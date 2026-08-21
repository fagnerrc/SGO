// SGO on Supabase — PIN login Edge Function.
// Replaces: authenticateSessionServer (V12_SecuritySync.gs).
//
// PIN auth is not a native Supabase Auth strategy, so this function does the
// two things Postgres alone can't:
//   1. Call verify_login() (0008_auth_functions.sql) — it does the actual
//      lockout/attempt-accounting/hash-check work, serialized per email via
//      an advisory lock inside one transaction.
//   2. On success, sign a Supabase-compatible JWT (HS256, project JWT
//      secret) carrying a `session_id` claim. That claim is what lets
//      session_is_valid() (0008) revoke access live — e.g. immediately
//      after an admin resets this user's PIN — rather than only once the
//      token would naturally expire.
//
// Required environment variables: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are injected automatically into every Edge Function by Supabase — no
// setup needed. JWT_SECRET is NOT auto-injected and must be set manually
// (`supabase secrets set JWT_SECRET=...`, never committed) — note it can't
// be named SUPABASE_JWT_SECRET, since Supabase reserves the SUPABASE_
// prefix for its own auto-injected vars and silently refuses to set a
// custom secret with that prefix. Find the value in the Supabase
// dashboard under Project Settings -> API (or via the Management API's
// GET /v1/projects/{ref}/postgrest endpoint) — it's what PostgREST
// verifies incoming tokens against.

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleCorsPreflight, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("JWT_SECRET")!;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const encoder = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const headerPart = base64url(encoder.encode(JSON.stringify(header)));
  const payloadPart = base64url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerPart}.${payloadPart}`;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return json({ success: false, errorCode: "METHOD_NOT_ALLOWED" }, 405);
  }

  let body: { email?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, errorCode: "INVALID_BODY" }, 400);
  }

  if (!body.email || !body.pin) {
    return json({ success: false, errorCode: "EMAIL_AND_PIN_REQUIRED" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await supabase.rpc("verify_login", {
    p_email: body.email,
    p_pin: body.pin,
  });

  if (error) {
    console.error("verify_login RPC error", error);
    return json({ success: false, errorCode: "SERVER_ERROR" }, 500);
  }

  if (!data.success) {
    // ACCOUNT_LOCKED or INVALID_CREDENTIALS — pass the errorCode straight
    // through, no distinction that would let a client enumerate emails.
    return json(data, 401);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = Math.floor(new Date(data.expires_at).getTime() / 1000);

  const accessToken = await signJwt({
    sub: data.profile_id,
    role: "authenticated",
    aud: "authenticated",
    session_id: data.session_id,
    iat: nowSeconds,
    exp: expSeconds,
  });

  return json({ success: true, access_token: accessToken, expires_at: data.expires_at });
});

// SGO on Supabase — admin provisions a new collaborator.
// Replaces: ensureCollaboratorCredentialV1215_'s temporary-PIN issuance
// path (V12_SecuritySync.gs), for the case where the collaborator record
// itself doesn't exist yet.
//
// Creates the underlying auth.users row via the Admin API — that fires
// handle_new_auth_user() (0008_auth_functions.sql), which inserts the
// matching `profiles` row — then sets an initial temporary PIN the admin
// can hand to the new collaborator.
//
// Required environment variables: SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function generateTemporaryPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4-digit temp PIN, must be changed on first login by the app's own UX
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ success: false, errorCode: "METHOD_NOT_ALLOWED" }, 405);
  }

  // Authorization is checked as the CALLER, not the service-role client
  // used later to do the actual work — is_privileged() only resolves
  // correctly against the caller's own auth.uid(), and set_pin() is called
  // through this same client further down for the same reason (calling it
  // via the service-role client would make auth.uid() resolve to nothing
  // inside set_pin() and fail its own "owner or privileged" check).
  const authHeader = req.headers.get("Authorization") ?? "";
  const callerToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!callerToken) {
    return json({ success: false, errorCode: "UNAUTHENTICATED" }, 401);
  }
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
  });
  const { data: isPrivileged, error: privilegeError } = await callerClient.rpc("is_privileged");
  if (privilegeError) {
    console.error("is_privileged RPC error", privilegeError);
    return json({ success: false, errorCode: "SERVER_ERROR" }, 500);
  }
  if (!isPrivileged) {
    return json({ success: false, errorCode: "FORBIDDEN" }, 403);
  }

  // The new user's company is always the CALLER's own company, never a
  // client-supplied value — is_privileged() above only proves the caller is
  // privileged *somewhere*, not that they have any authority over whatever
  // company_id a request body might name. Without this, a privileged admin
  // of Company A could provision a user directly into Company B just by
  // passing its id.
  const { data: callerCompanyId, error: companyError } = await callerClient.rpc("current_company");
  if (companyError || !callerCompanyId) {
    console.error("current_company RPC error", companyError);
    return json({ success: false, errorCode: "SERVER_ERROR" }, 500);
  }

  let body: { email?: string; full_name?: string; role?: string; area?: string };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, errorCode: "INVALID_BODY" }, 400);
  }
  if (!body.email || !body.full_name) {
    return json({ success: false, errorCode: "MISSING_FIELDS" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: body.email,
    email_confirm: true,
    user_metadata: {
      full_name: body.full_name,
      role: body.role ?? "colaborador",
      area: body.area ?? "",
      company_id: callerCompanyId,
    },
  });
  if (createError || !created?.user) {
    console.error("auth.admin.createUser error", createError);
    return json({ success: false, errorCode: "CREATE_USER_FAILED", message: createError?.message }, 500);
  }

  const temporaryPin = generateTemporaryPin();
  const { error: pinError } = await callerClient.rpc("set_pin", {
    p_profile_id: created.user.id,
    p_new_pin: temporaryPin,
  });
  if (pinError) {
    console.error("set_pin RPC error", pinError);
    return json({ success: false, errorCode: "SET_PIN_FAILED" }, 500);
  }

  return json({ success: true, profile_id: created.user.id, temporary_pin: temporaryPin });
});

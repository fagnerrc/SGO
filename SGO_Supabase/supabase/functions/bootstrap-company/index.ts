// SGO on Supabase — one-time setup for a brand-new project: creates the
// first company and its first admin user. Closes the gap flagged in
// PROGRESS.md since phase 3 ("no way to create the very first
// company/admin from a blank database").
//
// Safe to leave deployed permanently: can_bootstrap()/bootstrap_company()/
// bootstrap_set_initial_pin() (0012_admin_diagnostics.sql) are each
// self-limiting — they check that nothing has been bootstrapped yet as
// their own authorization gate, and refuse to run a second time. There is
// no separate "disable this function" step required after first use.
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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ success: false, errorCode: "METHOD_NOT_ALLOWED" }, 405);
  }

  let body: { company_name?: string; admin_email?: string; admin_full_name?: string; admin_pin?: string };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, errorCode: "INVALID_BODY" }, 400);
  }
  if (!body.company_name || !body.admin_email || !body.admin_full_name || !body.admin_pin) {
    return json({ success: false, errorCode: "MISSING_FIELDS" }, 400);
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: canBootstrap, error: canBootstrapError } = await anon.rpc("can_bootstrap");
  if (canBootstrapError) {
    console.error("can_bootstrap RPC error", canBootstrapError);
    return json({ success: false, errorCode: "SERVER_ERROR" }, 500);
  }
  if (!canBootstrap) {
    return json({ success: false, errorCode: "ALREADY_BOOTSTRAPPED" }, 409);
  }

  const { data: companyId, error: companyError } = await admin.rpc("bootstrap_company", {
    p_company_name: body.company_name,
  });
  if (companyError) {
    console.error("bootstrap_company RPC error", companyError);
    return json({ success: false, errorCode: "COMPANY_CREATE_FAILED", message: companyError.message }, 500);
  }

  const { data: created, error: createUserError } = await admin.auth.admin.createUser({
    email: body.admin_email,
    email_confirm: true,
    user_metadata: {
      full_name: body.admin_full_name,
      role: "admin",
      area: "",
      company_id: companyId,
    },
  });
  if (createUserError || !created?.user) {
    console.error("auth.admin.createUser error", createUserError);
    return json({ success: false, errorCode: "CREATE_USER_FAILED", message: createUserError?.message }, 500);
  }

  const { error: pinError } = await admin.rpc("bootstrap_set_initial_pin", {
    p_profile_id: created.user.id,
    p_new_pin: body.admin_pin,
  });
  if (pinError) {
    console.error("bootstrap_set_initial_pin RPC error", pinError);
    return json({ success: false, errorCode: "SET_PIN_FAILED", message: pinError.message }, 500);
  }

  return json({ success: true, company_id: companyId, profile_id: created.user.id });
});

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadSession } from "./session";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Fails loudly at startup rather than producing confusing "fetch failed"
  // errors deep inside a login attempt.
  // eslint-disable-next-line no-console
  console.error(
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — copy .env.example to .env.local and fill in your project's values.",
  );
}

// The anon client is for anything reachable before login: the pin-login
// Edge Function call itself, and nothing else (every table has RLS
// requiring a real session — see 0006_rls_policies.sql).
export const anonClient: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// The authenticated client is rebuilt whenever the session changes, with
// the self-signed JWT (see pin-login Edge Function) attached to every
// request's Authorization header. This is the standard way to use a
// non-GoTrue-issued token with supabase-js: supabase.auth.setSession()
// expects a refresh token we don't have, so requests are authenticated at
// the transport level instead.
let cachedClient: SupabaseClient | null = null;
let cachedToken: string | null = null;

export function getClient(): SupabaseClient {
  const session = loadSession();
  const token = session?.accessToken ?? null;

  if (cachedClient && token === cachedToken) {
    return cachedClient;
  }

  cachedToken = token;
  cachedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

export function resetClientCache(): void {
  cachedClient = null;
  cachedToken = null;
}

// PostgrestError (and the other supabase-js error shapes) don't extend the
// native Error class, so `err instanceof Error` is false for anything
// thrown straight from a `{ data, error }` response — every view's error
// display ends up rendering "[object Object]" instead of the real message.
// Route every such error through here so callers always get a real Error.
//
// Also the diagnostics module's main capture point for API/RPC failures
// (deliberately NOT importing from ./diagnostics — that module imports
// this one, and keeping this file leaf-level avoids the cycle). Every
// SGO_-prefixed message is a deliberate, named business rejection raised
// by a function in supabase/migrations/ — the calling view already
// surfaces it as normal form/action feedback, so logging it here would
// just be noise. Anything else (network failure, an unexpected Postgres
// error, a PostgREST parsing error) is a real, diagnostics-worthy
// problem and gets reported best-effort, fire-and-forget.
// Browsers throw these bare, cryptic messages when a fetch can't even
// complete — the network dropped, DNS failed, a proxy/VPN hiccuped — as
// opposed to the server responding with an actual error. The wording
// differs per browser (Chrome: "Failed to fetch", Safari: "Load failed",
// Firefox: "NetworkError when attempting to fetch resource"), but none of
// them mean anything to a non-technical user, so they get replaced with a
// message that actually says what happened and what to do about it.
const NETWORK_ERROR_PATTERN = /failed to fetch|networkerror|load failed|network request failed/i;

export function throwSupabaseError(error: { message: string }): never {
  if (!error.message.startsWith("SGO_")) {
    void (async () => {
      try {
        await getClient().rpc("report_client_error", {
          p_message: error.message,
          p_context: { module: "api", url: location.hash || location.pathname },
          p_level: "error",
          p_action: "RPC_FAILED",
        });
      } catch {
        // best-effort — never let the diagnostic write itself become a new error
      }
    })();
  }
  const friendlyMessage = NETWORK_ERROR_PATTERN.test(error.message)
    ? "Falha de conexão com o servidor. Verifique sua internet e tente novamente."
    : error.message;
  throw new Error(friendlyMessage);
}

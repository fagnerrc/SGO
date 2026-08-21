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

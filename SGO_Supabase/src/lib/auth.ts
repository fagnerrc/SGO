import { anonClient, getClient, resetClientCache } from "./supabase";
import { clearSession, saveSession, type Session } from "./session";

export interface LoginError {
  errorCode: string;
  lockedUntil?: string;
}

export async function login(email: string, pin: string): Promise<Session | LoginError> {
  // Edge Function, not a table/RPC call — see
  // supabase/functions/pin-login/index.ts: it's the piece that actually
  // signs the session JWT, which plain PostgREST can't do.
  const { data, error } = await anonClient.functions.invoke("pin-login", {
    body: { email, pin },
  });

  if (error) {
    return { errorCode: "SERVER_ERROR" };
  }
  if (!data.success) {
    return { errorCode: data.errorCode, lockedUntil: data.lockedUntil };
  }

  const session: Session = {
    accessToken: data.access_token,
    expiresAt: data.expires_at,
    profileId: parseJwtSub(data.access_token),
  };
  saveSession(session);
  resetClientCache();
  return session;
}

export async function logout(): Promise<void> {
  try {
    await getClient().rpc("logout");
  } finally {
    clearSession();
    resetClientCache();
  }
}

function parseJwtSub(token: string): string {
  const payload = token.split(".")[1];
  const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  return decoded.sub as string;
}

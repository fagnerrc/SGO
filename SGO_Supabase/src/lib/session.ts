// Session persistence for the custom PIN/JWT auth flow (see
// ../../PROGRESS.md phase 3 for why this isn't Supabase Auth's own
// session management — no refresh token exists to hand to
// supabase.setSession(), since sign-in never goes through GoTrue).

export interface Session {
  accessToken: string;
  expiresAt: string; // ISO timestamp
  profileId: string;
}

const STORAGE_KEY = "sgo.session";

export function loadSession(): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as Session;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      clearSession();
      return null;
    }
    return session;
  } catch {
    clearSession();
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

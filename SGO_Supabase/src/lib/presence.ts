// Presença / Atividade da Equipe — client-side status computation, the
// heartbeat controller, and a short-lived cache for the sidebar widget.
// The server only ever stores one timestamp per person (profiles.
// last_activity_at, 0042); everything else (ATIVO/AUSENTE/INATIVO, the
// "há Xh Ymin" text) is derived here, purely from that timestamp vs
// Date.now() — never pushed from the server and never re-fetched just to
// tick a counter (section 11 of the spec).

import { listCompanyProfiles } from "./profiles";
import { reportClientError } from "./diagnostics";
import { getClient } from "./supabase";
import type { Profile } from "./types";

export type PresenceStatus = "ativo" | "ausente" | "inativo";

// ATIVO's window matches the heartbeat interval below — as long as a tab
// stays open and interacted-with, heartbeats keep landing every ~5min and
// the person never drifts out of "ativo agora" between them. INATIVO's
// 2h threshold is the spec's one hard, exact rule (section 4).
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
export const INACTIVE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export function computePresenceStatus(lastActivityAt: string | null): PresenceStatus {
  if (!lastActivityAt) return "inativo";
  const elapsed = Date.now() - new Date(lastActivityAt).getTime();
  if (elapsed > INACTIVE_THRESHOLD_MS) return "inativo";
  if (elapsed > ACTIVE_WINDOW_MS) return "ausente";
  return "ativo";
}

function formatElapsed(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}min`;
  return `${minutes}min`;
}

export function presenceStatusLabel(lastActivityAt: string | null): string {
  if (!lastActivityAt) return "Sem atividade registrada";
  const status = computePresenceStatus(lastActivityAt);
  const elapsed = Date.now() - new Date(lastActivityAt).getTime();
  if (status === "ativo") return "Ativo agora";
  if (status === "ausente") return `Ausente há ${formatElapsed(elapsed)}`;
  return `Inativo há ${formatElapsed(elapsed)}`;
}

export function lastActivityClockLabel(lastActivityAt: string | null): string {
  if (!lastActivityAt) return "—";
  return new Date(lastActivityAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// Section 9: inativos primeiro (mais tempo parado primeiro), depois
// ausentes, depois ativos por último — the people who most need attention
// lead the list instead of being buried under everyone who's fine.
const STATUS_ORDER: Record<PresenceStatus, number> = { inativo: 0, ausente: 1, ativo: 2 };

export function sortByPresence(profiles: Profile[]): Profile[] {
  return [...profiles].sort((a, b) => {
    const orderDiff = STATUS_ORDER[computePresenceStatus(a.last_activity_at)] - STATUS_ORDER[computePresenceStatus(b.last_activity_at)];
    if (orderDiff !== 0) return orderDiff;
    const ta = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0;
    const tb = b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0;
    return ta - tb; // oldest activity first within the same status
  });
}

export async function recordActivity(): Promise<void> {
  const { error } = await getClient().rpc("record_activity");
  if (error) throw error;
}

// Short-lived cache shared by the sidebar widget across navigations —
// renderNav() runs on every single route change, and re-fetching the
// whole team's presence on every one of those would be wasteful (and is
// exactly the kind of "in the critical path" cost section 18 warns
// against). 60s is short enough that the sidebar still feels live.
let cachedTeam: Profile[] | null = null;
let cachedTeamAt = 0;
const TEAM_CACHE_MS = 60_000;

export async function getCachedTeamPresence(forceRefresh = false): Promise<Profile[]> {
  if (!forceRefresh && cachedTeam && Date.now() - cachedTeamAt < TEAM_CACHE_MS) return cachedTeam;
  cachedTeam = await listCompanyProfiles();
  cachedTeamAt = Date.now();
  return cachedTeam;
}

// --- Heartbeat controller (section 14/15) ---
//
// No network call happens per click/keystroke/navigation — interaction
// just flips a local flag. Every HEARTBEAT_INTERVAL_MS, if that flag is
// set, exactly one lightweight RPC call fires and the flag resets; if
// nobody touched the app since the last tick, nothing is sent at all.
let hasActivitySinceLastHeartbeat = true; // true on load: one heartbeat fires immediately, see below
let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

function markActivity(): void {
  hasActivitySinceLastHeartbeat = true;
}

async function sendHeartbeatIfDue(): Promise<void> {
  if (!hasActivitySinceLastHeartbeat) return;
  hasActivitySinceLastHeartbeat = false;
  try {
    await recordActivity();
  } catch (err) {
    hasActivitySinceLastHeartbeat = true; // don't lose the signal — retry on the next tick
    reportClientError(err instanceof Error ? err.message : String(err), { action: "PRESENCE_HEARTBEAT_FAILED", module: "presence" });
  }
}

// Called once from main.ts, after the app has already started rendering
// — presence is never on the critical path for login or first paint
// (section 18). Safe to call more than once; only the first call does
// anything.
export function initPresenceHeartbeat(): void {
  if (heartbeatHandle) return;
  ["click", "keydown"].forEach((evt) => document.addEventListener(evt, markActivity, { passive: true }));
  window.addEventListener("hashchange", markActivity);
  void sendHeartbeatIfDue(); // one immediate heartbeat so a fresh session shows "ativo agora" right away
  heartbeatHandle = setInterval(() => void sendHeartbeatIfDue(), HEARTBEAT_INTERVAL_MS);
}

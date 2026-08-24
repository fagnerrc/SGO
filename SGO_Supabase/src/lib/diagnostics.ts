// Diagnostics module — the piece report_client_error() (0012) was always
// meant to feed, never wired up. See PROGRESS.md for the old system
// comparison (V12_Diagnostics.gs): this captures broadly (any logged-in
// user can report — the RPC is SECURITY DEFINER, no privileged check on
// write) but is only ever readable by admin/diretoria/auditoria, via the
// same logs_select RLS clause every other privileged screen relies on.

import { getClient, throwSupabaseError } from "./supabase";
import type { CronJobStatus, LogEntry, LogLevel } from "./types";

const APP_VERSION = "1.0.0";

export interface ClientErrorContext {
  action?: string;
  module?: string;
  [key: string]: unknown;
}

// Fire-and-forget by design: a failure here must never itself throw or
// block the caller (that would turn "report this error" into a second
// source of errors). Swallows silently — console.error is enough for a
// developer actually watching devtools, and there is no user-facing
// consequence to a dropped diagnostic row.
export function reportClientError(message: string, context: ClientErrorContext = {}, level: LogLevel = "error"): void {
  const { action, module, ...rest } = context;
  const enrichedContext = {
    module: module ?? "client",
    url: location.hash || location.pathname,
    user_agent: navigator.userAgent,
    online: navigator.onLine,
    app_version: APP_VERSION,
    ...rest,
  };
  void (async () => {
    try {
      const { error } = await getClient().rpc("report_client_error", {
        p_message: message,
        p_context: enrichedContext,
        p_level: level,
        p_action: action ?? "CLIENT_ERROR",
      });
      if (error) console.error("[SGO] failed to report diagnostic:", error.message);
    } catch (err) {
      console.error("[SGO] failed to report diagnostic:", err);
    }
  })();
}

export interface LogFilters {
  level: string; // "" = todos
  kind: string; // "" = todos
  from: string; // yyyy-mm-dd
  to: string;
  search: string;
}

export const DEFAULT_LOG_FILTERS: LogFilters = { level: "", kind: "", from: "", to: "", search: "" };

export async function listLogs(limit = 500): Promise<LogEntry[]> {
  const { data, error } = await getClient()
    .from("logs")
    .select("id, kind, level, user_id, task_id, action, details, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throwSupabaseError(error);
  return data as LogEntry[];
}

export function applyLogFilters(logs: LogEntry[], filters: LogFilters): LogEntry[] {
  const fromTime = filters.from ? new Date(filters.from + "T00:00:00").getTime() : null;
  const toTime = filters.to ? new Date(filters.to + "T23:59:59").getTime() : null;
  const search = filters.search.trim().toLowerCase();
  return logs.filter((l) => {
    if (filters.level && l.level !== filters.level) return false;
    if (filters.kind && l.kind !== filters.kind) return false;
    const createdAt = new Date(l.created_at).getTime();
    if (fromTime !== null && createdAt < fromTime) return false;
    if (toTime !== null && createdAt > toTime) return false;
    if (search) {
      const message = String(l.details?.message ?? "").toLowerCase();
      if (!l.action.toLowerCase().includes(search) && !message.includes(search)) return false;
    }
    return true;
  });
}

export async function getCronStatus(): Promise<CronJobStatus[]> {
  const { data, error } = await getClient().rpc("get_cron_status");
  if (error) throwSupabaseError(error);
  return (data ?? []) as CronJobStatus[];
}

export interface HealthCheckResult {
  name: string;
  ok: boolean;
  detail: string;
  durationMs: number;
}

// The old system's closest equivalent (diagnoseV1217PersistenceHealth)
// only ever aggregated a server-side queue that doesn't exist in this
// architecture — there's nothing to port 1:1. These are new checks
// chosen for what could actually go wrong in *this* stack: an expired
// session, an RLS policy silently returning zero rows instead of the
// expected error, a scheduled job that stopped running or is failing
// every time, and one concrete data-integrity shape (a task marked
// Concluída with no concluido_em, which would break SLA math in
// Relatórios/Dashboard silently rather than loudly).
export async function runHealthChecks(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];
  const client = getClient();

  async function timed(name: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<void> {
    const started = performance.now();
    try {
      const { ok, detail } = await fn();
      results.push({ name, ok, detail, durationMs: Math.round(performance.now() - started) });
    } catch (err) {
      results.push({
        name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Math.round(performance.now() - started),
      });
    }
  }

  await timed("Sessão / autenticação", async () => {
    const { data, error } = await client.rpc("current_profile");
    if (error) return { ok: false, detail: error.message };
    if (!data?.id) return { ok: false, detail: "sessão presente mas sem perfil associado" };
    return { ok: true, detail: `autenticado como ${data.full_name ?? data.id}` };
  });

  await timed("Conectividade com o banco", async () => {
    const { error } = await client.from("companies").select("id").limit(1);
    if (error) return { ok: false, detail: error.message };
    return { ok: true, detail: "round-trip concluído" };
  });

  await timed("Leitura de tarefas (RLS)", async () => {
    const { data, error, count } = await client.from("tasks").select("id", { count: "exact", head: true }).eq("excluido", false);
    if (error) return { ok: false, detail: error.message };
    return { ok: true, detail: `${count ?? data?.length ?? 0} tarefa(s) visível(is)` };
  });

  await timed("Jobs agendados (pg_cron)", async () => {
    const jobs = await getCronStatus();
    if (jobs.length === 0) return { ok: false, detail: "nenhum job encontrado — cron.job vazio ou sem permissão" };
    const inactive = jobs.filter((j) => !j.active);
    const failing = jobs.filter((j) => j.last_status === "failed");
    if (inactive.length > 0) return { ok: false, detail: `${inactive.length} job(s) inativo(s): ${inactive.map((j) => j.jobname).join(", ")}` };
    if (failing.length > 0) return { ok: false, detail: `${failing.length} job(s) com última execução falha: ${failing.map((j) => j.jobname).join(", ")}` };
    return { ok: true, detail: `${jobs.length} job(s) ativo(s), última execução OK` };
  });

  await timed("Integridade: tarefas concluídas sem data", async () => {
    const { count, error } = await client
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .in("status", ["Concluída", "Auditada"])
      .is("concluido_em", null);
    if (error) return { ok: false, detail: error.message };
    if ((count ?? 0) > 0) return { ok: false, detail: `${count} tarefa(s) concluída(s)/auditada(s) sem concluido_em` };
    return { ok: true, detail: "nenhuma inconsistência encontrada" };
  });

  return results;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function logsToCSV(logs: LogEntry[]): string {
  const header = ["Data", "Nível", "Categoria", "Ação", "Usuário", "Mensagem", "Detalhes (JSON)"];
  const rows = logs.map((l) => [
    l.created_at,
    l.level,
    l.kind,
    l.action,
    l.user_id,
    String(l.details?.message ?? ""),
    JSON.stringify(l.details ?? {}),
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function logsToJSON(logs: LogEntry[]): string {
  return JSON.stringify({ exported_at: new Date().toISOString(), app_version: APP_VERSION, count: logs.length, logs }, null, 2);
}

export function downloadFile(filename: string, content: string, mime: string): void {
  const bom = mime.startsWith("text/csv") ? "﻿" : "";
  const blob = new Blob([bom + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

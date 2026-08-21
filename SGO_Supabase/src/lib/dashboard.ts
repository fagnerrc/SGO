import { getClient, throwSupabaseError } from "./supabase";
import type { Task } from "./types";

const TERMINAL_STATUSES = ["Concluída", "Auditada", "Cancelada"];

export interface DashboardStats {
  open: number;
  openDueToday: number;
  overdue: number;
  slaPercent: number | null;
  approvalsPending: number;
  byStatus: { status: string; count: number }[];
}

// Pure function over an already-fetched task list — the KPIs are just
// different ways of counting the same RLS-filtered rows the task list
// screen already fetches, not a separate privileged query. Mirrors the old
// Index.html dashboard's kpi-grid (Tarefas abertas / Atrasadas / SLA
// cumprido / Aprovações), minus the two chart.js canvases — "tarefas por
// status" is included as plain counts (rendered as CSS bars in the view)
// instead of pulling in a charting library for one screen.
export function computeDashboardStats(tasks: Task[]): DashboardStats {
  const now = Date.now();
  const todayStr = new Date().toDateString();

  let open = 0;
  let openDueToday = 0;
  let overdue = 0;
  let approvalsPending = 0;
  let completedOnTime = 0;
  let completedTotal = 0;
  const byStatusMap = new Map<string, number>();

  for (const task of tasks) {
    byStatusMap.set(task.status, (byStatusMap.get(task.status) ?? 0) + 1);

    const isTerminal = TERMINAL_STATUSES.includes(task.status);
    if (!isTerminal) {
      open += 1;
      if (task.prazo && new Date(task.prazo).toDateString() === todayStr) openDueToday += 1;
      if (task.prazo && new Date(task.prazo).getTime() < now) overdue += 1;
    }
    if (task.status === "Aguardando aprovação") approvalsPending += 1;
    if (task.status === "Concluída" || task.status === "Auditada") {
      completedTotal += 1;
      const completedAt = task.concluido_em ? new Date(task.concluido_em).getTime() : null;
      const dueAt = task.prazo ? new Date(task.prazo).getTime() : null;
      if (!dueAt || !completedAt || completedAt <= dueAt) completedOnTime += 1;
    }
  }

  return {
    open,
    openDueToday,
    overdue,
    slaPercent: completedTotal > 0 ? Math.round((completedOnTime / completedTotal) * 100) : null,
    approvalsPending,
    byStatus: Array.from(byStatusMap.entries()).map(([status, count]) => ({ status, count })),
  };
}

export interface ActivityEntry {
  id: number;
  task_id: string;
  at: string;
  action: string;
}

export async function listRecentActivity(limit = 10): Promise<ActivityEntry[]> {
  const { data, error } = await getClient()
    .from("task_history")
    .select("id, task_id, at, action")
    .order("at", { ascending: false })
    .limit(limit);
  if (error) throwSupabaseError(error);
  return data as ActivityEntry[];
}

export interface WorkloadEntry {
  profileId: string;
  name: string;
  count: number;
  hoursAssigned: number;
  capacity: number;
  occupancyPercent: number;
}

// Pure — same "just work over the already-RLS-filtered rows" approach as
// computeDashboardStats(), grouped by responsável instead of by status.
// occupancyPercent mirrors the old system's formula exactly: sum of the
// estimativa of open (non-terminal) tasks assigned to the person, divided
// by their capacidade_semanal — a real overload signal instead of a
// plain task count, which treats a 1-hour task the same as a 20-hour one.
export function computeWorkload(
  tasks: Task[],
  profiles: { id: string; full_name: string; capacidade_semanal: number }[],
  limit = 6,
): WorkloadEntry[] {
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const counts = new Map<string, number>();
  const hours = new Map<string, number>();
  for (const task of tasks) {
    if (TERMINAL_STATUSES.includes(task.status)) continue;
    counts.set(task.responsavel_id, (counts.get(task.responsavel_id) ?? 0) + 1);
    hours.set(task.responsavel_id, (hours.get(task.responsavel_id) ?? 0) + (task.estimativa || 0));
  }
  return Array.from(counts.entries())
    .map(([profileId, count]) => {
      const profile = profileById.get(profileId);
      const capacity = profile?.capacidade_semanal || 40;
      const hoursAssigned = hours.get(profileId) ?? 0;
      return {
        profileId,
        name: profile?.full_name ?? "—",
        count,
        hoursAssigned,
        capacity,
        occupancyPercent: Math.round((hoursAssigned / capacity) * 100),
      };
    })
    .sort((a, b) => b.occupancyPercent - a.occupancyPercent)
    .slice(0, limit);
}

// Raw completion timestamps for the last N days — bucketed client-side
// (computeCompletionsByDay) rather than with a SQL group-by, since the
// dataset per company is small and this avoids a second RPC just for one
// chart.
export async function listRecentCompletions(days = 14): Promise<{ at: string }[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await getClient()
    .from("task_history")
    .select("at")
    .eq("action", "Tarefa concluída")
    .gte("at", since);
  if (error) throwSupabaseError(error);
  return data as { at: string }[];
}

export function computeCompletionsByDay(completions: { at: string }[], days = 14): { label: string; count: number }[] {
  const buckets = new Map<string, number>();
  const labels: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, 0);
    labels.push(key);
  }
  for (const c of completions) {
    const key = c.at.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return labels.map((key) => ({
    label: new Date(key + "T00:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
    count: buckets.get(key) ?? 0,
  }));
}

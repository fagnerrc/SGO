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

// Relatórios — ported from the old system's #page-relatorios (Index.html
// filteredReportTasks()/renderReports()/renderReportCharts()/
// taskToCSV()/exportReport()). Same "pure function over the already
// RLS-filtered task list" approach as dashboard.ts — a privileged caller's
// listMyTasks() already returns the whole company's tasks (tasks_select
// policy's is_privileged() clause), so there's no separate report query.

import type { Profile, Task } from "./types";

const TERMINAL_STATUSES = ["Concluída", "Auditada", "Cancelada"];

export interface ReportFilters {
  responsavelId: string; // "" = todos
  status: string; // "" = todos
  from: string; // yyyy-mm-dd, "" = sem limite inferior
  to: string; // yyyy-mm-dd, "" = sem limite superior
}

export const DEFAULT_REPORT_FILTERS: ReportFilters = { responsavelId: "", status: "", from: "", to: "" };

export function applyReportFilters(tasks: Task[], filters: ReportFilters): Task[] {
  const fromTime = filters.from ? new Date(filters.from + "T00:00:00").getTime() : null;
  const toTime = filters.to ? new Date(filters.to + "T23:59:59").getTime() : null;
  return tasks.filter((t) => {
    if (filters.responsavelId && t.responsavel_id !== filters.responsavelId) return false;
    if (filters.status && t.status !== filters.status) return false;
    const createdAt = new Date(t.created_at).getTime();
    if (fromTime !== null && createdAt < fromTime) return false;
    if (toTime !== null && createdAt > toTime) return false;
    return true;
  });
}

export interface ReportStats {
  total: number;
  done: number;
  overdue: number;
  slaPercent: number | null;
  trackedTimeMs: number;
  trackedCount: number;
}

// A Tarefa Agendada (routine-generated ones included) never runs a real
// Cronômetro, so its timer_total_ms sits at 0 — counting that as "0h
// tracked" understates real effort. Mirrors the same esforço substitution
// taskDetail.ts and audit.ts already apply for this task type, so the
// report agrees with what those screens show.
function effectiveTrackedMs(task: Task): number {
  if (task.tipo === "Tarefa agendada" && task.estimativa > 0) return task.estimativa * 3600000;
  return task.timer_total_ms;
}

export function computeReportStats(tasks: Task[]): ReportStats {
  const now = Date.now();
  let done = 0;
  let overdue = 0;
  let completedOnTime = 0;
  let trackedTimeMs = 0;
  let trackedCount = 0;

  for (const task of tasks) {
    const isTerminal = TERMINAL_STATUSES.includes(task.status);
    if (task.status === "Concluída" || task.status === "Auditada") {
      done += 1;
      const completedAt = task.concluido_em ? new Date(task.concluido_em).getTime() : null;
      const dueAt = task.prazo ? new Date(task.prazo).getTime() : null;
      if (!dueAt || !completedAt || completedAt <= dueAt) completedOnTime += 1;
    }
    if (!isTerminal && task.prazo && new Date(task.prazo).getTime() < now) overdue += 1;
    const trackedMs = effectiveTrackedMs(task);
    if (trackedMs > 0) {
      trackedTimeMs += trackedMs;
      trackedCount += 1;
    }
  }

  return {
    total: tasks.length,
    done,
    overdue,
    slaPercent: done > 0 ? Math.round((completedOnTime / done) * 100) : null,
    trackedTimeMs,
    trackedCount,
  };
}

export function groupByPriority(tasks: Task[]): { priority: string; count: number }[] {
  const map = new Map<string, number>();
  for (const t of tasks) map.set(t.prioridade, (map.get(t.prioridade) ?? 0) + 1);
  return Array.from(map.entries()).map(([priority, count]) => ({ priority, count }));
}

export function groupByArea(tasks: Task[]): { area: string; count: number }[] {
  const map = new Map<string, number>();
  for (const t of tasks) {
    const area = t.area || "Sem área";
    map.set(area, (map.get(area) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([area, count]) => ({ area, count }));
}

export function formatTrackedTime(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, "0")}`;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function tasksToCSV(tasks: Task[], profileById: Map<string, Profile>): string {
  const header = ["Código", "Título", "Área", "Responsável", "Status", "Prioridade", "Risco", "Prazo", "Concluído em", "Esforço (h)", "Tempo rastreado (h)"];
  const rows = tasks.map((t) => [
    t.code ?? "",
    t.titulo,
    t.area,
    profileById.get(t.responsavel_id)?.full_name ?? "",
    t.status,
    t.prioridade,
    t.risco,
    t.prazo ?? "",
    t.concluido_em ?? "",
    String(t.estimativa),
    (effectiveTrackedMs(t) / 3600000).toFixed(2),
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

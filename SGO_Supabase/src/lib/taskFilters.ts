import type { Task } from "./types";

export interface TaskFilterState {
  search: string;
  status: string;
  responsavelId: string;
  prioridade: string;
  risco: string;
  prazo: string;
  sort: string;
}

export const DEFAULT_FILTERS: TaskFilterState = {
  search: "",
  status: "",
  responsavelId: "",
  prioridade: "",
  risco: "",
  prazo: "",
  sort: "prazo_asc",
};

const TERMINAL_STATUSES = ["Concluída", "Auditada", "Cancelada"];

export function applyTaskFilters(tasks: Task[], f: TaskFilterState): Task[] {
  const q = f.search.trim().toLowerCase();
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = startOfToday.getTime() + 86400000;
  const in7Days = startOfToday.getTime() + 7 * 86400000;

  const filtered = tasks.filter((t) => {
    if (q && !(t.titulo.toLowerCase().includes(q) || (t.code ?? "").toLowerCase().includes(q) || t.descricao.toLowerCase().includes(q))) {
      return false;
    }
    if (f.status && t.status !== f.status) return false;
    if (f.responsavelId && t.responsavel_id !== f.responsavelId) return false;
    if (f.prioridade && t.prioridade !== f.prioridade) return false;
    if (f.risco && t.risco !== f.risco) return false;
    if (f.prazo) {
      if (!t.prazo) return false;
      const d = new Date(t.prazo).getTime();
      if (f.prazo === "atrasadas" && !(d < now && !TERMINAL_STATUSES.includes(t.status))) return false;
      if (f.prazo === "hoje" && !(d >= startOfToday.getTime() && d < endOfToday)) return false;
      if (f.prazo === "7dias" && !(d >= now && d <= in7Days)) return false;
    }
    return true;
  });

  return sortTasks(filtered, f.sort);
}

const PRIORITY_ORDER: Record<string, number> = { Urgente: 0, Alta: 1, Normal: 2, Baixa: 3 };

function sortTasks(tasks: Task[], sort: string): Task[] {
  const arr = [...tasks];
  switch (sort) {
    case "prazo_desc":
      arr.sort((a, b) => (b.prazo ? new Date(b.prazo).getTime() : -Infinity) - (a.prazo ? new Date(a.prazo).getTime() : -Infinity));
      break;
    case "atualizado":
      arr.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      break;
    case "prioridade":
      arr.sort((a, b) => (PRIORITY_ORDER[a.prioridade] ?? 9) - (PRIORITY_ORDER[b.prioridade] ?? 9));
      break;
    default:
      arr.sort((a, b) => (a.prazo ? new Date(a.prazo).getTime() : Infinity) - (b.prazo ? new Date(b.prazo).getTime() : Infinity));
  }
  return arr;
}

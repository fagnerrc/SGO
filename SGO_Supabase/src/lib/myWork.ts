import type { Task } from "./types";

export type MyWorkTab = "hoje_atrasadas" | "proximas" | "aguardando" | "devolvidas" | "concluidas";

export interface MyWorkBuckets {
  hoje_atrasadas: Task[];
  proximas: Task[];
  aguardando: Task[];
  devolvidas: Task[];
  concluidas: Task[];
}

const WAITING_STATUSES = new Set(["Aguardando terceiro", "Aguardando aprovação"]);
const DONE_STATUSES = new Set(["Concluída", "Auditada"]);

// Only tasks where the caller is the responsável or a participant — the
// same RLS-scoped listMyTasks() also returns tasks visible because of a
// broader role (gestor over the whole area, privileged roles), which is
// correct for the "Tarefas" screen but too wide for a personal "what's
// actually mine" view. Cancelada is left out entirely: it isn't pending
// work for anyone anymore.
export function bucketMyWork(tasks: Task[], myProfileId: string): MyWorkBuckets {
  const buckets: MyWorkBuckets = { hoje_atrasadas: [], proximas: [], aguardando: [], devolvidas: [], concluidas: [] };
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = startOfToday.getTime() + 86400000;

  const mine = tasks.filter((t) => t.responsavel_id === myProfileId || t.participantes.includes(myProfileId));

  for (const task of mine) {
    if (WAITING_STATUSES.has(task.status)) {
      buckets.aguardando.push(task);
    } else if (task.status === "Reprovada/devolvida") {
      buckets.devolvidas.push(task);
    } else if (DONE_STATUSES.has(task.status)) {
      buckets.concluidas.push(task);
    } else if (task.status === "Cancelada") {
      continue;
    } else {
      const d = task.prazo ? new Date(task.prazo).getTime() : null;
      if (d !== null && d < endOfToday) buckets.hoje_atrasadas.push(task);
      else buckets.proximas.push(task);
    }
  }

  buckets.hoje_atrasadas.sort((a, b) => (a.prazo ? new Date(a.prazo).getTime() : now) - (b.prazo ? new Date(b.prazo).getTime() : now));
  buckets.proximas.sort((a, b) => (a.prazo ? new Date(a.prazo).getTime() : Infinity) - (b.prazo ? new Date(b.prazo).getTime() : Infinity));
  buckets.aguardando.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  buckets.devolvidas.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  buckets.concluidas.sort((a, b) => {
    const ad = a.concluido_em ? new Date(a.concluido_em).getTime() : 0;
    const bd = b.concluido_em ? new Date(b.concluido_em).getTime() : 0;
    return bd - ad;
  });

  return buckets;
}

import { applyTaskFilters, type TaskFilterState } from "../lib/taskFilters";
import { listCompanyProfiles } from "../lib/profiles";
import { listMyTasks } from "../lib/tasks";
import type { Profile, Task } from "../lib/types";
import { priorityBadge, statusBadge } from "./badges";
import { renderFilterBar } from "./filterBar";
import { renderNav } from "./nav";

const ALL_STATUSES = [
  "Em andamento",
  "Aguardando terceiro",
  "Aguardando aprovação",
  "Reprovada/devolvida",
  "Concluída",
  "Auditada",
  "Cancelada",
];

function formatPrazo(prazo: string | null): string {
  if (!prazo) return "sem prazo";
  const date = new Date(prazo);
  const overdue = date.getTime() < Date.now();
  const formatted = date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return overdue ? `${formatted} (atrasada)` : formatted;
}

export async function renderTaskList(root: HTMLElement, onOpenTask: (taskId: string) => void): Promise<void> {
  root.innerHTML = `
    <div id="nav-mount"></div>
    <div class="app-shell">
      <header class="app-header">
        <h1>Minhas tarefas</h1>
        <button id="new-task-btn">+ Nova tarefa</button>
      </header>
      <div id="filter-mount"></div>
      <p id="filter-summary" class="dashboard-subtitle"></p>
      <div id="task-list" class="task-list">Carregando...</div>
    </div>
  `;
  await renderNav(root.querySelector("#nav-mount")!, "tasks");

  root.querySelector("#new-task-btn")!.addEventListener("click", () => {
    location.hash = "#/tasks/new";
  });

  const listEl = root.querySelector<HTMLDivElement>("#task-list")!;
  const summaryEl = root.querySelector<HTMLParagraphElement>("#filter-summary")!;

  let tasks: Task[];
  let profiles: Profile[];
  try {
    [tasks, profiles] = await Promise.all([listMyTasks(), listCompanyProfiles()]);
  } catch (err) {
    listEl.textContent = `Não foi possível carregar as tarefas: ${(err as Error).message}`;
    return;
  }

  function renderList(filtered: Task[]): void {
    summaryEl.textContent = `${filtered.length} de ${tasks.length} tarefa(s)`;
    if (filtered.length === 0) {
      listEl.innerHTML = "<p>Nenhuma tarefa encontrada com esses filtros.</p>";
      return;
    }
    listEl.innerHTML = "";
    for (const task of filtered) {
      const card = document.createElement("button");
      card.className = "task-card";
      card.innerHTML = `
        <span class="task-card-code">${task.code ?? ""} ${priorityBadge(task.prioridade)}</span>
        <span class="task-card-title">${escapeHtml(task.titulo)}</span>
        <span class="task-card-status">${statusBadge(task.status)}</span>
        <span class="task-card-deadline">${formatPrazo(task.prazo)}</span>
      `;
      card.addEventListener("click", () => onOpenTask(task.id));
      listEl.appendChild(card);
    }
  }

  renderFilterBar(
    root.querySelector<HTMLDivElement>("#filter-mount")!,
    { profiles, statuses: ALL_STATUSES, showSort: true },
    (state: TaskFilterState) => renderList(applyTaskFilters(tasks, state)),
  );
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

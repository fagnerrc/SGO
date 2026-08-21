import { listMyTasks } from "../lib/tasks";
import type { Task } from "../lib/types";
import { priorityBadge, statusBadge } from "./badges";
import { renderNav } from "./nav";

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
      <div id="task-list" class="task-list">Carregando...</div>
    </div>
  `;
  await renderNav(root.querySelector("#nav-mount")!, "tasks");

  root.querySelector("#new-task-btn")!.addEventListener("click", () => {
    location.hash = "#/tasks/new";
  });

  const listEl = root.querySelector<HTMLDivElement>("#task-list")!;

  let tasks: Task[];
  try {
    tasks = await listMyTasks();
  } catch (err) {
    listEl.textContent = `Não foi possível carregar as tarefas: ${(err as Error).message}`;
    return;
  }

  if (tasks.length === 0) {
    listEl.textContent = "Nenhuma tarefa por aqui.";
    return;
  }

  listEl.innerHTML = "";
  for (const task of tasks) {
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

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

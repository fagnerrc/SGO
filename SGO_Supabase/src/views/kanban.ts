import { listMyTasks } from "../lib/tasks";
import type { Task, TaskStatus } from "../lib/types";
import { renderNav } from "./nav";

// All 7 statuses get a column — simpler and more honest than picking a
// subset, and the horizontal scroll container (same pattern as any other
// wide content in this app) keeps it usable on a normal-width screen.
const COLUMNS: TaskStatus[] = [
  "Em andamento",
  "Aguardando terceiro",
  "Aguardando aprovação",
  "Reprovada/devolvida",
  "Concluída",
  "Auditada",
  "Cancelada",
];

export async function renderKanban(root: HTMLElement, onOpenTask: (taskId: string) => void): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "kanban");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;

  let tasks: Task[];
  try {
    tasks = await listMyTasks();
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar o quadro: ${(err as Error).message}</p>`;
    return;
  }

  const byStatus = new Map<string, Task[]>();
  for (const status of COLUMNS) byStatus.set(status, []);
  for (const task of tasks) byStatus.get(task.status)?.push(task);

  shell.innerHTML = `
    <h1>Quadro Kanban</h1>
    <div class="kanban-board">
      ${COLUMNS.map(
        (status) => `
        <div class="kanban-column">
          <div class="kanban-column-header">
            <span>${escapeHtml(status)}</span>
            <span class="kanban-column-count">${byStatus.get(status)!.length}</span>
          </div>
          <div class="kanban-column-cards">
            ${byStatus
              .get(status)!
              .map(
                (t) => `
              <button class="kanban-card" data-task-id="${t.id}">
                <span class="kanban-card-code">${t.code ?? ""}</span>
                <span class="kanban-card-title">${escapeHtml(t.titulo)}</span>
              </button>`,
              )
              .join("")}
          </div>
        </div>`,
      ).join("")}
    </div>
  `;

  shell.querySelectorAll<HTMLButtonElement>(".kanban-card").forEach((el) => {
    el.addEventListener("click", () => onOpenTask(el.dataset.taskId!));
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

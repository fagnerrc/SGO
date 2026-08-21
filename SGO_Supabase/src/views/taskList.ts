import { listMyTasks } from "../lib/tasks";
import type { Task } from "../lib/types";
import { logout } from "../lib/auth";

const STATUS_LABELS: Record<string, string> = {
  "Em andamento": "Em andamento",
  "Aguardando terceiro": "Aguardando terceiro",
  "Aguardando aprovação": "Aguardando aprovação",
  "Reprovada/devolvida": "Reprovada / devolvida",
  Concluída: "Concluída",
  Auditada: "Auditada",
  Cancelada: "Cancelada",
};

function formatPrazo(prazo: string | null): string {
  if (!prazo) return "sem prazo";
  const date = new Date(prazo);
  const overdue = date.getTime() < Date.now();
  const formatted = date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return overdue ? `${formatted} (atrasada)` : formatted;
}

export async function renderTaskList(root: HTMLElement, onOpenTask: (taskId: string) => void): Promise<void> {
  root.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <h1>Minhas tarefas</h1>
        <button id="logout-btn" class="link-button">Sair</button>
      </header>
      <div id="task-list" class="task-list">Carregando...</div>
    </div>
  `;

  root.querySelector("#logout-btn")!.addEventListener("click", async () => {
    await logout();
    location.hash = "#/login";
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
      <span class="task-card-code">${task.code ?? ""}</span>
      <span class="task-card-title">${escapeHtml(task.titulo)}</span>
      <span class="task-card-status status-${slug(task.status)}">${STATUS_LABELS[task.status] ?? task.status}</span>
      <span class="task-card-deadline">${formatPrazo(task.prazo)}</span>
    `;
    card.addEventListener("click", () => onOpenTask(task.id));
    listEl.appendChild(card);
  }
}

function slug(status: string): string {
  return status
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, "-");
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

import { bucketMyWork, type MyWorkTab } from "../lib/myWork";
import { listMyTasks } from "../lib/tasks";
import type { Task } from "../lib/types";
import { priorityBadge, statusBadge } from "./badges";
import { getCachedProfile, renderNav } from "./nav";

const TABS: { key: MyWorkTab; label: string }[] = [
  { key: "hoje_atrasadas", label: "Hoje e atrasadas" },
  { key: "proximas", label: "Próximas" },
  { key: "aguardando", label: "Aguardando" },
  { key: "devolvidas", label: "Devolvidas" },
  { key: "concluidas", label: "Concluídas" },
];

function formatPrazo(prazo: string | null): string {
  if (!prazo) return "sem prazo";
  const date = new Date(prazo);
  const overdue = date.getTime() < Date.now();
  const formatted = date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return overdue ? `${formatted} (atrasada)` : formatted;
}

export async function renderMyWork(root: HTMLElement, onOpenTask: (taskId: string) => void): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "mywork");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;

  let tasks: Task[];
  let myProfileId: string;
  try {
    const [t, profile] = await Promise.all([listMyTasks(), getCachedProfile()]);
    tasks = t;
    myProfileId = profile.id;
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar suas tarefas: ${(err as Error).message}</p>`;
    return;
  }

  const buckets = bucketMyWork(tasks, myProfileId);
  let active: MyWorkTab = buckets.hoje_atrasadas.length > 0 ? "hoje_atrasadas" : "proximas";

  shell.innerHTML = `
    <h1 class="dashboard-title">Meu trabalho</h1>
    <p class="dashboard-subtitle">Só as tarefas em que você é responsável ou participante — separadas pelo que precisa de atenção agora.</p>
    <div class="tabs" id="mywork-tabs">
      ${TABS.map((t) => `<button type="button" class="tab" data-tab="${t.key}">${t.label} <span class="tab-count">${buckets[t.key].length}</span></button>`).join("")}
    </div>
    <div id="mywork-list" class="task-list"></div>
  `;

  const listEl = shell.querySelector<HTMLDivElement>("#mywork-list")!;
  const tabButtons = shell.querySelectorAll<HTMLButtonElement>(".tab");

  function renderTab(tab: MyWorkTab): void {
    active = tab;
    tabButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
    const items = buckets[tab];
    if (items.length === 0) {
      listEl.innerHTML = "<p>Nada por aqui.</p>";
      return;
    }
    listEl.innerHTML = items
      .map(
        (task) => `
      <button class="task-card" data-task-id="${task.id}">
        <span class="task-card-code">${task.code ?? ""} ${priorityBadge(task.prioridade)}</span>
        <span class="task-card-title">${escapeHtml(task.titulo)}</span>
        <span class="task-card-status">${statusBadge(task.status)}</span>
        <span class="task-card-deadline">${tab === "concluidas" && task.concluido_em ? "concluída em " + new Date(task.concluido_em).toLocaleDateString("pt-BR") : formatPrazo(task.prazo)}</span>
      </button>`,
      )
      .join("");
    listEl.querySelectorAll<HTMLButtonElement>(".task-card").forEach((card) => {
      card.addEventListener("click", () => onOpenTask(card.dataset.taskId!));
    });
  }

  tabButtons.forEach((btn) => btn.addEventListener("click", () => renderTab(btn.dataset.tab as MyWorkTab)));
  renderTab(active);
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

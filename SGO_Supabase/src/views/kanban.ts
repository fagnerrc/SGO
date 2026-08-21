import { listCompanyProfiles } from "../lib/profiles";
import { approvalWaitTask, auditTask, cancelTask, completeTask, listMyTasks, rejectTask, startTask, waitTask } from "../lib/tasks";
import type { Profile, Task, TaskStatus } from "../lib/types";
import { initials, priorityBadge } from "./badges";
import { openFormModal } from "./modal";
import { renderNav } from "./nav";

// All 7 statuses get a column. The other 3 (Concluída/Auditada/Cancelada)
// are terminal in the database (enforce_task_transition() blocks any
// further change once reached — see 0003_tasks.sql — and there is no
// reopen_task() yet), so their cards render without drag handles at all
// instead of allowing a gesture that would just fail server-side.
const COLUMNS: TaskStatus[] = [
  "Em andamento",
  "Aguardando terceiro",
  "Aguardando aprovação",
  "Reprovada/devolvida",
  "Concluída",
  "Auditada",
  "Cancelada",
];

const TERMINAL: Set<TaskStatus> = new Set(["Concluída", "Auditada", "Cancelada"]);

// What a card in status X may legally become, mirroring
// enforce_task_transition()'s gated_statuses map exactly — dropping
// anywhere else isn't offered at all rather than failing after the fact.
// Each performer collects whatever extra field the underlying RPC
// requires (via a small modal) and then calls it.
interface TransitionDef {
  target: TaskStatus;
  perform: (taskId: string) => Promise<unknown>;
}

function transitionsFor(task: Task): TransitionDef[] {
  const options: TransitionDef[] = [];
  const addWait = () =>
    options.push({
      target: "Aguardando terceiro",
      perform: async (taskId) => {
        const values = await openFormModal({
          title: "Colocar em espera",
          description: "Quem está sendo aguardado para a tarefa continuar?",
          fields: [
            { name: "aguardando_quem", label: "Aguardando quem", required: true },
            { name: "motivo", label: "Motivo (opcional)", type: "textarea" },
          ],
          confirmLabel: "Colocar em espera",
        });
        if (!values) return;
        await waitTask(taskId, values.aguardando_quem, values.motivo);
      },
    });
  const addApprovalWait = () =>
    options.push({ target: "Aguardando aprovação", perform: (taskId) => approvalWaitTask(taskId) });
  const addComplete = () =>
    options.push({
      target: "Concluída",
      perform: async (taskId) => {
        const values = await openFormModal({
          title: "Concluir tarefa",
          fields: [
            { name: "evidencia", label: "Evidência de execução", type: "textarea", required: true },
            { name: "justificativa", label: "Justificativa de atraso (se aplicável)", type: "textarea" },
          ],
          confirmLabel: "Concluir",
        });
        if (!values) return;
        await completeTask(taskId, values.evidencia, values.justificativa);
      },
    });
  const addCancel = () =>
    options.push({
      target: "Cancelada",
      perform: async (taskId) => {
        const values = await openFormModal({
          title: "Cancelar tarefa",
          fields: [{ name: "motivo", label: "Motivo do cancelamento", type: "textarea", required: true }],
          confirmLabel: "Cancelar tarefa",
        });
        if (!values) return;
        await cancelTask(taskId, values.motivo);
      },
    });
  const addResume = () => options.push({ target: "Em andamento", perform: (taskId) => startTask(taskId) });
  const addReject = () =>
    options.push({
      target: "Reprovada/devolvida",
      perform: async (taskId) => {
        const values = await openFormModal({
          title: "Reprovar / devolver tarefa",
          description: "Só o aprovador designado (ou um perfil privilegiado) pode reprovar de verdade.",
          fields: [{ name: "motivo", label: "Motivo da reprovação", type: "textarea", required: true }],
          confirmLabel: "Reprovar",
        });
        if (!values) return;
        await rejectTask(taskId, values.motivo);
      },
    });
  const addAudit = () => options.push({ target: "Auditada", perform: (taskId) => auditTask(taskId) });

  switch (task.status) {
    case "Em andamento":
      addWait();
      addApprovalWait();
      addComplete();
      addCancel();
      break;
    case "Aguardando terceiro":
      addResume();
      addCancel();
      break;
    case "Aguardando aprovação":
      addReject();
      addCancel();
      break;
    case "Reprovada/devolvida":
      addResume();
      addCancel();
      break;
    case "Concluída":
      addAudit();
      break;
    default:
      break; // Auditada / Cancelada: nothing legal, no drag handle.
  }
  return options;
}

export async function renderKanban(root: HTMLElement, onOpenTask: (taskId: string) => void): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "kanban");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;

  let tasks: Task[];
  let profiles: Profile[];
  try {
    [tasks, profiles] = await Promise.all([listMyTasks(), listCompanyProfiles()]);
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar o quadro: ${(err as Error).message}</p>`;
    return;
  }

  const profileById = new Map(profiles.map((p) => [p.id, p]));
  renderBoard(shell, tasks, profileById, onOpenTask, () => renderKanban(root, onOpenTask));
}

function renderBoard(
  shell: HTMLDivElement,
  tasks: Task[],
  profileById: Map<string, Profile>,
  onOpenTask: (taskId: string) => void,
  reload: () => void,
): void {
  const byStatus = new Map<string, Task[]>();
  for (const status of COLUMNS) byStatus.set(status, []);
  for (const task of tasks) byStatus.get(task.status)?.push(task);

  shell.innerHTML = `
    <h1>Quadro Kanban</h1>
    <p class="dashboard-subtitle">Arraste um card para uma coluna destacada, ou use o menu "Mover para..." no card.</p>
    <p id="kanban-error" class="error" hidden></p>
    <div class="kanban-board">
      ${COLUMNS.map((status) => {
        const items = byStatus.get(status)!;
        return `
        <div class="kanban-column${TERMINAL.has(status) ? " frozen" : ""}" data-status="${status}">
          <div class="kanban-column-header">
            <span>${escapeHtml(status)}</span>
            <span class="kanban-column-count">${items.length}</span>
          </div>
          <div class="kanban-column-cards">
            ${items.map((t) => renderCard(t, profileById)).join("")}
          </div>
        </div>`;
      }).join("")}
    </div>
  `;

  const errorEl = shell.querySelector<HTMLParagraphElement>("#kanban-error")!;
  const showError = (err: unknown) => {
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.hidden = false;
  };

  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  async function performMove(taskId: string, target: TaskStatus): Promise<void> {
    const task = tasksById.get(taskId);
    if (!task) return;
    const transition = transitionsFor(task).find((t) => t.target === target);
    if (!transition) return;
    try {
      await transition.perform(taskId);
      reload();
    } catch (err) {
      showError(err);
    }
  }

  shell.querySelectorAll<HTMLElement>(".kanban-card").forEach((card) => {
    const taskId = card.dataset.taskId!;
    card.addEventListener("click", () => onOpenTask(taskId));

    if (card.draggable) {
      card.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData("text/plain", taskId);
      });
    }

    const select = card.querySelector<HTMLSelectElement>(".kanban-move-select");
    select?.addEventListener("click", (event) => event.stopPropagation());
    select?.addEventListener("change", () => {
      const target = select.value as TaskStatus;
      select.value = "";
      if (target) void performMove(taskId, target);
    });
  });

  shell.querySelectorAll<HTMLElement>(".kanban-column").forEach((column) => {
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
      column.classList.add("drag-over");
    });
    column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
    column.addEventListener("drop", (event) => {
      event.preventDefault();
      column.classList.remove("drag-over");
      const taskId = event.dataTransfer?.getData("text/plain");
      const target = column.dataset.status as TaskStatus;
      if (taskId) void performMove(taskId, target);
    });
  });
}

function renderCard(task: Task, profileById: Map<string, Profile>): string {
  const options = transitionsFor(task);
  const draggable = options.length > 0;
  const responsavel = profileById.get(task.responsavel_id);
  const overdue = Boolean(task.prazo && new Date(task.prazo).getTime() < Date.now());

  return `
    <article class="kanban-card" draggable="${draggable}" data-task-id="${task.id}">
      <div class="kanban-card-top">
        <span class="kanban-card-code">${task.code ?? ""}</span>
        ${priorityBadge(task.prioridade)}
      </div>
      <span class="kanban-card-title">${escapeHtml(task.titulo)}</span>
      ${
        task.progresso > 0
          ? `<div class="kanban-card-progress"><span style="width:${task.progresso}%"></span></div>`
          : ""
      }
      <div class="kanban-card-footer">
        ${responsavel ? `<span class="kanban-card-avatar" title="${escapeHtml(responsavel.full_name)}">${initials(responsavel.full_name)}</span>` : "<span></span>"}
        <span class="kanban-card-deadline${overdue ? " overdue" : ""}">${task.prazo ? formatPrazo(task.prazo) : "sem prazo"}</span>
      </div>
      ${
        options.length > 0
          ? `<select class="kanban-move-select" aria-label="Mover tarefa">
              <option value="">Mover para...</option>
              ${options.map((o) => `<option value="${o.target}">${escapeHtml(o.target)}</option>`).join("")}
            </select>`
          : ""
      }
    </article>`;
}

function formatPrazo(prazo: string): string {
  return new Date(prazo).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

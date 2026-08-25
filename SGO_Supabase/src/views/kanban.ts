import { applyTaskFilters, DEFAULT_FILTERS, type TaskFilterState } from "../lib/taskFilters";
import { listCompanyProfiles } from "../lib/profiles";
import { approvalWaitTask, cancelTask, completeTask, listMyTasks, rejectTask, startTask, waitTask } from "../lib/tasks";
import type { Profile, Task, TaskStatus } from "../lib/types";
import { initials, priorityBadge, routineBadge } from "./badges";
import { renderFilterBar } from "./filterBar";
import { openFormModal } from "./modal";
import { renderNav } from "./nav";
import { toastSuccess } from "./toast";

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

// The board is for tracking work in flight, not an ever-growing archive —
// an open task (still actionable) always shows regardless of age, but a
// terminal one (Concluída/Auditada/Cancelada) only shows if it reached
// that state today; older finished cards just clutter the columns with
// nothing left to do on them. concluido_em is the natural "when this
// happened" timestamp for Concluída/Auditada; Cancelada doesn't set it
// (see cancel_task(), 0007), so updated_at covers that case too.
function isKanbanRelevant(task: Task, startOfTodayMs: number): boolean {
  if (!TERMINAL.has(task.status)) return true;
  const finishedAt = task.concluido_em ?? task.updated_at;
  return new Date(finishedAt).getTime() >= startOfTodayMs;
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// What a card in status X may legally become, mirroring
// enforce_task_transition()'s gated_statuses map exactly — dropping
// anywhere else isn't offered at all rather than failing after the fact.
// Each performer collects whatever extra field the underlying RPC
// requires (via a small modal) and then calls it.
interface TransitionDef {
  target: TaskStatus;
  // Resolves false when the person cancelled the modal (nothing
  // happened) so the caller can tell that apart from a real success —
  // otherwise a cancelled move would still show a "moved" toast.
  perform: (taskId: string) => Promise<boolean>;
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
        if (!values) return false;
        await waitTask(taskId, values.aguardando_quem, values.motivo);
        return true;
      },
    });
  const addApprovalWait = () =>
    options.push({
      target: "Aguardando aprovação",
      perform: async (taskId) => {
        await approvalWaitTask(taskId);
        return true;
      },
    });
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
        if (!values) return false;
        await completeTask(taskId, values.evidencia, values.justificativa);
        return true;
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
        if (!values) return false;
        await cancelTask(taskId, values.motivo);
        return true;
      },
    });
  const addResume = () =>
    options.push({
      target: "Em andamento",
      perform: async (taskId) => {
        await startTask(taskId);
        return true;
      },
    });
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
        if (!values) return false;
        await rejectTask(taskId, values.motivo);
        return true;
      },
    });
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
    default:
      break; // Concluída (audited from the dedicated Auditoria screen now,
      // not a Kanban drag — see 0030_audit_findings.sql) / Auditada /
      // Cancelada: nothing legal here, no drag handle.
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
    tasks = tasks.filter((t) => isKanbanRelevant(t, startOfTodayMs()));
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar o quadro: ${(err as Error).message}</p>`;
    return;
  }

  const profileById = new Map(profiles.map((p) => [p.id, p]));

  shell.innerHTML = `
    <h1>Quadro Kanban</h1>
    <p class="dashboard-subtitle">Tarefas em aberto e o que foi concluído/cancelado hoje. Arraste um card para uma coluna destacada, ou use o menu "Mover para..." no card.</p>
    <div id="filter-mount"></div>
    <p id="kanban-error" class="error" hidden></p>
    <div id="board-mount"></div>
  `;
  const boardMount = shell.querySelector<HTMLDivElement>("#board-mount")!;
  const errorEl = shell.querySelector<HTMLParagraphElement>("#kanban-error")!;
  const showError = (err: unknown) => {
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.hidden = false;
  };

  let currentFilter: TaskFilterState = { ...DEFAULT_FILTERS };

  async function reload(): Promise<void> {
    try {
      tasks = (await listMyTasks()).filter((t) => isKanbanRelevant(t, startOfTodayMs()));
    } catch (err) {
      showError(err);
      return;
    }
    renderBoard(boardMount, applyTaskFilters(tasks, currentFilter), profileById, onOpenTask, reload, showError);
  }

  renderFilterBar(shell.querySelector<HTMLDivElement>("#filter-mount")!, { profiles }, (state) => {
    currentFilter = state;
    renderBoard(boardMount, applyTaskFilters(tasks, state), profileById, onOpenTask, reload, showError);
  });
}

function renderBoard(
  boardMount: HTMLDivElement,
  tasks: Task[],
  profileById: Map<string, Profile>,
  onOpenTask: (taskId: string) => void,
  reload: () => void,
  showError: (err: unknown) => void,
): void {
  const byStatus = new Map<string, Task[]>();
  for (const status of COLUMNS) byStatus.set(status, []);
  for (const task of tasks) byStatus.get(task.status)?.push(task);

  boardMount.innerHTML = `
    <div class="kanban-board" style="--kanban-cols:${COLUMNS.length}">
      ${COLUMNS.map((status) => {
        const items = byStatus.get(status)!;
        return `
        <div class="kanban-column${TERMINAL.has(status) ? " frozen" : ""}" data-status="${status}">
          <div class="kanban-column-header">
            <span class="kanban-column-title" title="${escapeHtml(status)}">${escapeHtml(status)}</span>
            <span class="kanban-column-count">${items.length}</span>
          </div>
          <div class="kanban-column-cards">
            ${items.map((t) => renderCard(t, profileById)).join("")}
          </div>
        </div>`;
      }).join("")}
    </div>
  `;

  const shell = boardMount;
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  async function performMove(taskId: string, target: TaskStatus): Promise<void> {
    const task = tasksById.get(taskId);
    if (!task) return;
    const transition = transitionsFor(task).find((t) => t.target === target);
    if (!transition) return;
    try {
      const executed = await transition.perform(taskId);
      if (executed) {
        toastSuccess(`Tarefa movida para "${target}".`);
        reload();
      }
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
        ${priorityBadge(task.prioridade)} ${routineBadge(task.tipo)}
      </div>
      <span class="kanban-card-title" title="${escapeHtml(task.titulo)}">${escapeHtml(task.titulo)}</span>
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

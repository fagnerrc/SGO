import { cancelTask, completeTask, deleteTask, getChecklist, getTask, pauseTask, resumeTask, restoreTask, startTask, toggleChecklistItem } from "../lib/tasks";
import type { Task } from "../lib/types";
import { priorityBadge, riskBadge, statusBadge } from "./badges";
import { openFormModal } from "./modal";
import { renderNav } from "./nav";
import { toastSuccess } from "./toast";

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// "No prazo" vs "Atrasada": compares against concluido_em when the task
// is already done (so completing it late still shows as late forever,
// not just "on time now that the clock stopped"), otherwise against now.
function prazoIndicator(task: Task): { label: string; className: string } | null {
  if (!task.prazo) return null;
  const deadline = new Date(task.prazo).getTime();
  const reference = task.concluido_em ? new Date(task.concluido_em).getTime() : Date.now();
  return reference > deadline
    ? { label: "Atrasada", className: "prazo-badge prazo-late" }
    : { label: "No prazo", className: "prazo-badge prazo-ontime" };
}

// Same live-elapsed math as timerDock.ts's tick() — timer_total_ms only
// gets the running session folded into it when the timer actually stops
// (pause/complete), so displaying that field alone while running just
// shows whatever it was at the last stop, frozen, which is exactly the
// "não está contando" bug this fixes.
function liveElapsedMs(task: Task): number {
  if (task.timer_state !== "running") return task.timer_total_ms;
  const activeStarted = task.timer_active_started_at ? new Date(task.timer_active_started_at).getTime() : Date.now();
  return task.timer_total_ms + Math.max(0, Date.now() - activeStarted);
}

let tickHandle: ReturnType<typeof setInterval> | null = null;

export async function renderTaskDetail(root: HTMLElement, taskId: string, onBack: () => void): Promise<void> {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "tasks");

  let task: Task;
  try {
    task = await getTask(taskId);
  } catch (err) {
    root.querySelector(".app-shell")!.innerHTML = `<p class="error">Não foi possível carregar a tarefa: ${(err as Error).message}</p>`;
    return;
  }
  const checklist = await getChecklist(taskId).catch(() => []);

  const isTimed = task.tipo === "Tarefa cronometrada";
  const timerRunning = task.timer_state === "running";

  root.querySelector(".app-shell")!.innerHTML = `
      <header class="app-header">
        <button id="back-btn" class="link-button">&larr; Voltar</button>
        <h1>${task.code ?? ""}</h1>
      </header>
      <div class="task-detail">
        <h2>${escapeHtml(task.titulo)}</h2>
        <p class="task-detail-status">${statusBadge(task.status)} ${priorityBadge(task.prioridade)} ${riskBadge(task.risco)}</p>
        <p>${escapeHtml(task.descricao)}</p>

        ${
          task.data_inicio || task.prazo
            ? `
        <section class="schedule-panel">
          <p><strong>Início:</strong> ${formatDateTime(task.data_inicio)}</p>
          <p><strong>Prazo:</strong> ${formatDateTime(task.prazo)} ${
                (() => {
                  const indicator = prazoIndicator(task);
                  return indicator ? `<span class="${indicator.className}">${indicator.label}</span>` : "";
                })()
              }</p>
        </section>`
            : ""
        }

        ${
          task.excluido
            ? `
          <section class="trash-banner">
            <p>Esta tarefa foi excluída. Ela não aparece nas listas normais, mas nada foi perdido.</p>
            <button id="restore-task-btn" class="btn-primary">Restaurar tarefa</button>
          </section>`
            : ""
        }

        ${
          isTimed
            ? `
          <section class="timer-panel${timerRunning ? " timer-panel-running" : ""}">
            <p class="timer-status"><span class="status-dot${timerRunning ? " is-active" : ""}">●</span>${
              timerRunning ? "Cronômetro em andamento" : task.timer_state === "paused" ? "Cronômetro pausado" : "Cronômetro parado"
            }</p>
            <p class="timer-total" id="timer-total-live">${formatDuration(liveElapsedMs(task))}</p>
            <div class="timer-actions">
              ${!task.excluido && task.status === "Em andamento" && !timerRunning ? '<button id="start-btn">Iniciar</button>' : ""}
              ${!task.excluido && timerRunning ? '<button id="pause-btn" class="btn-outline">Pausar</button>' : ""}
              ${!task.excluido && task.status === "Em andamento" && task.timer_state === "paused" ? '<button id="resume-btn">Retomar</button>' : ""}
            </div>
          </section>`
            : ""
        }

        ${
          !isTimed
            ? `
        <section class="checklist-panel">
          <h3>Checklist</h3>
          <ul id="checklist-list">
            ${checklist
              .map(
                (item) => `
              <li>
                <label>
                  <input type="checkbox" data-item-id="${item.id}" ${item.feito ? "checked" : ""} ${task.excluido ? "disabled" : ""} />
                  ${escapeHtml(item.texto)}
                </label>
              </li>`,
              )
              .join("")}
          </ul>
        </section>`
            : ""
        }

        ${
          !task.excluido && !["Concluída", "Auditada", "Cancelada"].includes(task.status)
            ? `
          <section class="complete-panel">
            <h3>Concluir tarefa</h3>
            <label for="evidencia">Evidência de execução</label>
            <textarea id="evidencia" rows="3"></textarea>
            <label for="justificativa">Justificativa de atraso (se aplicável)</label>
            <textarea id="justificativa" rows="2"></textarea>
            <button id="complete-btn">Concluir</button>
          </section>
          <section class="cancel-panel">
            <button id="cancel-btn" class="danger-button">Cancelar tarefa</button>
          </section>`
            : ""
        }

        ${
          !task.excluido
            ? `
          <section class="cancel-panel">
            <button id="delete-task-btn" class="danger-button">Excluir tarefa</button>
          </section>`
            : ""
        }

        <p id="action-error" class="error" hidden></p>
      </div>
  `;

  root.querySelector("#back-btn")!.addEventListener("click", () => {
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
    onBack();
  });

  if (timerRunning) {
    tickHandle = setInterval(() => {
      const timeEl = root.querySelector<HTMLParagraphElement>("#timer-total-live");
      if (!timeEl) return;
      timeEl.textContent = formatDuration(liveElapsedMs(task));
    }, 1000);
  }

  const errorEl = root.querySelector<HTMLParagraphElement>("#action-error")!;
  const showError = (err: unknown) => {
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.hidden = false;
  };
  const reload = () => renderTaskDetail(root, taskId, onBack);

  root.querySelector("#start-btn")?.addEventListener("click", () =>
    startTask(taskId).then(reload).catch(showError),
  );
  root.querySelector("#pause-btn")?.addEventListener("click", () =>
    pauseTask(taskId).then(reload).catch(showError),
  );
  root.querySelector("#resume-btn")?.addEventListener("click", () =>
    resumeTask(taskId).then(reload).catch(showError),
  );
  root.querySelector("#complete-btn")?.addEventListener("click", () => {
    const evidencia = (root.querySelector("#evidencia") as HTMLTextAreaElement).value.trim();
    const justificativa = (root.querySelector("#justificativa") as HTMLTextAreaElement).value.trim();
    completeTask(taskId, evidencia, justificativa).then(reload).catch(showError);
  });
  root.querySelector("#cancel-btn")?.addEventListener("click", async () => {
    const values = await openFormModal({
      title: "Cancelar tarefa",
      fields: [{ name: "motivo", label: "Motivo do cancelamento", type: "textarea", required: true }],
      confirmLabel: "Cancelar tarefa",
    });
    if (!values) return;
    cancelTask(taskId, values.motivo).then(reload).catch(showError);
  });
  root.querySelector("#delete-task-btn")?.addEventListener("click", async () => {
    const confirmed = await openFormModal({
      title: "Excluir tarefa",
      description: "A tarefa some das listas normais, mas nada é perdido — dá para restaurar depois por aqui mesmo.",
      fields: [],
      confirmLabel: "Excluir tarefa",
    });
    if (!confirmed) return;
    deleteTask(taskId)
      .then(() => {
        toastSuccess("Tarefa excluída.");
        reload();
      })
      .catch(showError);
  });
  root.querySelector("#restore-task-btn")?.addEventListener("click", () => {
    restoreTask(taskId)
      .then(() => {
        toastSuccess("Tarefa restaurada.");
        reload();
      })
      .catch(showError);
  });

  root.querySelectorAll<HTMLInputElement>("#checklist-list input[type=checkbox]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const itemId = checkbox.dataset.itemId!;
      toggleChecklistItem(itemId, checkbox.checked).catch((err) => {
        checkbox.checked = !checkbox.checked;
        showError(err);
      });
    });
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

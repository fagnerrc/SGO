import { completeTask, getActiveTimerTask, pauseTask } from "../lib/tasks";
import type { Task } from "../lib/types";
import { openFormModal } from "./modal";
import { getCachedProfile } from "./nav";

// Rendered into a mount point outside #app (see main.ts / index.html) so
// it survives every route's `root.innerHTML = ...` re-render — the whole
// point of a dock is that it doesn't disappear when you navigate away
// from the task it's tracking.
let dockEl: HTMLElement | null = null;
let currentTask: Task | null = null;
let tickHandle: ReturnType<typeof setInterval> | null = null;

export function initTimerDock(container: HTMLElement): void {
  dockEl = container;
  void refreshTimerDock();
  setInterval(() => void refreshTimerDock(), 20000);
  window.addEventListener("hashchange", () => void refreshTimerDock());
  if (!tickHandle) tickHandle = setInterval(tick, 1000);
}

export async function refreshTimerDock(): Promise<void> {
  if (!dockEl) return;
  if (!localStorage.getItem("sgo.session") || location.hash === "#/login") {
    currentTask = null;
    dockEl.innerHTML = "";
    return;
  }
  try {
    const profile = await getCachedProfile();
    currentTask = await getActiveTimerTask(profile.id);
  } catch {
    currentTask = null;
  }
  render();
}

function render(): void {
  if (!dockEl) return;
  if (!currentTask) {
    dockEl.innerHTML = "";
    return;
  }
  const task = currentTask;
  dockEl.innerHTML = `
    <div class="timer-dock">
      <div class="timer-dock-info">
        <span class="timer-dock-code">${task.code ?? ""}</span>
        <span class="timer-dock-title">${escapeHtml(task.titulo)}</span>
        <span class="timer-dock-time" id="timer-dock-time">00:00:00</span>
      </div>
      <div class="timer-dock-actions">
        <button type="button" id="timer-dock-open" class="link-button">Abrir</button>
        <button type="button" id="timer-dock-pause" class="btn-outline">Pausar</button>
        <button type="button" id="timer-dock-complete">Concluir</button>
      </div>
    </div>
  `;
  dockEl.querySelector("#timer-dock-open")!.addEventListener("click", () => {
    location.hash = `#/tasks/${task.id}`;
  });
  dockEl.querySelector("#timer-dock-pause")!.addEventListener("click", async () => {
    try {
      await pauseTask(task.id);
    } finally {
      await refreshTimerDock();
    }
  });
  dockEl.querySelector("#timer-dock-complete")!.addEventListener("click", async () => {
    const values = await openFormModal({
      title: "Concluir tarefa",
      fields: [
        { name: "evidencia", label: "Evidência de execução", type: "textarea", required: true },
        { name: "justificativa", label: "Justificativa de atraso (se aplicável)", type: "textarea" },
      ],
      confirmLabel: "Concluir",
    });
    if (!values) return;
    try {
      await completeTask(task.id, values.evidencia, values.justificativa);
    } finally {
      await refreshTimerDock();
    }
  });
  tick();
}

function tick(): void {
  if (!currentTask || !dockEl) return;
  const timeEl = dockEl.querySelector<HTMLSpanElement>("#timer-dock-time");
  if (!timeEl) return;
  const activeStarted = currentTask.timer_active_started_at ? new Date(currentTask.timer_active_started_at).getTime() : Date.now();
  const elapsed = currentTask.timer_total_ms + Math.max(0, Date.now() - activeStarted);
  timeEl.textContent = formatDuration(elapsed);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

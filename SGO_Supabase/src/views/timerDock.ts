import { completeTask, listOpenTimerTasks, pauseTask, resumeTask, startTask } from "../lib/tasks";
import type { Task } from "../lib/types";
import { openFormModal } from "./modal";
import { getCachedProfile } from "./nav";
import { toastError } from "./toast";

// Rendered into a mount point outside #app (see main.ts / index.html) so
// it survives every route's `root.innerHTML = ...` re-render — the whole
// point of a dock is that it doesn't disappear when you navigate away
// from the task it's tracking.
//
// Multiple Tarefa cronometrada can be open at once (0034) — this shows
// the running one (or the most recently touched one, if none is
// currently running) as the primary card, and the rest behind an
// expandable "+N outras" list so you can switch to any of them without
// losing the others. Only one is ever actually running: resuming a
// different one auto-pauses whichever was running, server-side.
let dockEl: HTMLElement | null = null;
let openTasks: Task[] = [];
let othersExpanded = false;
let tickHandle: ReturnType<typeof setInterval> | null = null;

// Dragging: position is stored/persisted as left/top so it's independent
// of the default right/bottom anchoring — once the person drags it once,
// it stays wherever they left it (including across a reload).
const POSITION_KEY = "sgo.timerDockPos";
let dockPosition: { left: number; top: number } | null = loadDockPosition();

function loadDockPosition(): { left: number; top: number } | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.left === "number" && typeof parsed?.top === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

function clampPosition(left: number, top: number, el: HTMLElement): { left: number; top: number } {
  const rect = el.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  return { left: Math.min(Math.max(8, left), maxLeft), top: Math.min(Math.max(8, top), maxTop) };
}

function applyPosition(dock: HTMLElement): void {
  if (!dockPosition) return;
  const clamped = clampPosition(dockPosition.left, dockPosition.top, dock);
  dockPosition = clamped;
  dock.style.left = `${clamped.left}px`;
  dock.style.top = `${clamped.top}px`;
  dock.style.right = "auto";
  dock.style.bottom = "auto";
}

function startDrag(startEvent: PointerEvent, dock: HTMLElement): void {
  startEvent.preventDefault();
  const rect = dock.getBoundingClientRect();
  const offsetX = startEvent.clientX - rect.left;
  const offsetY = startEvent.clientY - rect.top;
  dock.classList.add("timer-dock-dragging");

  function onMove(e: PointerEvent): void {
    const { left, top } = clampPosition(e.clientX - offsetX, e.clientY - offsetY, dock);
    dock.style.left = `${left}px`;
    dock.style.top = `${top}px`;
    dock.style.right = "auto";
    dock.style.bottom = "auto";
  }
  function onUp(e: PointerEvent): void {
    window.removeEventListener("pointermove", onMove);
    dock.classList.remove("timer-dock-dragging");
    dockPosition = clampPosition(e.clientX - offsetX, e.clientY - offsetY, dock);
    localStorage.setItem(POSITION_KEY, JSON.stringify(dockPosition));
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

export function initTimerDock(container: HTMLElement): void {
  dockEl = container;
  void refreshTimerDock();
  setInterval(() => void refreshTimerDock(), 20000);
  window.addEventListener("hashchange", () => void refreshTimerDock());
  window.addEventListener("resize", () => {
    const dock = dockEl?.querySelector<HTMLElement>(".timer-dock");
    if (dock) applyPosition(dock);
  });
  if (!tickHandle) tickHandle = setInterval(tick, 1000);
}

// refreshTimerDock() is called from several independent, overlapping
// triggers — a 20s poll, every hashchange, and after every pause/resume/
// complete action — with no sequencing between them. Network responses
// don't always resolve in the order they were sent; without a guard, a
// slower call issued earlier can land AFTER a faster one and overwrite
// `openTasks` with stale data, corrupting what's on screen (the elapsed
// time visibly jumping backward/forward, a just-paused timer looking
// like it's still running, the whole widget seeming to "freeze" on an
// out-of-date snapshot). This token discards any response that isn't
// from the most recently issued call.
let refreshToken = 0;

export async function refreshTimerDock(): Promise<void> {
  if (!dockEl) return;
  if (!localStorage.getItem("sgo.session") || location.hash === "#/login") {
    refreshToken += 1;
    openTasks = [];
    dockEl.innerHTML = "";
    return;
  }
  const myToken = ++refreshToken;
  let fetched: Task[];
  try {
    const profile = await getCachedProfile();
    fetched = await listOpenTimerTasks(profile.id);
  } catch {
    fetched = [];
  }
  if (myToken !== refreshToken) return; // a newer refresh already started (or finished) — this result is stale
  openTasks = fetched;
  render();
}

function render(): void {
  if (!dockEl) return;
  if (openTasks.length === 0) {
    dockEl.innerHTML = "";
    return;
  }
  const primary = openTasks[0];
  const others = openTasks.slice(1);
  const running = primary.timer_state === "running";

  dockEl.innerHTML = `
    <div class="timer-dock">
      <span class="timer-dock-handle" title="Arrastar para mover" aria-hidden="true">⠿</span>
      <div class="timer-dock-info">
        <span class="timer-dock-code">${primary.code ?? ""}</span>
        <span class="timer-dock-title">${escapeHtml(primary.titulo)}</span>
        <span class="timer-dock-time" id="timer-dock-time">00:00:00</span>
      </div>
      <div class="timer-dock-actions">
        <button type="button" id="timer-dock-open" class="link-button">Abrir</button>
        ${
          running
            ? '<button type="button" id="timer-dock-pause" class="btn-outline">Pausar</button>'
            : '<button type="button" id="timer-dock-resume" class="btn-outline">Retomar</button>'
        }
        <button type="button" id="timer-dock-complete">Concluir</button>
        ${
          others.length > 0
            ? `<button type="button" id="timer-dock-others-toggle" class="timer-dock-others-toggle">+${others.length} outra${others.length > 1 ? "s" : ""}</button>`
            : ""
        }
      </div>
      ${
        others.length > 0
          ? `<div class="timer-dock-others-panel" id="timer-dock-others-panel" ${othersExpanded ? "" : "hidden"}>
              ${others
                .map(
                  (t) => `
                <div class="timer-dock-other-item">
                  <span class="timer-dock-other-title" title="${escapeHtml(t.titulo)}">${t.code ?? ""} ${escapeHtml(t.titulo)}</span>
                  <button type="button" class="link-button timer-dock-other-resume" data-task-id="${t.id}">Retomar</button>
                </div>`,
                )
                .join("")}
            </div>`
          : ""
      }
    </div>
  `;
  const dockNode = dockEl.querySelector<HTMLElement>(".timer-dock")!;
  applyPosition(dockNode);
  dockEl.querySelector<HTMLElement>(".timer-dock-handle")!.addEventListener("pointerdown", (e) => startDrag(e, dockNode));
  dockEl.querySelector("#timer-dock-open")!.addEventListener("click", () => {
    location.hash = `#/tasks/${primary.id}`;
  });
  dockEl.querySelector("#timer-dock-pause")?.addEventListener("click", async () => {
    try {
      await pauseTask(primary.id);
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    } finally {
      await refreshTimerDock();
    }
  });
  dockEl.querySelector("#timer-dock-resume")?.addEventListener("click", async () => {
    try {
      await (primary.status === "Em andamento" ? resumeTask(primary.id) : startTask(primary.id));
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
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
      await completeTask(primary.id, values.evidencia, values.justificativa);
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    } finally {
      await refreshTimerDock();
    }
  });
  dockEl.querySelector("#timer-dock-others-toggle")?.addEventListener("click", () => {
    othersExpanded = !othersExpanded;
    const panel = dockEl?.querySelector<HTMLElement>("#timer-dock-others-panel");
    if (panel) panel.hidden = !othersExpanded;
  });
  dockEl.querySelectorAll<HTMLButtonElement>(".timer-dock-other-resume").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const taskId = btn.dataset.taskId!;
      const task = others.find((t) => t.id === taskId);
      try {
        await (task?.status === "Em andamento" ? resumeTask(taskId) : startTask(taskId));
      } catch (err) {
        toastError(err instanceof Error ? err.message : String(err));
      } finally {
        othersExpanded = false;
        await refreshTimerDock();
      }
    });
  });
  tick();
}

function tick(): void {
  if (openTasks.length === 0 || !dockEl) return;
  const primary = openTasks[0];
  const timeEl = dockEl.querySelector<HTMLSpanElement>("#timer-dock-time");
  if (!timeEl) return;
  const activeStarted = primary.timer_state === "running" && primary.timer_active_started_at ? new Date(primary.timer_active_started_at).getTime() : null;
  const elapsed = primary.timer_total_ms + (activeStarted ? Math.max(0, Date.now() - activeStarted) : 0);
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

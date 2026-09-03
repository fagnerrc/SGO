import { Chart, registerables } from "chart.js";
import { applyTaskFilters, DEFAULT_FILTERS, type TaskFilterState } from "../lib/taskFilters";
import { listCompanyProfiles } from "../lib/profiles";
import { listDeletedTasks, listMyTasks, restoreTask } from "../lib/tasks";
import type { Profile, Task } from "../lib/types";
import { priorityBadge, statusBadge, STATUS_CHART_COLORS } from "./badges";
import { renderFilterBar } from "./filterBar";
import { renderNav } from "./nav";
import { toastError, toastSuccess } from "./toast";

Chart.register(...registerables);

const ALL_STATUSES = [
  "Em andamento",
  "Aguardando terceiro",
  "Aguardando aprovação",
  "Reprovada/devolvida",
  "Concluída",
  "Auditada",
  "Cancelada",
];

function formatPrazo(task: Task): string {
  if (!task.prazo) return "sem prazo";
  const date = new Date(task.prazo);
  const isTerminal = ["Concluída", "Auditada", "Cancelada"].includes(task.status);
  const overdue = !isTerminal && date.getTime() < Date.now();
  const formatted = date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return overdue ? `${formatted} (atrasada)` : formatted;
}

let statusChart: Chart | null = null;

export async function renderTaskList(root: HTMLElement, onOpenTask: (taskId: string) => void): Promise<void> {
  root.innerHTML = `
    <div id="nav-mount"></div>
    <div class="app-shell">
      <header class="app-header">
        <h1>Minhas tarefas</h1>
        <div class="app-header-actions">
          <button id="trash-toggle-btn" class="link-button">Ver excluídas</button>
          <button id="new-task-btn" class="btn-primary">+ Nova tarefa</button>
        </div>
      </header>
      <div id="trash-panel" class="card" hidden>
        <h3>Tarefas excluídas</h3>
        <div id="trash-list"><p>Carregando...</p></div>
      </div>
      <div id="filter-mount"></div>
      <div class="card dashboard-card task-status-overview-card">
        <div class="card-heading">
          <div><span class="eyebrow">Visão do filtro</span><h3>Distribuição por status</h3></div>
          <p class="chart-caption" id="filter-summary"></p>
        </div>
        <div class="task-status-overview">
          <div class="chart-box donut-chart-box task-status-donut">
            <canvas id="task-status-chart"></canvas>
            <div class="donut-center task-status-donut-center"><strong id="task-status-total">0</strong><span>tarefas</span></div>
          </div>
          <div class="task-status-summary" id="task-status-summary"></div>
        </div>
      </div>
      <div id="task-list" class="task-list">Carregando...</div>
    </div>
  `;
  await renderNav(root.querySelector("#nav-mount")!, "tasks");

  statusChart?.destroy();

  root.querySelector("#new-task-btn")!.addEventListener("click", () => {
    location.hash = "#/tasks/new";
  });

  const listEl = root.querySelector<HTMLDivElement>("#task-list")!;
  const summaryEl = root.querySelector<HTMLParagraphElement>("#filter-summary")!;
  const statusTotalEl = root.querySelector<HTMLElement>("#task-status-total")!;
  const statusSummaryEl = root.querySelector<HTMLElement>("#task-status-summary")!;

  let tasks: Task[];
  let profiles: Profile[];
  try {
    [tasks, profiles] = await Promise.all([listMyTasks(), listCompanyProfiles()]);
  } catch (err) {
    listEl.textContent = `Não foi possível carregar as tarefas: ${(err as Error).message}`;
    return;
  }

  const trashBtn = root.querySelector<HTMLButtonElement>("#trash-toggle-btn")!;
  const trashPanel = root.querySelector<HTMLDivElement>("#trash-panel")!;
  const trashListEl = root.querySelector<HTMLDivElement>("#trash-list")!;
  let trashLoaded = false;

  async function loadTrash(): Promise<void> {
    trashListEl.innerHTML = "<p>Carregando...</p>";
    let deleted: Task[];
    try {
      deleted = await listDeletedTasks();
    } catch (err) {
      trashListEl.innerHTML = `<p class="error">${escapeHtml((err as Error).message)}</p>`;
      return;
    }
    trashBtn.textContent = `Ver excluídas (${deleted.length})`;
    if (deleted.length === 0) {
      trashListEl.innerHTML = "<p>Nenhuma tarefa excluída.</p>";
      return;
    }
    trashListEl.innerHTML = deleted
      .map(
        (t) => `
      <div class="approval-card" data-task-id="${t.id}">
        <div>
          <span class="task-card-code">${t.code ?? ""} ${priorityBadge(t.prioridade)}</span>
          <span class="task-card-title">${escapeHtml(t.titulo)}</span>
        </div>
        <div class="approval-actions">
          <button class="btn-outline restore-task-btn" data-task-id="${t.id}">Restaurar</button>
        </div>
      </div>`,
      )
      .join("");
    trashListEl.querySelectorAll<HTMLButtonElement>(".restore-task-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await restoreTask(btn.dataset.taskId!);
          toastSuccess("Tarefa restaurada.");
          tasks = await listMyTasks();
          renderList(applyTaskFilters(tasks, currentFilterState));
          await loadTrash();
        } catch (err) {
          toastError((err as Error).message);
        }
      });
    });
  }

  trashBtn.addEventListener("click", async () => {
    trashPanel.hidden = !trashPanel.hidden;
    if (!trashPanel.hidden && !trashLoaded) {
      trashLoaded = true;
      await loadTrash();
    }
  });
  void listDeletedTasks()
    .then((d) => {
      if (d.length > 0) trashBtn.textContent = `Ver excluídas (${d.length})`;
    })
    .catch(() => {});

  let currentFilterState: TaskFilterState = { ...DEFAULT_FILTERS };

  const chartCtx = root.querySelector<HTMLCanvasElement>("#task-status-chart")!;

  function renderList(filtered: Task[]): void {
    summaryEl.textContent = `${filtered.length} de ${tasks.length} tarefa(s)`;

    const byStatus = new Map<string, number>();
    for (const t of filtered) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
    const labels = ALL_STATUSES.filter((status) => (byStatus.get(status) ?? 0) > 0);
    statusTotalEl.textContent = String(filtered.length);
    statusSummaryEl.innerHTML = labels.map((status) => {
      const count = byStatus.get(status) ?? 0;
      const percentage = filtered.length > 0 ? Math.round((count / filtered.length) * 100) : 0;
      const color = STATUS_CHART_COLORS[status] ?? "#8892a6";
      return `<div class="task-status-summary-row">
        <span class="task-status-summary-dot" style="background:${color}"></span>
        <span class="task-status-summary-name">${escapeHtml(status)}</span>
        <strong>${count}</strong>
        <small>${percentage}%</small>
        <span class="task-status-summary-track"><i style="width:${percentage}%;background:${color}"></i></span>
      </div>`;
    }).join("");
    statusChart?.destroy();
    statusChart = new Chart(chartCtx, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data: labels.map((l) => byStatus.get(l)!),
          backgroundColor: labels.map((l) => STATUS_CHART_COLORS[l] ?? "#8892a6"),
          borderColor: "#ffffff",
          borderWidth: 5,
          borderRadius: 8,
          hoverOffset: 10,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "74%",
        animation: { duration: 800, easing: "easeOutQuart" },
        plugins: { legend: { display: false }, tooltip: { backgroundColor: "#20382e", padding: 12, cornerRadius: 10, boxPadding: 4 } },
      },
    });

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
        <span class="task-card-deadline">${formatPrazo(task)}</span>
      `;
      card.addEventListener("click", () => onOpenTask(task.id));
      listEl.appendChild(card);
    }
  }

  renderFilterBar(
    root.querySelector<HTMLDivElement>("#filter-mount")!,
    { profiles, statuses: ALL_STATUSES, showSort: true },
    (state: TaskFilterState) => {
      currentFilterState = state;
      renderList(applyTaskFilters(tasks, state));
    },
  );
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

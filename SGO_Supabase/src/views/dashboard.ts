import { Chart, registerables } from "chart.js";
import { computeCompletionsByDay, computeDashboardStats, computeWorkload, listRecentActivity, listRecentCompletions } from "../lib/dashboard";
import { listCompanyProfiles } from "../lib/profiles";
import { listMyTasks } from "../lib/tasks";
import { initials, STATUS_CHART_COLORS } from "./badges";
import { renderNav } from "./nav";

Chart.register(...registerables);

let statusChart: Chart | null = null;
let trendChart: Chart | null = null;

export async function renderDashboard(root: HTMLElement, onOpenTask: (taskId: string) => void): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "dashboard");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;

  statusChart?.destroy();
  trendChart?.destroy();

  let tasks, profiles, activity, completions;
  try {
    [tasks, profiles, activity, completions] = await Promise.all([
      listMyTasks(),
      listCompanyProfiles(),
      listRecentActivity().catch(() => []),
      listRecentCompletions().catch(() => []),
    ]);
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar o dashboard: ${(err as Error).message}</p>`;
    return;
  }

  const stats = computeDashboardStats(tasks);
  const workload = computeWorkload(tasks, profiles);
  const trend = computeCompletionsByDay(completions);

  shell.innerHTML = `
    <h1 class="dashboard-title">Dashboard</h1>
    <p class="dashboard-subtitle">Indicadores calculados a partir das tarefas visíveis para você.</p>

    <div class="kpi-grid">
      <article class="kpi-tile tile-blue">
        <span class="kpi-tile-icon">${iconClipboard()}</span>
        <span class="kpi-label">Tarefas abertas</span>
        <div class="kpi-value">${stats.open}</div>
        <div class="kpi-sub">${stats.openDueToday} com prazo para hoje</div>
      </article>
      <article class="kpi-tile tile-pink">
        <span class="kpi-tile-icon">${iconAlert()}</span>
        <span class="kpi-label">Atrasadas</span>
        <div class="kpi-value">${stats.overdue}</div>
        <div class="kpi-sub">${stats.overdue > 0 ? "Requer atenção" : "Nenhum atraso"}</div>
      </article>
      <article class="kpi-tile tile-mint">
        <span class="kpi-tile-icon">${iconCheck()}</span>
        <span class="kpi-label">SLA cumprido</span>
        <div class="kpi-value">${stats.slaPercent === null ? "—" : stats.slaPercent + "%"}</div>
        <div class="kpi-sub">Baseado em tarefas concluídas</div>
      </article>
      <article class="kpi-tile tile-lavender">
        <span class="kpi-tile-icon">${iconStamp()}</span>
        <span class="kpi-label">Aprovações</span>
        <div class="kpi-value">${stats.approvalsPending}</div>
        <div class="kpi-sub">Aguardando decisão</div>
      </article>
    </div>

    <div class="dashboard-grid">
      <div class="card">
        <h3>Tarefas por status</h3>
        <div class="chart-box chart-box-sm"><canvas id="status-chart"></canvas></div>
      </div>
      <div class="card">
        <h3>Atividade recente</h3>
        <ul class="activity-list">
          ${
            activity
              .map(
                (a) => `
            <li class="activity-item" data-task-id="${a.task_id}">
              <span>${escapeHtml(a.action)}</span>
              <span class="activity-time">${new Date(a.at).toLocaleString("pt-BR")}</span>
            </li>`,
              )
              .join("") || "<li>Nenhuma atividade ainda.</li>"
          }
        </ul>
      </div>
    </div>

    <div class="dashboard-grid" style="margin-top:1rem">
      <div class="card">
        <h3>Tarefas concluídas (últimos 14 dias)</h3>
        <div class="chart-box"><canvas id="trend-chart"></canvas></div>
      </div>
      <div class="card">
        <h3>Carga por colaborador</h3>
        <p class="dashboard-subtitle" style="margin-bottom:0.75rem">Estimativa das tarefas abertas ÷ capacidade semanal cadastrada.</p>
        <div class="workload-list">
          ${
            workload
              .map(
                (w) => `
            <div class="workload-row">
              <span class="workload-avatar" title="${escapeHtml(w.name)}">${initials(w.name)}</span>
              <span class="workload-name" title="${escapeHtml(w.name)}">${escapeHtml(w.name)}</span>
              <div class="workload-bar-track"><div class="workload-bar-fill" style="width:${Math.min(w.occupancyPercent, 100)}%;background:${occupancyColor(w.occupancyPercent)}"></div></div>
              <span class="workload-count" style="color:${occupancyColor(w.occupancyPercent)}">${w.occupancyPercent}%</span>
            </div>`,
              )
              .join("") || "<p>Nenhuma tarefa em aberto ainda.</p>"
          }
        </div>
      </div>
    </div>
  `;

  shell.querySelectorAll<HTMLLIElement>(".activity-item[data-task-id]").forEach((el) => {
    el.addEventListener("click", () => onOpenTask(el.dataset.taskId!));
  });

  const statusCtx = shell.querySelector<HTMLCanvasElement>("#status-chart")!;
  statusChart = new Chart(statusCtx, {
    type: "doughnut",
    data: {
      labels: stats.byStatus.map((s) => s.status),
      datasets: [
        {
          data: stats.byStatus.map((s) => s.count),
          backgroundColor: stats.byStatus.map((s) => STATUS_CHART_COLORS[s.status] ?? "#8892a6"),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } },
    },
  });

  const trendCtx = shell.querySelector<HTMLCanvasElement>("#trend-chart")!;
  trendChart = new Chart(trendCtx, {
    type: "line",
    data: {
      labels: trend.map((t) => t.label),
      datasets: [
        {
          data: trend.map((t) => t.count),
          borderColor: "#1f6b45",
          backgroundColor: "rgba(31,107,69,0.12)",
          fill: true,
          tension: 0.35,
          pointRadius: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

function occupancyColor(percent: number): string {
  if (percent > 100) return "#c0522e";
  if (percent >= 80) return "#b3721f";
  return "#1f6b45";
}

function iconClipboard(): string {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/></svg>';
}
function iconAlert(): string {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
}
function iconCheck(): string {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="16 9 10.5 15 8 12.5"/></svg>';
}
function iconStamp(): string {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h14"/><path d="M5 2h14l-1.5 8h-11z" transform="translate(0 2)"/><circle cx="12" cy="9" r="4"/></svg>';
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

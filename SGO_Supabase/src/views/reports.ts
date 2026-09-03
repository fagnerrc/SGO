// Relatórios — ported from the old system's #page-relatorios: filters,
// KPIs, two Chart.js charts, a detailed table and a CSV export. See
// src/lib/reports.ts for the pure computations this view just renders.

import { Chart, registerables } from "chart.js";
import { listCompanyProfiles } from "../lib/profiles";
import {
  applyReportFilters,
  computeReportStats,
  DEFAULT_REPORT_FILTERS,
  formatTrackedTime,
  groupByArea,
  groupByPriority,
  tasksToCSV,
  type ReportFilters,
} from "../lib/reports";
import { listMyTasks } from "../lib/tasks";
import type { Profile, Task } from "../lib/types";
import { priorityBadge, PRIORITY_CHART_COLORS, statusBadge } from "./badges";
import { renderNav } from "./nav";

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

let priorityChart: Chart | null = null;
let areaChart: Chart | null = null;

export async function renderReports(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "reports");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;

  priorityChart?.destroy();
  areaChart?.destroy();

  let tasks: Task[];
  let profiles: Profile[];
  try {
    [tasks, profiles] = await Promise.all([listMyTasks(), listCompanyProfiles()]);
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar os relatórios: ${(err as Error).message}
      (esta tela é só para perfis privilegiados — gestor, diretoria, auditoria ou admin)</p>`;
    return;
  }

  const profileById = new Map(profiles.map((p) => [p.id, p]));
  let filters: ReportFilters = { ...DEFAULT_REPORT_FILTERS };

  shell.innerHTML = `
    <h1 class="dashboard-title">Relatórios</h1>
    <p class="dashboard-subtitle">Indicadores e exportação sobre as tarefas da empresa, filtráveis por responsável, status e período.</p>

    <div class="toolbar">
      <select id="rp-responsavel" class="control">
        <option value="">Todos os responsáveis</option>
        ${profiles.map((p) => `<option value="${p.id}">${escapeHtml(p.full_name)}</option>`).join("")}
      </select>
      <select id="rp-status" class="control">
        <option value="">Todos os status</option>
        ${ALL_STATUSES.map((s) => `<option value="${s}">${s}</option>`).join("")}
      </select>
      <label class="toolbar-inline-label">De <input id="rp-from" type="date" class="control" /></label>
      <label class="toolbar-inline-label">Até <input id="rp-to" type="date" class="control" /></label>
      <button type="button" id="rp-clear" class="btn-outline">Limpar</button>
      <button type="button" id="rp-export" class="btn-primary">Exportar CSV</button>
    </div>

    <div class="kpi-grid">
      <article class="kpi-tile tile-blue">
        <span class="kpi-label">Tarefas no filtro</span>
        <div class="kpi-value" id="kpi-total">0</div>
      </article>
      <article class="kpi-tile tile-mint">
        <span class="kpi-label">Concluídas</span>
        <div class="kpi-value" id="kpi-done">0</div>
      </article>
      <article class="kpi-tile tile-pink">
        <span class="kpi-label">Atrasadas</span>
        <div class="kpi-value" id="kpi-overdue">0</div>
      </article>
      <article class="kpi-tile tile-lavender">
        <span class="kpi-label">SLA cumprido</span>
        <div class="kpi-value" id="kpi-sla">—</div>
      </article>
      <article class="kpi-tile tile-blue">
        <span class="kpi-label">Tempo rastreado</span>
        <div class="kpi-value" id="kpi-tracked">0h00</div>
        <div class="kpi-sub" id="kpi-tracked-count">0 tarefas com cronômetro</div>
      </article>
    </div>

    <div class="dashboard-grid reports-chart-grid">
      <div class="card dashboard-card report-priority-card">
        <div class="card-heading">
          <div><span class="eyebrow">Composição</span><h3>Distribuição por prioridade</h3></div>
        </div>
        <div class="report-priority-overview">
          <div class="chart-box chart-box-sm donut-chart-box report-priority-donut">
            <canvas id="priority-chart"></canvas>
            <div class="donut-center"><strong id="priority-total">0</strong><span>tarefas</span></div>
          </div>
          <div class="priority-summary" id="priority-summary"></div>
        </div>
      </div>
      <div class="card dashboard-card report-area-card">
        <div class="card-heading">
          <div><span class="eyebrow">Volume operacional</span><h3>Tarefas por área</h3></div>
          <span class="chart-caption">quantidade no período</span>
        </div>
        <div class="chart-box report-area-chart-box"><canvas id="area-chart"></canvas></div>
      </div>
    </div>

    <div class="card table-card" style="margin-top:1rem">
      <table class="data-table">
        <colgroup>
          <col style="width:12%" /><col style="width:24%" /><col style="width:12%" /><col style="width:15%" />
          <col style="width:13%" /><col style="width:10%" /><col style="width:14%" />
        </colgroup>
        <thead>
          <tr><th>Código</th><th>Título</th><th>Área</th><th>Responsável</th><th>Status</th><th>Prioridade</th><th>Prazo</th></tr>
        </thead>
        <tbody id="report-rows"></tbody>
      </table>
    </div>
  `;

  const totalEl = shell.querySelector<HTMLDivElement>("#kpi-total")!;
  const doneEl = shell.querySelector<HTMLDivElement>("#kpi-done")!;
  const overdueEl = shell.querySelector<HTMLDivElement>("#kpi-overdue")!;
  const slaEl = shell.querySelector<HTMLDivElement>("#kpi-sla")!;
  const trackedEl = shell.querySelector<HTMLDivElement>("#kpi-tracked")!;
  const trackedCountEl = shell.querySelector<HTMLDivElement>("#kpi-tracked-count")!;
  const rowsEl = shell.querySelector<HTMLTableSectionElement>("#report-rows")!;
  const priorityCtx = shell.querySelector<HTMLCanvasElement>("#priority-chart")!;
  const priorityTotalEl = shell.querySelector<HTMLElement>("#priority-total")!;
  const prioritySummaryEl = shell.querySelector<HTMLElement>("#priority-summary")!;
  const areaCtx = shell.querySelector<HTMLCanvasElement>("#area-chart")!;

  function update(): void {
    const filtered = applyReportFilters(tasks, filters);
    const stats = computeReportStats(filtered);

    totalEl.textContent = String(stats.total);
    doneEl.textContent = String(stats.done);
    overdueEl.textContent = String(stats.overdue);
    slaEl.textContent = stats.slaPercent === null ? "—" : `${stats.slaPercent}%`;
    trackedEl.textContent = formatTrackedTime(stats.trackedTimeMs);
    trackedCountEl.textContent = `${stats.trackedCount} tarefa(s) com cronômetro`;

    rowsEl.innerHTML =
      filtered
        .map(
          (t) => `
      <tr>
        <td class="cell-primary">${t.code ?? ""}</td>
        <td data-label="Título" title="${escapeHtml(t.titulo)}">${escapeHtml(t.titulo)}</td>
        <td data-label="Área">${escapeHtml(t.area)}</td>
        <td data-label="Responsável" title="${escapeHtml(profileById.get(t.responsavel_id)?.full_name ?? "—")}">${escapeHtml(profileById.get(t.responsavel_id)?.full_name ?? "—")}</td>
        <td data-label="Status" class="wrap-cell">${statusBadge(t.status)}</td>
        <td data-label="Prioridade" class="wrap-cell">${priorityBadge(t.prioridade)}</td>
        <td data-label="Prazo">${t.prazo ? new Date(t.prazo).toLocaleDateString("pt-BR") : "—"}</td>
      </tr>`,
        )
        .join("") || `<tr><td colspan="7">Nenhuma tarefa encontrada com esses filtros.</td></tr>`;

    const byPriority = groupByPriority(filtered);
    const priorityTotal = byPriority.reduce((total, item) => total + item.count, 0);
    priorityTotalEl.textContent = String(priorityTotal);
    prioritySummaryEl.innerHTML = byPriority.map((item) => {
      const percentage = priorityTotal > 0 ? Math.round((item.count / priorityTotal) * 100) : 0;
      const color = PRIORITY_CHART_COLORS[item.priority] ?? "#8892a6";
      return `<div class="priority-summary-row">
        <span class="priority-summary-dot" style="background:${color}"></span>
        <span class="priority-summary-name">${escapeHtml(item.priority)}</span>
        <strong>${item.count}</strong>
        <small>${percentage}%</small>
        <span class="priority-summary-track"><i style="width:${percentage}%;background:${color}"></i></span>
      </div>`;
    }).join("");
    priorityChart?.destroy();
    priorityChart = new Chart(priorityCtx, {
      type: "doughnut",
      data: {
        labels: byPriority.map((p) => p.priority),
        datasets: [{
          data: byPriority.map((p) => p.count),
          backgroundColor: byPriority.map((p) => PRIORITY_CHART_COLORS[p.priority] ?? "#8892a6"),
          borderColor: "#ffffff",
          borderWidth: 5,
          borderRadius: 8,
          hoverOffset: 12,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "72%",
        animation: { duration: 900, easing: "easeOutQuart" },
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: "#20382e", padding: 12, cornerRadius: 10, displayColors: true, boxPadding: 5 },
        },
      },
    });

    const allAreas = groupByArea(filtered);
    const byArea = allAreas.slice(0, 11);
    const remainingAreas = allAreas.slice(11);
    if (remainingAreas.length > 0) {
      byArea.push({ area: `Outras áreas (${remainingAreas.length})`, count: remainingAreas.reduce((total, area) => total + area.count, 0) });
    }
    areaChart?.destroy();
    areaChart = new Chart(areaCtx, {
      type: "bar",
      data: {
        labels: byArea.map((a) => a.area),
        datasets: [{
          data: byArea.map((a) => a.count),
          backgroundColor: byArea.map((area, index) => area.area.startsWith("Outras áreas") ? "#b7c9c0" : index === 0 ? "#176b48" : index < 3 ? "#3d936d" : "#80bea1"),
          hoverBackgroundColor: "#155c3c",
          borderRadius: 8,
          borderSkipped: false,
          barThickness: 16,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        animation: { duration: 850, easing: "easeOutQuart" },
        interaction: { intersect: false, mode: "index" },
        plugins: { legend: { display: false }, tooltip: { backgroundColor: "#20382e", padding: 12, cornerRadius: 10, displayColors: false } },
        scales: {
          x: { beginAtZero: true, border: { display: false }, grid: { color: "rgba(62,91,77,.09)" }, ticks: { precision: 0, color: "#8b96a4", font: { size: 10 } } },
          y: { border: { display: false }, grid: { display: false }, ticks: { color: "#405249", font: { size: 11, weight: 600 }, autoSkip: false, padding: 8 } },
        },
      },
    });
  }

  const bind = (id: string, field: keyof ReportFilters) => {
    const el = shell.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
    el.addEventListener(el.tagName === "INPUT" ? "input" : "change", () => {
      filters = { ...filters, [field]: el.value };
      update();
    });
  };
  bind("rp-responsavel", "responsavelId");
  bind("rp-status", "status");
  bind("rp-from", "from");
  bind("rp-to", "to");

  shell.querySelector("#rp-clear")!.addEventListener("click", () => {
    filters = { ...DEFAULT_REPORT_FILTERS };
    shell.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".toolbar .control").forEach((el) => (el.value = ""));
    update();
  });

  shell.querySelector("#rp-export")!.addEventListener("click", () => {
    const filtered = applyReportFilters(tasks, filters);
    const csv = tasksToCSV(filtered, profileById);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `SGO_Relatorio_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  update();
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

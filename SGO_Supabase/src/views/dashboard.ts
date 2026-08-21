import { computeDashboardStats, listRecentActivity } from "../lib/dashboard";
import { listMyTasks } from "../lib/tasks";
import { renderNav } from "./nav";

export async function renderDashboard(root: HTMLElement, onOpenTask: (taskId: string) => void): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "dashboard");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;

  let tasks;
  try {
    tasks = await listMyTasks();
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar o dashboard: ${(err as Error).message}</p>`;
    return;
  }

  const stats = computeDashboardStats(tasks);
  const activity = await listRecentActivity().catch(() => []);

  const maxStatusCount = Math.max(1, ...stats.byStatus.map((s) => s.count));

  shell.innerHTML = `
    <h1 class="dashboard-title">Dashboard</h1>
    <p class="dashboard-subtitle">Indicadores calculados a partir das tarefas visíveis para você.</p>

    <div class="kpi-grid">
      <article class="kpi-card">
        <span class="kpi-label">Tarefas abertas</span>
        <div class="kpi-value">${stats.open}</div>
        <div class="kpi-sub">${stats.openDueToday} com prazo para hoje</div>
      </article>
      <article class="kpi-card kpi-pink">
        <span class="kpi-label">Atrasadas</span>
        <div class="kpi-value">${stats.overdue}</div>
        <div class="kpi-sub">${stats.overdue > 0 ? "Requer atenção" : "Nenhum atraso"}</div>
      </article>
      <article class="kpi-card kpi-green">
        <span class="kpi-label">SLA cumprido</span>
        <div class="kpi-value">${stats.slaPercent === null ? "—" : stats.slaPercent + "%"}</div>
        <div class="kpi-sub">Baseado em tarefas concluídas</div>
      </article>
      <article class="kpi-card kpi-peach">
        <span class="kpi-label">Aprovações</span>
        <div class="kpi-value">${stats.approvalsPending}</div>
        <div class="kpi-sub">Aguardando decisão</div>
      </article>
    </div>

    <div class="dashboard-grid">
      <div class="card">
        <h3>Tarefas por status</h3>
        <div class="status-bars">
          ${stats.byStatus
            .map(
              (s) => `
            <div class="status-bar-row">
              <span class="status-bar-label">${escapeHtml(s.status)}</span>
              <div class="status-bar-track"><div class="status-bar-fill" style="width:${(s.count / maxStatusCount) * 100}%"></div></div>
              <span class="status-bar-count">${s.count}</span>
            </div>`,
            )
            .join("") || "<p>Nenhuma tarefa ainda.</p>"}
        </div>
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
  `;

  shell.querySelectorAll<HTMLLIElement>(".activity-item[data-task-id]").forEach((el) => {
    el.addEventListener("click", () => onOpenTask(el.dataset.taskId!));
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

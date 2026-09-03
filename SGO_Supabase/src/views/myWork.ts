import { Chart, registerables } from "chart.js";
import { bucketMyWork, type MyWorkTab } from "../lib/myWork";
import { listMyTasks } from "../lib/tasks";
import type { Task } from "../lib/types";
import { priorityBadge, statusBadge } from "./badges";
import { getCachedProfile, renderNav } from "./nav";

Chart.register(...registerables);

const TABS: { key: MyWorkTab; label: string }[] = [
  { key: "hoje_atrasadas", label: "Hoje e atrasadas" },
  { key: "proximas", label: "Próximas" },
  { key: "aguardando", label: "Aguardando" },
  { key: "devolvidas", label: "Devolvidas" },
  { key: "concluidas", label: "Concluídas" },
];

const BUCKET_CHART_COLORS: Record<MyWorkTab, string> = {
  hoje_atrasadas: "#c0522e",
  proximas: "#2f6fa0",
  aguardando: "#e0954b",
  devolvidas: "#d6527d",
  concluidas: "#2fa968",
};

let bucketChart: Chart | null = null;

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
  const myTaskTotal = TABS.reduce((total, tab) => total + buckets[tab.key].length, 0);
  let active: MyWorkTab = buckets.hoje_atrasadas.length > 0 ? "hoje_atrasadas" : "proximas";

  bucketChart?.destroy();

  shell.innerHTML = `
    <h1 class="dashboard-title">Meu trabalho</h1>
    <p class="dashboard-subtitle">Só as tarefas em que você é responsável ou participante — separadas pelo que precisa de atenção agora.</p>
    <div class="card dashboard-card mywork-panorama-card">
      <div class="card-heading">
        <div><span class="eyebrow">Distribuição atual</span><h3>Panorama do seu trabalho</h3></div>
        <span class="chart-caption">${myTaskTotal} no seu fluxo</span>
      </div>
      <div class="mywork-overview">
        <div class="chart-box mywork-chart-box donut-chart-box">
          <canvas id="mywork-chart"></canvas>
          <div class="donut-center mywork-donut-center"><strong>${myTaskTotal}</strong><span>tarefas</span></div>
        </div>
        <div class="mywork-chart-summary">
          ${TABS.map((tab) => {
            const count = buckets[tab.key].length;
            const percentage = myTaskTotal > 0 ? Math.round((count / myTaskTotal) * 100) : 0;
            return `<div class="mywork-summary-row">
              <span class="mywork-summary-dot" style="background:${BUCKET_CHART_COLORS[tab.key]}"></span>
              <span class="mywork-summary-label">${tab.label}</span>
              <span class="mywork-summary-count">${count}</span>
              <span class="mywork-summary-percent">${percentage}%</span>
              <span class="mywork-summary-track"><i style="width:${percentage}%;background:${BUCKET_CHART_COLORS[tab.key]}"></i></span>
            </div>`;
          }).join("")}
        </div>
      </div>
    </div>
    <div class="tabs" id="mywork-tabs">
      ${TABS.map((t) => `<button type="button" class="tab" data-tab="${t.key}">${t.label} <span class="tab-count">${buckets[t.key].length}</span></button>`).join("")}
    </div>
    <div id="mywork-list" class="task-list"></div>
  `;

  const listEl = shell.querySelector<HTMLDivElement>("#mywork-list")!;
  const tabButtons = shell.querySelectorAll<HTMLButtonElement>(".tab");

  const bucketCtx = shell.querySelector<HTMLCanvasElement>("#mywork-chart")!;
  bucketChart = new Chart(bucketCtx, {
    type: "doughnut",
    data: {
      labels: TABS.map((t) => t.label),
      datasets: [{
        data: TABS.map((t) => buckets[t.key].length),
        backgroundColor: TABS.map((t) => BUCKET_CHART_COLORS[t.key]),
        hoverBackgroundColor: TABS.map((t) => BUCKET_CHART_COLORS[t.key]),
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
      animation: { duration: 850, easing: "easeOutQuart" },
      interaction: { intersect: false, mode: "index" },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: "#20382e", padding: 12, cornerRadius: 10, displayColors: false } },
    },
  });

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

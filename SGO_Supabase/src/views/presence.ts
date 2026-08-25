// Presença / Atividade da Equipe — full screen version of the sidebar
// widget (nav.ts): who's working right now, who's stepped away, and who
// has gone dark for over 2h. All status/label computation lives in
// lib/presence.ts and is purely local (no server round-trip to tick a
// counter — section 11 of the spec); this view only fetches the team
// list once per render and a lightweight local timer keeps the "há
// Xh Ymin" text current.

import {
  computePresenceStatus,
  INACTIVE_THRESHOLD_MS,
  lastActivityClockLabel,
  listTeamPresence,
  presenceStatusLabel,
  sortByPresence,
  type PresenceStatus,
  type TeamPresenceRow,
} from "../lib/presence";
import { initials, roleLabel } from "./badges";
import { renderNav } from "./nav";

type PresenceFilter = "todos" | "ativo" | "ausente" | "inativo";

const FILTERS: { key: PresenceFilter; label: string }[] = [
  { key: "todos", label: "Todos" },
  { key: "ativo", label: "Ativos" },
  { key: "ausente", label: "Ausentes" },
  { key: "inativo", label: "Inativos +2h" },
];

let tickInterval: ReturnType<typeof setInterval> | null = null;

export async function renderPresence(root: HTMLElement): Promise<void> {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "presence");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;
  let profiles: TeamPresenceRow[];
  try {
    profiles = await listTeamPresence();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    shell.innerHTML = message.includes("SGO_FORBIDDEN")
      ? `<p class="error">Acesso restrito a administradores, diretoria e processos/auditoria.</p>`
      : `<p class="error">Não foi possível carregar a equipe: ${message}</p>`;
    return;
  }

  const queryFilter = new URLSearchParams(location.hash.split("?")[1] ?? "").get("filter");
  let activeFilter: PresenceFilter = queryFilter === "inativos" ? "inativo" : "todos";
  let search = "";

  shell.innerHTML = `
    <h1 class="dashboard-title">Presença</h1>
    <p class="dashboard-subtitle">Quem está trabalhando agora, quem se afastou e quem está há mais de 2h sem nenhuma atividade no SGO.</p>

    <div class="kpi-grid" id="presence-kpis"></div>

    <div class="tabs" id="presence-filters">
      ${FILTERS.map((f) => `<button type="button" class="tab${f.key === activeFilter ? " active" : ""}" data-filter="${f.key}">${f.label}</button>`).join("")}
    </div>
    <input id="presence-search" type="text" placeholder="Buscar colaborador por nome..." class="presence-search" />

    <div id="presence-list" class="presence-list"></div>
  `;

  const kpisEl = shell.querySelector<HTMLDivElement>("#presence-kpis")!;
  const listEl = shell.querySelector<HTMLDivElement>("#presence-list")!;

  function render(): void {
    const counts = { ativo: 0, ausente: 0, inativo: 0 };
    for (const p of profiles) counts[computePresenceStatus(p.last_activity_at)]++;

    kpisEl.innerHTML = `
      <article class="kpi-tile tile-blue">
        <span class="kpi-label">Colaboradores</span>
        <div class="kpi-value">${profiles.length}</div>
      </article>
      <article class="kpi-tile tile-mint">
        <span class="kpi-label">Ativos</span>
        <div class="kpi-value">${counts.ativo}</div>
      </article>
      <article class="kpi-tile tile-lavender">
        <span class="kpi-label">Ausentes</span>
        <div class="kpi-value">${counts.ausente}</div>
      </article>
      <article class="kpi-tile tile-pink">
        <span class="kpi-label">Inativos +2h</span>
        <div class="kpi-value">${counts.inativo}</div>
      </article>
    `;

    const searchLower = search.trim().toLowerCase();
    const filtered = sortByPresence(profiles).filter((p) => {
      if (activeFilter !== "todos" && computePresenceStatus(p.last_activity_at) !== activeFilter) return false;
      if (searchLower && !p.full_name.toLowerCase().includes(searchLower)) return false;
      return true;
    });

    listEl.innerHTML =
      filtered.length === 0
        ? `<p class="dropdown-empty">Nenhum colaborador encontrado.</p>`
        : filtered.map((p) => presenceCardHtml(p)).join("");
  }

  render();

  shell.querySelectorAll<HTMLButtonElement>("#presence-filters .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.filter as PresenceFilter;
      shell.querySelectorAll("#presence-filters .tab").forEach((b) => b.classList.toggle("active", b === btn));
      render();
    });
  });

  shell.querySelector<HTMLInputElement>("#presence-search")!.addEventListener("input", (event) => {
    search = (event.target as HTMLInputElement).value;
    render();
  });

  // Local-only tick: recomputes and repaints "há Xh Ymin" from the same
  // already-fetched `profiles` array — never a new request just to move a
  // counter forward (section 11/12).
  tickInterval = setInterval(render, 30_000);
}

function presenceCardHtml(p: TeamPresenceRow): string {
  const status = computePresenceStatus(p.last_activity_at);
  const isCritical = status === "inativo" && p.last_activity_at !== null && Date.now() - new Date(p.last_activity_at).getTime() > INACTIVE_THRESHOLD_MS;
  const subtitle = p.area || roleLabel(p.role);

  return `
    <article class="presence-card${isCritical ? " presence-card-alert" : ""}">
      ${isCritical ? '<span class="presence-card-alert-icon">⚠</span>' : ""}
      <span class="avatar presence-avatar">${initials(p.full_name)}</span>
      <div class="presence-card-info">
        <span class="presence-card-name">${escapeHtml(p.full_name)}</span>
        <span class="presence-card-role">${escapeHtml(subtitle)}</span>
      </div>
      <div class="presence-card-status">
        <span class="presence-status-label presence-status-${status}">${presenceDot(status)} ${presenceStatusLabel(p.last_activity_at)}</span>
        <span class="presence-card-clock">Última atividade: ${p.last_activity_at ? lastActivityClockLabel(p.last_activity_at) : "—"}</span>
      </div>
    </article>`;
}

function presenceDot(status: PresenceStatus): string {
  if (status === "ativo") return "🟢";
  if (status === "ausente") return "🟡";
  return "🔴";
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

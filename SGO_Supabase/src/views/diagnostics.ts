// Diagnóstico — admin-only screen reading the `logs` table (kind:
// activity/audit/security/diagnostic) that already existed server-side
// (0005/0012) but never had a UI. See src/lib/diagnostics.ts for the
// capture side (main.ts's global handlers, supabase.ts's
// throwSupabaseError) and the active health checks this screen runs.

import {
  applyLogFilters,
  DEFAULT_LOG_FILTERS,
  downloadFile,
  getCronStatus,
  listLogs,
  logsToCSV,
  logsToJSON,
  runHealthChecks,
  type HealthCheckResult,
  type LogFilters,
} from "../lib/diagnostics";
import { adminListProfiles } from "../lib/profiles";
import type { CronJobStatus, LogEntry, Profile } from "../lib/types";
import { levelBadge } from "./badges";
import { renderNav } from "./nav";
import { toastError } from "./toast";

const LEVEL_OPTIONS = ["info", "warn", "error"];
const KIND_OPTIONS = ["activity", "audit", "security", "diagnostic"];
const KIND_LABEL: Record<string, string> = { activity: "Atividade", audit: "Auditoria", security: "Segurança", diagnostic: "Diagnóstico" };

export async function renderDiagnostics(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "diagnostics");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;

  let logs: LogEntry[];
  let profiles: Profile[];
  try {
    [logs, profiles] = await Promise.all([listLogs(), adminListProfiles()]);
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar o diagnóstico: ${(err as Error).message}
      (esta tela é só para perfis privilegiados — diretoria, auditoria ou admin)</p>`;
    return;
  }

  const profileById = new Map(profiles.map((p) => [p.id, p]));
  let filters: LogFilters = { ...DEFAULT_LOG_FILTERS };

  shell.innerHTML = `
    <h1 class="dashboard-title">Diagnóstico</h1>
    <p class="dashboard-subtitle">Erros e eventos técnicos capturados automaticamente, checagens ativas de saúde do sistema, e exportação para investigar problemas.</p>

    <div class="card" id="health-card">
      <div class="app-header" style="margin-bottom:0.75rem">
        <h3>Diagnóstico do sistema</h3>
        <button type="button" id="run-health-btn" class="btn-primary">Rodar diagnóstico agora</button>
      </div>
      <div id="health-results"><p>Carregando...</p></div>
    </div>

    <div class="kpi-grid">
      <article class="kpi-tile tile-blue">
        <span class="kpi-label">Eventos no filtro</span>
        <div class="kpi-value" id="kpi-total">0</div>
      </article>
      <article class="kpi-tile tile-pink">
        <span class="kpi-label">Erros</span>
        <div class="kpi-value" id="kpi-errors">0</div>
      </article>
      <article class="kpi-tile tile-lavender">
        <span class="kpi-label">Alertas</span>
        <div class="kpi-value" id="kpi-warns">0</div>
      </article>
      <article class="kpi-tile tile-mint">
        <span class="kpi-label">Últimas 24h</span>
        <div class="kpi-value" id="kpi-recent">0</div>
      </article>
    </div>

    <div class="toolbar">
      <select id="dg-level" class="control">
        <option value="">Todos os níveis</option>
        ${LEVEL_OPTIONS.map((l) => `<option value="${l}">${l === "info" ? "Info" : l === "warn" ? "Alerta" : "Erro"}</option>`).join("")}
      </select>
      <select id="dg-kind" class="control">
        <option value="">Todas as categorias</option>
        ${KIND_OPTIONS.map((k) => `<option value="${k}">${KIND_LABEL[k]}</option>`).join("")}
      </select>
      <input id="dg-search" class="control grow" placeholder="Buscar por ação ou mensagem..." />
      <label class="toolbar-inline-label">De <input id="dg-from" type="date" class="control" /></label>
      <label class="toolbar-inline-label">Até <input id="dg-to" type="date" class="control" /></label>
      <button type="button" id="dg-clear" class="btn-outline">Limpar</button>
      <button type="button" id="dg-export-csv" class="btn-outline">Exportar CSV</button>
      <button type="button" id="dg-export-json" class="btn-primary">Exportar JSON</button>
    </div>

    <div class="card table-card">
      <table class="data-table">
        <colgroup>
          <col style="width:14%" /><col style="width:9%" /><col style="width:11%" /><col style="width:16%" />
          <col style="width:14%" /><col style="width:26%" /><col style="width:10%" />
        </colgroup>
        <thead>
          <tr><th>Data</th><th>Nível</th><th>Categoria</th><th>Ação</th><th>Usuário</th><th>Mensagem</th><th></th></tr>
        </thead>
        <tbody id="log-rows"></tbody>
      </table>
    </div>
  `;

  const healthResultsEl = shell.querySelector<HTMLDivElement>("#health-results")!;
  const rowsEl = shell.querySelector<HTMLTableSectionElement>("#log-rows")!;

  function renderHealth(results: HealthCheckResult[], cronJobs: CronJobStatus[] | null): void {
    healthResultsEl.innerHTML = `
      <ul class="health-check-list">
        ${results
          .map(
            (r) => `
          <li class="health-check-item${r.ok ? " ok" : " fail"}">
            <span class="health-check-icon">${r.ok ? "✓" : "✗"}</span>
            <div>
              <span class="health-check-name">${escapeHtml(r.name)}</span>
              <span class="health-check-detail">${escapeHtml(r.detail)}</span>
            </div>
            <span class="health-check-duration">${r.durationMs}ms</span>
          </li>`,
          )
          .join("")}
      </ul>
      ${
        cronJobs
          ? `
        <table class="data-table" style="margin-top:0.75rem">
          <thead><tr><th>Job agendado</th><th>Ativo</th><th>Última execução</th><th>Status</th></tr></thead>
          <tbody>
            ${cronJobs
              .map(
                (j) => `
              <tr>
                <td class="cell-primary">${escapeHtml(j.jobname)}</td>
                <td data-label="Ativo">${j.active ? "Sim" : "Não"}</td>
                <td data-label="Última execução">${j.last_start ? new Date(j.last_start).toLocaleString("pt-BR") : "nunca rodou"}</td>
                <td data-label="Status">${j.last_status ?? "—"}</td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>`
          : ""
      }
    `;
  }

  async function runHealth(): Promise<void> {
    healthResultsEl.innerHTML = "<p>Rodando checagens...</p>";
    try {
      const [results, cronJobs] = await Promise.all([runHealthChecks(), getCronStatus().catch(() => null)]);
      renderHealth(results, cronJobs);
    } catch (err) {
      healthResultsEl.innerHTML = `<p class="error">${escapeHtml((err as Error).message)}</p>`;
    }
  }

  function update(): void {
    const filtered = applyLogFilters(logs, filters);
    shell.querySelector("#kpi-total")!.textContent = String(filtered.length);
    shell.querySelector("#kpi-errors")!.textContent = String(filtered.filter((l) => l.level === "error").length);
    shell.querySelector("#kpi-warns")!.textContent = String(filtered.filter((l) => l.level === "warn").length);
    const dayAgo = Date.now() - 86400000;
    shell.querySelector("#kpi-recent")!.textContent = String(filtered.filter((l) => new Date(l.created_at).getTime() > dayAgo).length);

    rowsEl.innerHTML =
      filtered
        .slice(0, 200)
        .map((l) => {
          const message = String(l.details?.message ?? "");
          const userName = profileById.get(l.user_id)?.full_name ?? "—";
          return `
        <tr data-log-id="${l.id}">
          <td class="cell-primary">${new Date(l.created_at).toLocaleString("pt-BR")}</td>
          <td data-label="Nível" class="wrap-cell">${levelBadge(l.level)}</td>
          <td data-label="Categoria">${KIND_LABEL[l.kind] ?? l.kind}</td>
          <td data-label="Ação">${escapeHtml(l.action)}</td>
          <td data-label="Usuário" title="${escapeHtml(userName)}">${escapeHtml(userName)}</td>
          <td data-label="Mensagem" class="wrap-cell" title="${escapeHtml(message)}">${escapeHtml(message.slice(0, 80))}${message.length > 80 ? "…" : ""}</td>
          <td data-label="" class="wrap-cell actions-cell"><button class="link-button log-detail-btn" data-log-id="${l.id}">ver detalhes</button></td>
        </tr>`;
        })
        .join("") || `<tr><td colspan="7">Nenhum evento encontrado com esses filtros.</td></tr>`;

    rowsEl.querySelectorAll<HTMLButtonElement>(".log-detail-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = filtered.find((l) => String(l.id) === btn.dataset.logId);
        if (entry) showLogDetail(entry, userNameFor(entry));
      });
    });
  }

  function userNameFor(entry: LogEntry): string {
    return profileById.get(entry.user_id)?.full_name ?? entry.user_id;
  }

  const bind = (id: string, field: keyof LogFilters) => {
    const el = shell.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
    el.addEventListener(el.tagName === "INPUT" ? "input" : "change", () => {
      filters = { ...filters, [field]: el.value };
      update();
    });
  };
  bind("dg-level", "level");
  bind("dg-kind", "kind");
  bind("dg-search", "search");
  bind("dg-from", "from");
  bind("dg-to", "to");

  shell.querySelector("#dg-clear")!.addEventListener("click", () => {
    filters = { ...DEFAULT_LOG_FILTERS };
    shell.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".toolbar .control").forEach((el) => (el.value = ""));
    update();
  });

  shell.querySelector("#dg-export-csv")!.addEventListener("click", () => {
    const filtered = applyLogFilters(logs, filters);
    if (filtered.length === 0) {
      toastError("Nenhum evento no filtro atual para exportar.");
      return;
    }
    downloadFile(`SGO_Diagnostico_${new Date().toISOString().slice(0, 10)}.csv`, logsToCSV(filtered), "text/csv;charset=utf-8;");
  });
  shell.querySelector("#dg-export-json")!.addEventListener("click", () => {
    const filtered = applyLogFilters(logs, filters);
    if (filtered.length === 0) {
      toastError("Nenhum evento no filtro atual para exportar.");
      return;
    }
    downloadFile(`SGO_Diagnostico_${new Date().toISOString().slice(0, 10)}.json`, logsToJSON(filtered), "application/json;charset=utf-8;");
  });

  shell.querySelector("#run-health-btn")!.addEventListener("click", () => void runHealth());

  update();
  void runHealth();
}

function showLogDetail(entry: LogEntry, userName: string): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay open";
  overlay.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true">
      <div class="modal-header">
        <div><h3>${escapeHtml(entry.action)}</h3><p>${new Date(entry.created_at).toLocaleString("pt-BR")} · ${escapeHtml(userName)}</p></div>
        <button type="button" class="modal-close" aria-label="Fechar">&times;</button>
      </div>
      <div class="modal-body task-form">
        <label>Detalhes (JSON)</label>
        <pre class="log-detail-json">${escapeHtml(JSON.stringify(entry.details ?? {}, null, 2))}</pre>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector(".modal-close")!.addEventListener("click", close);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

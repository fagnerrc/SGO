// Equipe (detail) — the actual working screen: roster with this month's
// score per integrante (derived server-side, never stored — see 0046),
// adding/editing members, registering ocorrências, and each member's own
// history. Every write here goes through lib/teams.ts's RPC wrappers,
// which re-check "you're this team's supervisor, or privileged"
// server-side regardless of what this screen shows.

import {
  addTeamMember,
  addTeamOccurrence,
  getTeam,
  getTeamMonthlyReport,
  listMemberOccurrences,
  listTeamMembers,
  setTeamMemberStatus,
  updateTeam,
  updateTeamMember,
  type TeamMemberInput,
} from "../lib/teams";
import type { Team, TeamMember, TeamMemberOccurrence, TeamMemberReportRow } from "../lib/types";
import { openFormModal } from "./modal";
import { renderNav } from "./nav";
import { toastError, toastSuccess } from "./toast";

const ROLE_OPTIONS = ["Separador", "Conferente", "Auxiliar de Expedição", "Carregamento", "Outro"];

function monthLabel(month: Date): string {
  const label = month.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function monthParam(month: Date): string {
  return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-01`;
}

export async function renderTeamDetail(root: HTMLElement, teamId: string, onBack: () => void): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "teams");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;
  let team: Team;
  let members: TeamMember[];
  let currentMonth = new Date();
  currentMonth.setDate(1);

  try {
    [team, members] = await Promise.all([getTeam(teamId), listTeamMembers(teamId)]);
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar a equipe: ${(err as Error).message}</p>`;
    return;
  }

  async function reload(): Promise<void> {
    try {
      [team, members] = await Promise.all([getTeam(teamId), listTeamMembers(teamId)]);
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
      return;
    }
    await renderPage();
  }

  async function renderPage(): Promise<void> {
    let report: TeamMemberReportRow[];
    try {
      report = await getTeamMonthlyReport(teamId, monthParam(currentMonth));
    } catch (err) {
      shell.innerHTML = `<p class="error">Não foi possível carregar o relatório: ${(err as Error).message}</p>`;
      return;
    }
    const reportByMember = new Map(report.map((r) => [r.member_id, r]));
    const activeCount = members.filter((m) => m.status === "ATIVO").length;
    const totalOccurrences = report.reduce((sum, r) => sum + r.occurrence_count, 0);
    const totalDeducted = report.reduce((sum, r) => sum + r.points_deducted, 0);

    shell.innerHTML = `
      <header class="app-header">
        <div>
          <button id="back-btn" class="link-button">&larr; Voltar</button>
          <h1>${escapeHtml(team.name)}</h1>
          <p class="dashboard-subtitle">Equipe interna — os integrantes não são usuários do SGO. <button type="button" id="edit-team-btn" class="link-button">editar equipe</button></p>
        </div>
      </header>

      <div class="kpi-grid">
        <article class="kpi-tile tile-blue"><span class="kpi-label">Integrantes</span><div class="kpi-value">${members.length}</div><div class="kpi-sub">${activeCount} ativos</div></article>
        <article class="kpi-tile tile-mint"><span class="kpi-label">Pontuação inicial</span><div class="kpi-value">${team.monthly_starting_points}</div></article>
        <article class="kpi-tile tile-lavender"><span class="kpi-label">Ocorrências no mês</span><div class="kpi-value">${totalOccurrences}</div></article>
        <article class="kpi-tile tile-pink"><span class="kpi-label">Pontos perdidos no mês</span><div class="kpi-value">${totalDeducted}</div></article>
      </div>

      <div class="tabs" style="max-width:420px">
        <button type="button" id="prev-month-btn" class="tab">&larr;</button>
        <button type="button" class="tab active" disabled>${monthLabel(currentMonth)}</button>
        <button type="button" id="next-month-btn" class="tab">&rarr;</button>
      </div>

      <div class="card table-card">
        <table class="data-table">
          <thead>
            <tr><th>Nome</th><th>Função</th><th>Matrícula</th><th>Status</th><th>Ocorrências</th><th>Pontos</th><th></th></tr>
          </thead>
          <tbody id="member-rows"></tbody>
        </table>
      </div>
      <div class="app-header-actions">
        <button type="button" id="add-member-btn" class="btn-primary">+ Adicionar integrante</button>
      </div>
    `;

    shell.querySelector("#back-btn")!.addEventListener("click", onBack);
    shell.querySelector("#prev-month-btn")!.addEventListener("click", () => {
      currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
      void renderPage();
    });
    shell.querySelector("#next-month-btn")!.addEventListener("click", () => {
      currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
      void renderPage();
    });
    shell.querySelector("#edit-team-btn")!.addEventListener("click", () => void editTeam());
    shell.querySelector("#add-member-btn")!.addEventListener("click", () => void addMember());

    const rowsEl = shell.querySelector<HTMLTableSectionElement>("#member-rows")!;
    rowsEl.innerHTML = members
      .map((m) => {
        const r = reportByMember.get(m.id);
        return `
      <tr data-member-id="${m.id}">
        <td class="cell-primary">${escapeHtml(m.name)}</td>
        <td data-label="Função">${escapeHtml(m.role || "—")}</td>
        <td data-label="Matrícula">${escapeHtml(m.employee_code || "—")}</td>
        <td data-label="Status"><span class="badge ${m.status === "ATIVO" ? "badge-green" : "badge-gray"}">${m.status === "ATIVO" ? "Ativo" : "Inativo"}</span></td>
        <td data-label="Ocorrências">${r?.occurrence_count ?? 0}</td>
        <td data-label="Pontos"><strong>${r?.final_points ?? team.monthly_starting_points}</strong> / ${team.monthly_starting_points}</td>
        <td data-label="" class="wrap-cell actions-cell">
          <button class="link-button" data-occurrence="${m.id}">registrar ocorrência</button>
          <button class="link-button" data-history="${m.id}">histórico</button>
          <button class="link-button" data-edit="${m.id}">editar</button>
          ${
            m.status === "ATIVO"
              ? `<button class="link-button" data-inactivate="${m.id}">inativar</button>`
              : `<button class="link-button" data-reactivate="${m.id}">reativar</button>`
          }
        </td>
      </tr>`;
      })
      .join("");
    if (members.length === 0) {
      rowsEl.innerHTML = `<tr><td colspan="7" class="dropdown-empty">Nenhum integrante cadastrado ainda.</td></tr>`;
    }

    rowsEl.querySelectorAll<HTMLButtonElement>("[data-occurrence]").forEach((btn) => {
      btn.addEventListener("click", () => void registerOccurrence(btn.dataset.occurrence!));
    });
    rowsEl.querySelectorAll<HTMLButtonElement>("[data-history]").forEach((btn) => {
      btn.addEventListener("click", () => void showHistory(members.find((m) => m.id === btn.dataset.history)!));
    });
    rowsEl.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => void editMember(members.find((m) => m.id === btn.dataset.edit)!));
    });
    rowsEl.querySelectorAll<HTMLButtonElement>("[data-inactivate]").forEach((btn) => {
      btn.addEventListener("click", () => void inactivateMember(btn.dataset.inactivate!));
    });
    rowsEl.querySelectorAll<HTMLButtonElement>("[data-reactivate]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await setTeamMemberStatus(btn.dataset.reactivate!, "ATIVO");
          toastSuccess("Integrante reativado.");
          await reload();
        } catch (err) {
          toastError(err instanceof Error ? err.message : String(err));
        }
      });
    });
  }

  async function editTeam(): Promise<void> {
    const values = await openFormModal({
      title: "Editar equipe",
      fields: [
        { name: "name", label: "Nome da equipe", type: "text", required: true, defaultValue: team.name },
        { name: "points", label: "Pontuação inicial mensal", type: "text", required: true, defaultValue: String(team.monthly_starting_points) },
      ],
      confirmLabel: "Salvar",
    });
    if (!values) return;
    try {
      await updateTeam(teamId, values.name, Number(values.points) || team.monthly_starting_points);
      toastSuccess("Equipe atualizada.");
      await reload();
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    }
  }

  function memberFormFields(defaults?: TeamMember) {
    return [
      { name: "name", label: "Nome completo", type: "text" as const, required: true, defaultValue: defaults?.name ?? "" },
      { name: "employeeCode", label: "Matrícula / identificação (opcional)", type: "text" as const, defaultValue: defaults?.employee_code ?? "" },
      {
        name: "role",
        label: "Função",
        type: "select" as const,
        options: ROLE_OPTIONS.map((r) => ({ value: r, label: r })),
        defaultValue: defaults?.role || ROLE_OPTIONS[0],
      },
      { name: "joinedAt", label: "Data de entrada na equipe", type: "dateonly" as const, defaultValue: defaults?.joined_at ?? new Date().toISOString().slice(0, 10) },
      { name: "notes", label: "Observação (opcional)", type: "textarea" as const, defaultValue: defaults?.notes ?? "" },
    ];
  }

  function inputFromValues(values: Record<string, string>): TeamMemberInput {
    return {
      name: values.name.trim(),
      employeeCode: values.employeeCode?.trim() ?? "",
      role: values.role ?? "",
      joinedAt: values.joinedAt ? values.joinedAt.slice(0, 10) : undefined,
      notes: values.notes?.trim() ?? "",
    };
  }

  async function addMember(): Promise<void> {
    const values = await openFormModal({ title: "Adicionar integrante", fields: memberFormFields(), confirmLabel: "Adicionar" });
    if (!values) return;
    try {
      await addTeamMember(teamId, inputFromValues(values));
      toastSuccess("Integrante adicionado.");
      await reload();
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    }
  }

  async function editMember(member: TeamMember): Promise<void> {
    const values = await openFormModal({ title: `Editar — ${member.name}`, fields: memberFormFields(member), confirmLabel: "Salvar" });
    if (!values) return;
    try {
      await updateTeamMember(member.id, inputFromValues(values));
      toastSuccess("Integrante atualizado.");
      await reload();
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    }
  }

  async function inactivateMember(memberId: string): Promise<void> {
    const values = await openFormModal({
      title: "Inativar integrante",
      description: "O histórico do integrante permanece disponível e ele pode ser reativado depois.",
      fields: [{ name: "reason", label: "Motivo (opcional)", type: "textarea" }],
      confirmLabel: "Inativar",
    });
    if (!values) return;
    try {
      await setTeamMemberStatus(memberId, "INATIVO", values.reason || "");
      toastSuccess("Integrante inativado.");
      await reload();
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    }
  }

  async function registerOccurrence(memberId: string): Promise<void> {
    const values = await openFormModal({
      title: "Registrar ocorrência",
      fields: [
        { name: "points", label: "Pontos a descontar", type: "text", required: true, defaultValue: "1" },
        { name: "motivo", label: "Motivo", type: "text", required: true },
        { name: "descricao", label: "Descrição", type: "textarea", required: true },
        { name: "observacao", label: "Observação (opcional)", type: "textarea" },
      ],
      confirmLabel: "Registrar",
    });
    if (!values) return;
    const points = Number(values.points);
    if (!Number.isFinite(points) || points < 0) {
      toastError("Informe um número válido de pontos.");
      return;
    }
    try {
      await addTeamOccurrence(memberId, points, values.motivo, values.descricao, values.observacao || "");
      toastSuccess("Ocorrência registrada.");
      await renderPage();
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    }
  }

  async function showHistory(member: TeamMember): Promise<void> {
    let occurrences: TeamMemberOccurrence[];
    try {
      occurrences = await listMemberOccurrences(member.id);
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
      return;
    }

    // Grouped by competência (yyyy-mm) so the modal reads like the
    // spec's example — pontuação inicial, cada ocorrência do mês, e o
    // total final — without needing a second RPC round-trip per month.
    const byMonth = new Map<string, TeamMemberOccurrence[]>();
    for (const occ of occurrences) {
      const key = occ.occurred_at.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key)!.push(occ);
    }
    const months = Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a));

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay open";
    overlay.innerHTML = `
      <div class="modal modal-sm" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div><h3>${escapeHtml(member.name)}</h3><p>Histórico de ocorrências</p></div>
          <button type="button" class="modal-close" aria-label="Fechar">&times;</button>
        </div>
        <div class="modal-body task-form">
          ${
            months.length === 0
              ? "<p>Nenhuma ocorrência registrada ainda.</p>"
              : months
                  .map((key) => {
                    const list = byMonth.get(key)!;
                    const [y, m] = key.split("-").map(Number);
                    const label = monthLabel(new Date(y, m - 1, 1));
                    const deducted = list.reduce((s, o) => s + o.points_deducted, 0);
                    const final = team.monthly_starting_points - deducted;
                    return `
                <h4>${label} — pontuação final: ${final}</h4>
                <ul class="routine-history-list">
                  ${list
                    .map(
                      (o) => `
                    <li>
                      <strong>-${o.points_deducted} ponto${o.points_deducted === 1 ? "" : "s"} — ${escapeHtml(o.motivo)}</strong>
                      <span>${new Date(o.occurred_at).toLocaleDateString("pt-BR")} — ${escapeHtml(o.descricao)}</span>
                    </li>`,
                    )
                    .join("")}
                </ul>`;
                  })
                  .join("")
          }
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

  await renderPage();
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

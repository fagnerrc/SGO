// Equipes — landing screen. Most supervisors have exactly one team, so
// this skips straight to its detail page instead of making them pick
// from a list of one; only shows a picker when there's genuinely more
// than one (a privileged viewer overseeing several supervisors' teams).
// No team yet at all → the create-team form, right here.

import { createTeam, listMyTeams } from "../lib/teams";
import type { Team } from "../lib/types";
import { renderNav } from "./nav";

export async function renderTeams(root: HTMLElement, onOpenTeam: (teamId: string) => void): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "teams");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;
  let teams: Team[];
  try {
    teams = await listMyTeams();
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar as equipes: ${(err as Error).message}</p>`;
    return;
  }

  if (teams.length === 1) {
    onOpenTeam(teams[0].id);
    return;
  }

  if (teams.length === 0) {
    renderCreateForm(shell, onOpenTeam);
    return;
  }

  shell.innerHTML = `
    <h1 class="dashboard-title">Equipes</h1>
    <p class="dashboard-subtitle">Equipes internas geridas por um supervisor — os integrantes não são usuários do SGO.</p>
    <div class="task-list" id="teams-list">
      ${teams
        .map(
          (t) => `
        <button type="button" class="approval-card" data-team-id="${t.id}" style="width:100%; text-align:left; cursor:pointer; border:1px solid var(--border);">
          <span class="task-card-title">${escapeHtml(t.name)}</span>
        </button>`,
        )
        .join("")}
    </div>
  `;
  shell.querySelectorAll<HTMLButtonElement>("[data-team-id]").forEach((btn) => {
    btn.addEventListener("click", () => onOpenTeam(btn.dataset.teamId!));
  });
}

function renderCreateForm(shell: HTMLDivElement, onOpenTeam: (teamId: string) => void): void {
  shell.innerHTML = `
    <h1 class="dashboard-title">Equipes</h1>
    <p class="dashboard-subtitle">Você ainda não tem uma equipe. Crie a sua para começar a cadastrar os integrantes.</p>
    <div class="card" style="max-width:420px">
      <form id="create-team-form" class="task-form">
        <label for="t-name">Nome da equipe *</label>
        <input id="t-name" required placeholder="ex: Expedição" />
        <label for="t-points">Pontuação inicial mensal</label>
        <input id="t-points" type="number" min="0" step="1" value="10" />
        <p id="create-team-error" class="error" hidden></p>
        <button type="submit">Criar equipe</button>
      </form>
    </div>
  `;
  const form = shell.querySelector<HTMLFormElement>("#create-team-form")!;
  const errorEl = shell.querySelector<HTMLParagraphElement>("#create-team-error")!;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    const name = (shell.querySelector("#t-name") as HTMLInputElement).value.trim();
    const points = Number((shell.querySelector("#t-points") as HTMLInputElement).value || 10);
    try {
      const team = await createTeam(name, points);
      onOpenTeam(team.id);
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : String(err);
      errorEl.hidden = false;
    }
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

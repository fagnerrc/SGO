import { adminListProfiles, createCollaborator, setProfileActive, setProfileRole } from "../lib/profiles";
import type { Profile } from "../lib/types";
import { renderNav } from "./nav";

const ROLE_LABELS: Record<string, string> = {
  colaborador: "Colaborador",
  gestor: "Gestor de área",
  diretoria: "Diretoria",
  auditoria: "Processos e auditoria",
  admin: "Administrador",
};

export async function renderCollaborators(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "collaborators");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;
  await renderPage(shell);
}

async function renderPage(shell: HTMLDivElement): Promise<void> {
  let profiles: Profile[];
  try {
    profiles = await adminListProfiles();
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar os colaboradores: ${(err as Error).message}
      (esta tela é só para perfis privilegiados — diretoria, auditoria ou admin)</p>`;
    return;
  }

  shell.innerHTML = `
    <header class="app-header">
      <h1>Colaboradores</h1>
      <button id="new-collab-btn">+ Novo colaborador</button>
    </header>

    <div id="new-collab-panel" class="card" hidden>
      <h3>Novo colaborador</h3>
      <form id="new-collab-form" class="task-form">
        <label for="collab-name">Nome *</label>
        <input id="collab-name" required />
        <label for="collab-email">E-mail *</label>
        <input id="collab-email" type="email" required />
        <label for="collab-area">Área *</label>
        <input id="collab-area" required placeholder="ex: Financeiro" />
        <label for="collab-role">Perfil de acesso *</label>
        <select id="collab-role">
          ${Object.entries(ROLE_LABELS)
            .map(([value, label]) => `<option value="${value}"${value === "colaborador" ? " selected" : ""}>${label}</option>`)
            .join("")}
        </select>
        <p id="new-collab-error" class="error" hidden></p>
        <button type="submit">Cadastrar</button>
      </form>
      <p id="new-collab-result" class="new-collab-result" hidden></p>
    </div>

    <div class="card table-card">
      <table class="data-table">
        <thead>
          <tr><th>Nome</th><th>E-mail</th><th>Área</th><th>Perfil</th><th>Status</th><th></th></tr>
        </thead>
        <tbody id="collab-rows"></tbody>
      </table>
    </div>
  `;

  const newBtn = shell.querySelector<HTMLButtonElement>("#new-collab-btn")!;
  const panel = shell.querySelector<HTMLDivElement>("#new-collab-panel")!;
  newBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  });

  const form = shell.querySelector<HTMLFormElement>("#new-collab-form")!;
  const formError = shell.querySelector<HTMLParagraphElement>("#new-collab-error")!;
  const resultEl = shell.querySelector<HTMLParagraphElement>("#new-collab-result")!;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.hidden = true;
    resultEl.hidden = true;
    const submitBtn = form.querySelector("button[type=submit]") as HTMLButtonElement;
    submitBtn.disabled = true;
    try {
      const result = await createCollaborator({
        fullName: (form.querySelector("#collab-name") as HTMLInputElement).value.trim(),
        email: (form.querySelector("#collab-email") as HTMLInputElement).value.trim(),
        area: (form.querySelector("#collab-area") as HTMLInputElement).value.trim(),
        role: (form.querySelector("#collab-role") as HTMLSelectElement).value,
      });
      resultEl.hidden = false;
      resultEl.textContent = `Cadastrado! PIN temporário: ${result.temporaryPin} — anote agora, ele só aparece essa vez. Peça para a pessoa trocar o PIN no primeiro acesso.`;
      form.reset();
      // Refresh only the table, not the whole shell — a full renderPage()
      // would tear down and re-hide this very panel, wiping the one-time
      // PIN before the admin can read it.
      await refreshRows(shell);
    } catch (err) {
      formError.textContent = (err as Error).message;
      formError.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  await refreshRows(shell);
}

async function refreshRows(shell: HTMLDivElement): Promise<void> {
  const profiles = await adminListProfiles();
  const rowsEl = shell.querySelector<HTMLTableSectionElement>("#collab-rows")!;
  rowsEl.innerHTML = profiles
    .map(
      (p) => `
    <tr data-profile-id="${p.id}">
      <td>${escapeHtml(p.full_name)}</td>
      <td>${escapeHtml(p.email)}</td>
      <td>${escapeHtml(p.area || "—")}</td>
      <td>
        <select class="role-select" data-profile-id="${p.id}">
          ${Object.entries(ROLE_LABELS)
            .map(([value, label]) => `<option value="${value}"${value === p.role ? " selected" : ""}>${label}</option>`)
            .join("")}
        </select>
      </td>
      <td>${p.active ? "Ativo" : "Inativo"}</td>
      <td><button class="link-button toggle-active-btn" data-profile-id="${p.id}" data-active="${p.active}">${p.active ? "Desativar" : "Reativar"}</button></td>
    </tr>`,
    )
    .join("");

  rowsEl.querySelectorAll<HTMLSelectElement>(".role-select").forEach((select) => {
    select.addEventListener("change", async () => {
      try {
        await setProfileRole(select.dataset.profileId!, select.value);
      } catch (err) {
        alert((err as Error).message);
        await refreshRows(shell);
      }
    });
  });

  rowsEl.querySelectorAll<HTMLButtonElement>(".toggle-active-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const currentlyActive = btn.dataset.active === "true";
      try {
        await setProfileActive(btn.dataset.profileId!, !currentlyActive);
        await refreshRows(shell);
      } catch (err) {
        alert((err as Error).message);
      }
    });
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

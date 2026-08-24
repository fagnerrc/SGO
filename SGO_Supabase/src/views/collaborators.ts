import {
  adminListProfiles,
  createCollaborator,
  deleteProfile,
  listDeletedProfiles,
  resetProfilePin,
  restoreProfile,
  setProfileActive,
  setProfileCapacity,
  setProfileRole,
} from "../lib/profiles";
import type { Profile } from "../lib/types";
import { openFormModal } from "./modal";
import { renderNav } from "./nav";
import { toastError, toastSuccess } from "./toast";

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
      <div class="app-header-actions">
        <button id="trash-toggle-btn" class="link-button">Ver excluídos</button>
        <button id="new-collab-btn" class="btn-primary">+ Novo colaborador</button>
      </div>
    </header>

    <div id="trash-panel" class="card" hidden>
      <h3>Colaboradores excluídos</h3>
      <div id="trash-list"><p>Carregando...</p></div>
    </div>

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

    <p id="pin-reset-result" class="new-collab-result" hidden></p>

    <div class="card table-card">
      <table class="data-table">
        <colgroup>
          <col style="width:19%" /><col style="width:23%" /><col style="width:11%" />
          <col style="width:15%" /><col style="width:13%" /><col style="width:9%" /><col style="width:10%" />
        </colgroup>
        <thead>
          <tr><th>Nome</th><th>E-mail</th><th>Área</th><th>Perfil</th><th title="Capacidade (h/semana)">Capacidade (h/sem.)</th><th>Status</th><th></th></tr>
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

  const trashBtn = shell.querySelector<HTMLButtonElement>("#trash-toggle-btn")!;
  const trashPanel = shell.querySelector<HTMLDivElement>("#trash-panel")!;
  const trashListEl = shell.querySelector<HTMLDivElement>("#trash-list")!;
  let trashLoaded = false;

  async function loadTrash(): Promise<void> {
    trashListEl.innerHTML = "<p>Carregando...</p>";
    let deleted: Profile[];
    try {
      deleted = await listDeletedProfiles();
    } catch (err) {
      trashListEl.innerHTML = `<p class="error">${escapeHtml((err as Error).message)}</p>`;
      return;
    }
    trashBtn.textContent = `Ver excluídos (${deleted.length})`;
    if (deleted.length === 0) {
      trashListEl.innerHTML = "<p>Nenhum colaborador excluído.</p>";
      return;
    }
    trashListEl.innerHTML = deleted
      .map(
        (p) => `
      <div class="approval-card" data-profile-id="${p.id}">
        <div>
          <span class="task-card-title">${escapeHtml(p.full_name)}</span>
          <span class="approval-waiting-since">${escapeHtml(p.email)}${p.area ? " · " + escapeHtml(p.area) : ""}</span>
        </div>
        <div class="approval-actions">
          <button class="btn-outline restore-profile-btn" data-profile-id="${p.id}">Restaurar</button>
        </div>
      </div>`,
      )
      .join("");
    trashListEl.querySelectorAll<HTMLButtonElement>(".restore-profile-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await restoreProfile(btn.dataset.profileId!);
          toastSuccess("Colaborador restaurado. Ele volta como inativo — reative quando quiser.");
          await refreshRows(shell);
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
  void listDeletedProfiles()
    .then((d) => {
      if (d.length > 0) trashBtn.textContent = `Ver excluídos (${d.length})`;
    })
    .catch(() => {});

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
      <td class="cell-primary" title="${escapeHtml(p.full_name)}">${escapeHtml(p.full_name)}</td>
      <td data-label="E-mail" class="cell-secondary" title="${escapeHtml(p.email)}">${escapeHtml(p.email)}</td>
      <td data-label="Área" title="${escapeHtml(p.area || "—")}">${escapeHtml(p.area || "—")}</td>
      <td data-label="Perfil" class="wrap-cell">
        <select class="role-select" data-profile-id="${p.id}">
          ${Object.entries(ROLE_LABELS)
            .map(([value, label]) => `<option value="${value}"${value === p.role ? " selected" : ""}>${label}</option>`)
            .join("")}
        </select>
      </td>
      <td data-label="Capacidade (h/semana)" class="wrap-cell"><input type="number" class="capacity-input" data-profile-id="${p.id}" min="1" step="0.5" value="${p.capacidade_semanal}" /></td>
      <td data-label="Status"><span class="status-dot${p.active ? " is-active" : ""}">●</span>${p.active ? "Ativo" : "Inativo"}</td>
      <td data-label="" class="wrap-cell actions-cell">
        <button class="link-button toggle-active-btn" data-profile-id="${p.id}" data-active="${p.active}">${p.active ? "Desativar" : "Reativar"}</button>
        <button class="link-button reset-pin-btn" data-profile-id="${p.id}" data-name="${escapeAttr(p.full_name)}">Redefinir PIN</button>
        <button class="link-button dropdown-item-danger delete-profile-btn" data-profile-id="${p.id}" data-name="${escapeAttr(p.full_name)}">Excluir</button>
      </td>
    </tr>`,
    )
    .join("");

  rowsEl.querySelectorAll<HTMLSelectElement>(".role-select").forEach((select) => {
    select.addEventListener("change", async () => {
      try {
        await setProfileRole(select.dataset.profileId!, select.value);
        toastSuccess("Perfil atualizado.");
      } catch (err) {
        toastError((err as Error).message);
        await refreshRows(shell);
      }
    });
  });

  rowsEl.querySelectorAll<HTMLInputElement>(".capacity-input").forEach((input) => {
    input.addEventListener("change", async () => {
      const value = Number(input.value);
      if (!value || value <= 0) {
        toastError("Capacidade precisa ser maior que zero.");
        await refreshRows(shell);
        return;
      }
      try {
        await setProfileCapacity(input.dataset.profileId!, value);
        toastSuccess("Capacidade atualizada.");
      } catch (err) {
        toastError((err as Error).message);
        await refreshRows(shell);
      }
    });
  });

  rowsEl.querySelectorAll<HTMLButtonElement>(".toggle-active-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const currentlyActive = btn.dataset.active === "true";
      try {
        await setProfileActive(btn.dataset.profileId!, !currentlyActive);
        toastSuccess(currentlyActive ? "Colaborador desativado." : "Colaborador reativado.");
        await refreshRows(shell);
      } catch (err) {
        toastError((err as Error).message);
      }
    });
  });

  rowsEl.querySelectorAll<HTMLButtonElement>(".delete-profile-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name!;
      const confirmed = await openFormModal({
        title: "Excluir colaborador",
        description: `${name} some da lista de colaboradores e é desconectado(a) na hora — mas nada é perdido, dá para restaurar depois em "Ver excluídos".`,
        fields: [],
        confirmLabel: "Excluir colaborador",
      });
      if (!confirmed) return;
      try {
        await deleteProfile(btn.dataset.profileId!);
        toastSuccess("Colaborador excluído.");
        await refreshRows(shell);
      } catch (err) {
        toastError((err as Error).message);
      }
    });
  });

  const pinResultEl = shell.querySelector<HTMLParagraphElement>("#pin-reset-result")!;
  rowsEl.querySelectorAll<HTMLButtonElement>(".reset-pin-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name!;
      const confirmed = await openFormModal({
        title: "Redefinir PIN",
        description: `Isso gera um novo PIN temporário para ${name} e desconecta a pessoa imediatamente de qualquer sessão ativa. Confirma?`,
        fields: [],
        confirmLabel: "Redefinir PIN",
      });
      if (!confirmed) return;
      try {
        const pin = await resetProfilePin(btn.dataset.profileId!);
        pinResultEl.hidden = false;
        pinResultEl.textContent = `PIN redefinido para ${name}: ${pin} — anote agora, ele só aparece essa vez. Peça para a pessoa trocar o PIN no primeiro acesso.`;
      } catch (err) {
        toastError((err as Error).message);
      }
    });
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

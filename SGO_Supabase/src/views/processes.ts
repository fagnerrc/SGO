import { listCompanyProfiles } from "../lib/profiles";
import { createProcess, listProcesses, setProcessActive, updateProcess, type Process, type ProcessInput } from "../lib/processes";
import type { Profile } from "../lib/types";
import { riskBadge } from "./badges";
import { renderNav } from "./nav";

const RECORRENCIA_OPTIONS = ["Sem recorrência", "Diária", "Semanal", "Mensal"];
const RISCO_OPTIONS = ["Baixo", "Médio", "Alto", "Crítico"];

export async function renderProcesses(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "processes");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;

  let processes: Process[];
  let profiles: Profile[];
  try {
    [processes, profiles] = await Promise.all([listProcesses(), listCompanyProfiles()]);
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar os processos: ${(err as Error).message}
      (esta tela é só para perfis privilegiados — diretoria, auditoria ou admin)</p>`;
    return;
  }

  renderPage(shell, processes, profiles);
}

function profileOptions(profiles: Profile[], selectedId: string | null): string {
  return (
    `<option value="">Ninguém</option>` +
    profiles.map((p) => `<option value="${p.id}"${p.id === selectedId ? " selected" : ""}>${escapeHtml(p.full_name)}</option>`).join("")
  );
}

function renderPage(shell: HTMLDivElement, processes: Process[], profiles: Profile[], editing: Process | null = null): void {
  shell.innerHTML = `
    <header class="app-header">
      <h1>Processos</h1>
      <button id="new-process-btn">+ Novo processo</button>
    </header>
    <p class="dashboard-subtitle">Um processo define, de uma vez, o dono, executor, aprovador, SLA, risco, checklist padrão e recorrência de uma família de tarefas — ao criar uma tarefa a partir dele, esses campos são pré-preenchidos.</p>

    <div id="process-panel" class="card" hidden>
      <h3>${editing ? `Editar processo — ${escapeHtml(editing.name)}` : "Novo processo"}</h3>
      <form id="process-form" class="task-form">
        <label for="p-name">Nome *</label>
        <input id="p-name" required value="${escapeAttr(editing?.name ?? "")}" />

        <div class="task-form-row">
          <div>
            <label for="p-codigo">Código</label>
            <input id="p-codigo" value="${escapeAttr(editing?.codigo ?? "")}" />
          </div>
          <div>
            <label for="p-area">Área</label>
            <input id="p-area" value="${escapeAttr(editing?.area ?? "")}" />
          </div>
        </div>

        <label for="p-descricao">Descrição</label>
        <textarea id="p-descricao" rows="2">${escapeHtml(editing?.descricao ?? "")}</textarea>

        <div class="task-form-row">
          <div>
            <label for="p-dono">Dono</label>
            <select id="p-dono">${profileOptions(profiles, editing?.dono_id ?? null)}</select>
          </div>
          <div>
            <label for="p-executor">Executor</label>
            <select id="p-executor">${profileOptions(profiles, editing?.executor_id ?? null)}</select>
          </div>
        </div>
        <div class="task-form-row">
          <div>
            <label for="p-conferente">Conferente</label>
            <select id="p-conferente">${profileOptions(profiles, editing?.conferente_id ?? null)}</select>
          </div>
          <div>
            <label for="p-aprovador">Aprovador</label>
            <select id="p-aprovador">${profileOptions(profiles, editing?.aprovador_id ?? null)}</select>
          </div>
        </div>

        <div class="task-form-row">
          <div>
            <label for="p-sla">SLA (horas)</label>
            <input id="p-sla" type="number" min="0" step="0.5" value="${editing?.sla_horas ?? ""}" />
          </div>
          <div>
            <label for="p-tolerancia">Tolerância (horas)</label>
            <input id="p-tolerancia" type="number" min="0" step="0.5" value="${editing?.tolerancia_horas ?? 0}" />
          </div>
        </div>
        <div class="task-form-row">
          <div>
            <label for="p-risco">Risco</label>
            <select id="p-risco">${RISCO_OPTIONS.map((r) => `<option${r === (editing?.risco ?? "Médio") ? " selected" : ""}>${r}</option>`).join("")}</select>
          </div>
          <div>
            <label for="p-estimativa">Estimativa padrão (horas)</label>
            <input id="p-estimativa" type="number" min="0" step="0.5" value="${editing?.estimativa_padrao ?? 1}" />
          </div>
        </div>

        <label><input id="p-segregacao" type="checkbox" ${editing?.segregacao ? "checked" : ""} /> Segregação de funções (executor ≠ conferente ≠ aprovador)</label>
        <label style="margin-top:0.5rem"><input id="p-evidencia-obrig" type="checkbox" ${editing?.evidencia_obrigatoria ? "checked" : ""} /> Evidência obrigatória para concluir</label>

        <label for="p-evidencia-orientacao">Orientação sobre a evidência esperada</label>
        <textarea id="p-evidencia-orientacao" rows="2">${escapeHtml(editing?.evidencia_orientacao ?? "")}</textarea>

        <label for="p-recorrencia">Recorrência</label>
        <select id="p-recorrencia">${RECORRENCIA_OPTIONS.map((r) => `<option${r === (editing?.recorrencia ?? "Sem recorrência") ? " selected" : ""}>${r}</option>`).join("")}</select>

        <label>Checklist padrão</label>
        <ul id="p-checklist-builder" class="checklist-builder"></ul>
        <div class="checklist-add-row">
          <input id="p-checklist-input" type="text" placeholder="Adicionar item e pressionar Enter" />
          <button type="button" id="p-checklist-add-btn">Adicionar</button>
        </div>

        <p id="process-error" class="error" hidden></p>
        <div class="app-header-actions" style="margin-top:0.5rem">
          <button type="submit">${editing ? "Salvar alterações" : "Criar processo"}</button>
          <button type="button" id="process-cancel-btn" class="link-button">Cancelar</button>
        </div>
      </form>
    </div>

    <div class="card table-card">
      <table class="data-table">
        <thead>
          <tr><th>Nome</th><th>Área</th><th>Aprovador</th><th>SLA</th><th>Risco</th><th>Recorrência</th><th>Status</th><th></th></tr>
        </thead>
        <tbody id="process-rows"></tbody>
      </table>
    </div>
  `;

  const panel = shell.querySelector<HTMLDivElement>("#process-panel")!;
  if (editing) panel.hidden = false;

  const newBtn = shell.querySelector<HTMLButtonElement>("#new-process-btn")!;
  newBtn.addEventListener("click", () => {
    if (!panel.hidden && !editing) {
      panel.hidden = true;
    } else {
      renderPage(shell, processes, profiles, null);
      shell.querySelector<HTMLDivElement>("#process-panel")!.hidden = false;
    }
  });
  shell.querySelector<HTMLButtonElement>("#process-cancel-btn")!.addEventListener("click", () => {
    renderPage(shell, processes, profiles, null);
  });

  const checklistItems: string[] = [...(editing?.checklist_padrao ?? [])];
  const checklistList = shell.querySelector<HTMLUListElement>("#p-checklist-builder")!;
  const checklistInput = shell.querySelector<HTMLInputElement>("#p-checklist-input")!;

  function renderChecklist(): void {
    checklistList.innerHTML = checklistItems
      .map(
        (text, i) => `
        <li>
          <span>${escapeHtml(text)}</span>
          <button type="button" class="link-button" data-remove="${i}">remover</button>
        </li>`,
      )
      .join("");
    checklistList.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        checklistItems.splice(Number(btn.dataset.remove), 1);
        renderChecklist();
      });
    });
  }
  function addChecklistItem(): void {
    const text = checklistInput.value.trim();
    if (!text) return;
    checklistItems.push(text);
    checklistInput.value = "";
    renderChecklist();
  }
  renderChecklist();
  shell.querySelector("#p-checklist-add-btn")!.addEventListener("click", addChecklistItem);
  checklistInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addChecklistItem();
    }
  });

  const form = shell.querySelector<HTMLFormElement>("#process-form")!;
  const errorEl = shell.querySelector<HTMLParagraphElement>("#process-error")!;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    const submitBtn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    submitBtn.disabled = true;
    try {
      const input: ProcessInput = {
        name: (shell.querySelector("#p-name") as HTMLInputElement).value.trim(),
        codigo: (shell.querySelector("#p-codigo") as HTMLInputElement).value.trim(),
        area: (shell.querySelector("#p-area") as HTMLInputElement).value.trim(),
        descricao: (shell.querySelector("#p-descricao") as HTMLTextAreaElement).value.trim(),
        donoId: (shell.querySelector("#p-dono") as HTMLSelectElement).value,
        executorId: (shell.querySelector("#p-executor") as HTMLSelectElement).value,
        conferenteId: (shell.querySelector("#p-conferente") as HTMLSelectElement).value,
        aprovadorId: (shell.querySelector("#p-aprovador") as HTMLSelectElement).value,
        slaHoras: (shell.querySelector("#p-sla") as HTMLInputElement).value ? Number((shell.querySelector("#p-sla") as HTMLInputElement).value) : null,
        toleranciaHoras: Number((shell.querySelector("#p-tolerancia") as HTMLInputElement).value || 0),
        risco: (shell.querySelector("#p-risco") as HTMLSelectElement).value,
        segregacao: (shell.querySelector("#p-segregacao") as HTMLInputElement).checked,
        evidenciaObrigatoria: (shell.querySelector("#p-evidencia-obrig") as HTMLInputElement).checked,
        evidenciaOrientacao: (shell.querySelector("#p-evidencia-orientacao") as HTMLTextAreaElement).value.trim(),
        estimativaPadrao: Number((shell.querySelector("#p-estimativa") as HTMLInputElement).value || 1),
        checklistPadrao: checklistItems,
        recorrencia: (shell.querySelector("#p-recorrencia") as HTMLSelectElement).value,
      };
      if (editing) await updateProcess(editing.id, input);
      else await createProcess(input);
      const fresh = await listProcesses();
      renderPage(shell, fresh, profiles, null);
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : String(err);
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  const rowsEl = shell.querySelector<HTMLTableSectionElement>("#process-rows")!;
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  rowsEl.innerHTML = processes
    .map(
      (p) => `
    <tr data-process-id="${p.id}">
      <td>${escapeHtml(p.name)}${p.codigo ? ` <span class="task-card-code">${escapeHtml(p.codigo)}</span>` : ""}</td>
      <td>${escapeHtml(p.area ?? "—")}</td>
      <td>${p.aprovador_id ? escapeHtml(profileById.get(p.aprovador_id)?.full_name ?? "—") : "—"}</td>
      <td>${p.sla_horas ?? "—"}${p.sla_horas ? "h" : ""}</td>
      <td>${riskBadge(p.risco)}</td>
      <td>${escapeHtml(p.recorrencia)}</td>
      <td>${p.ativo ? "Ativo" : "Inativo"}</td>
      <td>
        <button class="link-button" data-edit="${p.id}">editar</button>
        <button class="link-button" data-toggle="${p.id}" data-active="${p.ativo}">${p.ativo ? "desativar" : "reativar"}</button>
      </td>
    </tr>`,
    )
    .join("");

  rowsEl.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = processes.find((p) => p.id === btn.dataset.edit)!;
      renderPage(shell, processes, profiles, target);
    });
  });
  rowsEl.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const currentlyActive = btn.dataset.active === "true";
      try {
        await setProcessActive(btn.dataset.toggle!, !currentlyActive);
        const fresh = await listProcesses();
        renderPage(shell, fresh, profiles, null);
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
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

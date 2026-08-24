// Rotinas Periódicas — admin cadastra um modelo uma vez
// (supabase/migrations/0036_periodic_routines.sql: routines +
// generate_periodic_routine_tasks(), rodando via pg_cron a cada 5min) e o
// backend passa a gerar, sozinho, uma tarefa nova por dia útil configurado
// até que a rotina seja cancelada. Esta tela é só o CRUD administrativo —
// a geração em si não depende de ninguém estar com esta tela (ou o
// navegador) aberto.

import { listCompanyProfiles } from "../lib/profiles";
import { listProcesses, type Process } from "../lib/processes";
import {
  cancelRoutine,
  createRoutine,
  listRoutineHistory,
  listRoutines,
  reactivateRoutine,
  updateRoutine,
  updateRoutineChecklist,
  type RoutineInput,
} from "../lib/routines";
import type { Profile, Routine, RoutineHistoryEntry } from "../lib/types";
import { routineStatusBadge } from "./badges";
import { openFormModal } from "./modal";
import { getCachedProfile, renderNav } from "./nav";
import { toastError, toastSuccess } from "./toast";

const WEEKDAYS: { value: string; label: string; short: string }[] = [
  { value: "MON", label: "Segunda-feira", short: "Seg" },
  { value: "TUE", label: "Terça-feira", short: "Ter" },
  { value: "WED", label: "Quarta-feira", short: "Qua" },
  { value: "THU", label: "Quinta-feira", short: "Qui" },
  { value: "FRI", label: "Sexta-feira", short: "Sex" },
  { value: "SAT", label: "Sábado", short: "Sáb" },
  { value: "SUN", label: "Domingo", short: "Dom" },
];
const WEEKDAY_SHORT: Record<string, string> = Object.fromEntries(WEEKDAYS.map((d) => [d.value, d.short]));

const PRIORITY_OPTIONS = ["Baixa", "Normal", "Alta", "Urgente"];
const RISK_OPTIONS = ["Baixo", "Médio", "Alto", "Crítico"];

const ROUTINE_ACTION_LABEL: Record<string, string> = {
  CREATED: "Rotina criada",
  UPDATED: "Rotina atualizada",
  CHECKLIST_UPDATED: "Checklist atualizado",
  CANCELLED: "Rotina cancelada",
  REACTIVATED: "Rotina reativada",
  TASK_GENERATED: "Tarefa gerada automaticamente",
  GENERATION_FAILED: "Falha na geração automática",
};

export async function renderRoutines(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "routines");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;

  const profile = await getCachedProfile().catch(() => null);
  if (!profile || profile.role !== "admin") {
    shell.innerHTML = `<p class="error">Acesso restrito. Somente administradores podem gerenciar rotinas periódicas.</p>`;
    return;
  }

  let routines: Routine[];
  let profiles: Profile[];
  let processes: Process[];
  try {
    [routines, profiles, processes] = await Promise.all([listRoutines(), listCompanyProfiles(), listProcesses().catch(() => [])]);
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar as rotinas: ${(err as Error).message}</p>`;
    return;
  }

  renderPage(shell, routines, profiles, processes.filter((p) => p.ativo));
}

function profileOptions(profiles: Profile[], selectedId: string | null): string {
  return (
    `<option value="" disabled${selectedId ? "" : " selected"}>Selecione...</option>` +
    profiles.map((p) => `<option value="${p.id}"${p.id === selectedId ? " selected" : ""}>${escapeHtml(p.full_name)}</option>`).join("")
  );
}

function renderPage(shell: HTMLDivElement, routines: Routine[], profiles: Profile[], processes: Process[], editing: Routine | null = null): void {
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  shell.innerHTML = `
    <header class="app-header">
      <h1>Rotinas Periódicas</h1>
      <button id="new-routine-btn" class="btn-primary">+ Nova Rotina Periódica</button>
    </header>
    <p class="dashboard-subtitle">Uma rotina é cadastrada uma única vez e o sistema gera, sozinho, uma tarefa nova e independente em cada dia da semana configurado — até que um administrador a cancele.</p>

    <div id="routine-panel" class="card" hidden>
      <h3>${editing ? `Editar rotina — ${escapeHtml(editing.name)}` : "Nova rotina periódica"}</h3>
      <form id="routine-form" class="task-form">
        <label for="r-name">Nome da rotina *</label>
        <input id="r-name" required value="${escapeAttr(editing?.name ?? "")}" />

        <label for="r-description">Descrição</label>
        <textarea id="r-description" rows="2">${escapeHtml(editing?.description ?? "")}</textarea>

        <div class="task-form-row">
          <div>
            <label for="r-area">Área *</label>
            <input id="r-area" required value="${escapeAttr(editing?.area ?? "")}" />
          </div>
          <div>
            <label for="r-process">Processo vinculado (opcional)</label>
            <select id="r-process">
              <option value="">Nenhum</option>
              ${processes.map((p) => `<option value="${p.id}"${p.id === editing?.process_id ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="task-form-row">
          <div>
            <label for="r-responsible">Responsável principal *</label>
            <select id="r-responsible" required>${profileOptions(profiles, editing?.responsible_id ?? null)}</select>
          </div>
          <div>
            <label for="r-participants">Participantes (opcional)</label>
            <select id="r-participants" multiple size="4">
              ${profiles.map((p) => `<option value="${p.id}"${editing?.participant_ids.includes(p.id) ? " selected" : ""}>${escapeHtml(p.full_name)}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="task-form-row">
          <div>
            <label for="r-priority">Prioridade</label>
            <select id="r-priority">${PRIORITY_OPTIONS.map((o) => `<option${o === (editing?.priority ?? "Normal") ? " selected" : ""}>${o}</option>`).join("")}</select>
          </div>
          <div>
            <label for="r-risk">Risco</label>
            <select id="r-risk">${RISK_OPTIONS.map((o) => `<option${o === (editing?.risk ?? "Baixo") ? " selected" : ""}>${o}</option>`).join("")}</select>
          </div>
        </div>

        <label for="r-tags">Tags (separadas por vírgula)</label>
        <input id="r-tags" value="${escapeAttr((editing?.tags ?? []).join(", "))}" />

        <label><input id="r-evidence" type="checkbox" ${editing?.evidence_required ? "checked" : ""} /> Evidência obrigatória para concluir cada ocorrência</label>

        <label>Frequência — dias da semana *</label>
        <div id="r-weekdays" class="weekday-picker">
          ${WEEKDAYS.map(
            (d) => `
            <label class="weekday-chip">
              <input type="checkbox" value="${d.value}" ${(editing?.week_days ?? ["MON", "TUE", "WED", "THU", "FRI"]).includes(d.value) ? "checked" : ""} />
              ${d.short}
            </label>`,
          ).join("")}
        </div>

        <div class="task-form-row">
          <div>
            <label for="r-creation-time">Criar tarefa às *</label>
            <input id="r-creation-time" type="time" required value="${editing?.creation_time?.slice(0, 5) ?? "08:00"}" />
          </div>
          <div>
            <label for="r-deadline-time">Prazo de conclusão *</label>
            <input id="r-deadline-time" type="time" required value="${editing?.deadline_time?.slice(0, 5) ?? "18:00"}" />
          </div>
        </div>

        <label>Checklist da rotina</label>
        <ul id="r-checklist-builder" class="checklist-builder"></ul>
        <div class="checklist-add-row">
          <input id="r-checklist-input" type="text" placeholder="Novo item do checklist e pressionar Enter" />
          <button type="button" id="r-checklist-add-btn">+ Adicionar item</button>
        </div>

        <p id="routine-error" class="error" hidden></p>
        <div class="app-header-actions" style="margin-top:0.5rem">
          <button type="submit">${editing ? "Salvar alterações" : "Criar rotina"}</button>
          <button type="button" id="routine-cancel-btn" class="link-button">Cancelar</button>
        </div>
      </form>
    </div>

    <div class="card table-card">
      <table class="data-table">
        <thead>
          <tr><th>Nome</th><th>Área</th><th>Responsável</th><th>Dias</th><th>Horário</th><th>Próxima execução</th><th>Última geração</th><th>Criado por</th><th></th></tr>
        </thead>
        <tbody id="routine-rows"></tbody>
      </table>
    </div>
  `;

  const panel = shell.querySelector<HTMLDivElement>("#routine-panel")!;
  if (editing) panel.hidden = false;

  const newBtn = shell.querySelector<HTMLButtonElement>("#new-routine-btn")!;
  newBtn.addEventListener("click", () => {
    if (!panel.hidden && !editing) {
      panel.hidden = true;
    } else {
      renderPage(shell, routines, profiles, processes, null);
      shell.querySelector<HTMLDivElement>("#routine-panel")!.hidden = false;
    }
  });
  shell.querySelector<HTMLButtonElement>("#routine-cancel-btn")!.addEventListener("click", () => {
    renderPage(shell, routines, profiles, processes, null);
  });

  const checklistItems: string[] = [...(editing?.checklist_template ?? [])];
  const checklistList = shell.querySelector<HTMLUListElement>("#r-checklist-builder")!;
  const checklistInput = shell.querySelector<HTMLInputElement>("#r-checklist-input")!;

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
  shell.querySelector("#r-checklist-add-btn")!.addEventListener("click", addChecklistItem);
  checklistInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addChecklistItem();
    }
  });

  const form = shell.querySelector<HTMLFormElement>("#routine-form")!;
  const errorEl = shell.querySelector<HTMLParagraphElement>("#routine-error")!;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;

    const weekDays = Array.from(shell.querySelectorAll<HTMLInputElement>("#r-weekdays input:checked")).map((i) => i.value);
    if (weekDays.length === 0) {
      errorEl.textContent = "Selecione ao menos um dia da semana.";
      errorEl.hidden = false;
      return;
    }

    const submitBtn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    submitBtn.disabled = true;
    try {
      const input: RoutineInput = {
        name: (shell.querySelector("#r-name") as HTMLInputElement).value.trim(),
        area: (shell.querySelector("#r-area") as HTMLInputElement).value.trim(),
        responsibleId: (shell.querySelector("#r-responsible") as HTMLSelectElement).value,
        weekDays,
        description: (shell.querySelector("#r-description") as HTMLTextAreaElement).value.trim(),
        processId: (shell.querySelector("#r-process") as HTMLSelectElement).value || undefined,
        participantIds: Array.from((shell.querySelector("#r-participants") as HTMLSelectElement).selectedOptions).map((o) => o.value),
        priority: (shell.querySelector("#r-priority") as HTMLSelectElement).value,
        risk: (shell.querySelector("#r-risk") as HTMLSelectElement).value,
        tags: (shell.querySelector("#r-tags") as HTMLInputElement).value
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        evidenceRequired: (shell.querySelector("#r-evidence") as HTMLInputElement).checked,
        checklistTemplate: checklistItems,
        creationTime: (shell.querySelector("#r-creation-time") as HTMLInputElement).value || "08:00",
        deadlineTime: (shell.querySelector("#r-deadline-time") as HTMLInputElement).value || "18:00",
      };
      if (editing) {
        await updateRoutine(editing.id, input);
        await updateRoutineChecklist(editing.id, checklistItems);
      } else {
        await createRoutine(input);
      }
      toastSuccess(editing ? "Rotina atualizada." : "Rotina criada.");
      const fresh = await listRoutines();
      renderPage(shell, fresh, profiles, processes, null);
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : String(err);
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  const rowsEl = shell.querySelector<HTMLTableSectionElement>("#routine-rows")!;
  rowsEl.innerHTML = routines
    .map((r) => {
      const responsavel = profileById.get(r.responsible_id);
      const criador = profileById.get(r.created_by);
      return `
    <tr data-routine-id="${r.id}">
      <td class="cell-primary" title="${escapeHtml(r.name)}">
        ${escapeHtml(r.code ?? "")} ${escapeHtml(r.name)} ${routineStatusBadge(r.status)}
      </td>
      <td data-label="Área">${escapeHtml(r.area)}</td>
      <td data-label="Responsável">${escapeHtml(responsavel?.full_name ?? "—")}</td>
      <td data-label="Dias" class="wrap-cell">${r.week_days.map((d) => WEEKDAY_SHORT[d] ?? d).join(", ")}</td>
      <td data-label="Horário">${r.creation_time.slice(0, 5)} – ${r.deadline_time.slice(0, 5)}</td>
      <td data-label="Próxima execução">${formatNextOccurrence(r.status === "ACTIVE" ? r.next_occurrence_at : null)}</td>
      <td data-label="Última geração">${
        r.last_generated_at
          ? r.last_generated_task_id
            ? `<a href="#/tasks/${r.last_generated_task_id}">${new Date(r.last_generated_at).toLocaleString("pt-BR")}</a>`
            : new Date(r.last_generated_at).toLocaleString("pt-BR")
          : "—"
      }</td>
      <td data-label="Criado por">${escapeHtml(criador?.full_name ?? "—")}</td>
      <td data-label="" class="wrap-cell actions-cell">
        <button class="link-button" data-edit="${r.id}">editar</button>
        ${
          r.status === "ACTIVE"
            ? `<button class="link-button" data-cancel="${r.id}">cancelar</button>`
            : r.status === "CANCELLED"
              ? `<button class="link-button" data-reactivate="${r.id}">reativar</button>`
              : ""
        }
        <button class="link-button" data-history="${r.id}">histórico</button>
      </td>
    </tr>`;
    })
    .join("");

  if (routines.length === 0) {
    rowsEl.innerHTML = `<tr><td colspan="9" class="dropdown-empty">Nenhuma rotina cadastrada ainda.</td></tr>`;
  }

  rowsEl.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = routines.find((r) => r.id === btn.dataset.edit)!;
      renderPage(shell, routines, profiles, processes, target);
    });
  });

  rowsEl.querySelectorAll<HTMLButtonElement>("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const values = await openFormModal({
        title: "Cancelar rotina periódica?",
        description:
          "A rotina deixará de gerar novas tarefas. As tarefas que já foram criadas permanecerão no sistema e não serão excluídas.",
        fields: [{ name: "motivo", label: "Motivo do cancelamento (opcional)", type: "textarea" }],
        confirmLabel: "Cancelar rotina",
      });
      if (!values) return;
      try {
        await cancelRoutine(btn.dataset.cancel!, values.motivo || "");
        toastSuccess("Rotina cancelada.");
        const fresh = await listRoutines();
        renderPage(shell, fresh, profiles, processes, null);
      } catch (err) {
        toastError(err instanceof Error ? err.message : String(err));
      }
    });
  });

  rowsEl.querySelectorAll<HTMLButtonElement>("[data-reactivate]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const confirmed = await openFormModal({
        title: "Reativar rotina periódica?",
        description:
          "A rotina volta a gerar tarefas automaticamente a partir da próxima ocorrência válida. Os dias em que ela ficou cancelada não geram tarefas retroativas.",
        fields: [],
        confirmLabel: "Reativar rotina",
      });
      if (!confirmed) return;
      try {
        await reactivateRoutine(btn.dataset.reactivate!);
        toastSuccess("Rotina reativada.");
        const fresh = await listRoutines();
        renderPage(shell, fresh, profiles, processes, null);
      } catch (err) {
        toastError(err instanceof Error ? err.message : String(err));
      }
    });
  });

  rowsEl.querySelectorAll<HTMLButtonElement>("[data-history]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = routines.find((r) => r.id === btn.dataset.history)!;
      const entries = await listRoutineHistory(target.id).catch(() => []);
      showRoutineHistory(target, entries, profileById);
    });
  });
}

function showRoutineHistory(routine: Routine, entries: RoutineHistoryEntry[], profileById: Map<string, Profile>): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay open";
  overlay.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true">
      <div class="modal-header">
        <div><h3>${escapeHtml(routine.code ?? "")} ${escapeHtml(routine.name)}</h3><p>Histórico da rotina</p></div>
        <button type="button" class="modal-close" aria-label="Fechar">&times;</button>
      </div>
      <div class="modal-body task-form">
        ${
          entries.length === 0
            ? "<p>Sem eventos registrados ainda.</p>"
            : `<ul class="routine-history-list">${entries
                .map((e) => {
                  const who = e.user_id ? (profileById.get(e.user_id)?.full_name ?? "—") : "Sistema (geração automática)";
                  return `<li>
                    <strong>${escapeHtml(ROUTINE_ACTION_LABEL[e.action] ?? e.action)}</strong>
                    <span>${new Date(e.at).toLocaleString("pt-BR")} — ${escapeHtml(who)}</span>
                  </li>`;
                })
                .join("")}</ul>`
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

function formatNextOccurrence(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const weekday = d.toLocaleDateString("pt-BR", { weekday: "long" });
  const date = d.toLocaleDateString("pt-BR");
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${date} às ${time}`;
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

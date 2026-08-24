import { listCompanyProfiles } from "../lib/profiles";
import { listProcesses, type Process } from "../lib/processes";
import { createTask, startTask } from "../lib/tasks";
import type { Profile } from "../lib/types";
import { renderNav } from "./nav";
import { toastError } from "./toast";

export async function renderTaskCreate(root: HTMLElement, onCreated: (taskId: string) => void, onCancel: () => void): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "tasks");

  let profiles: Profile[];
  let processes: Process[];
  try {
    [profiles, processes] = await Promise.all([listCompanyProfiles(), listProcesses().catch(() => [])]);
  } catch (err) {
    root.querySelector(".app-shell")!.innerHTML = `<p class="error">Não foi possível carregar a lista de pessoas: ${(err as Error).message}</p>`;
    return;
  }
  const activeProcesses = processes.filter((p) => p.ativo);

  root.querySelector(".app-shell")!.innerHTML = `
      <header class="app-header">
        <button id="back-btn" class="link-button">&larr; Voltar</button>
        <h1>Tarefa Agendada</h1>
      </header>
      <form id="create-form" class="task-form">
        <label for="titulo">Título *</label>
        <input id="titulo" name="titulo" type="text" required />

        <label for="descricao">Descrição *</label>
        <textarea id="descricao" name="descricao" rows="3" required></textarea>

        <label for="processo">Processo (opcional)</label>
        <select id="processo" name="processo">
          <option value="">Nenhum — tarefa avulsa</option>
          ${activeProcesses.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.area ? ` (${escapeHtml(p.area)})` : ""}</option>`).join("")}
        </select>

        <label for="area">Área *</label>
        <input id="area" name="area" type="text" required placeholder="ex: Financeiro" />

        <label for="responsavel">Responsável *</label>
        <select id="responsavel" name="responsavel" required>
          <option value="" disabled selected>Selecione...</option>
          ${profiles.map((p) => `<option value="${p.id}">${escapeHtml(p.full_name)} (${escapeHtml(p.area || "sem área")})</option>`).join("")}
        </select>

        <div class="task-form-row">
          <div>
            <label for="inicio-data">Data de início</label>
            <input id="inicio-data" name="inicio-data" type="date" />
          </div>
          <div>
            <label for="inicio-hora">Horário de início</label>
            <input id="inicio-hora" name="inicio-hora" type="time" />
          </div>
        </div>
        <div class="task-form-row">
          <div>
            <label for="prazo-data">Data de término (prazo)</label>
            <input id="prazo-data" name="prazo-data" type="date" />
          </div>
          <div>
            <label for="prazo-hora">Horário de término</label>
            <input id="prazo-hora" name="prazo-hora" type="time" />
          </div>
        </div>
        <p id="date-range-error" class="error" hidden></p>

        <label for="estimativa">Estimativa (horas)</label>
        <input id="estimativa" name="estimativa" type="number" min="0" step="0.5" value="0" />

        <div class="task-form-row">
          <div>
            <label for="prioridade">Prioridade</label>
            <select id="prioridade" name="prioridade">
              <option>Baixa</option>
              <option selected>Normal</option>
              <option>Alta</option>
              <option>Urgente</option>
            </select>
          </div>
          <div>
            <label for="risco">Risco</label>
            <select id="risco" name="risco">
              <option selected>Baixo</option>
              <option>Médio</option>
              <option>Alto</option>
            </select>
          </div>
        </div>

        <label>Checklist</label>
        <ul id="checklist-builder" class="checklist-builder"></ul>
        <div class="checklist-add-row">
          <input id="checklist-input" type="text" placeholder="Adicionar item e pressionar Enter" />
          <button type="button" id="checklist-add-btn">Adicionar</button>
        </div>

        <p id="form-error" class="error" hidden></p>
        <button type="submit" id="submit-btn">Criar tarefa</button>
      </form>
  `;

  root.querySelector("#back-btn")!.addEventListener("click", onCancel);

  const checklistItems: string[] = [];
  const checklistList = root.querySelector<HTMLUListElement>("#checklist-builder")!;
  const checklistInput = root.querySelector<HTMLInputElement>("#checklist-input")!;

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

  const processoSelect = root.querySelector<HTMLSelectElement>("#processo")!;
  processoSelect.addEventListener("change", () => {
    const process = activeProcesses.find((p) => p.id === processoSelect.value);
    if (!process) return;

    const areaInput = root.querySelector<HTMLInputElement>("#area")!;
    if (!areaInput.value.trim() && process.area) areaInput.value = process.area;

    const responsavelSelect = root.querySelector<HTMLSelectElement>("#responsavel")!;
    if (!responsavelSelect.value && process.executor_id) responsavelSelect.value = process.executor_id;

    (root.querySelector<HTMLInputElement>("#estimativa")!).value = String(process.estimativa_padrao);
    (root.querySelector<HTMLSelectElement>("#risco")!).value = process.risco;

    const prazoDataInput = root.querySelector<HTMLInputElement>("#prazo-data")!;
    const prazoHoraInput = root.querySelector<HTMLInputElement>("#prazo-hora")!;
    if (!prazoDataInput.value && process.sla_horas) {
      const deadline = new Date(Date.now() + process.sla_horas * 3600000);
      deadline.setSeconds(0, 0);
      const iso = deadline.toISOString();
      prazoDataInput.value = iso.slice(0, 10);
      prazoHoraInput.value = iso.slice(11, 16);
    }

    // Only seed the checklist from the process's template when the
    // person hasn't already started building their own — re-selecting a
    // process (or picking a different one) shouldn't silently duplicate
    // or wipe out items someone already typed.
    if (checklistItems.length === 0 && process.checklist_padrao.length > 0) {
      checklistItems.push(...process.checklist_padrao);
      renderChecklist();
    }
  });

  root.querySelector("#checklist-add-btn")!.addEventListener("click", addChecklistItem);
  checklistInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addChecklistItem();
    }
  });

  const form = root.querySelector<HTMLFormElement>("#create-form")!;
  const errorEl = root.querySelector<HTMLParagraphElement>("#form-error")!;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;

    const responsavelId = (form.elements.namedItem("responsavel") as HTMLSelectElement).value;
    if (!responsavelId) {
      errorEl.textContent = "Selecione um responsável.";
      errorEl.hidden = false;
      return;
    }
    const descricao = (form.elements.namedItem("descricao") as HTMLTextAreaElement).value.trim();
    if (!descricao) {
      errorEl.textContent = "Descrição é obrigatória.";
      errorEl.hidden = false;
      return;
    }

    const inicioData = (form.elements.namedItem("inicio-data") as HTMLInputElement).value;
    const inicioHora = (form.elements.namedItem("inicio-hora") as HTMLInputElement).value;
    const dataInicio = inicioData ? `${inicioData}T${inicioHora || "00:00"}` : undefined;

    const prazoData = (form.elements.namedItem("prazo-data") as HTMLInputElement).value;
    const prazoHora = (form.elements.namedItem("prazo-hora") as HTMLInputElement).value;
    const prazo = prazoData ? `${prazoData}T${prazoHora || "00:00"}` : undefined;

    const dateRangeErrorEl = root.querySelector<HTMLParagraphElement>("#date-range-error")!;
    dateRangeErrorEl.hidden = true;
    if (dataInicio && prazo && new Date(dataInicio) > new Date(prazo)) {
      dateRangeErrorEl.textContent = "A data de início não pode ser depois do prazo final.";
      dateRangeErrorEl.hidden = false;
      return;
    }

    const submitButton = root.querySelector<HTMLButtonElement>("#submit-btn")!;
    submitButton.disabled = true;
    try {
      const result = await createTask({
        titulo: (form.elements.namedItem("titulo") as HTMLInputElement).value.trim(),
        descricao,
        area: (form.elements.namedItem("area") as HTMLInputElement).value.trim(),
        tipo: "Tarefa agendada",
        processId: (form.elements.namedItem("processo") as HTMLSelectElement).value || undefined,
        responsavelId,
        dataInicio,
        prazo,
        estimativa: Number((form.elements.namedItem("estimativa") as HTMLInputElement).value || 0),
        prioridade: (form.elements.namedItem("prioridade") as HTMLSelectElement).value,
        risco: (form.elements.namedItem("risco") as HTMLSelectElement).value,
        checklist: checklistItems,
      });
      await startTask(result.id).catch((err) => toastError(err instanceof Error ? err.message : String(err)));
      onCreated(result.id);
    } catch (err) {
      errorEl.textContent = (err as Error).message;
      errorEl.hidden = false;
    } finally {
      submitButton.disabled = false;
    }
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

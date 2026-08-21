import { DEFAULT_FILTERS, type TaskFilterState } from "../lib/taskFilters";
import type { Profile } from "../lib/types";

export interface FilterBarOptions {
  profiles: Profile[];
  statuses?: string[];
  showSort?: boolean;
}

export function renderFilterBar(container: HTMLElement, options: FilterBarOptions, onChange: (state: TaskFilterState) => void): void {
  const state: TaskFilterState = { ...DEFAULT_FILTERS };

  container.innerHTML = `
    <div class="toolbar">
      <input id="f-search" class="control grow" placeholder="Buscar por título ou código..." />
      ${
        options.statuses
          ? `<select id="f-status" class="control"><option value="">Todos os status</option>${options.statuses
              .map((s) => `<option value="${s}">${s}</option>`)
              .join("")}</select>`
          : ""
      }
      <select id="f-responsavel" class="control">
        <option value="">Todos os responsáveis</option>
        ${options.profiles.map((p) => `<option value="${p.id}">${escapeHtml(p.full_name)}</option>`).join("")}
      </select>
      <select id="f-prioridade" class="control">
        <option value="">Todas as prioridades</option>
        ${["Baixa", "Normal", "Alta", "Urgente"].map((p) => `<option value="${p}">${p}</option>`).join("")}
      </select>
      <select id="f-risco" class="control">
        <option value="">Todos os riscos</option>
        ${["Baixo", "Médio", "Alto", "Crítico"].map((r) => `<option value="${r}">${r}</option>`).join("")}
      </select>
      <select id="f-prazo" class="control">
        <option value="">Qualquer prazo</option>
        <option value="atrasadas">Atrasadas</option>
        <option value="hoje">Hoje</option>
        <option value="7dias">Próximos 7 dias</option>
      </select>
      ${
        options.showSort
          ? `<select id="f-sort" class="control">
              <option value="prazo_asc">Prazo mais próximo</option>
              <option value="prazo_desc">Prazo mais distante</option>
              <option value="atualizado">Atualização recente</option>
              <option value="prioridade">Prioridade</option>
            </select>`
          : ""
      }
      <button type="button" id="f-clear" class="btn-outline">Limpar filtros</button>
    </div>
  `;

  const bind = (id: string, field: keyof TaskFilterState) => {
    const el = container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
    if (!el) return;
    const evt = el.tagName === "INPUT" ? "input" : "change";
    el.addEventListener(evt, () => {
      (state as unknown as Record<string, string>)[field] = el.value;
      onChange({ ...state });
    });
  };

  bind("f-search", "search");
  bind("f-status", "status");
  bind("f-responsavel", "responsavelId");
  bind("f-prioridade", "prioridade");
  bind("f-risco", "risco");
  bind("f-prazo", "prazo");
  bind("f-sort", "sort");

  container.querySelector("#f-clear")!.addEventListener("click", () => {
    Object.assign(state, DEFAULT_FILTERS);
    container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".control").forEach((el) => {
      if (el.id === "f-sort") el.value = "prazo_asc";
      else el.value = "";
    });
    onChange({ ...state });
  });

  onChange({ ...state });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

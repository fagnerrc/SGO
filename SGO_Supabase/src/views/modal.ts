// Small, dependency-free modal for the handful of places that need to
// collect one or two fields before calling a mutating RPC (motivo,
// evidência, quem está sendo aguardado) — replaces native prompt()/textarea
// panels that don't match the rest of the visual language.

export interface ModalField {
  name: string;
  label: string;
  type?: "text" | "textarea";
  required?: boolean;
}

export function openFormModal(options: {
  title: string;
  description?: string;
  fields: ModalField[];
  confirmLabel?: string;
}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay open";
    overlay.innerHTML = `
      <div class="modal modal-sm" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div>
            <h3>${escapeHtml(options.title)}</h3>
            ${options.description ? `<p>${escapeHtml(options.description)}</p>` : ""}
          </div>
          <button type="button" class="modal-close" aria-label="Fechar">&times;</button>
        </div>
        <form class="modal-body task-form">
          ${options.fields
            .map(
              (f) => `
            <label for="modal-${f.name}">${escapeHtml(f.label)}${f.required ? " *" : ""}</label>
            ${
              f.type === "textarea"
                ? `<textarea id="modal-${f.name}" name="${f.name}" rows="3" ${f.required ? "required" : ""}></textarea>`
                : `<input id="modal-${f.name}" name="${f.name}" type="text" ${f.required ? "required" : ""} />`
            }`,
            )
            .join("")}
          <div class="modal-footer">
            <button type="button" class="btn-outline modal-cancel">Cancelar</button>
            <button type="submit" class="btn-primary">${escapeHtml(options.confirmLabel ?? "Confirmar")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = (result: Record<string, string> | null) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector(".modal-close")!.addEventListener("click", () => cleanup(null));
    overlay.querySelector(".modal-cancel")!.addEventListener("click", () => cleanup(null));
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) cleanup(null);
    });

    const form = overlay.querySelector("form")!;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values: Record<string, string> = {};
      for (const f of options.fields) {
        values[f.name] = (form.elements.namedItem(f.name) as HTMLInputElement | HTMLTextAreaElement).value.trim();
      }
      cleanup(values);
    });

    (overlay.querySelector("input, textarea") as HTMLElement | null)?.focus();
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

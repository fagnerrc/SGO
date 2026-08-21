import { applyBranding, getBranding, updateBranding, uploadLogo } from "../lib/branding";
import { getCachedProfile, renderNav } from "./nav";
import { toastError, toastSuccess } from "./toast";

const PRIVILEGED_ROLES = new Set(["admin", "diretoria", "auditoria"]);

const PRESET_COLORS = [
  { name: "Verde (padrão)", value: "#1f6b45" },
  { name: "Roxo", value: "#6a4fa0" },
  { name: "Azul", value: "#2f6fa0" },
  { name: "Coral", value: "#c0522e" },
  { name: "Rosa", value: "#b5386c" },
];

export async function renderSettings(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "settings");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;

  const profile = await getCachedProfile().catch(() => null);
  if (!profile || !PRIVILEGED_ROLES.has(profile.role)) {
    shell.innerHTML = `<p class="error">Esta tela é só para perfis privilegiados (admin, diretoria ou auditoria).</p>`;
    return;
  }

  const branding = await getBranding();

  shell.innerHTML = `
    <header class="app-header">
      <h1>Configurações</h1>
    </header>
    <p class="dashboard-subtitle">Identidade visual do SGO para todo mundo na empresa — cor de destaque, nome e logo.</p>

    <div class="settings-grid">
      <form id="branding-form" class="card">
        <label>Cor de destaque</label>
        <div class="color-swatches" id="color-swatches">
          ${PRESET_COLORS.map(
            (c) => `
            <button type="button" class="color-swatch${c.value === branding.accentColor ? " selected" : ""}" data-color="${c.value}" style="background:${c.value}" title="${c.name}"></button>`,
          ).join("")}
        </div>
        <label for="accent-hex">Cor customizada (hex)</label>
        <div class="hex-row">
          <input id="accent-hex" type="text" value="${branding.accentColor}" maxlength="7" />
          <input id="accent-hex-picker" type="color" value="${branding.accentColor}" />
        </div>

        <label for="display-name">Nome de exibição</label>
        <input id="display-name" type="text" value="${escapeAttr(branding.displayName ?? branding.name)}" />

        <label for="logo-file">Logo</label>
        <input id="logo-file" type="file" accept="image/png,image/jpeg,image/webp" />
        <p class="settings-hint">PNG, JPG ou WebP, até 5 MB. Envia e já mostra a pré-visualização assim que você escolher o arquivo.</p>
        <label for="logo-url">Ou cole a URL de uma imagem já hospedada</label>
        <input id="logo-url" type="text" placeholder="https://..." value="${escapeAttr(branding.logoUrl ?? "")}" />

        <p id="settings-error" class="error" hidden></p>
        <p id="settings-success" class="new-collab-result" hidden>Salvo! A nova identidade já está valendo para todo mundo.</p>
        <button type="submit" id="save-btn">Salvar</button>
      </form>

      <div class="card settings-preview">
        <h3>Pré-visualização</h3>
        <div class="preview-sidebar-brand">
          <span id="preview-logo" class="sidebar-brand-mark">${initialsOf(branding.displayName ?? branding.name)}</span>
          <div>
            <strong id="preview-name">${escapeHtml(branding.displayName ?? branding.name)}</strong>
            <span>SGO</span>
          </div>
        </div>
        <div class="preview-pill active" id="preview-pill">
          <span>Dashboard</span>
        </div>
        <button id="preview-btn" type="button" class="preview-button">Nova tarefa</button>
      </div>
    </div>
  `;

  const hexInput = shell.querySelector<HTMLInputElement>("#accent-hex")!;
  const hexPicker = shell.querySelector<HTMLInputElement>("#accent-hex-picker")!;
  const nameInput = shell.querySelector<HTMLInputElement>("#display-name")!;
  const logoInput = shell.querySelector<HTMLInputElement>("#logo-url")!;
  const logoFileInput = shell.querySelector<HTMLInputElement>("#logo-file")!;

  logoFileInput.addEventListener("change", async () => {
    const file = logoFileInput.files?.[0];
    if (!file) return;
    logoFileInput.disabled = true;
    try {
      const url = await uploadLogo(file);
      logoInput.value = url;
      updatePreview();
      toastSuccess("Logo enviado — clique em Salvar para aplicar para todo mundo.");
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
      logoFileInput.value = "";
    } finally {
      logoFileInput.disabled = false;
    }
  });

  function currentColor(): string {
    return hexInput.value.trim() || "#1f6b45";
  }

  function updatePreview(): void {
    const color = currentColor();
    const name = nameInput.value.trim() || "SGO";
    shell.querySelector<HTMLElement>("#preview-pill")!.style.background = color;
    shell.querySelector<HTMLElement>("#preview-btn")!.style.background = color;
    shell.querySelector<HTMLElement>("#preview-name")!.textContent = name;
    const logoEl = shell.querySelector<HTMLElement>("#preview-logo")!;
    const logoUrl = logoInput.value.trim();
    if (logoUrl) {
      logoEl.outerHTML = `<img id="preview-logo" src="${escapeAttr(logoUrl)}" alt="" class="sidebar-brand-logo" />`;
    } else {
      logoEl.textContent = initialsOf(name);
      logoEl.style.background = color;
    }
  }

  shell.querySelectorAll<HTMLButtonElement>(".color-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      shell.querySelectorAll(".color-swatch").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      hexInput.value = btn.dataset.color!;
      hexPicker.value = btn.dataset.color!;
      updatePreview();
    });
  });
  hexPicker.addEventListener("input", () => {
    hexInput.value = hexPicker.value;
    updatePreview();
  });
  hexInput.addEventListener("input", updatePreview);
  nameInput.addEventListener("input", updatePreview);
  logoInput.addEventListener("input", updatePreview);

  const form = shell.querySelector<HTMLFormElement>("#branding-form")!;
  const errorEl = shell.querySelector<HTMLParagraphElement>("#settings-error")!;
  const successEl = shell.querySelector<HTMLParagraphElement>("#settings-success")!;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    successEl.hidden = true;
    const submitBtn = shell.querySelector<HTMLButtonElement>("#save-btn")!;
    submitBtn.disabled = true;
    try {
      const color = currentColor();
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        throw new Error("Cor inválida — use o formato hexadecimal, ex: #1f6b45.");
      }
      await updateBranding({ accentColor: color, displayName: nameInput.value.trim(), logoUrl: logoInput.value.trim() });
      applyBranding({ name: color, displayName: nameInput.value.trim(), accentColor: color, logoUrl: logoInput.value.trim() || null });
      successEl.hidden = false;
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : String(err);
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "SG"
  );
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

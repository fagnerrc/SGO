export type ToastType = "success" | "error" | "warning" | "info";

let containerEl: HTMLElement | null = null;

function getContainer(): HTMLElement {
  if (containerEl && document.body.contains(containerEl)) return containerEl;
  containerEl = document.createElement("div");
  containerEl.className = "toast-stack";
  document.body.appendChild(containerEl);
  return containerEl;
}

export function showToast(message: string, type: ToastType = "info", durationMs = 5000): void {
  const container = getContainer();
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-message"></span><button type="button" class="toast-close" aria-label="Fechar">&times;</button>`;
  toast.querySelector(".toast-message")!.textContent = message;

  const remove = () => {
    toast.classList.add("toast-leaving");
    setTimeout(() => toast.remove(), 180);
  };
  toast.querySelector(".toast-close")!.addEventListener("click", remove);
  const timer = setTimeout(remove, durationMs);
  toast.addEventListener("mouseenter", () => clearTimeout(timer));

  container.appendChild(toast);
}

export const toastSuccess = (message: string) => showToast(message, "success");
export const toastError = (message: string) => showToast(message, "error", 7000);
export const toastWarning = (message: string) => showToast(message, "warning", 6000);
export const toastInfo = (message: string) => showToast(message, "info");

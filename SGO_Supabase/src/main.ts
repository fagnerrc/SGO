import { startApp } from "./app";
import { toastError } from "./views/toast";
import { initTimerDock } from "./views/timerDock";

const root = document.querySelector<HTMLDivElement>("#app")!;
startApp(root);

initTimerDock(document.querySelector<HTMLDivElement>("#timer-dock-mount")!);

// Safety net for anything a view's own try/catch missed — without this,
// an unexpected exception anywhere just fails silently (the exact class
// of bug behind the stale-session crash fixed earlier: the page looked
// "stuck loading" with nothing telling the person something broke).
// Throttled so a cascade of related errors doesn't spam five toasts at
// once.
let lastGlobalErrorAt = 0;
function reportUnexpectedError(source: string, error: unknown): void {
  console.error(`[SGO] unhandled ${source}:`, error);
  const now = Date.now();
  if (now - lastGlobalErrorAt < 4000) return;
  lastGlobalErrorAt = now;
  toastError("Ocorreu um erro inesperado. Se a tela parecer travada, recarregue a página.");
}

window.addEventListener("error", (event) => reportUnexpectedError("error", event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => reportUnexpectedError("promise rejection", event.reason));

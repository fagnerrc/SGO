import { reportClientError } from "./lib/diagnostics";
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
// once — but every occurrence still gets persisted via reportClientError
// (fire-and-forget, itself throttle-free) so the diagnostics screen sees
// the true count even when the toast was suppressed.
let lastGlobalErrorAt = 0;
function reportUnexpectedError(source: string, error: unknown): void {
  console.error(`[SGO] unhandled ${source}:`, error);

  const errObj = error instanceof Error ? error : null;
  reportClientError(errObj?.message ?? String(error), {
    action: source === "error" ? "WINDOW_ERROR" : "UNHANDLED_REJECTION",
    module: "window",
    stack: errObj?.stack ?? null,
  });

  const now = Date.now();
  if (now - lastGlobalErrorAt < 4000) return;
  lastGlobalErrorAt = now;
  toastError("Ocorreu um erro inesperado. Se a tela parecer travada, recarregue a página.");
}

window.addEventListener("error", (event) => reportUnexpectedError("error", event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => reportUnexpectedError("promise rejection", event.reason));

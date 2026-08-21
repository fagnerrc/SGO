import { loadSession } from "./lib/session";
import { renderLogin } from "./views/login";
import { renderTaskList } from "./views/taskList";
import { renderTaskDetail } from "./views/taskDetail";

// Deliberately minimal hash router — #/login, #/tasks, #/tasks/:id.
// No SPA framework, matching the old system's plain-JS approach (see
// SGO_Supabase_Migration_Prompt.md section 3); a proper router/state
// layer is a fine thing to add once there's more than three screens.

export function startApp(root: HTMLElement): void {
  window.addEventListener("hashchange", () => route(root));
  route(root);
}

function route(root: HTMLElement): void {
  const hash = location.hash || "#/tasks";
  const session = loadSession();

  if (!session && hash !== "#/login") {
    location.hash = "#/login";
    return;
  }
  if (session && hash === "#/login") {
    location.hash = "#/tasks";
    return;
  }

  if (hash === "#/login") {
    renderLogin(root, () => {
      location.hash = "#/tasks";
    });
    return;
  }

  const taskMatch = hash.match(/^#\/tasks\/(.+)$/);
  if (taskMatch) {
    renderTaskDetail(root, taskMatch[1], () => {
      location.hash = "#/tasks";
    });
    return;
  }

  renderTaskList(root, (taskId) => {
    location.hash = `#/tasks/${taskId}`;
  });
}

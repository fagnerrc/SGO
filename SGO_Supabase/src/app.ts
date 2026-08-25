import { loadSession } from "./lib/session";
import { renderLogin } from "./views/login";
import { renderTaskList } from "./views/taskList";
import { renderTaskDetail } from "./views/taskDetail";
import { renderTaskCreate } from "./views/taskCreate";
import { renderDashboard } from "./views/dashboard";
import { renderKanban } from "./views/kanban";
import { renderApprovals } from "./views/approvals";
import { renderAudit } from "./views/audit";
import { renderReports } from "./views/reports";
import { renderDiagnostics } from "./views/diagnostics";
import { renderCollaborators } from "./views/collaborators";
import { renderSettings } from "./views/settings";
import { renderProcesses } from "./views/processes";
import { renderMyWork } from "./views/myWork";
import { renderRoutines } from "./views/routines";
import { renderPresence } from "./views/presence";

// Deliberately minimal hash router — no SPA framework, matching the old
// system's plain-JS approach (see SGO_Supabase_Migration_Prompt.md section
// 3). Routes: #/login, #/dashboard (default landing page), #/tasks,
// #/tasks/new, #/tasks/:id, #/kanban, #/approvals, #/admin/collaborators.

export function startApp(root: HTMLElement): void {
  window.addEventListener("hashchange", () => route(root));
  route(root);
}

function route(root: HTMLElement): void {
  const hash = location.hash || "#/dashboard";
  const session = loadSession();

  if (!session && hash !== "#/login") {
    location.hash = "#/login";
    return;
  }
  if (session && hash === "#/login") {
    location.hash = "#/dashboard";
    return;
  }

  if (hash === "#/login") {
    renderLogin(root, () => {
      location.hash = "#/dashboard";
    });
    return;
  }

  const openTask = (taskId: string) => {
    location.hash = `#/tasks/${taskId}`;
  };

  if (hash === "#/dashboard" || hash === "") {
    renderDashboard(root, openTask);
    return;
  }

  if (hash === "#/mywork") {
    renderMyWork(root, openTask);
    return;
  }

  if (hash === "#/kanban") {
    renderKanban(root, openTask);
    return;
  }

  if (hash === "#/approvals") {
    renderApprovals(root);
    return;
  }

  if (hash === "#/audit") {
    renderAudit(root);
    return;
  }

  if (hash === "#/reports") {
    renderReports(root);
    return;
  }

  if (hash === "#/diagnostics") {
    renderDiagnostics(root);
    return;
  }

  if (hash === "#/admin/collaborators") {
    renderCollaborators(root);
    return;
  }

  if (hash === "#/admin/settings") {
    renderSettings(root);
    return;
  }

  if (hash === "#/admin/processes") {
    renderProcesses(root);
    return;
  }

  if (hash === "#/admin/routines") {
    renderRoutines(root);
    return;
  }

  if (hash.startsWith("#/presence")) {
    renderPresence(root);
    return;
  }

  if (hash === "#/tasks/new") {
    renderTaskCreate(root, openTask, () => {
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

  renderTaskList(root, openTask);
}

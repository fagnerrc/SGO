import { approveTask, listPendingApprovals, rejectTask } from "../lib/tasks";
import type { Task } from "../lib/types";
import { priorityBadge } from "./badges";
import { openFormModal } from "./modal";
import { renderNav } from "./nav";
import { toastSuccess } from "./toast";

export async function renderApprovals(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "approvals");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;
  await renderList(shell);
}

async function renderList(shell: HTMLDivElement): Promise<void> {
  let tasks: Task[];
  try {
    tasks = await listPendingApprovals();
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar as aprovações: ${(err as Error).message}</p>`;
    return;
  }

  shell.innerHTML = `
    <h1>Aprovações</h1>
    <p class="dashboard-subtitle">Tarefas aguardando decisão. Só quem é o aprovador designado no processo (ou um perfil privilegiado) consegue aprovar ou reprovar de verdade — as ações abaixo são recusadas pelo servidor caso contrário.</p>
    <p id="approvals-error" class="error" hidden></p>
    <div id="approvals-list" class="task-list">
      ${
        tasks
          .map(
            (t) => `
        <div class="approval-card" data-task-id="${t.id}">
          <div>
            <span class="task-card-code">${t.code ?? ""} ${priorityBadge(t.prioridade)}</span>
            <span class="task-card-title">${escapeHtml(t.titulo)}</span>
            <span class="approval-waiting-since">aguardando desde ${t.updated_at ? new Date(t.updated_at).toLocaleDateString("pt-BR") : "—"}</span>
          </div>
          <div class="approval-actions">
            <button class="approve-btn" data-task-id="${t.id}">Aprovar</button>
            <button class="reject-btn danger-button" data-task-id="${t.id}">Reprovar</button>
          </div>
        </div>`,
          )
          .join("") || "<p>Nenhuma tarefa aguardando sua aprovação.</p>"
      }
    </div>
  `;

  const errorEl = shell.querySelector<HTMLParagraphElement>("#approvals-error")!;
  const showError = (err: unknown) => {
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.hidden = false;
  };

  shell.querySelectorAll<HTMLButtonElement>(".approve-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      errorEl.hidden = true;
      try {
        await approveTask(btn.dataset.taskId!);
        toastSuccess("Tarefa aprovada.");
        await renderList(shell);
      } catch (err) {
        showError(err);
      }
    });
  });

  shell.querySelectorAll<HTMLButtonElement>(".reject-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const values = await openFormModal({
        title: "Reprovar tarefa",
        fields: [{ name: "motivo", label: "Motivo da reprovação", type: "textarea", required: true }],
        confirmLabel: "Reprovar",
      });
      if (!values) return;
      errorEl.hidden = true;
      try {
        await rejectTask(btn.dataset.taskId!, values.motivo);
        toastSuccess("Tarefa reprovada e devolvida.");
        await renderList(shell);
      } catch (err) {
        showError(err);
      }
    });
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

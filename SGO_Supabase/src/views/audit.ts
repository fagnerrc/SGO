// Auditoria — the real audit workflow (checklist gap: the port only ever
// had a bare Kanban drag from Concluída to Auditada, no data collected,
// no reject path, no findings tracking). Ported from the old system's
// #page-relatorios sibling #auditModal/saveAuditFromForm (Index.html) and
// the findings list ("Relatórios e achados"), backed by audit_task() /
// set_audit_finding_status() in 0030_audit_findings.sql.

import { listCompanyProfiles } from "../lib/profiles";
import { auditTask, getChecklist, listAuditFindings, listPendingAudits, setAuditFindingStatus } from "../lib/tasks";
import type { AuditFinding, AuditFindingStatus, ChecklistItem, Profile, Task } from "../lib/types";
import { priorityBadge, riskBadge, routineBadge, statusBadge } from "./badges";
import { openFormModal } from "./modal";
import { renderNav } from "./nav";
import { toastError, toastSuccess } from "./toast";

function formatSpentTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatChecklistForDisplay(items: ChecklistItem[]): string {
  if (items.length === 0) return "Sem checklist.";
  return items.map((item) => `${item.feito ? "☑" : "☐"} ${item.texto}`).join("\n");
}

type AuditTab = "fila" | "achados";

const RISCO_OPTIONS = ["Baixo", "Médio", "Alto", "Crítico"];
const FINDING_STATUS_OPTIONS: AuditFindingStatus[] = ["Aberto", "Em andamento", "Concluído", "Validado", "Ineficaz", "Cancelado"];
const ACAO_OPTIONS = [
  "Corrigir informação incorreta",
  "Complementar informação faltante",
  "Refazer atividade",
  "Corrigir lançamento/cadastro",
  "Adequar procedimento",
  "Revisar tarefas relacionadas",
  "Escalar problema para gestor",
  "Reatribuir tarefa",
  "Anexar documentação pendente",
  "Aprovado sem ressalva",
];

export async function renderAudit(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div id="nav-mount"></div><div class="app-shell"><p>Carregando...</p></div>`;
  await renderNav(root.querySelector("#nav-mount")!, "audit");

  const shell = root.querySelector<HTMLDivElement>(".app-shell")!;

  let pending: Task[];
  let findings: AuditFinding[];
  let profiles: Profile[];
  try {
    [pending, findings, profiles] = await Promise.all([listPendingAudits(), listAuditFindings(), listCompanyProfiles()]);
  } catch (err) {
    shell.innerHTML = `<p class="error">Não foi possível carregar a auditoria: ${(err as Error).message}
      (esta tela é só para perfis privilegiados — diretoria, auditoria ou admin)</p>`;
    return;
  }

  const profileById = new Map(profiles.map((p) => [p.id, p]));
  let active: AuditTab = "fila";

  shell.innerHTML = `
    <h1 class="dashboard-title">Auditoria</h1>
    <p class="dashboard-subtitle">Tarefas concluídas aguardando revisão, e o acompanhamento dos achados já registrados.</p>
    <div class="tabs" id="audit-tabs">
      <button type="button" class="tab" data-tab="fila">Fila de auditoria <span class="tab-count" id="fila-count">${pending.length}</span></button>
      <button type="button" class="tab" data-tab="achados">Relatórios e achados <span class="tab-count" id="achados-count">${findings.length}</span></button>
    </div>
    <p id="audit-error" class="error" hidden></p>
    <div id="audit-panel"></div>
  `;

  const panel = shell.querySelector<HTMLDivElement>("#audit-panel")!;
  const tabButtons = shell.querySelectorAll<HTMLButtonElement>(".tab");
  const errorEl = shell.querySelector<HTMLParagraphElement>("#audit-error")!;
  const showError = (err: unknown) => {
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.hidden = false;
  };

  async function reload(): Promise<void> {
    try {
      [pending, findings] = await Promise.all([listPendingAudits(), listAuditFindings()]);
    } catch (err) {
      showError(err);
      return;
    }
    shell.querySelector<HTMLSpanElement>("#fila-count")!.textContent = String(pending.length);
    shell.querySelector<HTMLSpanElement>("#achados-count")!.textContent = String(findings.length);
    renderTab(active);
  }

  function renderTab(tab: AuditTab): void {
    active = tab;
    tabButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
    errorEl.hidden = true;
    if (tab === "fila") renderQueue();
    else renderFindings();
  }

  function renderQueue(): void {
    if (pending.length === 0) {
      panel.innerHTML = "<p>Nenhuma tarefa concluída aguardando auditoria.</p>";
      return;
    }
    panel.innerHTML = `
      <div class="task-list">
        ${pending
          .map((t) => {
            const responsavel = profileById.get(t.responsavel_id);
            return `
          <div class="approval-card audit-queue-card" data-task-id="${t.id}">
            <div>
              <span class="task-card-code">${t.code ?? ""} ${priorityBadge(t.prioridade)} ${routineBadge(t.tipo)}</span>
              <span class="task-card-title">${escapeHtml(t.titulo)}</span>
              ${t.descricao ? `<span class="audit-queue-desc">${escapeHtml(t.descricao)}</span>` : ""}
              <div class="audit-queue-meta">
                <span>${escapeHtml(responsavel?.full_name ?? "—")}</span>
                <span>${t.tipo === "Tarefa cronometrada" ? "Cronômetro" : "Agendada"}</span>
                <span>Tempo gasto: ${formatSpentTime(t.timer_total_ms)}</span>
                <span>${statusBadge(t.status)}</span>
                <span class="approval-waiting-since">concluída em ${t.concluido_em ? new Date(t.concluido_em).toLocaleDateString("pt-BR") : "—"}</span>
              </div>
            </div>
            <div class="approval-actions">
              <button class="btn-primary audit-btn" data-task-id="${t.id}">Auditar</button>
            </div>
          </div>`;
          })
          .join("")}
      </div>
    `;
    panel.querySelectorAll<HTMLButtonElement>(".audit-btn").forEach((btn) => {
      btn.addEventListener("click", () => void openAuditForm(btn.dataset.taskId!));
    });
  }

  async function openAuditForm(taskId: string): Promise<void> {
    const task = pending.find((t) => t.id === taskId);
    const checklist = await getChecklist(taskId).catch(() => []);
    const responsavel = task ? profileById.get(task.responsavel_id) : null;
    const values = await openFormModal({
      title: "Registrar auditoria",
      description: "Fato e ação corretiva são obrigatórios em ambos os resultados — servem de registro mesmo quando a tarefa é aprovada.",
      fields: [
        { name: "titulo", label: "Título", type: "readonly", defaultValue: task ? `${task.code ?? ""} ${task.titulo}`.trim() : "—" },
        { name: "descricao", label: "Descrição", type: "readonly", defaultValue: task?.descricao || "—" },
        { name: "responsavel", label: "Responsável", type: "readonly", defaultValue: responsavel?.full_name ?? "—" },
        { name: "tipo", label: "Tipo", type: "readonly", defaultValue: task?.tipo ?? "—" },
        { name: "prazo_original", label: "Prazo", type: "readonly", defaultValue: task?.prazo ? new Date(task.prazo).toLocaleString("pt-BR") : "—" },
        { name: "tempo_gasto", label: "Tempo gasto", type: "readonly", defaultValue: task ? formatSpentTime(task.timer_total_ms) : "—" },
        { name: "checklist_display", label: "Checklist", type: "readonly", defaultValue: formatChecklistForDisplay(checklist) },
        { name: "evidencia_execucao", label: "Evidência de execução", type: "readonly", defaultValue: task?.evidencia || "Nenhuma evidência registrada." },
        {
          name: "resultado",
          label: "Resultado",
          type: "select",
          required: true,
          options: [
            { value: "Aprovada", label: "Aprovada" },
            { value: "Reprovada", label: "Reprovada" },
          ],
        },
        {
          name: "risco",
          label: "Risco",
          type: "select",
          required: true,
          options: RISCO_OPTIONS.map((r) => ({ value: r, label: r })),
        },
        { name: "fato", label: "Fato observado", type: "textarea", required: true },
        {
          name: "acao",
          label: "Ação corretiva",
          type: "select",
          required: true,
          options: ACAO_OPTIONS.map((a) => ({ value: a, label: a })),
        },
        {
          name: "responsavel_id",
          label: "Responsável pela ação corretiva (obrigatório se reprovada)",
          type: "select",
          options: profiles.map((p) => ({ value: p.id, label: p.full_name })),
          defaultValue: task?.responsavel_id,
        },
        { name: "prazo", label: "Prazo da ação (obrigatório se reprovada)", type: "date" },
        { name: "evidencia", label: "Evidência / observação", type: "textarea" },
      ],
      confirmLabel: "Registrar",
    });
    if (!values) return;

    try {
      await auditTask(taskId, {
        resultado: values.resultado as "Aprovada" | "Reprovada",
        risco: values.risco,
        fato: values.fato,
        acao: values.acao,
        responsavelId: values.responsavel_id || null,
        prazo: values.prazo || null,
        evidencia: values.evidencia,
      });
      toastSuccess(values.resultado === "Aprovada" ? "Tarefa auditada e aprovada." : "Tarefa auditada, reprovada e devolvida.");
      await reload();
    } catch (err) {
      showError(err);
    }
  }

  function renderFindings(): void {
    if (findings.length === 0) {
      panel.innerHTML = "<p>Nenhum achado de auditoria registrado ainda.</p>";
      return;
    }
    panel.innerHTML = `
      <div class="card table-card">
        <table class="data-table">
          <colgroup>
            <col style="width:17%" /><col style="width:10%" /><col style="width:9%" /><col style="width:13%" />
            <col style="width:11%" /><col style="width:11%" /><col style="width:16%" /><col style="width:13%" />
          </colgroup>
          <thead>
            <tr><th>Tarefa</th><th>Resultado</th><th>Risco</th><th>Responsável</th><th>Prazo</th><th>Registrado em</th><th>Status</th><th></th></tr>
          </thead>
          <tbody id="findings-rows">
            ${findings
              .map((f) => {
                const responsavel = f.responsavel_id ? profileById.get(f.responsavel_id) : null;
                return `
              <tr data-finding-id="${f.id}">
                <td class="cell-primary" title="${escapeHtml(f.tasks?.titulo ?? "")}">${f.tasks?.code ?? ""} ${escapeHtml(f.tasks?.titulo ?? "")}</td>
                <td data-label="Resultado">${f.resultado === "Aprovada" ? '<span class="badge badge-green">Aprovada</span>' : '<span class="badge badge-red">Reprovada</span>'}</td>
                <td data-label="Risco" class="wrap-cell">${riskBadge(f.risco)}</td>
                <td data-label="Responsável" title="${escapeHtml(responsavel?.full_name ?? "—")}">${escapeHtml(responsavel?.full_name ?? "—")}</td>
                <td data-label="Prazo">${f.prazo ? new Date(f.prazo).toLocaleDateString("pt-BR") : "—"}</td>
                <td data-label="Registrado em">${new Date(f.criado_em).toLocaleDateString("pt-BR")}</td>
                <td data-label="Status" class="wrap-cell">
                  <select class="finding-status-select" data-finding-id="${f.id}">
                    ${FINDING_STATUS_OPTIONS.map((s) => `<option value="${s}"${s === f.status ? " selected" : ""}>${s}</option>`).join("")}
                  </select>
                </td>
                <td data-label="" class="wrap-cell actions-cell"><button class="link-button finding-detail-btn" data-finding-id="${f.id}">ver detalhes</button></td>
              </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    `;
    panel.querySelectorAll<HTMLSelectElement>(".finding-status-select").forEach((select) => {
      select.addEventListener("change", async () => {
        try {
          await setAuditFindingStatus(select.dataset.findingId!, select.value as AuditFindingStatus);
          toastSuccess("Status do achado atualizado.");
          const f = findings.find((x) => x.id === select.dataset.findingId);
          if (f) f.status = select.value as AuditFindingStatus;
        } catch (err) {
          toastError((err as Error).message);
          await reload();
        }
      });
    });
    panel.querySelectorAll<HTMLButtonElement>(".finding-detail-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const f = findings.find((x) => x.id === btn.dataset.findingId);
        if (f) void showFindingDetail(f, profileById);
      });
    });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => renderTab(btn.dataset.tab as AuditTab));
  });

  renderTab(active);
}

async function showFindingDetail(f: AuditFinding, profileById: Map<string, Profile>): Promise<void> {
  const task = f.tasks;
  const checklist = await getChecklist(f.task_id).catch(() => []);

  const responsavel = task ? profileById.get(task.responsavel_id) : null;
  const execRows: [string, string][] = task
    ? [
        ["Executado por", responsavel?.full_name ?? "—"],
        ["Tempo gasto", formatSpentTime(task.timer_total_ms)],
        ["Tipo", task.tipo],
        ["Status atual", task.status],
        ["Descrição da tarefa", task.descricao || "—"],
        ["Início", task.data_inicio ? new Date(task.data_inicio).toLocaleString("pt-BR") : "—"],
        ["Prazo", task.prazo ? new Date(task.prazo).toLocaleString("pt-BR") : "—"],
        ["Concluída em", task.concluido_em ? new Date(task.concluido_em).toLocaleString("pt-BR") : "—"],
        ["Evidência de execução", task.evidencia || "Nenhuma evidência registrada."],
      ]
    : [];

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay open";
  const auditRows: [string, string][] = [
    ["Fato observado", f.fato],
    ["Ação corretiva", f.acao],
  ];
  if (f.evidencia) auditRows.push(["Evidência / observação", f.evidencia]);

  overlay.innerHTML = `
    <div class="modal modal-sm" role="dialog" aria-modal="true">
      <div class="modal-header">
        <div><h3>${escapeHtml(task?.code ?? "")} ${escapeHtml(task?.titulo ?? "")}</h3></div>
        <button type="button" class="modal-close" aria-label="Fechar">&times;</button>
      </div>
      <div class="modal-body task-form">
        <h4>Execução da tarefa</h4>
        ${execRows.map(([label, text]) => `<label>${escapeHtml(label)}</label><p>${escapeHtml(text)}</p>`).join("")}
        <label>Checklist</label>
        ${
          checklist.length > 0
            ? `<ul class="finding-detail-checklist">${checklist
                .map((item) => `<li>${item.feito ? "☑" : "☐"} ${escapeHtml(item.texto)}</li>`)
                .join("")}</ul>`
            : "<p>Sem itens de checklist.</p>"
        }
        <h4>Registro da auditoria</h4>
        ${auditRows.map(([label, text]) => `<label>${escapeHtml(label)}</label><p>${escapeHtml(text)}</p>`).join("")}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector(".modal-close")!.addEventListener("click", close);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

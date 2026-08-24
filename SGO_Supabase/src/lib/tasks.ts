import { getClient, throwSupabaseError } from "./supabase";
import type { AuditFinding, AuditFindingStatus, AuditResult, ChecklistItem, Task } from "./types";

// Every mutation function below sends a fresh operation_id, so a retried
// call (flaky network, a double-click) is safely idempotent server-side —
// see claim_operation()/complete_operation() in
// supabase/migrations/0007_task_functions.sql. There is deliberately no
// local-first outbox/queue here yet (the old Index.html's headline
// feature): this is a plain call-and-await implementation for now. See
// PROGRESS.md phase 6 notes for why that's a real gap, not an oversight.
function newOperationId(): string {
  return crypto.randomUUID();
}

// "One running Cronômetro at a time, any number open" (0034): starting
// or resuming a Tarefa cronometrada now auto-pauses whichever other one
// was running, server-side, inside the same transaction — a real
// guarantee, not a client-side check racing against itself. This still
// finds *the* running one when there is one (for the dock's primary
// display); listOpenTimerTasks() below is what surfaces the rest.
export async function getActiveTimerTask(profileId: string): Promise<Task | null> {
  const { data, error } = await getClient()
    .from("tasks")
    .select("*")
    .eq("responsavel_id", profileId)
    .eq("timer_state", "running")
    .eq("excluido", false)
    .limit(1)
    .maybeSingle();
  if (error) throwSupabaseError(error);
  return (data as Task | null) ?? null;
}

// Every open (not yet Concluída/Auditada/Cancelada) Tarefa cronometrada
// for this person, running one first — this is what lets the dock show
// "+N outras" and lets a person switch between several open timed tasks
// without losing any of them.
export async function listOpenTimerTasks(profileId: string): Promise<Task[]> {
  const { data, error } = await getClient()
    .from("tasks")
    .select("*")
    .eq("responsavel_id", profileId)
    .eq("tipo", "Tarefa cronometrada")
    .not("status", "in", "(Concluída,Auditada,Cancelada)")
    .eq("excluido", false)
    .order("updated_at", { ascending: false });
  if (error) throwSupabaseError(error);
  const tasks = data as Task[];
  return tasks.sort((a, b) => {
    if (a.timer_state === "running" && b.timer_state !== "running") return -1;
    if (b.timer_state === "running" && a.timer_state !== "running") return 1;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
}

export async function listMyTasks(): Promise<Task[]> {
  const { data, error } = await getClient()
    .from("tasks")
    .select("*")
    .eq("excluido", false)
    .order("prazo", { ascending: true, nullsFirst: false });
  if (error) throwSupabaseError(error);
  return data as Task[];
}

export async function getTask(taskId: string): Promise<Task> {
  const { data, error } = await getClient().from("tasks").select("*").eq("id", taskId).single();
  if (error) throwSupabaseError(error);
  return data as Task;
}

export async function getChecklist(taskId: string): Promise<ChecklistItem[]> {
  const { data, error } = await getClient()
    .from("task_checklist_items")
    .select("*")
    .eq("task_id", taskId)
    .order("position", { ascending: true });
  if (error) throwSupabaseError(error);
  return data as ChecklistItem[];
}

async function callAction<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getClient().rpc(fn, args);
  if (error) throwSupabaseError(error);
  return data as T;
}

export const startTask = (taskId: string) => callAction("start_task", { p_task_id: taskId, p_operation_id: newOperationId() });

export const pauseTask = (taskId: string) => callAction("pause_task", { p_task_id: taskId, p_operation_id: newOperationId() });

export const resumeTask = (taskId: string) => callAction("resume_task", { p_task_id: taskId, p_operation_id: newOperationId() });

export const completeTask = (taskId: string, evidencia: string, justificativaAtraso = "") =>
  callAction("complete_task", {
    p_task_id: taskId,
    p_operation_id: newOperationId(),
    p_evidencia: evidencia,
    p_justificativa_atraso: justificativaAtraso,
  });

export const waitTask = (taskId: string, aguardandoQuem: string, motivoEspera = "") =>
  callAction("wait_task", {
    p_task_id: taskId,
    p_operation_id: newOperationId(),
    p_aguardando_quem: aguardandoQuem,
    p_motivo_espera: motivoEspera,
  });

export interface AuditTaskInput {
  resultado: AuditResult;
  risco: string;
  fato: string;
  acao: string;
  responsavelId?: string | null;
  prazo?: string | null; // ISO datetime, from a <input type="datetime-local">
  evidencia?: string;
}

export const auditTask = (taskId: string, input: AuditTaskInput) =>
  callAction("audit_task", {
    p_task_id: taskId,
    p_operation_id: newOperationId(),
    p_resultado: input.resultado,
    p_risco: input.risco,
    p_fato: input.fato,
    p_acao: input.acao,
    p_responsavel_id: input.responsavelId ?? null,
    p_prazo: input.prazo ? new Date(input.prazo).toISOString() : null,
    p_evidencia: input.evidencia ?? "",
  });

// A task audited either way (approved or reproved) leaves 'Concluída'
// immediately — Aprovada moves it to 'Auditada', Reprovada reopens it to
// 'Reprovada/devolvida' (see audit_task() in 0030_audit_findings.sql). So
// "pending audit" is simply every task still sitting in 'Concluída',
// no separate flag needed.
export async function listPendingAudits(): Promise<Task[]> {
  const { data, error } = await getClient()
    .from("tasks")
    .select("*")
    .eq("status", "Concluída")
    .eq("excluido", false)
    .order("concluido_em", { ascending: true });
  if (error) throwSupabaseError(error);
  return data as Task[];
}

export async function listAuditFindings(): Promise<AuditFinding[]> {
  const { data, error } = await getClient()
    .from("audit_findings")
    .select("*, tasks(code, titulo, descricao, tipo, status, responsavel_id, timer_total_ms, prazo, data_inicio, concluido_em)")
    .order("criado_em", { ascending: false });
  if (error) throwSupabaseError(error);
  return data as AuditFinding[];
}

export const setAuditFindingStatus = (findingId: string, status: AuditFindingStatus) =>
  callAction("set_audit_finding_status", { p_finding_id: findingId, p_status: status });

export const approvalWaitTask = (taskId: string) => callAction("approval_wait_task", { p_task_id: taskId, p_operation_id: newOperationId() });

export const cancelTask = (taskId: string, motivo: string) =>
  callAction("cancel_task", { p_task_id: taskId, p_operation_id: newOperationId(), p_motivo: motivo });

export const approveTask = (taskId: string) => callAction("approve_task", { p_task_id: taskId, p_operation_id: newOperationId() });

export const rejectTask = (taskId: string, motivo: string) =>
  callAction("reject_task", { p_task_id: taskId, p_operation_id: newOperationId(), p_motivo: motivo });

// Soft-delete: excluido=true, independent of status (0033_soft_delete.sql)
// — the task disappears from every list (listMyTasks already filters
// excluido=false) but the row, and everything that references it, stays
// intact. Reversible via restoreTask(); nothing is ever hard-deleted.
export const deleteTask = (taskId: string) => callAction("delete_task", { p_task_id: taskId, p_operation_id: newOperationId() });

export const restoreTask = (taskId: string) => callAction("restore_task", { p_task_id: taskId, p_operation_id: newOperationId() });

export async function listDeletedTasks(): Promise<Task[]> {
  const { data, error } = await getClient().from("tasks").select("*").eq("excluido", true).order("updated_at", { ascending: false });
  if (error) throwSupabaseError(error);
  return data as Task[];
}

// Same table, same RLS-filtered visibility as listMyTasks() — the approver
// clause in tasks_select (0006/0007) is what actually decides who sees a
// given pending-approval task, this is just a narrower status filter on
// top. A task showing up here doesn't guarantee the viewer IS the
// designated approver (a participant could also see it) — approve_task()/
// reject_task() enforce that server-side regardless of what this list
// shows, so acting on the wrong task here fails cleanly rather than
// silently succeeding.
export async function listPendingApprovals(): Promise<Task[]> {
  const { data, error } = await getClient()
    .from("tasks")
    .select("*")
    .eq("status", "Aguardando aprovação")
    .eq("excluido", false)
    .order("aguardando_desde", { ascending: true });
  if (error) throwSupabaseError(error);
  return data as Task[];
}

export async function toggleChecklistItem(itemId: string, done: boolean): Promise<void> {
  // Direct table update, not an RPC — task_checklist_items_update (0011)
  // is a simple RLS policy scoped, at the grant level, to just this one
  // column (see 0011's comment for why). Verified working end-to-end
  // through this exact code path in a real browser (PROGRESS.md).
  const { error } = await getClient().from("task_checklist_items").update({ feito: done }).eq("id", itemId);
  if (error) throwSupabaseError(error);
}

export interface NewTaskInput {
  titulo: string;
  area: string;
  responsavelId: string;
  descricao?: string;
  tipo?: string;
  processId?: string;
  dataInicio?: string; // ISO datetime, from a <input type="datetime-local">-shaped string
  prazo?: string; // ISO datetime — the deadline/end date, distinct from dataInicio
  estimativa?: number;
  prioridade?: string;
  risco?: string;
  checklist?: string[];
}

export async function createTask(input: NewTaskInput): Promise<{ id: string }> {
  return callAction("create_task", {
    p_operation_id: newOperationId(),
    p_titulo: input.titulo,
    p_area: input.area,
    p_responsavel_id: input.responsavelId,
    p_descricao: input.descricao ?? "",
    p_tipo: input.tipo ?? "Demanda operacional",
    p_process_id: input.processId ?? null,
    p_data_inicio: input.dataInicio ? new Date(input.dataInicio).toISOString() : null,
    p_prazo: input.prazo ? new Date(input.prazo).toISOString() : null,
    p_estimativa: input.estimativa ?? 0,
    p_prioridade: input.prioridade ?? "Normal",
    p_risco: input.risco ?? "Baixo",
    p_checklist: input.checklist ?? [],
  });
}

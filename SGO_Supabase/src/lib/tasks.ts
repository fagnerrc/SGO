import { getClient } from "./supabase";
import type { ChecklistItem, Task } from "./types";

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

export async function listMyTasks(): Promise<Task[]> {
  const { data, error } = await getClient()
    .from("tasks")
    .select("*")
    .eq("excluido", false)
    .order("prazo", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data as Task[];
}

export async function getTask(taskId: string): Promise<Task> {
  const { data, error } = await getClient().from("tasks").select("*").eq("id", taskId).single();
  if (error) throw error;
  return data as Task;
}

export async function getChecklist(taskId: string): Promise<ChecklistItem[]> {
  const { data, error } = await getClient()
    .from("task_checklist_items")
    .select("*")
    .eq("task_id", taskId)
    .order("position", { ascending: true });
  if (error) throw error;
  return data as ChecklistItem[];
}

async function callAction<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getClient().rpc(fn, args);
  if (error) throw error;
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

export const cancelTask = (taskId: string, motivo: string) =>
  callAction("cancel_task", { p_task_id: taskId, p_operation_id: newOperationId(), p_motivo: motivo });

export async function toggleChecklistItem(itemId: string, done: boolean): Promise<void> {
  // Direct table update, not an RPC: task_checklist_items has no write
  // policy in 0006/0007 yet (create_task() is the only writer so far) —
  // this call will fail against RLS until that's added. Flagged in
  // PROGRESS.md; left in place so the UI shape is right even though the
  // backend piece for it isn't wired up yet.
  const { error } = await getClient().from("task_checklist_items").update({ feito: done }).eq("id", itemId);
  if (error) throw error;
}

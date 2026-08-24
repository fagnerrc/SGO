import { getClient, throwSupabaseError } from "./supabase";
import type { Routine, RoutineHistoryEntry } from "./types";

export async function listRoutines(): Promise<Routine[]> {
  const { data, error } = await getClient().from("routines").select("*").order("created_at", { ascending: false });
  if (error) throwSupabaseError(error);
  return data as Routine[];
}

export async function getRoutine(routineId: string): Promise<Routine> {
  const { data, error } = await getClient().from("routines").select("*").eq("id", routineId).single();
  if (error) throwSupabaseError(error);
  return data as Routine;
}

export async function listRoutineHistory(routineId: string): Promise<RoutineHistoryEntry[]> {
  const { data, error } = await getClient()
    .from("routine_history")
    .select("*")
    .eq("routine_id", routineId)
    .order("at", { ascending: false });
  if (error) throwSupabaseError(error);
  return data as RoutineHistoryEntry[];
}

async function callAction<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getClient().rpc(fn, args);
  if (error) throwSupabaseError(error);
  return data as T;
}

export interface RoutineInput {
  name: string;
  area: string;
  responsibleId: string;
  weekDays: string[];
  description?: string;
  processId?: string;
  participantIds?: string[];
  priority?: string;
  risk?: string;
  tags?: string[];
  evidenceRequired?: boolean;
  checklistTemplate?: string[];
  creationTime?: string; // "HH:MM"
  deadlineTime?: string;
}

export const createRoutine = (input: RoutineInput) =>
  callAction<Routine>("create_routine", {
    p_name: input.name,
    p_area: input.area,
    p_responsible_id: input.responsibleId,
    p_week_days: input.weekDays,
    p_description: input.description ?? "",
    p_process_id: input.processId ?? null,
    p_participant_ids: input.participantIds ?? [],
    p_priority: input.priority ?? "Normal",
    p_risk: input.risk ?? "Baixo",
    p_tags: input.tags ?? [],
    p_evidence_required: input.evidenceRequired ?? false,
    p_checklist_template: input.checklistTemplate ?? [],
    p_creation_time: input.creationTime ?? "08:00",
    p_deadline_time: input.deadlineTime ?? "18:00",
  });

export const updateRoutine = (routineId: string, input: RoutineInput) =>
  callAction<Routine>("update_routine", {
    p_routine_id: routineId,
    p_name: input.name,
    p_area: input.area,
    p_responsible_id: input.responsibleId,
    p_week_days: input.weekDays,
    p_description: input.description ?? "",
    p_process_id: input.processId ?? null,
    p_participant_ids: input.participantIds ?? [],
    p_priority: input.priority ?? "Normal",
    p_risk: input.risk ?? "Baixo",
    p_tags: input.tags ?? [],
    p_evidence_required: input.evidenceRequired ?? false,
    p_creation_time: input.creationTime ?? "08:00",
    p_deadline_time: input.deadlineTime ?? "18:00",
  });

export const updateRoutineChecklist = (routineId: string, items: string[]) =>
  callAction<Routine>("update_routine_checklist", { p_routine_id: routineId, p_items: items });

export const cancelRoutine = (routineId: string, reason = "") =>
  callAction<Routine>("cancel_routine", { p_routine_id: routineId, p_reason: reason });

export const reactivateRoutine = (routineId: string) => callAction<Routine>("reactivate_routine", { p_routine_id: routineId });

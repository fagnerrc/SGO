import { getClient, throwSupabaseError } from "./supabase";

export interface Process {
  id: string;
  name: string;
  codigo: string | null;
  area: string | null;
  descricao: string | null;
  dono_id: string | null;
  executor_id: string | null;
  conferente_id: string | null;
  aprovador_id: string | null;
  sla_horas: number | null;
  tolerancia_horas: number;
  risco: string;
  segregacao: boolean;
  evidencia_obrigatoria: boolean;
  evidencia_orientacao: string | null;
  estimativa_padrao: number;
  checklist_padrao: string[];
  recorrencia: string;
  ativo: boolean;
}

export async function listProcesses(): Promise<Process[]> {
  const { data, error } = await getClient().from("processes").select("*").order("name", { ascending: true });
  if (error) throwSupabaseError(error);
  return data as Process[];
}

export interface ProcessInput {
  name: string;
  codigo: string;
  area: string;
  descricao: string;
  donoId: string;
  executorId: string;
  conferenteId: string;
  aprovadorId: string;
  slaHoras: number | null;
  toleranciaHoras: number;
  risco: string;
  segregacao: boolean;
  evidenciaObrigatoria: boolean;
  evidenciaOrientacao: string;
  estimativaPadrao: number;
  checklistPadrao: string[];
  recorrencia: string;
}

function toRpcArgs(input: ProcessInput): Record<string, unknown> {
  return {
    p_name: input.name,
    p_codigo: input.codigo || null,
    p_area: input.area || null,
    p_descricao: input.descricao || null,
    p_dono_id: input.donoId || null,
    p_executor_id: input.executorId || null,
    p_conferente_id: input.conferenteId || null,
    p_aprovador_id: input.aprovadorId || null,
    p_sla_horas: input.slaHoras,
    p_tolerancia_horas: input.toleranciaHoras,
    p_risco: input.risco,
    p_segregacao: input.segregacao,
    p_evidencia_obrigatoria: input.evidenciaObrigatoria,
    p_evidencia_orientacao: input.evidenciaOrientacao || null,
    p_estimativa_padrao: input.estimativaPadrao,
    p_checklist_padrao: input.checklistPadrao,
    p_recorrencia: input.recorrencia,
  };
}

export async function createProcess(input: ProcessInput): Promise<Process> {
  const { data, error } = await getClient().rpc("create_process", toRpcArgs(input));
  if (error) throwSupabaseError(error);
  return data as Process;
}

export async function updateProcess(processId: string, input: ProcessInput): Promise<Process> {
  const { data, error } = await getClient().rpc("update_process", { p_process_id: processId, ...toRpcArgs(input) });
  if (error) throwSupabaseError(error);
  return data as Process;
}

export async function setProcessActive(processId: string, active: boolean): Promise<void> {
  const { error } = await getClient().rpc("set_process_active", { p_process_id: processId, p_active: active });
  if (error) throwSupabaseError(error);
}

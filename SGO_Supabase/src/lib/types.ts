// Mirrors the enums/columns from supabase/migrations/0003_tasks.sql. Kept
// hand-written rather than generated (`supabase gen types`) — the schema
// has now actually been applied to a real project (see PROGRESS.md's LIVE
// VALIDATION sections), so generating this for real is a reasonable
// follow-up, just not done yet.

export type TaskStatus =
  | "Em andamento"
  | "Aguardando terceiro"
  | "Aguardando aprovação"
  | "Reprovada/devolvida"
  | "Concluída"
  | "Auditada"
  | "Cancelada";

export type TimerState = "paused" | "running" | "waiting" | "approval" | "completed";

export interface Task {
  id: string;
  code: string | null;
  area: string;
  titulo: string;
  descricao: string;
  tipo: string;
  responsavel_id: string;
  solicitante_id: string;
  participantes: string[];
  prazo: string | null;
  prazo_manual: boolean;
  estimativa: number;
  prioridade: string;
  risco: string;
  status: TaskStatus;
  progresso: number;
  evidencia: string;
  justificativa_atraso: string;
  timer_state: TimerState;
  timer_total_ms: number;
  timer_active_started_at: string | null;
  record_version: number;
  created_at: string;
  updated_at: string;
  concluido_em: string | null;
}

export interface ChecklistItem {
  id: string;
  task_id: string;
  texto: string;
  feito: boolean;
  position: number;
}

export interface Profile {
  id: string;
  full_name: string;
  email: string;
  role: string;
  area: string;
  active: boolean;
  capacidade_semanal: number;
}

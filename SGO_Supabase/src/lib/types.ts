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
  data_inicio: string | null;
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
  excluido: boolean;
  routine_id: string | null;
  routine_occurrence_key: string | null;
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
  last_activity_at: string | null;
}

export type AuditResult = "Aprovada" | "Reprovada";

export type AuditFindingStatus = "Aberto" | "Em andamento" | "Concluído" | "Validado" | "Ineficaz" | "Cancelado";

export type LogLevel = "info" | "warn" | "error";
export type LogKind = "activity" | "audit" | "security" | "diagnostic";

export interface LogEntry {
  id: number;
  kind: LogKind;
  level: LogLevel;
  user_id: string;
  task_id: string | null;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface CronJobStatus {
  jobname: string;
  schedule: string;
  active: boolean;
  last_status: string | null;
  last_start: string | null;
  last_end: string | null;
}

export interface AuditFinding {
  id: string;
  task_id: string;
  resultado: AuditResult;
  risco: string;
  fato: string;
  acao: string;
  responsavel_id: string | null;
  prazo: string | null;
  evidencia: string;
  status: AuditFindingStatus;
  criado_por: string;
  criado_em: string;
  tasks?: {
    code: string | null;
    titulo: string;
    descricao: string;
    tipo: string;
    status: TaskStatus;
    responsavel_id: string;
    timer_total_ms: number;
    prazo: string | null;
    data_inicio: string | null;
    concluido_em: string | null;
    evidencia: string;
  } | null;
}

export type RoutineStatus = "ACTIVE" | "PAUSED" | "CANCELLED";

export interface Routine {
  id: string;
  code: string | null;
  company_id: string;
  area: string;
  name: string;
  description: string;
  process_id: string | null;
  responsible_id: string;
  participant_ids: string[];
  priority: string;
  risk: string;
  tags: string[];
  evidence_required: boolean;
  checklist_template: string[];
  estimativa: number;
  week_days: string[];
  creation_time: string; // "HH:MM:SS"
  deadline_time: string;
  timezone: string;
  status: RoutineStatus;
  start_date: string;
  end_mode: "UNTIL_CANCELLED";
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  last_generated_at: string | null;
  last_occurrence_date: string | null;
  last_generated_task_id: string | null;
  next_occurrence_at: string | null;
  version: number;
}

export interface RoutineHistoryEntry {
  id: number;
  routine_id: string;
  at: string;
  user_id: string | null;
  action: string;
  details: Record<string, unknown>;
}

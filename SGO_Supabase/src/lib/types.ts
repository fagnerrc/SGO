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
  tasks?: { code: string | null; titulo: string } | null;
}

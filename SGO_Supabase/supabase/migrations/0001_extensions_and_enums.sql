-- SGO on Supabase — extensions and enums
-- Mirrors the status/role vocabularies found in the Apps Script source
-- (V12_TaskOperations.gs, V12_SecuritySync.gs, V10_Database.gs).

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "pg_cron";    -- daily task generation, deadline notifications

create type user_role as enum (
  'colaborador',
  'gestor',
  'diretoria',
  'auditoria',
  'admin'
);

create type task_status as enum (
  'Em andamento',
  'Aguardando terceiro',
  'Aguardando aprovação',
  'Reprovada/devolvida',
  'Concluída',
  'Auditada',
  'Cancelada'
);

-- Old system special-cased 'Tarefa cronometrada' throughout (timer rules,
-- terminal-state protection). Kept as free text (many demand types exist)
-- but the app must treat this exact string as the timed-task marker.
create domain task_type as text;

create type timer_state as enum (
  'paused',
  'running',
  'waiting',
  'approval',
  'completed'
);

create type approval_status as enum (
  'not_required',
  'pending',
  'approved'
);

create type conversation_type as enum (
  'direct',
  'task',
  'area'
);

create type notification_type as enum (
  'TASK_ASSIGNED',
  'TASK_UPDATED',
  'FEEDBACK_RECEIVED',
  'TASK_MESSAGE',
  'MESSAGE_RECEIVED',
  'MENTION',
  'TASK_OVERDUE',
  'TASK_DUE_SOON',
  'APPROVAL_PENDING'
);

create type log_kind as enum (
  'activity',
  'audit',
  'security'
);

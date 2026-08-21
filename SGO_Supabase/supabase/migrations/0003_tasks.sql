-- SGO on Supabase — tasks and its child tables
-- Replaces: V12_TaskOperations.gs (mutateTaskServer / completeTaskServer /
-- updateTaskServer / timer state machine) and the SGO_TAREFAS collection.
--
-- Design notes (see SGO_Supabase_Migration_Prompt.md section 6 for the bug
-- numbers referenced below):
--
-- * historico / comentarios / links / timeTracking.sessions were JSON arrays
--   embedded in the task record in the old system (and needed manual
--   archiving once they grew too large — a bug in itself). Here they are
--   proper child tables: queryable, unbounded, no archiving hack needed.
-- * Terminal-state protection (bug #5) and action-gating (bug #4) are
--   enforced by the enforce_task_transition() trigger below for ALL task
--   types, not just 'Tarefa cronometrada' — the old system's gap.
-- * Regular authenticated clients get SELECT only on this table (see
--   0006_rls_policies.sql). All writes go through the mutate_task() /
--   timer action functions in a later migration, which run as SECURITY
--   DEFINER and are the only place allowed to move a task through a gated
--   transition. A bare `update tasks set status = ...` from a client is
--   structurally impossible, not just discouraged.

create table tasks (
  id uuid primary key default gen_random_uuid(),
  code text unique,                                  -- e.g. SGO-000123, assigned on insert
  company_id uuid not null references companies (id),
  area text not null,
  process_id uuid references processes (id),
  titulo text not null,
  descricao text not null default '',
  tipo task_type not null default 'Demanda operacional',

  solicitante_id uuid not null references profiles (id),
  responsavel_id uuid not null references profiles (id),
  participantes uuid[] not null default '{}',

  prazo timestamptz,
  prazo_manual boolean not null default false,        -- true once a human sets/edits prazo
  estimativa numeric not null default 0,
  prioridade text not null default 'Normal',
  risco text not null default 'Baixo',

  status task_status not null default 'Em andamento',
  progresso smallint not null default 0 check (progresso between 0 and 100),

  aguardando_quem text not null default '',
  aguardando_desde timestamptz,
  motivo_espera text not null default '',

  evidencia text not null default '',
  justificativa_atraso text not null default '',

  approval_status approval_status not null default 'not_required',
  approved_by uuid references profiles (id),
  approved_at timestamptz,

  timer_state timer_state not null default 'paused',
  timer_total_ms bigint not null default 0,
  timer_active_started_at timestamptz,
  timer_started_at timestamptz,
  timer_completed_at timestamptz,

  tags text[] not null default '{}',
  excluido boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  concluido_em timestamptz,

  record_version bigint not null default 1,           -- kept for optimistic-lock-style client UX

  constraint tasks_waiting_fields_required check (
    status not in ('Aguardando terceiro', 'Aguardando aprovação')
    or (aguardando_quem <> '' and aguardando_desde is not null)
  ),
  constraint tasks_completion_requires_evidence check (
    status not in ('Concluída', 'Auditada') or evidencia <> ''
  )
);

create index tasks_company_idx on tasks (company_id);
create index tasks_area_idx on tasks (area);
create index tasks_responsavel_idx on tasks (responsavel_id);
create index tasks_solicitante_idx on tasks (solicitante_id);
create index tasks_status_idx on tasks (status);
create index tasks_participantes_idx on tasks using gin (participantes);
create index tasks_prazo_idx on tasks (prazo) where excluido = false;

create trigger tasks_touch_updated_at
  before update on tasks
  for each row execute function touch_updated_at();

-- Sequential human-friendly code, e.g. SGO-000123. Old system
-- (allocateTaskCodeV12183_) scanned the whole sheet under the global lock to
-- find the next number; a sequence is the whole point of Postgres here.
create sequence task_code_seq;

create function assign_task_code()
returns trigger
language plpgsql
as $$
begin
  if new.code is null then
    new.code := 'SGO-' || lpad(nextval('task_code_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;

create trigger tasks_assign_code
  before insert on tasks
  for each row execute function assign_task_code();

-- ---------------------------------------------------------------------
-- Child tables (replace historico / comentarios / links / timeTracking.sessions
-- arrays, and the checklist array)
-- ---------------------------------------------------------------------

create table task_checklist_items (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  texto text not null,
  feito boolean not null default false,
  position integer not null default 0
);

create index task_checklist_items_task_idx on task_checklist_items (task_id);

create table task_history (
  id bigint generated always as identity primary key,
  task_id uuid not null references tasks (id) on delete cascade,
  at timestamptz not null default now(),
  user_id uuid references profiles (id),
  action text not null,
  from_status task_status,
  to_status task_status,
  operation_id text
);

create index task_history_task_idx on task_history (task_id, at desc);

create table task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  author_id uuid not null references profiles (id),
  body text not null,
  created_at timestamptz not null default now()
);

create index task_comments_task_idx on task_comments (task_id, created_at);

create table task_links (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  url text not null,
  label text not null default '',
  created_at timestamptz not null default now()
);

create index task_links_task_idx on task_links (task_id);

create table task_timer_sessions (
  id bigint generated always as identity primary key,
  task_id uuid not null references tasks (id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_ms bigint,
  outcome text                                        -- 'paused' | 'waiting' | 'approval' | 'completed'
);

create index task_timer_sessions_task_idx on task_timer_sessions (task_id);

-- ---------------------------------------------------------------------
-- Transition guard: fixes bug #4 (generic update reaching a gated status)
-- and bug #5 (terminal-state resurrection, old system only covered timed
-- tasks). mutate_task()/timer action functions (0007_task_functions.sql)
-- call set_config('sgo.action', <action>, true) before performing an
-- UPDATE; a bare client UPDATE (should one ever be attempted directly
-- against this table) has no action set and is always rejected once the
-- task is in a gated or terminal status.
-- ---------------------------------------------------------------------

create function enforce_task_transition()
returns trigger
language plpgsql
as $$
declare
  action text := coalesce(current_setting('sgo.action', true), '');
  terminal_statuses task_status[] := array['Concluída', 'Auditada', 'Cancelada'];
  gated_statuses task_status[] := array['Concluída', 'Auditada', 'Cancelada', 'Reprovada/devolvida', 'Aguardando aprovação', 'Aguardando terceiro'];
begin
  -- Bug #5 fix: ANY task type in a terminal status stays there unless the
  -- dedicated reopen action explicitly says otherwise (no such action
  -- exists yet in this migration — reopening is out of scope until a
  -- reopen_task() function with its own audit trail is added).
  if old.status = any (terminal_statuses) and new.status <> old.status and action <> 'reopen' then
    raise exception 'SGO_TERMINAL_STATE_PRESERVED: task % is % and cannot be moved to % without the reopen action',
      old.id, old.status, new.status;
  end if;

  -- Bug #4 fix: reaching a gated status requires the matching explicit
  -- action, uniformly (old system missed 'Cancelada' and
  -- 'Reprovada/devolvida' specifically).
  if new.status <> old.status and new.status = any (gated_statuses) then
    if (new.status = 'Concluída' and action <> 'complete')
      or (new.status = 'Auditada' and action <> 'audit')
      or (new.status = 'Cancelada' and action <> 'cancel')
      or (new.status = 'Reprovada/devolvida' and action <> 'reject')
      or (new.status = 'Aguardando aprovação' and action <> 'approval_wait')
      or (new.status = 'Aguardando terceiro' and action <> 'wait')
    then
      raise exception 'SGO_ACTION_REQUIRED: status % can only be reached via its dedicated action, got action=%',
        new.status, action;
    end if;
  end if;

  return new;
end;
$$;

create trigger tasks_enforce_transition
  before update on tasks
  for each row execute function enforce_task_transition();

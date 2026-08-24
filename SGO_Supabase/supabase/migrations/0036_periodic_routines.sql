-- SGO on Supabase — Rotinas Periódicas (Tarefa Periódica / Rotina Recorrente)
--
-- A routine is a model an admin configures once; each due weekday it spawns
-- an independent task (own id, code, checklist, history, timer, approval —
-- see tasks.routine_id below). This is a NEW module, deliberately built
-- alongside the unused Phase 5 task_templates/generate_daily_tasks()
-- (0010_scheduled_automation.sql) rather than repurposing it: that table
-- has no per-weekday selection, no separate creation-time, no timezone, no
-- cancel/reactivate trail, and is open to 'gestor' — none of which matches
-- this spec, and nothing in the app has ever called it (grep confirms zero
-- frontend usage), so leaving it alone carries no regression risk.

-- ---------------------------------------------------------------------
-- Per-company timezone — didn't exist before (0010's comment already
-- flagged this gap). Routine scheduling math must run in local wall-clock
-- time, not raw UTC.
-- ---------------------------------------------------------------------

alter table companies add column timezone text not null default 'America/Sao_Paulo';

-- ---------------------------------------------------------------------
-- is_admin() — deliberately stricter than is_privileged() (which also
-- allows diretoria/auditoria). The spec is explicit: only role='admin'
-- may manage routines.
-- ---------------------------------------------------------------------

create function is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select role = 'admin' from profiles where id = auth.uid() and session_is_valid()), false);
$$;

-- ---------------------------------------------------------------------
-- routines
-- ---------------------------------------------------------------------

create table routines (
  id uuid primary key default gen_random_uuid(),
  code text unique,                                   -- e.g. ROT-000014, assigned on insert
  company_id uuid not null references companies (id),
  area text not null,
  name text not null,
  description text not null default '',
  process_id uuid references processes (id),
  responsible_id uuid not null references profiles (id),
  participant_ids uuid[] not null default '{}',
  priority text not null default 'Normal',
  risk text not null default 'Baixo',
  tags text[] not null default '{}',
  evidence_required boolean not null default false,
  checklist_template text[] not null default '{}',

  week_days text[] not null default '{}'
    constraint routines_week_days_valid check (week_days <@ array['MON','TUE','WED','THU','FRI','SAT','SUN']::text[]),
  creation_time time not null default '08:00',
  deadline_time time not null default '18:00',
  timezone text not null default 'America/Sao_Paulo',

  status text not null default 'ACTIVE'
    constraint routines_status_valid check (status in ('ACTIVE', 'PAUSED', 'CANCELLED')),
  start_date date not null default current_date,
  end_mode text not null default 'UNTIL_CANCELLED'
    constraint routines_end_mode_valid check (end_mode = 'UNTIL_CANCELLED'),

  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),
  updated_by uuid references profiles (id),
  updated_at timestamptz not null default now(),
  cancelled_by uuid references profiles (id),
  cancelled_at timestamptz,
  cancel_reason text not null default '',

  last_generated_at timestamptz,
  last_occurrence_date date,
  last_generated_task_id uuid references tasks (id),
  next_occurrence_at timestamptz,

  version bigint not null default 1
);

create index routines_company_idx on routines (company_id);
create index routines_status_idx on routines (status) where status = 'ACTIVE';

create sequence routine_code_seq;

create function assign_routine_code()
returns trigger
language plpgsql
as $$
begin
  if new.code is null then
    new.code := 'ROT-' || lpad(nextval('routine_code_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;

create trigger routines_assign_code
  before insert on routines
  for each row execute function assign_routine_code();

create trigger routines_touch_updated_at
  before update on routines
  for each row execute function touch_updated_at();

create table routine_history (
  id bigint generated always as identity primary key,
  routine_id uuid not null references routines (id) on delete cascade,
  at timestamptz not null default now(),
  user_id uuid references profiles (id),
  action text not null,
  details jsonb not null default '{}'::jsonb
);

create index routine_history_routine_idx on routine_history (routine_id, at desc);

alter table routines enable row level security;
alter table routine_history enable row level security;

-- Read-only module, admin-only, matching the spec's "acesso administrativo"
-- for the whole Rotinas Periódicas screen. All writes go through the
-- SECURITY DEFINER functions below, which re-check is_admin() themselves —
-- this SELECT policy is not the only guard, same belt-and-suspenders
-- posture as tasks (0003/0006).
create policy routines_select on routines for select
  using (company_id = current_company() and is_admin());

create policy routine_history_select on routine_history for select
  using (exists (select 1 from routines r where r.id = routine_history.routine_id and r.company_id = current_company()) and is_admin());

-- ---------------------------------------------------------------------
-- tasks: link back to the routine occurrence that generated it.
-- routine_occurrence_key's unique index is the real anti-duplicity
-- guarantee (section 19) — enforced by Postgres itself, not just app
-- logic, so it holds even under concurrent cron runs / retries.
-- ---------------------------------------------------------------------

alter table tasks add column routine_id uuid references routines (id);
alter table tasks add column routine_occurrence_key text;
create unique index tasks_routine_occurrence_key_idx on tasks (routine_occurrence_key) where routine_occurrence_key is not null;

-- ---------------------------------------------------------------------
-- compute_next_occurrence — pure function, used both for display (right
-- after create/update/reactivate, so the admin sees a correct "próxima
-- execução" without waiting for the next cron tick) and by the generator
-- itself. Walks forward day-by-day (in the routine's own timezone) up to
-- a week, returns the first instant that's on an allowed weekday and
-- strictly after p_after.
-- ---------------------------------------------------------------------

create function compute_next_occurrence(
  p_week_days text[],
  p_creation_time time,
  p_timezone text,
  p_after timestamptz default now()
)
returns timestamptz
language plpgsql
stable
as $$
declare
  v_dow_names text[] := array['MON','TUE','WED','THU','FRI','SAT','SUN'];
  v_local_date date;
  v_day date;
  v_dow text;
  v_candidate timestamptz;
  i integer;
begin
  if p_week_days is null or array_length(p_week_days, 1) is null then
    return null;
  end if;

  v_local_date := (p_after at time zone p_timezone)::date;

  for i in 0..7 loop
    v_day := v_local_date + i;
    v_dow := v_dow_names[extract(isodow from v_day)::int];
    if v_dow = any(p_week_days) then
      v_candidate := (v_day + p_creation_time) at time zone p_timezone;
      if v_candidate > p_after then
        return v_candidate;
      end if;
    end if;
  end loop;

  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Client-facing mutation RPCs — every one re-checks is_admin() itself
-- (never trust the SELECT policy alone), and fails with the exact message
-- the spec requires, so the frontend can surface it verbatim.
-- ---------------------------------------------------------------------

create function create_routine(
  p_name text,
  p_area text,
  p_responsible_id uuid,
  p_week_days text[],
  p_description text default '',
  p_process_id uuid default null,
  p_participant_ids uuid[] default '{}',
  p_priority text default 'Normal',
  p_risk text default 'Baixo',
  p_tags text[] default '{}',
  p_evidence_required boolean default false,
  p_checklist_template text[] default '{}',
  p_creation_time time default '08:00',
  p_deadline_time time default '18:00',
  p_timezone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := current_company();
  v_tz text;
  v_routine routines;
begin
  if not is_admin() then
    raise exception 'SGO_FORBIDDEN: Acesso restrito. Somente administradores podem gerenciar rotinas periódicas.';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'SGO_NAME_REQUIRED: informe um nome para a rotina';
  end if;
  if p_week_days is null or array_length(p_week_days, 1) is null then
    raise exception 'SGO_WEEKDAYS_REQUIRED: selecione ao menos um dia da semana';
  end if;

  select coalesce(p_timezone, c.timezone) into v_tz from companies c where c.id = v_company;

  insert into routines (
    company_id, area, name, description, process_id, responsible_id, participant_ids,
    priority, risk, tags, evidence_required, checklist_template,
    week_days, creation_time, deadline_time, timezone, created_by
  ) values (
    v_company, p_area, p_name, p_description, p_process_id, p_responsible_id, p_participant_ids,
    p_priority, p_risk, p_tags, p_evidence_required, p_checklist_template,
    p_week_days, p_creation_time, p_deadline_time, v_tz, auth.uid()
  ) returning * into v_routine;

  update routines
    set next_occurrence_at = compute_next_occurrence(p_week_days, p_creation_time, v_tz, now())
    where id = v_routine.id
    returning * into v_routine;

  insert into routine_history (routine_id, user_id, action, details)
    values (v_routine.id, auth.uid(), 'CREATED', jsonb_build_object('name', p_name));

  return to_jsonb(v_routine);
end;
$$;

create function update_routine(
  p_routine_id uuid,
  p_name text,
  p_area text,
  p_responsible_id uuid,
  p_week_days text[],
  p_description text default '',
  p_process_id uuid default null,
  p_participant_ids uuid[] default '{}',
  p_priority text default 'Normal',
  p_risk text default 'Baixo',
  p_tags text[] default '{}',
  p_evidence_required boolean default false,
  p_creation_time time default '08:00',
  p_deadline_time time default '18:00'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_routine routines;
begin
  if not is_admin() then
    raise exception 'SGO_FORBIDDEN: Acesso restrito. Somente administradores podem gerenciar rotinas periódicas.';
  end if;
  select * into v_routine from routines where id = p_routine_id and company_id = current_company();
  if not found then
    raise exception 'SGO_NOT_FOUND: routine % does not exist', p_routine_id;
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'SGO_NAME_REQUIRED: informe um nome para a rotina';
  end if;
  if p_week_days is null or array_length(p_week_days, 1) is null then
    raise exception 'SGO_WEEKDAYS_REQUIRED: selecione ao menos um dia da semana';
  end if;

  update routines set
    name = p_name,
    area = p_area,
    responsible_id = p_responsible_id,
    week_days = p_week_days,
    description = p_description,
    process_id = p_process_id,
    participant_ids = p_participant_ids,
    priority = p_priority,
    risk = p_risk,
    tags = p_tags,
    evidence_required = p_evidence_required,
    creation_time = p_creation_time,
    deadline_time = p_deadline_time,
    updated_by = auth.uid(),
    version = v_routine.version + 1,
    next_occurrence_at = case when v_routine.status = 'ACTIVE'
      then compute_next_occurrence(p_week_days, p_creation_time, v_routine.timezone, now())
      else null end
    where id = p_routine_id
    returning * into v_routine;

  insert into routine_history (routine_id, user_id, action, details)
    values (p_routine_id, auth.uid(), 'UPDATED', to_jsonb(v_routine));

  return to_jsonb(v_routine);
end;
$$;

create function update_routine_checklist(p_routine_id uuid, p_items text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_routine routines;
begin
  if not is_admin() then
    raise exception 'SGO_FORBIDDEN: Acesso restrito. Somente administradores podem gerenciar rotinas periódicas.';
  end if;
  if not exists (select 1 from routines where id = p_routine_id and company_id = current_company()) then
    raise exception 'SGO_NOT_FOUND: routine % does not exist', p_routine_id;
  end if;

  update routines set checklist_template = coalesce(p_items, '{}'), updated_by = auth.uid()
    where id = p_routine_id
    returning * into v_routine;

  -- Checklist copies happen only at generation time (see
  -- generate_periodic_routine_tasks() below), so this alone satisfies
  -- section 15: already-created tasks keep whatever checklist they were
  -- given; only future occurrences see this edit.
  insert into routine_history (routine_id, user_id, action, details)
    values (p_routine_id, auth.uid(), 'CHECKLIST_UPDATED', jsonb_build_object('items', p_items));

  return to_jsonb(v_routine);
end;
$$;

create function cancel_routine(p_routine_id uuid, p_reason text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_routine routines;
begin
  if not is_admin() then
    raise exception 'SGO_FORBIDDEN: Acesso restrito. Somente administradores podem gerenciar rotinas periódicas.';
  end if;
  if not exists (select 1 from routines where id = p_routine_id and company_id = current_company()) then
    raise exception 'SGO_NOT_FOUND: routine % does not exist', p_routine_id;
  end if;

  -- Cancelling only stops future generation (next_occurrence_at cleared);
  -- tasks already created by this routine are untouched — no cascade, no
  -- cancel_task() call on them (section 11/32).
  update routines set status = 'CANCELLED', cancelled_by = auth.uid(), cancelled_at = now(),
    cancel_reason = coalesce(p_reason, ''), next_occurrence_at = null
    where id = p_routine_id
    returning * into v_routine;

  insert into routine_history (routine_id, user_id, action, details)
    values (p_routine_id, auth.uid(), 'CANCELLED', jsonb_build_object('reason', p_reason));

  return to_jsonb(v_routine);
end;
$$;

create function reactivate_routine(p_routine_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_routine routines;
begin
  if not is_admin() then
    raise exception 'SGO_FORBIDDEN: Acesso restrito. Somente administradores podem gerenciar rotinas periódicas.';
  end if;
  select * into v_routine from routines where id = p_routine_id and company_id = current_company();
  if not found then
    raise exception 'SGO_NOT_FOUND: routine % does not exist', p_routine_id;
  end if;
  if v_routine.status <> 'CANCELLED' then
    raise exception 'SGO_INVALID_STATE: only a cancelled routine can be reactivated (current status: %)', v_routine.status;
  end if;

  -- next_occurrence_at is computed from now(), never retroactively — days
  -- the routine spent cancelled never get a make-up occurrence
  -- (section 32).
  update routines set status = 'ACTIVE', cancelled_by = null, cancelled_at = null, cancel_reason = '',
    next_occurrence_at = compute_next_occurrence(week_days, creation_time, timezone, now())
    where id = p_routine_id
    returning * into v_routine;

  insert into routine_history (routine_id, user_id, action, details)
    values (p_routine_id, auth.uid(), 'REACTIVATED', '{}'::jsonb);

  return to_jsonb(v_routine);
end;
$$;

-- ---------------------------------------------------------------------
-- generate_periodic_routine_tasks() — pg_cron-only (no grant below),
-- meant to run every few minutes. Idempotent per (routine, local date) via
-- routine_occurrence_key's unique index; `for update skip locked` on the
-- routines row additionally serializes concurrent runs per-routine, and
-- each routine's body is wrapped so one bad routine can't abort the batch
-- — same shape as generate_daily_tasks() (0010).
-- ---------------------------------------------------------------------

create function generate_periodic_routine_tasks()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dow_names text[] := array['MON','TUE','WED','THU','FRI','SAT','SUN'];
  v_routine routines;
  v_local_date date;
  v_dow text;
  v_creation_instant timestamptz;
  v_deadline_instant timestamptz;
  v_occurrence_key text;
  v_task_id uuid;
  v_checklist_item text;
begin
  for v_routine in
    select * from routines where status = 'ACTIVE' for update skip locked
  loop
    begin
      v_task_id := null;
      v_local_date := (now() at time zone v_routine.timezone)::date;
      v_dow := v_dow_names[extract(isodow from v_local_date)::int];

      if not (v_dow = any(v_routine.week_days)) then
        continue;
      end if;

      v_creation_instant := (v_local_date + v_routine.creation_time) at time zone v_routine.timezone;
      if now() < v_creation_instant then
        continue;
      end if;

      v_occurrence_key := v_routine.code || '_' || to_char(v_local_date, 'YYYY-MM-DD');
      if exists (select 1 from tasks where routine_occurrence_key = v_occurrence_key) then
        continue;
      end if;

      v_deadline_instant := (v_local_date + v_routine.deadline_time) at time zone v_routine.timezone;

      insert into tasks (
        company_id, area, process_id, titulo, descricao, tipo,
        solicitante_id, responsavel_id, participantes, prazo, prazo_manual,
        prioridade, risco, tags, routine_id, routine_occurrence_key
      ) values (
        v_routine.company_id, v_routine.area, v_routine.process_id, v_routine.name, v_routine.description, 'Rotina periódica',
        v_routine.created_by, v_routine.responsible_id, v_routine.participant_ids, v_deadline_instant, true,
        v_routine.priority, v_routine.risk, v_routine.tags, v_routine.id, v_occurrence_key
      )
      on conflict (routine_occurrence_key) do nothing
      returning id into v_task_id;

      if v_task_id is null then
        -- Lost a race to another concurrent run of this same function —
        -- the other run already created (or is creating) today's task.
        continue;
      end if;

      foreach v_checklist_item in array v_routine.checklist_template loop
        insert into task_checklist_items (task_id, texto, position)
          values (v_task_id, v_checklist_item,
            coalesce((select max(position) + 1 from task_checklist_items where task_id = v_task_id), 0));
      end loop;

      insert into task_history (task_id, action, to_status)
        values (v_task_id, 'Tarefa gerada automaticamente pela rotina "' || v_routine.name || '"', 'Em andamento');

      insert into routine_history (routine_id, user_id, action, details)
        values (v_routine.id, null, 'TASK_GENERATED', jsonb_build_object('task_id', v_task_id, 'occurrence_date', v_local_date));

      update routines set
        last_generated_at = now(),
        last_occurrence_date = v_local_date,
        last_generated_task_id = v_task_id,
        next_occurrence_at = compute_next_occurrence(week_days, creation_time, timezone, now())
        where id = v_routine.id;
    exception when others then
      insert into logs (company_id, kind, user_id, action, details)
        values (v_routine.company_id, 'security', v_routine.created_by, 'PERIODIC_ROUTINE_GENERATION_FAILED',
          jsonb_build_object('routine_id', v_routine.id, 'error', sqlerrm));
      insert into routine_history (routine_id, user_id, action, details)
        values (v_routine.id, null, 'GENERATION_FAILED', jsonb_build_object('error', sqlerrm));
    end;
  end loop;
end;
$$;

-- Every 5 minutes: due-but-not-yet-generated occurrences are picked up
-- without needing to fire exactly at creation_time (section 38).
select cron.schedule('sgo-generate-periodic-routines', '*/5 * * * *', $$select generate_periodic_routine_tasks();$$);

-- ---------------------------------------------------------------------
-- Grants — mutation RPCs only. generate_periodic_routine_tasks() is
-- pg_cron-only, same posture as generate_daily_tasks() (0010).
-- ---------------------------------------------------------------------

grant execute on function
  create_routine(text, text, uuid, text[], text, uuid, uuid[], text, text, text[], boolean, text[], time, time, text),
  update_routine(uuid, text, text, uuid, text[], text, uuid, uuid[], text, text, text[], boolean, time, time),
  update_routine_checklist(uuid, text[]),
  cancel_routine(uuid, text),
  reactivate_routine(uuid)
to authenticated;

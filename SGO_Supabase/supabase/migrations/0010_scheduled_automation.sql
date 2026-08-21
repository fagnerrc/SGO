-- SGO on Supabase — Phase 5: recurring task templates + scheduled
-- automation (pg_cron), replacing V12_TimerDaily.gs's
-- generateDailyTasksV1215_ and V10_Communication.gs's
-- generateDeadlineNotificationsV1215_.
--
-- Structural difference from the old system worth calling out: in Apps
-- Script, a trigger handler that throws repeatedly gets silently disabled
-- by the platform, with no in-app signal (bug #C2 in the original review).
-- pg_cron does not do this — a failing job keeps firing on schedule and its
-- failures are visible in `cron.job_run_details`. The per-row exception
-- handlers below (log to `logs` and move on) exist so one bad template or
-- task can't abort the whole run, not to work around a disablement risk
-- that doesn't exist here.

-- ---------------------------------------------------------------------
-- Recurring task templates (did not exist before phase 5 — the old
-- system's "recurring task" concept lived only inside V12_TimerDaily.gs's
-- generation logic, with no dedicated table in this migration plan until
-- now).
-- ---------------------------------------------------------------------

create table task_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  area text not null,
  titulo text not null,
  descricao text not null default '',
  tipo task_type not null default 'Demanda operacional',
  process_id uuid references processes (id),
  responsavel_id uuid not null references profiles (id),
  participantes uuid[] not null default '{}',
  created_by uuid not null references profiles (id),
  estimativa numeric not null default 0,
  prioridade text not null default 'Normal',
  risco text not null default 'Baixo',
  checklist text[] not null default '{}',
  -- Time-of-day (UTC) the generated task's prazo is set to. A per-company
  -- timezone column doesn't exist yet (see PROGRESS.md) — for now every
  -- company's daily generation and deadline math runs on UTC wall-clock
  -- time, which is a known simplification, not a deliberate design choice.
  deadline_time time not null default '18:00',
  active boolean not null default true,
  last_generated_on date,
  created_at timestamptz not null default now()
);

create index task_templates_company_idx on task_templates (company_id);
create index task_templates_active_idx on task_templates (active) where active = true;

alter table task_templates enable row level security;

create policy task_templates_select on task_templates for select
  using (company_id = current_company() and (is_privileged() or current_user_role() = 'gestor'));

create function create_task_template(
  p_area text,
  p_titulo text,
  p_responsavel_id uuid,
  p_deadline_time time default '18:00',
  p_descricao text default '',
  p_tipo text default 'Demanda operacional',
  p_process_id uuid default null,
  p_participantes uuid[] default '{}',
  p_estimativa numeric default 0,
  p_prioridade text default 'Normal',
  p_risco text default 'Baixo',
  p_checklist text[] default '{}'
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_id uuid;
begin
  if not (is_privileged() or current_user_role() = 'gestor') then
    raise exception 'SGO_FORBIDDEN: only a privileged role or gestor may create a recurring task template';
  end if;

  insert into task_templates (
    company_id, area, titulo, descricao, tipo, process_id, responsavel_id, participantes,
    created_by, estimativa, prioridade, risco, checklist, deadline_time
  ) values (
    current_company(), p_area, p_titulo, p_descricao, p_tipo, p_process_id, p_responsavel_id, p_participantes,
    auth.uid(), p_estimativa, p_prioridade, p_risco, p_checklist, p_deadline_time
  ) returning id into v_id;

  return v_id;
end;
$$;

create function set_task_template_active(p_template_id uuid, p_active boolean)
returns void
language plpgsql
security definer
as $$
begin
  if not exists (select 1 from task_templates where id = p_template_id and company_id = current_company()) then
    raise exception 'SGO_NOT_FOUND: template % does not exist', p_template_id;
  end if;
  if not (is_privileged() or current_user_role() = 'gestor') then
    raise exception 'SGO_FORBIDDEN: only a privileged role or gestor may change template status';
  end if;

  update task_templates set active = p_active where id = p_template_id;
end;
$$;

-- ---------------------------------------------------------------------
-- generate_daily_tasks() — meant to be called once a day by pg_cron, not
-- by clients (no grant to authenticated/anon below). Idempotent per
-- template via last_generated_on: firing this twice on the same day is
-- harmless, same guarantee the old system's trigger-duplication-tolerant
-- design already had and that the original review confirmed worked
-- correctly.
-- ---------------------------------------------------------------------

create function generate_daily_tasks()
returns void
language plpgsql
security definer
as $$
declare
  v_template task_templates;
  v_checklist_item text;
  v_task_id uuid;
  v_deadline timestamptz;
begin
  for v_template in
    select * from task_templates
    where active = true and (last_generated_on is null or last_generated_on < current_date)
    for update skip locked
  loop
    begin
      v_deadline := (current_date + v_template.deadline_time) at time zone 'UTC';

      insert into tasks (
        company_id, area, process_id, titulo, descricao, tipo,
        solicitante_id, responsavel_id, participantes, prazo, prazo_manual,
        estimativa, prioridade, risco
      ) values (
        v_template.company_id, v_template.area, v_template.process_id, v_template.titulo, v_template.descricao, v_template.tipo,
        v_template.created_by, v_template.responsavel_id, v_template.participantes, v_deadline, false,
        v_template.estimativa, v_template.prioridade, v_template.risco
      ) returning id into v_task_id;
      -- tasks_notify_assigned (0009) fires off this insert automatically —
      -- the responsavel gets a TASK_ASSIGNED notification with no extra
      -- code needed here.

      foreach v_checklist_item in array v_template.checklist loop
        insert into task_checklist_items (task_id, texto, position)
          values (v_task_id, v_checklist_item,
            coalesce((select max(position) + 1 from task_checklist_items where task_id = v_task_id), 0));
      end loop;

      insert into task_history (task_id, action, to_status)
        values (v_task_id, 'Tarefa gerada automaticamente a partir do modelo "' || v_template.titulo || '"', 'Em andamento');

      update task_templates set last_generated_on = current_date where id = v_template.id;
    exception when others then
      insert into logs (company_id, kind, user_id, action, details)
        values (v_template.company_id, 'security', v_template.created_by, 'DAILY_TASK_GENERATION_FAILED',
          jsonb_build_object('template_id', v_template.id, 'error', sqlerrm));
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- generate_deadline_notifications() — meant to run hourly via pg_cron.
-- Relies entirely on the day-bucketed dedup_key from 0004/0009
-- (source_id is null here, so the key falls back to task_id) to avoid
-- re-notifying the same recipient about the same still-overdue task every
-- time this runs; that dedup is now correctly recipient-scoped from
-- phase 1 onward, which is what the original bug (#2-adjacent, in the old
-- generateDeadlineNotificationsV1215_) was missing.
--
-- prazo is a real `timestamptz` column (not a string parsed client-side),
-- so the old date-only-string-parsed-as-UTC-midnight bug has no equivalent
-- here — Postgres/PostgREST resolve timestamptz values unambiguously
-- regardless of how the client formatted the input date.
-- ---------------------------------------------------------------------

create function generate_deadline_notifications()
returns void
language plpgsql
security definer
as $$
declare
  v_task tasks;
  v_process processes;
begin
  for v_task in
    select * from tasks
    where excluido = false
      and status not in ('Concluída', 'Auditada', 'Cancelada')
      and prazo is not null and prazo < now()
  loop
    begin
      insert into notifications (company_id, recipient_id, type, task_id, title, message)
        values (v_task.company_id, v_task.responsavel_id, 'TASK_OVERDUE', v_task.id,
          'Tarefa atrasada', coalesce(v_task.code, v_task.titulo) || ' está atrasada')
        on conflict (dedup_key) do nothing;
    exception when others then
      insert into logs (company_id, kind, user_id, action, details)
        values (v_task.company_id, 'security', v_task.responsavel_id, 'DEADLINE_NOTIFICATION_FAILED',
          jsonb_build_object('task_id', v_task.id, 'phase', 'overdue', 'error', sqlerrm));
    end;
  end loop;

  for v_task in
    select * from tasks
    where excluido = false
      and status not in ('Concluída', 'Auditada', 'Cancelada')
      and prazo is not null and prazo >= now() and prazo < now() + interval '24 hours'
  loop
    begin
      insert into notifications (company_id, recipient_id, type, task_id, title, message)
        values (v_task.company_id, v_task.responsavel_id, 'TASK_DUE_SOON', v_task.id,
          'Prazo se aproximando', coalesce(v_task.code, v_task.titulo) || ' vence nas próximas 24h')
        on conflict (dedup_key) do nothing;
    exception when others then
      insert into logs (company_id, kind, user_id, action, details)
        values (v_task.company_id, 'security', v_task.responsavel_id, 'DEADLINE_NOTIFICATION_FAILED',
          jsonb_build_object('task_id', v_task.id, 'phase', 'due_soon', 'error', sqlerrm));
    end;
  end loop;

  for v_task in
    select * from tasks
    where excluido = false and status = 'Aguardando aprovação' and approval_status = 'pending'
      and aguardando_desde is not null and aguardando_desde < now() - interval '24 hours'
  loop
    begin
      select * into v_process from processes where id = v_task.process_id;
      if found and v_process.aprovador_id is not null then
        insert into notifications (company_id, recipient_id, type, task_id, title, message)
          values (v_task.company_id, v_process.aprovador_id, 'APPROVAL_PENDING', v_task.id,
            'Aprovação pendente', coalesce(v_task.code, v_task.titulo) || ' aguarda sua aprovação há mais de 24h')
          on conflict (dedup_key) do nothing;
      end if;
    exception when others then
      insert into logs (company_id, kind, user_id, action, details)
        values (v_task.company_id, 'security', v_task.responsavel_id, 'DEADLINE_NOTIFICATION_FAILED',
          jsonb_build_object('task_id', v_task.id, 'phase', 'approval_pending', 'error', sqlerrm));
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- pg_cron schedule. Requires the pg_cron extension enabled on the project
-- (Supabase dashboard -> Database -> Extensions) — see PROGRESS.md open
-- question #1. Both times are UTC; 00:05 for daily generation gives a
-- 5-minute buffer past midnight rather than racing it exactly.
-- ---------------------------------------------------------------------

select cron.schedule('sgo-generate-daily-tasks', '5 0 * * *', $$select generate_daily_tasks();$$);
select cron.schedule('sgo-deadline-notifications', '0 * * * *', $$select generate_deadline_notifications();$$);

-- ---------------------------------------------------------------------
-- Grants. generate_daily_tasks()/generate_deadline_notifications() are
-- deliberately NOT granted to authenticated/anon — they're pg_cron-only
-- (pg_cron jobs run as the role that called cron.schedule, i.e. whichever
-- role applies these migrations). A client asking for either job to run
-- on demand is out of scope; the template management functions are the
-- client-facing surface.
-- ---------------------------------------------------------------------

grant execute on function
  create_task_template(text, text, uuid, time, text, text, uuid, uuid[], numeric, text, text, text[]),
  set_task_template_active(uuid, boolean)
to authenticated;

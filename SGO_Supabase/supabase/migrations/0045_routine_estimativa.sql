-- SGO on Supabase — routines need an effort estimate too (estimativa, in
-- hours), same field every manually-created task already has, so a
-- routine-generated task carries it just like a normal one (0044 already
-- made these tasks otherwise indistinguishable from a hand-created Tarefa
-- Agendada — estimativa was the one field still missing).
--
-- create_routine/update_routine both get a new p_estimativa parameter.
-- Learned the hard way on create_task (0035/0038/0039): `create or
-- replace function` with a DIFFERENT parameter list does NOT replace the
-- old function, it creates a second overload — breaking every call that
-- omits the new parameter and, worse, silently skipping the anon/public
-- EXECUTE revoke the old signature had. So this time: explicit DROP of
-- the exact old signatures first, then CREATE, then an explicit REVOKE
-- on the new signatures — no CREATE OR REPLACE shortcut.

alter table routines add column estimativa numeric not null default 0;

drop function create_routine(text, text, uuid, text[], text, uuid, uuid[], text, text, text[], boolean, text[], time, time, text);
drop function update_routine(uuid, text, text, uuid, text[], text, uuid, uuid[], text, text, text[], boolean, time, time);

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
  p_creation_time time default '08:00:00',
  p_deadline_time time default '18:00:00',
  p_timezone text default null,
  p_estimativa numeric default 0
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
    week_days, creation_time, deadline_time, timezone, created_by, estimativa
  ) values (
    v_company, p_area, p_name, p_description, p_process_id, p_responsible_id, p_participant_ids,
    p_priority, p_risk, p_tags, p_evidence_required, p_checklist_template,
    p_week_days, p_creation_time, p_deadline_time, v_tz, auth.uid(), p_estimativa
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
  p_creation_time time default '08:00:00',
  p_deadline_time time default '18:00:00',
  p_estimativa numeric default 0
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
    estimativa = p_estimativa,
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

revoke execute on function create_routine(text, text, uuid, text[], text, uuid, uuid[], text, text, text[], boolean, text[], time, time, text, numeric) from anon, public;
revoke execute on function update_routine(uuid, text, text, uuid, text[], text, uuid, uuid[], text, text, text[], boolean, time, time, numeric) from anon, public;

-- generate_periodic_routine_tasks() now carries the routine's estimativa
-- onto each generated task (previously omitted from the insert entirely,
-- so every routine-born task defaulted to 0 regardless of the routine).
create or replace function generate_periodic_routine_tasks()
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
        solicitante_id, responsavel_id, participantes, prazo, prazo_manual, data_inicio,
        prioridade, risco, tags, estimativa, routine_id, routine_occurrence_key
      ) values (
        v_routine.company_id, v_routine.area, v_routine.process_id, v_routine.name, v_routine.description, 'Tarefa agendada',
        v_routine.created_by, v_routine.responsible_id, v_routine.participant_ids, v_deadline_instant, true, v_creation_instant,
        v_routine.priority, v_routine.risk, v_routine.tags, v_routine.estimativa, v_routine.id, v_occurrence_key
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

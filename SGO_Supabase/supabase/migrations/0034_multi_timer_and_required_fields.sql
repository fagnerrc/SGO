-- SGO on Supabase — "one running Cronômetro at a time, but any number
-- open" (confirmed with the user against the old system's actual
-- behavior: multiple Tarefa cronometrada can be open/paused
-- simultaneously, but starting/resuming one auto-pauses whichever other
-- one was running — the old system just refused/blocked instead of
-- auto-pausing, which is what made "iniciar uma nova tarefa não deve...
-- bloquear outra tarefa que já esteja aberta" true here but not there).
--
-- Also: título and descrição become required on every task, not just
-- título (the old system never required descrição either — this is a
-- deliberate tightening per the new spec, not a port).

-- ---------------------------------------------------------------------
-- pause_other_running_timers(): scoped to Tarefa cronometrada only —
-- Tarefa agendada tasks can also technically end up with
-- timer_state='running' (start_task doesn't distinguish tipo), but they
-- have no timer UI at all (taskDetail.ts only renders the timer panel
-- for isTimed tasks), so that state is inert for them. Scoping this to
-- cronometrada keeps the two task kinds' timers from ever interfering
-- with each other.
-- ---------------------------------------------------------------------

create function pause_other_running_timers(p_responsavel_id uuid, p_except_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_other tasks;
  v_open task_timer_sessions;
  v_duration bigint;
begin
  for v_other in
    select * from tasks
    where responsavel_id = p_responsavel_id
      and id <> p_except_task_id
      and tipo = 'Tarefa cronometrada'
      and timer_state = 'running'
      and excluido = false
    for update
  loop
    select * into v_open from task_timer_sessions
      where task_id = v_other.id and ended_at is null
      order by started_at desc limit 1;
    v_duration := 0;
    if found then
      v_duration := extract(epoch from (now() - v_open.started_at)) * 1000;
      update task_timer_sessions
        set ended_at = now(), duration_ms = v_duration, outcome = 'paused'
        where id = v_open.id;
    end if;

    update tasks
      set timer_state = 'paused',
          timer_active_started_at = null,
          timer_total_ms = timer_total_ms + v_duration,
          record_version = record_version + 1
      where id = v_other.id;

    insert into task_history (task_id, user_id, action, to_status)
      values (v_other.id, auth.uid(), 'Cronômetro pausado automaticamente (outra tarefa iniciada)', v_other.status);
  end loop;
end;
$$;

revoke execute on function pause_other_running_timers(uuid, uuid) from public, anon, authenticated;

create or replace function start_task(p_task_id uuid, p_operation_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_result jsonb;
begin
  v_existing := claim_operation(p_operation_id, 'start');
  if v_existing is not null then
    return v_existing;
  end if;

  v_task := lock_task(p_task_id);
  perform pause_other_running_timers(v_task.responsavel_id, p_task_id);

  perform set_config('sgo.action', 'start', true);
  update tasks
    set status = 'Em andamento',
        timer_state = 'running',
        timer_active_started_at = now(),
        timer_started_at = coalesce(timer_started_at, now()),
        progresso = greatest(progresso, 1),
        record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_timer_sessions (task_id, started_at) values (p_task_id, now());
  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Tarefa iniciada', v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

create or replace function resume_task(p_task_id uuid, p_operation_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_result jsonb;
begin
  v_existing := claim_operation(p_operation_id, 'resume');
  if v_existing is not null then
    return v_existing;
  end if;

  v_task := lock_task(p_task_id);
  perform pause_other_running_timers(v_task.responsavel_id, p_task_id);

  perform set_config('sgo.action', 'resume', true);
  update tasks
    set status = 'Em andamento',
        timer_state = 'running',
        timer_active_started_at = now(),
        record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_timer_sessions (task_id, started_at) values (p_task_id, now());
  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Tarefa retomada', v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

-- ---------------------------------------------------------------------
-- create_task(): título and descrição both required now. Enforced here
-- (not just the client's `required` attribute) for the same reason
-- every other business rule in this schema is server-side — a client
-- check is UX, not a guarantee.
-- ---------------------------------------------------------------------

create or replace function create_task(
  p_operation_id text,
  p_titulo text,
  p_area text,
  p_responsavel_id uuid,
  p_descricao text default '',
  p_tipo text default 'Demanda operacional',
  p_process_id uuid default null,
  p_participantes uuid[] default '{}',
  p_prazo timestamptz default null,
  p_estimativa numeric default 0,
  p_prioridade text default 'Normal',
  p_risco text default 'Baixo',
  p_checklist text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_company uuid := current_company();
  v_item text;
  v_result jsonb;
begin
  v_existing := claim_operation(p_operation_id, 'create');
  if v_existing is not null then
    return v_existing;
  end if;

  if coalesce(trim(p_titulo), '') = '' then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_TITLE_REQUIRED: informe um título para a tarefa';
  end if;
  if coalesce(trim(p_descricao), '') = '' then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_DESCRIPTION_REQUIRED: informe uma descrição para a tarefa';
  end if;

  if not (is_privileged() or current_user_role() = 'gestor' or auth.uid() = p_responsavel_id) then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_FORBIDDEN: caller is not allowed to create a task in area %', p_area;
  end if;

  if p_process_id is not null then
    if not exists (select 1 from processes pr where pr.id = p_process_id and pr.company_id = v_company) then
      perform fail_operation(p_operation_id);
      raise exception 'SGO_INVALID_PROCESS: process does not belong to the caller''s company';
    end if;
    if exists (
      select 1 from processes pr
      where pr.id = p_process_id and pr.segregacao
        and p_responsavel_id in (pr.conferente_id, pr.aprovador_id)
    ) then
      perform fail_operation(p_operation_id);
      raise exception 'SGO_SEGREGATION_VIOLATION: responsavel cannot be the conferente/aprovador of this process';
    end if;
  end if;

  insert into tasks (
    company_id, area, process_id, titulo, descricao, tipo,
    solicitante_id, responsavel_id, participantes, prazo, prazo_manual,
    estimativa, prioridade, risco
  ) values (
    v_company, p_area, p_process_id, p_titulo, p_descricao, p_tipo,
    auth.uid(), p_responsavel_id, p_participantes, p_prazo, p_prazo is not null,
    p_estimativa, p_prioridade, p_risco
  ) returning * into v_task;

  foreach v_item in array p_checklist loop
    insert into task_checklist_items (task_id, texto, position)
      values (v_task.id, v_item, coalesce((select max(position) + 1 from task_checklist_items where task_id = v_task.id), 0));
  end loop;

  insert into task_history (task_id, user_id, action, from_status, to_status, operation_id)
    values (v_task.id, auth.uid(), 'Tarefa criada', null, v_task.status, p_operation_id);

  v_result := task_summary(v_task) || jsonb_build_object('created', true);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

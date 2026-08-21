-- SGO on Supabase — task mutation functions (Phase 2)
-- Replaces: mutateTaskServer / completeTaskServer / updateTaskServer and the
-- timer action handlers in V12_TaskOperations.gs.
--
-- Every function here is SECURITY DEFINER and is the ONLY way a client can
-- change a row in `tasks` — see 0006_rls_policies.sql, which grants no
-- direct insert/update/delete on `tasks` to `authenticated`. Each function
-- calls set_config('sgo.action', <action>, true) right before its UPDATE so
-- the enforce_task_transition() trigger (0003_tasks.sql) can verify the
-- transition is the one this specific function is meant to perform.
--
-- Idempotency: claim_operation()/complete_operation()/fail_operation() wrap
-- the `operations` ledger (0005_audit_and_ops.sql). This replaces the old
-- appendChangeOnceV12_ full-column text-search scan with a unique-index
-- lookup, and replaces taskSemanticNoopV1218_'s ad-hoc status comparisons
-- with a straightforward "have we already completed this operation_id"
-- check that works the same for every action.

-- ---------------------------------------------------------------------
-- Idempotency helpers
-- ---------------------------------------------------------------------

create function claim_operation(p_operation_id text, p_action text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_op operations;
begin
  select * into v_op from operations where operation_id = p_operation_id for update;
  if found then
    if v_op.status = 'COMPLETED' then
      return v_op.result;
    elsif v_op.status = 'PROCESSING' then
      raise exception 'SGO_OPERATION_IN_PROGRESS: operation % is already being processed', p_operation_id;
    else -- FAILED: allow a retry to reclaim it
      update operations
        set status = 'PROCESSING', action = p_action, created_at = now(), completed_at = null, result = null
        where operation_id = p_operation_id;
      return null;
    end if;
  else
    insert into operations (operation_id, profile_id, action, status)
      values (p_operation_id, auth.uid(), p_action, 'PROCESSING');
    return null;
  end if;
end;
$$;

create function complete_operation(p_operation_id text, p_result jsonb)
returns void
language sql
security definer
as $$
  update operations set status = 'COMPLETED', result = p_result, completed_at = now()
  where operation_id = p_operation_id;
$$;

create function fail_operation(p_operation_id text)
returns void
language sql
security definer
as $$
  update operations set status = 'FAILED', completed_at = now()
  where operation_id = p_operation_id;
$$;

-- ---------------------------------------------------------------------
-- Shared authorization + summary helpers
-- ---------------------------------------------------------------------

-- Baseline "may touch this task at all" check. Individual actions (approve/
-- reject, cancel) narrow this further below.
create function can_mutate_task(t tasks)
returns boolean
language sql
security definer
stable
as $$
  select t.company_id = current_company()
    and (
      t.responsavel_id = auth.uid()
      or t.solicitante_id = auth.uid()
      or auth.uid() = any (t.participantes)
      or is_privileged()
      or (current_user_role() = 'gestor' and t.area = (select area from profiles where id = auth.uid()))
    );
$$;

create function task_summary(t tasks)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', t.id, 'code', t.code, 'status', t.status, 'progresso', t.progresso,
    'timer_state', t.timer_state, 'timer_total_ms', t.timer_total_ms,
    'approval_status', t.approval_status, 'record_version', t.record_version,
    'updated_at', t.updated_at, 'concluido_em', t.concluido_em
  );
$$;

create function lock_task(p_task_id uuid)
returns tasks
language plpgsql
security definer
as $$
declare
  v_task tasks;
begin
  select * into v_task from tasks where id = p_task_id for update;
  if not found then
    raise exception 'SGO_NOT_FOUND: task % does not exist', p_task_id;
  end if;
  if not can_mutate_task(v_task) then
    raise exception 'SGO_FORBIDDEN: caller may not act on task %', p_task_id;
  end if;
  return v_task;
end;
$$;

-- Locks the row and checks only company membership, not the general
-- can_mutate_task() baseline — used by approve_task/reject_task, where the
-- designated aprovador_id on the linked process is very often someone
-- outside the task's own area/participants (e.g. a director approving a
-- request from a different department). Those functions apply their own,
-- narrower "must be the aprovador or privileged" check right after.
create function lock_task_for_approval(p_task_id uuid)
returns tasks
language plpgsql
security definer
as $$
declare
  v_task tasks;
begin
  select * into v_task from tasks where id = p_task_id for update;
  if not found then
    raise exception 'SGO_NOT_FOUND: task % does not exist', p_task_id;
  end if;
  if v_task.company_id <> current_company() then
    raise exception 'SGO_FORBIDDEN: caller may not act on task %', p_task_id;
  end if;
  return v_task;
end;
$$;

-- ---------------------------------------------------------------------
-- create_task
-- ---------------------------------------------------------------------

create function create_task(
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

-- ---------------------------------------------------------------------
-- Timer actions: start / pause / resume
-- ---------------------------------------------------------------------

create function start_task(p_task_id uuid, p_operation_id text)
returns jsonb
language plpgsql
security definer
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

create function pause_task(p_task_id uuid, p_operation_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_open task_timer_sessions;
  v_duration bigint := 0;
  v_result jsonb;
begin
  v_existing := claim_operation(p_operation_id, 'pause');
  if v_existing is not null then
    return v_existing;
  end if;

  v_task := lock_task(p_task_id);

  select * into v_open from task_timer_sessions
    where task_id = p_task_id and ended_at is null
    order by started_at desc limit 1;
  if found then
    v_duration := extract(epoch from (now() - v_open.started_at)) * 1000;
    update task_timer_sessions
      set ended_at = now(), duration_ms = v_duration, outcome = 'paused'
      where id = v_open.id;
  end if;

  perform set_config('sgo.action', 'pause', true);
  update tasks
    set timer_state = 'paused',
        timer_active_started_at = null,
        timer_total_ms = timer_total_ms + v_duration,
        record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Cronômetro pausado', v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

create function resume_task(p_task_id uuid, p_operation_id text)
returns jsonb
language plpgsql
security definer
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
-- wait_task / approval_wait_task
-- ---------------------------------------------------------------------

create function wait_task(p_task_id uuid, p_operation_id text, p_aguardando_quem text, p_motivo_espera text default '')
returns jsonb
language plpgsql
security definer
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_open task_timer_sessions;
  v_duration bigint := 0;
  v_result jsonb;
begin
  v_existing := claim_operation(p_operation_id, 'wait');
  if v_existing is not null then
    return v_existing;
  end if;

  if coalesce(trim(p_aguardando_quem), '') = '' then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_WAITING_PERSON_REQUIRED: informe quem esta sendo aguardado';
  end if;

  v_task := lock_task(p_task_id);

  select * into v_open from task_timer_sessions where task_id = p_task_id and ended_at is null order by started_at desc limit 1;
  if found then
    v_duration := extract(epoch from (now() - v_open.started_at)) * 1000;
    update task_timer_sessions set ended_at = now(), duration_ms = v_duration, outcome = 'waiting' where id = v_open.id;
  end if;

  perform set_config('sgo.action', 'wait', true);
  update tasks
    set status = 'Aguardando terceiro',
        timer_state = 'waiting',
        timer_active_started_at = null,
        timer_total_ms = timer_total_ms + v_duration,
        aguardando_quem = p_aguardando_quem,
        aguardando_desde = coalesce(aguardando_desde, now()),
        motivo_espera = p_motivo_espera,
        record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Tarefa colocada em espera', v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

create function approval_wait_task(p_task_id uuid, p_operation_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_open task_timer_sessions;
  v_duration bigint := 0;
  v_result jsonb;
begin
  v_existing := claim_operation(p_operation_id, 'approval_wait');
  if v_existing is not null then
    return v_existing;
  end if;

  v_task := lock_task(p_task_id);

  select * into v_open from task_timer_sessions where task_id = p_task_id and ended_at is null order by started_at desc limit 1;
  if found then
    v_duration := extract(epoch from (now() - v_open.started_at)) * 1000;
    update task_timer_sessions set ended_at = now(), duration_ms = v_duration, outcome = 'approval' where id = v_open.id;
  end if;

  perform set_config('sgo.action', 'approval_wait', true);
  update tasks
    set status = 'Aguardando aprovação',
        timer_state = 'approval',
        timer_active_started_at = null,
        timer_total_ms = timer_total_ms + v_duration,
        aguardando_desde = coalesce(aguardando_desde, now()),
        approval_status = 'pending',
        record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Tarefa enviada para aprovação', v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

-- ---------------------------------------------------------------------
-- complete_task
-- ---------------------------------------------------------------------

create function complete_task(
  p_task_id uuid,
  p_operation_id text,
  p_evidencia text,
  p_justificativa_atraso text default ''
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_process processes;
  v_open task_timer_sessions;
  v_duration bigint := 0;
  v_pending_items integer;
  v_is_late boolean;
  v_result jsonb;
begin
  v_existing := claim_operation(p_operation_id, 'complete');
  if v_existing is not null then
    return v_existing;
  end if;

  if coalesce(trim(p_evidencia), '') = '' then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_EVIDENCE_REQUIRED: informe a evidencia de execucao';
  end if;

  v_task := lock_task(p_task_id);

  select count(*) into v_pending_items from task_checklist_items
    where task_id = p_task_id and feito = false;
  if v_pending_items > 0 then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_CHECKLIST_INCOMPLETE: conclua todos os itens do checklist';
  end if;

  if v_task.process_id is not null then
    select * into v_process from processes where id = v_task.process_id;
    if v_process.aprovador_id is not null and v_task.approval_status <> 'approved' then
      perform fail_operation(p_operation_id);
      raise exception 'SGO_APPROVAL_REQUIRED: a tarefa precisa ser aprovada antes da conclusao';
    end if;
  end if;

  -- Late-completion justification, mirroring the old
  -- "timed quick task without a manually-set deadline is exempt" rule
  -- (V12_TaskOperations.gs taskHasManualDeadlineV1214_/isTimedQuickTask).
  v_is_late := v_task.prazo is not null
    and v_task.prazo < now()
    and not (v_task.tipo = 'Tarefa cronometrada' and not v_task.prazo_manual);
  if v_is_late and coalesce(trim(p_justificativa_atraso), '') = '' then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_DELAY_REASON_REQUIRED: informe a justificativa de atraso';
  end if;

  select * into v_open from task_timer_sessions where task_id = p_task_id and ended_at is null order by started_at desc limit 1;
  if found then
    v_duration := extract(epoch from (now() - v_open.started_at)) * 1000;
    update task_timer_sessions set ended_at = now(), duration_ms = v_duration, outcome = 'completed' where id = v_open.id;
  end if;

  perform set_config('sgo.action', 'complete', true);
  update tasks
    set status = 'Concluída',
        progresso = 100,
        evidencia = p_evidencia,
        justificativa_atraso = coalesce(p_justificativa_atraso, ''),
        timer_state = 'completed',
        timer_active_started_at = null,
        timer_total_ms = timer_total_ms + v_duration,
        concluido_em = now(),
        record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Tarefa concluída', v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

-- ---------------------------------------------------------------------
-- cancel_task — fixes bug #4: the old system let a generic update reach
-- 'Cancelada' with zero checks. This is now the only path there, and it
-- requires a reason.
-- ---------------------------------------------------------------------

create function cancel_task(p_task_id uuid, p_operation_id text, p_motivo text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_result jsonb;
begin
  v_existing := claim_operation(p_operation_id, 'cancel');
  if v_existing is not null then
    return v_existing;
  end if;

  if coalesce(trim(p_motivo), '') = '' then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_CANCEL_REASON_REQUIRED: informe o motivo do cancelamento';
  end if;

  v_task := lock_task(p_task_id);
  if not (is_privileged() or v_task.solicitante_id = auth.uid()
      or (current_user_role() = 'gestor' and v_task.area = (select area from profiles where id = auth.uid()))) then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_FORBIDDEN: only the requester, an area manager, or a privileged role may cancel this task';
  end if;

  perform set_config('sgo.action', 'cancel', true);
  update tasks
    set status = 'Cancelada',
        timer_state = 'completed',
        timer_active_started_at = null,
        record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Tarefa cancelada: ' || p_motivo, v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

-- ---------------------------------------------------------------------
-- approve_task / reject_task — only the process's designated aprovador or
-- a privileged role. reject_task is the ONLY sanctioned path to
-- 'Reprovada/devolvida' (old bug #4/#6: a generic update could set that
-- status directly, bypassing this check entirely).
-- ---------------------------------------------------------------------

create function approve_task(p_task_id uuid, p_operation_id text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_process processes;
  v_result jsonb;
begin
  v_existing := claim_operation(p_operation_id, 'approve');
  if v_existing is not null then
    return v_existing;
  end if;

  v_task := lock_task_for_approval(p_task_id);
  if v_task.process_id is null then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_NO_APPROVAL_NEEDED: task has no linked process/approver';
  end if;
  select * into v_process from processes where id = v_task.process_id;
  if not (is_privileged() or v_process.aprovador_id = auth.uid()) then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_FORBIDDEN: only the designated approver may approve this task';
  end if;

  update tasks
    set approval_status = 'approved',
        approved_by = auth.uid(),
        approved_at = now(),
        record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Tarefa aprovada', v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

create function reject_task(p_task_id uuid, p_operation_id text, p_motivo text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_process processes;
  v_result jsonb;
begin
  v_existing := claim_operation(p_operation_id, 'reject');
  if v_existing is not null then
    return v_existing;
  end if;

  if coalesce(trim(p_motivo), '') = '' then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_REJECT_REASON_REQUIRED: informe o motivo da devolucao';
  end if;

  v_task := lock_task_for_approval(p_task_id);
  if v_task.process_id is null then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_NO_APPROVAL_NEEDED: task has no linked process/approver';
  end if;
  select * into v_process from processes where id = v_task.process_id;
  if not (is_privileged() or v_process.aprovador_id = auth.uid()) then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_FORBIDDEN: only the designated approver may reject this task';
  end if;

  perform set_config('sgo.action', 'reject', true);
  update tasks
    set status = 'Reprovada/devolvida',
        approval_status = 'pending',
        approved_by = null,
        approved_at = null,
        record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Tarefa reprovada: ' || p_motivo, v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

-- ---------------------------------------------------------------------
-- update_task — non-status-changing edits only. Explicitly rejects any
-- attempt to touch a status/approval/timer/ownership field through the
-- generic path (old bug #4: the old system's mergeTaskPayloadV127_ let a
-- plain update forge timeTracking fields; here those keys are not even
-- reachable). area/responsavel_id changes (old bug #3: gestor moving a
-- task outside their own authority) are only honored when the caller is
-- privileged, or is a gestor acting entirely within their own area on
-- both sides of the change.
-- ---------------------------------------------------------------------

create function update_task(p_task_id uuid, p_operation_id text, p_patch jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_forbidden_keys text[] := array[
    'status', 'evidencia', 'justificativa_atraso', 'approval_status', 'approved_by', 'approved_at',
    'timer_state', 'timer_total_ms', 'timer_active_started_at', 'timer_started_at', 'timer_completed_at',
    'concluido_em', 'code', 'company_id', 'id', 'record_version', 'created_at', 'updated_at',
    'solicitante_id', 'excluido', 'aguardando_quem', 'aguardando_desde', 'motivo_espera'
  ];
  v_key text;
  v_caller_area text := (select area from profiles where id = auth.uid());
  v_new_area text;
  v_new_responsavel uuid;
  v_result jsonb;
begin
  v_existing := claim_operation(p_operation_id, 'update');
  if v_existing is not null then
    return v_existing;
  end if;

  foreach v_key in array v_forbidden_keys loop
    if p_patch ? v_key then
      perform fail_operation(p_operation_id);
      raise exception 'SGO_FIELD_NOT_ALLOWED: % cannot be changed via update_task, use the dedicated action', v_key;
    end if;
  end loop;

  v_task := lock_task(p_task_id);

  if p_patch ? 'area' then
    v_new_area := p_patch ->> 'area';
    if not (is_privileged() or (current_user_role() = 'gestor' and v_task.area = v_caller_area and v_new_area = v_caller_area)) then
      perform fail_operation(p_operation_id);
      raise exception 'SGO_FORBIDDEN: only a privileged role may move a task to a different area';
    end if;
  end if;

  if p_patch ? 'responsavel_id' then
    v_new_responsavel := (p_patch ->> 'responsavel_id')::uuid;
    if not (
      is_privileged()
      or (current_user_role() = 'gestor' and v_task.area = v_caller_area
          and (select area from profiles where id = v_new_responsavel) = v_caller_area)
    ) then
      perform fail_operation(p_operation_id);
      raise exception 'SGO_FORBIDDEN: only a privileged role, or a gestor reassigning within their own area, may change responsavel_id';
    end if;
  end if;

  update tasks set
    titulo = coalesce(p_patch ->> 'titulo', titulo),
    descricao = coalesce(p_patch ->> 'descricao', descricao),
    area = coalesce(v_new_area, area),
    responsavel_id = coalesce(v_new_responsavel, responsavel_id),
    participantes = case when p_patch ? 'participantes'
      then (select array_agg(x::uuid) from jsonb_array_elements_text(p_patch -> 'participantes') x)
      else participantes end,
    prazo = case when p_patch ? 'prazo' then (p_patch ->> 'prazo')::timestamptz else prazo end,
    prazo_manual = case when p_patch ? 'prazo' then true else prazo_manual end,
    estimativa = coalesce((p_patch ->> 'estimativa')::numeric, estimativa),
    prioridade = coalesce(p_patch ->> 'prioridade', prioridade),
    risco = coalesce(p_patch ->> 'risco', risco),
    tags = case when p_patch ? 'tags'
      then (select array_agg(x::text) from jsonb_array_elements_text(p_patch -> 'tags') x)
      else tags end,
    record_version = record_version + 1
  where id = p_task_id
  returning * into v_task;

  insert into task_history (task_id, user_id, action, from_status, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Tarefa atualizada', v_task.status, v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants — RLS on the base tables denies writes to `authenticated`
-- entirely; these functions are the only door in, so they need EXECUTE
-- explicitly.
-- ---------------------------------------------------------------------

grant execute on function
  create_task(text, text, text, uuid, text, text, uuid, uuid[], timestamptz, numeric, text, text, text[]),
  start_task(uuid, text),
  pause_task(uuid, text),
  resume_task(uuid, text),
  wait_task(uuid, text, text, text),
  approval_wait_task(uuid, text),
  complete_task(uuid, text, text, text),
  cancel_task(uuid, text, text),
  approve_task(uuid, text),
  reject_task(uuid, text, text),
  update_task(uuid, text, jsonb)
to authenticated;

-- SGO on Supabase — adds the missing audit_task() function.
--
-- The 'Auditada' status has existed in the task_status enum and in
-- enforce_task_transition()'s gated_statuses list (0003_tasks.sql) since
-- the very first migration, requiring action = 'audit' — but no function
-- anywhere ever set that action, so the status was structurally
-- unreachable. Found while designing Kanban drag-and-drop (every column
-- needs a real function behind it) and confirmed by reading the trigger
-- directly rather than assuming.
--
-- A second, more subtle gap: enforce_task_transition() also treats
-- 'Concluída' as terminal (old.status = any(terminal_statuses) blocks any
-- further status change unless action = 'reopen'). Auditing only makes
-- sense on an already-completed task, so a naive audit_task() would still
-- have failed against the terminal-state check, which runs before the
-- gated-status check. This replaces the trigger with one extra, narrow
-- exception: 'Concluída' -> 'Auditada' via action = 'audit' specifically —
-- every other terminal-state protection is unchanged.

create or replace function enforce_task_transition()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  action text := coalesce(current_setting('sgo.action', true), '');
  terminal_statuses task_status[] := array['Concluída', 'Auditada', 'Cancelada'];
  gated_statuses task_status[] := array['Concluída', 'Auditada', 'Cancelada', 'Reprovada/devolvida', 'Aguardando aprovação', 'Aguardando terceiro'];
begin
  if old.status = any (terminal_statuses) and new.status <> old.status and action <> 'reopen'
    and not (old.status = 'Concluída' and new.status = 'Auditada' and action = 'audit')
  then
    raise exception 'SGO_TERMINAL_STATE_PRESERVED: task % is % and cannot be moved to % without the reopen action',
      old.id, old.status, new.status;
  end if;

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

-- Restricted to auditoria/diretoria/admin (is_privileged()), same
-- criterion as the old system's can('auditTask'). Only legal from
-- 'Concluída' — auditing is a review step on finished work, not an
-- alternative way to finish a task.
create function audit_task(p_task_id uuid, p_operation_id text)
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
  v_existing := claim_operation(p_operation_id, 'audit');
  if v_existing is not null then
    return v_existing;
  end if;

  if not is_privileged() then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_FORBIDDEN: only auditoria, diretoria, or admin may audit a task';
  end if;

  select * into v_task from tasks where id = p_task_id for update;
  if not found then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_NOT_FOUND: task % does not exist', p_task_id;
  end if;
  if v_task.status <> 'Concluída' then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_AUDIT_REQUIRES_COMPLETED: only a completed task can be audited';
  end if;

  perform set_config('sgo.action', 'audit', true);
  update tasks
    set status = 'Auditada',
        record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Tarefa auditada', v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

grant execute on function audit_task(uuid, text) to authenticated;

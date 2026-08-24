-- SGO on Supabase — reversible soft-delete for tasks and collaborators.
--
-- tasks.excluido has existed since 0003_tasks.sql (every task query
-- already filters `.eq("excluido", false)`) but nothing ever set it to
-- true — there was no delete action anywhere. Collaborators already had
-- a reversible toggle (active/set_profile_active), but it's a distinct
-- concept from deletion: "Inativo" still shows in the roster (can't log
-- in, but still assignable-history and visible for context); "Excluído"
-- removes them from the roster entirely, same as a deleted task
-- disappearing from every list, while the row itself — and everything
-- that references it (tasks, task_history, audit_findings) — stays
-- intact and restorable. Confirmed with the user: reversible soft-delete
-- only, never a real `delete from` — same "nothing is ever truly gone"
-- posture as the rest of this schema (cancel/reject/deactivate).

alter table profiles add column excluido boolean not null default false;

-- ---------------------------------------------------------------------
-- delete_task / restore_task — same authorization pair as cancel_task
-- (0007): the requester, an area manager of the same area, or a
-- privileged role. Deliberately NOT available to a mere responsável or
-- participante (lock_task()'s own can_mutate_task check is broader, but
-- the explicit re-check below narrows it, exactly like cancel_task
-- does) — deleting is closer in weight to cancelling than to the
-- everyday task actions.
--
-- Independent of `status` on purpose: excluido doesn't participate in
-- enforce_task_transition()'s gated/terminal-status checks at all, so a
-- task can be deleted (and restored) from any status, including a
-- terminal one — this is "remove from view", not a business transition.
-- ---------------------------------------------------------------------

create function delete_task(p_task_id uuid, p_operation_id text)
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
  v_existing := claim_operation(p_operation_id, 'delete');
  if v_existing is not null then
    return v_existing;
  end if;

  v_task := lock_task(p_task_id);
  if not (is_privileged() or v_task.solicitante_id = auth.uid()
      or (current_user_role() = 'gestor' and v_task.area = (select area from profiles where id = auth.uid()))) then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_FORBIDDEN: only the requester, an area manager, or a privileged role may delete this task';
  end if;
  if v_task.excluido then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_ALREADY_DELETED: task % is already deleted', p_task_id;
  end if;

  update tasks set excluido = true, record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Tarefa excluída', v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

create function restore_task(p_task_id uuid, p_operation_id text)
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
  v_existing := claim_operation(p_operation_id, 'restore_task');
  if v_existing is not null then
    return v_existing;
  end if;

  v_task := lock_task(p_task_id);
  if not (is_privileged() or v_task.solicitante_id = auth.uid()
      or (current_user_role() = 'gestor' and v_task.area = (select area from profiles where id = auth.uid()))) then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_FORBIDDEN: only the requester, an area manager, or a privileged role may restore this task';
  end if;
  if not v_task.excluido then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_NOT_DELETED: task % is not deleted', p_task_id;
  end if;

  update tasks set excluido = false, record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), 'Tarefa restaurada', v_task.status, p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

grant execute on function delete_task(uuid, text) to authenticated;
grant execute on function restore_task(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- delete_profile / restore_profile — privileged only, same gate as
-- set_profile_active. Deleting also deactivates + revokes sessions (a
-- deleted person obviously shouldn't stay logged in); restoring only
-- clears excluido — it deliberately does NOT also reactivate, so an
-- admin restoring someone from the trash still gets a chance to decide
-- role/capacity before they're active again, rather than silently
-- handing back access.
-- ---------------------------------------------------------------------

create function delete_profile(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_privileged() then
    raise exception 'SGO_FORBIDDEN: only a privileged role may delete a collaborator';
  end if;
  if not exists (select 1 from profiles where id = p_profile_id and company_id = current_company()) then
    raise exception 'SGO_NOT_FOUND: profile % does not exist in the caller company', p_profile_id;
  end if;

  update profiles set excluido = true, active = false, updated_at = now() where id = p_profile_id;
  perform revoke_sessions_for(p_profile_id);
end;
$$;

create function restore_profile(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_privileged() then
    raise exception 'SGO_FORBIDDEN: only a privileged role may restore a collaborator';
  end if;
  if not exists (select 1 from profiles where id = p_profile_id and company_id = current_company()) then
    raise exception 'SGO_NOT_FOUND: profile % does not exist in the caller company', p_profile_id;
  end if;

  update profiles set excluido = false, updated_at = now() where id = p_profile_id;
end;
$$;

grant execute on function delete_profile(uuid) to authenticated;
grant execute on function restore_profile(uuid) to authenticated;

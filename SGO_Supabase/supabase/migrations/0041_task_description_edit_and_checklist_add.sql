-- SGO on Supabase — a Tarefa Cronometrada is created with only título +
-- descrição (0034) and never gets a checklist at all, and no task of any
-- type has ever had a way to edit its descrição after creation (the only
-- write path was create_task() itself). Requested: the assigned person
-- (not just someone with direct database access) needs to be able to fix
-- up the descrição mid-task, and to build a checklist on a timed task too
-- — same authorization as every other task action (can_mutate_task, via
-- lock_task): responsável, solicitante, participante, gestor of the area,
-- or privileged. Deliberately not restricted by task status — this isn't a
-- status transition, so enforce_task_transition() never sees it.

create function update_task_description(p_task_id uuid, p_operation_id text, p_descricao text)
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
  v_existing := claim_operation(p_operation_id, 'update_description');
  if v_existing is not null then
    return v_existing;
  end if;

  if coalesce(trim(p_descricao), '') = '' then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_DESCRIPTION_REQUIRED: informe uma descrição para a tarefa';
  end if;

  v_task := lock_task(p_task_id);

  update tasks
    set descricao = p_descricao,
        record_version = record_version + 1
    where id = p_task_id
    returning * into v_task;

  insert into task_history (task_id, user_id, action, operation_id)
    values (p_task_id, auth.uid(), 'Descrição atualizada', p_operation_id);

  v_result := task_summary(v_task);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

create function add_task_checklist_item(p_task_id uuid, p_operation_id text, p_texto text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_item task_checklist_items;
  v_result jsonb;
begin
  v_existing := claim_operation(p_operation_id, 'add_checklist_item');
  if v_existing is not null then
    return v_existing;
  end if;

  if coalesce(trim(p_texto), '') = '' then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_CHECKLIST_ITEM_REQUIRED: informe o texto do item';
  end if;

  v_task := lock_task(p_task_id);

  insert into task_checklist_items (task_id, texto, position)
    values (p_task_id, p_texto, coalesce((select max(position) + 1 from task_checklist_items where task_id = p_task_id), 0))
    returning * into v_item;

  insert into task_history (task_id, user_id, action, operation_id)
    values (p_task_id, auth.uid(), 'Item de checklist adicionado: ' || p_texto, p_operation_id);

  v_result := jsonb_build_object('id', v_item.id, 'texto', v_item.texto, 'position', v_item.position, 'feito', v_item.feito);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

-- Match this project's established least-privilege posture (see 0016/0018/
-- 0019/0039/0040): every new function otherwise defaults to anon-callable.
revoke execute on function update_task_description(uuid, text, text) from anon, public;
revoke execute on function add_task_checklist_item(uuid, text, text) from anon, public;

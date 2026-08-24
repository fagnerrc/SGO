-- SGO on Supabase — simplify the audit finding form per user feedback
-- after using it: drop causa/impacto (redundant with fato + ação in
-- practice), turn ação corretiva into a controlled vocabulary (was free
-- text), and default responsável to the task's own responsavel_id
-- (client-side default — see audit.ts) rather than leaving it blank.
--
-- acao is left as plain text with no CHECK constraint, same as
-- risco/prioridade elsewhere (see PROGRESS.md open-questions item 8) —
-- the select in the UI is what actually constrains it day to day; a hard
-- constraint here would also have broken on this table's one pre-existing
-- test row, whose acao value predates the new option list.

alter table audit_findings drop column causa;
alter table audit_findings drop column impacto;

drop function if exists audit_task(uuid, text, text, text, text, text, text, text, uuid, timestamptz, text);

create function audit_task(
  p_task_id uuid,
  p_operation_id text,
  p_resultado text,
  p_risco text,
  p_fato text,
  p_acao text,
  p_responsavel_id uuid default null,
  p_prazo timestamptz default null,
  p_evidencia text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing jsonb;
  v_task tasks;
  v_finding_id uuid;
  v_finding_status text;
  v_history_action text;
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

  if p_resultado not in ('Aprovada', 'Reprovada') then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_INVALID_RESULT: resultado must be Aprovada or Reprovada';
  end if;
  if coalesce(trim(p_fato), '') = '' or coalesce(trim(p_acao), '') = '' then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_AUDIT_FIELDS_REQUIRED: fato and acao are both required';
  end if;
  if p_resultado = 'Reprovada' and (p_responsavel_id is null or p_prazo is null) then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_AUDIT_PLAN_REQUIRED: a reproved finding needs a responsavel and a prazo for the corrective action';
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

  if p_resultado = 'Aprovada' then
    perform set_config('sgo.action', 'audit', true);
    update tasks
      set status = 'Auditada',
          record_version = record_version + 1
      where id = p_task_id
      returning * into v_task;
    v_finding_status := 'Validado';
    v_history_action := 'Tarefa auditada — aprovada';
  else
    perform set_config('sgo.action', 'audit_reject', true);
    update tasks
      set status = 'Reprovada/devolvida',
          concluido_em = null,
          record_version = record_version + 1
      where id = p_task_id
      returning * into v_task;
    v_finding_status := 'Aberto';
    v_history_action := 'Tarefa auditada — reprovada: ' || p_acao;
  end if;

  insert into audit_findings (
    company_id, task_id, resultado, risco, fato, acao,
    responsavel_id, prazo, evidencia, status, criado_por
  ) values (
    current_company(), p_task_id, p_resultado, p_risco, p_fato, p_acao,
    p_responsavel_id, p_prazo, coalesce(p_evidencia, ''), v_finding_status, auth.uid()
  ) returning id into v_finding_id;

  insert into task_history (task_id, user_id, action, to_status, operation_id)
    values (p_task_id, auth.uid(), v_history_action, v_task.status, p_operation_id);

  v_result := task_summary(v_task) || jsonb_build_object('finding_id', v_finding_id);
  perform complete_operation(p_operation_id, v_result);
  return v_result;
exception when others then
  perform fail_operation(p_operation_id);
  raise;
end;
$$;

grant execute on function audit_task(uuid, text, text, text, text, text, uuid, timestamptz, text) to authenticated;

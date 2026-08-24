-- SGO on Supabase — Tarefa Agendada needs a start date too, not just
-- `prazo` (the deadline/end date) — so a person can actually tell
-- "started late" from "still within the window" instead of only ever
-- seeing one date. `prazo` already means "quando termina"; this adds
-- `data_inicio` for "quando começa".

alter table tasks add column data_inicio timestamptz;

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
  p_checklist text[] default '{}',
  p_data_inicio timestamptz default null
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
  if p_data_inicio is not null and p_prazo is not null and p_data_inicio > p_prazo then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_INVALID_DATE_RANGE: a data de início não pode ser depois do prazo final';
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
    estimativa, prioridade, risco, data_inicio
  ) values (
    v_company, p_area, p_process_id, p_titulo, p_descricao, p_tipo,
    auth.uid(), p_responsavel_id, p_participantes, p_prazo, p_prazo is not null,
    p_estimativa, p_prioridade, p_risco, p_data_inicio
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

-- SGO on Supabase — full audit workflow (checklist gap: "auditoria não
-- está funcionando").
--
-- 0025_audit_task.sql only ever gave Concluída -> Auditada a real function
-- to go through — but as a bare status flip with no data collected, no
-- reject path, no dedicated screen, and (found while investigating) no
-- role filter on the Kanban drag target, so a plain colaborador could see
-- "mover para Auditada" on a card and get a permission error trying it.
--
-- The old system's audit flow (V12_TaskOperations.gs mutateTaskServer
-- action='audit', Index.html #auditModal/saveAuditFromForm) collected a
-- real finding — resultado (Aprovada/Reprovada), risco, fato, causa,
-- impacto, ação corretiva, responsável and prazo for the corrective
-- action, evidência — and tracked each finding through its own status
-- lifecycle (Aberto/Em andamento/Concluído/Validado/Ineficaz/Cancelado).
-- This replicates that as a proper table instead of the old system's
-- state.audits array.

create table audit_findings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  task_id uuid not null references tasks(id),
  resultado text not null check (resultado in ('Aprovada', 'Reprovada')),
  risco text not null check (risco in ('Baixo', 'Médio', 'Alto', 'Crítico')),
  fato text not null,
  causa text not null,
  impacto text not null,
  acao text not null,
  responsavel_id uuid references profiles(id),
  prazo timestamptz,
  evidencia text not null default '',
  status text not null default 'Aberto'
    check (status in ('Aberto', 'Em andamento', 'Concluído', 'Validado', 'Ineficaz', 'Cancelado')),
  criado_por uuid not null references profiles(id),
  criado_em timestamptz not null default now()
);

create index audit_findings_task_id_idx on audit_findings(task_id);
create index audit_findings_company_id_idx on audit_findings(company_id);

alter table audit_findings enable row level security;

-- Visible to auditors/diretoria/admin (company-scoped, same as everything
-- else) and to whoever owns the corrective-action plan, so they can see
-- and progress their own finding without needing a privileged role.
create policy audit_findings_select on audit_findings for select
  using (
    company_id = current_company()
    and (is_privileged() or responsavel_id = auth.uid())
  );

-- No insert/update grant here — audit_task() (below) creates the finding
-- as part of auditing a task, set_audit_finding_status() is the only way
-- to move it through its lifecycle. Same "no bare table write" pattern as
-- tasks (0006_rls_policies.sql header note).

-- ---------------------------------------------------------------------
-- enforce_task_transition(): add the second narrow terminal-state
-- exception this needs — a REPROVED audit reopens a 'Concluída' task
-- straight to 'Reprovada/devolvida' (skipping the normal
-- approval-rejection path, which requires a linked process/approver and
-- doesn't apply here). Every other terminal-state protection is
-- unchanged from 0025.
-- ---------------------------------------------------------------------

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
    and not (old.status = 'Concluída' and new.status = 'Reprovada/devolvida' and action = 'audit_reject')
  then
    raise exception 'SGO_TERMINAL_STATE_PRESERVED: task % is % and cannot be moved to % without the reopen action',
      old.id, old.status, new.status;
  end if;

  if new.status <> old.status and new.status = any (gated_statuses) then
    if (new.status = 'Concluída' and action <> 'complete')
      or (new.status = 'Auditada' and action <> 'audit')
      or (new.status = 'Cancelada' and action <> 'cancel')
      or (new.status = 'Reprovada/devolvida' and action <> 'reject' and action <> 'audit_reject')
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

-- ---------------------------------------------------------------------
-- audit_task(): replaces the 0025 bare status-flip version with the full
-- finding form. Kept the same function name/first two params so nothing
-- else needs to change identity — callers now pass the finding fields.
-- ---------------------------------------------------------------------

drop function if exists audit_task(uuid, text);

create function audit_task(
  p_task_id uuid,
  p_operation_id text,
  p_resultado text,
  p_risco text,
  p_fato text,
  p_causa text,
  p_impacto text,
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
  if coalesce(trim(p_fato), '') = '' or coalesce(trim(p_causa), '') = ''
    or coalesce(trim(p_impacto), '') = '' or coalesce(trim(p_acao), '') = ''
  then
    perform fail_operation(p_operation_id);
    raise exception 'SGO_AUDIT_FIELDS_REQUIRED: fato, causa, impacto and acao are all required';
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
    company_id, task_id, resultado, risco, fato, causa, impacto, acao,
    responsavel_id, prazo, evidencia, status, criado_por
  ) values (
    current_company(), p_task_id, p_resultado, p_risco, p_fato, p_causa, p_impacto, p_acao,
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

grant execute on function audit_task(uuid, text, text, text, text, text, text, text, uuid, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------
-- set_audit_finding_status(): moves a finding through Aberto -> Em
-- andamento -> Concluído -> Validado/Ineficaz/Cancelado. Same "owner or
-- privileged" gate as everywhere else a single row is self-service.
-- ---------------------------------------------------------------------

create function set_audit_finding_status(p_finding_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_finding audit_findings;
begin
  if p_status not in ('Aberto', 'Em andamento', 'Concluído', 'Validado', 'Ineficaz', 'Cancelado') then
    raise exception 'SGO_INVALID_STATUS: unknown finding status %', p_status;
  end if;

  select * into v_finding from audit_findings where id = p_finding_id;
  if not found then
    raise exception 'SGO_NOT_FOUND: finding % does not exist', p_finding_id;
  end if;
  if not (is_privileged() or v_finding.responsavel_id = auth.uid()) then
    raise exception 'SGO_FORBIDDEN: only the assigned responsavel or a privileged role may update this finding';
  end if;

  update audit_findings set status = p_status where id = p_finding_id;
end;
$$;

grant execute on function set_audit_finding_status(uuid, text) to authenticated;

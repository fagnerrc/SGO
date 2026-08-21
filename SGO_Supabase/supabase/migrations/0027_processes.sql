-- SGO on Supabase — extends `processes` (checklist part 2/7) with the
-- fields the old system used to turn a process into a real operational
-- template: RACI beyond conferente/aprovador (dono, executor), SLA,
-- risk, evidence requirements, a default checklist, and recurrence.
-- `processes` existed since 0002_core_tables.sql but only had
-- name/segregacao/conferente_id/aprovador_id — no screen ever used the
-- rest of this, so it was never added until now.

alter table processes add column codigo text;
alter table processes add column area text;
alter table processes add column descricao text;
alter table processes add column dono_id uuid references profiles (id);
alter table processes add column executor_id uuid references profiles (id);
alter table processes add column sla_horas numeric;
alter table processes add column tolerancia_horas numeric not null default 0;
alter table processes add column risco text not null default 'Médio';
alter table processes add column evidencia_obrigatoria boolean not null default false;
alter table processes add column evidencia_orientacao text;
alter table processes add column estimativa_padrao numeric not null default 1;
alter table processes add column checklist_padrao text[] not null default '{}';
alter table processes add column recorrencia text not null default 'Sem recorrência'
  constraint processes_recorrencia_check check (recorrencia in ('Sem recorrência', 'Diária', 'Semanal', 'Mensal'));
alter table processes add column ativo boolean not null default true;

-- Mutations go through security-definer functions, same convention as
-- every other write path in this project (set_profile_active,
-- update_company_branding, ...) rather than an RLS update/insert policy
-- — processes_select is the only policy on this table today, so nothing
-- could write to it from the client before this.
create function create_process(
  p_name text,
  p_codigo text default null,
  p_area text default null,
  p_descricao text default null,
  p_dono_id uuid default null,
  p_executor_id uuid default null,
  p_conferente_id uuid default null,
  p_aprovador_id uuid default null,
  p_sla_horas numeric default null,
  p_tolerancia_horas numeric default 0,
  p_risco text default 'Médio',
  p_segregacao boolean default false,
  p_evidencia_obrigatoria boolean default false,
  p_evidencia_orientacao text default null,
  p_estimativa_padrao numeric default 1,
  p_checklist_padrao text[] default '{}',
  p_recorrencia text default 'Sem recorrência'
)
returns processes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_process processes;
begin
  if not is_privileged() then
    raise exception 'SGO_FORBIDDEN: only admin/diretoria/auditoria may manage processes';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'SGO_PROCESS_NAME_REQUIRED: informe o nome do processo';
  end if;

  insert into processes (
    company_id, name, codigo, area, descricao, dono_id, executor_id, conferente_id, aprovador_id,
    sla_horas, tolerancia_horas, risco, segregacao, evidencia_obrigatoria, evidencia_orientacao,
    estimativa_padrao, checklist_padrao, recorrencia
  ) values (
    current_company(), p_name, nullif(trim(coalesce(p_codigo, '')), ''), p_area, p_descricao,
    p_dono_id, p_executor_id, p_conferente_id, p_aprovador_id,
    p_sla_horas, p_tolerancia_horas, p_risco, p_segregacao, p_evidencia_obrigatoria, p_evidencia_orientacao,
    p_estimativa_padrao, p_checklist_padrao, p_recorrencia
  )
  returning * into v_process;

  return v_process;
end;
$$;

create function update_process(
  p_process_id uuid,
  p_name text,
  p_codigo text default null,
  p_area text default null,
  p_descricao text default null,
  p_dono_id uuid default null,
  p_executor_id uuid default null,
  p_conferente_id uuid default null,
  p_aprovador_id uuid default null,
  p_sla_horas numeric default null,
  p_tolerancia_horas numeric default 0,
  p_risco text default 'Médio',
  p_segregacao boolean default false,
  p_evidencia_obrigatoria boolean default false,
  p_evidencia_orientacao text default null,
  p_estimativa_padrao numeric default 1,
  p_checklist_padrao text[] default '{}',
  p_recorrencia text default 'Sem recorrência'
)
returns processes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_process processes;
begin
  if not is_privileged() then
    raise exception 'SGO_FORBIDDEN: only admin/diretoria/auditoria may manage processes';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'SGO_PROCESS_NAME_REQUIRED: informe o nome do processo';
  end if;

  update processes set
    name = p_name,
    codigo = nullif(trim(coalesce(p_codigo, '')), ''),
    area = p_area,
    descricao = p_descricao,
    dono_id = p_dono_id,
    executor_id = p_executor_id,
    conferente_id = p_conferente_id,
    aprovador_id = p_aprovador_id,
    sla_horas = p_sla_horas,
    tolerancia_horas = p_tolerancia_horas,
    risco = p_risco,
    segregacao = p_segregacao,
    evidencia_obrigatoria = p_evidencia_obrigatoria,
    evidencia_orientacao = p_evidencia_orientacao,
    estimativa_padrao = p_estimativa_padrao,
    checklist_padrao = p_checklist_padrao,
    recorrencia = p_recorrencia,
    updated_at = now()
  where id = p_process_id and company_id = current_company()
  returning * into v_process;

  if not found then
    raise exception 'SGO_NOT_FOUND: process % does not exist in this company', p_process_id;
  end if;

  return v_process;
end;
$$;

create function set_process_active(p_process_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_privileged() then
    raise exception 'SGO_FORBIDDEN: only admin/diretoria/auditoria may manage processes';
  end if;
  update processes set ativo = p_active, updated_at = now()
    where id = p_process_id and company_id = current_company();
  if not found then
    raise exception 'SGO_NOT_FOUND: process % does not exist in this company', p_process_id;
  end if;
end;
$$;

grant execute on function
  create_process(text, text, text, text, uuid, uuid, uuid, uuid, numeric, numeric, text, boolean, boolean, text, numeric, text[], text),
  update_process(uuid, text, text, text, text, uuid, uuid, uuid, uuid, numeric, numeric, text, boolean, boolean, text, numeric, text[], text),
  set_process_active(uuid, boolean)
to authenticated;

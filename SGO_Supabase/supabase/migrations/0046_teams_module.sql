-- SGO on Supabase — Equipes (Teams) module. First real use case: a
-- supervisor (Fernando, Expedição) tracks a crew that are NOT SGO users
-- at all — no login, no PIN, no session, nothing in `profiles`. They're
-- plain records scoped to a team, cadastrados manualmente pelo próprio
-- supervisor. The only SGO-authenticated person in this picture is the
-- supervisor themselves — an ordinary `profiles` row (role stays exactly
-- what it already is, e.g. 'colaborador' for Fernando; this deliberately
-- does NOT add a new global role or touch is_privileged()/is_admin()).
-- Permission to manage a given team is scoped to "you are that team's
-- supervisor_id, or you're already privileged" — never a blanket
-- SGO-wide grant (spec section 13/14).
--
-- Monthly scoring never stores a single mutable "current points" column
-- — a member's score for any given month is always DERIVED as
-- monthly_starting_points minus that month's occurrences, so "resets to
-- 10 every month" falls out for free with zero migration/cron needed,
-- and nothing about past months is ever destroyed (section 10).

create table teams (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  name text not null,
  supervisor_id uuid not null references profiles (id),
  monthly_starting_points numeric not null default 10,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_by uuid references profiles (id),
  updated_at timestamptz not null default now()
);
create index teams_company_idx on teams (company_id);
create index teams_supervisor_idx on teams (supervisor_id);

create table team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (id) on delete cascade,
  name text not null,
  employee_code text not null default '',
  role text not null default '',
  joined_at date not null default current_date,
  status text not null default 'ATIVO' check (status in ('ATIVO', 'INATIVO')),
  notes text not null default '',
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_by uuid references profiles (id),
  updated_at timestamptz not null default now(),
  inactivated_at timestamptz,
  inactivated_by uuid references profiles (id),
  inactivation_reason text not null default ''
);
create index team_members_team_idx on team_members (team_id);

create table team_member_occurrences (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid not null references team_members (id) on delete cascade,
  occurred_at date not null default current_date,
  points_deducted numeric not null check (points_deducted >= 0),
  motivo text not null,
  descricao text not null,
  observacao text not null default '',
  registered_by uuid not null references profiles (id),
  created_at timestamptz not null default now()
);
create index team_member_occurrences_member_idx on team_member_occurrences (team_member_id, occurred_at);

alter table teams enable row level security;
alter table team_members enable row level security;
alter table team_member_occurrences enable row level security;

create function is_team_supervisor(p_team_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from teams where id = p_team_id and supervisor_id = auth.uid());
$$;
revoke execute on function is_team_supervisor(uuid) from anon, public;

-- Read access: the team's own supervisor, or anyone already privileged
-- (same "oversight backstop" reasoning as every other module this
-- session — e.g. if Fernando is out, an admin can still see what's
-- going on). Deliberately NOT open to the rest of the company — these
-- are internal performance/disciplinary records about people who never
-- consented to being SGO users (spec section 3/12).
create policy teams_select on teams for select
  using (company_id = current_company() and (supervisor_id = auth.uid() or is_privileged()));

create policy team_members_select on team_members for select
  using (exists (select 1 from teams t where t.id = team_members.team_id and (t.supervisor_id = auth.uid() or is_privileged())));

create policy team_member_occurrences_select on team_member_occurrences for select
  using (exists (
    select 1 from team_members m join teams t on t.id = m.team_id
    where m.id = team_member_occurrences.team_member_id and (t.supervisor_id = auth.uid() or is_privileged())
  ));

-- No insert/update/delete policies anywhere here on purpose — every
-- write goes through a SECURITY DEFINER RPC below, matching this
-- project's established pattern (tasks, routines, ...): RLS only ever
-- governs reads, mutations are validated server-side regardless of what
-- RLS would otherwise allow.

create function create_team(p_name text, p_supervisor_id uuid default null, p_monthly_starting_points numeric default 10)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supervisor uuid := coalesce(p_supervisor_id, auth.uid());
  v_team teams;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'SGO_NAME_REQUIRED: informe um nome para a equipe';
  end if;
  -- Naming someone else as supervisor is an admin-only move — anyone
  -- else may only ever create a team with themselves as supervisor.
  if v_supervisor <> auth.uid() and not is_privileged() then
    raise exception 'SGO_FORBIDDEN: apenas administradores podem definir outro usuário como supervisor';
  end if;
  if not exists (select 1 from profiles where id = v_supervisor and company_id = current_company() and excluido = false) then
    raise exception 'SGO_INVALID_SUPERVISOR: supervisor inválido';
  end if;

  insert into teams (company_id, name, supervisor_id, monthly_starting_points, created_by)
    values (current_company(), p_name, v_supervisor, coalesce(p_monthly_starting_points, 10), auth.uid())
    returning * into v_team;

  return to_jsonb(v_team);
end;
$$;
revoke execute on function create_team(text, uuid, numeric) from anon, public;

create function update_team(p_team_id uuid, p_name text, p_monthly_starting_points numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team teams;
begin
  if not (is_team_supervisor(p_team_id) or is_privileged()) then
    raise exception 'SGO_FORBIDDEN: acesso restrito ao supervisor da equipe';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'SGO_NAME_REQUIRED: informe um nome para a equipe';
  end if;

  update teams set name = p_name, monthly_starting_points = coalesce(p_monthly_starting_points, monthly_starting_points),
    updated_by = auth.uid(), updated_at = now()
    where id = p_team_id
    returning * into v_team;
  if not found then
    raise exception 'SGO_NOT_FOUND: equipe não encontrada';
  end if;

  return to_jsonb(v_team);
end;
$$;
revoke execute on function update_team(uuid, text, numeric) from anon, public;

create function add_team_member(
  p_team_id uuid, p_name text, p_employee_code text default '', p_role text default '',
  p_joined_at date default current_date, p_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member team_members;
begin
  if not (is_team_supervisor(p_team_id) or is_privileged()) then
    raise exception 'SGO_FORBIDDEN: acesso restrito ao supervisor da equipe';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'SGO_NAME_REQUIRED: informe o nome do integrante';
  end if;

  insert into team_members (team_id, name, employee_code, role, joined_at, notes, created_by)
    values (p_team_id, p_name, coalesce(p_employee_code, ''), coalesce(p_role, ''), coalesce(p_joined_at, current_date), coalesce(p_notes, ''), auth.uid())
    returning * into v_member;

  return to_jsonb(v_member);
end;
$$;
revoke execute on function add_team_member(uuid, text, text, text, date, text) from anon, public;

create function update_team_member(
  p_member_id uuid, p_name text, p_employee_code text, p_role text, p_joined_at date, p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
  v_member team_members;
begin
  select team_id into v_team_id from team_members where id = p_member_id;
  if v_team_id is null then
    raise exception 'SGO_NOT_FOUND: integrante não encontrado';
  end if;
  if not (is_team_supervisor(v_team_id) or is_privileged()) then
    raise exception 'SGO_FORBIDDEN: acesso restrito ao supervisor da equipe';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'SGO_NAME_REQUIRED: informe o nome do integrante';
  end if;

  update team_members set
    name = p_name, employee_code = coalesce(p_employee_code, ''), role = coalesce(p_role, ''),
    joined_at = coalesce(p_joined_at, joined_at), notes = coalesce(p_notes, ''),
    updated_by = auth.uid(), updated_at = now()
    where id = p_member_id
    returning * into v_member;

  return to_jsonb(v_member);
end;
$$;
revoke execute on function update_team_member(uuid, text, text, text, date, text) from anon, public;

-- Soft state change only — reversible, matches this app's "nothing is
-- ever really deleted" convention (spec section 11: reativação must
-- stay possible, history must stay intact regardless of status).
create function set_team_member_status(p_member_id uuid, p_status text, p_reason text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
  v_member team_members;
begin
  if p_status not in ('ATIVO', 'INATIVO') then
    raise exception 'SGO_INVALID_STATUS: status inválido';
  end if;
  select team_id into v_team_id from team_members where id = p_member_id;
  if v_team_id is null then
    raise exception 'SGO_NOT_FOUND: integrante não encontrado';
  end if;
  if not (is_team_supervisor(v_team_id) or is_privileged()) then
    raise exception 'SGO_FORBIDDEN: acesso restrito ao supervisor da equipe';
  end if;

  update team_members set
    status = p_status,
    inactivated_at = case when p_status = 'INATIVO' then now() else null end,
    inactivated_by = case when p_status = 'INATIVO' then auth.uid() else null end,
    inactivation_reason = case when p_status = 'INATIVO' then coalesce(p_reason, '') else '' end,
    updated_by = auth.uid(), updated_at = now()
    where id = p_member_id
    returning * into v_member;

  return to_jsonb(v_member);
end;
$$;
revoke execute on function set_team_member_status(uuid, text, text) from anon, public;

create function add_team_occurrence(p_member_id uuid, p_points numeric, p_motivo text, p_descricao text, p_observacao text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
  v_occ team_member_occurrences;
begin
  select team_id into v_team_id from team_members where id = p_member_id;
  if v_team_id is null then
    raise exception 'SGO_NOT_FOUND: integrante não encontrado';
  end if;
  if not (is_team_supervisor(v_team_id) or is_privileged()) then
    raise exception 'SGO_FORBIDDEN: acesso restrito ao supervisor da equipe';
  end if;
  if p_points is null or p_points < 0 then
    raise exception 'SGO_INVALID_POINTS: informe quantos pontos descontar';
  end if;
  if coalesce(trim(p_motivo), '') = '' then
    raise exception 'SGO_MOTIVO_REQUIRED: informe o motivo';
  end if;
  if coalesce(trim(p_descricao), '') = '' then
    raise exception 'SGO_DESCRICAO_REQUIRED: informe a descrição';
  end if;

  insert into team_member_occurrences (team_member_id, points_deducted, motivo, descricao, observacao, registered_by)
    values (p_member_id, p_points, p_motivo, p_descricao, coalesce(p_observacao, ''), auth.uid())
    returning * into v_occ;

  return to_jsonb(v_occ);
end;
$$;
revoke execute on function add_team_occurrence(uuid, numeric, text, text, text) from anon, public;

-- The one place monthly scoring math actually lives — the team list
-- view and a member's "current score" both read from here, so there is
-- exactly one formula to ever get right: starting points for the team,
-- minus that month's occurrences for each member (section 7/10).
create function team_monthly_report(p_team_id uuid, p_month date default date_trunc('month', now())::date)
returns table (
  member_id uuid, name text, role text, status text,
  starting_points numeric, occurrence_count bigint, points_deducted numeric, final_points numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_start date := date_trunc('month', p_month)::date;
  v_month_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_starting numeric;
begin
  if not (is_team_supervisor(p_team_id) or is_privileged()) then
    raise exception 'SGO_FORBIDDEN: acesso restrito ao supervisor da equipe';
  end if;
  select monthly_starting_points into v_starting from teams where id = p_team_id;
  if v_starting is null then
    raise exception 'SGO_NOT_FOUND: equipe não encontrada';
  end if;

  return query
    select
      m.id, m.name, m.role, m.status,
      v_starting as starting_points,
      count(o.id) as occurrence_count,
      coalesce(sum(o.points_deducted), 0) as points_deducted,
      v_starting - coalesce(sum(o.points_deducted), 0) as final_points
    from team_members m
    left join team_member_occurrences o
      on o.team_member_id = m.id and o.occurred_at >= v_month_start and o.occurred_at < v_month_end
    where m.team_id = p_team_id
    group by m.id, m.name, m.role, m.status
    order by m.name;
end;
$$;
revoke execute on function team_monthly_report(uuid, date) from anon, public;

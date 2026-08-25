-- SGO on Supabase — Presença viewing is restricted to admin/diretoria/
-- auditoria (is_privileged(), same tier as Auditoria/Colaboradores/
-- Processos/Diagnóstico already use) — everyone still RECORDS their own
-- activity via record_activity() (unchanged, unrestricted by role, since
-- that's what makes the feature work for the whole team), but only
-- privileged roles may READ everyone's last_activity_at. Hiding the nav
-- link isn't enough on its own (same "não basta esconder o botão" rule
-- as Rotinas Periódicas) — listCompanyProfiles() is used by every regular
-- colaborador for task-assignment pickers, so last_activity_at can't just
-- ride along on that RLS-open query; it needs its own gated read path.

create function list_team_presence()
returns table (id uuid, full_name text, area text, role user_role, last_activity_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_privileged() then
    raise exception 'SGO_FORBIDDEN: acesso restrito a administradores, diretoria e processos/auditoria';
  end if;

  return query
    select p.id, p.full_name, p.area, p.role, p.last_activity_at
    from profiles p
    where p.company_id = current_company()
      and p.active = true
      and p.excluido = false
    order by p.full_name;
end;
$$;

revoke execute on function list_team_presence() from anon, public;

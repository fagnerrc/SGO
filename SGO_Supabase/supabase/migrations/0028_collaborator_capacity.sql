-- SGO on Supabase — weekly capacity per collaborator (checklist part
-- 6/7). Used by the Dashboard's workload calculation: occupancy = sum
-- of open tasks' estimativa assigned to the person, divided by this
-- number — a real measure of overload instead of a plain task count.

alter table profiles add column capacidade_semanal numeric not null default 40;

create function set_profile_capacity(p_profile_id uuid, p_capacidade_semanal numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_privileged() then
    raise exception 'SGO_FORBIDDEN: only admin/diretoria/auditoria may change a collaborator''s capacity';
  end if;
  if p_capacidade_semanal <= 0 then
    raise exception 'SGO_INVALID_CAPACITY: capacidade semanal precisa ser maior que zero';
  end if;
  update profiles set capacidade_semanal = p_capacidade_semanal, updated_at = now()
    where id = p_profile_id and company_id = current_company();
  if not found then
    raise exception 'SGO_NOT_FOUND: profile % does not exist in this company', p_profile_id;
  end if;
end;
$$;

grant execute on function set_profile_capacity(uuid, numeric) to authenticated;

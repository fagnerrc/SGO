-- SGO on Supabase — Phase 7: admin tooling, diagnostics, and closing the
-- first-user bootstrap gap flagged back in phase 3's PROGRESS.md.
--
-- Backup/restore is deliberately NOT reimplemented here as app code. The
-- old system's backup/restore logic was itself a source of real bugs (the
-- original review's C3 and A2: restoring a stale snapshot, and backup
-- maintenance silently wiping backups on a mid-write failure) — precisely
-- the kind of hand-rolled persistence logic this whole migration exists to
-- get away from. Supabase/Postgres has real point-in-time recovery and
-- scheduled backups built in (paid plans) or `pg_dump` (any plan); use
-- those instead of a custom RPC that could reintroduce the same bug class.

-- ---------------------------------------------------------------------
-- Bootstrap: the very first company + admin of a brand-new project. Both
-- functions are self-limiting rather than relying on auth (there's no
-- logged-in user yet to check `is_privileged()` against) — each checks
-- that nothing has been bootstrapped yet as its own gate, and permanently
-- stops working the instant that's no longer true.
-- ---------------------------------------------------------------------

create function can_bootstrap()
returns boolean
language sql
security definer
stable
as $$
  select not exists (select 1 from companies);
$$;

create function bootstrap_company(p_company_name text)
returns uuid
language plpgsql
security definer
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from companies) then
    raise exception 'SGO_ALREADY_BOOTSTRAPPED: a company already exists in this project';
  end if;
  insert into companies (name) values (p_company_name) returning id into v_id;
  return v_id;
end;
$$;

-- Separate from set_pin() (0008) on purpose: set_pin() requires the caller
-- to already be authenticated as the target or a privileged role, neither
-- of which exists during bootstrap. This instead checks that NO credential
-- has ever been set for anyone in the target's company — true only once,
-- for the very first admin, then closed off exactly like set_pin() would
-- have been for anyone else from that point on.
create function bootstrap_set_initial_pin(p_profile_id uuid, p_new_pin text)
returns void
language plpgsql
security definer
as $$
declare
  v_company uuid;
begin
  select company_id into v_company from profiles where id = p_profile_id;
  if v_company is null then
    raise exception 'SGO_NOT_FOUND: profile % does not exist', p_profile_id;
  end if;
  if exists (
    select 1 from credentials c join profiles p on p.id = c.profile_id
    where p.company_id = v_company
  ) then
    raise exception 'SGO_ALREADY_BOOTSTRAPPED: this company already has at least one credential set — use set_pin or an admin reset instead';
  end if;
  if length(coalesce(p_new_pin, '')) < 4 then
    raise exception 'SGO_PIN_TOO_SHORT: pin must be at least 4 characters';
  end if;

  insert into credentials (profile_id, pin_hash, updated_at)
    values (p_profile_id, crypt(p_new_pin, gen_salt('bf')), now());
end;
$$;

grant execute on function can_bootstrap() to anon;
grant execute on function bootstrap_company(text) to anon;
grant execute on function bootstrap_set_initial_pin(uuid, text) to anon;

-- ---------------------------------------------------------------------
-- Admin: company settings, collaborator lifecycle. profiles has no RLS
-- write policy at all (0006) — same "mutations go through functions"
-- pattern as tasks.
-- ---------------------------------------------------------------------

create function update_company_settings(p_login_max_attempts integer, p_login_lockout_minutes integer)
returns void
language plpgsql
security definer
as $$
begin
  if not is_privileged() then
    raise exception 'SGO_FORBIDDEN: only a privileged role may change company settings';
  end if;
  if p_login_max_attempts < 1 or p_login_lockout_minutes < 1 then
    raise exception 'SGO_INVALID_SETTINGS: attempts/lockout must be positive';
  end if;

  update companies
    set login_max_attempts = p_login_max_attempts, login_lockout_minutes = p_login_lockout_minutes
    where id = current_company();
end;
$$;

create function set_profile_role(p_profile_id uuid, p_role user_role)
returns void
language plpgsql
security definer
as $$
begin
  if not is_privileged() then
    raise exception 'SGO_FORBIDDEN: only a privileged role may change another user''s role';
  end if;
  if not exists (select 1 from profiles where id = p_profile_id and company_id = current_company()) then
    raise exception 'SGO_NOT_FOUND: profile % does not exist in the caller company', p_profile_id;
  end if;

  update profiles set role = p_role, updated_at = now() where id = p_profile_id;
end;
$$;

-- Deactivating a collaborator also revokes their sessions immediately —
-- same reasoning as set_pin() in phase 3: a status change with security
-- implications should take effect on the very next request, not linger
-- for up to 8h because nobody thought to also touch `sessions`.
create function set_profile_active(p_profile_id uuid, p_active boolean)
returns void
language plpgsql
security definer
as $$
begin
  if not is_privileged() then
    raise exception 'SGO_FORBIDDEN: only a privileged role may activate/deactivate a collaborator';
  end if;
  if not exists (select 1 from profiles where id = p_profile_id and company_id = current_company()) then
    raise exception 'SGO_NOT_FOUND: profile % does not exist in the caller company', p_profile_id;
  end if;

  update profiles set active = p_active, updated_at = now() where id = p_profile_id;
  if not p_active then
    perform revoke_sessions_for(p_profile_id);
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Diagnostics. Replaces reportClientErrorServer (V12_Diagnostics.gs) —
-- appendDiagnosticLogsServer's in-memory-buffer-with-periodic-flush design
-- doesn't have an equivalent here because it doesn't need one: this is a
-- direct write to `logs`, which is a real table with no size limit to work
-- around (the buffer existed in the old system to batch writes against
-- Sheets' comparatively expensive API, not because batching is inherently
-- necessary). Admins already read this data through the existing
-- `logs_select` RLS policy (0006) — no separate diagnostics-viewing
-- function needed.
-- ---------------------------------------------------------------------

-- Safe to add and reference in the same migration file (Postgres 12+):
-- the restriction is on using a brand-new enum value inside a DML
-- statement that actually EXECUTES in the same transaction it was added
-- in, not on merely storing it in a function body that runs later.
alter type log_kind add value 'diagnostic';

create function report_client_error(p_message text, p_context jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
as $$
begin
  insert into logs (company_id, kind, user_id, action, details)
    values (current_company(), 'diagnostic', auth.uid(), 'CLIENT_ERROR',
      jsonb_build_object('message', p_message) || coalesce(p_context, '{}'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

grant execute on function
  update_company_settings(integer, integer),
  set_profile_role(uuid, user_role),
  set_profile_active(uuid, boolean),
  report_client_error(text, jsonb)
to authenticated;

-- SGO on Supabase — Phase 3: PIN-based auth, live session revocation, and
-- provisioning a profile when an admin creates an auth.users row.
-- Replaces: authenticateSessionServer / readLoginAttemptV1215_ /
-- writeLoginAttemptV1215_ / resetUserPinServer (V12_SecuritySync.gs).
--
-- Design: `profiles.id` already references `auth.users.id` (0002), so every
-- SGO user still needs a real Supabase Auth user underneath. But sign-in
-- itself is custom (PIN, not password/magic-link): an Edge Function
-- (supabase/functions/pin-login) calls verify_login() below, and on success
-- signs its own Supabase-compatible JWT (HS256, project JWT secret) — this
-- is Supabase's documented "bring your own auth" pattern. That JWT carries
-- a `session_id` custom claim pointing at a row in `sessions` (0005), which
-- current_profile() now checks on every single request. That's what makes
-- an admin's PIN reset actually invalidate existing sessions immediately
-- (bug #1) instead of only affecting future logins.

-- ---------------------------------------------------------------------
-- Per-company lockout configuration. No separate expiry/TTL layer exists
-- anywhere in this design (bug #2's root cause) — login_attempts.locked_until
-- is read and compared directly, for as long as the row exists.
-- ---------------------------------------------------------------------

alter table companies add column login_max_attempts integer not null default 5;
alter table companies add column login_lockout_minutes integer not null default 30;

-- ---------------------------------------------------------------------
-- Design correction from 0005: sessions were originally modeled as an
-- opaque token the client presents and we look up by hash
-- (validate_session()). The actual design that shipped instead has the
-- login Edge Function sign a real Supabase-compatible JWT carrying a
-- `session_id` claim (verified live by session_is_valid() below), so
-- `token_hash` is no longer populated on insert. Kept nullable rather than
-- dropped, in case a future phase wants an opaque-token path alongside the
-- JWT one (e.g. long-lived API keys) — validate_session() in 0005 is
-- effectively superseded by session_is_valid() and current_session_id()
-- below and should not be relied on for new code.
-- ---------------------------------------------------------------------

alter table sessions alter column token_hash drop not null;

-- ---------------------------------------------------------------------
-- credentials: split out from `profiles` on purpose. `profiles` is broadly
-- readable within a company (0006); pin_hash must never be exposed through
-- that policy, so it lives in its own table with RLS enabled and NO
-- policies at all — only SECURITY DEFINER functions below ever touch it.
-- ---------------------------------------------------------------------

create table credentials (
  profile_id uuid primary key references profiles (id) on delete cascade,
  pin_hash text not null,
  updated_at timestamptz not null default now()
);

alter table credentials enable row level security;

-- ---------------------------------------------------------------------
-- Live session validity, keyed off a custom `session_id` claim the login
-- Edge Function puts in the JWT it signs.
-- ---------------------------------------------------------------------

create function current_session_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid;
$$;

create function session_is_valid()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select case
    when auth.uid() is null then true          -- anonymous/service-role context: nothing to check
    when current_session_id() is null then false -- claims a user identity but carries none of our session bookkeeping — reject rather than assume valid
    else exists (
      select 1 from sessions
      where id = current_session_id() and revoked_at is null and expires_at > now()
    )
  end;
$$;

-- Every other RLS helper (current_user_role/current_company/is_privileged)
-- goes through current_profile(), so gating it here is enough to make a
-- revoked session lose access everywhere, immediately — not just on token
-- refresh.
create or replace function current_profile()
returns profiles
language sql
security definer
stable
set search_path = public
as $$
  select * from profiles where id = auth.uid() and session_is_valid();
$$;

create or replace function current_user_role()
returns user_role
language sql
security definer
stable
set search_path = public
as $$
  select role from profiles where id = auth.uid() and session_is_valid();
$$;

create or replace function current_company()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select company_id from profiles where id = auth.uid() and session_is_valid();
$$;

create or replace function is_privileged()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select role in ('diretoria', 'auditoria', 'admin') from profiles where id = auth.uid() and session_is_valid()),
    false
  );
$$;

-- ---------------------------------------------------------------------
-- set_pin — self-service PIN change or admin-triggered reset. Both paths
-- revoke every existing session for the target user, fixing bug #1 (the
-- old resetUserPinServer updated the credential hash but left active
-- sessions valid for up to 8h).
-- ---------------------------------------------------------------------

create function set_pin(p_profile_id uuid, p_new_pin text)
returns void
language plpgsql
security definer
as $$
begin
  if not (auth.uid() = p_profile_id or is_privileged()) then
    raise exception 'SGO_FORBIDDEN: only the account owner or a privileged role may set this PIN';
  end if;
  if length(coalesce(p_new_pin, '')) < 4 then
    raise exception 'SGO_PIN_TOO_SHORT: pin must be at least 4 characters';
  end if;

  insert into credentials (profile_id, pin_hash, updated_at)
    values (p_profile_id, crypt(p_new_pin, gen_salt('bf')), now())
    on conflict (profile_id) do update set pin_hash = excluded.pin_hash, updated_at = now();

  perform revoke_sessions_for(p_profile_id);
end;
$$;

-- ---------------------------------------------------------------------
-- verify_login — the whole check (lockout, hash comparison, attempt
-- accounting) happens inside one transaction serialized per-email via an
-- advisory lock, closing the original race condition (parallel PIN guesses
-- reading the same attempt counter before either writes back — the very
-- first bug flagged in this project's review) at its root, not by adding a
-- lock around a check that still isn't atomic.
--
-- Called from the pin-login Edge Function (which then signs the actual
-- JWT — plain SQL cannot do that); also directly callable via PostgREST
-- RPC by `anon`, since a client isn't authenticated yet when logging in.
-- ---------------------------------------------------------------------

create function verify_login(p_email text, p_pin text)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_email text := lower(trim(p_email));
  v_attempt login_attempts;
  v_profile profiles;
  v_cred credentials;
  v_cred_found boolean;
  v_pin_ok boolean := false;
  v_company companies;
  v_max_attempts integer;
  v_lockout_minutes integer;
  v_session sessions;
begin
  perform pg_advisory_xact_lock(hashtext(v_email));

  select * into v_attempt from login_attempts where email = v_email;
  if found and v_attempt.locked_until is not null and v_attempt.locked_until > now() then
    return jsonb_build_object('success', false, 'errorCode', 'ACCOUNT_LOCKED', 'lockedUntil', v_attempt.locked_until);
  end if;

  select * into v_profile from profiles where email = v_email and active = true;
  if found then
    select * into v_cred from credentials where profile_id = v_profile.id;
    v_cred_found := found;
    if v_cred_found then
      v_pin_ok := (crypt(p_pin, v_cred.pin_hash) = v_cred.pin_hash);
    end if;
    select * into v_company from companies where id = v_profile.company_id;
  end if;

  v_max_attempts := coalesce(v_company.login_max_attempts, 5);
  v_lockout_minutes := coalesce(v_company.login_lockout_minutes, 30);

  if not v_pin_ok then
    -- Same failure response whether the email doesn't exist or the PIN is
    -- wrong (no user enumeration), but attempt accounting still happens so
    -- lockout behaves consistently either way.
    insert into login_attempts (email, failed_count, last_attempt_at)
      values (v_email, 1, now())
      on conflict (email) do update set
        failed_count = login_attempts.failed_count + 1,
        last_attempt_at = now(),
        locked_until = case
          when login_attempts.failed_count + 1 >= v_max_attempts
            then now() + (coalesce(v_lockout_minutes, 30) || ' minutes')::interval
          else login_attempts.locked_until
        end;
    return jsonb_build_object('success', false, 'errorCode', 'INVALID_CREDENTIALS');
  end if;

  delete from login_attempts where email = v_email;

  insert into sessions (profile_id, expires_at)
    values (v_profile.id, now() + interval '8 hours')
    returning * into v_session;

  return jsonb_build_object(
    'success', true,
    'profile_id', v_profile.id,
    'session_id', v_session.id,
    'expires_at', v_session.expires_at
  );
end;
$$;

create function logout()
returns void
language sql
security definer
as $$
  update sessions set revoked_at = now()
  where id = current_session_id() and revoked_at is null;
$$;

-- ---------------------------------------------------------------------
-- Auto-provision a profile when an admin creates the underlying auth.users
-- row via the Admin API (see supabase/functions/admin-create-user). This is
-- the standard Supabase pattern for syncing auth.users -> a public table.
-- ---------------------------------------------------------------------

create function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, full_name, email, role, area, company_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'role', '')::user_role, 'colaborador'),
    coalesce(new.raw_user_meta_data ->> 'area', ''),
    (new.raw_user_meta_data ->> 'company_id')::uuid
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

-- verify_login must be callable before the caller has any session at all.
grant execute on function verify_login(text, text) to anon, authenticated;
grant execute on function set_pin(uuid, text) to authenticated;
grant execute on function logout() to authenticated;

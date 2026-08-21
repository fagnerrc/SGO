-- SGO on Supabase — fix a real bug found by `supabase db lint` after
-- deploying to a live project: this Supabase project (like most, by
-- default) installs pgcrypto into an `extensions` schema, not `public`.
-- set_pin()/verify_login()/bootstrap_set_initial_pin() call crypt()/
-- gen_salt() without `extensions` on their search_path, so — despite
-- creating successfully (CREATE FUNCTION doesn't validate the function
-- calls inside a plpgsql body) — every one of them would fail at the
-- first actual login or PIN-set attempt with "function crypt(text, text)
-- does not exist" / "function gen_salt(unknown) does not exist".
--
-- 0008 and 0012 (where these were first defined) had already been applied
-- to the live project by the time this was caught, so the fix has to be a
-- forward migration (CREATE OR REPLACE), not an edit to those files —
-- same reasoning as the sessions.token_hash correction in 0008 itself.
-- `extensions` is added ahead of `public` deliberately, matching how
-- Supabase's own default search_path is ordered.

create or replace function set_pin(p_profile_id uuid, p_new_pin text)
returns void
language plpgsql
security definer
set search_path = extensions, public
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

create or replace function verify_login(p_email text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = extensions, public
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

create or replace function bootstrap_set_initial_pin(p_profile_id uuid, p_new_pin text)
returns void
language plpgsql
security definer
set search_path = extensions, public
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

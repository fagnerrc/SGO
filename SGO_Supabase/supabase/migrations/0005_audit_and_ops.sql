-- SGO on Supabase — audit/activity/security logs, login attempts, sessions,
-- and the idempotency ledger.
-- Replaces: activity / audits / securityLog / errors collections in
-- V10_Database.gs, plus the login-attempt and session logic in
-- V12_SecuritySync.gs.

-- Old system had three near-identical collections (activity, audits,
-- securityLog) sharing one sheet, plus a separate ownership bug (#8: a
-- record with no owner defaulted to "the current user owns it", vacuously
-- passing the write check). Here it's one table with a `kind` column, and
-- `user_id` is set server-side from auth.uid() via default — never
-- client-supplied, so there is no blank-owner case to default-allow.
create table logs (
  id bigint generated always as identity primary key,
  company_id uuid not null references companies (id),
  kind log_kind not null,
  user_id uuid not null references profiles (id) default auth.uid(),
  task_id uuid references tasks (id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index logs_company_kind_idx on logs (company_id, kind, created_at desc);
create index logs_user_idx on logs (user_id);
create index logs_task_idx on logs (task_id);

-- Fixes bug #2 (an admin-configured 24h lockout was silently truncated to
-- 8h by an unrelated storage TTL). There is no separate expiry layer here:
-- locked_until is read and compared directly, for as long as the row
-- exists. A cleanup job may delete old rows for housekeeping, but that is
-- never what determines whether an account is currently locked.
create table login_attempts (
  email text primary key,
  failed_count integer not null default 0,
  locked_until timestamptz,
  last_attempt_at timestamptz not null default now()
);

-- Fixes bug #1 (resetting a PIN left existing sessions valid). Sessions are
-- real rows here, so a PIN reset can revoke them explicitly (revoked_at) and
-- validate_session() below is the only path that treats a session as live.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index sessions_profile_idx on sessions (profile_id);

create function revoke_sessions_for(target_profile uuid)
returns void
language sql
security definer
as $$
  update sessions set revoked_at = now()
  where profile_id = target_profile and revoked_at is null;
$$;

create function validate_session(p_token_hash text)
returns profiles
language sql
security definer
stable
as $$
  select p.* from sessions s
  join profiles p on p.id = s.profile_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.expires_at > now();
$$;

-- Idempotency ledger. Replaces appendChangeOnceV12_'s full-column
-- createTextFinder scan (done *inside* the global ScriptLock in the old
-- system) with a unique index — O(log n), no lock contention with anyone
-- else, by construction.
create table operations (
  operation_id text primary key,
  profile_id uuid not null references profiles (id),
  action text not null,
  status text not null default 'PROCESSING' check (status in ('PROCESSING', 'COMPLETED', 'FAILED')),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index operations_profile_idx on operations (profile_id, created_at desc);

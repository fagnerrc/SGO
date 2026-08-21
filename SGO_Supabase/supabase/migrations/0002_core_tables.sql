-- SGO on Supabase — companies, profiles (collaborators), processes
-- Replaces: V10_Database.gs collections 'collaborators', 'processes', and the
-- singleton 'companies' config block.

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- One row per authenticated user, 1:1 with auth.users. PIN-based login is
-- layered on top of Supabase Auth (see 0005_auth_and_ops.sql) rather than
-- replacing it, so RLS can key off auth.uid() directly.
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  email text not null unique,
  role user_role not null default 'colaborador',
  area text not null default '',
  company_id uuid not null references companies (id),
  company_access uuid[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_company_idx on profiles (company_id);
create index profiles_role_idx on profiles (role);

create table processes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  name text not null,
  segregacao boolean not null default false,          -- segregation of duties flag
  conferente_id uuid references profiles (id),
  aprovador_id uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- old bug (V10_Database.gs:855-861): executor must not equal conferente/aprovador
  -- when segregacao is on. Enforced again at write-time in the mutate_task
  -- function, but this constraint keeps the process definition itself sane.
  constraint processes_conferente_neq_aprovador check (
    conferente_id is null or aprovador_id is null or conferente_id <> aprovador_id
  )
);

create index processes_company_idx on processes (company_id);

-- Helper functions used by RLS policies across every table. SECURITY DEFINER
-- so that policies on `profiles` itself don't recurse into RLS when other
-- policies look up the caller's role/company.
create function current_profile()
returns profiles
language sql
security definer
stable
set search_path = public
as $$
  select * from profiles where id = auth.uid();
$$;

create function current_user_role()
returns user_role
language sql
security definer
stable
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create function current_company()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select company_id from profiles where id = auth.uid();
$$;

create function is_privileged()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select role in ('diretoria', 'auditoria', 'admin') from profiles where id = auth.uid()), false);
$$;

create function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on profiles
  for each row execute function touch_updated_at();

create trigger processes_touch_updated_at
  before update on processes
  for each row execute function touch_updated_at();

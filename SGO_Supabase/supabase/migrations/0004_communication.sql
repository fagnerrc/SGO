-- SGO on Supabase — chat, feedback, notifications
-- Replaces: V12_Communication.gs, V10_Communication.gs and the collections
-- 'messages', 'conversations', 'conversationReads', 'feedbacks', 'notifications'.

create table conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  type conversation_type not null,
  task_id uuid references tasks (id) on delete cascade,   -- set when type = 'task'
  area text,                                                -- set when type = 'area'
  created_at timestamptz not null default now(),
  constraint conversations_task_requires_type check (task_id is null or type = 'task'),
  constraint conversations_area_requires_type check (area is null or type = 'area')
);

create index conversations_company_idx on conversations (company_id);
create index conversations_task_idx on conversations (task_id);

-- Direct (1:1 or small-group) conversations list their members explicitly;
-- task/area conversations derive visibility from the task/area instead
-- (see 0006_rls_policies.sql) so this table only needs rows for 'direct'.
create table conversation_participants (
  conversation_id uuid not null references conversations (id) on delete cascade,
  profile_id uuid not null references profiles (id) on delete cascade,
  primary key (conversation_id, profile_id)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  author_id uuid not null references profiles (id),
  body text not null,
  created_at timestamptz not null default now()
);

create index messages_conversation_idx on messages (conversation_id, created_at);

-- Fixes the old lastReadSequence:0-treated-as-missing bug (`||` instead of a
-- null check) by not using a falsy-able sequence number at all: "nothing
-- read yet" is simply the absence of a row, not a 0 that can be confused
-- with a legitimate value.
create table conversation_reads (
  conversation_id uuid not null references conversations (id) on delete cascade,
  profile_id uuid not null references profiles (id) on delete cascade,
  last_read_message_id uuid references messages (id),
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, profile_id)
);

create table feedbacks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  task_id uuid references tasks (id) on delete set null,
  author_id uuid not null references profiles (id),
  recipient_id uuid not null references profiles (id),
  body text not null,
  created_at timestamptz not null default now()
);

create index feedbacks_recipient_idx on feedbacks (recipient_id);
create index feedbacks_task_idx on feedbacks (task_id);

-- Fixes bug #7 (record with no real task link got a fabricated taskId equal
-- to its own id, making it permanently invisible to sync) simply by making
-- task_id a real nullable FK: null means "no task", not a fake self-reference.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  recipient_id uuid not null references profiles (id),
  type notification_type not null,
  task_id uuid references tasks (id) on delete cascade,
  title text not null,
  message text not null,
  read boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  -- Fixes bug #2 in section 6 of the migration plan (dedup key omitted the
  -- recipient, so reassigning a task mid-day silently dropped the new
  -- recipient's notification). The recipient is now part of the identity.
  dedup_key text generated always as (
    type::text || ':' || coalesce(task_id::text, '') || ':' || recipient_id::text || ':' || to_char(created_at, 'YYYY-MM-DD')
  ) stored
);

create index notifications_recipient_idx on notifications (recipient_id, read);
create index notifications_task_idx on notifications (task_id);
-- One notification per (type, task, recipient, day) — replaces the old
-- recipient-less dedup key.
create unique index notifications_dedup_idx on notifications (dedup_key);

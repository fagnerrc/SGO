-- SGO on Supabase — Phase 4: chat, feedback, and notification generation
-- Replaces: createAutomaticNotifications_ (V10_Communication.gs) — in the
-- old system this function existed but was never called from anywhere, so
-- TASK_ASSIGNED/FEEDBACK_RECEIVED/TASK_MESSAGE/MESSAGE_RECEIVED/MENTION
-- notifications never actually fired (bug #6). Here, notification creation
-- is wired directly into AFTER INSERT/UPDATE triggers on the tables that
-- cause it — a task being assigned, a feedback row landing, a message being
-- sent — so it can't be "forgotten" the way a plain function call was.
--
-- Design note carried over from 0004: `notifications.dedup_key` was
-- originally `type:task_id:recipient_id:day`, built to stop a repeating
-- background job (deadline checks, phase 5) from spamming the same
-- notification every run. Applying that same day-bucket to *event-driven*
-- notifications (a chat message, a piece of feedback) was wrong — two
-- different direct conversations to the same person on the same day would
-- have collided into one silently-dropped notification, since neither
-- conversation_id nor a message id were part of the key. Fixed below by
-- adding `source_id` (the causing row's own id — already unique) and using
-- it ahead of `task_id` in the key. Event-driven notifications end up
-- effectively never deduped against each other (each source row is unique
-- by construction); the day-bucket behavior is preserved for phase 5's
-- scheduled notifications, which have no single source row and pass
-- source_id = null.

alter table notifications add column source_id uuid;

-- dedup_key (0004) is a plain column set by a BEFORE INSERT trigger, not a
-- generated column (see 0004's comment on why: to_char() on a timestamp
-- isn't IMMUTABLE, which a generated column's expression is required to
-- be). That means picking up source_id here only requires replacing the
-- trigger function's body — no column drop/recreate, no index rebuild.
create or replace function set_notification_dedup_key()
returns trigger
language plpgsql
as $$
begin
  new.dedup_key := new.type::text || ':' || coalesce(new.source_id::text, new.task_id::text, '') || ':' || new.recipient_id::text || ':' || to_char(new.created_at, 'YYYY-MM-DD');
  return new;
end;
$$;

-- One conversation per task, one per (company, area) — get_or_create
-- functions below rely on these to be race-safe.
create unique index conversations_one_per_task on conversations (task_id) where type = 'task';
create unique index conversations_one_per_area on conversations (company_id, area) where type = 'area';

-- feedbacks was missing an insert policy entirely in 0006 (only select was
-- defined) — a simple, rule-free append like messages/task_comments, so it
-- gets a direct RLS-checked policy rather than a wrapping function.
create policy feedbacks_insert on feedbacks for insert
  with check (
    author_id = auth.uid()
    and company_id = current_company()
    and exists (select 1 from profiles where id = recipient_id and company_id = current_company())
  );

-- ---------------------------------------------------------------------
-- Notification triggers
-- ---------------------------------------------------------------------

create function notify_task_assigned()
returns trigger
language plpgsql
security definer
as $$
begin
  if tg_op = 'INSERT' then
    insert into notifications (company_id, recipient_id, type, task_id, source_id, title, message)
      values (new.company_id, new.responsavel_id, 'TASK_ASSIGNED', new.id, new.id,
        'Nova tarefa atribuída', 'Você foi designado para ' || coalesce(new.code, new.titulo))
      on conflict (dedup_key) do nothing;
  elsif new.responsavel_id is distinct from old.responsavel_id then
    insert into notifications (company_id, recipient_id, type, task_id, source_id, title, message)
      values (new.company_id, new.responsavel_id, 'TASK_ASSIGNED', new.id, new.id,
        'Tarefa reatribuída a você', 'Você foi designado para ' || coalesce(new.code, new.titulo))
      on conflict (dedup_key) do nothing;
  end if;
  return new;
end;
$$;

create trigger tasks_notify_assigned
  after insert or update of responsavel_id on tasks
  for each row execute function notify_task_assigned();

create function notify_feedback()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into notifications (company_id, recipient_id, type, task_id, source_id, title, message)
    values (new.company_id, new.recipient_id, 'FEEDBACK_RECEIVED', new.task_id, new.id,
      'Novo feedback recebido', left(new.body, 200))
    on conflict (dedup_key) do nothing;
  return new;
end;
$$;

create trigger feedbacks_notify
  after insert on feedbacks
  for each row execute function notify_feedback();

create function notify_message()
returns trigger
language plpgsql
security definer
as $$
declare
  v_conv conversations;
  v_task tasks;
  v_participants uuid[];
  v_recipient uuid;
begin
  select * into v_conv from conversations where id = new.conversation_id;

  if v_conv.type = 'direct' then
    select array_agg(profile_id) into v_participants
      from conversation_participants
      where conversation_id = v_conv.id and profile_id <> new.author_id;
    if v_participants is not null then
      foreach v_recipient in array v_participants loop
        insert into notifications (company_id, recipient_id, type, task_id, source_id, title, message)
          values (v_conv.company_id, v_recipient, 'MESSAGE_RECEIVED', null, new.id, 'Nova mensagem', left(new.body, 200))
          on conflict (dedup_key) do nothing;
      end loop;
    end if;
  elsif v_conv.type = 'task' then
    select * into v_task from tasks where id = v_conv.task_id;
    if found then
      select array_agg(distinct p) into v_participants
        from unnest(array[v_task.responsavel_id, v_task.solicitante_id] || v_task.participantes) p
        where p is not null and p <> new.author_id;
      if v_participants is not null then
        foreach v_recipient in array v_participants loop
          insert into notifications (company_id, recipient_id, type, task_id, source_id, title, message)
            values (v_conv.company_id, v_recipient, 'TASK_MESSAGE', v_task.id, new.id, 'Nova mensagem na tarefa', left(new.body, 200))
            on conflict (dedup_key) do nothing;
        end loop;
      end if;
    end if;
  end if;
  -- 'area' conversations are a broadcast channel; deliberately no
  -- per-message notification fan-out to an entire area on every message.

  if new.mentioned_ids is not null then
    foreach v_recipient in array new.mentioned_ids loop
      if v_recipient <> new.author_id then
        insert into notifications (company_id, recipient_id, type, task_id, source_id, title, message)
          values (v_conv.company_id, v_recipient, 'MENTION', v_conv.task_id, new.id, 'Você foi mencionado', left(new.body, 200))
          on conflict (dedup_key) do nothing;
      end if;
    end loop;
  end if;

  return new;
end;
$$;

create trigger messages_notify
  after insert on messages
  for each row execute function notify_message();

-- Client-populated mention list (the app's own mention-picker UI resolves
-- "@name" to a profile id before sending), rather than regex-parsing
-- "@name" out of free text server-side, which is fragile and
-- locale-dependent.
alter table messages add column mentioned_ids uuid[] not null default '{}';

-- ---------------------------------------------------------------------
-- Chat: conversation lookup/creation. Sending a message itself stays a
-- direct client insert against the existing messages_insert RLS policy
-- (0006) — it's a rule-free append once you already have a conversation_id
-- you're allowed to post into. Getting that conversation_id is the part
-- with rules (must-be-a-participant, one-per-task, etc.), so it's a
-- function like phase 2's task mutations.
-- ---------------------------------------------------------------------

create function can_view_conversation(c conversations)
returns boolean
language sql
security definer
stable
as $$
  select c.company_id = current_company()
    and (
      (c.type = 'direct' and exists (
        select 1 from conversation_participants cp where cp.conversation_id = c.id and cp.profile_id = auth.uid()
      ))
      or (c.type = 'task' and exists (
        select 1 from tasks t where t.id = c.task_id and can_mutate_task(t)
      ))
      or (c.type = 'area' and c.area <> '' and c.area = (select area from profiles where id = auth.uid() and area <> ''))
      or is_privileged()
    );
$$;

create function get_or_create_task_conversation(p_task_id uuid)
returns uuid
language plpgsql
security definer
as $$
declare
  v_task tasks;
  v_conv_id uuid;
begin
  select * into v_task from tasks where id = p_task_id;
  if not found then
    raise exception 'SGO_NOT_FOUND: task % does not exist', p_task_id;
  end if;
  if not can_mutate_task(v_task) then
    raise exception 'SGO_FORBIDDEN: caller may not access task %', p_task_id;
  end if;

  select id into v_conv_id from conversations where task_id = p_task_id and type = 'task';
  if v_conv_id is not null then
    return v_conv_id;
  end if;

  insert into conversations (company_id, type, task_id) values (v_task.company_id, 'task', p_task_id)
    returning id into v_conv_id;
  return v_conv_id;
exception when unique_violation then
  select id into v_conv_id from conversations where task_id = p_task_id and type = 'task';
  return v_conv_id;
end;
$$;

create function get_or_create_area_conversation(p_area text)
returns uuid
language plpgsql
security definer
as $$
declare
  v_company uuid := current_company();
  v_conv_id uuid;
begin
  if coalesce(trim(p_area), '') = '' then
    raise exception 'SGO_INVALID_AREA: area must not be empty';
  end if;

  select id into v_conv_id from conversations where company_id = v_company and area = p_area and type = 'area';
  if v_conv_id is not null then
    return v_conv_id;
  end if;

  insert into conversations (company_id, type, area) values (v_company, 'area', p_area)
    returning id into v_conv_id;
  return v_conv_id;
exception when unique_violation then
  select id into v_conv_id from conversations where company_id = v_company and area = p_area and type = 'area';
  return v_conv_id;
end;
$$;

create function create_direct_conversation(p_other_profile_id uuid)
returns uuid
language plpgsql
security definer
as $$
declare
  v_company uuid := current_company();
  v_conv_id uuid;
  v_lock_key text;
begin
  if p_other_profile_id = auth.uid() then
    raise exception 'SGO_INVALID_PARTICIPANT: cannot start a direct conversation with yourself';
  end if;
  if not exists (select 1 from profiles where id = p_other_profile_id and company_id = v_company) then
    raise exception 'SGO_INVALID_PARTICIPANT: participant is not in the caller company';
  end if;

  -- Serialize both directions of the same pair so two simultaneous
  -- "start chat" clicks can't create two separate direct conversations.
  v_lock_key := least(auth.uid()::text, p_other_profile_id::text) || ':' || greatest(auth.uid()::text, p_other_profile_id::text);
  perform pg_advisory_xact_lock(hashtext(v_lock_key));

  select cp1.conversation_id into v_conv_id
    from conversation_participants cp1
    join conversation_participants cp2 on cp2.conversation_id = cp1.conversation_id
    join conversations c on c.id = cp1.conversation_id
    where c.type = 'direct' and cp1.profile_id = auth.uid() and cp2.profile_id = p_other_profile_id;

  if v_conv_id is not null then
    return v_conv_id;
  end if;

  insert into conversations (company_id, type) values (v_company, 'direct') returning id into v_conv_id;
  insert into conversation_participants (conversation_id, profile_id) values (v_conv_id, auth.uid()), (v_conv_id, p_other_profile_id);
  return v_conv_id;
end;
$$;

create function mark_conversation_read(p_conversation_id uuid, p_message_id uuid default null)
returns void
language plpgsql
security definer
as $$
declare
  v_conv conversations;
begin
  select * into v_conv from conversations where id = p_conversation_id;
  if not found or not can_view_conversation(v_conv) then
    raise exception 'SGO_NOT_FOUND: conversation % does not exist or is not visible', p_conversation_id;
  end if;

  insert into conversation_reads (conversation_id, profile_id, last_read_message_id, last_read_at)
    values (p_conversation_id, auth.uid(), p_message_id, now())
    on conflict (conversation_id, profile_id) do update
      set last_read_message_id = coalesce(excluded.last_read_message_id, conversation_reads.last_read_message_id),
          last_read_at = now();
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------

grant execute on function
  get_or_create_task_conversation(uuid),
  get_or_create_area_conversation(text),
  create_direct_conversation(uuid),
  mark_conversation_read(uuid, uuid)
to authenticated;

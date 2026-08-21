-- SGO on Supabase — Row Level Security
-- Replaces: canWriteRecordV10_ (V10_Database.gs) and visibilityForRecordV12_ /
-- changeVisibleToUserV12_ / userCanSeeConversationV12_ (V12_SecuritySync.gs).
--
-- Design: RLS controls what a client can SELECT. For anything with real
-- business rules on write (tasks, notifications, logs, sessions, operations,
-- login attempts) there is deliberately NO insert/update/delete grant for
-- the `authenticated` role at all — every mutation goes through a
-- SECURITY DEFINER function (0007_task_functions.sql onward), which enforces
-- the rule and then performs the write with elevated privilege. A bare
-- `update tasks ...` from a client has nothing to succeed against; this is
-- what makes bug #4 (generic update reaching a gated status) structurally
-- impossible here rather than just checked in application code.
-- Simple, rule-free appends (chat messages, task comments, read receipts)
-- get a direct RLS-checked INSERT policy instead — there's no gate to
-- bypass for those.

alter table companies enable row level security;
alter table profiles enable row level security;
alter table processes enable row level security;
alter table tasks enable row level security;
alter table task_checklist_items enable row level security;
alter table task_history enable row level security;
alter table task_comments enable row level security;
alter table task_links enable row level security;
alter table task_timer_sessions enable row level security;
alter table conversations enable row level security;
alter table conversation_participants enable row level security;
alter table messages enable row level security;
alter table conversation_reads enable row level security;
alter table feedbacks enable row level security;
alter table notifications enable row level security;
alter table logs enable row level security;
alter table login_attempts enable row level security;
alter table sessions enable row level security;
alter table operations enable row level security;

-- ---------------------------------------------------------------------
-- companies / profiles / processes
-- ---------------------------------------------------------------------

-- `x = ANY (subquery)` has special grammar when the right side is literally
-- a subquery: Postgres expects the subquery to yield multiple rows of a
-- scalar type to compare against, not one row containing an array value —
-- `(select company_access from profiles ...)` returns a single uuid[] row,
-- which this form can't use ("operator does not exist: uuid = uuid[]").
-- unnest() turns it into what that grammar actually expects: one row per
-- array element.
create policy companies_select on companies for select
  using (id = current_company() or id = any (select unnest(company_access) from profiles where id = auth.uid()));

create policy profiles_select on profiles for select
  using (company_id = current_company() or company_id = any (select unnest(company_access) from profiles where id = auth.uid()));

create policy processes_select on processes for select
  using (company_id = current_company());

-- ---------------------------------------------------------------------
-- tasks and children: visible to solicitante, responsável, participante,
-- any gestor of the same area/company, or a privileged role (diretoria /
-- auditoria / admin). No write grants here on purpose (see header note).
-- ---------------------------------------------------------------------

create policy tasks_select on tasks for select
  using (
    company_id = current_company()
    and (
      solicitante_id = auth.uid()
      or responsavel_id = auth.uid()
      or auth.uid() = any (participantes)
      or is_privileged()
      or (current_user_role() = 'gestor' and area = (select area from profiles where id = auth.uid()))
      -- the process's designated approver can see the task even if they're
      -- outside its area/participants (e.g. a director approving a request
      -- from another department) — must stay in sync with the approver
      -- check in approve_task()/reject_task() (0007_task_functions.sql)
      or exists (
        select 1 from processes pr where pr.id = tasks.process_id and pr.aprovador_id = auth.uid()
      )
    )
  );

create policy task_checklist_items_select on task_checklist_items for select
  using (exists (select 1 from tasks t where t.id = task_id));

create policy task_history_select on task_history for select
  using (exists (select 1 from tasks t where t.id = task_id));

create policy task_comments_select on task_comments for select
  using (exists (select 1 from tasks t where t.id = task_id));

create policy task_comments_insert on task_comments for insert
  with check (author_id = auth.uid() and exists (select 1 from tasks t where t.id = task_id));

create policy task_links_select on task_links for select
  using (exists (select 1 from tasks t where t.id = task_id));

create policy task_timer_sessions_select on task_timer_sessions for select
  using (exists (select 1 from tasks t where t.id = task_id));

-- Note: the four "children select" policies above rely on Postgres
-- evaluating `exists (select 1 from tasks ...)` under the querying user's
-- own RLS-filtered view of `tasks` — so a child row is visible exactly when
-- its parent task is visible, with no separate visibility logic to keep in
-- sync (unlike the old system's per-collection visibilityForRecordV12_).

-- ---------------------------------------------------------------------
-- conversations / messages
-- ---------------------------------------------------------------------

create policy conversations_select on conversations for select
  using (
    company_id = current_company()
    and (
      (type = 'direct' and exists (
        select 1 from conversation_participants cp
        where cp.conversation_id = id and cp.profile_id = auth.uid()
      ))
      or (type = 'task' and exists (select 1 from tasks t where t.id = task_id))
      -- Fixes the empty-area-matches-empty-area bug: both sides must be a
      -- real, non-empty area, not just equal.
      or (type = 'area' and area <> '' and area = (select area from profiles where id = auth.uid() and area <> ''))
      or is_privileged()
    )
  );

create policy conversation_participants_select on conversation_participants for select
  using (profile_id = auth.uid() or exists (
    select 1 from conversations c where c.id = conversation_id
  ));

create policy messages_select on messages for select
  using (exists (select 1 from conversations c where c.id = conversation_id));

create policy messages_insert on messages for insert
  with check (
    author_id = auth.uid()
    and exists (select 1 from conversations c where c.id = conversation_id)
  );

create policy conversation_reads_select on conversation_reads for select
  using (profile_id = auth.uid());

create policy conversation_reads_upsert on conversation_reads for insert
  with check (profile_id = auth.uid());

create policy conversation_reads_update on conversation_reads for update
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- ---------------------------------------------------------------------
-- feedbacks / notifications
-- ---------------------------------------------------------------------

create policy feedbacks_select on feedbacks for select
  using (author_id = auth.uid() or recipient_id = auth.uid() or is_privileged());

create policy notifications_select on notifications for select
  using (recipient_id = auth.uid());

-- Users may only mark their own notification read — never edit its content.
-- Fixes bug where the old 'notifications' branch of canWriteRecordV10_ had
-- no field allowlist at all for the record's own owner.
create policy notifications_mark_read on notifications for update
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

-- ---------------------------------------------------------------------
-- logs / login_attempts / sessions / operations — no client writes.
-- Regular users read only their own 'activity' rows; privileged roles read
-- everything in their company (audits, security log included).
-- ---------------------------------------------------------------------

create policy logs_select on logs for select
  using (
    company_id = current_company()
    and (is_privileged() or (kind = 'activity' and user_id = auth.uid()))
  );

-- login_attempts / sessions: no policies at all beyond RLS-enabled-with-no-
-- policy, which defaults to deny-all for `authenticated`/`anon`. Only
-- SECURITY DEFINER functions (which bypass RLS) can read or write these.

create policy operations_select on operations for select
  using (profile_id = auth.uid());

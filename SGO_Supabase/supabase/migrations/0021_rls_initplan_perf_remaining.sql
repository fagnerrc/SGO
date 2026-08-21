-- SGO on Supabase — the rest of the auth_rls_initplan findings from
-- `db advisors` (0017 only covered companies_select/profiles_select; a
-- full advisor run afterward found 14 more policies with the same direct
-- `auth.uid()` pattern). Same fix throughout: wrap `auth.uid()` as
-- `(select auth.uid())` so Postgres's planner evaluates it once per
-- statement (an initplan) instead of once per row scanned.
--
-- Not touched here, deliberately: calls to this project's own helper
-- functions (`current_company()`, `is_privileged()`, `current_user_role()`)
-- also call auth.uid() internally and have the same theoretical per-row
-- cost, but the advisor doesn't flag them (it only pattern-matches literal
-- `auth.<function>()` calls, not calls to functions that happen to wrap
-- one) — left alone to keep this fix scoped to what was actually measured
-- as a problem, not a speculative rewrite of everything that could
-- theoretically be marginally faster.

alter policy tasks_select on tasks
  using (
    company_id = current_company()
    and (
      solicitante_id = (select auth.uid())
      or responsavel_id = (select auth.uid())
      or (select auth.uid()) = any (participantes)
      or is_privileged()
      or (current_user_role() = 'gestor' and area = (select area from profiles where id = (select auth.uid())))
      or exists (
        select 1 from processes pr where pr.id = tasks.process_id and pr.aprovador_id = (select auth.uid())
      )
    )
  );

alter policy task_comments_insert on task_comments
  with check (author_id = (select auth.uid()) and exists (select 1 from tasks t where t.id = task_id));

alter policy feedbacks_select on feedbacks
  using (author_id = (select auth.uid()) or recipient_id = (select auth.uid()) or is_privileged());

alter policy feedbacks_insert on feedbacks
  with check (
    author_id = (select auth.uid())
    and company_id = current_company()
    and exists (select 1 from profiles where id = recipient_id and company_id = current_company())
  );

alter policy conversations_select on conversations
  using (
    company_id = current_company()
    and (
      (type = 'direct' and exists (
        select 1 from conversation_participants cp
        where cp.conversation_id = id and cp.profile_id = (select auth.uid())
      ))
      or (type = 'task' and exists (select 1 from tasks t where t.id = task_id))
      or (type = 'area' and area <> '' and area = (select area from profiles where id = (select auth.uid()) and area <> ''))
      or is_privileged()
    )
  );

alter policy conversation_participants_select on conversation_participants
  using (profile_id = (select auth.uid()) or exists (
    select 1 from conversations c where c.id = conversation_id
  ));

alter policy messages_insert on messages
  with check (
    author_id = (select auth.uid())
    and exists (select 1 from conversations c where c.id = conversation_id)
  );

alter policy conversation_reads_select on conversation_reads
  using (profile_id = (select auth.uid()));

alter policy conversation_reads_upsert on conversation_reads
  with check (profile_id = (select auth.uid()));

alter policy conversation_reads_update on conversation_reads
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

alter policy notifications_select on notifications
  using (recipient_id = (select auth.uid()));

alter policy notifications_mark_read on notifications
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));

alter policy logs_select on logs
  using (
    company_id = current_company()
    and (is_privileged() or (kind = 'activity' and user_id = (select auth.uid())))
  );

alter policy operations_select on operations
  using (profile_id = (select auth.uid()));

-- SGO on Supabase — three more real bugs found by running functional
-- tests end-to-end (task lifecycle, approval flow, chat).

-- ---------------------------------------------------------------------
-- Bug: task_checklist_items_update (0011) calls can_mutate_task(t)
-- directly in its RLS USING/WITH CHECK clause — that runs as the
-- QUERYING role, which needs EXECUTE on the function, not as a definer.
-- 0013/0016 revoked can_mutate_task from authenticated as part of the
-- "internal helper, not meant to be called directly" cleanup — correct
-- for most of that list, wrong for this one specifically, since an RLS
-- policy invoking it directly makes it exactly as public as
-- current_company()/is_privileged(), which were deliberately never
-- revoked for the same reason. Confirmed broken live: toggling a
-- checklist item failed with "permission denied for function
-- can_mutate_task".
-- ---------------------------------------------------------------------

grant execute on function can_mutate_task(tasks) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Bug: infinite recursion on `conversations` when inserting a message.
-- Same class of bug as 0023 (profiles), different pair of tables:
-- conversations_select's 'direct' clause queries conversation_participants
-- (to check membership); conversation_participants_select's fallback
-- clause queried conversations right back
-- (`exists (select 1 from conversations c where c.id = conversation_id)`)
-- — a two-table cycle instead of a single-table self-reference, but the
-- same underlying problem: a plain subquery in a policy body runs as the
-- querying role and re-triggers RLS on what it touches. Fixed the same
-- way as 0023: move the "which conversations do I participate in" lookup
-- into a SECURITY DEFINER function, breaking the cycle. This also
-- preserves the original intent (see other participants of a conversation
-- you're in, not just your own row) that a naive `profile_id = auth.uid()`
-- -only policy would have lost.
-- ---------------------------------------------------------------------

create function my_conversation_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select conversation_id from conversation_participants where profile_id = auth.uid();
$$;

alter policy conversation_participants_select on conversation_participants
  using (
    profile_id = (select auth.uid())
    or conversation_id in (select my_conversation_ids())
    or is_privileged()
  );

-- ---------------------------------------------------------------------
-- Bug: tasks_waiting_fields_required (0003) required aguardando_quem to
-- be non-empty for BOTH 'Aguardando terceiro' and 'Aguardando aprovação'.
-- That's right for "waiting on a third party" (an arbitrary free-text
-- name), but 'Aguardando aprovação' already has a structured link to who's
-- deciding — the linked process's aprovador_id — so approval_wait_task()
-- (0007) never populated aguardando_quem, and every real call failed the
-- CHECK constraint. Confirmed live: "new row for relation tasks violates
-- check constraint tasks_waiting_fields_required".
-- ---------------------------------------------------------------------

alter table tasks drop constraint tasks_waiting_fields_required;

alter table tasks add constraint tasks_waiting_fields_required check (
  status <> 'Aguardando terceiro' or (aguardando_quem <> '' and aguardando_desde is not null)
);

alter table tasks add constraint tasks_approval_wait_requires_date check (
  status <> 'Aguardando aprovação' or aguardando_desde is not null
);

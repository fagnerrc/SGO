-- SGO on Supabase — small fix found while building the frontend (phase 6):
-- task_checklist_items had a SELECT policy (0006) but no way for anyone to
-- actually check an item off. create_task() (0007) is the only writer so
-- far, via SECURITY DEFINER. This is a simple, rule-free toggle — same
-- category as messages_insert/task_comments_insert/feedbacks_insert — so it
-- gets a direct RLS policy rather than a wrapping function: anyone who can
-- mutate the parent task can flip `feito`, nothing else about the row.

create policy task_checklist_items_update on task_checklist_items for update
  using (exists (select 1 from tasks t where t.id = task_id and can_mutate_task(t)))
  with check (exists (select 1 from tasks t where t.id = task_id and can_mutate_task(t)));

-- RLS policies only filter which ROWS are affected, not which COLUMNS —
-- narrow the grant itself so the only thing this policy actually lets a
-- client change is the checkbox, not `texto`/`position`. Supabase's default
-- project setup grants broad table-level DML to `authenticated` and relies
-- on RLS as the real gate (which is why no other table in this migration
-- set needed an explicit GRANT before now); this is the one column where
-- that default is wider than intended, so it's narrowed explicitly here.
revoke update on task_checklist_items from authenticated;
grant update (feito) on task_checklist_items to authenticated;

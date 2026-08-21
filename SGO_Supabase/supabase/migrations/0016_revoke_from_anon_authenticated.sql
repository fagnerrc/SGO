-- SGO on Supabase — fix a real bug found by directly querying the live
-- database after 0013: `REVOKE EXECUTE ... FROM PUBLIC` did NOT actually
-- block anon/authenticated from calling claim_operation/complete_operation/
-- fail_operation/lock_task/etc. `has_function_privilege('anon', ...,
-- 'EXECUTE')` still returned true after 0013 was applied.
--
-- Root cause: Supabase provisions new projects with an
-- `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon,
-- authenticated, service_role` rule on the `public` schema — a role-specific
-- grant that fires automatically for every newly created function,
-- independent of Postgres's own "PUBLIC gets EXECUTE by default" behavior.
-- 0013 revoked the PUBLIC grant, which was real but not the (bigger) one
-- actually gating access here. `db advisors` kept flagging these functions
-- as anon/authenticated-executable after 0013 for the same reason — that
-- flag was correct, not stale.
--
-- The fix is to name the roles explicitly. `service_role` is deliberately
-- left with EXECUTE — it's the trusted backend key, not exposed to
-- end-user clients, and revoking from it isn't needed for the same reason
-- REVOKE FROM PUBLIC wasn't sufficient: it's a real, separate grant this
-- migration has no reason to touch.

revoke execute on function claim_operation(text, text) from anon, authenticated;
revoke execute on function complete_operation(text, jsonb) from anon, authenticated;
revoke execute on function fail_operation(text) from anon, authenticated;
revoke execute on function lock_task(uuid) from anon, authenticated;
revoke execute on function lock_task_for_approval(uuid) from anon, authenticated;
revoke execute on function can_mutate_task(tasks) from anon, authenticated;
revoke execute on function task_summary(tasks) from anon, authenticated;
revoke execute on function can_view_conversation(conversations) from anon, authenticated;
revoke execute on function generate_daily_tasks() from anon, authenticated;
revoke execute on function generate_deadline_notifications() from anon, authenticated;

-- handle_new_auth_user() is a trigger function (fires on auth.users
-- insert), never meant to be called directly at all — 0013 didn't cover it
-- since trigger functions are normally uncallable via SQL regardless of
-- grants, but the advisor flagged it as anon/authenticated-executable too,
-- meaning Supabase's REST layer doesn't apply that trigger-only
-- restriction the same way plain SQL does. Revoke here for the same
-- least-privilege reason as everything else in this file, even though the
-- practical exploitability is low (calling it as a bare function, with no
-- `NEW`/`OLD` row available, fails immediately regardless of grants).
revoke execute on function handle_new_auth_user() from anon, authenticated;

-- SGO on Supabase — close a real gap found during a validation pass after
-- phase 7: Postgres grants EXECUTE on every new function to PUBLIC by
-- default, unless explicitly revoked. Every migration so far assumed
-- "internal helper functions I never explicitly GRANT stay uncallable by
-- clients" (stated as fact in comments across 0007/0009/0010) — that
-- assumption was wrong. Anything not a trigger function (trigger functions
-- are safe automatically; Postgres refuses to call them outside trigger
-- context) has been directly callable via PostgREST RPC by `anon`/
-- `authenticated` this whole time.
--
-- Concretely, before this migration, any authenticated client could call:
--   - complete_operation(any_operation_id, forged_result) — poison the
--     idempotency cache for an operation belonging to a different user
--     with fabricated data.
--   - fail_operation(any_operation_id) — mark someone else's in-flight
--     operation as failed.
--   - claim_operation(any_operation_id, action) — squat on an operation_id
--     before the legitimate request reaches it.
--   - generate_daily_tasks() / generate_deadline_notifications() — trigger
--     either scheduled job on demand instead of only via pg_cron.
--
-- None of these were exploitable through the RLS-protected tables
-- themselves (RLS was and is correct); the gap was specifically that these
-- functions' own logic — not RLS — was the only thing standing between a
-- client and those side effects, and that logic was reachable when it
-- shouldn't have been callable at all.
--
-- The RLS helper functions (current_profile/current_user_role/
-- current_company/is_privileged/session_is_valid/current_session_id) are
-- deliberately NOT revoked here: RLS policy expressions are evaluated as
-- the querying role, so revoking EXECUTE on those would break every policy
-- that calls them. Being directly callable is harmless for these
-- specifically — each only reports information about the calling user's
-- own session/role, nothing that crosses a permission boundary.

revoke execute on function claim_operation(text, text) from public;
revoke execute on function complete_operation(text, jsonb) from public;
revoke execute on function fail_operation(text) from public;
revoke execute on function lock_task(uuid) from public;
revoke execute on function lock_task_for_approval(uuid) from public;
revoke execute on function can_mutate_task(tasks) from public;
revoke execute on function task_summary(tasks) from public;
revoke execute on function can_view_conversation(conversations) from public;
revoke execute on function generate_daily_tasks() from public;
revoke execute on function generate_deadline_notifications() from public;

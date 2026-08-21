-- SGO on Supabase — fix a real finding from `supabase db advisors`
-- (security, WARN, "function_search_path_mutable") against the live
-- project: every function below was created without an explicit
-- `search_path`, which the postgres role's default search_path fills in at
-- CALL time rather than DEFINITION time. For a `SECURITY DEFINER` function
-- especially, that's a real risk: a caller able to create objects in a
-- schema that happens to sit earlier on their own session's search_path
-- could shadow a table/function this code references unqualified, and have
-- the function unknowingly operate on the attacker's object instead of the
-- real one. Pinning `search_path = public` (or `extensions, public` for the
-- three functions already fixed in 0014) removes that degree of freedom
-- entirely — an ALTER, not a rewrite, since none of these functions'
-- bodies need to change.
--
-- A few of these aren't SECURITY DEFINER (the trigger functions, mainly)
-- and so aren't exploitable the same way, but are pinned too for
-- consistency and because the advisor doesn't distinguish — an unpinned
-- search_path is also just fragile in its own right (a future session-level
-- search_path change elsewhere could alter behavior silently).

alter function approval_wait_task(uuid, text) set search_path = public;
alter function approve_task(uuid, text) set search_path = public;
alter function assign_task_code() set search_path = public;
alter function bootstrap_company(text) set search_path = public;
alter function can_bootstrap() set search_path = public;
alter function can_mutate_task(tasks) set search_path = public;
alter function can_view_conversation(conversations) set search_path = public;
alter function cancel_task(uuid, text, text) set search_path = public;
alter function claim_operation(text, text) set search_path = public;
alter function complete_operation(text, jsonb) set search_path = public;
alter function complete_task(uuid, text, text, text) set search_path = public;
alter function create_direct_conversation(uuid) set search_path = public;
alter function create_task(text, text, text, uuid, text, text, uuid, uuid[], timestamptz, numeric, text, text, text[]) set search_path = public;
alter function create_task_template(text, text, uuid, time, text, text, uuid, uuid[], numeric, text, text, text[]) set search_path = public;
alter function current_session_id() set search_path = public;
alter function enforce_task_transition() set search_path = public;
alter function fail_operation(text) set search_path = public;
alter function generate_daily_tasks() set search_path = public;
alter function generate_deadline_notifications() set search_path = public;
alter function get_or_create_area_conversation(text) set search_path = public;
alter function get_or_create_task_conversation(uuid) set search_path = public;
alter function lock_task(uuid) set search_path = public;
alter function lock_task_for_approval(uuid) set search_path = public;
alter function logout() set search_path = public;
alter function mark_conversation_read(uuid, uuid) set search_path = public;
alter function notify_feedback() set search_path = public;
alter function notify_message() set search_path = public;
alter function notify_task_assigned() set search_path = public;
alter function pause_task(uuid, text) set search_path = public;
alter function reject_task(uuid, text, text) set search_path = public;
alter function report_client_error(text, jsonb) set search_path = public;
alter function resume_task(uuid, text) set search_path = public;
alter function revoke_sessions_for(uuid) set search_path = public;
alter function set_notification_dedup_key() set search_path = public;
alter function set_profile_active(uuid, boolean) set search_path = public;
alter function set_profile_role(uuid, user_role) set search_path = public;
alter function set_task_template_active(uuid, boolean) set search_path = public;
alter function start_task(uuid, text) set search_path = public;
alter function task_summary(tasks) set search_path = public;
alter function touch_updated_at() set search_path = public;
alter function update_company_settings(integer, integer) set search_path = public;
alter function update_task(uuid, text, jsonb) set search_path = public;
alter function validate_session(text) set search_path = public;
alter function wait_task(uuid, text, text, text) set search_path = public;

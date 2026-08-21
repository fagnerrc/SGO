-- SGO on Supabase — same root cause as 0016, wider blast radius: every
-- function this project ever granted "to authenticated" (0007, 0008, 0009,
-- 0010, 0012) turned out to ALSO be callable by `anon`, because Supabase's
-- per-project default-privileges rule grants EXECUTE to anon AND
-- authenticated AND service_role on every new function in `public`
-- automatically — `GRANT ... TO authenticated` only ADDS a redundant grant,
-- it never narrows what anon already has. Confirmed directly against the
-- live database with `has_function_privilege('anon', ..., 'EXECUTE')`
-- returning true for all 22 functions below before this migration.
--
-- Practical impact was limited — every one of these functions derives its
-- own authorization from auth.uid()/current_company()/is_privileged(),
-- which all resolve to null/false for a genuinely anonymous caller, so an
-- anon call was already rejected by the function's own logic (SGO_FORBIDDEN
-- or a null company_id violating a NOT NULL constraint) rather than
-- silently succeeding. This closes it at the access-control layer anyway,
-- least-privilege, rather than relying on every function's internal check
-- being correct forever.
--
-- verify_login/can_bootstrap/bootstrap_company/bootstrap_set_initial_pin
-- are NOT in this list — those are intentionally anon-callable (login and
-- first-project bootstrap both happen before any session exists).

revoke execute on function
  start_task(uuid, text),
  pause_task(uuid, text),
  resume_task(uuid, text),
  wait_task(uuid, text, text, text),
  approval_wait_task(uuid, text),
  complete_task(uuid, text, text, text),
  cancel_task(uuid, text, text),
  approve_task(uuid, text),
  reject_task(uuid, text, text),
  update_task(uuid, text, jsonb),
  create_task(text, text, text, uuid, text, text, uuid, uuid[], timestamptz, numeric, text, text, text[])
from anon;

revoke execute on function set_pin(uuid, text), logout() from anon;

revoke execute on function
  get_or_create_task_conversation(uuid),
  get_or_create_area_conversation(text),
  create_direct_conversation(uuid),
  mark_conversation_read(uuid, uuid)
from anon;

revoke execute on function create_task_template(text, text, uuid, time, text, text, uuid, uuid[], numeric, text, text, text[]), set_task_template_active(uuid, boolean) from anon;

revoke execute on function
  update_company_settings(integer, integer),
  set_profile_role(uuid, user_role),
  set_profile_active(uuid, boolean),
  report_client_error(text, jsonb)
from anon;

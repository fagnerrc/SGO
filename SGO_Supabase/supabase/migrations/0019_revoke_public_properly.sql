-- SGO on Supabase — the actual fix 0018 was trying to make. Direct ACL
-- inspection (`select proacl from pg_proc where proname = 'create_task'`)
-- showed the real picture: `{=X/postgres,postgres=X/postgres,
-- authenticated=X/postgres,service_role=X/postgres}`. The leading `=X`
-- entry (empty role name) is the PUBLIC grant Postgres creates by default
-- for every new function — `anon` was never granted EXECUTE directly, it
-- was inheriting through PUBLIC the whole time, same as every role does.
-- 0018's `REVOKE ... FROM anon` was consequently a no-op: there was no
-- anon-specific grant to remove. Compare to claim_operation's ACL after
-- 0013, which has NO `=X` entry at all — that revoke-from-PUBLIC worked
-- correctly; 0013 just never covered this list of 22 functions, only the
-- 10 fully-internal ones.
--
-- The fix is what 0013 already proved works: revoke from PUBLIC. Once the
-- `=X` entry is gone, only the explicit `authenticated=X`/`service_role=X`
-- grants remain, and anon is correctly locked out.

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
from public;

revoke execute on function set_pin(uuid, text), logout() from public;

revoke execute on function
  get_or_create_task_conversation(uuid),
  get_or_create_area_conversation(text),
  create_direct_conversation(uuid),
  mark_conversation_read(uuid, uuid)
from public;

revoke execute on function create_task_template(text, text, uuid, time, text, text, uuid, uuid[], numeric, text, text, text[]), set_task_template_active(uuid, boolean) from public;

revoke execute on function
  update_company_settings(integer, integer),
  set_profile_role(uuid, user_role),
  set_profile_active(uuid, boolean),
  report_client_error(text, jsonb)
from public;

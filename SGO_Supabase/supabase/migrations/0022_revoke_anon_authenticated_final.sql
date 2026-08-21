-- SGO on Supabase — completes 0020. Direct ACL inspection showed two
-- independent grant mechanisms were in play the whole time, not one:
-- Postgres's own "PUBLIC gets EXECUTE by default" on function creation,
-- AND a separate Supabase default-privileges rule that explicitly grants
-- EXECUTE to anon/authenticated/service_role on every new function. 0013/
-- 0016 happened to revoke both for their target list; 0020 only revoked
-- PUBLIC for revoke_sessions_for and the trigger functions, leaving their
-- explicit anon/authenticated grants intact — confirmed by
-- `select proacl from pg_proc` still showing `anon=X`/`authenticated=X`
-- after 0020 ran. This finishes the job for the same function list.

revoke execute on function revoke_sessions_for(uuid) from anon, authenticated;

revoke execute on function
  notify_feedback(),
  notify_message(),
  notify_task_assigned(),
  touch_updated_at(),
  assign_task_code(),
  enforce_task_transition(),
  set_notification_dedup_key()
from anon, authenticated;

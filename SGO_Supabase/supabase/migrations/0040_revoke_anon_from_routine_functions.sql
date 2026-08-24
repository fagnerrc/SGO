-- SGO on Supabase — least-privilege cleanup for the Rotinas Periódicas
-- RPCs (0036). Every new function created on this project's public schema
-- picks up Supabase's default-privilege auto-grant to anon/authenticated/
-- service_role (see 0016's note on this) plus Postgres's own PUBLIC
-- default — 0036 only explicitly granted `authenticated`, so these five
-- were left anon/public-executable. Each one already checks is_admin()
-- internally (auth.uid() resolves to null for an anon caller, so is_admin()
-- is false and every call is rejected with SGO_FORBIDDEN regardless), so
-- this was never actually exploitable — but it doesn't match this
-- project's established least-privilege posture (0018/0019/0020), and
-- `db advisors` would flag it the same way it flagged the same gap
-- elsewhere. Closing it for consistency, not because of a live exploit.

revoke execute on function
  create_routine(text, text, uuid, text[], text, uuid, uuid[], text, text, text[], boolean, text[], time, time, text),
  update_routine(uuid, text, text, uuid, text[], text, uuid, uuid[], text, text, text[], boolean, time, time),
  update_routine_checklist(uuid, text[]),
  cancel_routine(uuid, text),
  reactivate_routine(uuid)
from anon, public;

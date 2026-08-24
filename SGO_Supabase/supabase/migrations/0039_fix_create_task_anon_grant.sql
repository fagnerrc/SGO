-- SGO on Supabase — close a real, currently-live security hole caused by
-- the same root issue as 0038: because 0035_task_start_date.sql's
-- `create or replace function create_task(...)` had a different parameter
-- list than the original (0007), Postgres created a brand-new function
-- object rather than replacing the old one. That new object never received
-- the anon/public EXECUTE revokes that 0018_revoke_anon_from_authenticated_
-- only.sql and 0019_revoke_public_properly.sql applied to the OLD
-- signature — it only got Supabase's default-privilege auto-grant to
-- anon/authenticated/service_role plus Postgres's own PUBLIC default.
--
-- Net effect since 0035 shipped: create_task() has been callable by
-- completely unauthenticated (anon) clients in production. Closing it now
-- with the exact same revoke this function was always supposed to carry.

revoke execute on function
  create_task(text, text, text, uuid, text, text, uuid, uuid[], timestamptz, numeric, text, text, text[], timestamptz)
from anon, public;

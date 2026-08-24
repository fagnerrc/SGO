-- Fix for a production-breaking bug introduced by 0035_task_start_date.sql:
-- `create or replace function create_task(...)` there added a new LAST
-- parameter (p_data_inicio). In Postgres, CREATE OR REPLACE only replaces a
-- function whose parameter list is IDENTICAL — a different parameter list
-- creates a second, separate overload instead of replacing the first. So
-- since 0035, two create_task() functions have coexisted: the original
-- 13-arg one (from 0007/0034) and the new 14-arg one. Any caller that omits
-- p_data_inicio (every existing call site does, since the frontend was
-- updated to pass it but old cached clients / any 13-arg-only call still
-- match both overloads' common parameters) makes PostgREST's RPC dispatch
-- fail with "Could not choose the best candidate function" — this broke
-- task creation in production (reported live by a real user, Maisa, via a
-- create_task error toast) until now.
--
-- Fix: drop the stale 13-arg overload. The 14-arg one from 0035 already
-- defaults p_data_inicio to null, so every existing caller keeps working
-- unchanged — this was always meant to be a straight replacement, not an
-- additional overload.

drop function create_task(text, text, text, uuid, text, text, uuid, uuid[], timestamptz, numeric, text, text, text[]);

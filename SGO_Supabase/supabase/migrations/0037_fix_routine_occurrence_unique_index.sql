-- Fix for generate_periodic_routine_tasks()'s `on conflict
-- (routine_occurrence_key) do nothing`: a PARTIAL unique index (the
-- original `where routine_occurrence_key is not null` from 0036) cannot be
-- used as an ON CONFLICT inference target without repeating the same WHERE
-- clause in the ON CONFLICT itself — Postgres raised "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification" on every
-- single generation attempt, caught by the per-routine exception handler,
-- so no periodic task was ever actually created. Caught by manually
-- exercising generate_periodic_routine_tasks() against a real test routine
-- before shipping (see routine_history 'GENERATION_FAILED' entries from
-- that test).
--
-- Fix: drop the WHERE clause. A plain unique index already treats every
-- NULL as distinct from every other NULL, so non-routine tasks (where this
-- column is null) were never going to collide anyway — the partial
-- predicate was buying nothing and breaking ON CONFLICT inference.

drop index tasks_routine_occurrence_key_idx;
create unique index tasks_routine_occurrence_key_idx on tasks (routine_occurrence_key);

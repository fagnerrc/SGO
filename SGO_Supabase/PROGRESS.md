# Progress

Following the phases in `../SGO_Supabase_Migration_Prompt.md` section 8.

## Done — Phase 1: schema + RLS

All in `supabase/migrations/`:

- **`0001_extensions_and_enums.sql`** — enums for `user_role`, `task_status`, `timer_state`,
  `approval_status`, `conversation_type`, `notification_type`, `log_kind`.
- **`0002_core_tables.sql`** — `companies`, `profiles` (1:1 with `auth.users`), `processes`,
  plus the RLS helper functions `current_profile()`, `current_user_role()`, `current_company()`,
  `is_privileged()`.
- **`0003_tasks.sql`** — `tasks` and its child tables (`task_checklist_items`, `task_history`,
  `task_comments`, `task_links`, `task_timer_sessions`), sequential task codes, and the
  `enforce_task_transition()` trigger that fixes bug #4 (generic update reaching a gated
  status) and bug #5 (terminal-state resurrection only protected timed tasks) **for every task
  type**, at the database level.
- **`0004_communication.sql`** — `conversations`, `conversation_participants`, `messages`,
  `conversation_reads`, `feedbacks`, `notifications` (with a real nullable `task_id` FK, fixing
  bug #7's fabricated-self-id problem, and a dedup key that includes the recipient, fixing the
  reassignment-drops-notification bug).
- **`0005_audit_and_ops.sql`** — unified `logs` table (activity/audit/security), `login_attempts`
  (lockout duration is the only source of truth, fixing bug #2), `sessions` +
  `revoke_sessions_for()`/`validate_session()` (fixing bug #1 — PIN reset can now actually
  invalidate sessions), and `operations` (idempotency ledger replacing the old full-column
  text-search scan).
- **`0006_rls_policies.sql`** — RLS enabled on every table. Read policies mirror the old
  visibility rules; `tasks`/`notifications`/`logs`/`sessions`/`login_attempts`/`operations` have
  **no write policies at all** for regular clients on purpose (see README "Design decisions") —
  all mutation goes through `SECURITY DEFINER` functions, not yet written (Phase 2).

## Not started yet

- **Phase 2 — task mutation functions.** `create_task()`, `mutate_task()`/action-specific
  functions (`start_task`, `pause_task`, `resume_task`, `complete_task`, `cancel_task`,
  `reject_task`, `approve_task`), wired to call `set_config('sgo.action', ..., true)` before
  writing so the `enforce_task_transition()` trigger lets the write through. This is the
  highest-value next step — it's the most complex and most bug-prone module in the old system.
- **Phase 3 — auth.** A PIN-login Edge Function using `login_attempts`/`sessions` (schema is
  ready; no function code yet). Decide: custom JWT vs. Supabase Auth admin API to mint a real
  session on successful PIN check.
- **Phase 4 — comms functions.** Server-side notification creation actually wired to task/
  feedback/message events (fixing bug #6 — the old function existed but was never called).
  Schema (`notifications`) is ready; the trigger/function that populates it on
  insert/assignment is not written yet.
- **Phase 5 — scheduled automation.** pg_cron jobs for daily recurring task generation and
  deadline notifications. Not started.
- **Phase 6 — frontend.** Nothing under `src/` yet.
- **Phase 7 — diagnostics/admin tooling.** Not started.

## Open questions / things to verify before relying on this schema

1. **Untested against a real Postgres/Supabase instance.** These migrations were written by
   reading the SQL by eye; they have not been run with `supabase db push` or against a local
   Supabase instance yet. Before building on top of them, run them against a throwaway project
   and fix whatever the first `db push` surfaces (likely candidates: exact array/`ANY` syntax
   in `0006`'s `company_access` checks, and whether `pg_cron` is available on your Supabase
   plan — it requires the extension to be enabled in the dashboard first).
2. **`risco`/`prioridade` are plain text, not enums** — the old source didn't give enough
   confirmed values to enumerate safely; tighten with a `CHECK (... IN (...))` once the real
   value set is confirmed against the old data.
3. **Reopening a terminal task has no path at all yet** — `enforce_task_transition()` blocks it
   unconditionally (`action <> 'reopen'` is never true because no function ever sets that
   action). Decide the audit-trail requirements for a legitimate reopen before adding it.
4. **Direct-conversation creation isn't modeled yet** — `conversation_participants` exists but
   nothing populates it; that's part of Phase 2/4 (creating a conversation is itself a
   mutation with a rule: "must include the creator").

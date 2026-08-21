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

## Done — Phase 2: task mutation functions

**`0007_task_functions.sql`** — all writes to `tasks` now go exclusively through these
`SECURITY DEFINER` functions (RLS on `tasks` grants no direct write to `authenticated` — see
0006). Each one calls `set_config('sgo.action', ..., true)` immediately before its `UPDATE` so
`enforce_task_transition()` (0003) can verify the action matches the status it's trying to
reach.

- `create_task(...)` — authorization check, process/segregation-of-duties check, inserts the
  task + initial checklist + a `task_history` row.
- `start_task` / `pause_task` / `resume_task` — the timer state machine; `pause_task` closes the
  open `task_timer_sessions` row and folds its duration into `tasks.timer_total_ms`.
- `wait_task` / `approval_wait_task` — 'Aguardando terceiro' / 'Aguardando aprovação'.
- `complete_task` — requires evidence, a fully-done checklist, approval (when the linked
  process has an `aprovador_id`), and a delay justification when late — checked uniformly for
  every task, not just timed ones.
- `cancel_task` — **new in this rewrite**: the old system let a generic `update` reach
  'Cancelada' with no checks at all (bug #4). Now it's the only path there, and it requires a
  non-empty reason.
- `approve_task` / `reject_task` — only the process's designated `aprovador_id` or a privileged
  role. `reject_task` is the only sanctioned path to 'Reprovada/devolvida' (closes the other
  half of bug #4/#6).
- `update_task(p_task_id, p_operation_id, p_patch jsonb)` — non-status edits only; explicitly
  rejects a patch touching `status`/`evidencia`/`approval_*`/`timer_*`/etc. Changing `area` or
  `responsavel_id` requires a privileged role, or a gestor acting entirely within their own area
  on both the old and new value — this closes bug #3 (gestor moving a task out of their own
  authority), which the old `canMutateTaskV12_` never checked on the post-mutation side.
- `claim_operation()` / `complete_operation()` / `fail_operation()` — the idempotency ledger
  wrapper every action function uses first, replacing the old full-column text-search scan
  (`appendChangeOnceV12_`) with a unique-index lookup.

**Bug found and fixed while writing this phase, not in the original review:** the first draft
of `approve_task`/`reject_task` used the general `can_mutate_task()` baseline (responsável/
solicitante/participante/gestor-of-area/privileged), which would have wrongly blocked a
legitimate approver from a *different* area or department (a very normal case — e.g. a director
approving a request from another team) from approving or even seeing the task. Fixed by:
(1) a separate `lock_task_for_approval()` that only checks company membership, letting
`approve_task`/`reject_task` do their own narrower "must be the aprovador or privileged" check;
(2) added an approver clause to the `tasks_select` RLS policy in `0006_rls_policies.sql` so the
approver can actually see the task in the first place. Both changes are in this commit.

## Done — Phase 3: auth

**`0008_auth_functions.sql`** + **`supabase/functions/pin-login/`** + **`supabase/functions/admin-create-user/`**.

Decision made on the "custom JWT vs. Supabase Auth" question left open after phase 1: PIN
verification and lockout accounting happen in Postgres (`verify_login()`), but the actual
session token is a **self-signed, Supabase-compatible JWT** (HS256, project JWT secret) minted
by the `pin-login` Edge Function — Postgres can't sign JWTs itself, and using Supabase Auth's
own sign-in methods would mean giving up PIN as the credential. This is Supabase's documented
"bring your own auth" pattern: the JWT works directly with PostgREST/RLS (`auth.uid()` resolves
from its `sub` claim) for both plain `SELECT`s and the phase 2 RPC functions — one token, no
separate session concept to keep in sync.

- **`verify_login(email, pin)`** — lockout check, `crypt()` (bcrypt via pgcrypto) hash
  comparison, attempt accounting, all inside one transaction serialized per-email via
  `pg_advisory_xact_lock(hashtext(email))`. This closes the *original* race-condition bug this
  whole review started from (parallel PIN attempts reading the same counter before either
  writes back) at the root, not by bolting a lock onto a check that still wasn't atomic.
- **No hidden TTL on lockouts** (fixes bug #2) — `login_attempts.locked_until` is read and
  compared directly; nothing else expires the row early. Lockout duration/attempt threshold are
  now per-company config (`companies.login_max_attempts`/`login_lockout_minutes`, added by this
  migration), not hardcoded.
- **`session_is_valid()`** — every RLS helper (`current_profile`/`current_user_role`/
  `current_company`/`is_privileged`) now also checks that the JWT's `session_id` claim points at
  a non-revoked, non-expired row in `sessions`. **`set_pin()`** calls `revoke_sessions_for()`
  (already built in phase 1) on every PIN change — self-service or admin reset — so a reset
  invalidates existing sessions *immediately*, on the very next request, not just for future
  logins. This fixes bug #1 for real, not just at the login layer.
- **`credentials`** — split out from `profiles` on purpose: `profiles` is broadly readable
  within a company (phase 1 RLS), and `pin_hash` must never ride along with that. RLS-enabled,
  zero policies — only reachable through `SECURITY DEFINER` functions.
- **`handle_new_auth_user()`** trigger — the standard Supabase pattern for keeping `profiles` in
  sync with `auth.users`; fires when `admin-create-user` calls the Admin API to create the
  underlying auth user, using `raw_user_meta_data` to fill in role/area/company.
- Design correction recorded in `0008`: the `sessions.token_hash`/`validate_session()` mechanism
  from phase 1 (0005) assumed an opaque-token model that didn't survive contact with "Postgres
  can't sign JWTs" — `token_hash` is now nullable and unused; `session_is_valid()`/
  `current_session_id()` are the real mechanism going forward.

## Done — Phase 4: chat, feedback, and notification generation

**`0009_comms_functions.sql`**.

- **Notifications are now generated by triggers, not a function nobody calls.** `notify_task_assigned()` (AFTER INSERT/UPDATE OF responsavel_id ON tasks), `notify_feedback()` (AFTER INSERT ON feedbacks), and `notify_message()` (AFTER INSERT ON messages, covering MESSAGE_RECEIVED/TASK_MESSAGE + MENTION) fire directly off the write itself. This is the structural fix for bug #6 — the old `createAutomaticNotifications_` existed but had zero callers anywhere in the codebase; here there's no separate call to forget, the row landing *is* the trigger.
- **Bug found and fixed while building this, not in the original review:** the phase-1 `notifications.dedup_key` (`type:task_id:recipient_id:day`) worked fine for the deadline-style notifications it was designed for, but applied to chat messages it would have collided two *different* direct conversations to the same person on the same day into one silently-dropped notification, since neither `conversation_id` nor a message id were part of the key. Fixed by adding a `source_id` column (the causing row's own id) and putting it ahead of `task_id` in the key — event-driven notifications are now keyed by something already unique per event, so they're never wrongly deduped against each other; the day-bucket behavior is preserved for phase 5's scheduled notifications (which have no single source row and pass `source_id = null`).
- **Mentions are client-supplied**, not server-parsed: `messages.mentioned_ids uuid[]` is populated by the app's own mention-picker UI rather than regex-matching "@name" out of free text server-side (fragile, locale-dependent, and the old system didn't have this problem because it didn't have mentions working at all).
- **`feedbacks` had a select policy but no insert policy** in 0006 — nobody could actually submit feedback. Added `feedbacks_insert` (simple author-must-match, recipient-must-be-in-company check, same pattern as `messages_insert`/`task_comments_insert`).
- **Chat conversation lookup/creation**: `get_or_create_task_conversation()`, `get_or_create_area_conversation()`, `create_direct_conversation()` (advisory-lock-serialized per pair, avoiding a race that could otherwise create two direct conversations between the same two people), and `mark_conversation_read()`. Sending a message itself stays a plain client `INSERT` against the existing `messages_insert` RLS policy from phase 1 — it's a rule-free append once you already have a `conversation_id` you're allowed to post into; getting that id is the part with rules, so it's a function, consistent with phase 2's pattern.
- **`can_view_conversation()`** — a SECURITY DEFINER helper mirroring the `conversations_select` RLS policy's logic, needed because `mark_conversation_read()` runs as the function owner and therefore bypasses RLS on `conversations`; without an explicit re-check it would have let anyone mark any conversation read.
- Added `conversations_one_per_task`/`conversations_one_per_area` partial unique indexes so the get-or-create functions are actually race-safe (paired with `ON unique_violation` fallback fetches).

## Done — Phase 5: recurring templates + scheduled automation

**`0010_scheduled_automation.sql`**.

- **`task_templates`** — this table didn't exist before phase 5; the old system's "recurring
  task" concept lived only inside `V12_TimerDaily.gs`'s generation logic with no dedicated
  table, so this migration plan didn't have one to carry over either. `create_task_template()` /
  `set_task_template_active()` are the client-facing management functions (privileged/gestor
  only); template rows are otherwise only read by `generate_daily_tasks()`.
- **`generate_daily_tasks()`** — idempotent per template via `last_generated_on` (same guarantee
  the original review confirmed the old trigger-duplication-tolerant design already had), uses
  `FOR UPDATE SKIP LOCKED` when scanning templates, and wraps each template's generation in its
  own exception handler (logged to `logs`) so one bad template can't abort the whole run.
  Inserting the generated task automatically fires `tasks_notify_assigned` from phase 4 — no
  extra notification code needed here, that's just what the trigger-based design from phase 4
  buys for free.
- **`generate_deadline_notifications()`** — TASK_OVERDUE / TASK_DUE_SOON (24h window) /
  APPROVAL_PENDING (pending >24h, notifies the process's `aprovador_id`). Relies on the
  day-bucketed, recipient-scoped `dedup_key` from phases 1/4 to avoid re-notifying on every
  hourly run — this is the exact mechanism the original bug #2 (dedup key omitted the recipient)
  was about, and it's already correct here by construction.
- **Two structural fixes that come from the platform, not new code:** (1) `prazo` is a real
  `timestamptz` column, so the old "date-only string parsed as UTC midnight" bug (a *different*
  bug from the already-known `v1214TimeKeyFromDeadline_` one) has no equivalent here — Postgres
  resolves timestamps unambiguously regardless of input format. (2) pg_cron does not silently
  disable a job that keeps failing the way Apps Script disables a misbehaving trigger (bug #C2)
  — failures show up in `cron.job_run_details` instead. The per-row `exception when others`
  blocks in both functions exist for batch robustness (one bad row shouldn't sink the whole run),
  not to work around a disablement risk that doesn't exist in this environment.
- `generate_daily_tasks()`/`generate_deadline_notifications()` are deliberately **not** granted
  to `authenticated`/`anon` — pg_cron-only, scheduled at the bottom of the migration
  (`5 0 * * *` / `0 * * * *`, both UTC).

## Done — Phase 6: frontend foundation (partial — see gaps below)

Plain TypeScript + Vite, no framework (matches the old system's no-framework `Index.html`, just
with real tooling). **This is the one piece of the whole project that's actually been run and
verified** — `npm install && npm run build` succeeds cleanly (strict `tsc` + Vite bundling), and
the login screen was smoke-tested in a real browser via a local dev server: form renders, submit
correctly hits the `pin-login` Edge Function call path, and a network failure (no real Supabase
project configured) is caught and shown as a friendly error instead of crashing — see the
screenshot/console check in this session's transcript around the phase 6 work.

**What's built:**
- `src/lib/supabase.ts` / `session.ts` — the custom-JWT client pattern described in phase 3's
  README section: no `supabase.auth.setSession()` (no refresh token exists), the authenticated
  client is rebuilt with the token attached to `Authorization` headers instead.
- `src/lib/auth.ts` — `login()`/`logout()`, calling the `pin-login` Edge Function and `logout()`
  RPC respectively.
- `src/lib/tasks.ts` — task list/detail reads, and the timer/complete/cancel actions from phase
  2, each generating its own `operation_id` client-side (`crypto.randomUUID()`) for idempotent
  retries.
- Three screens (`src/views/`): login, task list, task detail (timer controls, checklist,
  complete-with-evidence, cancel-with-reason). A ~40-line hash router (`src/app.ts`) ties them
  together.
- **Bug found and fixed while building this, not in the original review:** `task_checklist_items`
  had a `SELECT` policy from phase 1 but nothing let a client actually check an item off —
  `create_task()` was the only writer, via `SECURITY DEFINER`. Fixed in
  `0011_checklist_write_policy.sql` with a direct RLS `UPDATE` policy scoped, at the grant level
  (not just RLS), to the single `feito` column — `revoke update ... / grant update (feito) ...` —
  so the policy can't be used to rewrite an item's text.

**What's explicitly NOT built yet (this is a big gap, not a rounding error):**
- **No local-first outbox/queue.** This was the old system's headline architectural property
  ("toda ação do usuário entra na fila local antes de depender da rede" — see
  `SGO_Supabase_Migration_Prompt.md` section 2.8) and this frontend does not have it: actions are
  plain call-and-await against the network. A dropped connection mid-action currently just fails
  the action, it doesn't queue it. Rebuilding that (local queue, retry/backoff, conflict
  handling) is real, substantial work — don't assume it exists.
- No chat UI, no notification center UI, no task-creation form, no admin/template-management
  screens, no diagnostics view. Only "view my tasks, act on one task" exists.
- No `supabase gen types` — `src/lib/types.ts` is hand-written and will drift from the real
  schema the moment migrations change; regenerate it once there's a real project to point at.
- `npm audit` reports one moderate vulnerability (`esbuild`, via Vite) affecting Vite's **dev
  server only** (not production `dist/` output) — present in the entire Vite 5.x/6.x line, only
  fixed by jumping to Vite 8, which is a breaking change not attempted here. Accepted as a known
  risk for now; revisit before this is used somewhere the dev server itself is exposed.

## Done — Phase 7: admin tooling, diagnostics, first-user bootstrap

**`0012_admin_diagnostics.sql`** + **`supabase/functions/bootstrap-company/`**. This closes out
every phase in the original plan (`SGO_Supabase_Migration_Prompt.md` section 8).

- **Bootstrap gap closed** (flagged as an open question since phase 3): `can_bootstrap()` /
  `bootstrap_company()` / `bootstrap_set_initial_pin()` are each self-limiting — they check that
  nothing has been bootstrapped yet as their own authorization gate (no `companies` row exists /
  no `credentials` row exists yet for that company), rather than checking a role, since no
  logged-in user exists yet to check a role against. `bootstrap-company` (Edge Function) chains
  them together with the Admin API call needed to create the actual `auth.users` row. This is
  meant to stay deployed permanently — it locks itself out after first use, not a one-time script
  to delete afterward.
- **Admin tooling**: `update_company_settings()` (the lockout config added in phase 3 finally has
  a way to be changed), `set_profile_role()`, `set_profile_active()` — deactivating a collaborator
  also calls `revoke_sessions_for()` immediately, same reasoning as phase 3's PIN-reset fix: a
  security-relevant status change shouldn't linger for up to 8h because nobody thought to also
  touch `sessions`.
- **Diagnostics**: `report_client_error()` replaces `reportClientErrorServer`
  (`V12_Diagnostics.gs`) — a direct write to `logs` (new `'diagnostic'` kind added to the
  `log_kind` enum). No separate viewing function needed: admins already read this data through
  the existing `logs_select` RLS policy from phase 1. The old system's in-memory
  buffer-with-periodic-flush doesn't have an equivalent here on purpose — that existed to batch
  writes against Sheets' comparatively expensive API; a real Postgres table with no row-count
  ceiling doesn't need the same workaround.
- **Backup/restore deliberately NOT reimplemented as app code.** The old system's backup/restore
  logic was itself the source of two real bugs in the original review (C3: restoring a stale
  snapshot; A2: backup maintenance silently wiping backups on a mid-write failure) — exactly the
  class of hand-rolled persistence logic this migration exists to get away from. Use Supabase's
  built-in point-in-time recovery / scheduled backups (paid plans) or `pg_dump` instead. This is a
  deliberate scope decision, not an oversight — don't build a custom restore RPC without a strong
  reason, given the history.

## Everything in the original plan has a first pass now — what that does and doesn't mean

All 7 phases from `SGO_Supabase_Migration_Prompt.md` section 8 have at least a first
implementation (12 migrations, 4 Edge Functions, a frontend foundation covering 3 of the ~8
screens the old system had). That is **not** the same as "ready to replace the Apps Script
system in production." The single most important next step, unchanged since phase 1, is still:
run these migrations against a real Supabase project and see what breaks — nothing in this
project has executed against a live Postgres instance except the frontend's own build step.
Treat every phase's "done" as "designed and internally consistent," not "verified."

## Validation pass (after phase 7) — what was actually checked, and two real bugs it found

No Docker/psql/Supabase CLI/Deno available in this environment, so a real Postgres instance was
still not reachable — but two things were validated for real, not just read by eye:

1. **All 13 migration files parsed successfully with `libpg-query`** (a Node wrapper around the
   actual Postgres SQL parser) — confirms every `CREATE TABLE`/`CREATE FUNCTION`/`CREATE POLICY`/
   `GRANT`/`REVOKE`/etc. statement is syntactically valid SQL. This does **not** validate PL/pgSQL
   function *bodies* (those are opaque string literals to the outer parser — a typo inside a
   `BEGIN...END` block wouldn't be caught this way) or any semantic/runtime behavior — only that
   nothing is malformed at the statement level.
2. **Every `GRANT`/`REVOKE EXECUTE` statement's argument-type list was cross-checked against the
   actual function signature it targets**, across all 13 files (30 functions checked by hand,
   grant-list vs. `create function` line) — all matched exactly. A mismatch here would make
   `supabase db push` fail outright (Postgres can't resolve which overload a `GRANT` refers to),
   so this specifically catches "I renamed/reordered a parameter and forgot to update the grant"
   mistakes before they'd surface as a deploy failure.
3. **Every `task_status` string literal used anywhere across all migrations** (comparisons,
   trigger arrays, generated notifications) was extracted and diffed against the 7 real enum
   values from `0001` — all matched exactly, no typos/accent mismatches that would otherwise only
   surface as a runtime "invalid input value for enum" error.

**Two real bugs found and fixed by this pass, not by the original code review:**

- **`0013_function_grants_hardening.sql`** — Postgres grants `EXECUTE` on every new function to
  `PUBLIC` by default unless explicitly revoked. Every earlier migration's comments *assumed*
  "I never explicitly granted this, so clients can't call it" — that assumption was wrong.
  `claim_operation()`/`complete_operation()`/`fail_operation()` (0007) were, until this migration,
  directly callable by any authenticated client — meaning anyone could forge a `COMPLETED` result
  for *someone else's* `operation_id`, or mark it `FAILED`, bypassing the whole point of the
  idempotency ledger. `generate_daily_tasks()`/`generate_deadline_notifications()` (0010) were
  triggerable on demand instead of pg_cron-only, as documented but not enforced. Also revoked
  (lower risk, but not meant to be public either): `lock_task()`, `lock_task_for_approval()`,
  `can_mutate_task()`, `task_summary()`, `can_view_conversation()`. The RLS helper functions
  (`current_profile`/`current_company`/`is_privileged`/etc.) are deliberately left alone — RLS
  policies invoke them as the querying role, so revoking would break every policy that uses them;
  being directly callable is harmless for those specifically since each only reports information
  about the caller's own session.
- **`admin-create-user`** accepted `company_id` from the request body and only checked that the
  *caller* was privileged somewhere — not that they had any authority over the specific company
  they were asking to provision a user into. A privileged admin of Company A could have provisioned
  a user directly into Company B just by naming its id. Fixed: the function now derives the
  target company from the caller's own `current_company()` via RPC, ignoring any client-supplied
  value entirely.

## Open questions / things to verify before relying on this schema

1. **Still not run against a real Postgres/Supabase instance — still the #1 item**, though this
   is now more precisely scoped than "written by eye": all 13 migrations pass real Postgres SQL
   parsing and a full grant/signature cross-check (see the validation pass section above), so
   what's actually unverified is semantic/runtime behavior — PL/pgSQL function bodies, RLS policy
   *behavior* (not just that the policies parse), and every Edge Function's actual HTTP behavior.
   Before trusting any of this, run the migrations against a throwaway project and fix whatever
   the first `db push` surfaces. Likely candidates: exact array/`ANY` syntax in `0006`'s
   `company_access` checks; whether `pg_cron` is available on your Supabase plan (needs enabling
   in the dashboard first); in `0007`'s `update_task()`, the
   `jsonb_array_elements_text(...)::uuid`/`::text` casts used to turn a JSON array into
   `participantes uuid[]`/`tags text[]`; and in `0008`, whether creating a trigger on `auth.users`
   is permitted under your project's role setup (it's the standard documented Supabase pattern,
   but depends on the migration being run as a role with the right privileges on the `auth`
   schema — usually true for the `postgres` role `supabase db push` uses by default).
2. **First-user bootstrap: closed in phase 7** (`can_bootstrap()`/`bootstrap_company()`/
   `bootstrap_set_initial_pin()` in `0012`, called from `supabase/functions/bootstrap-company/`).
   Left here as a record that it was a real gap and how it got closed, not as an open item.
3. **Company settings can be edited (phase 7's `update_company_settings()`), but there's still no
   `create_company()`** for a second/third company in an already-bootstrapped project —
   `bootstrap_company()` (phase 7) only works once, for the very first one. Not needed until SGO
   actually hosts more than one company in the same project; add it then.
4. **'area' conversations deliberately don't send per-message notifications** (`notify_message()`
   in `0009`) — treated as a broadcast channel people check rather than get pinged for on every
   message, to avoid notifying an entire department every time anyone posts. This was a judgment
   call, not something confirmed against how the old system actually behaved (it didn't have a
   working notification path for any chat type — bug #6). Revisit if the product wants area chat
   to notify.
5. **Migration 0009 (comms/notifications) is untested like everything else** — same caveat as
   item 1, plus it specifically drops and recreates `notifications.dedup_key`/its unique index,
   so if 0004-0008 were ever actually applied to a real database before 0009 runs, double-check
   that ALTER sequence against whatever notification rows already exist.
6. **No per-company timezone yet.** `0010`'s daily generation and deadline math both run on UTC
   wall-clock time (`task_templates.deadline_time` is interpreted as UTC, `generate_daily_tasks`
   fires at `5 0 * * *` UTC). Fine for a single-timezone company, wrong the moment SGO serves a
   company outside UTC — a `companies.timezone` column plus timezone-aware generation is the
   right fix, not implemented yet. `generate_deadline_notifications()` itself doesn't have this
   problem (it compares real timestamps, not wall-clock dates), only the daily generation time
   and the templates' `deadline_time` do.
7. **`pg_cron` scheduling in `0010` is the least-tested part of the whole project so far** — it
   depends on the extension being enabled (dashboard toggle) *and* on `cron.schedule()`'s exact
   behavior on Supabase's managed Postgres, which can differ subtly from self-hosted pg_cron.
   Verify both jobs actually appear in `cron.job` and produce rows in `cron.job_run_details`
   after applying this migration, before trusting that automation is really running.
8. **`risco`/`prioridade` are plain text, not enums** — the old source didn't give enough
   confirmed values to enumerate safely; tighten with a `CHECK (... IN (...))` once the real
   value set is confirmed against the old data.
9. **Reopening a terminal task has no path at all yet** — `enforce_task_transition()` (0003)
   blocks it unconditionally (`action <> 'reopen'` is never true because no function ever sets
   that action). Decide the audit-trail requirements for a legitimate reopen before adding it.
   This is the one deliberate design gap that's stayed open across every phase — a reopen action
   didn't fit naturally into phase 2 (task ops), phase 7 (admin tooling) is arguably where it
   belongs, and it still isn't built.
10. **No local-first outbox** (phase 6) and **no chat/notifications/admin/diagnostics UI** — see
    the phase 6 section above for the full list; not repeated here.

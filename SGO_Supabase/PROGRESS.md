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

## Not started yet

- **Phase 5 — scheduled automation.** pg_cron jobs for daily recurring task generation and
  deadline notifications. Not started.
- **Phase 6 — frontend.** Nothing under `src/` yet.
- **Phase 7 — diagnostics/admin tooling.** Not started.

## Open questions / things to verify before relying on this schema

1. **Untested against a real Postgres/Supabase instance.** All eight migrations (0001-0008) and
   both Edge Functions were written by reading the code by eye; none have been run with
   `supabase db push`/`supabase functions deploy`, or against a local Supabase instance, yet.
   Before building a frontend on top of them, run them against a throwaway project and fix
   whatever the first `db push`/`functions serve` surfaces. Likely candidates: exact array/`ANY`
   syntax in `0006`'s `company_access` checks; whether `pg_cron` is available on your Supabase
   plan (needs enabling in the dashboard first); in `0007`'s `update_task()`, the
   `jsonb_array_elements_text(...)::uuid`/`::text` casts used to turn a JSON array into
   `participantes uuid[]`/`tags text[]`; and in `0008`, whether creating a trigger on `auth.users`
   is permitted under your project's role setup (it's the standard documented Supabase pattern,
   but depends on the migration being run as a role with the right privileges on the `auth`
   schema — usually true for the `postgres` role `supabase db push` uses by default).
2. **First-user bootstrap has no path yet.** `admin-create-user` requires the *caller* to already
   be `is_privileged()` — which is correct for provisioning the 2nd, 3rd, ... user, but means
   there is currently no way to create the very first company/admin from a blank database. Needs
   either: a one-time SQL script run directly by the project owner (bypassing the Edge Function)
   to insert the first `companies` row and manually create+promote one `auth.users`/`profiles`
   row to `role = 'admin'`, or a dedicated `bootstrap_company()` function that only works when
   the `companies` table is empty. Not designed yet — flagging so it isn't a surprise when
   someone tries to log into a fresh project and there's no account to log in with.
3. **No `create_company()` / company-settings functions yet.** The `companies` table (with the
   phase 3 lockout columns) can currently only be written to directly with the service role —
   there's no RPC for an admin to edit their own company's settings (e.g. `login_max_attempts`).
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
2. **`risco`/`prioridade` are plain text, not enums** — the old source didn't give enough
   confirmed values to enumerate safely; tighten with a `CHECK (... IN (...))` once the real
   value set is confirmed against the old data.
3. **Reopening a terminal task has no path at all yet** — `enforce_task_transition()` blocks it
   unconditionally (`action <> 'reopen'` is never true because no function ever sets that
   action). Decide the audit-trail requirements for a legitimate reopen before adding it.
4. **Direct-conversation creation isn't modeled yet** — `conversation_participants` exists but
   nothing populates it; that's part of Phase 2/4 (creating a conversation is itself a
   mutation with a rule: "must include the creator").

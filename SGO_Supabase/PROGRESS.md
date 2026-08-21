# Progress

Following the phases in `../SGO_Supabase_Migration_Prompt.md` section 8.

## LIVE VALIDATION — actually run against a real Supabase project (2026-08-21)

Every phase below says "done" based on code review and (from the validation-pass entry)
SQL-parser/grant-signature checks. None of that is the same as running it. On 2026-08-21 this
project was linked to a real Supabase project (`SGO`, ref `nrguwyhkocsdszdrvmry`, region
sa-east-1) via `supabase link` + a personal access token, and every migration was actually
applied with `supabase db push`. This found **6 real bugs** that no amount of reading the SQL
would have caught, fixed with forward migrations `0014`-`0022` (0004/0006/0009 were also edited
directly, since their bugs were caught before those specific files had successfully applied —
see each bug below for which case it was):

1. **`notifications.dedup_key` as a `GENERATED ALWAYS AS (...) STORED` column failed outright**
   (`0004`/`0009`, edited directly — hadn't applied yet): `to_char(timestamptz, ...)` is only
   `STABLE`, not `IMMUTABLE`, and Postgres requires a generated column's expression to be
   immutable. Fixed by making `dedup_key` a plain column set by a `BEFORE INSERT` trigger
   instead — no such restriction applies there.
2. **`id = ANY ((select company_access from profiles ...))` failed** (`0006`, edited directly):
   `x = ANY (subquery)` expects the subquery to yield multiple scalar rows, not one row
   containing an array — Postgres tried to compare `uuid = uuid[]` directly. Fixed with
   `unnest()`.
3. **pgcrypto's `crypt()`/`gen_salt()` were unreachable** from `set_pin()`/`verify_login()`/
   `bootstrap_set_initial_pin()` (`0008`/`0012`, already applied — fixed forward in `0014`):
   this project installs pgcrypto into an `extensions` schema, not `public`, and none of the
   three functions had `extensions` on their `search_path`. The functions *created*
   successfully (plpgsql bodies aren't validated at creation time) but would have failed on the
   very first real login or PIN-set attempt.
4. **Every function was missing an explicit `search_path`** (`0015`) — a real
   `db advisors` security finding (`function_search_path_mutable`), not a hypothetical.
5. **Internal-only functions were reachable via PostgREST RPC despite "never granted" comments
   throughout 0007/0009/0010** (`0013` partially, completed in `0016`/`0019`/`0020`/`0022`) —
   the actual root cause took three attempts to nail down correctly, which is itself worth
   recording: Postgres grants `EXECUTE` to `PUBLIC` on every new function by default, **and**
   Supabase separately auto-grants `EXECUTE` to `anon`/`authenticated`/`service_role` on every
   new function in `public` — two independent grants, and revoking only one leaves the function
   fully callable via the other. `claim_operation`/`complete_operation`/`fail_operation` (would
   have let any client forge or sabotage another user's idempotency record),
   `generate_daily_tasks`/`generate_deadline_notifications` (triggerable on demand instead of
   pg_cron-only), and — the one missed by every earlier manual review pass —
   **`revoke_sessions_for`**, which would have let any client, including `anon`, revoke *any*
   user's sessions by profile id. Verified with direct ACL inspection
   (`select proacl from pg_proc`), not just re-running the advisor, after getting it wrong twice.
6. **14 RLS policies re-evaluated `auth.uid()` per row instead of once per query** (`0017` for
   2, `0021` for the other 12) — a real `db advisors` performance finding
   (`auth_rls_initplan`), fixed by wrapping as `(select auth.uid())` per Supabase's documented
   pattern.

**End-to-end auth flow was then verified for real**, not just unit-by-unit: deployed all three
Edge Functions (`supabase functions deploy`), set the `JWT_SECRET` secret (note: **cannot be
named `SUPABASE_JWT_SECRET`** — Supabase reserves that prefix and silently refuses to set it;
had to fetch the actual secret value via the Management API's `GET /v1/projects/{ref}/postgrest`
endpoint, since neither the CLI nor the dashboard UI surfaced it in an easy-to-find place for
this project), called `bootstrap-company` to create a real company + admin, called `pin-login`
with that admin's PIN and got back a real signed JWT, used that JWT to call `current_profile()`
via PostgREST directly and got the correct profile back (RLS + `session_is_valid()` both
working), then called `logout()` and confirmed the *same* token immediately stopped working —
the phase 3 bug #1 fix (live session revocation) is confirmed working against a real database,
not just reasoned about. Test company/admin were deleted afterward; the project is back to a
clean, unbootstrapped state.

**Also confirmed for real:** both `pg_cron` jobs (`sgo-generate-daily-tasks`,
`sgo-deadline-notifications`) actually appear in `cron.job` and are active — this closes open
question #7 below, which had flagged pg_cron behavior on Supabase's managed Postgres as
unverified.

## FUNCTIONAL TEST SUITE — task/chat/notifications/automation, end-to-end (2026-08-21)

Follow-up to the auth-only validation above. Wrote a 55-assertion test script
(not committed — lived in the session's scratchpad, reproducible from this description) that
drives the real deployed system as four real users (admin, gestor, colaborador, an aprovador in
a different area) through `pin-login` and the REST/RPC API, the same way the eventual frontend
will. **All 55 passed on the final run.** It found **4 more real bugs** first — none of which
the earlier SQL-parser/advisor-driven validation pass could have caught, because all four are
about runtime *behavior* under real multi-user data, not schema/grant correctness:

1. **`infinite recursion detected in policy for relation "profiles"` (42P17)** — `profiles_select`
   (0006) contained `select unnest(company_access) from profiles where id = auth.uid()`: a plain
   subquery against `profiles`, evaluated as the querying role, inside `profiles`' own policy.
   Every row that subquery touches needs `profiles_select` evaluated on it too — forever. Never
   triggered by the auth-flow validation (which only ever called `current_profile()`, a
   SECURITY DEFINER function that bypasses RLS on its internal lookup) — only surfaced once a
   test actually queried `task_checklist_items`, which checks `tasks_select`, which checks
   `profiles` for the gestor-of-area clause. Fixed (`0023`) with a SECURITY DEFINER
   `caller_company_access()` helper, same pattern as `current_company()`.
2. **The identical bug, two tables apart** — `conversations_select`'s 'direct' clause queries
   `conversation_participants`; `conversation_participants_select`'s fallback clause queried
   `conversations` right back. Only surfaced when a message was actually sent. Fixed (`0024`)
   with a `my_conversation_ids()` SECURITY DEFINER helper, same pattern again — worth noting
   as a category, not just two isolated bugs: **any RLS policy with a plain subquery against a
   table whose own policy queries back (directly or transitively) will do this**, and the fix is
   always the same shape.
3. **`task_checklist_items_update`'s policy called `can_mutate_task()` directly** — that function
   had been revoked from `authenticated` in `0013`/`0016` as "internal, not meant to be called
   directly," which was true for every other place it's used (inside other SECURITY DEFINER
   functions) but wrong here specifically: an RLS policy invoking a function directly needs that
   function grantable to the querying role, exactly like `current_company()`/`is_privileged()`.
   Fixed (`0024`) by re-granting it — a reminder that "not granted anywhere in a GRANT statement"
   isn't the same question as "not used directly in a policy," and the lockdown passes earlier
   only checked the former.
4. **`approval_wait_task()` never set `aguardando_quem`, and the `tasks_waiting_fields_required`
   CHECK constraint required it for `'Aguardando aprovação'` too**, not just
   `'Aguardando terceiro'` — every real approval-wait attempt failed outright. The two "waiting"
   states aren't actually the same shape: `Aguardando terceiro` needs a free-text name (no
   structured link to who), `Aguardando aprovação` already has one (the process's
   `aprovador_id`) and never needed the free-text field. Split into two constraints (`0024`).

**What the 55 passing assertions now confirm, specifically:** the full task lifecycle
(create → checklist gating → complete, terminal-state protection against restarting a completed
task, cancel requiring a reason, update_task's guarded-field rejection); the approval flow
end-to-end including an approver in a *different area* seeing and acting on the task via the
approver-specific RLS clause from phase 2; `reject_task` as the only path to
`'Reprovada/devolvida'`; direct and task-linked chat with automatic `MESSAGE_RECEIVED`/
`TASK_MESSAGE`/`MENTION` notifications; feedback triggering `FEEDBACK_RECEIVED`; admin company
settings, client-error reporting, and — confirmed precisely — that deactivating a collaborator
revokes their session *immediately* (the first test run's assumption that it didn't was itself
wrong, caught by tightening the assertion rather than trusting a 200 status code alone); a
recurring task template actually producing a real task when `generate_daily_tasks()` runs; and
deadline notifications firing for a real overdue task, with the day-bucket dedup confirmed to
not duplicate on a second run. Database returned to a clean, empty (unbootstrapped) state
afterward.

**Still genuinely unverified:** timer state machine specifics (`start_task`/`pause_task`/
`resume_task` duration accumulation — the test suite only exercised non-timed tasks), the
frontend (`SGO_Supabase/src/`) against this live project (never pointed at a real
`.env.local`), and anything not explicitly listed above.

## TIMER STATE MACHINE — verified with real elapsed wall-clock time (2026-08-21)

18-assertion follow-up script, same pattern as the functional suite above, specifically for
`'Tarefa cronometrada'` tasks: `start_task` → wait ~2.5s real time → `pause_task` (confirmed
`timer_total_ms` landed at ~2500-2600ms, not just "some positive number") → `resume_task` → wait
~1.5s → `pause_task` again (confirmed the second session's duration was *added* to the first, not
overwritten) → `task_timer_sessions` has exactly two rows, both closed with `outcome='paused'`.
All passed with no fixes needed — the timer accumulation logic in `0007`'s `pause_task`/
`resume_task` was correct as designed.

Also confirmed the late-completion justification split from bug #4 above actually behaves
correctly in both directions: a timed task with a **manual** past deadline (`prazo_manual=true`)
rejects `complete_task` without `p_justificativa_atraso` and accepts it with one; a timed task
generated by `generate_daily_tasks()` with an **auto** deadline (`prazo_manual=false`) accepts
`complete_task` with *no* justification even though it's completed well past its `prazo` — the
exemption the old Apps Script system had for this exact case is preserved correctly.

## FRONTEND — tested through a real browser against the live project (2026-08-21)

Pointed `SGO_Supabase/.env.local` at the real project, built and served the frontend, and drove
it with actual mouse clicks and keyboard input in a browser — not curl, not a Node script. This
is the one round of testing this session where the choice of tool (browser vs. `fetch`) directly
determined whether a bug was even reachable:

- **CORS was completely unhandled on all three Edge Functions** — `pin-login` failed immediately
  with `Access to fetch ... has been blocked by CORS policy: Response to preflight request
  doesn't pass access control check: No 'Access-Control-Allow-Origin' header`. Every prior round
  of testing (curl, the 55-assertion suite, the 18-assertion timer suite) used `fetch`/`curl`
  directly against the API with no browser in between — neither sends a CORS preflight `OPTIONS`
  request or enforces the response header, so this bug was invisible to every single automated
  check that came before it, despite dozens of successful calls to the exact same functions.
  Fixed by adding `supabase/functions/_shared/cors.ts` (a shared preflight handler + a `json()`
  helper that always attaches `Access-Control-Allow-Origin`) and wiring it into all three
  functions; redeployed.
- **After the fix, the full user-facing flow was exercised for real**: login form → real
  `pin-login` call → redirected to the task list, which correctly showed a task created earlier
  via the API (proving `tasks_select` RLS resolves correctly for a session obtained through the
  actual login form, not just a hand-crafted token) → opened the task → checked off both
  checklist items via real clicks (verified against the database directly: `feito=true` on both
  rows, not just optimistic UI state) → filled in evidence and clicked "Concluir" → task status
  visibly changed to "Concluída" and the completion/cancel panels correctly disappeared (the
  frontend's own conditional rendering for terminal-status tasks).
- Test company/user/task deleted afterward; database confirmed empty again.

**Still not exercised through the browser:** the timer UI buttons specifically (start/pause/
resume — the completion flow above used a non-timed task), and everything not built yet per the
phase 6 gaps list (chat UI, notifications UI, admin UI, local-first outbox).

## DEPLOYMENT — the frontend is live, publicly, at a real URL (2026-08-21)

Two of the three hard blockers from the "what's missing to actually use this" discussion are now
closed (bootstrapping a real company is the one left — deliberately not done, since it's the
user's own company to create, not something to do speculatively).

- **Primary: https://grupo-quintao-sgo.vercel.app** — deployed via the Vercel CLI (personal
  access token, same pattern as the Supabase CLI setup earlier), project created directly through
  the Vercel API (`POST /v10/projects`) with the name `grupo-quintao-sgo` specifically so the URL
  wouldn't carry a personal GitHub username the way GitHub Pages does (project-page URLs there are
  `<github-account>.github.io/<repo>`, tied to who owns the repo — not renameable without either
  creating a GitHub organization and transferring the repo, or a custom domain).
- **Mirror: https://fagnerrc.github.io/SGO/** — `.github/workflows/deploy-frontend.yml`, builds
  and deploys automatically on every push to `master` touching `SGO_Supabase/`. Kept running
  alongside Vercel as a zero-maintenance second copy, not replaced.
- **Real bug caught on the first Vercel deploy attempt**: `vite.config.ts`'s `base` path was
  hardcoded to `/SGO/` for every production build — correct for GitHub Pages' project-page path,
  wrong for Vercel (served from the domain root), and broke every JS/CSS asset load with 404s.
  Fixed with a `VITE_BASE_PATH` env var that only the GitHub Actions workflow sets; Vercel's
  build has no such var and correctly falls back to `/`. Verified by reading the actual built
  `index.html`'s asset paths before redeploying, then confirming in a real browser against the
  live Vercel URL.
- Full login → task list flow re-verified end-to-end against the Vercel URL specifically (not
  just assumed to work because GitHub Pages did) — same result: real bootstrap, real login,
  real session.
- `npm install`-ing the Vercel CLI surfaced 30 `npm audit` findings (1 critical) in its own
  transitive dependencies (`@vercel/fun`, `ajv`, etc.) — all local build-tooling only, never
  shipped in the deployed `dist/` bundle, same category as the pre-existing Vite/esbuild
  dev-server-only finding. Not fixed (would mean downgrading the CLI); accepted for the same
  reason.

## TASK CREATION SCREEN — built and tested through a real browser (2026-08-21)

The single hardest blocker to anyone actually using this system: there was no way to create a
task from the UI at all, only to act on tasks created via the API. Built `src/views/taskCreate.ts`
(title/description/area/tipo/prazo/estimativa/prioridade/risco, a responsável picker sourced from
a real `listCompanyProfiles()` query against `profiles`, and a dynamic add/remove checklist
builder) plus `createTask()` in `src/lib/tasks.ts` and the `#/tasks/new` route. Tested by actually
clicking through it in a browser against the live project: filled every field, added two checklist
items, submitted, landed on the new task's detail page, and confirmed directly in the database
that every field (`code`, `titulo`, `area`, `tipo`, `prioridade`, `risco`, `estimativa`) persisted
exactly as entered.

Two things that looked like bugs during this test turned out to be artifacts of the **browser
automation tool** used to drive the test, not the product — worth recording so a future session
doesn't waste time chasing them again: (1) a synthetic "press Enter" action didn't trigger the
checklist input's `keydown` listener, but dispatching a real `KeyboardEvent('keydown', {key:
'Enter'})` via `element.dispatchEvent()` fired it correctly — confirmed the listener code itself
is right, a real keyboard's Enter key behaves like the dispatched event, not like the automation
tool's synthetic key action. (2) Typing text containing a Portuguese accented character
("relatório") into a field once left it empty — worked fine immediately after with an
unaccented string, and again when set via `dispatchEvent`. Neither should recur when a real
person uses a real keyboard.

## DASHBOARD, KANBAN, APROVAÇÕES, COLABORADORES — built and tested through a real browser (2026-08-21)

Ported the four highest-value remaining screens from the old `Index.html`, chosen by the user
from a menu of all the pages the old system had. New: `src/views/nav.ts` (shared top nav, hides
"Colaboradores" unless the viewer's role is `admin`/`diretoria`/`auditoria`), `src/views/
dashboard.ts` + `src/lib/dashboard.ts` (KPI grid, status breakdown, recent activity — the two
Chart.js canvases from the old dashboard were deliberately replaced with plain CSS bar rows
rather than pulling in a charting dependency for one screen), `src/views/kanban.ts` (7 fixed
status columns), `src/views/approvals.ts` (pending-approval list with real Approve/Reject
actions), `src/views/collaborators.ts` (admin table + collaborator creation form). All four
existing screens (`taskList`, `taskDetail`, `taskCreate`) were adjusted to render the shared nav.

The collaborator form deliberately only exposes the fields that already exist on `profiles`
(nome, e-mail, área, perfil de acesso) — the old modal's Cargo, Capacidade semanal, Substituto,
Processos principais, and Observações fields have no schema support yet and aren't read by any
automation, so they were left out rather than added as dead inputs. Flagged back to the user;
add them (schema + form) if they turn out to matter in practice.

Verified against a freshly seeded demo company ("Grupo Quintao", 4 users, 5 tasks in varied
states, a linked process) through a real browser — not just a build check. This found **two real
bugs**, both now fixed:

1. **Every error message in the app rendered as `[object Object]`.** Every `lib/*.ts` function
   did `if (error) throw error;` on a Supabase `{ data, error }` response, and every view's error
   display did `err instanceof Error ? err.message : String(err)`. `PostgrestError` (and the
   other supabase-js error shapes) don't extend the native `Error` class, so `instanceof Error`
   was false everywhere, and `String()` on the plain error object produced `[object Object]`
   instead of the real message. Caught by deliberately triggering a real server-side rejection
   (approving a task as a non-approver) and reading the on-screen error instead of just checking
   that the action failed. Fixed with a `throwSupabaseError()` helper in `src/lib/supabase.ts`
   that all of `tasks.ts`/`dashboard.ts`/`profiles.ts` now route errors through, so every thrown
   error is a real `Error` from here on.
2. **The new collaborator's one-time temporary PIN was shown and then immediately erased.**
   `collaborators.ts`'s submit handler set the result banner text, then called `renderPage(shell)`
   — a full re-render of the entire screen, including recreating the "novo colaborador" panel in
   its default-hidden state — which wiped the banner before a real admin could ever read it. This
   is the one piece of information in that whole flow that matters (there's no "forgot PIN"
   recovery), so it was a real functional bug, not cosmetic. Caught by checking the DOM
   immediately after a real form submission instead of assuming success from the request
   succeeding. Fixed by splitting the render into `renderPage()` (full page, once) and
   `refreshRows(shell)` (table body only, used after every mutation), so the result banner and
   the "novo colaborador" panel's open/closed state now survive a successful creation.

Demo data (company, 6 profiles including two created live through the collaborator form, 5
tasks, 1 process) was fully deleted afterward via a scoped cleanup script (delete children by
`company_id` in FK order, then profiles, then the company, then each `auth.users` row via the
Admin API) — nothing from this test run remains in the live project.

## VISUAL REDESIGN + KANBAN DRAG-AND-DROP (2026-08-21)

The first four screens worked but looked like a test harness (system font, flat gray cards, no
brand identity) — expected at that stage, but not something to hand to real users. Redesigned the
whole app to match the maturity of the old Apps Script system, using two references: the old
`Index.html`'s design system (sidebar, KPI cards, badges, modals) read directly from source, and
the **live** old system (`script.google.com/.../exec`, real admin login) for real branding —
which turned out to be **green** (leaf logo, green gradient login, green sidebar), not the
purple/indigo that dominates the old system's internal CSS tokens. Getting into the live system
needed the user to type the login themselves in the shared browser pane: the login form runs
inside a Google Apps Script sandboxed iframe three layers deep
(`script.google.com` → Google sandbox → `userHtmlFrame`, loaded via `postMessage`), and this
session's browser-automation tool can dispatch clicks into it but not synthetic keystrokes —
confirmed by checking `document.querySelectorAll('iframe')` at each layer rather than assuming.

Changes:
- `src/style.css`: full new token set (green brand palette, badge/status colors, shadows,
  radii), Inter font (Google Fonts link in `index.html`).
- `src/views/nav.ts`: rewritten from a top bar to a fixed sidebar (brand, links with icons, user
  + logout footer), collapsible off-canvas below 860px. Same function signature, so every
  existing screen kept working unchanged.
- `src/views/badges.ts` (new): `statusBadge()`/`priorityBadge()`/`riskBadge()`, ported from the
  old system's equivalent functions, now shared by `taskList`, `taskDetail`, `kanban`,
  `approvals` instead of each screen inventing its own status text.
- `src/views/modal.ts` (new): a small dependency-free modal (`openFormModal()`) for the handful
  of actions that need to collect a field before calling a mutating RPC — replaces the native
  `prompt()` used for cancel/reject motivo, now also used by the Kanban's drag targets.
- `src/views/kanban.ts`: real drag-and-drop (native HTML5 `dragstart`/`dragover`/`drop`, same
  pattern as the old system, no new dependency), plus a `<select>` "Mover para..." fallback on
  every card for accessibility/mobile. Cards now show priority badge, progress bar, responsible
  person's initials, and deadline (highlighted red if overdue).

**The hard part wasn't styling — it was that every column-to-column drag has to correspond to a
real, allowed database transition.** Since the migration to Supabase, `enforce_task_transition()`
(0003_tasks.sql) only allows a status change through its one dedicated function — there is no
generic "set status to X". Read that trigger directly (not assumed) and built an explicit
per-status transition table in `kanban.ts` (`transitionsFor(task)`) so a card only offers/accepts
drops that are actually legal; anything requiring extra input (motivo, evidência, quem está sendo
aguardado) opens the new modal first.

That reading surfaced **two real backend gaps**, both fixed:
1. `wait_task()` (→ "Aguardando terceiro") existed in the database since the original migration
   but was never wrapped in `lib/tasks.ts` — the frontend had no way to reach that status at all
   until now.
2. **`'Auditada'` was structurally unreachable.** The status has existed in the enum and in the
   trigger's gated-status list since day one (requiring `action = 'audit'`), but no function ever
   set that action — confirmed by grepping every migration for `create function` and finding
   nothing. Worse, even a correctly-written `audit_task()` would still have failed: the same
   trigger treats `'Concluída'` as terminal and blocks any further change unless
   `action = 'reopen'`, and auditing only makes sense on an already-completed task. Fixed both
   parts in `0025_audit_task.sql`: the trigger gets one narrow additional exception
   (`'Concluída' → 'Auditada'` via `action = 'audit'`, nothing else about terminal-state
   protection changes), and the new `audit_task()` function is restricted to
   `auditoria`/`diretoria`/`admin` and requires the task to currently be `'Concluída'`.

Verified against the real project, not just read: an 8-assertion Node script confirmed a
colaborador can't audit an in-progress or completed task, an auditor can't audit a task that
isn't `'Concluída'` yet, an auditor *can* audit a completed one, and `'Auditada'` is still
terminal afterward (can't cancel it). Then re-seeded a small realistic dataset under the real
`Grupo Quintão` company and drove every screen through a real browser logged in as the real
admin: Dashboard, Kanban (including an actual native drag via dispatched `DragEvent`s, since the
click-drag automation action doesn't fire real HTML5 DnD events — same class of tool limitation
as earlier sessions, confirmed by dispatching real events instead of assuming), Aprovações, and
Colaboradores all render correctly with the new design. All seeded test profiles/tasks were
deleted afterward; the real `fagner@gmail.com` admin account, `taina@gmail.com` (a real
collaborator the user had already added independently), and a real "Teste" task the user created
themselves while trying out the site were all left untouched.

**One more real bug, found only because the production deploy was re-checked after going
live:** the production site got stuck forever on "Carregando..." for a stale/invalidated
session, with an uncaught `TypeError: Cannot read properties of null (reading 'split')`.
Root cause: `current_profile()` (`0002_core_tables.sql`/`0008_auth_functions.sql`) is declared
`returns profiles` (a single row, not `setof`) — when its `where id = auth.uid() and
session_is_valid()` matches nothing, Postgres doesn't return "no rows", it returns **one row
where every column is null**, which PostgREST forwards as a 200 with an all-null object. The
frontend treated that truthy-but-empty object as a real profile and crashed computing avatar
initials from a null `full_name`. Any user whose session goes stale while the tab is still open
(PIN reset elsewhere, deactivation) would have hit this. Fixed in two places: `getMyProfile()`
(`src/lib/profiles.ts`) now checks `data?.id` and throws a clear `SGO_SESSION_INVALID` error
instead of trusting the shape; `renderNav()` (`src/views/nav.ts`) now specifically catches that
error, clears the local session, and redirects to `#/login`, instead of silently rendering a
profile-less shell. Reproduced with the exact stale JWT via a direct RPC call before writing the
fix, and confirmed fixed the same way afterward.

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
- Four screens (`src/views/`): login, task list, **task creation** (added 2026-08-21 — title,
  description, area, tipo, responsável picked from a real `listCompanyProfiles()` query, prazo,
  estimativa, prioridade, risco, and a dynamic add/remove checklist builder), task detail (timer
  controls, checklist, complete-with-evidence, cancel-with-reason). A ~50-line hash router
  (`src/app.ts`) ties them together, including `#/tasks/new`.
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
- No chat UI, no notification center UI, no admin/template-management screens, no diagnostics
  view. Task creation is now covered (see above); everything else is still "view my tasks, act
  on one task, create a task."
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

1. **RESOLVED 2026-08-21 — see "LIVE VALIDATION" section at the top of this file.** All 22
   migrations now apply cleanly to a real Supabase project, and the full auth flow (bootstrap →
   login → RLS-protected query → logout → session actually revoked) was verified end-to-end.
   What's genuinely still unverified: task-mutation/chat/notification *content correctness*, and
   whether `jsonb_array_elements_text(...)::uuid`/`::text` in `0007`'s `update_task()` behaves as
   expected against a real call (never exercised).
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
5. **RESOLVED 2026-08-21** — 0009 applies cleanly (its `dedup_key` handling was rewritten from a
   generated column to a trigger during live validation; see item 1 above). Not yet verified:
   that notifications actually get created with correct content when a real task/feedback/
   message is inserted — only that the schema/trigger *definitions* apply without error.
6. **No per-company timezone yet.** `0010`'s daily generation and deadline math both run on UTC
   wall-clock time (`task_templates.deadline_time` is interpreted as UTC, `generate_daily_tasks`
   fires at `5 0 * * *` UTC). Fine for a single-timezone company, wrong the moment SGO serves a
   company outside UTC — a `companies.timezone` column plus timezone-aware generation is the
   right fix, not implemented yet. `generate_deadline_notifications()` itself doesn't have this
   problem (it compares real timestamps, not wall-clock dates), only the daily generation time
   and the templates' `deadline_time` do.
7. **RESOLVED 2026-08-21** — confirmed via `select * from cron.job` against the live project:
   both `sgo-generate-daily-tasks` and `sgo-deadline-notifications` are registered and active.
   Not yet verified: that a real scheduled run actually produces correct rows (only that the job
   itself is correctly scheduled) — check `cron.job_run_details` after the next natural firing,
   or call the underlying functions manually with seed data.
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

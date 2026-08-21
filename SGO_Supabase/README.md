# SGO — Supabase rewrite

This is a from-scratch rewrite of the SGO task-management system (originally Google Apps
Script + Google Sheets, see `../SGO_v12_18_4_FINAL/`) on top of Supabase (Postgres + Auth +
Row Level Security + Realtime + Edge Functions).

It keeps the same modules and feature set as the original — see
`../SGO_Supabase_Migration_Prompt.md` for the full migration plan this project follows,
including the module-by-module mapping and the list of bugs from the original code review
that this rewrite is specifically designed not to repeat.

**This folder is fully independent of `../SGO_v12_18_4_FINAL/`.** The old Apps Script system
keeps running in production untouched while this is built out; nothing here reads from or
writes to it.

## Status

See [`PROGRESS.md`](./PROGRESS.md) for what's done and what's next.

**Live at https://grupo-quintao-sgo.vercel.app** (Vercel project `grupo-quintao-sgo`, deployed
manually so far via `vercel deploy --prod`) — chosen over the GitHub Pages deployment below as
the primary URL specifically because Vercel's `*.vercel.app` subdomain comes from the **project
name**, not the GitHub account that owns the repo, so the link doesn't carry a personal
username. Also live at https://fagnerrc.github.io/SGO/, deployed automatically by
`.github/workflows/deploy-frontend.yml` on every push to `master` that touches this folder — kept
running as a second, zero-maintenance mirror. Both read `VITE_SUPABASE_URL`/
`VITE_SUPABASE_ANON_KEY` from their own platform's secret store (Vercel env vars / GitHub repo
secrets, neither committed) and bake them into the build; the anon key is safe to ship publicly,
RLS is what actually protects data. `vite.config.ts`'s `base` path differs between the two (root
`/` for Vercel, `/SGO/` for the GitHub Pages project-page path) via the `VITE_BASE_PATH` env var,
which only the GitHub Actions workflow sets.

## Structure

```
SGO_Supabase/
├── supabase/
│   ├── migrations/   — SQL schema, in order (0001, 0002, ...)
│   └── functions/    — Edge Functions (Deno): pin-login, admin-create-user
├── src/               — frontend (plain TypeScript + Vite, no framework)
│   ├── lib/           — supabase client, session, auth, tasks data access
│   └── views/         — login, task list, task detail
├── .env.example       — backend/Edge Function env vars (placeholders only)
└── .env.local.example — frontend (Vite) env vars (placeholders only)
```

## Getting started (once you have a Supabase project)

1. Create a project at [supabase.com](https://supabase.com) (or run Supabase locally with the
   Supabase CLI).
2. Copy `.env.example` to `.env` and fill in your project's `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_JWT_SECRET` — **never commit
   real values**. These are used by the Edge Functions (`supabase secrets set`).
3. Apply the migrations in `supabase/migrations/` in order, either via the Supabase CLI
   (`supabase db push`) or by pasting each file into the SQL editor in order. Enable the
   `pg_cron` extension first (dashboard → Database → Extensions) — `0010` schedules jobs with it.
4. Deploy the Edge Functions: `supabase functions deploy pin-login` and
   `supabase functions deploy admin-create-user`.
5. For the frontend: `npm install`, copy `.env.local.example` to `.env.local` and fill in the
   same URL/anon key, then `npm run dev` (or `npm run build` for a production bundle in
   `dist/`).
6. **None of the above has actually been run against a real Supabase project as part of this
   session** — only `npm run build` and a local dev-server smoke test of the login screen have
   been verified. See `PROGRESS.md` for what to double-check first, especially before deploying
   the SQL migrations.

## Auth model (phase 3)

Login is still PIN-based, like the original system — not email/password or magic links. Since
that isn't a native Supabase Auth strategy, `supabase/functions/pin-login/` does the sign-in:
it calls `verify_login()` (a Postgres function that checks the PIN hash and lockout state), and
on success signs its own Supabase-compatible JWT using the project's JWT secret. That token
works directly with every other part of the app (`SELECT`s through RLS, and the phase 2 RPC
functions) — there's no separate "app session" concept layered on top. A custom `session_id`
claim in that JWT is checked on every request (`session_is_valid()` in
`0008_auth_functions.sql`), which is what makes an admin's PIN reset invalidate a user's
existing session immediately, not just for their next login. `supabase/functions/
admin-create-user/` provisions a new collaborator (creates the underlying Supabase Auth user +
an initial temporary PIN) — see `PROGRESS.md` for the current gap around bootstrapping the very
first user of a brand-new project.

## First-time setup (phase 7)

There's no seed data and no default admin account. After applying the migrations and deploying
the Edge Functions, call `bootstrap-company` once to create the first company and its first
admin:

```bash
curl -X POST https://your-project-ref.supabase.co/functions/v1/bootstrap-company \
  -H "Content-Type: application/json" \
  -d '{"company_name":"Grupo Quintão","admin_email":"admin@example.com","admin_full_name":"Admin","admin_pin":"1234"}'
```

It's safe to leave deployed permanently — it locks itself out the moment a company exists. From
there, that admin logs in via `pin-login` and uses `admin-create-user` to invite everyone else.

## Design decisions worth knowing before you read the schema

- **Mutations go through functions, not raw table writes.** For `tasks`, `notifications`,
  `logs`, `sessions`, `login_attempts`, and `operations`, Row Level Security is configured so
  that regular clients can only ever `SELECT` — there is deliberately no `INSERT`/`UPDATE`/
  `DELETE` policy for the `authenticated` role. All business logic (creating a task, moving it
  through its timer states, completing it, resetting a PIN, ...) happens inside
  `SECURITY DEFINER` Postgres functions that enforce the rule and then write with elevated
  privilege. This is what makes several of the original bugs (a generic "update" reaching a
  status it shouldn't, a stale write silently resurrecting a completed task) structurally
  impossible here, rather than just checked in application code.
- **Child tables instead of embedded JSON arrays.** `historico`, `comentarios`, `links`, and
  timer sessions were arrays inside the task record in the old system, which is why it needed
  manual archiving logic once they grew too large. Here they're normal queryable child tables
  with no size ceiling.
- **`current_user_role()`, `current_company()`, `is_privileged()`** (in
  `0002_core_tables.sql`) are the RLS-policy equivalents of the old
  `canWriteRecordV10_`/`visibilityForRecordV12_` permission functions — read those first if
  you're trying to understand who can see what.

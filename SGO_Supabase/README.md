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

## Structure

```
SGO_Supabase/
├── supabase/
│   ├── migrations/   — SQL schema, in order (0001, 0002, ...)
│   └── functions/    — Edge Functions (Deno), added from Phase 2 onward
├── src/               — frontend (added from Phase 6 onward)
└── .env.example       — required environment variables (placeholders only)
```

## Getting started (once you have a Supabase project)

1. Create a project at [supabase.com](https://supabase.com) (or run Supabase locally with the
   Supabase CLI).
2. Copy `.env.example` to `.env` and fill in your project's `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` — **never commit real values**.
3. Apply the migrations in `supabase/migrations/` in order, either via the Supabase CLI
   (`supabase db push`) or by pasting each file into the SQL editor in order.
4. The migrations have not yet been run against a real Supabase project as part of this
   session — see `PROGRESS.md` for what to double-check first.

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

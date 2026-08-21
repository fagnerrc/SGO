-- SGO on Supabase — fix a real bug found by actually running functional
-- tests against the live project: querying `profiles` as an authenticated
-- user (directly, or indirectly — e.g. task_checklist_items_select checks
-- tasks_select, which checks profiles for the gestor-of-area clause)
-- failed with `42P17 infinite recursion detected in policy for relation
-- "profiles"`.
--
-- Root cause: `profiles_select`'s own USING clause contains
-- `select unnest(company_access) from profiles where id = auth.uid()` — a
-- plain subquery against `profiles`, evaluated as the querying role. To
-- return rows from that subquery, Postgres must evaluate `profiles_select`
-- again on them (RLS applies to every scan of the table, including one a
-- policy's own body triggers), which needs to evaluate the same subquery
-- again, forever. `companies_select` has the identical subquery — it
-- doesn't recurse *itself* (companies and profiles are different tables),
-- but it inherits the same failure the instant it touches profiles, since
-- profiles' own policy is what's actually broken.
--
-- `current_company()`/`current_user_role()`/etc. never had this problem:
-- they're SECURITY DEFINER, so their internal `select ... from profiles`
-- runs as the function's owner (postgres, who owns `profiles` and bypasses
-- RLS on it entirely) — not as the querying role. The fix here is the same
-- pattern: move the self-referencing lookup into a SECURITY DEFINER
-- function so it bypasses RLS instead of re-entering it.

create function caller_company_access()
returns uuid[]
language sql
security definer
stable
set search_path = public
as $$
  select company_access from profiles where id = auth.uid();
$$;

alter policy companies_select on companies
  using (id = current_company() or id = any (caller_company_access()));

alter policy profiles_select on profiles
  using (company_id = current_company() or company_id = any (caller_company_access()));

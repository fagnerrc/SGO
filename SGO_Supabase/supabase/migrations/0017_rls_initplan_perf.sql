-- SGO on Supabase — fix a real performance finding from `supabase db
-- advisors` (auth_rls_initplan) against the live project: `companies_select`
-- (and `profiles_select`, same pattern) call `auth.uid()` directly inside
-- their USING clause. Postgres's planner then re-evaluates that call once
-- PER ROW scanned, instead of once per statement — negligible on a small
-- table today, real at scale. Supabase's documented fix is to wrap it as
-- `(select auth.uid())`: the subquery form lets the planner treat it as an
-- initplan, evaluated once and reused. 0006 (already applied) predates
-- this fix, hence ALTER POLICY here rather than an edit there.

alter policy companies_select on companies
  using (id = current_company() or id = any (select unnest(company_access) from profiles where id = (select auth.uid())));

alter policy profiles_select on profiles
  using (company_id = current_company() or company_id = any (select unnest(company_access) from profiles where id = (select auth.uid())));

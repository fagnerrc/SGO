-- SGO on Supabase — the diagnostics module the checklist asked for.
--
-- The backend groundwork for this already existed from phase 7
-- (0012_admin_diagnostics.sql): a `logs` table with kind='diagnostic',
-- RLS that already lets privileged roles read every log in the company,
-- and a report_client_error() function — but nothing ever called it (the
-- frontend's global error handler only showed a toast) and there was no
-- screen to read `logs` back. This closes both gaps: a `level` column
-- for real filtering, a richer report_client_error() signature, and a
-- get_cron_status() read so the two scheduled jobs (0010) are finally
-- observable from the app instead of only via a manual `select * from
-- cron.job_run_details`.
--
-- Old system comparison (V12_Diagnostics.gs): it had NIVEL/ORIGEM/MODULO
-- fields on a separate technical-log sheet, captured client errors, RPC
-- failures/slowness, and exported a JSON bundle — but never had a real
-- viewing screen for that technical log (only for a separate, manually
-- curated "erros" list), and never had an on-demand active health-check
-- runnable from the UI. Both gaps are closed here rather than replicated.

alter table logs add column level text not null default 'info' check (level in ('info', 'warn', 'error'));

-- Backfill: every existing row is a *_FAILED entry from the scheduled-job
-- exception handlers (0010) — all genuine errors, none of them 'info'.
update logs set level = 'error' where kind = 'security';

create index logs_level_idx on logs (company_id, level, created_at desc);

-- ---------------------------------------------------------------------
-- report_client_error(): broadened from the phase-7 version (message +
-- context only) to carry a level and an action code, so the diagnostics
-- screen can actually filter/triage instead of every row being an
-- identical 'CLIENT_ERROR'. p_context still takes anything free-form
-- (stack, url, module, user_agent, duration_ms, ...) — same "insert
-- straight into logs, no buffering" reasoning as the original.
-- ---------------------------------------------------------------------

drop function if exists report_client_error(text, jsonb);

create function report_client_error(
  p_message text,
  p_context jsonb default '{}'::jsonb,
  p_level text default 'error',
  p_action text default 'CLIENT_ERROR'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_level text := lower(coalesce(p_level, 'error'));
begin
  if v_level not in ('info', 'warn', 'error') then
    v_level := 'error';
  end if;
  insert into logs (company_id, kind, user_id, level, action, details)
    values (
      current_company(), 'diagnostic', auth.uid(), v_level, coalesce(p_action, 'CLIENT_ERROR'),
      jsonb_build_object('message', p_message) || coalesce(p_context, '{}'::jsonb)
    );
end;
$$;

grant execute on function report_client_error(text, jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- get_cron_status(): read-only visibility into the two pg_cron jobs from
-- 0010_scheduled_automation.sql. cron.job/cron.job_run_details live in
-- the `cron` schema, which a plain `authenticated` role can't read
-- directly — this function runs as its (superuser-ish) owner via
-- SECURITY DEFINER and re-checks is_privileged() itself, the same
-- pattern as every other admin-only RPC in this project.
-- ---------------------------------------------------------------------

create function get_cron_status()
returns jsonb
language plpgsql
security definer
set search_path = public, cron
as $$
declare
  v_result jsonb;
begin
  if not is_privileged() then
    raise exception 'SGO_FORBIDDEN: only a privileged role may read scheduled-job status';
  end if;

  select coalesce(jsonb_agg(job), '[]'::jsonb) into v_result
  from (
    select
      j.jobname,
      j.schedule,
      j.active,
      last_run.status as last_status,
      last_run.start_time as last_start,
      last_run.end_time as last_end
    from cron.job j
    left join lateral (
      select status, start_time, end_time
      from cron.job_run_details d
      where d.jobid = j.jobid
      order by d.start_time desc
      limit 1
    ) last_run on true
    where j.jobname in ('sgo-generate-daily-tasks', 'sgo-deadline-notifications')
  ) job;

  return v_result;
end;
$$;

grant execute on function get_cron_status() to authenticated;

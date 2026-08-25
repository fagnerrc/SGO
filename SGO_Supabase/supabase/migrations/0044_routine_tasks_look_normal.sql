-- SGO on Supabase — a task born from a Rotina Periódica should look and
-- count exactly like a task someone created by hand: same tipo (Tarefa
-- agendada — the closest existing "normal" full task, with checklist and
-- prazo support already built in), same lists, same dashboards, no
-- separate badge anywhere. routine_id/routine_occurrence_key stay on the
-- row (0036) — that plumbing is still what makes anti-duplication and the
-- Rotinas admin screen's own traceability work, it's just no longer
-- surfaced to the person actually working the task.
--
-- Also now sets data_inicio (0035) to the same instant the task was
-- created, matching what a manually-created Tarefa Agendada normally has
-- — previously only prazo was set, so a routine-born task never showed a
-- início or an on-time/atrasada indicator on its detail page.

create or replace function generate_periodic_routine_tasks()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dow_names text[] := array['MON','TUE','WED','THU','FRI','SAT','SUN'];
  v_routine routines;
  v_local_date date;
  v_dow text;
  v_creation_instant timestamptz;
  v_deadline_instant timestamptz;
  v_occurrence_key text;
  v_task_id uuid;
  v_checklist_item text;
begin
  for v_routine in
    select * from routines where status = 'ACTIVE' for update skip locked
  loop
    begin
      v_task_id := null;
      v_local_date := (now() at time zone v_routine.timezone)::date;
      v_dow := v_dow_names[extract(isodow from v_local_date)::int];

      if not (v_dow = any(v_routine.week_days)) then
        continue;
      end if;

      v_creation_instant := (v_local_date + v_routine.creation_time) at time zone v_routine.timezone;
      if now() < v_creation_instant then
        continue;
      end if;

      v_occurrence_key := v_routine.code || '_' || to_char(v_local_date, 'YYYY-MM-DD');
      if exists (select 1 from tasks where routine_occurrence_key = v_occurrence_key) then
        continue;
      end if;

      v_deadline_instant := (v_local_date + v_routine.deadline_time) at time zone v_routine.timezone;

      insert into tasks (
        company_id, area, process_id, titulo, descricao, tipo,
        solicitante_id, responsavel_id, participantes, prazo, prazo_manual, data_inicio,
        prioridade, risco, tags, routine_id, routine_occurrence_key
      ) values (
        v_routine.company_id, v_routine.area, v_routine.process_id, v_routine.name, v_routine.description, 'Tarefa agendada',
        v_routine.created_by, v_routine.responsible_id, v_routine.participant_ids, v_deadline_instant, true, v_creation_instant,
        v_routine.priority, v_routine.risk, v_routine.tags, v_routine.id, v_occurrence_key
      )
      on conflict (routine_occurrence_key) do nothing
      returning id into v_task_id;

      if v_task_id is null then
        -- Lost a race to another concurrent run of this same function —
        -- the other run already created (or is creating) today's task.
        continue;
      end if;

      foreach v_checklist_item in array v_routine.checklist_template loop
        insert into task_checklist_items (task_id, texto, position)
          values (v_task_id, v_checklist_item,
            coalesce((select max(position) + 1 from task_checklist_items where task_id = v_task_id), 0));
      end loop;

      insert into task_history (task_id, action, to_status)
        values (v_task_id, 'Tarefa gerada automaticamente pela rotina "' || v_routine.name || '"', 'Em andamento');

      insert into routine_history (routine_id, user_id, action, details)
        values (v_routine.id, null, 'TASK_GENERATED', jsonb_build_object('task_id', v_task_id, 'occurrence_date', v_local_date));

      update routines set
        last_generated_at = now(),
        last_occurrence_date = v_local_date,
        last_generated_task_id = v_task_id,
        next_occurrence_at = compute_next_occurrence(week_days, creation_time, timezone, now())
        where id = v_routine.id;
    exception when others then
      insert into logs (company_id, kind, user_id, action, details)
        values (v_routine.company_id, 'security', v_routine.created_by, 'PERIODIC_ROUTINE_GENERATION_FAILED',
          jsonb_build_object('routine_id', v_routine.id, 'error', sqlerrm));
      insert into routine_history (routine_id, user_id, action, details)
        values (v_routine.id, null, 'GENERATION_FAILED', jsonb_build_object('error', sqlerrm));
    end;
  end loop;
end;
$$;

-- Any task already generated under the old 'Rotina periódica' tipo (today,
-- from live testing) gets relabeled too, so nothing already on the board
-- keeps standing out from a normal Tarefa Agendada.
update tasks set tipo = 'Tarefa agendada' where tipo = 'Rotina periódica';

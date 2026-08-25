-- SGO on Supabase — Presença / Atividade da Equipe. Tracks the last real
-- interaction each person had with the app (not just login) so the team
-- can see at a glance who's actively working, who's stepped away, and who
-- has gone dark for over 2h. Deliberately just two columns on `profiles`
-- rather than a new table — this is a 1:1 extension of a profile, reusing
-- the same row everyone already fetches via listCompanyProfiles(), no new
-- join needed to show it anywhere. No "status" column: ATIVO/AUSENTE/
-- INATIVO is always derived from last_activity_at vs now() on the client
-- (see src/lib/presence.ts computePresenceStatus()) — storing a status
-- string would just be a second source of truth that goes stale between
-- heartbeats.

alter table profiles add column last_activity_at timestamptz;
alter table profiles add column last_activity_session_id uuid references sessions(id) on delete set null;

-- The only way `last_activity_at` ever changes — the client's heartbeat
-- controller (presence.ts) calls this at most once per ~5min, and only
-- when there was real interaction since the last call (click/keydown/
-- navigation), never on a raw timer alone and never on every click. The
-- caller's identity comes from auth.uid()/current_session_id() exclusively
-- — there is no p_profile_id parameter, so there is nothing here for a
-- client to spoof to touch anyone else's presence (0016 of this spec).
-- The `and (last_activity_at is null or ... < now() - 30s)` guard is a
-- cheap server-side backstop against a buggy or malicious client calling
-- this far more often than intended — the client-side throttle is the
-- real control, this is defense in depth, not the primary mechanism.
create function record_activity()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not session_is_valid() then
    raise exception 'SGO_INVALID_SESSION: sessão ausente ou inválida';
  end if;

  update profiles
    set last_activity_at = now(),
        last_activity_session_id = current_session_id()
    where id = auth.uid()
      and (last_activity_at is null or last_activity_at < now() - interval '30 seconds');
end;
$$;

revoke execute on function record_activity() from anon, public;

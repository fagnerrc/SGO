// Equipes (Teams) — see 0046_teams_module.sql for the full design
// rationale. RLS alone gates every read here (teams_select/team_members_
// select/team_member_occurrences_select — supervisor of that team, or
// privileged); every write goes through a SECURITY DEFINER RPC that
// re-checks the same thing server-side, same split as tasks/routines.

import { getClient, throwSupabaseError } from "./supabase";
import type { Team, TeamMember, TeamMemberOccurrence, TeamMemberReportRow } from "./types";

export async function listMyTeams(): Promise<Team[]> {
  const { data, error } = await getClient().from("teams").select("*").order("name", { ascending: true });
  if (error) throwSupabaseError(error);
  return data as Team[];
}

export async function getTeam(teamId: string): Promise<Team> {
  const { data, error } = await getClient().from("teams").select("*").eq("id", teamId).single();
  if (error) throwSupabaseError(error);
  return data as Team;
}

export async function listTeamMembers(teamId: string): Promise<TeamMember[]> {
  const { data, error } = await getClient().from("team_members").select("*").eq("team_id", teamId).order("name", { ascending: true });
  if (error) throwSupabaseError(error);
  return data as TeamMember[];
}

export async function getTeamMember(memberId: string): Promise<TeamMember> {
  const { data, error } = await getClient().from("team_members").select("*").eq("id", memberId).single();
  if (error) throwSupabaseError(error);
  return data as TeamMember;
}

export async function listMemberOccurrences(memberId: string): Promise<TeamMemberOccurrence[]> {
  const { data, error } = await getClient()
    .from("team_member_occurrences")
    .select("*")
    .eq("team_member_id", memberId)
    .order("occurred_at", { ascending: false });
  if (error) throwSupabaseError(error);
  return data as TeamMemberOccurrence[];
}

export interface TeamOccurrenceWithMember extends TeamMemberOccurrence {
  member_name: string;
}

// All occurrences for every member of a team, regardless of month — the
// view slices this by competência client-side (same approach as the
// per-member history modal), so a report covering the whole team never
// needs a second round-trip when the user flips months.
export async function listTeamOccurrences(teamId: string): Promise<TeamOccurrenceWithMember[]> {
  const { data, error } = await getClient()
    .from("team_member_occurrences")
    .select("*, team_members!inner(name, team_id)")
    .eq("team_members.team_id", teamId)
    .order("occurred_at", { ascending: false });
  if (error) throwSupabaseError(error);
  return (data as (TeamMemberOccurrence & { team_members: { name: string } })[]).map((row) => ({
    ...row,
    member_name: row.team_members.name,
  }));
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function occurrencesToCSV(rows: TeamOccurrenceWithMember[]): string {
  const header = ["Integrante", "Data", "Motivo", "Descrição", "Observação", "Pontos descontados"];
  const csvRows = rows.map((o) => [o.member_name, o.occurred_at, o.motivo, o.descricao, o.observacao, String(o.points_deducted)]);
  return [header, ...csvRows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

// p_month accepts any date within the target month (the RPC truncates
// to month-start itself) — pass undefined for "the current month".
export async function getTeamMonthlyReport(teamId: string, month?: string): Promise<TeamMemberReportRow[]> {
  const { data, error } = await getClient().rpc("team_monthly_report", { p_team_id: teamId, p_month: month ?? undefined });
  if (error) throwSupabaseError(error);
  return (data ?? []) as TeamMemberReportRow[];
}

async function callAction<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getClient().rpc(fn, args);
  if (error) throwSupabaseError(error);
  return data as T;
}

export const createTeam = (name: string, monthlyStartingPoints = 10) =>
  callAction<Team>("create_team", { p_name: name, p_monthly_starting_points: monthlyStartingPoints });

export const updateTeam = (teamId: string, name: string, monthlyStartingPoints: number) =>
  callAction<Team>("update_team", { p_team_id: teamId, p_name: name, p_monthly_starting_points: monthlyStartingPoints });

export interface TeamMemberInput {
  name: string;
  employeeCode?: string;
  role?: string;
  joinedAt?: string; // yyyy-mm-dd
  notes?: string;
}

export const addTeamMember = (teamId: string, input: TeamMemberInput) =>
  callAction<TeamMember>("add_team_member", {
    p_team_id: teamId,
    p_name: input.name,
    p_employee_code: input.employeeCode ?? "",
    p_role: input.role ?? "",
    p_joined_at: input.joinedAt ?? undefined,
    p_notes: input.notes ?? "",
  });

export const updateTeamMember = (memberId: string, input: TeamMemberInput) =>
  callAction<TeamMember>("update_team_member", {
    p_member_id: memberId,
    p_name: input.name,
    p_employee_code: input.employeeCode ?? "",
    p_role: input.role ?? "",
    p_joined_at: input.joinedAt ?? undefined,
    p_notes: input.notes ?? "",
  });

export const setTeamMemberStatus = (memberId: string, status: "ATIVO" | "INATIVO", reason = "") =>
  callAction<TeamMember>("set_team_member_status", { p_member_id: memberId, p_status: status, p_reason: reason });

export const addTeamOccurrence = (memberId: string, points: number, motivo: string, descricao: string, observacao = "") =>
  callAction<TeamMemberOccurrence>("add_team_occurrence", {
    p_member_id: memberId,
    p_points: points,
    p_motivo: motivo,
    p_descricao: descricao,
    p_observacao: observacao,
  });

// Cached per tab, same reasoning as getCachedProfile()/getCachedTeamPresence
// — nav.ts needs this on every render just to decide whether "Equipes"
// shows up at all, and it's cheap to get wrong in the wasteful direction
// (a few seconds stale) but not in the "extra query on every navigation"
// direction.
let cachedMyTeams: Team[] | null = null;

export async function getCachedMyTeams(): Promise<Team[]> {
  if (!cachedMyTeams) cachedMyTeams = await listMyTeams();
  return cachedMyTeams;
}

export function clearCachedMyTeams(): void {
  cachedMyTeams = null;
}

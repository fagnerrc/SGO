import { getClient, throwSupabaseError } from "./supabase";
import type { Profile } from "./types";

export async function listCompanyProfiles(): Promise<Profile[]> {
  const { data, error } = await getClient()
    .from("profiles")
    .select("id, full_name, email, role, area, active, capacidade_semanal")
    .eq("active", true)
    .eq("excluido", false)
    .order("full_name", { ascending: true });
  if (error) throwSupabaseError(error);
  return data as Profile[];
}

// Same query without the active filter — the collaborator management
// screen needs to show (and let an admin reactivate) inactive people too,
// unlike every other picker in the app which should only ever offer
// active collaborators. Still excludes excluido=true (deleted) — those
// only ever show up in the trash view (listDeletedProfiles).
export async function adminListProfiles(): Promise<Profile[]> {
  const { data, error } = await getClient()
    .from("profiles")
    .select("id, full_name, email, role, area, active, capacidade_semanal")
    .eq("excluido", false)
    .order("full_name", { ascending: true });
  if (error) throwSupabaseError(error);
  return data as Profile[];
}

export async function listDeletedProfiles(): Promise<Profile[]> {
  const { data, error } = await getClient()
    .from("profiles")
    .select("id, full_name, email, role, area, active, capacidade_semanal")
    .eq("excluido", true)
    .order("full_name", { ascending: true });
  if (error) throwSupabaseError(error);
  return data as Profile[];
}

export async function getMyProfile(): Promise<Profile> {
  const { data, error } = await getClient().rpc("current_profile");
  if (error) throwSupabaseError(error);
  // current_profile() is `returns profiles` (a single row, not `setof`) —
  // when the session is valid but doesn't match any profile (revoked,
  // deleted), Postgres doesn't return "no rows", it returns one row with
  // every column null. PostgREST forwards that as a 200 with an all-null
  // object, which would otherwise be mistaken for a real (if odd) profile.
  if (!data?.id) {
    throw new Error("SGO_SESSION_INVALID: sessão inválida ou expirada");
  }
  return data as Profile;
}

export interface NewCollaboratorInput {
  email: string;
  fullName: string;
  role: string;
  area: string;
}

// Calls the admin-create-user Edge Function (0012/phase 7) — creating a
// collaborator isn't a plain table insert, it has to go through the Admin
// API to create the underlying auth.users row (see that function's own
// comments for why). Returns the temporary PIN so the admin can hand it to
// the new collaborator; there is no "forgot PIN" self-service flow yet, so
// losing this value means asking an admin to reset it instead.
export async function createCollaborator(input: NewCollaboratorInput): Promise<{ profileId: string; temporaryPin: string }> {
  const { data, error } = await getClient().functions.invoke("admin-create-user", {
    body: { email: input.email, full_name: input.fullName, role: input.role, area: input.area },
  });
  if (error) throwSupabaseError(error);
  if (!data?.success) {
    throw new Error(data?.errorCode ?? "CREATE_COLLABORATOR_FAILED");
  }
  return { profileId: data.profile_id, temporaryPin: data.temporary_pin };
}

async function callProfileAction(fn: string, args: Record<string, unknown>): Promise<void> {
  const { error } = await getClient().rpc(fn, args);
  if (error) throwSupabaseError(error);
}

export const setProfileActive = (profileId: string, active: boolean) =>
  callProfileAction("set_profile_active", { p_profile_id: profileId, p_active: active });

export const setProfileRole = (profileId: string, role: string) =>
  callProfileAction("set_profile_role", { p_profile_id: profileId, p_role: role });

export const setProfileCapacity = (profileId: string, capacidadeSemanal: number) =>
  callProfileAction("set_profile_capacity", { p_profile_id: profileId, p_capacidade_semanal: capacidadeSemanal });

// Soft-delete: excluido=true + active=false + sessions revoked
// (0033_soft_delete.sql) — removes the person from the roster entirely,
// distinct from just deactivating (which still shows them as "Inativo").
// Reversible via restoreProfile(), which deliberately does NOT also
// reactivate — an admin decides that separately after restoring.
export const deleteProfile = (profileId: string) => callProfileAction("delete_profile", { p_profile_id: profileId });

export const restoreProfile = (profileId: string) => callProfileAction("restore_profile", { p_profile_id: profileId });

function generateTemporaryPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4-digit temp PIN, same scheme as admin-create-user
}

// set_pin() already allows a privileged caller to set ANY profile's PIN
// (see 0014_fix_pgcrypto_search_path.sql) and revokes that profile's
// existing sessions as a side effect — an admin-triggered reset forces an
// immediate logout, same as the old system's resetUserPinServer.
export async function resetProfilePin(profileId: string): Promise<string> {
  const pin = generateTemporaryPin();
  const { error } = await getClient().rpc("set_pin", { p_profile_id: profileId, p_new_pin: pin });
  if (error) throwSupabaseError(error);
  return pin;
}

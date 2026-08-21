import { getClient } from "./supabase";
import type { Profile } from "./types";

export async function listCompanyProfiles(): Promise<Profile[]> {
  const { data, error } = await getClient()
    .from("profiles")
    .select("id, full_name, email, role, area, active")
    .eq("active", true)
    .order("full_name", { ascending: true });
  if (error) throw error;
  return data as Profile[];
}

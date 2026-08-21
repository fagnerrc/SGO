import { getClient, throwSupabaseError } from "./supabase";

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  task_id: string | null;
  created_at: string;
}

export async function listMyNotifications(limit = 20): Promise<AppNotification[]> {
  const { data, error } = await getClient()
    .from("notifications")
    .select("id, type, title, message, read, task_id, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throwSupabaseError(error);
  return data as AppNotification[];
}

// notifications_mark_read (0006_rls_policies.sql) scopes this to the
// caller's own recipient_id — a plain table update, no RPC needed, same
// as toggleChecklistItem() in lib/tasks.ts.
export async function markNotificationRead(id: string): Promise<void> {
  const { error } = await getClient().from("notifications").update({ read: true, read_at: new Date().toISOString() }).eq("id", id);
  if (error) throwSupabaseError(error);
}

import { logout } from "../lib/auth";
import { getMyProfile } from "../lib/profiles";
import type { Profile } from "../lib/types";

export type PageKey = "dashboard" | "tasks" | "kanban" | "approvals" | "collaborators";

const PRIVILEGED_ROLES = new Set(["admin", "diretoria", "auditoria"]);

// Cached for the lifetime of the tab — every page needs it just to decide
// whether to show the "Colaboradores" link, and re-fetching it on every
// single navigation would be wasteful. Cleared on logout by virtue of a
// fresh page load being required to log back in.
let cachedProfile: Profile | null = null;

export async function getCachedProfile(): Promise<Profile> {
  if (!cachedProfile) cachedProfile = await getMyProfile();
  return cachedProfile;
}

export async function renderNav(root: HTMLElement, active: PageKey): Promise<void> {
  let profile: Profile | null = null;
  try {
    profile = await getCachedProfile();
  } catch {
    // RLS/session hiccup — still render the nav without role-gated links
    // rather than block the whole page on it.
  }

  const isPrivileged = Boolean(profile && PRIVILEGED_ROLES.has(profile.role));

  const links: { key: PageKey; label: string; href: string }[] = [
    { key: "dashboard", label: "Dashboard", href: "#/dashboard" },
    { key: "tasks", label: "Tarefas", href: "#/tasks" },
    { key: "kanban", label: "Kanban", href: "#/kanban" },
    { key: "approvals", label: "Aprovações", href: "#/approvals" },
  ];
  if (isPrivileged) {
    links.push({ key: "collaborators", label: "Colaboradores", href: "#/admin/collaborators" });
  }

  root.innerHTML = `
    <nav class="topnav">
      <span class="topnav-brand">SGO</span>
      <div class="topnav-links">
        ${links
          .map((l) => `<a href="${l.href}" class="topnav-link${l.key === active ? " active" : ""}">${l.label}</a>`)
          .join("")}
      </div>
      <div class="topnav-user">
        ${profile ? `<span class="topnav-username">${escapeHtml(profile.full_name)}</span>` : ""}
        <button id="nav-logout-btn" class="link-button">Sair</button>
      </div>
    </nav>
  `;

  root.querySelector("#nav-logout-btn")!.addEventListener("click", async () => {
    await logout();
    location.hash = "#/login";
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

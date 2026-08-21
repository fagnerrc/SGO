import { logout } from "../lib/auth";
import { getMyProfile } from "../lib/profiles";
import { clearSession } from "../lib/session";
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

const ICONS: Record<PageKey, string> = {
  dashboard:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
  tasks:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  kanban:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>',
  approvals:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  collaborators:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
};

export async function renderNav(root: HTMLElement, active: PageKey): Promise<void> {
  let profile: Profile | null = null;
  try {
    profile = await getCachedProfile();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("SGO_SESSION_INVALID")) {
      // The stored token no longer maps to a live session (PIN reset,
      // deactivation, or the profile itself was removed elsewhere) —
      // without this, the page would otherwise render as an empty,
      // profile-less shell instead of sending the person back to log in.
      clearSession();
      location.hash = "#/login";
      return;
    }
    // Any other error here is a transient hiccup — still render the nav
    // without role-gated links rather than block the whole page on it.
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

  const initials = profile
    ? profile.full_name
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() ?? "")
        .join("")
    : "";

  root.innerHTML = `
    <button id="sidebar-toggle" class="sidebar-toggle" aria-label="Abrir menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
    </button>
    <div id="sidebar-backdrop" class="sidebar-backdrop"></div>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-brand">
        <span class="sidebar-brand-mark">SGO</span>
        <div>
          <h1>SGO</h1>
          <p>Grupo Quintão</p>
        </div>
      </div>
      <nav class="sidebar-nav">
        ${links
          .map(
            (l) => `
          <a href="${l.href}" class="sidebar-link${l.key === active ? " active" : ""}">
            <span class="sidebar-link-icon">${ICONS[l.key]}</span>
            <span>${l.label}</span>
          </a>`,
          )
          .join("")}
      </nav>
      <div class="sidebar-footer">
        ${
          profile
            ? `
          <div class="sidebar-user">
            <span class="avatar">${initials}</span>
            <div class="sidebar-user-info">
              <strong>${escapeHtml(profile.full_name)}</strong>
              <span>${escapeHtml(profile.role)}</span>
            </div>
          </div>`
            : ""
        }
        <button id="nav-logout-btn" class="sidebar-logout">Sair</button>
      </div>
    </aside>
  `;

  const sidebar = root.querySelector<HTMLElement>("#sidebar")!;
  const backdrop = root.querySelector<HTMLElement>("#sidebar-backdrop")!;
  const closeSidebar = () => {
    sidebar.classList.remove("open");
    backdrop.classList.remove("open");
  };
  root.querySelector("#sidebar-toggle")!.addEventListener("click", () => {
    sidebar.classList.add("open");
    backdrop.classList.add("open");
  });
  backdrop.addEventListener("click", closeSidebar);
  sidebar.querySelectorAll("a.sidebar-link").forEach((a) => a.addEventListener("click", closeSidebar));

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

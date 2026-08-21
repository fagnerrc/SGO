import { applyBranding, getBranding, type Branding } from "../lib/branding";
import { logout } from "../lib/auth";
import { listMyNotifications, markNotificationRead, type AppNotification } from "../lib/notifications";
import { getMyProfile } from "../lib/profiles";
import { clearSession } from "../lib/session";
import { createTask, getActiveTimerTask, listMyTasks, startTask } from "../lib/tasks";
import type { Profile, Task } from "../lib/types";
import { initials } from "./badges";
import { openFormModal } from "./modal";
import { refreshTimerDock } from "./timerDock";

export type PageKey = "dashboard" | "mywork" | "tasks" | "kanban" | "approvals" | "collaborators" | "processes" | "settings";

const PRIVILEGED_ROLES = new Set(["admin", "diretoria", "auditoria"]);

// Cached for the lifetime of the tab — every page needs it just to decide
// whether to show role-gated links, and re-fetching it on every single
// navigation would be wasteful. Cleared on logout by virtue of a fresh
// page load being required to log back in.
let cachedProfile: Profile | null = null;

export async function getCachedProfile(): Promise<Profile> {
  if (!cachedProfile) cachedProfile = await getMyProfile();
  return cachedProfile;
}

// Search and notifications both want "all my tasks" / "my notifications"
// without every page paying for a fresh fetch — cached per tab, cleared
// each time renderNav() runs for a genuinely new page load (see below).
let searchTasksPromise: Promise<Task[]> | null = null;

const ICONS: Record<PageKey, string> = {
  dashboard:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
  mywork:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  tasks:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  kanban:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>',
  approvals:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  collaborators:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  processes:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4M6.5 10v4M17.5 10v4M10 17.5h4"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

const BELL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
const SEARCH_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const CHEVRON_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

export async function renderNav(root: HTMLElement, active: PageKey): Promise<void> {
  searchTasksPromise = null;

  const branding = await getBranding().catch(() => null);
  if (branding) applyBranding(branding);

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
    { key: "mywork", label: "Meu trabalho", href: "#/mywork" },
    { key: "tasks", label: "Tarefas", href: "#/tasks" },
    { key: "kanban", label: "Kanban", href: "#/kanban" },
    { key: "approvals", label: "Aprovações", href: "#/approvals" },
  ];
  if (isPrivileged) {
    links.push({ key: "collaborators", label: "Colaboradores", href: "#/admin/collaborators" });
    links.push({ key: "processes", label: "Processos", href: "#/admin/processes" });
  }

  const brandName = branding?.displayName || branding?.name || "SGO";
  const brandInitials = initials(brandName) || "SG";

  root.innerHTML = `
    <button id="sidebar-toggle" class="sidebar-toggle" aria-label="Abrir menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
    </button>
    <div id="sidebar-backdrop" class="sidebar-backdrop"></div>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-brand">
        ${branding?.logoUrl ? `<img src="${escapeHtml(branding.logoUrl)}" alt="" class="sidebar-brand-logo" />` : `<span class="sidebar-brand-mark">${brandInitials}</span>`}
        <div>
          <h1>${escapeHtml(brandName)}</h1>
          <p>SGO</p>
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
    </aside>
    <header class="topbar">
      <div class="topbar-search">
        ${SEARCH_ICON}
        <input id="topbar-search-input" type="text" placeholder="Buscar tarefa por título ou código..." autocomplete="off" />
        <div id="topbar-search-results" class="topbar-search-results" hidden></div>
      </div>
      <div class="topbar-actions">
        <button type="button" id="quick-start-btn" class="quick-start-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Iniciar tarefa
        </button>
        <div class="topbar-menu-wrap">
          <button id="notif-btn" class="topbar-icon-btn" aria-label="Notificações">
            ${BELL_ICON}
            <span id="notif-badge" class="topbar-badge" hidden></span>
          </button>
          <div id="notif-panel" class="dropdown-panel dropdown-panel-wide" hidden>
            <div class="dropdown-header">Notificações</div>
            <div id="notif-list"><p class="dropdown-empty">Carregando...</p></div>
          </div>
        </div>
        <div class="topbar-menu-wrap">
          <button id="user-btn" class="topbar-user-btn">
            <span class="avatar">${profile ? initials(profile.full_name) : "?"}</span>
            ${profile ? `<span class="topbar-user-info"><strong>${escapeHtml(profile.full_name)}</strong><span>${escapeHtml(profile.role)}</span></span>` : ""}
            ${CHEVRON_ICON}
          </button>
          <div id="user-panel" class="dropdown-panel" hidden>
            ${isPrivileged ? `<a href="#/admin/settings" class="dropdown-item">Configurações</a>` : ""}
            <button id="nav-logout-btn" class="dropdown-item dropdown-item-danger">Sair</button>
          </div>
        </div>
      </div>
    </header>
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

  setupDropdown(root, "#notif-btn", "#notif-panel", () => loadNotifications(root));
  setupDropdown(root, "#user-btn", "#user-panel");
  setupSearch(root);

  root.querySelector("#quick-start-btn")!.addEventListener("click", () => void quickStartTimer(profile));
}

// "Iniciar tarefa" — the old system's fastest path to registering work:
// skip the full task form entirely, just ask what you're about to do,
// and start the timer immediately. Enforces "only one active timer per
// person" by checking before creating anything, rather than letting a
// second one start and only noticing later.
async function quickStartTimer(profile: Profile | null): Promise<void> {
  if (!profile) return;

  const existing = await getActiveTimerTask(profile.id).catch(() => null);
  if (existing) {
    alert(`Você já tem um cronômetro rodando em "${existing.titulo}" (${existing.code ?? ""}). Abrindo essa tarefa.`);
    location.hash = `#/tasks/${existing.id}`;
    return;
  }

  const values = await openFormModal({
    title: "Iniciar tarefa",
    description: "Descreva rapidamente o que você vai fazer agora — o cronômetro começa assim que confirmar.",
    fields: [{ name: "descricao", label: "Descrição da atividade", type: "textarea", required: true }],
    confirmLabel: "Iniciar",
  });
  if (!values) return;

  const descricao = values.descricao.trim();
  const titulo = descricao.split("\n")[0].slice(0, 80);

  try {
    const result = await createTask({
      titulo,
      descricao,
      area: profile.area || "Geral",
      tipo: "Tarefa cronometrada",
      responsavelId: profile.id,
      prioridade: "Normal",
      risco: "Baixo",
    });
    await startTask(result.id);
    await refreshTimerDock();
    location.hash = `#/tasks/${result.id}`;
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  }
}

function setupDropdown(root: HTMLElement, btnSelector: string, panelSelector: string, onOpen?: () => void): void {
  const btn = root.querySelector<HTMLButtonElement>(btnSelector)!;
  const panel = root.querySelector<HTMLElement>(panelSelector)!;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = panel.hidden;
    root.querySelectorAll<HTMLElement>(".dropdown-panel").forEach((p) => (p.hidden = true));
    panel.hidden = !willOpen;
    if (willOpen && onOpen) onOpen();
  });
  document.addEventListener("click", () => {
    panel.hidden = true;
  });
  panel.addEventListener("click", (event) => event.stopPropagation());
}

async function loadNotifications(root: HTMLElement): Promise<void> {
  const listEl = root.querySelector<HTMLElement>("#notif-list")!;
  let notifications: AppNotification[];
  try {
    notifications = await listMyNotifications();
  } catch {
    listEl.innerHTML = `<p class="dropdown-empty">Não foi possível carregar as notificações.</p>`;
    return;
  }
  updateBadge(root, notifications);
  if (notifications.length === 0) {
    listEl.innerHTML = `<p class="dropdown-empty">Nenhuma notificação por aqui.</p>`;
    return;
  }
  listEl.innerHTML = notifications
    .map(
      (n) => `
    <button class="notif-item${n.read ? "" : " unread"}" data-id="${n.id}" data-task-id="${n.task_id ?? ""}">
      <span class="notif-item-title">${escapeHtml(n.title)}</span>
      <span class="notif-item-message">${escapeHtml(n.message)}</span>
      <span class="notif-item-time">${new Date(n.created_at).toLocaleString("pt-BR")}</span>
    </button>`,
    )
    .join("");
  listEl.querySelectorAll<HTMLButtonElement>(".notif-item").forEach((el) => {
    el.addEventListener("click", async () => {
      const id = el.dataset.id!;
      const taskId = el.dataset.taskId;
      el.classList.remove("unread");
      await markNotificationRead(id).catch(() => {});
      if (taskId) location.hash = `#/tasks/${taskId}`;
    });
  });
}

function updateBadge(root: HTMLElement, notifications: AppNotification[]): void {
  const badge = root.querySelector<HTMLElement>("#notif-badge")!;
  const unread = notifications.filter((n) => !n.read).length;
  badge.hidden = unread === 0;
  if (unread > 0) badge.textContent = unread > 9 ? "9+" : String(unread);
}

function setupSearch(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>("#topbar-search-input")!;
  const resultsEl = root.querySelector<HTMLElement>("#topbar-search-results")!;
  let debounceHandle: ReturnType<typeof setTimeout> | null = null;

  input.addEventListener("input", () => {
    if (debounceHandle) clearTimeout(debounceHandle);
    const query = input.value.trim().toLowerCase();
    if (!query) {
      resultsEl.hidden = true;
      return;
    }
    debounceHandle = setTimeout(async () => {
      if (!searchTasksPromise) searchTasksPromise = listMyTasks();
      const tasks = await searchTasksPromise.catch(() => [] as Task[]);
      const matches = tasks
        .filter((t) => t.titulo.toLowerCase().includes(query) || (t.code ?? "").toLowerCase().includes(query))
        .slice(0, 8);
      renderSearchResults(resultsEl, matches, query);
    }, 150);
  });

  document.addEventListener("click", () => {
    resultsEl.hidden = true;
  });
  resultsEl.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("click", (event) => event.stopPropagation());
}

function renderSearchResults(resultsEl: HTMLElement, matches: Task[], query: string): void {
  if (matches.length === 0) {
    resultsEl.innerHTML = `<p class="dropdown-empty">Nenhuma tarefa encontrada para "${escapeHtml(query)}".</p>`;
  } else {
    resultsEl.innerHTML = matches
      .map(
        (t) => `
      <button class="search-result-item" data-task-id="${t.id}">
        <span class="search-result-code">${t.code ?? ""}</span>
        <span class="search-result-title">${escapeHtml(t.titulo)}</span>
      </button>`,
      )
      .join("");
    resultsEl.querySelectorAll<HTMLButtonElement>(".search-result-item").forEach((el) => {
      el.addEventListener("click", () => {
        location.hash = `#/tasks/${el.dataset.taskId}`;
      });
    });
  }
  resultsEl.hidden = false;
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

import { applyBranding, getBranding, type Branding } from "../lib/branding";
import { logout } from "../lib/auth";
import { listMyNotifications, markNotificationRead, type AppNotification } from "../lib/notifications";
import { getCachedProfile } from "../lib/profiles";
import { computePresenceStatus, getCachedTeamPresence, initPresenceHeartbeat, type TeamPresenceRow } from "../lib/presence";
import { clearSession } from "../lib/session";
import { createTask, listMyTasks, startTask } from "../lib/tasks";
import { getCachedMyTeams } from "../lib/teams";
import type { Profile, Task } from "../lib/types";
import { initials } from "./badges";
import { openFormModal } from "./modal";
import { refreshTimerDock } from "./timerDock";
import { toastError } from "./toast";

export type PageKey =
  | "dashboard"
  | "mywork"
  | "tasks"
  | "kanban"
  | "approvals"
  | "audit"
  | "reports"
  | "diagnostics"
  | "collaborators"
  | "processes"
  | "routines"
  | "presence"
  | "teams"
  | "settings";

const PRIVILEGED_ROLES = new Set(["admin", "diretoria", "auditoria"]);

// Re-exported so every existing `import { getCachedProfile } from "./nav"`
// keeps working — the actual cache now lives in lib/profiles.ts (next to
// clearCachedProfile(), which lib/auth.ts calls on login/logout; a view
// module isn't a sensible thing for a lib module to depend on).
export { getCachedProfile };

// Search and notifications both want "all my tasks" / "my notifications"
// without every page paying for a fresh fetch — cached per tab, cleared
// each time renderNav() runs for a genuinely new page load (see below).
let searchTasksPromise: Promise<Task[]> | null = null;

// The greeting/clock ticks against whatever nav-mount is currently in the
// DOM — renderNav() replaces that container on every navigation, so the
// old interval has to be torn down each time or it just keeps writing
// into detached nodes forever.
let greetingInterval: ReturnType<typeof setInterval> | null = null;

// Same reasoning as greetingInterval, split in two: presenceTickInterval
// only re-renders the already-fetched list's "há Xmin" text locally (no
// network), presencePollInterval is the much rarer one that actually
// re-fetches from the server — see loadPresenceSidebar() below.
let presenceTickInterval: ReturnType<typeof setInterval> | null = null;
let presencePollInterval: ReturnType<typeof setInterval> | null = null;

// Registered once, not per-render: this listens on `document`, which
// outlives every nav-mount replacement, so re-adding it on each
// renderNav() call would stack up a duplicate handler per navigation.
let searchShortcutBound = false;

function greetingText(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Boa madrugada";
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

function clockText(): string {
  const now = new Date();
  const date = now.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
  const time = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${date.charAt(0).toUpperCase()}${date.slice(1)} · ${time}`;
}

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
  audit:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h6a1 1 0 0 1 1 1v1h1a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h1V3a1 1 0 0 1 1-1Z"/><path d="m9 13 2 2 4-4"/></svg>',
  reports:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  diagnostics:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  collaborators:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  processes:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4M6.5 10v4M17.5 10v4M10 17.5h4"/></svg>',
  routines:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2.1l4 4-4 4"/><path d="M3 12.2v-2a4 4 0 0 1 4-4h14"/><path d="M7 21.9l-4-4 4-4"/><path d="M21 11.8v2a4 4 0 0 1-4 4H3"/></svg>',
  presence:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><circle cx="19" cy="8" r="3.2" fill="currentColor" stroke="none"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  teams:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M12 12v2"/></svg>',
};

const BELL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
const SEARCH_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const CHEVRON_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

export async function renderNav(root: HTMLElement, active: PageKey): Promise<void> {
  searchTasksPromise = null;
  if (greetingInterval) {
    clearInterval(greetingInterval);
    greetingInterval = null;
  }
  if (presenceTickInterval) {
    clearInterval(presenceTickInterval);
    presenceTickInterval = null;
  }
  if (presencePollInterval) {
    clearInterval(presencePollInterval);
    presencePollInterval = null;
  }

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
  // Rotinas Periódicas is stricter than the general "privileged" tier —
  // the spec is explicit that only role='admin' (not diretoria/auditoria)
  // may see or manage it. The backend RPCs (0036) re-check this
  // themselves regardless of what this link's visibility suggests.
  const isAdmin = Boolean(profile && profile.role === "admin");
  // Relatórios matches the old system's access list exactly: privileged
  // roles plus gestor (an area manager needs their own numbers even
  // without admin/diretoria/auditoria access to everything else).
  const canSeeReports = isPrivileged || profile?.role === "gestor";
  // Equipes (0046) isn't tied to any global role — it shows up for
  // whoever actually supervises a team (Fernando, an ordinary
  // 'colaborador'), discovered by just asking what teams RLS lets them
  // see, cached per tab like everything else here. Privileged roles get
  // it too, as an oversight backstop, same as every other module.
  const myTeams = profile ? await getCachedMyTeams().catch(() => []) : [];
  const canSeeTeams = isPrivileged || myTeams.length > 0;

  const links: { key: PageKey; label: string; href: string }[] = [
    { key: "dashboard", label: "Dashboard", href: "#/dashboard" },
    { key: "mywork", label: "Meu trabalho", href: "#/mywork" },
    { key: "tasks", label: "Tarefas", href: "#/tasks" },
    { key: "kanban", label: "Kanban", href: "#/kanban" },
    { key: "approvals", label: "Aprovações", href: "#/approvals" },
  ];
  if (canSeeReports) links.push({ key: "reports", label: "Relatórios", href: "#/reports" });
  if (canSeeTeams) links.push({ key: "teams", label: "Equipes", href: "#/teams" });
  if (isPrivileged) {
    links.push({ key: "audit", label: "Auditoria", href: "#/audit" });
    links.push({ key: "presence", label: "Presença", href: "#/presence" });
    links.push({ key: "collaborators", label: "Colaboradores", href: "#/admin/collaborators" });
    links.push({ key: "processes", label: "Processos", href: "#/admin/processes" });
    links.push({ key: "diagnostics", label: "Diagnóstico", href: "#/diagnostics" });
  }
  if (isAdmin) {
    links.push({ key: "routines", label: "Rotinas", href: "#/admin/routines" });
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
            ${l.key === "presence" ? '<span id="presence-nav-badge" class="badge-dot-red" hidden></span>' : ""}
          </a>`,
          )
          .join("")}
      </nav>
      <div class="sidebar-presence" id="sidebar-presence" hidden>
        <p class="sidebar-presence-header">EQUIPE ATIVA · <span id="sidebar-presence-count">0</span></p>
        <ul class="sidebar-presence-list" id="sidebar-presence-list"></ul>
        <button type="button" class="sidebar-presence-alert" id="sidebar-presence-alert" hidden></button>
      </div>
    </aside>
    <header class="topbar">
      <div class="topbar-greeting">
        <span class="topbar-greeting-text">${greetingText()}${profile ? `, ${escapeHtml(profile.full_name.split(" ")[0])}` : ""}</span>
        <span class="topbar-greeting-clock" id="topbar-clock">${clockText()}</span>
      </div>
      <div class="topbar-search">
        ${SEARCH_ICON}
        <input id="topbar-search-input" type="text" placeholder="Buscar tarefa por título ou código..." autocomplete="off" />
        <kbd class="topbar-search-hint" id="topbar-search-hint">${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</kbd>
        <div id="topbar-search-results" class="topbar-search-results" hidden></div>
      </div>
      <div class="topbar-actions">
        <button type="button" id="quick-start-btn" class="quick-start-btn" title="Cria e já inicia uma tarefa cronometrada — dá pra ter várias abertas ao mesmo tempo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Cronômetro
        </button>
        <button type="button" id="new-scheduled-btn" class="btn-outline" title="Abre o formulário completo — título, descrição, data e hora, responsável e checklist">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="16" x2="15" y2="16"/></svg>
          Tarefa Agendada
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
  void loadNotifications(root); // populate the badge right away, not only once the bell is clicked

  if (profile) {
    // Everyone still *records* their own activity (recordActivity() has
    // no role check — it has to work for every person for the feature to
    // mean anything) — only *viewing* the team's presence is restricted.
    initPresenceHeartbeat();
    if (isPrivileged) void loadPresenceSidebar(root);
  }

  root.querySelector("#quick-start-btn")!.addEventListener("click", () => void quickStartTimer(profile));
  root.querySelector("#new-scheduled-btn")!.addEventListener("click", () => {
    location.hash = "#/tasks/new";
  });

  const clockEl = root.querySelector<HTMLElement>("#topbar-clock");
  greetingInterval = setInterval(() => {
    if (clockEl) clockEl.textContent = clockText();
  }, 20000);

  if (!searchShortcutBound) {
    searchShortcutBound = true;
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        const input = document.querySelector<HTMLInputElement>("#topbar-search-input");
        if (input) {
          event.preventDefault();
          input.focus();
          input.select();
        }
      }
    });
  }
}

// "Cronômetro" — the fastest path to registering work: a minimal
// title+description modal, no checklist, no other fields, and the
// timer starts the moment it's confirmed. Deliberately does NOT check
// for an already-running timer first — multiple Tarefa cronometrada can
// be open at once now; start_task() itself auto-pauses whichever other
// one was running (0034_multi_timer_and_required_fields.sql), so this
// never needs to block or ask first.
async function quickStartTimer(profile: Profile | null): Promise<void> {
  if (!profile) return;

  const values = await openFormModal({
    title: "Cronômetro",
    description: "O cronômetro começa assim que confirmar. Já tem outra tarefa rodando? Ela é pausada automaticamente.",
    fields: [
      { name: "titulo", label: "Título", type: "text", required: true },
      { name: "descricao", label: "Descrição", type: "textarea", required: true },
    ],
    confirmLabel: "Iniciar",
  });
  if (!values) return;

  try {
    const result = await createTask({
      titulo: values.titulo.trim(),
      descricao: values.descricao.trim(),
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
    toastError(err instanceof Error ? err.message : String(err));
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

// Fetches once (via the shared 60s cache) and paints the sidebar widget,
// then keeps it accurate two different ways: a cheap local tick that just
// re-renders the same already-fetched list (elapsed-time text only
// changes, no new data needed) and a much rarer poll that actually
// re-fetches from the server. Torn down at the top of the next
// renderNav() call, same as greetingInterval.
async function loadPresenceSidebar(root: HTMLElement): Promise<void> {
  const render = (profiles: TeamPresenceRow[]) => renderPresenceWidget(root, profiles);

  try {
    render(await getCachedTeamPresence());
  } catch (err) {
    console.error("[SGO] failed to load team presence:", err);
    return; // presence is non-critical — leave the widget hidden rather than show broken data
  }

  presenceTickInterval = setInterval(async () => {
    try {
      render(await getCachedTeamPresence());
    } catch {
      // transient — the next tick tries again, nothing user-visible to do here
    }
  }, 30_000);

  presencePollInterval = setInterval(async () => {
    try {
      render(await getCachedTeamPresence(true));
    } catch {
      // same as above — the widget just keeps showing the last good data
    }
  }, 120_000);
}

function renderPresenceWidget(root: HTMLElement, profiles: TeamPresenceRow[]): void {
  const widget = root.querySelector<HTMLElement>("#sidebar-presence");
  const listEl = root.querySelector<HTMLUListElement>("#sidebar-presence-list");
  const countEl = root.querySelector<HTMLElement>("#sidebar-presence-count");
  const alertBtn = root.querySelector<HTMLButtonElement>("#sidebar-presence-alert");
  const navBadge = root.querySelector<HTMLElement>("#presence-nav-badge");
  if (!widget || !listEl || !countEl || !alertBtn || !navBadge) return;

  const active = profiles.filter((p) => computePresenceStatus(p.last_activity_at) === "ativo");
  const inactive2h = profiles.filter((p) => computePresenceStatus(p.last_activity_at) === "inativo");

  widget.hidden = false;
  countEl.textContent = String(active.length);

  listEl.innerHTML = active
    .map((p) => `<li class="sidebar-presence-item"><span class="presence-dot presence-dot-ativo"></span>${escapeHtml(p.full_name)}</li>`)
    .join("");

  alertBtn.hidden = inactive2h.length === 0;
  if (inactive2h.length > 0) {
    alertBtn.textContent = `⚠ ${inactive2h.length} inativo${inactive2h.length > 1 ? "s" : ""} +2h`;
    alertBtn.onclick = () => {
      location.hash = "#/presence?filter=inativos";
    };
  }

  navBadge.hidden = inactive2h.length === 0;
  if (inactive2h.length > 0) navBadge.textContent = String(inactive2h.length);
}

function updateBadge(root: HTMLElement, notifications: AppNotification[]): void {
  const badge = root.querySelector<HTMLElement>("#notif-badge")!;
  const unread = notifications.filter((n) => !n.read).length;
  badge.hidden = unread === 0;
  badge.classList.toggle("topbar-badge-pulse", unread > 0);
  if (unread > 0) badge.textContent = unread > 9 ? "9+" : String(unread);
}

function setupSearch(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>("#topbar-search-input")!;
  const resultsEl = root.querySelector<HTMLElement>("#topbar-search-results")!;
  const hintEl = root.querySelector<HTMLElement>("#topbar-search-hint");
  let debounceHandle: ReturnType<typeof setTimeout> | null = null;

  const updateHint = () => {
    if (hintEl) hintEl.hidden = document.activeElement === input || input.value.length > 0;
  };
  input.addEventListener("focus", updateHint);
  input.addEventListener("blur", updateHint);

  input.addEventListener("input", () => {
    updateHint();
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
  input.addEventListener("click", (event) => {
    event.stopPropagation();
    updateHint();
  });
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

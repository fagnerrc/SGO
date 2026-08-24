// Status/priority/risk → color mapping, ported from the old system's
// statusBadge()/priorityBadge()/riskBadge() (Index.html) so every screen
// that shows a task uses the same visual language instead of plain text.

const STATUS_COLOR: Record<string, string> = {
  "Em andamento": "yellow",
  "Aguardando terceiro": "orange",
  "Aguardando aprovação": "orange",
  "Reprovada/devolvida": "red",
  Concluída: "green",
  Auditada: "purple",
  Cancelada: "gray",
};

const PRIORITY_COLOR: Record<string, string> = {
  Baixa: "green",
  Normal: "blue",
  Alta: "orange",
  Urgente: "red",
};

const RISK_COLOR: Record<string, string> = {
  Baixo: "green",
  Médio: "yellow",
  Alto: "orange",
  Crítico: "red",
};

// Hex equivalents of the same palette, for Chart.js canvases (CSS badge
// classes don't help there) — shared by dashboard.ts, reports.ts,
// taskList.ts and myWork.ts so every "tasks by status/priority" chart in
// the app uses identical colors.
export const STATUS_CHART_COLORS: Record<string, string> = {
  "Em andamento": "#e0954b",
  "Aguardando terceiro": "#d6527d",
  "Aguardando aprovação": "#d6527d",
  "Reprovada/devolvida": "#c0522e",
  Concluída: "#2fa968",
  Auditada: "#7c6fd9",
  Cancelada: "#8892a6",
};

export const PRIORITY_CHART_COLORS: Record<string, string> = {
  Baixa: "#2fa968",
  Normal: "#2f6fa0",
  Alta: "#e0954b",
  Urgente: "#c0522e",
};

function badge(label: string, color: string): string {
  return `<span class="badge badge-${color}">${escapeHtml(label)}</span>`;
}

export function statusBadge(status: string): string {
  return badge(status, STATUS_COLOR[status] ?? "gray");
}

export function priorityBadge(priority: string): string {
  return badge(priority, PRIORITY_COLOR[priority] ?? "gray");
}

export function riskBadge(risk: string): string {
  return badge(risk, RISK_COLOR[risk] ?? "gray");
}

const LEVEL_COLOR: Record<string, string> = {
  info: "blue",
  warn: "orange",
  error: "red",
};

const LEVEL_LABEL: Record<string, string> = {
  info: "Info",
  warn: "Alerta",
  error: "Erro",
};

export function levelBadge(level: string): string {
  return badge(LEVEL_LABEL[level] ?? level, LEVEL_COLOR[level] ?? "gray");
}

// Marks a task that was born automatically from a Rotina Periódica, so it
// stays identifiable wherever tasks are listed (section 21 of the spec).
export function routineBadge(tipo: string): string {
  return tipo === "Rotina periódica" ? `<span class="badge badge-purple routine-badge">↻ Rotina</span>` : "";
}

const ROUTINE_STATUS_COLOR: Record<string, string> = {
  ACTIVE: "green",
  PAUSED: "yellow",
  CANCELLED: "gray",
};

const ROUTINE_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Ativa",
  PAUSED: "Pausada",
  CANCELLED: "Cancelada",
};

export function routineStatusBadge(status: string): string {
  return badge(ROUTINE_STATUS_LABEL[status] ?? status, ROUTINE_STATUS_COLOR[status] ?? "gray");
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

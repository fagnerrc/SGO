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

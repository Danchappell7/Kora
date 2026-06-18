/* ============================================================
   KANBO — reusable task templates (stored locally per browser).
   A template captures the reusable shape of a task — name, priority,
   tags, focus estimate, recurrence, description — not project/assignee.
   ============================================================ */
import type { Priority, Recurrence } from "../data/types";

export interface TaskTemplate {
  id: string;
  name: string;
  title: string;
  priority: Priority;
  tags: string[];
  focusMin: number;
  recurrence: Recurrence;
  description: string;
}

const KEY = "kanbo-templates";

// curated starting points shown in the template gallery (always available)
export const BUILTIN_TASK_TEMPLATES: TaskTemplate[] = [
  { id: "builtin-bug", name: "Bug report", title: "Bug: ", priority: "high", tags: [], focusMin: 30, recurrence: "none", description: "**Steps to reproduce**\n- \n\n**Expected**\n\n**Actual**" },
  { id: "builtin-meeting", name: "Meeting notes", title: "Meeting: ", priority: "medium", tags: [], focusMin: 30, recurrence: "none", description: "**Attendees**\n\n**Notes**\n\n**Action items**\n- " },
  { id: "builtin-brief", name: "Content brief", title: "Brief: ", priority: "medium", tags: [], focusMin: 60, recurrence: "none", description: "**Goal**\n\n**Audience**\n\n**Key points**\n- \n\n**Deadline**" },
  { id: "builtin-weekly", name: "Weekly review", title: "Weekly review", priority: "medium", tags: [], focusMin: 30, recurrence: "weekly", description: "**Wins**\n\n**Blockers**\n\n**Next week**" },
];

export function getTemplates(): TaskTemplate[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return [...BUILTIN_TASK_TEMPLATES, ...(Array.isArray(v) ? v : [])]; } catch { return [...BUILTIN_TASK_TEMPLATES]; }
}
export function saveTemplate(t: Omit<TaskTemplate, "id">): TaskTemplate {
  const tpl: TaskTemplate = { ...t, id: "tpl-" + Date.now() + "-" + Math.round(Math.random() * 1e5) };
  try { localStorage.setItem(KEY, JSON.stringify([tpl, ...getTemplates()].slice(0, 24))); } catch { /* ignore */ }
  return tpl;
}
export function deleteTemplate(id: string): void {
  try { localStorage.setItem(KEY, JSON.stringify(getTemplates().filter((x) => x.id !== id))); } catch { /* ignore */ }
}

/* ---------- project templates ---------- */
export interface ProjectTemplate { id: string; name: string; emoji: string; color: string; }
const PKEY = "kanbo-project-templates";

export const BUILTIN_PROJECT_TEMPLATES: ProjectTemplate[] = [
  { id: "builtin-launch", name: "Product launch", emoji: "🚀", color: "#8B5CF6" },
  { id: "builtin-marketing", name: "Marketing campaign", emoji: "📣", color: "#C24BE0" },
  { id: "builtin-sprint", name: "Sprint", emoji: "🏃", color: "#5B7CFA" },
  { id: "builtin-content", name: "Content calendar", emoji: "🗓️", color: "#37c6a8" },
  { id: "builtin-bugs", name: "Bug tracker", emoji: "🐞", color: "#e5544b" },
];

export function getProjectTemplates(): ProjectTemplate[] {
  try { const v = JSON.parse(localStorage.getItem(PKEY) || "[]"); return [...BUILTIN_PROJECT_TEMPLATES, ...(Array.isArray(v) ? v : [])]; } catch { return [...BUILTIN_PROJECT_TEMPLATES]; }
}
export function saveProjectTemplate(t: Omit<ProjectTemplate, "id">): ProjectTemplate {
  const tpl: ProjectTemplate = { ...t, id: "ptpl-" + Date.now() + "-" + Math.round(Math.random() * 1e5) };
  try { localStorage.setItem(PKEY, JSON.stringify([tpl, ...getProjectTemplates()].slice(0, 24))); } catch { /* ignore */ }
  return tpl;
}

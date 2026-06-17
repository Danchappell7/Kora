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

export function getTemplates(): TaskTemplate[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
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

export function getProjectTemplates(): ProjectTemplate[] {
  try { const v = JSON.parse(localStorage.getItem(PKEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveProjectTemplate(t: Omit<ProjectTemplate, "id">): ProjectTemplate {
  const tpl: ProjectTemplate = { ...t, id: "ptpl-" + Date.now() + "-" + Math.round(Math.random() * 1e5) };
  try { localStorage.setItem(PKEY, JSON.stringify([tpl, ...getProjectTemplates()].slice(0, 24))); } catch { /* ignore */ }
  return tpl;
}

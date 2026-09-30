/* Shared task export — CSV download + printable PDF (used by List/Board
   toolbar and the Search view). The CSV opens cleanly in Excel (UTF-8 BOM,
   every cell quoted, formula injection neutralised) and re-imports into
   Kanbo with status, people, dates, sections, tags and sub-tasks intact. */
import type { CustomFieldDef, CustomValue, Task } from "../data/types";
import { getMember, getProject, PRIORITY_META, STATUS_META, TAGS, toLocalISO } from "../data/data";

// A cell starting with one of these is run as a formula by Excel, Sheets and
// Numbers (=HYPERLINK(…), DDE payloads) — or shows #NAME? for "-Call supplier".
const FORMULA_START = /^[=+\-@\t\r]/;
// …but a plain signed number ("-5", "+2.5") is data, not a formula.
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/** One CSV cell: always quoted, with a leading ' when the value would run as a formula. */
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Rows → CSV text with a UTF-8 byte-order mark so Excel reads £ and accents correctly. */
export function toCsv(rows: unknown[][]): string {
  return "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Downloads CSV text built by toCsv(). */
export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  // revoking straight away can cancel the download in Safari/Firefox
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export interface TaskExportOptions {
  /** Section names (by id) for the Section column. */
  sections?: { id: string; name: string }[];
  /** Custom field definitions — one extra column per field name. */
  customFields?: CustomFieldDef[];
  /** All tasks, so a sub-task's parent is named even when the parent isn't in the export. */
  allTasks?: Task[];
  /** People to resolve assignees against (defaults to the loaded workspace members). */
  members?: { id: string; name: string; email?: string }[];
}

const BASE_COLUMNS = ["Title", "Description", "Status", "Priority", "Assignee", "Assignee email", "Start", "Due", "Completed", "Project", "Section", "Tags", "Parent task"];

const dateCell = (v?: string) => {
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? "" : toLocalISO(d);
};

/** Builds the CSV text for a task export (exposed for tests). */
export function buildTasksCsv(tasks: Task[], opts: TaskExportOptions = {}): string {
  const person = (id?: string) => {
    if (!id) return undefined;
    const m = opts.members?.find((x) => x.id === id);
    const g = getMember(id);
    return m || g ? { name: m?.name || g?.name || "", email: m?.email || g?.email || "" } : undefined;
  };
  const sectionName = new Map((opts.sections ?? []).map((s) => [s.id, s.name]));
  const titleOf = new Map<string, string>();
  (opts.allTasks ?? []).forEach((t) => titleOf.set(t.id, t.title));
  tasks.forEach((t) => titleOf.set(t.id, t.title));

  // custom fields used by the exported tasks' projects, one column per distinct name
  const projectIds = new Set(tasks.map((t) => t.projectId));
  const fieldCols: { name: string; defs: CustomFieldDef[] }[] = [];
  (opts.customFields ?? []).filter((f) => projectIds.has(f.projectId)).forEach((f) => {
    const clash = BASE_COLUMNS.some((c) => c.toLowerCase() === f.name.trim().toLowerCase());
    const name = clash ? `${f.name} (custom field)` : f.name;
    const col = fieldCols.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (col) col.defs.push(f); else fieldCols.push({ name, defs: [f] });
  });
  const customCell = (def: CustomFieldDef, v: CustomValue | undefined): string => {
    if (v == null || v === "") return "";
    if (def.type === "people") return (Array.isArray(v) ? v : [String(v)]).map((id) => person(id)?.name || id).join("; ");
    if (Array.isArray(v)) return v.join("; ");
    if (typeof v === "boolean") return v ? "Yes" : "No";
    return String(v);
  };

  const rows: unknown[][] = [[...BASE_COLUMNS, ...fieldCols.map((c) => c.name)]];
  tasks.forEach((t) => {
    const who = person(t.assigneeId);
    rows.push([
      t.title,
      t.description || "",
      STATUS_META[t.status]?.label ?? t.status,
      PRIORITY_META[t.priority]?.label ?? t.priority,
      who?.name || "",
      who?.email || "",
      dateCell(t.startDate),
      dateCell(t.dueDate),
      t.status === "done" ? dateCell(t.completedAt) : "",
      getProject(t.projectId)?.name || "",
      (t.sectionId && sectionName.get(t.sectionId)) || "",
      (t.tags || []).map((k) => TAGS[k]?.label ?? k).join("; "),
      (t.parentId && titleOf.get(t.parentId)) || "",
      ...fieldCols.map((c) => {
        const def = c.defs.find((d) => d.projectId === t.projectId);
        return def ? customCell(def, t.custom?.[def.id]) : "";
      }),
    ]);
  });
  return toCsv(rows);
}

const fileSlug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "tasks";

export function exportTasksCsv(tasks: Task[], name = "tasks", opts: TaskExportOptions = {}) {
  downloadCsv(`kanbo-${fileSlug(name)}-${toLocalISO(new Date())}.csv`, buildTasksCsv(tasks, opts));
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));

export function printTasks(tasks: Task[], title = "Tasks") {
  const w = window.open("", "_blank"); if (!w) return;
  const rows = tasks.map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(STATUS_META[t.status]?.label ?? t.status)}</td><td>${esc(t.priority)}</td><td>${esc(t.dueDate || "")}</td><td>${esc(getProject(t.projectId)?.name || "")}</td><td>${esc(getMember(t.assigneeId)?.name || "")}</td></tr>`).join("");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;padding:32px;max-width:920px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin:0 0 20px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #eee}th{color:#888;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}@media print{.noprint{display:none}}</style></head><body><h1>${esc(title)}</h1><p class="sub">${tasks.length} task${tasks.length === 1 ? "" : "s"} · ${esc(new Date().toLocaleDateString())}</p><table><thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Due</th><th>Project</th><th>Assignee</th></tr></thead><tbody>${rows}</tbody></table><p class="noprint" style="margin-top:24px;color:#888;font-size:12px">Use your browser's Print dialog to save as PDF.</p></body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
}

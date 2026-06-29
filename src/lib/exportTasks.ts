/* Shared task export — CSV download + printable PDF (used by List/Board
   toolbar and the Search view). */
import type { Task } from "../data/types";
import { getMember, getProject, STATUS_META, toLocalISO } from "../data/data";

const csvCell = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));

export function exportTasksCsv(tasks: Task[], name = "tasks") {
  const rows = [["Title", "Status", "Priority", "Assignee", "Due", "Project", "Tags"]];
  tasks.forEach((t) => rows.push([t.title, STATUS_META[t.status]?.label ?? t.status, t.priority, getMember(t.assigneeId)?.name || "", t.dueDate || "", getProject(t.projectId)?.name || "", (t.tags || []).join("; ")]));
  const csv = rows.map((r) => r.map((c) => csvCell(String(c))).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = `kanbo-${name}-${toLocalISO(new Date())}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

export function printTasks(tasks: Task[], title = "Tasks") {
  const w = window.open("", "_blank"); if (!w) return;
  const rows = tasks.map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(STATUS_META[t.status]?.label ?? t.status)}</td><td>${esc(t.priority)}</td><td>${esc(t.dueDate || "")}</td><td>${esc(getProject(t.projectId)?.name || "")}</td><td>${esc(getMember(t.assigneeId)?.name || "")}</td></tr>`).join("");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;padding:32px;max-width:920px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin:0 0 20px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #eee}th{color:#888;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}@media print{.noprint{display:none}}</style></head><body><h1>${esc(title)}</h1><p class="sub">${tasks.length} task${tasks.length === 1 ? "" : "s"} · ${esc(new Date().toLocaleDateString())}</p><table><thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Due</th><th>Project</th><th>Assignee</th></tr></thead><tbody>${rows}</tbody></table><p class="noprint" style="margin-top:24px;color:#888;font-size:12px">Use your browser's Print dialog to save as PDF.</p></body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
}

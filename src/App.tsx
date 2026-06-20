/* ============================================================
   KANBO — App shell: auth gate, store-backed state, routing,
   timer, tasks page
   ============================================================ */
import { useState, useEffect, useCallback, useRef } from "react";
import { Icon, Avatar, StatusDot, Segmented, GlobalTipStyles, type SegmentedOption } from "./components/primitives";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { CommandPalette } from "./components/CommandPalette";
import { NewTaskModal } from "./components/NewTaskModal";
import { NewProjectModal } from "./components/NewProjectModal";
import { NewWorkspaceModal } from "./components/NewWorkspaceModal";
import { DeleteProjectModal, type DeleteMode } from "./components/DeleteProjectModal";
import { SettingsModal } from "./components/SettingsModal";
import { MobileNav } from "./components/MobileNav";
import { WelcomeModal } from "./components/WelcomeModal";
import { TrialBanner, UpgradeModal, Paywall, hasAccess, BILLING_ENABLED } from "./components/Billing";
import { ListView } from "./components/tasks/ListView";
import { BoardView, TimelineView, CalendarView, FilesView, MatrixView } from "./components/tasks/OtherViews";
import { PlanView } from "./components/views/PlanView";
import { MyWeekView } from "./components/views/MyWeekView";
import { HomeView } from "./components/views/HomeView";
import { AnalyticsView } from "./components/views/AnalyticsView";
import { SearchView } from "./components/views/SearchView";
import { WorkloadView, GoalsView, PortfoliosView, AutomationsView, FormsView, type FormValues, STATUS_KIND_META } from "./components/views/ManagerViews";
import { InboxView, TeamView } from "./components/views/InboxTeam";
import { FocusMode } from "./components/views/FocusMode";
import { TaskDetail } from "./components/TaskDetail";
import { PublicSite, UpdatePasswordScreen, PendingApproval } from "./auth/LoginScreen";
import { useAuth } from "./auth/AuthProvider";
import { useToast } from "./components/Toast";
import { reportError } from "./lib/monitoring";
import { useFocusTimer } from "./hooks/useFocusTimer";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { store, type NewProject } from "./data/store";
import {
  STATUS_META, getProject, projectProgress, getMember, setReferenceData, toLocalISO, nextDueDate, MEMBERS, dueState, KANBO_TODAY,
} from "./data/data";
import type { ProfileDraft } from "./components/SettingsModal";
import type { Task, Project, Workspace, WorkspaceMember, Role, TagDef, Comment, Activity, ActivityKind, Subscription, Plan, Status, Profile, CalProvider, CalendarConnection, ExternalEvent, Section, CustomFieldDef, SavedSearch, Goal, GoalStatus, Portfolio, StatusUpdate, StatusKind, AutomationRule, AutomationAction, AutomationActionType, FormDef, FormFieldKey } from "./data/types";
import type { Route, TaskView, GroupBy } from "./app-types";

/* ---- tasks page with view switcher ---- */
const VIEW_OPTS: SegmentedOption<TaskView>[] = [
  { value: "list", label: "List", icon: "list" },
  { value: "board", label: "Board", icon: "board" },
  { value: "timeline", label: "Timeline", icon: "timeline" },
  { value: "calendar", label: "Calendar", icon: "calendar" },
  { value: "files", label: "Files", icon: "folder" },
  { value: "matrix", label: "Matrix", icon: "grid" },
];

const GROUP_OPTS: SegmentedOption<GroupBy>[] = [
  { value: "status", label: "Status" },
  { value: "section", label: "Section" },
  { value: "due", label: "Due" },
  { value: "priority", label: "Priority" },
  { value: "project", label: "Project" },
  { value: "none", label: "None" },
];

const PRIORITY_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All priorities" },
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

function FilterSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div className="kicker" style={{ padding: "6px 8px 4px" }}>{label}</div>
      {children}
    </div>
  );
}
function FilterOption({ label, active, onClick, dot }: { label: string; active: boolean; onClick: () => void; dot?: string }) {
  return (
    <button onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, fontFamily: "var(--font-display)", color: active ? "var(--ink)" : "var(--ink-3)", background: active ? "var(--surface-2)" : "transparent" }}>
      <span style={{ width: 13, display: "grid", placeItems: "center", flexShrink: 0 }}>{active && <Icon name="check" size={13} style={{ color: "var(--accent)" }} />}</span>
      {dot && <span style={{ width: 8, height: 8, borderRadius: 3, background: dot, flexShrink: 0 }} />}
      <span className="truncate">{label}</span>
    </button>
  );
}

const PROJECT_STATUSES: { v: string; label: string; color: string }[] = [
  { v: "on_track", label: "On track", color: "var(--st-done)" },
  { v: "at_risk", label: "At risk", color: "var(--st-review)" },
  { v: "off_track", label: "Off track", color: "var(--st-blocked)" },
  { v: "on_hold", label: "On hold", color: "var(--ink-4)" },
];

function ProjectOverview({ project, tasks, onUpdate, statusUpdates = [], onPostStatus }: { project: Project; tasks: Task[]; onUpdate: (id: string, patch: { description?: string; status?: string }) => void; statusUpdates?: StatusUpdate[]; onPostStatus?: (projectId: string, summary: string, status: StatusKind) => void }) {
  const [statusOpen, setStatusOpen] = useState(false);
  const [descEditing, setDescEditing] = useState(false);
  const [descDraft, setDescDraft] = useState(project.description || "");
  const [updOpen, setUpdOpen] = useState(false);
  const [updText, setUpdText] = useState("");
  const [updKind, setUpdKind] = useState<StatusKind>("on_track");
  const latest = statusUpdates.find((s) => s.projectId === project.id);
  const postUpd = () => { const v = updText.trim(); if (v && onPostStatus) { onPostStatus(project.id, v, updKind); setUpdText(""); setUpdOpen(false); } };
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const prog = total ? Math.round((done / total) * 100) : 0;
  const contributors = [...new Set(tasks.map((t) => t.assigneeId))].slice(0, 6);
  const todayMid = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate()).getTime();
  const dueSoon = tasks.filter((t) => t.status !== "done" && t.dueDate && (() => { const d = new Date(t.dueDate + "T00:00:00").getTime(); return d <= todayMid + 7 * 86400000; })()).length;
  // auto-computed RAG health — complements the manually-set project phase
  const overdue = tasks.filter((t) => t.status !== "done" && t.dueDate && new Date(t.dueDate + "T00:00:00").getTime() < todayMid).length;
  const blockedCount = tasks.filter((t) => t.status === "blocked").length;
  const health = (() => {
    if (total === 0) return null;
    const bits: string[] = [];
    if (overdue) bits.push(`${overdue} overdue`);
    if (blockedCount) bits.push(`${blockedCount} blocked`);
    const detail = bits.length ? bits.join(" · ") : "nothing overdue or blocked";
    if (prog === 100) return { label: "Complete", color: "var(--st-done)", detail: "all tasks done" };
    if (overdue >= 3 || overdue / total > 0.25 || (overdue >= 1 && blockedCount >= 2)) return { label: "Off track", color: "var(--prio-urgent)", detail };
    if (overdue >= 1 || blockedCount >= 1) return { label: "At risk", color: "var(--st-review)", detail };
    return { label: "On track", color: "var(--st-done)", detail };
  })();
  const byStatus = (["todo", "progress", "review", "blocked", "done"] as Status[]).map((s) => ({ s, n: tasks.filter((t) => t.status === s).length })).filter((x) => x.n > 0);
  const printReport = () => {
    const w = window.open("", "_blank"); if (!w) return;
    const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
    const rows = [...tasks].sort((a, b) => a.status.localeCompare(b.status)).map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(STATUS_META[t.status].label)}</td><td>${esc(t.priority)}</td><td>${esc(t.dueDate || "")}</td><td>${esc(getMember(t.assigneeId)?.name || "")}</td></tr>`).join("");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(project.name)} — report</title><style>body{font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;padding:32px;max-width:900px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin:0 0 20px}.bar{height:10px;background:#eee;border-radius:6px;overflow:hidden;margin:8px 0 20px}.bar>div{height:100%;background:#6a5cff;width:${prog}%}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #eee}th{color:#888;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}@media print{.noprint{display:none}}</style></head><body><h1>${esc(project.emoji)} ${esc(project.name)}</h1><p class="sub">${total} tasks · ${prog}% complete · ${esc(new Date().toLocaleDateString())}</p><div class="bar"><div></div></div><table><thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Due</th><th>Assignee</th></tr></thead><tbody>${rows}</tbody></table><p class="noprint" style="margin-top:24px;color:#888;font-size:12px">Use your browser's Print dialog to save as PDF.</p></body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  };
  const curStatus = PROJECT_STATUSES.find((s) => s.v === project.status);
  return (
    <div className="glass" style={{ margin: "14px 24px 0", padding: "16px 18px", borderRadius: 16, display: "flex", flexDirection: "column", gap: 12 }}>
     <div style={{ display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 180 }}>
        <span style={{ width: 40, height: 40, borderRadius: 11, display: "grid", placeItems: "center", fontSize: 20, background: `color-mix(in oklch, ${project.color} 18%, transparent)`, border: `1px solid color-mix(in oklch, ${project.color} 32%, transparent)` }}>{project.emoji}</span>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{project.name}</span>
            <div style={{ position: "relative" }}>
              <button onClick={() => setStatusOpen((v) => !v)} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 99, border: "1px solid var(--hairline)", background: curStatus ? `color-mix(in oklch, ${curStatus.color} 14%, transparent)` : "var(--surface)", cursor: "pointer", fontSize: 11.5, fontFamily: "var(--font-display)", color: curStatus ? curStatus.color : "var(--ink-4)" }}>
                {curStatus ? <><span style={{ width: 7, height: 7, borderRadius: 99, background: curStatus.color }} />{curStatus.label}</> : "Set status"}
              </button>
              {statusOpen && (
                <>
                  <div onClick={() => setStatusOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
                  <div className="anim-scalein" style={{ position: "absolute", top: "calc(100% + 5px)", left: 0, zIndex: 21, width: 150, padding: 5, borderRadius: 11, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)" }}>
                    {PROJECT_STATUSES.map((s) => (
                      <button key={s.v} onClick={() => { onUpdate(project.id, { status: project.status === s.v ? "" : s.v }); setStatusOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none", background: project.status === s.v ? "var(--surface-2)" : "transparent", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13, textAlign: "left", color: "var(--ink-2)" }}>
                        <span style={{ width: 8, height: 8, borderRadius: 99, background: s.color }} /> {s.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {health && (
              <span title={`Auto health: ${health.detail}`} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 99, fontSize: 11.5, fontFamily: "var(--font-display)", color: health.color, background: `color-mix(in oklch, ${health.color} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${health.color} 30%, transparent)` }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: health.color }} />{health.label}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-4)" }}>{total} task{total === 1 ? "" : "s"}{dueSoon > 0 ? ` · ${dueSoon} due soon` : ""}</div>
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 160 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 5 }}><span className="kicker">Progress</span><span className="mono tnum" style={{ color: prog > 0 ? "var(--accent)" : "var(--ink-4)" }}>{prog}%</span></div>
        <div style={{ height: 7, borderRadius: 99, background: "var(--surface-2)", overflow: "hidden" }}><div style={{ width: prog + "%", height: "100%", borderRadius: 99, background: project.color, transition: "width .9s var(--ease)" }} /></div>
        <div style={{ display: "flex", gap: 12, marginTop: 9, flexWrap: "wrap" }}>
          {byStatus.map(({ s, n }) => (
            <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--ink-3)" }}><StatusDot status={s} size={7} />{STATUS_META[s].label} <span className="mono" style={{ color: "var(--ink-4)" }}>{n}</span></span>
          ))}
        </div>
      </div>
      {contributors.length > 0 && (
        <div>
          <div className="kicker" style={{ marginBottom: 6 }}>Contributors</div>
          <div style={{ display: "flex" }}>{contributors.map((id, i) => <span key={id} style={{ marginLeft: i ? -8 : 0, borderRadius: 99, boxShadow: "0 0 0 2px var(--surface-raised)" }}><Avatar id={id} size={28} /></span>)}</div>
        </div>
      )}
      <button onClick={printReport} className="btn btn-ghost" title="Print / export a PDF report" style={{ alignSelf: "flex-start", padding: "6px 11px", fontSize: 12.5 }}><Icon name="arrowUpRight" size={14} /> Report</button>
     </div>
     {descEditing ? (
       // eslint-disable-next-line jsx-a11y/no-autofocus
       <textarea autoFocus value={descDraft} onChange={(e) => setDescDraft(e.target.value)} onBlur={() => { setDescEditing(false); if (descDraft !== (project.description || "")) onUpdate(project.id, { description: descDraft }); }}
         placeholder="Add a project description…" rows={2}
         style={{ width: "100%", resize: "vertical", padding: "8px 11px", borderRadius: 10, border: "1px solid var(--accent)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, lineHeight: 1.55, outline: "none" }} />
     ) : (
       <div onClick={() => { setDescDraft(project.description || ""); setDescEditing(true); }} style={{ fontSize: 13, lineHeight: 1.55, color: project.description ? "var(--ink-3)" : "var(--ink-4)", cursor: "text", padding: "2px 0" }}>
         {project.description || "Add a project description…"}
       </div>
     )}
     {onPostStatus && (
       <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
         <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
           <span className="kicker">Status update</span>
           {latest && <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: STATUS_KIND_META[latest.status].color }}><span style={{ width: 7, height: 7, borderRadius: 99, background: STATUS_KIND_META[latest.status].color }} />{STATUS_KIND_META[latest.status].label}</span>}
           <button onClick={() => setUpdOpen((v) => !v)} className="btn btn-ghost" style={{ marginLeft: "auto", padding: "4px 10px", fontSize: 12 }}>{updOpen ? "Cancel" : "Post update"}</button>
         </div>
         {latest && !updOpen && <div style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>{latest.summary}</div>}
         {updOpen && (
           <>
             <div style={{ display: "flex", gap: 6 }}>
               {(Object.keys(STATUS_KIND_META) as StatusKind[]).map((k) => (
                 <button key={k} onClick={() => setUpdKind(k)} style={{ padding: "4px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12, border: `1px solid ${updKind === k ? STATUS_KIND_META[k].color : "var(--hairline)"}`, background: updKind === k ? `color-mix(in oklch, ${STATUS_KIND_META[k].color} 14%, transparent)` : "transparent", color: updKind === k ? STATUS_KIND_META[k].color : "var(--ink-3)", fontFamily: "var(--font-display)" }}>{STATUS_KIND_META[k].label}</button>
               ))}
             </div>
             {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
             <textarea autoFocus value={updText} onChange={(e) => setUpdText(e.target.value)} placeholder="What's the latest? Wins, risks, next steps…" rows={2}
               style={{ width: "100%", resize: "vertical", padding: "8px 11px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, lineHeight: 1.55, outline: "none" }} />
             <button onClick={postUpd} className="btn btn-accent" style={{ alignSelf: "flex-start", padding: "6px 13px", fontSize: 13 }}>Post update</button>
           </>
         )}
       </div>
     )}
    </div>
  );
}

function TasksPage({ tasks, allTasks, projects = [], view, setView, groupBy, setGroupBy, smart, setSmart, onOpen, onToggle, onToggleSubtask, onAdd, onMove, onBulkPatch, onBulkDelete, onPatch, onQuickAdd, members, allTags, archivedTasks = [], header, sections = [], onCreateSection, onRenameSection, onDeleteSection, customFields = [], sectionField = "sectionId", sectionProjectId }: {
  tasks: Task[];
  allTasks: Task[];
  projects?: Project[];
  view: TaskView;
  setView: (v: TaskView) => void;
  groupBy: GroupBy;
  setGroupBy: (g: GroupBy) => void;
  smart: boolean;
  setSmart: React.Dispatch<React.SetStateAction<boolean>>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onToggleSubtask: (taskId: string, subId: string) => void;
  onAdd: (status: Status) => void;
  onMove: (taskId: string, status: Status, position?: number) => void;
  onBulkPatch: (ids: string[], patch: Partial<Task>) => void;
  onBulkDelete: (ids: string[]) => void;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onQuickAdd: (partial: Partial<Task> & { title: string }) => void;
  members: { id: string; name: string }[];
  allTags: Record<string, TagDef>;
  archivedTasks?: Task[];
  header?: React.ReactNode;
  sections?: Section[];
  onCreateSection?: (projectId: string, name: string) => void;
  onRenameSection?: (id: string, name: string) => void;
  onDeleteSection?: (id: string) => void;
  customFields?: CustomFieldDef[];
  sectionField?: "sectionId" | "mySectionId";
  sectionProjectId?: string;
}) {
  const { success: toastImport } = useToast();
  const [filterOpen, setFilterOpen] = useState(false);
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem("kanbo-density") === "compact"; } catch { return false; } });
  const toggleCompact = () => setCompact((c) => { const n = !c; try { localStorage.setItem("kanbo-density", n ? "compact" : "comfortable"); } catch { /* private mode */ } return n; });
  const [sortOpen, setSortOpen] = useState(false);
  const [sort, setSort] = useState<string>(() => { try { return localStorage.getItem("kanbo-sort") || "manual"; } catch { return "manual"; } });
  useEffect(() => { try { localStorage.setItem("kanbo-sort", sort); } catch { /* ignore */ } }, [sort]);
  const [search, setSearch] = useState("");
  // filters persist across sessions (key shared app-wide)
  const [filters, setFilters] = useState<{ priority: string; assignee: string; tag: string; due: string; hideDone: boolean; showArchived: boolean; custom: Record<string, string> }>(() => {
    try { const s = localStorage.getItem("kanbo-filters"); if (s) return { priority: "all", assignee: "all", tag: "all", due: "all", hideDone: false, custom: {}, ...JSON.parse(s), showArchived: false }; } catch { /* ignore */ }
    return { priority: "all", assignee: "all", tag: "all", due: "all", hideDone: false, showArchived: false, custom: {} };
  });
  useEffect(() => { try { localStorage.setItem("kanbo-filters", JSON.stringify(filters)); } catch { /* ignore */ } }, [filters]);
  const setFilter = (patch: Partial<typeof filters>) => setFilters((f) => ({ ...f, ...patch }));
  const isMobile = useMediaQuery("(max-width: 860px)");
  const { priority: priorityFilter, assignee: assigneeFilter, tag: tagFilter, due: dueFilter, hideDone, showArchived, custom: customFilter } = filters;
  const cfActive = Object.values(customFilter ?? {}).some((v) => v && v !== "all");
  const filterActive = priorityFilter !== "all" || assigneeFilter !== "all" || tagFilter !== "all" || dueFilter !== "all" || hideDone || cfActive;
  const dueOk = (t: Task) => {
    if (dueFilter === "all") return true;
    const ds = dueState(t.dueDate, t.status);
    if (dueFilter === "overdue") return ds === "overdue";
    if (dueFilter === "today") return ds === "today";
    if (dueFilter === "week") {
      if (!t.dueDate) return false;
      const days = Math.round((new Date(t.dueDate + "T00:00:00").getTime() - new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate()).getTime()) / 86400000);
      return days >= 0 && days <= 7;
    }
    return true;
  };
  const q = search.trim().toLowerCase();
  const filtered = (showArchived ? archivedTasks : tasks).filter((t) =>
    (priorityFilter === "all" || t.priority === priorityFilter) &&
    (!hideDone || t.status !== "done") &&
    (assigneeFilter === "all" || t.assigneeId === assigneeFilter) &&
    (tagFilter === "all" || (t.tags || []).includes(tagFilter)) &&
    dueOk(t) &&
    Object.entries(customFilter ?? {}).every(([fid, v]) => { if (!v || v === "all") return true; const cv = (t.custom ?? {})[fid]; return Array.isArray(cv) ? cv.includes(v) : String(cv ?? "") === v; }) &&
    (q === "" || t.title.toLowerCase().includes(q)));

  const csvInputRef = useRef<HTMLInputElement>(null);
  const csvCell = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const exportCsv = () => {
    const rows = [["Title", "Status", "Priority", "Assignee", "Due", "Project", "Tags"]];
    filtered.forEach((t) => rows.push([t.title, t.status, t.priority, getMember(t.assigneeId)?.name || "", t.dueDate || "", getProject(t.projectId)?.name || "", (t.tags || []).join("; ")]));
    const csv = rows.map((r) => r.map((c) => csvCell(String(c))).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = `kanbo-tasks-${toLocalISO(new Date())}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
  const importCsv = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      // minimal CSV parse: split rows on newlines, fields on commas (honour quotes)
      const parseLine = (line: string): string[] => {
        const out: string[] = []; let cur = "", inQ = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (inQ) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch; }
          else if (ch === '"') inQ = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
        }
        out.push(cur); return out;
      };
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
      if (lines.length === 0) return;
      const first = parseLine(lines[0]).map((h) => h.trim().toLowerCase());
      const hasHeader = first.includes("title") || first.includes("name");
      const col = (names: string[]) => first.findIndex((h) => names.includes(h));
      const ti = hasHeader ? Math.max(0, col(["title", "name", "task"])) : 0;
      const pi = hasHeader ? col(["priority"]) : -1;
      const di = hasHeader ? col(["due", "due date", "duedate"]) : -1;
      const si = hasHeader ? col(["status"]) : -1;
      const dataLines = hasHeader ? lines.slice(1) : lines;
      let n = 0;
      dataLines.forEach((line) => {
        const cells = parseLine(line);
        const title = (cells[ti] || "").trim(); if (!title) return;
        const partial: Partial<Task> & { title: string } = { title };
        const pr = pi >= 0 ? (cells[pi] || "").trim().toLowerCase() : "";
        if (["low", "medium", "high", "urgent"].includes(pr)) partial.priority = pr as Task["priority"];
        const st = si >= 0 ? (cells[si] || "").trim().toLowerCase() : "";
        if (["todo", "progress", "review", "blocked", "done"].includes(st)) partial.status = st as Task["status"];
        const dd = di >= 0 ? (cells[di] || "").trim() : "";
        if (/^\d{4}-\d{2}-\d{2}$/.test(dd)) partial.dueDate = dd;
        onQuickAdd(partial); n++;
      });
      if (n > 0) toastImport(`Imported ${n} task${n > 1 ? "s" : ""}`);
    };
    reader.readAsText(file);
  };

  return (
    <>
      {header}
      <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12, padding: isMobile ? "10px 14px" : "12px 24px", borderBottom: "1px solid var(--hairline)", flexShrink: 0, flexWrap: "wrap" }}>
        <Segmented options={VIEW_OPTS} value={view} onChange={setView} />
        {!isMobile && <div style={{ width: 1, height: 22, background: "var(--hairline)" }} />}
        {view === "list" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {!isMobile && <span className="kicker">Group</span>}
            <Segmented options={GROUP_OPTS} value={groupBy} onChange={setGroupBy} />
          </div>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: isMobile ? 8 : 10 }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <Icon name="search" size={14} style={{ position: "absolute", left: 10, color: "var(--ink-4)", pointerEvents: "none" }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter tasks…" aria-label="Filter tasks by title"
            style={{ width: isMobile ? 120 : 168, height: 34, padding: "0 10px 0 30px", borderRadius: 9, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" }} />
          {search && <button onClick={() => setSearch("")} aria-label="Clear search" style={{ position: "absolute", right: 6, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 15, lineHeight: 1 }}>×</button>}
        </div>
        {view === "list" && (
          <div style={{ position: "relative" }}>
            <button onClick={() => setSortOpen((v) => !v)} className="btn" style={{ padding: "8px 11px", border: sort !== "manual" ? "1px solid var(--accent)" : "1px solid var(--hairline)", background: sort !== "manual" ? "var(--accent-dim)" : "transparent", color: sort !== "manual" ? "var(--accent)" : "var(--ink-2)" }}>
              <Icon name="sort" size={15} /> Sort
            </button>
            {sortOpen && (
              <>
                <div onClick={() => setSortOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
                <div className="anim-scalein" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 31, width: 180, padding: 6, borderRadius: 12, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)" }}>
                  {[{ v: "manual", l: "Manual" }, { v: "due", l: "Due date" }, { v: "priority", l: "Priority" }, { v: "title", l: "Name (A–Z)" }].map((o) => (
                    <button key={o.v} onClick={() => { setSort(o.v); setSortOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 9px", borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, fontFamily: "var(--font-display)", color: sort === o.v ? "var(--ink)" : "var(--ink-3)", background: sort === o.v ? "var(--surface-2)" : "transparent" }}>
                      <span style={{ width: 13, display: "grid", placeItems: "center" }}>{sort === o.v && <Icon name="check" size={13} style={{ color: "var(--accent)" }} />}</span>{o.l}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <div style={{ position: "relative" }}>
          <button onClick={() => setFilterOpen((v) => !v)} className="btn" style={{ padding: "8px 11px", border: filterActive ? "1px solid var(--accent)" : "1px solid var(--hairline)", background: filterActive ? "var(--accent-dim)" : "transparent", color: filterActive ? "var(--accent)" : "var(--ink-2)" }}>
            <Icon name="filter" size={15} /> Filter{filterActive ? " · on" : ""}
          </button>
          {filterOpen && (
            <>
              <div onClick={() => setFilterOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
              <div className="anim-scalein" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 31, width: 224, maxHeight: 420, overflowY: "auto", padding: 8, borderRadius: 12, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)" }}>
                <div style={{ display: "flex", alignItems: "center", padding: "2px 6px 8px" }}>
                  <span className="kicker">Filters</span>
                  {filterActive && <button onClick={() => setFilters({ priority: "all", assignee: "all", tag: "all", due: "all", hideDone: false, showArchived: false, custom: {} })} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-display)" }}>Clear all</button>}
                </div>

                <FilterSection label="Priority">
                  {PRIORITY_FILTERS.map((p) => <FilterOption key={p.value} label={p.label} active={priorityFilter === p.value} onClick={() => setFilter({ priority: p.value })} />)}
                </FilterSection>

                <FilterSection label="Due">
                  {[{ v: "all", l: "Any time" }, { v: "overdue", l: "Overdue" }, { v: "today", l: "Due today" }, { v: "week", l: "Next 7 days" }].map((d) => <FilterOption key={d.v} label={d.l} active={dueFilter === d.v} onClick={() => setFilter({ due: d.v })} />)}
                </FilterSection>

                {members.length > 1 && (
                  <FilterSection label="Assignee">
                    <FilterOption label="Anyone" active={assigneeFilter === "all"} onClick={() => setFilter({ assignee: "all" })} />
                    {members.map((m) => <FilterOption key={m.id} label={m.name} active={assigneeFilter === m.id} onClick={() => setFilter({ assignee: m.id })} />)}
                  </FilterSection>
                )}

                {Object.keys(allTags).length > 0 && (
                  <FilterSection label="Tag">
                    <FilterOption label="Any tag" active={tagFilter === "all"} onClick={() => setFilter({ tag: "all" })} />
                    {Object.entries(allTags).map(([id, t]) => <FilterOption key={id} label={t.label} dot={t.color} active={tagFilter === id} onClick={() => setFilter({ tag: id })} />)}
                  </FilterSection>
                )}

                {/* custom-field filters (dropdown / people fields) */}
                {customFields.filter((f) => f.type === "dropdown" || f.type === "people" || f.type === "multiselect").map((f) => {
                  const cur = customFilter?.[f.id] ?? "all";
                  const opts = f.type === "people" ? members.map((m) => ({ v: m.id, l: m.name })) : f.options.map((o) => ({ v: o, l: o }));
                  return (
                    <FilterSection key={f.id} label={f.name}>
                      <FilterOption label="Any" active={cur === "all"} onClick={() => setFilter({ custom: { ...(customFilter ?? {}), [f.id]: "all" } })} />
                      {opts.map((o) => <FilterOption key={o.v} label={o.l} active={cur === o.v} onClick={() => setFilter({ custom: { ...(customFilter ?? {}), [f.id]: o.v } })} />)}
                    </FilterSection>
                  );
                })}

                <div className="divider" style={{ margin: "6px 4px" }} />
                <button onClick={() => setFilter({ hideDone: !hideDone })} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, fontFamily: "var(--font-display)", color: "var(--ink-2)", background: "transparent" }}>
                  <span style={{ width: 16, height: 16, borderRadius: 5, border: `1.5px solid ${hideDone ? "var(--accent)" : "var(--hairline-strong)"}`, background: hideDone ? "var(--accent)" : "transparent", display: "grid", placeItems: "center" }}>{hideDone && <Icon name="check" size={11} sw={3} style={{ color: "var(--on-accent)" }} />}</span>
                  Hide completed
                </button>
                {archivedTasks.length > 0 && (
                  <button onClick={() => setFilter({ showArchived: !showArchived })} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 13, fontFamily: "var(--font-display)", color: "var(--ink-2)", background: "transparent" }}>
                    <span style={{ width: 16, height: 16, borderRadius: 5, border: `1.5px solid ${showArchived ? "var(--accent)" : "var(--hairline-strong)"}`, background: showArchived ? "var(--accent)" : "transparent", display: "grid", placeItems: "center" }}>{showArchived && <Icon name="check" size={11} sw={3} style={{ color: "var(--on-accent)" }} />}</span>
                    <Icon name="archive" size={13} style={{ color: "var(--ink-4)" }} /> Show archived <span className="mono" style={{ color: "var(--ink-4)", marginLeft: "auto" }}>{archivedTasks.length}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <button onClick={() => setSmart((v) => !v)} className="btn" style={{
          padding: "8px 12px", border: smart ? "1px solid var(--accent)" : "1px solid var(--hairline)",
          background: smart ? "var(--accent-dim)" : "transparent", color: smart ? "var(--accent)" : "var(--ink-2)", fontWeight: 500,
        }}>
          <Icon name="sparkles" size={15} /> AI sort {smart ? "on" : "off"}
        </button>
        {view === "list" && (
          <button onClick={toggleCompact} className="btn" title={compact ? "Switch to comfortable rows" : "Switch to compact rows"} style={{ padding: "8px 11px", border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-2)" }}>
            <Icon name={compact ? "list" : "menu"} size={15} /> {compact ? "Comfortable" : "Compact"}
          </button>
        )}
        {!isMobile && (
          <>
            <input ref={csvInputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) importCsv(f); e.target.value = ""; }} />
            <button onClick={exportCsv} className="btn" title="Export current view to CSV" style={{ padding: "8px 11px", border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-2)" }}><Icon name="arrowUpRight" size={15} /> CSV</button>
            <button onClick={() => csvInputRef.current?.click()} className="btn" title="Import tasks from CSV" style={{ padding: "8px 11px", border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-2)" }}><Icon name="plus" size={15} /> Import</button>
          </>
        )}
        </div>
      </div>
      {(view === "list" || view === "board") && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: isMobile ? "8px 14px" : "8px 24px", flexWrap: "wrap", borderBottom: "1px solid var(--hairline)", flexShrink: 0 }}>
          <span className="kicker" style={{ marginRight: 2 }}>Quick</span>
          {[
            { label: "Overdue", active: dueFilter === "overdue", on: () => setFilter({ due: dueFilter === "overdue" ? "all" : "overdue" }) },
            { label: "Today", active: dueFilter === "today", on: () => setFilter({ due: dueFilter === "today" ? "all" : "today" }) },
            { label: "This week", active: dueFilter === "week", on: () => setFilter({ due: dueFilter === "week" ? "all" : "week" }) },
            { label: "High priority", active: priorityFilter === "high", on: () => setFilter({ priority: priorityFilter === "high" ? "all" : "high" }) },
            { label: "Urgent", active: priorityFilter === "urgent", on: () => setFilter({ priority: priorityFilter === "urgent" ? "all" : "urgent" }) },
            { label: "Hide done", active: hideDone, on: () => setFilter({ hideDone: !hideDone }) },
          ].map((c) => (
            <button key={c.label} onClick={c.on} style={{ padding: "4px 11px", borderRadius: 99, cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 500, border: `1px solid ${c.active ? "var(--accent)" : "var(--hairline)"}`, background: c.active ? "var(--accent-dim)" : "transparent", color: c.active ? "var(--accent)" : "var(--ink-3)" }}>{c.label}</button>
          ))}
          {filterActive && <button onClick={() => setFilters({ priority: "all", assignee: "all", tag: "all", due: "all", hideDone: false, showArchived: false, custom: {} })} style={{ marginLeft: 4, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-display)" }}>Clear</button>}
        </div>
      )}
      {view === "list" && <ListView tasks={filtered} allTasks={allTasks} projects={projects} compact={compact} onOpen={onOpen} onToggle={onToggle} onToggleSubtask={onToggleSubtask} groupBy={groupBy} smart={smart} sort={sort} onBulkPatch={onBulkPatch} onBulkDelete={onBulkDelete} onPatch={onPatch} onQuickAdd={onQuickAdd} members={members} sections={sections} onCreateSection={onCreateSection} onRenameSection={onRenameSection} onDeleteSection={onDeleteSection} customFields={customFields} sectionField={sectionField} sectionProjectId={sectionProjectId} />}
      {view === "board" && <BoardView tasks={filtered} allTasks={allTasks} onOpen={onOpen} onAdd={onAdd} onMove={onMove} onPatch={onPatch} onBulkPatch={onBulkPatch} onBulkDelete={onBulkDelete} members={members} customFields={customFields} />}
      {view === "timeline" && <TimelineView tasks={filtered} allTasks={allTasks} onOpen={onOpen} onPatch={onPatch} />}
      {view === "calendar" && <CalendarView tasks={filtered} onOpen={onOpen} onPatch={onPatch} />}
      {view === "files" && <FilesView tasks={filtered} onOpen={onOpen} />}
      {view === "matrix" && <MatrixView tasks={filtered} onOpen={onOpen} />}
    </>
  );
}

function FullLoader() {
  const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;
  const bar = (w: number | string, h = 12, style: React.CSSProperties = {}) => <div className="skel" style={{ width: w, height: h, ...style }} />;
  return (
    <div style={{ position: "relative", height: "100vh", overflow: "hidden", display: "flex" }}>
      <div className="app-bg" />
      {/* sidebar rail */}
      {!isMobile && (
        <div style={{ position: "relative", zIndex: 1, width: 248, flexShrink: 0, borderRight: "1px solid var(--hairline)", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>{bar(28, 28, { borderRadius: 9 })}{bar(96, 16)}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{Array.from({ length: 6 }, (_, i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 11 }}>{bar(18, 18, { borderRadius: 6 })}{bar(`${60 + (i % 3) * 12}%`, 13)}</div>)}</div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 9 }}>{bar(70, 10)}{Array.from({ length: 4 }, (_, i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 11 }}>{bar(14, 14, { borderRadius: 99 })}{bar(`${50 + (i % 3) * 15}%`, 12)}</div>)}</div>
        </div>
      )}
      {/* main column */}
      <div style={{ position: "relative", zIndex: 1, flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 24px", borderBottom: "1px solid var(--hairline)" }}>
          {bar(200, 22)}<div style={{ flex: 1 }} />{bar(120, 34, { borderRadius: 11 })}{bar(36, 34, { borderRadius: 11 })}
        </div>
        <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14, maxWidth: 880, width: "100%" }}>
          {bar(160, 14)}
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="glass" style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderRadius: 13, opacity: 1 - i * 0.1 }}>
              {bar(20, 20, { borderRadius: 99 })}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>{bar(`${40 + (i * 7) % 45}%`, 13)}{bar(`${20 + (i * 5) % 20}%`, 10)}</div>
              {bar(54, 20, { borderRadius: 7 })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const auth = useAuth();
  const { error: toastError, success: toastSuccess, action: toastAction } = useToast();
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try { const s = localStorage.getItem("kanbo-theme"); if (s === "light" || s === "dark") return s; } catch { /* private mode */ }
    return "dark"; // dark is the on-brand default; users can toggle to light
  });
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tags, setTags] = useState<Record<string, TagDef>>({});
  const [activity, setActivity] = useState<Activity[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [statusUpdates, setStatusUpdates] = useState<StatusUpdate[]>([]);
  const [automationRules, setAutomationRules] = useState<AutomationRule[]>([]);
  const [forms, setForms] = useState<FormDef[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([{ id: null, name: "Personal", kind: "personal" }]);
  const [wsMembers, setWsMembers] = useState<WorkspaceMember[]>([]);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<Plan | null>(null);
  const [currentUserId, setCurrentUserId] = useState("m-self");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [calConnections, setCalConnections] = useState<CalendarConnection[]>([]);
  const [calEvents, setCalEvents] = useState<ExternalEvent[]>([]);
  const [calSyncing, setCalSyncing] = useState(false);
  const [route, setRouteRaw] = useState<Route>({ view: "home" });
  const [workspace, setWorkspace] = useState<string | null>(store.configured ? null : "ws-foundrise");
  const [view, setView] = useState<TaskView>(() => {
    try { const s = localStorage.getItem("kanbo-view") as TaskView | null; if (s && ["list", "board", "timeline", "calendar", "files", "matrix"].includes(s)) return s; } catch { /* private mode */ }
    return "list";
  });
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    try { const s = localStorage.getItem("kanbo-groupby") as GroupBy | null; if (s && ["status", "section", "due", "priority", "project", "none"].includes(s)) return s; } catch { /* private mode */ }
    return "status";
  });
  useEffect(() => { try { localStorage.setItem("kanbo-view", view); } catch { /* private mode */ } }, [view]);
  useEffect(() => { try { localStorage.setItem("kanbo-groupby", groupBy); } catch { /* private mode */ } }, [groupBy]);
  // saved views per project: remember each project's view + grouping
  const pviewKey = route.view === "project" && route.projectId ? `kanbo-pview-${route.projectId}` : null;
  const skipPviewSave = useRef(false);
  useEffect(() => {
    if (!pviewKey) return;
    try { const s = localStorage.getItem(pviewKey); if (s) { const c = JSON.parse(s); skipPviewSave.current = true; if (c.view) setView(c.view); if (c.groupBy) setGroupBy(c.groupBy); } } catch { /* private mode */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pviewKey]);
  useEffect(() => {
    if (!pviewKey) return;
    if (skipPviewSave.current) { skipPviewSave.current = false; return; }
    try { localStorage.setItem(pviewKey, JSON.stringify({ view, groupBy })); } catch { /* private mode */ }
  }, [view, groupBy, pviewKey]);
  const [smart, setSmart] = useState(false);
  // unread inbox badge: count activity newer than the last time you opened the
  // inbox (persisted). New accounts start "caught up" rather than flooded.
  const [inboxSeenAt, setInboxSeenAt] = useState<number>(() => {
    try { const s = localStorage.getItem("kanbo-inbox-seen"); if (s) return Number(s) || 0; } catch { /* private mode */ }
    return Date.now();
  });
  useEffect(() => {
    try { if (!localStorage.getItem("kanbo-inbox-seen")) localStorage.setItem("kanbo-inbox-seen", String(inboxSeenAt)); } catch { /* private mode */ }
  }, [inboxSeenAt]);
  // opening the inbox marks everything seen and clears the badge
  useEffect(() => {
    if (route.view !== "inbox") return;
    const now = Date.now();
    setInboxSeenAt(now);
    try { localStorage.setItem("kanbo-inbox-seen", String(now)); } catch { /* private mode */ }
    // mark every item read (optimistic + server, best-effort)
    const stamp = new Date().toISOString();
    setActivity((xs) => xs.map((a) => a.readAt ? a : { ...a, readAt: stamp }));
    store.markActivityRead().catch(reportError);
  }, [route.view]);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const gPrefixRef = useRef(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [focusOpen, setFocusOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskStatus, setNewTaskStatus] = useState<Status>("todo");
  const [newTaskProjectId, setNewTaskProjectId] = useState<string | undefined>(undefined);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const focus = useFocusTimer();

  const routeRef = useRef<Route>(route); routeRef.current = route;
  // tasks created locally but not yet confirmed saved — kept through realtime
  // reloads so a refetch can never wipe a task you just added
  const pendingTasksRef = useRef<Task[]>([]);
  // recent local edits/deletes, applied on top of a realtime refetch so a
  // background reload can never revert a change you just made (the DB may not
  // have propagated your own write yet). Each entry self-expires.
  const recentWritesRef = useRef<Map<string, { deleted: boolean; patch: Partial<Task>; until: number }>>(new Map());
  const WRITE_TTL = 8000;
  const noteWrite = useCallback((ids: string | string[], patch: Partial<Task>) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    const until = Date.now() + WRITE_TTL;
    arr.forEach((id) => {
      const ex = recentWritesRef.current.get(id);
      recentWritesRef.current.set(id, { deleted: false, patch: { ...(ex?.patch ?? {}), ...patch }, until });
    });
  }, []);
  const noteDelete = useCallback((ids: string | string[]) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    const until = Date.now() + WRITE_TTL;
    arr.forEach((id) => recentWritesRef.current.set(id, { deleted: true, patch: {}, until }));
  }, []);
  const clearWrite = useCallback((ids: string | string[]) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    arr.forEach((id) => recentWritesRef.current.delete(id));
  }, []);
  const tasksRef = useRef<Task[] | null>(null); tasksRef.current = tasks;
  const userIdRef = useRef(currentUserId); userIdRef.current = currentUserId;
  const projectsRef = useRef<Project[]>([]); projectsRef.current = projects;
  const rulesRef = useRef<AutomationRule[]>([]); rulesRef.current = automationRules;
  const tagsRef = useRef<Record<string, TagDef>>({}); tagsRef.current = tags;
  const workspacesRef = useRef<Workspace[]>([]); workspacesRef.current = workspaces;
  const workspaceRef = useRef<string | null>(null); workspaceRef.current = workspace;
  const [aiBusy, setAiBusy] = useState(false);

  // single source of truth for projects/tags: React state (drives re-renders) +
  // the module reference data (used by getProject()/<Tag> lookups deep in the tree).
  const applyProjects = useCallback((next: Project[]) => {
    setProjects(next);
    setReferenceData({ projects: next });
  }, []);
  const applyTags = useCallback((next: Record<string, TagDef>) => {
    setTags(next);
    setReferenceData({ tags: next });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("kanbo-theme", theme); } catch { /* private mode */ }
  }, [theme]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdOpen((v) => !v); return; }
      if (e.key === "Escape") {
        // close whatever transient overlay is open (idempotent; modals also
        // handle their own Escape via the focus trap)
        setCmdOpen(false); setDetailId(null); setSidebarOpen(false); setFocusOpen(false);
        setUpgradeOpen(false); setNewTaskOpen(false); setNewProjectOpen(false);
        setNewWorkspaceOpen(false); setDeleteProjectId(null); setShortcutsOpen(false);
        return;
      }
      // single-key shortcuts — ignore while typing or with modifiers held
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT" || tgt.isContentEditable)) return;
      if (gPrefixRef.current) {
        gPrefixRef.current = false;
        const nav: Record<string, Route["view"]> = { h: "home", p: "plan", i: "inbox", t: "tasks", c: "calendar", s: "search", a: "analytics" };
        const v = nav[e.key.toLowerCase()];
        if (v) { e.preventDefault(); setRouteRaw({ view: v }); setDetailId(null); setSidebarOpen(false); }
        return;
      }
      if (e.key === "g") { gPrefixRef.current = true; window.setTimeout(() => { gPrefixRef.current = false; }, 800); return; }
      if (e.key === "c") { e.preventDefault(); const r = routeRef.current; setNewTaskProjectId(r.view === "project" ? r.projectId : undefined); setNewTaskStatus("todo"); setNewTaskOpen(true); return; }
      if (e.key === "/") { e.preventDefault(); setCmdOpen(true); return; }
      if (e.key === "?") { e.preventDefault(); setShortcutsOpen(true); return; }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // load data once the user is known (immediately in demo mode)
  const authUserId = auth.user?.id ?? null;

  // dwell-time tracking: open a session and heartbeat while the tab is active
  // (best-effort — quietly no-ops if the sessions table isn't installed yet)
  useEffect(() => {
    if (!store.configured || !authUserId) return;
    let sessionId: string | null = null, stopped = false;
    store.recordSession(authUserId).then((id) => { sessionId = id; });
    const beat = () => { if (!stopped && sessionId && document.visibilityState === "visible") store.touchSession(sessionId); };
    const iv = window.setInterval(beat, 45000);
    document.addEventListener("visibilitychange", beat);
    return () => { stopped = true; clearInterval(iv); document.removeEventListener("visibilitychange", beat); };
  }, [authUserId]);

  useEffect(() => {
    if (auth.configured && !authUserId) { setTasks(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const b = await store.bootstrap(auth.user);
        if (!cancelled) { setTasks(b.tasks); applyProjects(b.projects); applyTags(b.tags); setWorkspaces(b.workspaces); setWsMembers(b.members); setCurrentUserId(b.currentUserId); setWorkspace(b.defaultWorkspace); setProfile(b.profile); setSections(b.sections); setCustomFields(b.customFields); setSavedSearches(b.savedSearches); setGoals(b.goals); setPortfolios(b.portfolios); setStatusUpdates(b.statusUpdates); setAutomationRules(b.automationRules); setForms(b.forms); }
        const feed = await store.listActivity();
        if (!cancelled) setActivity(feed);
        const subn = await store.getSubscription();
        if (!cancelled) setSubscription(subn);
      } catch (e) {
        reportError(e, { op: "bootstrap" });
        if (!cancelled) { setTasks([]); toastError("Couldn't load your workspace. Please refresh."); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.configured, authUserId]);

  // real-time multi-tab/device sync: re-pull data (debounced) on remote changes
  useEffect(() => {
    if (!store.configured || !authUserId) return;
    let timer: ReturnType<typeof setTimeout>;
    const reload = async () => {
      try {
        const b = await store.bootstrap(auth.user);
        // apply recent local edits/deletes on top of the refetch so a reload
        // can't revert a change whose write hasn't propagated yet
        const now = Date.now();
        const m = recentWritesRef.current;
        for (const [id, w] of m) if (w.until < now) m.delete(id);
        const merged = b.tasks
          .filter((d) => !m.get(d.id)?.deleted)
          .map((d) => { const w = m.get(d.id); return w && !w.deleted ? { ...d, ...w.patch } : d; });
        // never drop a locally-created task that hasn't been confirmed in the DB yet
        const pending = pendingTasksRef.current.filter((p) => !b.tasks.some((d) => d.id === p.id));
        setTasks(pending.length ? [...pending, ...merged] : merged);
        applyProjects(b.projects); applyTags(b.tags); setWorkspaces(b.workspaces); setWsMembers(b.members); setProfile(b.profile);
        setSections(b.sections); setCustomFields(b.customFields); setSavedSearches(b.savedSearches);
        setGoals(b.goals); setPortfolios(b.portfolios); setStatusUpdates(b.statusUpdates); setAutomationRules(b.automationRules); setForms(b.forms);
        setActivity(await store.listActivity());
      } catch (e) { reportError(e, { op: "realtime-reload" }); }
    };
    const unsub = store.subscribeToChanges(() => { clearTimeout(timer); timer = setTimeout(reload, 500); });
    return () => { clearTimeout(timer); unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId]);

  const setRoute = (r: Route) => {
    setRouteRaw(r);
    if (r.smart) setSmart(true);
    setDetailId(null);
    setSidebarOpen(false); // close the mobile drawer on navigation
  };

  /* append to the activity feed (Inbox) — fire-and-forget */
  const log = useCallback((kind: ActivityKind, task: { id: string | null; title: string }, detail: string) => {
    store.logActivity({ taskId: task.id, taskTitle: task.title, kind, detail }, userIdRef.current)
      .then((a) => setActivity((xs) => [a, ...xs]))
      .catch(reportError);
  }, []);

  /* ---- inbox archiving ---- */
  const archiveActivity = useCallback((id: string) => {
    setActivity((xs) => xs.filter((a) => a.id !== id)); // optimistic
    store.archiveActivity(id).catch((e) => { reportError(e); toastError("Couldn't archive that item."); });
  }, [toastError]);

  const clearInbox = useCallback(() => {
    setActivity((xs) => { if (!xs.length) return xs; return []; });
    store.clearInbox().then(() => toastSuccess("Inbox cleared")).catch((e) => { reportError(e); toastError("Couldn't clear the inbox."); });
  }, [toastSuccess, toastError]);

  /* ---- profile ---- */
  const uploadAvatar = useCallback((file: File) => store.uploadAvatar(userIdRef.current, file), []);

  const saveProfile = useCallback(async (draft: ProfileDraft) => {
    const email = auth.user?.email ?? getMember(userIdRef.current)?.email ?? "";
    const saved = await store.saveProfile(userIdRef.current, { ...draft, email });
    setProfile(saved);
    // reflect name/avatar/pronouns in reference data so every Avatar + assignee
    // label across the app updates immediately.
    const name = [saved.firstName, saved.lastName].filter(Boolean).join(" ").trim();
    setReferenceData({
      members: MEMBERS.map((m) => m.id === userIdRef.current
        ? { ...m, name: name || m.name, email: saved.email || m.email, pronouns: saved.pronouns || undefined, avatarUrl: saved.avatarUrl }
        : m),
    });
    toastSuccess("Profile saved");
  }, [auth.user?.email, toastSuccess]);

  // download all of the user's data as JSON (user-initiated, their own data)
  const exportData = useCallback(() => {
    const payload = {
      app: "Kanbo",
      exportedAt: new Date().toISOString(),
      profile,
      workspaces,
      projects,
      tasks: tasksRef.current ?? [],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kanbo-export-${toLocalISO(new Date())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toastSuccess("Your data is downloading");
  }, [profile, workspaces, projects, toastSuccess]);

  const deleteAccount = useCallback(async () => {
    await store.deleteAccount();
    // wipe local state and bounce to the signed-out site
    if (auth.configured) await auth.signOut();
  }, [auth]);

  /* ---- external calendars (Google / Microsoft) ---- */
  const refreshCalendar = useCallback(async () => {
    if (!store.configured) return;
    setCalSyncing(true);
    try {
      const conns = await store.listCalendarConnections();
      setCalConnections(conns);
      if (conns.length) {
        const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
        const end = new Date(start); end.setMonth(end.getMonth() + 2);
        setCalEvents(await store.listExternalEvents(start.toISOString(), end.toISOString()));
      } else {
        setCalEvents([]);
      }
    } catch (e) { reportError(e); }
    finally { setCalSyncing(false); }
  }, []);

  const connectCalendar = useCallback(async (provider: CalProvider) => {
    try {
      const url = await store.getCalendarAuthUrl(provider);
      window.location.href = url; // full redirect to the provider's consent screen
    } catch (e) {
      reportError(e);
      toastError(e instanceof Error ? e.message : "Couldn't start the connection.");
    }
  }, [toastError]);

  const disconnectCalendar = useCallback(async (provider: CalProvider) => {
    try { await store.disconnectCalendar(provider); toastSuccess("Calendar disconnected"); refreshCalendar(); }
    catch (e) { reportError(e); toastError("Couldn't disconnect that calendar."); }
  }, [toastSuccess, toastError, refreshCalendar]);

  // first-run welcome — once, for a brand-new account (no tasks yet) OR any
  // account that still has no real name set (a name is needed so teammates and
  // assignment notifications show a person, not an email).
  const welcomeKey = `kanbo-welcomed-${currentUserId}`;
  useEffect(() => {
    if (!store.configured || tasks === null || currentUserId === "m-self") return;
    const self = getMember(currentUserId);
    const named = !!(self?.name && !self.name.includes("@"));
    if (tasks.length === 0 || !named) {
      try { if (!localStorage.getItem(welcomeKey)) setWelcomeOpen(true); } catch { /* private mode */ }
    }
  }, [tasks, welcomeKey, currentUserId]);
  const dismissWelcome = useCallback(() => {
    try { localStorage.setItem(welcomeKey, "1"); } catch { /* private mode */ }
    setWelcomeOpen(false);
  }, [welcomeKey]);

  // deep link: open ?task=<id> once tasks are loaded, then clean the URL
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current || tasks === null) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const tid = params.get("task");
      if (!tid) return;
      deepLinkDone.current = true;
      if (tasks.some((t) => t.id === tid)) setDetailId(tid);
      params.delete("task");
      window.history.replaceState({}, "", window.location.pathname + (params.toString() ? "?" + params : ""));
    } catch { /* ignore */ }
  }, [tasks]);

  // load connected calendars on sign-in, and handle the OAuth round-trip return
  useEffect(() => {
    if (!store.configured || !authUserId) return;
    refreshCalendar();
    const params = new URLSearchParams(window.location.search);
    const cal = params.get("calendar");
    if (cal === "connected") { toastSuccess("Calendar connected"); setRouteRaw({ view: "calendar" }); }
    if (cal === "error") toastError("Couldn't connect that calendar. Please try again.");
    if (cal) {
      params.delete("calendar"); params.delete("fresh");
      const qs = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId]);

  const persistTask = useCallback((raw: Task) => {
    // a task lives in its project's workspace
    const wsId = getProject(raw.projectId)?.workspaceId ?? null;
    // new tasks sort to the bottom of their board column
    const t: Task = { ...raw, workspaceId: wsId, position: raw.position ?? Date.now() };
    setTasks((ts) => ts ? [t, ...ts] : [t]);
    // track as pending so a realtime reload can't drop it before it's saved
    pendingTasksRef.current = [t, ...pendingTasksRef.current];
    const clearPending = () => { pendingTasksRef.current = pendingTasksRef.current.filter((p) => p.id !== t.id); };
    store.createTask(t, userIdRef.current)
      .then((saved) => {
        clearPending();
        if (saved.id !== t.id) setTasks((ts) => ts && ts.map((x) => x.id === t.id ? saved : x));
        log("created", saved, "Task created");
      })
      .catch((e) => {
        // keep it on screen (still in pendingTasksRef) and tell the user loudly
        reportError(e, { op: "createTask" });
        toastError(`Couldn't save “${t.title}”: ${e?.message || e}`);
      });
  }, [log, toastError]);

  // automation: apply enabled "task created" rules for the task's project,
  // folded into the new task BEFORE it's created (no hot-path mutation, no loops)
  const applyAutomation = useCallback((t: Task): Task => {
    const rules = rulesRef.current.filter((r) => r.enabled && r.trigger === "task_created" && r.projectId === t.projectId);
    if (rules.length === 0) return t;
    let next = { ...t };
    for (const r of rules) for (const a of r.actions) {
      if (!a.value) continue;
      if (a.type === "set_priority") next = { ...next, priority: a.value as Task["priority"] };
      else if (a.type === "set_assignee") next = { ...next, assigneeId: a.value };
      else if (a.type === "set_section") next = { ...next, sectionId: a.value };
      else if (a.type === "add_tag") next = { ...next, tags: [...new Set([...(next.tags ?? []), a.value])] };
    }
    return next;
  }, []);

  // inline quick-add: build a full task from a small partial (group context)
  const quickAddTask = useCallback((partial: Partial<Task> & { title: string }) => {
    const r = routeRef.current;
    // keep the new task in the workspace you're looking at — fall back to a
    // project in the active workspace, not the global Personal bucket (which
    // would silently file it elsewhere and vanish from the current view)
    const wsId = workspaceRef.current;
    const wsFallback = projectsRef.current.find((p) => (p.workspaceId ?? null) === wsId)?.id || "p-personal";
    const projectId = partial.projectId || (r.view === "project" ? r.projectId : undefined) || wsFallback;
    persistTask(applyAutomation({
      id: "t-new-" + Date.now() + "-" + Math.round(Math.random() * 1e6),
      title: partial.title, description: "", status: partial.status || "todo", priority: partial.priority || "medium",
      projectId, assigneeId: partial.assigneeId || userIdRef.current, tags: [], dependencies: [], subtasks: [],
      comments: 0, aiScore: 50, aiReason: undefined, focusMin: 30, dur: 30, scheduled: null, planToday: true,
      recurrence: "none", dueDate: partial.dueDate, position: Date.now(),
    }));
  }, [persistTask, applyAutomation]);

  // task dependencies (blocked-by)
  const addDependency = useCallback((taskId: string, dependsOn: string) => {
    if (taskId === dependsOn) return;
    const cur = tasksRef.current?.find((t) => t.id === taskId);
    const deps = [...new Set([...(cur?.dependencies ?? []), dependsOn])];
    setTasks((ts) => ts && ts.map((t) => t.id === taskId ? { ...t, dependencies: deps } : t));
    noteWrite(taskId, { dependencies: deps });
    store.addDependency(taskId, dependsOn).catch(reportError);
  }, [noteWrite]);
  const removeDependency = useCallback((taskId: string, dependsOn: string) => {
    const cur = tasksRef.current?.find((t) => t.id === taskId);
    const deps = (cur?.dependencies ?? []).filter((d) => d !== dependsOn);
    setTasks((ts) => ts && ts.map((t) => t.id === taskId ? { ...t, dependencies: deps } : t));
    noteWrite(taskId, { dependencies: deps });
    store.removeDependency(taskId, dependsOn).catch(reportError);
  }, [noteWrite]);

  const archiveTask = useCallback((id: string) => {
    const at = new Date().toISOString();
    setTasks((ts) => ts && ts.map((t) => t.id === id ? { ...t, archivedAt: at } : t));
    noteWrite(id, { archivedAt: at });
    store.updateTask(id, { archivedAt: at }).catch(reportError);
    toastAction("Task archived", "Undo", () => {
      setTasks((ts) => ts && ts.map((t) => t.id === id ? { ...t, archivedAt: undefined } : t));
      noteWrite(id, { archivedAt: undefined });
      store.updateTask(id, { archivedAt: undefined }).catch(reportError);
    });
  }, [toastAction, noteWrite]);
  const unarchiveTask = useCallback((id: string) => {
    setTasks((ts) => ts && ts.map((t) => t.id === id ? { ...t, archivedAt: undefined } : t));
    noteWrite(id, { archivedAt: undefined });
    store.updateTask(id, { archivedAt: undefined }).catch(reportError);
  }, [noteWrite]);

  // duplicate a task (fresh copy, not done, no comments/deps carried over)
  const duplicateTask = useCallback((id: string) => {
    const src = tasksRef.current?.find((t) => t.id === id);
    if (!src) return;
    const uid = () => "t-dup-" + Date.now() + "-" + Math.round(Math.random() * 1e6);
    persistTask({
      ...src, id: uid(), title: src.title + " (copy)", status: "todo", completedAt: undefined,
      comments: 0, dependencies: [], subtasks: src.subtasks.map((s) => ({ ...s, id: uid(), done: false })),
      position: Date.now(),
    });
    toastSuccess("Task duplicated");
  }, [persistTask, toastSuccess]);

  // when a recurring task is completed, spawn its next occurrence
  const spawnRecurrence = useCallback((t: Task) => {
    if (!t.recurrence || t.recurrence === "none") return;
    const next: Task = {
      ...t,
      id: "t-rec-" + Date.now() + "-" + Math.round(Math.random() * 1e5),
      status: "todo",
      completedAt: undefined,
      dueDate: nextDueDate(t.dueDate, t.recurrence),
      scheduled: null,
      comments: 0,
      subtasks: t.subtasks.map((s) => ({ ...s, done: false })),
    };
    persistTask(next);
  }, [persistTask]);

  const toggleTask = useCallback((id: string) => {
    const cur = tasksRef.current; if (!cur) return;
    const t = cur.find((x) => x.id === id); if (!t) return;
    const becomingDone = t.status !== "done";
    if (becomingDone) {
      // dependency enforcement: warn before completing a still-blocked task
      const blockers = (t.dependencies ?? []).map((d) => cur.find((x) => x.id === d)).filter((b): b is Task => !!b && b.status !== "done");
      if (blockers.length && !window.confirm(`“${t.title}” is blocked by ${blockers.length} unfinished task${blockers.length > 1 ? "s" : ""}. Mark it complete anyway?`)) return;
    }
    const status: Status = becomingDone ? "done" : "todo";
    const completedAt = becomingDone ? toLocalISO(new Date()) : undefined;
    setTasks((ts) => ts && ts.map((x) => x.id === id ? { ...x, status, completedAt } : x));
    noteWrite(id, { status, completedAt });
    store.updateTask(id, { status, completedAt }).catch(reportError);
    log(becomingDone ? "completed" : "reopened", t, becomingDone ? "Marked complete" : "Reopened");
    if (becomingDone) {
      // spawn the next occurrence only if the completion sticks (isn't undone),
      // so toggling done/undone can't multiply phantom recurrences
      let undone = false;
      const recTimer = setTimeout(() => { if (!undone) spawnRecurrence(t); }, 6000);
      toastAction(`Completed “${t.title}”`, "Undo", () => {
        undone = true; clearTimeout(recTimer);
        setTasks((ts) => ts && ts.map((x) => x.id === id ? { ...x, status: t.status, completedAt: t.completedAt } : x));
        noteWrite(id, { status: t.status, completedAt: t.completedAt });
        store.updateTask(id, { status: t.status, completedAt: t.completedAt }).catch(reportError);
      });
    }
  }, [log, spawnRecurrence, toastAction, noteWrite]);

  const patchTask = useCallback((id: string, patch: Partial<Task>) => {
    const prev = tasksRef.current?.find((t) => t.id === id);
    // a task lives in its project's workspace — when the project changes, move
    // the task's workspace with it so it doesn't vanish from the active view
    if (patch.projectId !== undefined && patch.workspaceId === undefined) {
      patch = { ...patch, workspaceId: getProject(patch.projectId)?.workspaceId ?? null };
    }
    setTasks((ts) => ts && ts.map((t) => t.id === id ? { ...t, ...patch } : t));
    noteWrite(id, patch);
    store.updateTask(id, patch).catch(reportError);
    if (prev && patch.status && patch.status !== prev.status) {
      if (patch.status === "done") { log("completed", prev, "Marked complete"); spawnRecurrence(prev); }
      else log("status", prev, `Moved to ${STATUS_META[patch.status].label}`);
    }
  }, [log, spawnRecurrence, noteWrite]);

  // follow/unfollow a task (followers get its activity in their inbox)
  const toggleFollow = useCallback((id: string) => {
    const t = tasksRef.current?.find((x) => x.id === id); if (!t) return;
    const uid = userIdRef.current;
    const cur = t.followers ?? [];
    const next = cur.includes(uid) ? cur.filter((f) => f !== uid) : [...cur, uid];
    patchTask(id, { followers: next });
  }, [patchTask]);

  // toggle the signed-in user's emoji reaction on a task itself
  const toggleTaskReaction = useCallback((id: string, emoji: string) => {
    const t = tasksRef.current?.find((x) => x.id === id); if (!t) return;
    const uid = userIdRef.current;
    const r: Record<string, string[]> = { ...(t.reactions ?? {}) };
    const list = r[emoji] ?? [];
    r[emoji] = list.includes(uid) ? list.filter((x) => x !== uid) : [...list, uid];
    if (r[emoji].length === 0) delete r[emoji];
    patchTask(id, { reactions: r });
  }, [patchTask]);

  // add/remove a collaborator (extra assignee) on a task
  const toggleCollaborator = useCallback((id: string, memberId: string) => {
    const t = tasksRef.current?.find((x) => x.id === id); if (!t) return;
    const cur = t.collaborators ?? [];
    const next = cur.includes(memberId) ? cur.filter((c) => c !== memberId) : [...cur, memberId];
    patchTask(id, { collaborators: next });
  }, [patchTask]);

  // genuine "new task" entry points (modal, capture) run automation rules;
  // duplicate / recurrence / sub-tasks call persistTask directly (no rules)
  const createTask = useCallback((t: Task) => persistTask(applyAutomation(t)), [persistTask, applyAutomation]);

  const deleteTask = useCallback((id: string) => {
    const t = tasksRef.current?.find((x) => x.id === id);
    if (!t) return;
    // optimistically remove, but defer the real delete so it can be undone
    // deleting a parent removes its sub-tasks too (the DB cascades on delete);
    // mirror that locally so children don't linger as orphans, and restore
    // them all on undo
    const kids = (tasksRef.current ?? []).filter((x) => x.parentId === id);
    const removedIds = [id, ...kids.map((k) => k.id)];
    setTasks((ts) => ts && ts.filter((x) => !removedIds.includes(x.id)));
    noteDelete(removedIds);
    let undone = false;
    const timer = setTimeout(() => {
      if (undone) return;
      store.deleteTask(id).catch(reportError); // cascade removes children
      log("deleted", { id: null, title: t.title }, "Task deleted");
    }, 6000);
    const label = kids.length ? `Deleted “${t.title}” and ${kids.length} subtask${kids.length > 1 ? "s" : ""}` : `Deleted “${t.title}”`;
    toastAction(label, "Undo", () => {
      undone = true; clearTimeout(timer); clearWrite(removedIds);
      setTasks((ts) => ts ? [t, ...kids, ...ts] : [t, ...kids]);
    });
  }, [log, toastAction, noteDelete, clearWrite]);

  // ---- bulk actions (multi-select) ----
  const bulkPatch = useCallback((ids: string[], patch: Partial<Task>) => {
    if (!ids.length) return;
    const cur = tasksRef.current ?? [];
    const settingDone = patch.status === "done";
    // mark a completion time when bulk-completing, mirroring single complete
    const full = settingDone ? { ...patch, completedAt: toLocalISO(new Date()) } : patch;
    setTasks((ts) => ts && ts.map((t) => ids.includes(t.id) ? { ...t, ...full } : t));
    noteWrite(ids, full);
    ids.forEach((id) => store.updateTask(id, full).catch(reportError));
    // keep activity + recurrence consistent with a single status change
    if (patch.status) {
      ids.forEach((id) => {
        const prev = cur.find((t) => t.id === id);
        if (!prev || prev.status === patch.status) return;
        if (settingDone) { log("completed", prev, "Marked complete"); spawnRecurrence(prev); }
        else log("status", prev, `Moved to ${STATUS_META[patch.status!].label}`);
      });
    }
    toastSuccess(`Updated ${ids.length} task${ids.length > 1 ? "s" : ""}`);
  }, [toastSuccess, noteWrite, log, spawnRecurrence]);

  const bulkDelete = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const removed = (tasksRef.current ?? []).filter((t) => ids.includes(t.id));
    setTasks((ts) => ts && ts.filter((t) => !ids.includes(t.id)));
    noteDelete(ids);
    let undone = false;
    const timer = setTimeout(() => { if (undone) return; ids.forEach((id) => store.deleteTask(id).catch(reportError)); }, 6000);
    toastAction(`Deleted ${ids.length} task${ids.length > 1 ? "s" : ""}`, "Undo", () => {
      undone = true; clearTimeout(timer); clearWrite(ids);
      setTasks((ts) => ts ? [...removed, ...ts] : removed);
    });
  }, [toastAction, noteDelete, clearWrite]);

  const addComment = useCallback(async (taskId: string, body: string, mentions: string[] = []): Promise<Comment | null> => {
    const t = tasksRef.current?.find((x) => x.id === taskId);
    const authorName = getMember(userIdRef.current)?.name || "You";
    try {
      const c = await store.addComment(taskId, body, userIdRef.current, authorName, mentions);
      if (t) {
        const count = t.comments + 1;
        setTasks((ts) => ts && ts.map((x) => x.id === taskId ? { ...x, comments: count } : x));
        noteWrite(taskId, { comments: count });
        store.updateTask(taskId, { comments: count }).catch(reportError);
        log("comment", t, body.length > 80 ? body.slice(0, 77) + "…" : body);
      }
      return c;
    } catch (e) {
      reportError(e, { op: "addComment" });
      toastError("Couldn't post the comment.");
      return null;
    }
  }, [log, toastError, noteWrite]);

  const toggleSubtask = useCallback((taskId: string, subId: string) => {
    const cur = tasksRef.current; if (!cur) return;
    const task = cur.find((t) => t.id === taskId);
    const sub = task?.subtasks.find((s) => s.id === subId); if (!sub) return;
    const done = !sub.done;
    setTasks((ts) => ts && ts.map((t) => t.id === taskId ? { ...t, subtasks: t.subtasks.map((s) => s.id === subId ? { ...s, done } : s) } : t));
    store.setSubtaskDone(subId, done).catch(reportError);
  }, []);

  // a sub-task is a full task with parentId — it inherits the parent's project
  // (and therefore workspace) and assignee, and can be given its own due date,
  // priority, etc. just like any task.
  const addSubtask = useCallback((parentId: string, title: string) => {
    const parent = tasksRef.current?.find((t) => t.id === parentId);
    if (!parent) return;
    persistTask({
      id: "t-sub-" + Date.now() + "-" + Math.round(Math.random() * 1e6),
      title, description: "", status: "todo", priority: "medium",
      projectId: parent.projectId, assigneeId: parent.assigneeId || userIdRef.current,
      parentId, tags: [], dependencies: [], subtasks: [], comments: 0,
      aiScore: 50, aiReason: undefined, focusMin: 30, dur: 30, scheduled: null,
      planToday: false, recurrence: "none", dueDate: undefined, position: Date.now(),
    });
  }, [persistTask]);

  const createProject = useCallback((input: NewProject) => {
    // optimistic: show it immediately, reconcile/rollback with the server
    const tmpId = "tmp-proj-" + Date.now();
    const optimistic: Project = { id: tmpId, ...input };
    applyProjects([...projectsRef.current, optimistic]);
    store.createProject(input, userIdRef.current)
      .then((p) => applyProjects(projectsRef.current.map((x) => x.id === tmpId ? p : x)))
      .catch((e) => {
        reportError(e, { op: "createProject" });
        applyProjects(projectsRef.current.filter((x) => x.id !== tmpId));
        toastError("Couldn't save the project: " + (e?.message || e));
      });
  }, [applyProjects, toastError]);

  const updateProject = useCallback((id: string, patch: { description?: string; status?: string }) => {
    applyProjects(projectsRef.current.map((p) => p.id === id ? { ...p, ...patch } : p));
    store.updateProject(id, patch).catch(reportError);
  }, [applyProjects]);

  const confirmDeleteProject = useCallback((id: string, mode: DeleteMode, targetId?: string) => {
    if (id === "p-personal") { setDeleteProjectId(null); return; } // built-in default can't be deleted
    const affected = (tasksRef.current || []).filter((t) => t.projectId === id);
    if (mode === "reassign") {
      const target = targetId || "p-personal";
      // tasks live in their project's workspace — carry the target's workspace
      // so reassigned tasks don't keep a stale workspace and vanish from view
      const targetWs = getProject(target)?.workspaceId ?? null;
      setTasks((ts) => ts && ts.map((t) => t.projectId === id ? { ...t, projectId: target, workspaceId: targetWs } : t));
      noteWrite(affected.map((t) => t.id), { projectId: target, workspaceId: targetWs });
      affected.forEach((t) => store.updateTask(t.id, { projectId: target, workspaceId: targetWs }).catch(reportError));
    } else {
      setTasks((ts) => ts && ts.filter((t) => t.projectId !== id));
      noteDelete(affected.map((t) => t.id));
      affected.forEach((t) => store.deleteTask(t.id).catch(reportError));
    }
    applyProjects(projectsRef.current.filter((p) => p.id !== id));
    store.deleteProject(id).catch(reportError);
    setRouteRaw((r) => r.view === "project" && r.projectId === id ? { view: "tasks" } : r);
    setDeleteProjectId(null);
  }, [applyProjects, noteWrite, noteDelete]);

  // ---- sections (ordered groupings within a project) ----
  const createSection = useCallback((projectId: string, name: string) => {
    const wsId = getProject(projectId)?.workspaceId ?? null;
    const pos = Date.now();
    const tmp: Section = { id: "tmp-sec-" + Date.now(), projectId, workspaceId: wsId, name, position: pos };
    setSections((s) => [...s, tmp]);
    store.createSection({ projectId, workspaceId: wsId, name, position: pos }, userIdRef.current)
      .then((sec) => setSections((s) => s.map((x) => x.id === tmp.id ? sec : x)))
      .catch((e) => { reportError(e, { op: "createSection" }); setSections((s) => s.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the section: " + (e?.message || e)); });
  }, [toastError]);
  const renameSection = useCallback((id: string, name: string) => {
    setSections((s) => s.map((x) => x.id === id ? { ...x, name } : x));
    store.updateSection(id, { name }).catch(reportError);
  }, []);
  const deleteSection = useCallback((id: string) => {
    setSections((s) => s.filter((x) => x.id !== id));
    const affected = (tasksRef.current ?? []).filter((t) => t.sectionId === id || t.mySectionId === id);
    setTasks((ts) => ts && ts.map((t) => t.sectionId === id ? { ...t, sectionId: undefined } : t.mySectionId === id ? { ...t, mySectionId: undefined } : t));
    affected.forEach((t) => { const patch = t.sectionId === id ? { sectionId: undefined } : { mySectionId: undefined }; noteWrite(t.id, patch); store.updateTask(t.id, patch).catch(reportError); });
    store.deleteSection(id).catch(reportError);
  }, [noteWrite]);

  // ---- saved searches ----
  const saveSearch = useCallback((name: string, query: Record<string, unknown>) => {
    const tmp: SavedSearch = { id: "tmp-ss-" + Date.now(), name, query };
    setSavedSearches((s) => [...s, tmp]);
    store.createSavedSearch(name, query, userIdRef.current)
      .then((ss) => setSavedSearches((s) => s.map((x) => x.id === tmp.id ? ss : x)))
      .catch((e) => { reportError(e, { op: "saveSearch" }); setSavedSearches((s) => s.filter((x) => x.id !== tmp.id)); toastError("Couldn't save the search."); });
  }, [toastError]);
  const removeSavedSearch = useCallback((id: string) => {
    setSavedSearches((s) => s.filter((x) => x.id !== id));
    store.deleteSavedSearch(id).catch(reportError);
  }, []);

  // ---- goals / OKRs ----
  const createGoal = useCallback((name: string) => {
    const wsId = workspaceRef.current;
    const tmp: Goal = { id: "tmp-goal-" + Date.now(), workspaceId: wsId, name, status: "on_track", current: 0, target: 100 };
    setGoals((g) => [...g, tmp]);
    store.createGoal({ workspaceId: wsId, name, status: "on_track", current: 0, target: 100 }, userIdRef.current)
      .then((goal) => setGoals((g) => g.map((x) => x.id === tmp.id ? goal : x)))
      .catch((e) => { reportError(e, { op: "createGoal" }); setGoals((g) => g.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the goal: " + (e?.message || e)); });
  }, [toastError]);
  const updateGoal = useCallback((id: string, patch: Partial<Pick<Goal, "name" | "target" | "current" | "unit" | "due" | "status" | "parentId" | "projectId">>) => {
    setGoals((g) => g.map((x) => x.id === id ? { ...x, ...patch } : x));
    store.updateGoal(id, patch).catch(reportError);
  }, []);
  const deleteGoal = useCallback((id: string) => {
    setGoals((g) => g.filter((x) => x.id !== id));
    store.deleteGoal(id).catch(reportError);
  }, []);

  // ---- portfolios ----
  const createPortfolio = useCallback((name: string) => {
    const wsId = workspaceRef.current;
    const tmp: Portfolio = { id: "tmp-pf-" + Date.now(), workspaceId: wsId, name, projectIds: [] };
    setPortfolios((p) => [...p, tmp]);
    store.createPortfolio({ workspaceId: wsId, name }, userIdRef.current)
      .then((pf) => setPortfolios((p) => p.map((x) => x.id === tmp.id ? pf : x)))
      .catch((e) => { reportError(e, { op: "createPortfolio" }); setPortfolios((p) => p.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the portfolio: " + (e?.message || e)); });
  }, [toastError]);
  const updatePortfolio = useCallback((id: string, patch: { name?: string; projectIds?: string[] }) => {
    setPortfolios((p) => p.map((x) => x.id === id ? { ...x, ...patch } : x));
    store.updatePortfolio(id, patch).catch(reportError);
  }, []);
  const deletePortfolio = useCallback((id: string) => {
    setPortfolios((p) => p.filter((x) => x.id !== id));
    store.deletePortfolio(id).catch(reportError);
  }, []);

  // ---- project status updates ----
  const postStatusUpdate = useCallback((projectId: string, summary: string, status: StatusKind) => {
    const wsId = getProject(projectId)?.workspaceId ?? null;
    store.createStatusUpdate({ workspaceId: wsId, projectId, summary, status }, userIdRef.current)
      .then((su) => setStatusUpdates((s) => [su, ...s]))
      .catch((e) => { reportError(e, { op: "statusUpdate" }); toastError("Couldn't post the update."); });
  }, [toastError]);

  // ---- automation rules ----
  const createRule = useCallback((projectId: string, name: string, actions: AutomationAction[]) => {
    const wsId = getProject(projectId)?.workspaceId ?? null;
    const tmp: AutomationRule = { id: "tmp-rule-" + Date.now(), workspaceId: wsId, projectId, name, trigger: "task_created", actions, enabled: true };
    setAutomationRules((rs) => [...rs, tmp]);
    store.createRule({ workspaceId: wsId, projectId, name, actions }, userIdRef.current)
      .then((rule) => setAutomationRules((rs) => rs.map((x) => x.id === tmp.id ? rule : x)))
      .catch((e) => { reportError(e, { op: "createRule" }); setAutomationRules((rs) => rs.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the rule: " + (e?.message || e)); });
  }, [toastError]);
  const updateRule = useCallback((id: string, patch: { name?: string; actions?: AutomationAction[]; enabled?: boolean }) => {
    setAutomationRules((rs) => rs.map((x) => x.id === id ? { ...x, ...patch } : x));
    store.updateRule(id, patch).catch(reportError);
  }, []);
  const deleteRule = useCallback((id: string) => {
    setAutomationRules((rs) => rs.filter((x) => x.id !== id));
    store.deleteRule(id).catch(reportError);
  }, []);

  // ---- intake forms ----
  const createForm = useCallback((projectId: string, name: string, fields: FormFieldKey[]) => {
    const wsId = getProject(projectId)?.workspaceId ?? null;
    const tmp: FormDef = { id: "tmp-form-" + Date.now(), workspaceId: wsId, projectId, name, fields };
    setForms((fs) => [...fs, tmp]);
    store.createForm({ workspaceId: wsId, projectId, name, fields }, userIdRef.current)
      .then((form) => setForms((fs) => fs.map((x) => x.id === tmp.id ? form : x)))
      .catch((e) => { reportError(e, { op: "createForm" }); setForms((fs) => fs.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the form: " + (e?.message || e)); });
  }, [toastError]);
  const updateForm = useCallback((id: string, patch: { name?: string; fields?: FormFieldKey[] }) => {
    setForms((fs) => fs.map((x) => x.id === id ? { ...x, ...patch } : x));
    store.updateForm(id, patch).catch(reportError);
  }, []);
  const deleteForm = useCallback((id: string) => {
    setForms((fs) => fs.filter((x) => x.id !== id));
    store.deleteForm(id).catch(reportError);
  }, []);
  // a form submission becomes a task (and runs the project's automation rules)
  const submitForm = useCallback((projectId: string, vals: FormValues) => {
    createTask({
      id: "t-form-" + Date.now() + "-" + Math.round(Math.random() * 1e6),
      title: vals.title, description: vals.description ?? "", status: "todo", priority: (vals.priority as Task["priority"]) || "medium",
      projectId, assigneeId: vals.assigneeId || userIdRef.current, tags: [], dependencies: [], subtasks: [],
      comments: 0, aiScore: 50, aiReason: undefined, focusMin: 30, dur: 30, scheduled: null, planToday: false,
      recurrence: "none", dueDate: vals.dueDate || undefined, position: Date.now(),
    });
    toastSuccess("Submitted — task created");
  }, [createTask, toastSuccess]);

  // ---- custom fields (per-project definitions) ----
  const createCustomField = useCallback((projectId: string, name: string, type: CustomFieldDef["type"], options: string[] = []) => {
    const wsId = getProject(projectId)?.workspaceId ?? null;
    const tmp: CustomFieldDef = { id: "tmp-cf-" + Date.now(), projectId, workspaceId: wsId, name, type, options };
    setCustomFields((cs) => [...cs, tmp]);
    store.createCustomField({ projectId, workspaceId: wsId, name, type, options }, userIdRef.current)
      .then((def) => setCustomFields((cs) => cs.map((c) => c.id === tmp.id ? def : c)))
      .catch((e) => { reportError(e, { op: "createCustomField" }); setCustomFields((cs) => cs.filter((c) => c.id !== tmp.id)); toastError("Couldn't add the field: " + (e?.message || e)); });
  }, [toastError]);
  const deleteCustomField = useCallback((id: string) => {
    setCustomFields((cs) => cs.filter((c) => c.id !== id));
    store.deleteCustomField(id).catch(reportError);
  }, []);

  const createTag = useCallback((label: string, color: string) => {
    const tmpId = "tmp-tag-" + Date.now();
    applyTags({ ...tagsRef.current, [tmpId]: { label, color } });
    store.createTag(label, color, userIdRef.current)
      .then((tag) => {
        const next = { ...tagsRef.current };
        delete next[tmpId];
        next[tag.id] = { label: tag.label, color: tag.color };
        applyTags(next);
      })
      .catch((e) => {
        reportError(e, { op: "createTag" });
        const next = { ...tagsRef.current }; delete next[tmpId]; applyTags(next);
        toastError("Couldn't save the tag: " + (e?.message || e));
      });
  }, [applyTags, toastError]);

  const deleteTag = useCallback((id: string) => {
    // drop it from any tasks that use it, then remove the tag
    const cur = tasksRef.current || [];
    const affected = cur.filter((t) => t.tags.includes(id));
    if (affected.length) {
      setTasks((ts) => ts && ts.map((t) => t.tags.includes(id) ? { ...t, tags: t.tags.filter((x) => x !== id) } : t));
      affected.forEach((t) => store.updateTask(t.id, { tags: t.tags.filter((x) => x !== id) }).catch(reportError));
    }
    const next = { ...tagsRef.current }; delete next[id]; applyTags(next);
    store.deleteTag(id).catch(reportError);
  }, [applyTags]);

  const createWorkspace = useCallback((name: string) => {
    const me = getMember(userIdRef.current);
    store.createWorkspace(name, { id: userIdRef.current, email: me?.email || "", name: me?.name || "You" })
      .then((w) => {
        setWorkspaces((ws) => [...ws, w]);
        setWsMembers((m) => [...m, { id: "owner-" + w.id, workspaceId: w.id!, userId: userIdRef.current, email: me?.email || "", name: me?.name || "You", role: "owner", status: "active" }]);
        setReferenceData({ workspaces: [...workspacesRef.current, w] });
        setWorkspace(w.id);
        setRoute({ view: "team" });
      })
      .catch((e) => { reportError(e, { op: "createWorkspace" }); toastError("Couldn't create the workspace: " + (e?.message || e)); });
  }, [toastError]);

  const updateWorkspace = useCallback((workspaceId: string, name: string, logoUrl: string | null) => {
    const next = workspacesRef.current.map((w) => w.id === workspaceId ? { ...w, name, logoUrl: logoUrl ?? undefined } : w);
    setWorkspaces(next); setReferenceData({ workspaces: next });
    store.updateWorkspace(workspaceId, name, logoUrl).catch((e) => { reportError(e, { op: "updateWorkspace" }); toastError("Couldn't save workspace settings: " + (e?.message || e)); });
  }, [toastError]);

  const uploadWorkspaceLogo = useCallback(async (workspaceId: string, file: File) => {
    try {
      const url = await store.uploadWorkspaceLogo(workspaceId, file, userIdRef.current);
      const ws = workspacesRef.current.find((w) => w.id === workspaceId);
      updateWorkspace(workspaceId, ws?.name || "Workspace", url);
    } catch (e) { reportError(e, { op: "uploadWorkspaceLogo" }); toastError("Couldn't upload the logo: " + ((e as Error)?.message || e)); }
  }, [updateWorkspace, toastError]);

  const deleteWorkspace = useCallback((workspaceId: string) => {
    store.deleteWorkspace(workspaceId)
      .then(() => {
        const next = workspacesRef.current.filter((w) => w.id !== workspaceId);
        setWorkspaces(next); setReferenceData({ workspaces: next });
        setWsMembers((m) => m.filter((x) => x.workspaceId !== workspaceId));
        setWorkspace(null); setRoute({ view: "home" });
        toastSuccess("Workspace closed");
      })
      .catch((e) => { reportError(e, { op: "deleteWorkspace" }); toastError("Couldn't close the workspace: " + (e?.message || e)); });
  }, [toastError, toastSuccess]);

  const refreshWorkspaceMembers = useCallback(() => {
    store.listWorkspaceMembers().then(setWsMembers).catch((e) => reportError(e, { op: "refreshWorkspaceMembers" }));
  }, []);

  const inviteMember = useCallback((workspaceId: string, email: string, role: Role = "member") => {
    store.inviteMember(workspaceId, email, role)
      .then((m) => setWsMembers((xs) => [...xs.filter((x) => x.id !== m.id), m]))
      .catch((e) => { reportError(e, { op: "inviteMember" }); toastError("Couldn't send the invite: " + (e?.message || e)); });
  }, [toastError]);

  const removeMember = useCallback((memberId: string) => {
    setWsMembers((xs) => xs.filter((m) => m.id !== memberId));
    store.removeMember(memberId).catch((e) => { reportError(e, { op: "removeMember" }); toastError("Couldn't remove them: " + (e?.message || e)); refreshWorkspaceMembers(); });
  }, [toastError]);

  const setMemberRole = useCallback((memberId: string, role: Role) => {
    setWsMembers((xs) => xs.map((m) => m.id === memberId ? { ...m, role } : m));
    store.setMemberRole(memberId, role).catch((e) => { reportError(e, { op: "setMemberRole" }); toastError("Couldn't change the role: " + (e?.message || e)); refreshWorkspaceMembers(); });
  }, [toastError]);

  const transferOwnership = useCallback((workspaceId: string, memberId: string) => {
    store.transferOwnership(workspaceId, memberId)
      .then(() => { toastSuccess("Ownership transferred"); refreshWorkspaceMembers(); })
      .catch((e) => { reportError(e, { op: "transferOwnership" }); toastError("Couldn't transfer ownership: " + (e?.message || e)); });
  }, [toastError, toastSuccess]);

  // returning from Stripe checkout → refresh subscription + toast, clean the URL
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("billing");
    if (!p) return;
    if (p === "success") {
      store.getSubscription().then(setSubscription).catch(reportError);
      toastSuccess("You're all set — welcome to Kanbo.");
    }
    window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCheckout = useCallback(async (plan: Plan) => {
    setCheckoutBusy(plan);
    try {
      const seats = Math.max(1, wsMembers.filter((m) => m.status === "active").length || 1);
      const url = await store.startCheckout(plan, seats);
      if (url) window.location.href = url;
      else { toastError("Checkout isn't connected yet — deploy the Stripe functions to enable it."); setCheckoutBusy(null); }
    } catch (e) { reportError(e, { op: "startCheckout" }); toastError("Couldn't start checkout: " + ((e as Error)?.message || e)); setCheckoutBusy(null); }
  }, [wsMembers, toastError]);

  const manageBilling = useCallback(async () => {
    try {
      const url = await store.openBillingPortal();
      if (url) window.location.href = url;
      else toastError("Billing portal isn't connected yet.");
    } catch (e) { reportError(e, { op: "manageBilling" }); toastError("Couldn't open billing."); }
  }, [toastError]);

  // AI auto-prioritize: real LLM (Edge Function) with heuristic fallback
  const autoPrioritize = useCallback(async () => {
    const cur = tasksRef.current; if (!cur) return;
    setRouteRaw({ view: "tasks" }); setSmart(true); setSidebarOpen(false); setDetailId(null);
    setAiBusy(true);
    try {
      const scope = cur.filter((t) => (t.workspaceId ?? null) === workspaceRef.current);
      const res = await store.aiPrioritize(scope, toLocalISO(new Date()));
      const byId = new Map(res.items.map((i) => [i.id, i]));
      setTasks((ts) => ts && ts.map((t) => byId.has(t.id) ? { ...t, aiScore: byId.get(t.id)!.score, aiReason: byId.get(t.id)!.reason } : t));
      res.items.forEach((i) => store.updateTask(i.id, { aiScore: i.score, aiReason: i.reason }).catch(() => {}));
      toastSuccess((res.source === "ai" ? "✨ " : "") + res.summary);
    } catch (e) {
      reportError(e, { op: "autoPrioritize" });
      toastError("Couldn't prioritize right now.");
    } finally { setAiBusy(false); }
  }, [toastSuccess, toastError]);

  const openNewTask = useCallback((status: Status = "todo") => {
    const r = routeRef.current;
    // creating a task while viewing a project drops it into that project
    setNewTaskProjectId(r.view === "project" ? r.projectId : undefined);
    setNewTaskStatus(status); setNewTaskOpen(true);
  }, []);

  const openFocus = () => { focus.setRunning(true); setFocusOpen(true); };
  const focusTask = (id: string) => { focus.setTaskId(id); setDetailId(null); setFocusOpen(true); focus.setRunning(true); };

  // ---- auth / loading gates ----
  if (auth.recovery) return <UpdatePasswordScreen />;
  if (auth.configured && !auth.user) return <PublicSite />;
  if (auth.loading || tasks === null) return <FullLoader />;
  // Early-access gate: a brand-new account stays in a waiting room until an admin
  // approves it. Fail-open — only blocks when we KNOW approved === false, never on
  // a load hiccup, and the admin is always let through.
  if (auth.configured && profile && profile.approved === false && (auth.user?.email ?? "") !== "danchappell7@gmail.com") {
    return <PendingApproval email={auth.user?.email} onSignOut={auth.signOut} />;
  }
  if (subscription && !hasAccess(subscription)) {
    const seats = Math.max(1, wsMembers.filter((m) => m.status === "active").length || 1);
    return <Paywall sub={subscription} seats={seats} busyPlan={checkoutBusy} onChoose={startCheckout} onSignOut={auth.configured ? auth.signOut : undefined} />;
  }

  // scope everything to the active workspace
  const allTasks = tasks.filter((t) => (t.workspaceId ?? null) === workspace && !t.archivedAt);
  const archivedTasks = tasks.filter((t) => (t.workspaceId ?? null) === workspace && !!t.archivedAt);

  const activeWsName = workspaces.find((w) => w.id === workspace)?.name || "Personal";

  // scope tasks by route
  let scoped = allTasks, title = "My tasks", subtitle = "Everything assigned to you", breadcrumb = activeWsName;
  let newProj = getProject("");
  // "My tasks" stays within the workspace you're viewing — your personal tasks
  // never mix with a team workspace's, and vice versa. (allTasks is already
  // scoped to the active workspace + non-archived.)
  if (route.view === "tasks") { scoped = allTasks.filter((t) => t.assigneeId === currentUserId || (t.collaborators ?? []).includes(currentUserId)); }
  else if (route.view === "project" && route.projectId) {
    const p = getProject(route.projectId); newProj = p;
    scoped = allTasks.filter((t) => t.projectId === route.projectId);
    // count top-level tasks (sub-tasks nest under them) so the number matches the rows
    const topCount = scoped.filter((t) => !t.parentId).length;
    title = p?.name || "Project"; subtitle = topCount + " task" + (topCount === 1 ? "" : "s") + " · " + projectProgress(allTasks, route.projectId) + "% complete";
    breadcrumb = workspaces.find((w) => w.id === (p?.workspaceId ?? null))?.name || "Personal";
  }
  const wsProjects = projects.filter((p) => (p.workspaceId ?? null) === workspace);
  // people you can assign/tag: active members of the ACTIVE workspace only.
  // Personal (workspace === null) has no member rows, so it resolves to just you —
  // you can never tag someone from another workspace.
  const assignees = (() => {
    const active = wsMembers.filter((m) => m.status === "active" && m.userId && (m.workspaceId ?? null) === workspace).map((m) => ({ id: m.userId!, name: m.name || m.email }));
    return active.length > 0 ? active : [{ id: currentUserId, name: getMember(currentUserId)?.name || "You" }];
  })();

  const inboxCount = activity.filter((a) => !a.readAt && new Date(a.createdAt).getTime() > inboxSeenAt).length;
  const currentUser = getMember(currentUserId);
  const firstName = currentUser?.name?.trim().split(/\s+/)[0] || "there";
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const monthLabel = new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const renderMain = () => {
    switch (route.view) {
      case "plan": return <PlanView tasks={allTasks} onUpdate={patchTask} onCreate={createTask} onOpen={setDetailId} externalEvents={calEvents} calendarConnected={calConnections.length > 0} />;
      case "myweek": return <MyWeekView tasks={allTasks.filter((t) => t.assigneeId === currentUserId || (t.collaborators ?? []).includes(currentUserId))} onOpen={setDetailId} onPatch={patchTask} />;
      case "home": return <HomeView tasks={allTasks} projects={wsProjects} userName={currentUser?.name} onOpen={setDetailId} setRoute={setRoute} openFocus={openFocus} onNewProject={() => setNewProjectOpen(true)} onNewTask={() => openNewTask()} onAutoPrioritize={autoPrioritize} aiBusy={aiBusy} calendarConnected={calConnections.length > 0} hasTeam={workspaces.some((w) => w.id !== null)} />;
      case "analytics": return <AnalyticsView tasks={allTasks} customFields={customFields} />;
      case "search": return <SearchView tasks={tasks} projects={projects} members={assignees} onOpen={setDetailId} savedSearches={savedSearches} onSaveSearch={saveSearch} onDeleteSavedSearch={removeSavedSearch} />;
      case "workload": return <WorkloadView tasks={allTasks} members={assignees} onOpen={setDetailId} />;
      case "goals": return <GoalsView goals={goals.filter((g) => (g.workspaceId ?? null) === workspace)} projects={wsProjects} tasks={allTasks} onCreate={createGoal} onUpdate={updateGoal} onDelete={deleteGoal} />;
      case "portfolios": return <PortfoliosView portfolios={portfolios.filter((p) => (p.workspaceId ?? null) === workspace)} projects={wsProjects} tasks={allTasks} onCreate={createPortfolio} onUpdate={updatePortfolio} onDelete={deletePortfolio} onOpenProject={(pid) => setRoute({ view: "project", projectId: pid })} />;
      case "automations": return <AutomationsView rules={automationRules.filter((r) => wsProjects.some((p) => p.id === r.projectId))} projects={wsProjects} members={assignees} sections={sections} onCreate={createRule} onUpdate={updateRule} onDelete={deleteRule} />;
      case "forms": return <FormsView forms={forms.filter((f) => wsProjects.some((p) => p.id === f.projectId))} projects={wsProjects} members={assignees} onCreate={createForm} onUpdate={updateForm} onDelete={deleteForm} onSubmit={submitForm} />;
      case "inbox": return <InboxView activity={activity} tasks={allTasks} onOpen={setDetailId} onArchive={archiveActivity} onClearAll={clearInbox} />;
      case "calendar": return <CalendarView tasks={allTasks} onOpen={setDetailId} onPatch={patchTask} connections={calConnections} externalEvents={calEvents} onConnect={connectCalendar} onDisconnect={disconnectCalendar} syncing={calSyncing} />;
      case "team": return <TeamView tasks={allTasks} workspace={workspace} workspaces={workspaces} members={wsMembers} currentUserId={currentUserId} myRole={wsMembers.find((m) => m.userId === currentUserId && (m.workspaceId ?? null) === workspace && m.status === "active")?.role} onInvite={inviteMember} onRemoveMember={removeMember} onSetRole={setMemberRole} onTransferOwnership={transferOwnership} onOpen={setDetailId} onNewWorkspace={() => setNewWorkspaceOpen(true)} onUpdateWorkspace={updateWorkspace} onUploadLogo={uploadWorkspaceLogo} onDeleteWorkspace={deleteWorkspace} />;
      case "tasks":
      case "project":
        return <TasksPage tasks={scoped} allTasks={allTasks} projects={wsProjects} view={view} setView={setView} groupBy={groupBy} setGroupBy={setGroupBy} smart={smart} setSmart={setSmart} onOpen={setDetailId} onToggle={toggleTask} onToggleSubtask={toggleSubtask} onAdd={openNewTask} onMove={(id, status, position) => {
          const patch: Partial<Task> = { status, completedAt: status === "done" ? toLocalISO(new Date()) : undefined };
          if (position !== undefined) patch.position = position;
          patchTask(id, patch);
        }} onBulkPatch={bulkPatch} onBulkDelete={bulkDelete} onPatch={patchTask} onQuickAdd={quickAddTask} members={assignees} allTags={tags}
          archivedTasks={archivedTasks}
          sections={route.view === "tasks" ? sections.filter((s) => s.projectId === "__my") : (route.view === "project" && route.projectId ? sections.filter((s) => s.projectId === route.projectId) : sections)}
          onCreateSection={createSection} onRenameSection={renameSection} onDeleteSection={deleteSection}
          sectionField={route.view === "tasks" ? "mySectionId" : "sectionId"}
          sectionProjectId={route.view === "tasks" ? "__my" : route.projectId}
          customFields={route.view === "project" && route.projectId ? customFields.filter((f) => f.projectId === route.projectId) : customFields}
          header={route.view === "project" && newProj && newProj.id !== "p-personal" ? <ProjectOverview project={newProj} tasks={scoped} onUpdate={updateProject} statusUpdates={statusUpdates} onPostStatus={postStatusUpdate} /> : undefined} />;
      default: return null;
    }
  };

  const headerMap: Record<Route["view"], { title: string; subtitle: string; breadcrumb: string }> = {
    plan: { title: `${greet}, ${firstName}`, subtitle: "Here's your day.", breadcrumb: "Plan" },
    myweek: { title: "My week", subtitle: "Plan the week and clear what slipped.", breadcrumb: "Plan" },
    home: { title: "Home", subtitle: "A focused look at what's moving today.", breadcrumb: "Today" },
    analytics: { title: "Analytics", subtitle: "Your throughput, measured.", breadcrumb: "Insights" },
    inbox: { title: "Inbox", subtitle: "Mentions, assignments, and updates.", breadcrumb: "Notifications" },
    calendar: { title: "Calendar", subtitle: monthLabel, breadcrumb: "Schedule" },
    team: { title: "Team", subtitle: "Who's working on what.", breadcrumb: "People" },
    search: { title: "Search", subtitle: "Find anything across your tasks.", breadcrumb: "Search" },
    workload: { title: "Workload", subtitle: "Capacity across your team.", breadcrumb: "Reporting" },
    goals: { title: "Goals", subtitle: "Objectives and their progress.", breadcrumb: "Reporting" },
    portfolios: { title: "Portfolios", subtitle: "Projects, rolled up.", breadcrumb: "Reporting" },
    automations: { title: "Automations", subtitle: "Rules that run on new tasks.", breadcrumb: "Reporting" },
    forms: { title: "Forms", subtitle: "Capture requests as tasks.", breadcrumb: "Intake" },
    tasks: { title, subtitle, breadcrumb },
    project: { title, subtitle, breadcrumb },
  };
  const headerProps = headerMap[route.view];

  const sidebar = (
    <Sidebar route={route} setRoute={setRoute} workspace={workspace} setWorkspace={setWorkspace} workspaces={workspaces} onNewWorkspace={() => setNewWorkspaceOpen(true)} focus={focus} openFocus={openFocus} tasks={allTasks} projects={projects} inboxCount={inboxCount}
      currentUserId={currentUserId} currentUser={currentUser} onSignOut={auth.configured ? auth.signOut : undefined} onOpenSettings={() => setSettingsOpen(true)} onNewProject={() => setNewProjectOpen(true)} onDeleteProject={(id) => setDeleteProjectId(id)}
      subscription={subscription} onUpgrade={() => setUpgradeOpen(true)} onManageBilling={manageBilling} />
  );

  return (
    <div style={{ position: "relative", height: "100vh", display: "flex", overflow: "hidden" }}>
      <div className="app-bg" /><div className="app-grid" />
      <GlobalTipStyles />
      {isMobile ? (
        <>
          {sidebarOpen && <div aria-hidden="true" onClick={() => setSidebarOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 49, background: "color-mix(in oklch, var(--bg-deep) 50%, transparent)", backdropFilter: "blur(2px)" }} />}
          <div role="dialog" aria-modal="true" aria-label="Menu" aria-hidden={!sidebarOpen} style={{ position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 50, transform: sidebarOpen ? "none" : "translateX(-100%)", transition: "transform .25s var(--ease)", boxShadow: sidebarOpen ? "var(--shadow-lg)" : "none" }}>
            {sidebar}
          </div>
        </>
      ) : sidebar}
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative", zIndex: 1 }}>
        {BILLING_ENABLED && subscription?.status === "trialing" && <TrialBanner sub={subscription} onUpgrade={() => setUpgradeOpen(true)} />}
        <Topbar {...headerProps} theme={theme} toggleTheme={() => setTheme((t) => t === "dark" ? "light" : "dark")}
          hasUnread={inboxCount > 0} onMenu={isMobile ? () => setSidebarOpen(true) : undefined}
          onNewTask={() => openNewTask()} onNewProject={() => setNewProjectOpen(true)} onCommand={() => setCmdOpen(true)} onBell={() => setRoute({ view: "inbox" })}>
          {(route.view === "project") && newProj && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "0 4px" }}>
              <span style={{ fontSize: 22 }}>{newProj.emoji}</span>
            </span>
          )}
        </Topbar>
        {renderMain()}
        {isMobile && <MobileNav route={route} setRoute={setRoute} inboxCount={inboxCount} />}
      </main>

      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} tasks={allTasks} onOpenTask={setDetailId} onAction={(s) => {
        if (s.id === "new-task") openNewTask();
        else if (s.id === "prioritize") autoPrioritize();
        else if (s.id === "focus") openFocus();
        else if (s.id === "board") { setRoute({ view: "tasks" }); setView("board"); }
      }} onNavigate={(v) => setRoute({ view: v as Route["view"] })} />
      {shortcutsOpen && (
        <div onClick={() => setShortcutsOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 200, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}>
          <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="glass anim-scalein" style={{ width: 440, maxWidth: "94vw", borderRadius: 18, padding: 22, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
              <Icon name="command" size={18} style={{ color: "var(--accent)" }} />
              <h2 style={{ fontSize: 17, fontWeight: 600 }}>Keyboard shortcuts</h2>
              <button onClick={() => setShortcutsOpen(false)} className="btn-icon" aria-label="Close" style={{ marginLeft: "auto", border: "none" }}><Icon name="x" size={16} /></button>
            </div>
            {([["⌘K · Ctrl+K", "Command palette"], ["c", "New task"], ["/", "Search"], ["g then h", "Home"], ["g then p", "Plan my day"], ["g then i", "Inbox"], ["g then t", "My tasks"], ["g then c", "Calendar"], ["g then s", "Search"], ["g then a", "Analytics"], ["?", "This help"], ["Esc", "Close / dismiss"]] as [string, string][]).map(([k, d]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", padding: "7px 0", borderTop: "1px solid var(--hairline)" }}>
                <span style={{ flex: 1, fontSize: 13.5, color: "var(--ink-2)" }}>{d}</span>
                <kbd className="mono" style={{ fontSize: 11.5, padding: "2px 8px", borderRadius: 6, background: "var(--surface-2)", border: "1px solid var(--hairline)", color: "var(--ink-3)" }}>{k}</kbd>
              </div>
            ))}
          </div>
        </div>
      )}
      {detailId && <TaskDetail taskId={detailId} tasks={tasks} tags={tags} activity={activity} members={wsMembers} currentUserId={currentUserId} onClose={() => setDetailId(null)} onOpenTask={setDetailId} projects={projects} onToggle={toggleTask} onPatch={patchTask} onDelete={deleteTask} onDuplicate={duplicateTask} onArchive={archiveTask} onUnarchive={unarchiveTask} onToggleSubtask={toggleSubtask} onAddSubtask={addSubtask} onCreateTag={createTag} onDeleteTag={deleteTag} onAddComment={addComment} onFocus={focusTask} onAddDependency={addDependency} onRemoveDependency={removeDependency} onToggleFollow={toggleFollow} onToggleTaskReaction={toggleTaskReaction} onToggleCollaborator={toggleCollaborator} customFields={customFields.filter((f) => f.projectId === (tasks.find((t) => t.id === detailId)?.projectId))} onCreateCustomField={createCustomField} onDeleteCustomField={deleteCustomField} sections={sections.filter((s) => s.projectId === (tasks.find((t) => t.id === detailId)?.projectId))} onCreateSection={createSection} onConvertComment={(body, pid) => { quickAddTask({ title: body.slice(0, 200), projectId: pid }); toastSuccess("Comment added as a task"); }} />}
      {focusOpen && <FocusMode focus={focus} tasks={allTasks} onClose={() => setFocusOpen(false)} onOpenTask={(id) => { setFocusOpen(false); setDetailId(id); }} />}
      <NewTaskModal open={newTaskOpen} onClose={() => setNewTaskOpen(false)} onCreate={createTask} onCreateTag={createTag} onDeleteTag={deleteTag} projects={wsProjects} allTags={tags} members={wsMembers} currentUserId={currentUserId} defaultStatus={newTaskStatus} defaultProjectId={newTaskProjectId} />
      <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} onCreate={createProject} workspaceId={workspace} />
      <NewWorkspaceModal open={newWorkspaceOpen} onClose={() => setNewWorkspaceOpen(false)} onCreate={createWorkspace} />
      <WelcomeModal open={welcomeOpen} onClose={dismissWelcome}
        canSkip={!!((profile?.firstName?.trim()) || (profile?.lastName?.trim()))}
        onSaveProfile={(firstName, lastName) => saveProfile({ firstName, lastName, pronouns: profile?.pronouns ?? "", avatarUrl: profile?.avatarUrl ?? null })}
        name={currentUser?.name && !currentUser.name.includes("@") ? currentUser.name : undefined}
        initialFirst={profile?.firstName ?? ""} initialLast={profile?.lastName ?? ""} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)}
        initial={{ firstName: profile?.firstName ?? "", lastName: profile?.lastName ?? "", pronouns: profile?.pronouns ?? "", avatarUrl: profile?.avatarUrl ?? null }}
        email={auth.user?.email ?? currentUser?.email ?? ""} color={currentUser?.color ?? "oklch(0.585 0.196 264)"}
        onUpload={uploadAvatar} onSave={saveProfile} onExport={exportData} onDeleteAccount={deleteAccount} />
      <UpgradeModal open={upgradeOpen} onClose={() => setUpgradeOpen(false)} seats={Math.max(1, wsMembers.filter((m) => m.status === "active").length || 1)} busyPlan={checkoutBusy} onChoose={startCheckout} />
      {deleteProjectId && (() => {
        const proj = getProject(deleteProjectId);
        if (!proj) return null;
        return <DeleteProjectModal project={proj} taskCount={allTasks.filter((t) => t.projectId === deleteProjectId).length} projects={projects}
          onConfirm={(mode, target) => confirmDeleteProject(deleteProjectId, mode, target)} onClose={() => setDeleteProjectId(null)} />;
      })()}
    </div>
  );
}

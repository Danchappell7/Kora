/* ============================================================
   KANBO — App shell: auth gate, store-backed state, routing,
   timer, tasks page
   ============================================================ */
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Icon, Avatar, StatusDot, Segmented, GlobalTipStyles, EmojiPicker, type SegmentedOption, AppBg, Collapse } from "./components/primitives";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { CommandPalette } from "./components/CommandPalette";
import { NewTaskModal } from "./components/NewTaskModal";
import { NewProjectModal } from "./components/NewProjectModal";
import { NewWorkspaceModal } from "./components/NewWorkspaceModal";
import { DeleteProjectModal, type DeleteMode } from "./components/DeleteProjectModal";
import { SettingsModal, type ThemeChoice } from "./components/SettingsModal";
import { MobileNav } from "./components/MobileNav";
import { WelcomeModal } from "./components/WelcomeModal";
import { TrialBanner, UpgradeModal, Paywall, hasAccess, BILLING_ENABLED } from "./components/Billing";
import { ImportTasksModal, type ImportRow } from "./components/ImportTasksModal";
import { exportTasksCsv, printTasks, type TaskExportOptions } from "./lib/exportTasks";
import { OnboardingModal } from "./components/OnboardingModal";
import { TagManagerModal } from "./components/TagManagerModal";
import { TAG_COLORS } from "./components/TagPicker";
import { ListView } from "./components/tasks/ListView";
import { BoardView, TimelineView, CalendarView, FilesView, MatrixView } from "./components/tasks/OtherViews";
import { PlanView } from "./components/views/PlanView";
import { MyWeekView } from "./components/views/MyWeekView";
import { HomeView } from "./components/views/HomeView";
import { AnalyticsView } from "./components/views/AnalyticsView";
import { ReportsView } from "./components/views/ReportsView";
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
import { store, keepOnScreen, getStrippedColumns, type NewProject, type AppBanner, type Bootstrap, type RealtimeChange } from "./data/store";
import { offlineQueue, type DeadLetter } from "./lib/offlineQueue";
import { DAY_CHANGE_EVENT } from "./lib/liveClock";
import { canArchiveProject } from "./lib/permissions";
import { BUILTIN_PROJECT_TEMPLATES, projectTemplateTasks } from "./lib/templates";
import { resolveTagId } from "./components/views/reportingUtils";
import { loadAppearance, saveAppearance, type Appearance } from "./lib/appearance";
import { QuickCapture } from "./components/QuickCapture";
import { SMART_LISTS, smartListQuery } from "./lib/smartLists";
import { taskMatchesQuery, toQuery } from "./lib/searchQuery";
import {
  STATUS_META, getProject, getMember, setReferenceData, toLocalISO, MEMBERS, dueState, KANBO_TODAY, energyOf, SELF_COLOR,
} from "./data/data";
import type { ProfileDraft } from "./components/SettingsModal";
import type { Task, Subtask, Project, Workspace, WorkspaceMember, Role, TagDef, Comment, Activity, ActivityKind, Subscription, Plan, Status, Profile, CalProvider, CalendarConnection, ExternalEvent, Section, CustomFieldDef, SavedSearch, Goal, Portfolio, StatusUpdate, StatusKind, AutomationRule, AutomationAction, FormDef, FormFieldKey } from "./data/types";
import type { Route, TaskView, GroupBy } from "./app-types";
import {
  newTaskId, isTaskId, descendantsOf, parentsFirst, runLimited, createLimiter, swapTmp, keepTmp, statusTransition, buildRecurrence,
  unseenCreates, reloadProjects, reloadWorkspaces,
  cloneTaskTree, pickFields, topLevelProgress, pickStartWorkspace, lastWorkspaceKey, readFilters, validFilters, filtersKey, EMPTY_FILTERS, type TaskFilters, type Limiter,
} from "./lib/taskOps";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const GUEST_MSG = "Guests can view and comment — ask a workspace admin for member access";
// activity the signed-in user wrote about their own actions — history, not notifications
const SELF_KINDS = new Set<ActivityKind>(["created", "status", "completed", "reopened", "deleted"]);

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

/** "today", "yesterday", "3 days ago", or a date — for status-update freshness. */
function relDay(iso: string): { label: string; days: number } {
  const then = new Date(iso); const now = new Date();
  const days = Math.max(0, Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / 86400000));
  const label = days === 0 ? "today" : days === 1 ? "yesterday" : days < 14 ? `${days} days ago` : then.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: then.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  return { label, days };
}

function ProjectOverview({ project, tasks: allProjectTasks, onUpdate, statusUpdates = [], onPostStatus, members = [], canManagePeople = false, onDuplicate, onArchive }: { project: Project; tasks: Task[]; onUpdate: (id: string, patch: { name?: string; emoji?: string; color?: string; description?: string; status?: string; ownerId?: string | null; contributorIds?: string[] }) => void; statusUpdates?: StatusUpdate[]; onPostStatus?: (projectId: string, summary: string, status: StatusKind) => Promise<boolean> | void; members?: { id: string; name: string }[]; canManagePeople?: boolean; onDuplicate?: (projectId: string) => void; onArchive?: (projectId: string) => void }) {
  // progress and the task count are top-level tasks, like the page header (sub-tasks nest
  // under their parent); what needs attention — overdue, due soon, blocked — counts every
  // task, sub-tasks included, because that's real work that's late or stuck
  const tasks = allProjectTasks.filter((t) => !t.parentId);
  const [statusOpen, setStatusOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(project.name);
  const [emojiDraft, setEmojiDraft] = useState(project.emoji);
  useEffect(() => { setNameDraft(project.name); setEmojiDraft(project.emoji); setEditOpen(false); setEmojiPickerOpen(false); }, [project.id, project.name, project.emoji]);
  const PROJECT_PALETTE = ["oklch(0.74 0.14 230)", "oklch(0.74 0.16 305)", "oklch(0.75 0.13 155)", "oklch(0.78 0.15 70)", "oklch(0.66 0.2 20)", "oklch(0.78 0.1 45)"];
  const [descEditing, setDescEditing] = useState(false);
  const [descDraft, setDescDraft] = useState(project.description || "");
  const [updOpen, setUpdOpen] = useState(false);
  const [updText, setUpdText] = useState("");
  const [updKind, setUpdKind] = useState<StatusKind>("on_track");
  const [posting, setPosting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = statusUpdates.filter((s) => s.projectId === project.id);
  const latest = history[0];
  const latestAge = latest ? relDay(latest.createdAt) : null;
  const stale = !!latestAge && latestAge.days > 14;
  // keep the draft until the update is actually saved
  const postUpd = () => {
    const v = updText.trim(); if (!v || !onPostStatus || posting) return;
    const r = onPostStatus(project.id, v, updKind);
    if (r && typeof (r as Promise<boolean>).then === "function") {
      setPosting(true);
      (r as Promise<boolean>).then((ok) => { setPosting(false); if (ok) { setUpdText(""); setUpdOpen(false); } });
    } else { setUpdText(""); setUpdOpen(false); }
  };
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const prog = total ? Math.round((done / total) * 100) : 0;
  const todayMid = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate()).getTime();
  const dueSoon = allProjectTasks.filter((t) => t.status !== "done" && t.dueDate && (() => { const d = new Date(t.dueDate + "T00:00:00").getTime(); return d <= todayMid + 7 * 86400000; })()).length;
  // auto-computed RAG health — complements the manually-set project phase
  const overdue = allProjectTasks.filter((t) => t.status !== "done" && t.dueDate && new Date(t.dueDate + "T00:00:00").getTime() < todayMid).length;
  const blockedCount = allProjectTasks.filter((t) => t.status === "blocked").length;
  const health = (() => {
    if (total === 0) return null;
    const bits: string[] = [];
    if (overdue) bits.push(`${overdue} overdue`);
    if (blockedCount) bits.push(`${blockedCount} blocked`);
    const detail = bits.length ? bits.join(" · ") : "nothing overdue or blocked";
    if (prog === 100) return { label: "Complete", color: "var(--st-done)", detail: "all tasks done" };
    if (overdue >= 3 || overdue / allProjectTasks.length > 0.25 || (overdue >= 1 && blockedCount >= 2)) return { label: "Off track", color: "var(--prio-urgent)", detail };
    if (overdue >= 1 || blockedCount >= 1) return { label: "At risk", color: "var(--st-review)", detail };
    return { label: "On track", color: "var(--st-done)", detail };
  })();
  const byStatus = (["todo", "progress", "review", "blocked", "done"] as Status[]).map((s) => ({ s, n: tasks.filter((t) => t.status === s).length })).filter((x) => x.n > 0);
  const printReport = () => {
    const w = window.open("", "_blank"); if (!w) return;
    const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
    // every task, each sub-task listed under its parent
    const kids = new Map<string, Task[]>();
    allProjectTasks.forEach((t) => { if (t.parentId) { const l = kids.get(t.parentId); if (l) l.push(t); else kids.set(t.parentId, [t]); } });
    const ordered: { t: Task; depth: number }[] = [];
    const seen = new Set<string>();
    const walk = (t: Task, depth: number) => { if (seen.has(t.id)) return; seen.add(t.id); ordered.push({ t, depth }); (kids.get(t.id) ?? []).forEach((k) => walk(k, depth + 1)); };
    [...tasks].sort((a, b) => a.status.localeCompare(b.status)).forEach((t) => walk(t, 0));
    allProjectTasks.forEach((t) => walk(t, 0)); // a sub-task whose parent isn't in this list
    const rows = ordered.map(({ t, depth }) => `<tr><td style="padding-left:${8 + Math.min(depth, 4) * 16}px">${depth ? "↳ " : ""}${esc(t.title)}</td><td>${esc(STATUS_META[t.status].label)}</td><td>${esc(t.priority)}</td><td>${esc(t.dueDate || "")}</td><td>${esc(getMember(t.assigneeId)?.name || "")}</td></tr>`).join("");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(project.name)} — report</title><style>body{font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;padding:32px;max-width:900px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin:0 0 20px}.bar{height:10px;background:#eee;border-radius:6px;overflow:hidden;margin:8px 0 20px}.bar>div{height:100%;background:#6a5cff;width:${prog}%}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #eee}th{color:#888;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}@media print{.noprint{display:none}}</style></head><body><h1>${esc(project.emoji)} ${esc(project.name)}</h1><p class="sub">${total} tasks · ${prog}% complete · ${esc(new Date().toLocaleDateString())}</p><div class="bar"><div></div></div><table><thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Due</th><th>Assignee</th></tr></thead><tbody>${rows}</tbody></table><p class="noprint" style="margin-top:24px;color:#888;font-size:12px">Use your browser's Print dialog to save as PDF.</p></body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  };
  const curStatus = PROJECT_STATUSES.find((s) => s.v === project.status);
  return (
    <div className="glass" style={{ margin: "14px 24px 0", padding: "16px 18px", borderRadius: 16, display: "flex", flexDirection: "column", gap: 12 }}>
     <div style={{ display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 180 }}>
        <div style={{ position: "relative" }}>
          <button onClick={() => canManagePeople && setEditOpen((v) => !v)} title={canManagePeople ? "Edit project" : undefined}
            style={{ width: 40, height: 40, borderRadius: 11, display: "grid", placeItems: "center", fontSize: 20, background: `color-mix(in oklch, ${project.color} 18%, transparent)`, border: `1px solid color-mix(in oklch, ${project.color} 32%, transparent)`, cursor: canManagePeople ? "pointer" : "default", padding: 0 }}>{project.emoji}</button>
          {editOpen && canManagePeople && (
            <>
              <div onClick={() => setEditOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
              <div className="glass anim-scalein" style={{ position: "absolute", top: "calc(100% + 8px)", left: 0, zIndex: 31, width: 280, padding: 14, borderRadius: 14, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", gap: 12 }}>
                <div className="kicker">Edit project</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setEmojiPickerOpen((v) => !v)} title="Choose icon" aria-label="Project icon"
                    style={{ width: 46, height: 38, textAlign: "center", fontSize: 19, borderRadius: 9, border: emojiPickerOpen ? "1px solid var(--accent)" : "1px solid var(--hairline)", background: "var(--surface)", cursor: "pointer" }}>{emojiDraft}</button>
                  <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && nameDraft.trim()) { onUpdate(project.id, { name: nameDraft.trim() }); setEditOpen(false); } }} onBlur={() => { if (nameDraft.trim() && nameDraft.trim() !== project.name) onUpdate(project.id, { name: nameDraft.trim() }); }} aria-label="Project name"
                    style={{ flex: 1, height: 38, padding: "0 11px", borderRadius: 9, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14, outline: "none" }} />
                </div>
                {emojiPickerOpen && <EmojiPicker width={252} height={180} onPick={(e) => { setEmojiDraft(e); onUpdate(project.id, { emoji: e }); setEmojiPickerOpen(false); }} />}
                <div>
                  <div className="kicker" style={{ marginBottom: 7 }}>Colour</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {PROJECT_PALETTE.map((c) => (
                      <button key={c} onClick={() => onUpdate(project.id, { color: c })} aria-label="Set colour"
                        style={{ width: 26, height: 26, borderRadius: 8, background: c, border: project.color === c ? "2px solid var(--ink)" : "2px solid transparent", cursor: "pointer" }} />
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
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
        <div style={{ height: 7, borderRadius: 99, background: "var(--track, var(--surface-2))", overflow: "hidden" }}><div style={{ width: prog + "%", height: "100%", borderRadius: 99, background: project.color, transition: "width .9s var(--ease)" }} /></div>
        <div style={{ display: "flex", gap: 12, marginTop: 9, flexWrap: "wrap" }}>
          {byStatus.map(({ s, n }) => (
            <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--ink-3)" }}><StatusDot status={s} size={7} />{STATUS_META[s].label} <span className="mono" style={{ color: "var(--ink-4)" }}>{n}</span></span>
          ))}
        </div>
      </div>
      {(() => {
        const ownerId = project.ownerId ?? null;
        const ownerName = ownerId ? (members.find((m) => m.id === ownerId)?.name || getMember(ownerId)?.name || "Owner") : null;
        const contribIds = (project.contributorIds ?? []).filter((id) => id !== ownerId);
        const toggleContrib = (id: string) => {
          const set = new Set(contribIds);
          set.has(id) ? set.delete(id) : set.add(id);
          onUpdate(project.id, { contributorIds: [...set] });
        };
        return (
          <div style={{ position: "relative" }}>
            <div className="kicker" style={{ marginBottom: 6 }}>Owner & contributors</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {/* owner */}
              <div style={{ display: "flex", alignItems: "center", gap: 7 }} title={ownerName ? `Owner: ${ownerName}` : "No owner"}>
                {ownerId ? <Avatar id={ownerId} size={28} /> : <span style={{ width: 28, height: 28, borderRadius: 99, display: "grid", placeItems: "center", background: "var(--surface-2)", border: "1px dashed var(--hairline-strong)", color: "var(--ink-4)" }}><Icon name="user" size={14} /></span>}
                <span style={{ fontSize: 12.5, color: "var(--ink-2)" }} className="truncate">{ownerName || "Set owner"}<span style={{ color: "var(--ink-4)", fontSize: 11 }}> · owner</span></span>
              </div>
              {/* contributors stack */}
              {contribIds.length > 0 && <div style={{ display: "flex", marginLeft: 4 }}>{contribIds.slice(0, 6).map((id, i) => <span key={id} title={members.find((m) => m.id === id)?.name || getMember(id)?.name} style={{ marginLeft: i ? -8 : 0, borderRadius: 99, boxShadow: "0 0 0 2px var(--surface-raised)" }}><Avatar id={id} size={28} /></span>)}</div>}
              {canManagePeople && <button onClick={() => setPeopleOpen((v) => !v)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12 }}><Icon name="users" size={13} /> Manage</button>}
            </div>
            {peopleOpen && canManagePeople && (
              <>
                <div onClick={() => setPeopleOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
                <div className="anim-scalein" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 31, width: 280, maxHeight: 320, overflowY: "auto", padding: 8, borderRadius: 12, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)" }}>
                  <div className="kicker" style={{ padding: "4px 8px 6px" }}>Owner</div>
                  <select value={ownerId ?? ""} onChange={(e) => onUpdate(project.id, { ownerId: e.target.value || null })} aria-label="Project owner"
                    style={{ width: "100%", height: 32, padding: "0 8px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none", cursor: "pointer", marginBottom: 8 }}>
                    {!ownerId && <option value="">Select owner…</option>}
                    {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <div className="kicker" style={{ padding: "4px 8px 6px" }}>Contributors</div>
                  {members.filter((m) => m.id !== ownerId).length === 0 && <p style={{ fontSize: 12, color: "var(--ink-4)", padding: "2px 8px" }}>Invite teammates to add contributors.</p>}
                  {members.filter((m) => m.id !== ownerId).map((m) => (
                    <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>
                      <input type="checkbox" checked={contribIds.includes(m.id)} onChange={() => toggleContrib(m.id)} />
                      <Avatar id={m.id} size={22} /><span className="truncate">{m.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })()}
      <div style={{ display: "flex", gap: 8, alignSelf: "flex-start" }}>
        {onDuplicate && <button onClick={() => onDuplicate(project.id)} className="btn btn-ghost" title="Duplicate this project (as a template)" style={{ padding: "6px 11px", fontSize: 12.5 }}><Icon name="layers" size={14} /> Duplicate</button>}
        {onArchive && <button onClick={() => { if (window.confirm(`Archive "${project.name}"? It's hidden but kept, and you can restore it from the sidebar.`)) onArchive(project.id); }} className="btn btn-ghost" title="Archive this project" style={{ padding: "6px 11px", fontSize: 12.5 }}><Icon name="archive" size={14} /> Archive</button>}
        <button onClick={printReport} className="btn btn-ghost" title="Print / export a PDF report" style={{ padding: "6px 11px", fontSize: 12.5 }}><Icon name="arrowUpRight" size={14} /> Report</button>
      </div>
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
     {/* guests can read the updates; only people who can edit can post one */}
     {(onPostStatus || history.length > 0) && (
       <div style={{ borderTop: "1px solid var(--hairline)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
         <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
           <span className="kicker">Status update</span>
           {latest && <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: STATUS_KIND_META[latest.status].color }}><span style={{ width: 7, height: 7, borderRadius: 99, background: STATUS_KIND_META[latest.status].color }} />{STATUS_KIND_META[latest.status].label}</span>}
           {latestAge && <span style={{ fontSize: 11.5, color: stale ? "var(--st-review)" : "var(--ink-4)" }} title={new Date(latest!.createdAt).toLocaleString("en-GB")}>{stale ? `Stale · last update ${latestAge.label}` : `Posted ${latestAge.label}`}</span>}
           {onPostStatus && <button onClick={() => setUpdOpen((v) => !v)} className="btn btn-ghost" style={{ marginLeft: "auto", padding: "4px 10px", fontSize: 12 }}>{updOpen ? "Cancel" : "Post update"}</button>}
         </div>
         {latest && !updOpen && <div style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>{latest.summary}</div>}
         {history.length > 1 && !updOpen && (
           <div>
             <button onClick={() => setHistoryOpen((v) => !v)} aria-expanded={historyOpen} className="btn btn-ghost" style={{ padding: "3px 8px", fontSize: 12, color: "var(--ink-3)" }}>
               <Icon name={historyOpen ? "chevronDown" : "chevronRight"} size={13} /> {historyOpen ? "Hide earlier updates" : `Show ${plural(history.length - 1, "earlier update")}`}
             </button>
             <Collapse open={historyOpen}>
               <ol style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                 {history.slice(1, 21).map((s) => (
                   <li key={s.id} style={{ display: "flex", gap: 9, fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-3)" }}>
                     <span style={{ width: 7, height: 7, borderRadius: 99, marginTop: 6, flexShrink: 0, background: STATUS_KIND_META[s.status].color }} aria-hidden="true" />
                     <span><span style={{ color: STATUS_KIND_META[s.status].color, fontWeight: 600 }}>{STATUS_KIND_META[s.status].label}</span> <span style={{ color: "var(--ink-4)" }}>· {relDay(s.createdAt).label}</span><br />{s.summary}</span>
                   </li>
                 ))}
               </ol>
             </Collapse>
           </div>
         )}
         {updOpen && onPostStatus && (
           <>
             <div style={{ display: "flex", gap: 6 }}>
               {(Object.keys(STATUS_KIND_META) as StatusKind[]).map((k) => (
                 <button key={k} onClick={() => setUpdKind(k)} style={{ padding: "4px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12, border: `1px solid ${updKind === k ? STATUS_KIND_META[k].color : "var(--hairline)"}`, background: updKind === k ? `color-mix(in oklch, ${STATUS_KIND_META[k].color} 14%, transparent)` : "transparent", color: updKind === k ? STATUS_KIND_META[k].color : "var(--ink-3)", fontFamily: "var(--font-display)" }}>{STATUS_KIND_META[k].label}</button>
               ))}
             </div>
             {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
             <textarea autoFocus value={updText} onChange={(e) => setUpdText(e.target.value)} placeholder="What's the latest? Wins, risks, next steps…" rows={2}
               style={{ width: "100%", resize: "vertical", padding: "8px 11px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, lineHeight: 1.55, outline: "none" }} />
             <button onClick={postUpd} disabled={posting || !updText.trim()} className="btn btn-accent" style={{ alignSelf: "flex-start", padding: "6px 13px", fontSize: 13, opacity: posting || !updText.trim() ? 0.6 : 1 }}>{posting ? "Posting…" : "Post update"}</button>
           </>
         )}
       </div>
     )}
    </div>
  );
}

function TasksPage({ tasks, allTasks, projects = [], view, setView, groupBy, setGroupBy, smart, setSmart, onOpen, onToggle, onToggleSubtask, onAdd, onMove, onBulkPatch, onBulkDelete, onPatch, onQuickAdd, onOpenImport, members, allTags, archivedTasks = [], header, sections = [], onCreateSection, onRenameSection, onDeleteSection, customFields = [], sectionField = "sectionId", sectionProjectId, filterScope = "my", readOnly = false, boardScope, exportName = "my-tasks", exportOpts }: {
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
  onOpenImport?: () => void;
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
  /** filters are saved per route: a project id, or "my" for My tasks */
  filterScope?: string;
  /** a guest in this workspace: view + comment only (editing controls should hide) */
  readOnly?: boolean;
  /** which board this is, so each board keeps its own WIP limits */
  boardScope?: string;
  /** the CSV file's name (the project's, or "my-tasks") */
  exportName?: string;
  /** what the CSV needs to fill its Section, Parent task and custom-field columns */
  exportOpts?: TaskExportOptions;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem("kanbo-density") === "compact"; } catch { return false; } });
  const toggleCompact = () => setCompact((c) => { const n = !c; try { localStorage.setItem("kanbo-density", n ? "compact" : "comfortable"); } catch { /* private mode */ } return n; });
  const [sortOpen, setSortOpen] = useState(false);
  const [sort, setSort] = useState<string>(() => { try { return localStorage.getItem("kanbo-sort") || "manual"; } catch { return "manual"; } });
  useEffect(() => { try { localStorage.setItem("kanbo-sort", sort); } catch { /* ignore */ } }, [sort]);
  // The page is keyed by route, so the title filter starts empty on every
  // project / My tasks switch. Filters persist per route (not app-wide), so a
  // filter set in one project can never hide every task in another.
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<TaskFilters>(() => readFilters(filterScope));
  useEffect(() => { try { localStorage.setItem(filtersKey(filterScope), JSON.stringify({ ...filters, showArchived: false })); } catch { /* ignore */ } }, [filters, filterScope]);
  const setFilter = (patch: Partial<TaskFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const clearFilters = () => { setFilters({ ...EMPTY_FILTERS, custom: {} }); setSearch(""); };
  const isMobile = useMediaQuery("(max-width: 860px)");
  // ignore saved filters that can't apply here (another project's custom field,
  // someone who isn't in this workspace, a deleted tag)
  const effective = validFilters(filters, {
    memberIds: new Set(members.map((m) => m.id)),
    fieldIds: new Set(customFields.map((f) => f.id)),
    tagIds: new Set(Object.keys(allTags)),
  });
  const { priority: priorityFilter, assignee: assigneeFilter, tag: tagFilter, due: dueFilter, hideDone, showArchived, custom: customFilter } = effective;
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
  const narrowed = filterActive || q !== "";
  // filters hide everything: say so (the list view renders its own empty state)
  const hiddenByFilters = narrowed && filtered.length === 0 && (showArchived ? archivedTasks : tasks).length > 0 && view !== "list";

  return (
    <>
      {header}
      <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12, padding: isMobile ? "10px 14px" : "12px 24px", borderBottom: "1px solid var(--hairline)", flexShrink: 0, flexWrap: "wrap" }}>
        <Segmented options={VIEW_OPTS} value={view} onChange={setView} ariaLabel="View" />
        {!isMobile && <div style={{ width: 1, height: 22, background: "var(--hairline)" }} />}
        {view === "list" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {!isMobile && <span className="kicker">Group</span>}
            <Segmented options={GROUP_OPTS} value={groupBy} onChange={setGroupBy} ariaLabel="Group by" />
          </div>
        )}
        {/* wraps rather than running off the edge on a narrow window (a focused button out
            there would scroll the whole app sideways) */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: isMobile ? 8 : 10, flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0 }}>
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
                  {filterActive && <button onClick={() => setFilters({ ...EMPTY_FILTERS, custom: {} })} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-display)" }}>Clear all</button>}
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
            <button onClick={() => exportTasksCsv(filtered, exportName, exportOpts)} className="btn" title="Export these tasks to CSV" style={{ padding: "8px 11px", border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-2)" }}><Icon name="arrowUpRight" size={15} /> CSV</button>
            <button onClick={() => printTasks(filtered, "Tasks export")} className="btn" title="Export these tasks to PDF (print)" style={{ padding: "8px 11px", border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-2)" }}><Icon name="arrowUpRight" size={15} /> PDF</button>
            {onOpenImport && !readOnly && <button onClick={onOpenImport} className="btn" title="Import tasks (paste a list or upload a file)" style={{ padding: "8px 11px", border: "1px solid var(--hairline)", background: "transparent", color: "var(--ink-2)" }}><Icon name="plus" size={15} /> Import</button>}
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
          {filterActive && <button onClick={() => setFilters({ ...EMPTY_FILTERS, custom: {} })} style={{ marginLeft: 4, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-display)" }}>Clear</button>}
        </div>
      )}
      {hiddenByFilters && (
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 10, margin: isMobile ? "10px 14px 0" : "12px 24px 0", padding: "10px 14px", borderRadius: 12, border: "1px solid var(--hairline)", background: "var(--fill-1, var(--surface-2))", flexShrink: 0 }}>
          <Icon name="filter" size={15} style={{ color: "var(--ink-4)", flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 13, color: "var(--ink-2)" }}>No tasks match {q !== "" ? `“${search.trim()}”` : "these filters"}.</span>
          <button onClick={clearFilters} className="btn btn-ghost" style={{ padding: "4px 11px", fontSize: 12.5 }}>Clear filters</button>
        </div>
      )}
      {view === "list" && <ListView tasks={filtered} allTasks={allTasks} projects={projects} compact={compact} onOpen={onOpen} onToggle={onToggle} onToggleSubtask={onToggleSubtask} groupBy={groupBy} smart={smart} sort={sort} onBulkPatch={onBulkPatch} onBulkDelete={onBulkDelete} onPatch={onPatch} onQuickAdd={onQuickAdd} onOpenImport={onOpenImport} members={members} sections={sections} onCreateSection={onCreateSection} onRenameSection={onRenameSection} onDeleteSection={onDeleteSection} customFields={customFields} sectionField={sectionField} sectionProjectId={sectionProjectId}
        filtered={narrowed || showArchived} onClearFilters={clearFilters} readOnly={readOnly} />}
      {view === "board" && <BoardView tasks={filtered} allTasks={allTasks} onOpen={onOpen} onAdd={onAdd} onMove={onMove} onPatch={onPatch} onBulkPatch={onBulkPatch} onBulkDelete={onBulkDelete} members={members} customFields={customFields} readOnly={readOnly} scopeKey={boardScope} />}
      {view === "timeline" && <TimelineView tasks={filtered} allTasks={allTasks} onOpen={onOpen} onPatch={onPatch} readOnly={readOnly} />}
      {view === "calendar" && <CalendarView tasks={filtered} onOpen={onOpen} onPatch={onPatch} readOnly={readOnly} />}
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
      <AppBg />
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

/** A locally-created task the server hasn't confirmed yet. `until` is null while
 *  the insert is in flight (or failed); once saved it lingers for 30s so a reload
 *  that raced the insert can't make it blink out. */
type PendingCreate = { id: string; task: Task; until: number | null };
type CreateOpts = { log?: boolean; notify?: boolean; slot?: Limiter };
type CommitOpts = { notify?: boolean; op?: string; onFailed?: (ids: string[]) => void; retry?: () => void; failMessage?: (failed: number) => string };
/** Side effects of status changes, held until the save settles: activity rows are
 *  only logged for saves that stuck, and a failed completion takes back the
 *  recurrence it spawned (a failed reopen puts back the one it removed). */
type StatusFx = { logs: Map<string, () => void>; completing: Set<string>; unspawned: Map<string, Task> };
const newStatusFx = (): StatusFx => ({ logs: new Map(), completing: new Set(), unspawned: new Map() });
const UNDO_MS = 10000;
/** Inbox items taken off screen by one archive, and that archive's save. */
type ArchivePart = { items: Activity[]; archived: Promise<void> };

/** Lets an error boundary catch errors thrown while building a view's props, too. */
function RenderView({ render }: { render: () => React.ReactNode }) { return <>{render()}</>; }

export default function App() {
  const auth = useAuth();
  const { error: toastError, success: toastSuccess, action: toastAction, toast } = useToast();
  const toastInfo = useCallback((m: string) => toast(m, "info"), [toast]);
  // "system" follows the device (theme-init.js paints it before React mounts)
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    try { const s = localStorage.getItem("kanbo-theme"); if (s === "light" || s === "dark" || s === "system") return s; } catch { /* private mode */ }
    return "dark"; // dark is the on-brand default; users can toggle to light
  });
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const resolvedTheme: "light" | "dark" = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  // the quick toggles (top bar, palette) always pick an explicit theme — worked out
  // when clicked, not in a state updater (StrictMode re-runs those mid-render)
  const flipTheme = useCallback(() => setTheme(resolvedThemeRef.current === "dark" ? "light" : "dark"), []);
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
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
  const [importOpen, setImportOpen] = useState(false);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [unsavedIds, setUnsavedIds] = useState<string[]>([]); // creates that failed — kept on screen until retried
  const onboardCheckedRef = useRef(false);
  const [online, setOnline] = useState(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
  const [pendingSync, setPendingSync] = useState(0); // queued offline task writes awaiting replay
  const [syncing, setSyncing] = useState(false);
  const [banner, setBanner] = useState<AppBanner | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState<string | null>(() => { try { return localStorage.getItem("kanbo-banner-dismissed"); } catch { return null; } });
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
  const [smart, setSmart] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  // Search opened from the palette with its text already typed in (until you navigate)
  const [searchPrefill, setSearchPrefill] = useState<{ text: string; key: string } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
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
  const [aiBusy, setAiBusy] = useState(false);

  /* ---- live views of state for stable callbacks ---- */
  const routeRef = useRef<Route>(route); routeRef.current = route;
  const resolvedThemeRef = useRef(resolvedTheme); resolvedThemeRef.current = resolvedTheme;
  const tasksRef = useRef<Task[] | null>(null); tasksRef.current = tasks;
  const userIdRef = useRef(currentUserId); userIdRef.current = currentUserId;
  const projectsRef = useRef<Project[]>([]); projectsRef.current = projects;
  const sectionsRef = useRef<Section[]>([]); sectionsRef.current = sections;
  const rulesRef = useRef<AutomationRule[]>([]); rulesRef.current = automationRules;
  const tagsRef = useRef<Record<string, TagDef>>({}); tagsRef.current = tags;
  const workspacesRef = useRef<Workspace[]>([]); workspacesRef.current = workspaces;
  const workspaceRef = useRef<string | null>(null); workspaceRef.current = workspace;
  const wsMembersRef = useRef<WorkspaceMember[]>([]); wsMembersRef.current = wsMembers;
  const activityRef = useRef<Activity[]>([]); activityRef.current = activity;
  const savedSearchesRef = useRef<SavedSearch[]>([]); savedSearchesRef.current = savedSearches;
  const signedInRef = useRef(false); signedInRef.current = !auth.configured || !!auth.user;

  /* ---- write bookkeeping ----
     pendingTasksRef: tasks created here that a reload hasn't returned yet, so a
       refetch can never wipe a task you just added.
     createsRef: in-flight inserts (id → server id). Writes to a task that is
       still being inserted wait for it instead of failing.
     unsavedRef: inserts that failed. The row stays on screen, flagged, with Retry.
     recentWritesRef: recent local edits/deletes, laid over a realtime refetch so
       a background reload can't revert a change whose write hasn't landed. */
  const pendingTasksRef = useRef<PendingCreate[]>([]);
  const createsRef = useRef(new Map<string, Promise<string>>());
  const unsavedRef = useRef(new Set<string>());
  const cancelledRef = useRef(new Set<string>()); // deleted before their insert ran — never insert them
  const recentWritesRef = useRef<Map<string, { deleted: boolean; patch: Partial<Task>; until: number }>>(new Map());
  const spawnedRef = useRef(new Map<string, string>()); // completed recurring task → its next occurrence
  const pendingDeletesRef = useRef(new Map<number, () => void>()); // undo-able deletes waiting to be sent
  const delSeqRef = useRef(0);
  const writeSeqRef = useRef(0);
  const fieldSeqRef = useRef(new Map<string, number>()); // `${taskId}:${field}` → newest write that set it
  const tmpOpsRef = useRef(new Map<string, { patch: Record<string, unknown>; deleted: boolean }>());
  const tmpSectionRef = useRef(new Map<string, Promise<string>>());
  const sectionAliasRef = useRef(new Map<string, string>());
  const readLocallyRef = useRef(new Map<string, string>()); // activity ids marked read here → stamp
  const lastGuestToastRef = useRef(0);
  const lastErrToastRef = useRef(0);
  const lastUnsavedToastRef = useRef(0);
  const reloadSeqRef = useRef(0);   // every bootstrap / realtime reload gets a number…
  const appliedSeqRef = useRef(0);  // …and only the newest result is ever applied
  const bootedRef = useRef(false);
  const retryUnsavedRef = useRef<() => void>(() => {});
  const removeTasksRef = useRef<(roots: Task[], label: string) => void>(() => {});
  // projects/workspaces created here → the newest reload that had already started
  // when they were created. Those reloads can't know about them, so they must not drop them.
  const recentCreatesRef = useRef(new Map<string, { seq: number; until: number }>());
  const requestReloadRef = useRef<(() => void) | null>(null); // realtime mode: ask for a fresh snapshot
  const skipWsPersistRef = useRef(false); // the next workspace change isn't the user's choice — don't remember it

  const WRITE_TTL = 8000;
  const noteWrite = useCallback((ids: string | string[], patch: Partial<Task>) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    const until = Date.now() + WRITE_TTL;
    arr.forEach((id) => {
      const ex = recentWritesRef.current.get(id);
      recentWritesRef.current.set(id, { deleted: false, patch: { ...(ex && !ex.deleted ? ex.patch : {}), ...patch }, until });
    });
  }, []);
  const noteDelete = useCallback((ids: string | string[], ttl = WRITE_TTL) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    const until = Date.now() + ttl;
    arr.forEach((id) => recentWritesRef.current.set(id, { deleted: true, patch: {}, until }));
  }, []);
  /** Forget a recent write (all of it, or just some fields) so a reload shows the server's value. */
  const clearWrite = useCallback((ids: string | string[], keys?: string[]) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    arr.forEach((id) => {
      if (!keys) { recentWritesRef.current.delete(id); return; }
      const w = recentWritesRef.current.get(id); if (!w || w.deleted) return;
      const patch = { ...w.patch } as Record<string, unknown>;
      keys.forEach((k) => delete patch[k]);
      if (Object.keys(patch).length) recentWritesRef.current.set(id, { ...w, patch: patch as Partial<Task> });
      else recentWritesRef.current.delete(id);
    });
  }, []);
  const dropPending = useCallback((ids: Set<string>) => {
    pendingTasksRef.current = pendingTasksRef.current.filter((p) => !ids.has(p.id));
  }, []);

  /** Throttled "couldn't save" toast for writes that aren't rolled back. */
  const saveFailed = useCallback((op: string, msg = "Couldn't save that change — please try again.") => (e: unknown) => {
    reportError(e, { op });
    const now = Date.now();
    if (now - lastErrToastRef.current > 2500) { lastErrToastRef.current = now; toastError(msg); }
  }, [toastError]);

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

  /* ---- roles: guests can view and comment, nothing else ---- */
  const roleIn = useCallback((wsId: string | null | undefined): Role | null => {
    if (!wsId) return null; // Personal: your own space
    return wsMembersRef.current.find((m) => (m.workspaceId ?? null) === wsId && m.userId === userIdRef.current && m.status === "active")?.role ?? null;
  }, []);
  /** Refuse up front (with one friendly toast) instead of an optimistic change the server would silently revert. */
  const denyGuest = useCallback((wsIds: (string | null | undefined)[]): boolean => {
    if (!wsIds.some((w) => roleIn(w) === "guest")) return false;
    const now = Date.now();
    if (now - lastGuestToastRef.current > 3000) { lastGuestToastRef.current = now; toastInfo(GUEST_MSG); }
    return true;
  }, [roleIn, toastInfo]);
  const projectWs = (projectId: string | undefined) => (projectId ? getProject(projectId)?.workspaceId ?? null : null);

  /** The server gave a task a different id than we generated (only until the
   *  store inserts with explicit ids): move every local reference over. */
  const remapTaskId = useCallback((from: string, to: string) => {
    if (from === to) return;
    setTasks((ts) => ts && ts.map((x) => {
      if (x.id !== from && x.parentId !== from && !(x.dependencies ?? []).includes(from)) return x;
      return { ...x, id: x.id === from ? to : x.id, parentId: x.parentId === from ? to : x.parentId, dependencies: (x.dependencies ?? []).map((d) => (d === from ? to : d)) };
    }));
    pendingTasksRef.current = pendingTasksRef.current.map((p) => (p.id === from ? { ...p, id: to, task: { ...p.task, id: to } } : p));
    const w = recentWritesRef.current.get(from);
    if (w) { recentWritesRef.current.delete(from); recentWritesRef.current.set(to, w); }
    spawnedRef.current.forEach((v, k) => { if (v === from) spawnedRef.current.set(k, to); });
    const s = spawnedRef.current.get(from); if (s) { spawnedRef.current.delete(from); spawnedRef.current.set(to, s); }
    setDetailId((d) => (d === from ? to : d)); // an open panel follows the task
  }, []);

  useEffect(() => { store.activeBanner().then(setBanner).catch(() => {}); }, []);
  // offline write-replay queue: surface how many changes are waiting to sync
  useEffect(() => offlineQueue.subscribe(setPendingSync), []);
  // a queued create was saved: swap its optimistic id for the server's
  const onQueuedCreateSaved = useCallback((clientId: string, serverId: string, saved: Task) => {
    // after an online reopen a queued-create task isn't in state yet — insert it
    setTasks((ts) => {
      if (!ts || ts.some((t) => t.id === clientId || t.id === serverId)) return ts;
      return [{ ...saved, id: serverId }, ...ts];
    });
    remapTaskId(clientId, serverId);
  }, [remapTaskId]);
  // replay queued task writes; swap any optimistic ids the server reassigned
  const flushOffline = useCallback(async () => {
    if (offlineQueue.size() === 0 || typeof navigator !== "undefined" && navigator.onLine === false) return;
    setSyncing(true);
    try {
      const n = await store.flushQueue(onQueuedCreateSaved);
      if (n > 0) toastSuccess(`Synced ${plural(n, "offline change")}`);
    } catch (e) { reportError(e, { op: "flushOffline" }); }
    finally { setSyncing(false); }
  }, [toastSuccess, onQueuedCreateSaved]);
  // changes the queue parked after several failed tries: say so, with Retry / Discard
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  useEffect(() => offlineQueue.subscribeDeadLetters(setDeadLetters), []);
  const retryDeadLetters = useCallback(() => { offlineQueue.retryDeadLetters(); flushOffline(); }, [flushOffline]);
  const discardDeadLetters = useCallback(() => {
    const n = offlineQueue.deadLetters().length;
    if (!n || !window.confirm(`Discard ${plural(n, "change")} that couldn't be synced? ${n === 1 ? "It's" : "They're"} only on this device, so ${n === 1 ? "it's" : "they're"} gone for good.`)) return;
    offlineQueue.discardDeadLetters();
  }, []);
  // connection awareness — honest about offline, and drain the queue on reconnect
  useEffect(() => {
    const goOnline = () => { setOnline(true); toastSuccess("Back online"); flushOffline(); };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); };
  }, [toastSuccess, flushOffline]);
  // first-run onboarding: once per person (not per browser), for accounts with no real projects yet
  useEffect(() => {
    if (tasks === null || onboardCheckedRef.current) return;
    onboardCheckedRef.current = true;
    let done = false;
    try {
      const mine = `kanbo-onboarded:${userIdRef.current}`;
      done = localStorage.getItem(mine) === "1";
      // before onboarding was per person it was one flag per browser: whoever
      // signs in here first inherits it (so nobody who finished it sees it again),
      // and it's then retired so a second person on this browser still gets theirs
      if (!done && localStorage.getItem("kanbo-onboarded") === "1") {
        done = true;
        localStorage.setItem(mine, "1"); localStorage.removeItem("kanbo-onboarded");
      }
    } catch { /* private mode */ }
    if (!done && projectsRef.current.filter((p) => p.id !== "p-personal").length === 0) setOnboardOpen(true);
  }, [tasks]);
  const finishOnboarding = useCallback(() => { try { localStorage.setItem(`kanbo-onboarded:${userIdRef.current}`, "1"); } catch { /* ignore */ } setOnboardOpen(false); }, []);

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

  /* ---- inbox: scoped to the active workspace; the badge is the server's read_at ---- */
  const scopedActivity = useMemo(() => {
    if (!tasks) return [] as Activity[];
    // a task's activity belongs to the workspace its task lives in, so personal
    // activity never leaks into a team inbox (or vice versa). Unresolvable
    // (deleted-task) items are dropped.
    const wsOfTask = new Map(tasks.map((t) => [t.id, t.workspaceId ?? null]));
    return activity.filter((a) => a.taskId != null && wsOfTask.has(a.taskId) && wsOfTask.get(a.taskId) === workspace);
  }, [tasks, activity, workspace]);
  const scopedActivityRef = useRef<Activity[]>([]); scopedActivityRef.current = scopedActivity;
  // unread = not read on the server (any device), and not your own actions
  const inboxCount = scopedActivity.filter((a) => !a.readAt && !SELF_KINDS.has(a.kind)).length;
  const mergeReadState = useCallback((feed: Activity[]) =>
    feed.map((a) => (a.readAt || !readLocallyRef.current.has(a.id) ? a : { ...a, readAt: readLocallyRef.current.get(a.id) })), []);
  useEffect(() => {
    if (route.view !== "inbox") return;
    try { localStorage.setItem(`kanbo-inbox-seen:${userIdRef.current}`, String(Date.now())); } catch { /* private mode */ }
  }, [route.view]);
  // while the inbox is on screen, what it shows (this workspace only) is read —
  // including anything that arrives while you're looking at it
  useEffect(() => {
    if (route.view !== "inbox") return;
    const unread = scopedActivity.filter((a) => !a.readAt).map((a) => a.id);
    if (!unread.length) return;
    const stamp = new Date().toISOString();
    const ids = new Set(unread);
    unread.forEach((id) => readLocallyRef.current.set(id, stamp));
    setActivity((xs) => xs.map((a) => (ids.has(a.id) && !a.readAt ? { ...a, readAt: stamp } : a)));
    store.markActivityRead(unread).catch(reportError);
  }, [route.view, scopedActivity]);
  // unread count in the tab title, so a background tab still tells you
  const baseTitleRef = useRef(typeof document !== "undefined" ? document.title.replace(/^\(\d+\)\s*/, "") : "Kanbo");
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = inboxCount > 0 ? `(${inboxCount}) ${baseTitleRef.current}` : baseTitleRef.current;
  }, [inboxCount]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    try { localStorage.setItem("kanbo-theme", theme); } catch { /* private mode */ }
    // (theme-init.js keeps <meta name="theme-color"> in step with data-theme)
  }, [theme, resolvedTheme]);
  useEffect(() => { saveAppearance(appearance); }, [appearance]);

  /* ---- keyboard ---- */
  const overlayRef = useRef({ quick: false, shortcuts: false, cmd: false, upgrade: false, deleteProject: false, newWorkspace: false, newProject: false, newTask: false, focus: false, detail: false, sidebar: false, selfManaged: false });
  overlayRef.current = {
    quick: quickCaptureOpen, shortcuts: shortcutsOpen, cmd: cmdOpen, upgrade: upgradeOpen, deleteProject: !!deleteProjectId,
    newWorkspace: newWorkspaceOpen, newProject: newProjectOpen, newTask: newTaskOpen, focus: focusOpen, detail: !!detailId, sidebar: sidebarOpen,
    // these dialogs handle Escape themselves; the window handler must leave them (and what's under them) alone
    selfManaged: settingsOpen || tagManagerOpen || importOpen || welcomeOpen || onboardOpen,
  };
  const openNewTaskRef = useRef<() => void>(() => {});
  const openCaptureRef = useRef<() => void>(() => {});
  useEffect(() => {
    const isEditable = (el: EventTarget | null) => {
      const h = el as HTMLElement | null;
      return !!h && (h.tagName === "INPUT" || h.tagName === "TEXTAREA" || h.tagName === "SELECT" || h.isContentEditable);
    };
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;      // a field, menu or dialog already handled it
      if (!signedInRef.current) return;    // no app shortcuts on the signed-out site
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdOpen((v) => !v); return; }
      if (e.key === "Escape") {
        // close only the top-most overlay — never the task panel underneath a menu
        const o = overlayRef.current;
        if (o.selfManaged) return;
        const editable = isEditable(e.target);
        if (o.quick) setQuickCaptureOpen(false);
        else if (o.shortcuts) setShortcutsOpen(false);
        else if (o.cmd) setCmdOpen(false);
        else if (o.upgrade) setUpgradeOpen(false);
        else if (o.deleteProject) setDeleteProjectId(null);
        else if (o.newWorkspace) setNewWorkspaceOpen(false);
        else if (o.newProject) setNewProjectOpen(false);
        else if (o.newTask) setNewTaskOpen(false);
        else if (o.focus) setFocusOpen(false);
        // typing in the task panel: leave the field, keep the panel (and your draft).
        // Only the panel's own fields — elsewhere a field's Escape is its own business
        // (an inline "Add task" treats Escape as cancel and blur as save).
        else if (o.detail) {
          const inPanel = editable && !!(e.target as HTMLElement).closest?.('[role="dialog"][aria-label^="Task:"]');
          if (inPanel) (e.target as HTMLElement).blur(); else setDetailId(null);
        }
        else if (o.sidebar) setSidebarOpen(false);
        return;
      }
      // single-key shortcuts — never while typing, with modifiers held, or while a dialog is open
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) { gPrefixRef.current = false; return; }
      if (gPrefixRef.current) {
        gPrefixRef.current = false;
        const nav: Record<string, Route["view"]> = { h: "home", p: "plan", i: "inbox", t: "tasks", c: "calendar", s: "search", a: "analytics", r: "reports", w: "myweek" };
        const v = nav[e.key.toLowerCase()];
        if (v) { e.preventDefault(); setRouteRaw({ view: v }); setDetailId(null); setSidebarOpen(false); }
        return;
      }
      if (e.key === "g") { gPrefixRef.current = true; window.setTimeout(() => { gPrefixRef.current = false; }, 800); return; }
      if (e.key === "c") { e.preventDefault(); openNewTaskRef.current(); return; }
      if (e.key === "q") { e.preventDefault(); openCaptureRef.current(); return; }
      if (e.key === "/") { e.preventDefault(); setCmdOpen(true); return; }
      if (e.key === "?") { e.preventDefault(); setShortcutsOpen(true); return; }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // mobile drawer: out of the tab order and hidden from assistive tech while closed;
  // focus moves in when it opens and back to where you were when it closes
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerReturnRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = drawerRef.current; if (!el) return;
    if (sidebarOpen) {
      el.removeAttribute("inert");
      drawerReturnRef.current = document.activeElement as HTMLElement | null;
      el.querySelector<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')?.focus();
    } else {
      el.setAttribute("inert", "");
      const back = drawerReturnRef.current; drawerReturnRef.current = null;
      if (back && document.contains(back)) back.focus();
    }
  }, [sidebarOpen, isMobile, tasks === null]);

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

  /** Server tasks + what the server can't know yet: recent local edits/deletes and
   *  tasks created here that it hasn't returned (kept by id, in their current local form). */
  const mergeServerTasks = useCallback((serverTasks: Task[]): Task[] => {
    const now = Date.now();
    const m = recentWritesRef.current;
    for (const [id, w] of m) if (w.until < now) m.delete(id);
    const merged = serverTasks
      .filter((d) => !m.get(d.id)?.deleted)
      .map((d) => { const w = m.get(d.id); return w && !w.deleted ? { ...d, ...w.patch } : d; });
    const serverIds = new Set(serverTasks.map((d) => d.id));
    const queued = new Set(offlineQueue.all().flatMap((q) => (q.kind === "create" ? [q.task.id] : [])));
    pendingTasksRef.current = pendingTasksRef.current.filter((p) => !serverIds.has(p.id) && (p.until === null || p.until > now || queued.has(p.id)));
    const local = new Map((tasksRef.current ?? []).map((t) => [t.id, t]));
    const pending = pendingTasksRef.current.filter((p) => !m.get(p.id)?.deleted).map((p) => local.get(p.id) ?? p.task);
    return pending.length ? [...pending, ...merged] : merged;
  }, []);

  /** A project or workspace was just created here: reloads already under way keep it. */
  const noteCreated = useCallback((id: string) => {
    recentCreatesRef.current.set(id, { seq: reloadSeqRef.current, until: Date.now() + 30000 });
  }, []);

  /** Once per session, and only to a platform admin (the one person who can act on
   *  it): the database is missing columns this version writes (a migration not run
   *  yet), so some fields are being dropped on save. Everyone else's drops still
   *  reach monitoring (the store reports each column once). */
  const schemaNoticeRef = useRef(false);
  const noteSchemaBehind = useCallback((adminByProfile: boolean) => {
    if (schemaNoticeRef.current || !store.configured || getStrippedColumns().length === 0) return;
    schemaNoticeRef.current = true;
    const tell = () => {
      const cols = getStrippedColumns();
      toastInfo(`Admin notice: the database is behind this version — ${cols.join(", ")} ${cols.length === 1 ? "isn't" : "aren't"} being saved yet. Run the pending migration.`);
    };
    if (adminByProfile) { tell(); return; }
    // the founding account may not carry the profile flag — ask the server (once, and only now)
    store.amIAdmin().then((admin) => { if (admin) tell(); }, () => { /* not an admin as far as we can tell */ });
  }, [toastInfo]);

  /** Apply a bootstrap result. Returns false when a newer run's data is already on screen. */
  const applyBoot = useCallback((loaded: Bootstrap, seq: number, initial: boolean): boolean => {
    if (initial) {
      setCurrentUserId(loaded.currentUserId);
      // reopen where this person left off (if they're still in that workspace)
      let stored: string | null = null;
      try { stored = localStorage.getItem(lastWorkspaceKey(loaded.currentUserId)); } catch { /* private mode */ }
      setWorkspace(pickStartWorkspace(loaded.workspaces, loaded.defaultWorkspace, stored));
      // where we open isn't a choice to remember (a list that loaded short would otherwise pin Personal)
      skipWsPersistRef.current = true;
      bootedRef.current = true;
    }
    if (seq < appliedSeqRef.current) {
      // the store already pointed its lookups at this older snapshot — point them back at what's on screen
      setReferenceData({ projects: projectsRef.current, workspaces: workspacesRef.current, tags: tagsRef.current });
      return false;
    }
    appliedSeqRef.current = seq;
    // a reload where some best-effort parts failed keeps what's on screen for those
    // parts. (The first load's parts are already the device's last good copy.)
    const b = initial ? loaded : keepOnScreen(loaded, { projects: projectsRef.current, tags: tagsRef.current, workspaces: workspacesRef.current, members: wsMembersRef.current });
    noteSchemaBehind(!!b.profile?.isAdmin && b.profile.suspended !== true);
    setTasks(mergeServerTasks(b.tasks));
    const tmpTags = Object.fromEntries(Object.entries(tagsRef.current).filter(([k]) => k.startsWith("tmp-")));
    // Projects and workspaces this snapshot can't be trusted to leave out: ones created
    // here after the reload started, and — when a best-effort query came back short —
    // ones the rest of the snapshot still vouches for. Everything else follows the server.
    const justMade = unseenCreates(recentCreatesRef.current, seq);
    applyProjects(reloadProjects(b.projects, projectsRef.current, b.tasks, justMade)); applyTags({ ...b.tags, ...tmpTags });
    const ws = reloadWorkspaces(b.workspaces, workspacesRef.current, b.members, wsMembersRef.current, b.currentUserId, justMade);
    setWorkspaces(ws.workspaces); setReferenceData({ workspaces: ws.workspaces });
    setWsMembers(ws.members); setProfile((cur) => (!initial && b.partial?.profile ? cur : b.profile));
    setSections((cur) => keepTmp(b.sections, cur)); setCustomFields((cur) => keepTmp(b.customFields, cur)); setSavedSearches((cur) => keepTmp(b.savedSearches, cur));
    setGoals((cur) => keepTmp(b.goals, cur)); setPortfolios((cur) => keepTmp(b.portfolios, cur)); setStatusUpdates(b.statusUpdates);
    setAutomationRules((cur) => keepTmp(b.automationRules, cur)); setForms((cur) => keepTmp(b.forms, cur));
    return true;
  }, [mergeServerTasks, applyProjects, applyTags, noteSchemaBehind]);

  useEffect(() => {
    if (auth.configured && !authUserId) {
      // signed out: nothing from the last session may leak into the next one
      setTasks(null); bootedRef.current = false; onboardCheckedRef.current = false;
      pendingTasksRef.current = []; createsRef.current.clear(); unsavedRef.current.clear(); setUnsavedIds([]);
      recentWritesRef.current.clear(); spawnedRef.current.clear(); readLocallyRef.current.clear();
      return;
    }
    let cancelled = false;
    const seq = ++reloadSeqRef.current;
    // retries the store schedules by itself (a request that died mid-flight) can
    // swap optimistic ids too, even when the queue was empty at load
    store.setRemapHandler(onQueuedCreateSaved);
    (async () => {
      try {
        const b = await store.bootstrap(auth.user);
        if (cancelled) return;
        applyBoot(b, seq, true);
        flushOffline(); // app reopened online after offline edits — drain the queue
        const feed = await store.listActivity();
        if (!cancelled && seq >= appliedSeqRef.current) setActivity(mergeReadState(feed));
        const subn = await store.getSubscription();
        if (!cancelled) setSubscription(subn);
      } catch (e) {
        reportError(e, { op: "bootstrap" });
        if (!cancelled) { setTasks([]); toastError("Couldn't load your workspace. Please refresh."); }
      }
    })();
    return () => { cancelled = true; store.setRemapHandler(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.configured, authUserId]);

  // real-time multi-tab/device sync: re-pull data on remote changes. 500ms
  // trailing debounce with a 3s max wait (steady traffic can't starve it), and
  // numbered runs so an older reload that finishes late can't overwrite a newer one.
  // One reload at a time: events that arrive while one runs queue a single follow-up.
  // A resync (reconnected, back online, tab back after a while) runs at once; a
  // change that only touches the inbox (activity rows) re-reads just the feed.
  useEffect(() => {
    if (!store.configured || !authUserId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let feedTimer: ReturnType<typeof setTimeout> | undefined;
    let firstAt = 0, alive = true, running = false, dirty = false;
    const reload = async () => {
      if (running) { dirty = true; return; }
      running = true;
      const seq = ++reloadSeqRef.current;
      try {
        const b = await store.bootstrap(auth.user);
        if (!alive || !applyBoot(b, seq, false)) return;
        const feed = await store.listActivity();
        if (alive && seq >= appliedSeqRef.current) setActivity(mergeReadState(feed));
      } catch (e) { reportError(e, { op: "realtime-reload" }); }
      finally {
        running = false;
        if (dirty && alive) { dirty = false; schedule(); }
      }
    };
    const schedule = () => {
      const now = Date.now();
      if (!firstAt) firstAt = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { firstAt = 0; timer = undefined; reload(); }, Math.max(0, Math.min(500, firstAt + 3000 - now)));
    };
    const reloadNow = () => { if (timer) clearTimeout(timer); timer = undefined; firstAt = 0; reload(); };
    const refreshFeed = () => {
      if (feedTimer) return; // one feed read per burst
      feedTimer = setTimeout(() => {
        feedTimer = undefined;
        const seq = appliedSeqRef.current;
        store.listActivity().then((feed) => { if (alive && seq === appliedSeqRef.current) setActivity(mergeReadState(feed)); }, (e) => reportError(e, { op: "realtime-feed" }));
      }, 400);
    };
    const onChange = (change?: RealtimeChange) => {
      if (change?.kind === "resync") reloadNow();
      else if (change?.kind === "row" && change.table === "activity") refreshFeed();
      else schedule();
    };
    requestReloadRef.current = schedule;
    const unsub = store.subscribeToChanges(onChange);
    return () => { alive = false; requestReloadRef.current = null; if (timer) clearTimeout(timer); if (feedTimer) clearTimeout(feedTimer); unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId]);

  const setRoute = (r: Route) => {
    setRouteRaw(r);
    setSearchPrefill(null);
    if (r.smart) setSmart(true);
    setDetailId(null);
    setSidebarOpen(false); // close the mobile drawer on navigation
  };

  // remember the workspace per person, so the next visit opens where they left off
  // (only the user's own switches — not where we opened, nor a switch we forced)
  useEffect(() => {
    if (tasks === null || !bootedRef.current) return;
    if (store.configured && currentUserId === "m-self") return;
    if (skipWsPersistRef.current) { skipWsPersistRef.current = false; return; }
    try { localStorage.setItem(lastWorkspaceKey(currentUserId), workspace ?? "personal"); } catch { /* private mode */ }
  }, [workspace, currentUserId, tasks === null]);

  // you left / were removed from a workspace, or it was closed: don't stay pointed at it.
  // A reload can come back short (a failed best-effort query), so the membership is
  // checked directly before anyone is moved — and nothing happens if that check fails.
  const wsNamesRef = useRef(new Map<string | null, string>());
  const wsCheckRef = useRef<string | null>(null);
  useEffect(() => {
    if (tasks === null) return;
    workspaces.forEach((w) => wsNamesRef.current.set(w.id, w.name));
    if (workspace === null || workspaces.some((w) => w.id === workspace)) return;
    const gone = workspace;
    if (wsCheckRef.current === gone) return; // already checking
    wsCheckRef.current = gone;
    const me = userIdRef.current;
    const check = store.configured
      ? store.listWorkspaceMembers().then((ms) => !ms.some((m) => (m.workspaceId ?? null) === gone && m.userId === me && m.status === "active"))
      : Promise.resolve(true);
    check.then((isGone) => {
      if (!isGone || workspaceRef.current !== gone || workspacesRef.current.some((w) => w.id === gone)) return;
      const name = wsNamesRef.current.get(gone);
      skipWsPersistRef.current = true;
      setWorkspace(null); setRoute({ view: "home" });
      toastInfo(name ? `You're no longer in ${name}` : "You're no longer in that workspace");
    }, (e) => reportError(e, { op: "confirmWorkspaceGone" })) // couldn't check: stay put, the next reload looks again
      .finally(() => { if (wsCheckRef.current === gone) wsCheckRef.current = null; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, workspace, tasks === null]);
  // the open project was deleted, archived or moved to another workspace: go home.
  // "Missing" must show up in two reloads in a row before it counts (one can come back short).
  const projMissRef = useRef<{ id: string; seq: number } | null>(null);
  const routeWsRef = useRef<string | null>(null);
  useEffect(() => {
    const switched = routeWsRef.current !== workspace; routeWsRef.current = workspace;
    if (tasks === null || route.view !== "project" || !route.projectId || route.projectId.startsWith("tmp-")) { projMissRef.current = null; return; }
    const pid = route.projectId;
    const p = projects.find((x) => x.id === pid);
    if (!p) {
      const miss = projMissRef.current;
      if (requestReloadRef.current && (!miss || miss.id !== pid)) { projMissRef.current = { id: pid, seq: appliedSeqRef.current }; requestReloadRef.current(); return; }
      if (requestReloadRef.current && miss && appliedSeqRef.current <= miss.seq) return; // wait for the confirming reload
      projMissRef.current = null;
      setRoute({ view: "home" }); toastInfo("That project was deleted, or you no longer have access to it.");
      return;
    }
    projMissRef.current = null;
    // (only people who can archive see the sidebar's Restore)
    if (p.archivedAt) { setRoute({ view: "home" }); toastInfo(canArchiveProject(p, { myRole: roleIn(p.workspaceId) }) ? `“${p.name}” was archived — restore it from the sidebar.` : `“${p.name}” was archived.`); }
    else if ((p.workspaceId ?? null) !== workspace) {
      setRoute({ view: "home" });
      // you switched workspace: nothing to explain. Otherwise (it was moved): say where it is.
      if (!switched) toastInfo(`“${p.name}” is now in ${workspaces.find((w) => w.id === (p.workspaceId ?? null))?.name || "Personal"} — switch workspace to open it.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, projects, workspace, tasks === null]);

  /* append to the activity feed (Inbox) — fire-and-forget */
  const log = useCallback((kind: ActivityKind, task: { id: string | null; title: string }, detail: string) => {
    store.logActivity({ taskId: task.id, taskTitle: task.title, kind, detail }, userIdRef.current)
      .then((a) => setActivity((xs) => [a, ...xs]))
      .catch(reportError);
  }, []);

  /* ---- inbox archiving (with Undo) ---- */
  const putBackActivity = useCallback((items: Activity[]) => {
    setActivity((xs) => {
      const have = new Set(xs.map((a) => a.id));
      const back = items.filter((a) => !have.has(a.id));
      return back.length ? [...back, ...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : xs;
    });
  }, []);
  /** Undo archives: back on screen at once, and un-archived on the server (in one
   *  call) once each archive has landed — one that failed already put its items back. */
  const undoArchive = useCallback((parts: ArchivePart[]) => {
    const items = parts.flatMap((p) => p.items);
    if (!items.length) return;
    putBackActivity(items);
    Promise.all(parts.map((p) => p.archived.then(() => p.items.map((a) => a.id), () => [] as string[]))).then((landed) => {
      const ids = landed.flat();
      if (!ids.length) return;
      return store.unarchiveActivity(ids).catch((e) => {
        reportError(e, { op: "unarchiveActivity" });
        const gone = new Set(ids);
        setActivity((xs) => xs.filter((a) => !gone.has(a.id)));
        toastError(ids.length === 1 ? "Couldn't bring that item back." : "Couldn't bring those items back.");
      });
    });
  }, [putBackActivity, toastError]);

  /** The inbox keeps ONE Undo toast: archiving more while it's up adds to it
   *  ("Archived 3 notifications") and its Undo brings them all back, so working
   *  through the inbox never stacks toasts over its rows. */
  const archiveBatchRef = useRef<ArchivePart[] | null>(null);
  const offerArchiveUndo = useCallback((part: ArchivePart, message: string) => {
    const prev = archiveBatchRef.current;
    const batch = [...(prev ?? []), part];
    archiveBatchRef.current = batch;
    const done = () => { if (archiveBatchRef.current === batch) archiveBatchRef.current = null; };
    const n = batch.reduce((sum, p) => sum + p.items.length, 0);
    toastAction(prev ? `Archived ${plural(n, "notification")}` : message, "Undo", () => { done(); undoArchive(batch); }, { key: "inbox-archive", onExpire: done });
  }, [toastAction, undoArchive]);

  const archiveActivity = useCallback((id: string) => {
    const removed = activityRef.current.filter((a) => a.id === id);
    setActivity((xs) => xs.filter((a) => a.id !== id)); // optimistic
    const archived = store.archiveActivity(id);
    archived.catch((e) => { reportError(e); toastError("Couldn't archive that item."); putBackActivity(removed); });
    offerArchiveUndo({ items: removed, archived }, "Notification archived");
  }, [toastError, putBackActivity, offerArchiveUndo]);

  // "Archive all" clears what the inbox is showing — this workspace, not every workspace
  const clearInbox = useCallback((ids?: unknown) => {
    const list = Array.isArray(ids) ? (ids as string[]) : scopedActivityRef.current.map((a) => a.id);
    if (!list.length) return;
    const set = new Set(list);
    const removed = activityRef.current.filter((a) => set.has(a.id));
    setActivity((xs) => xs.filter((a) => !set.has(a.id)));
    const archived = store.clearInbox(list);
    archived.catch((e) => { reportError(e); toastError("Couldn't clear the inbox."); putBackActivity(removed); });
    offerArchiveUndo({ items: removed, archived }, Array.isArray(ids) ? `Archived ${plural(list.length, "item")}` : "Inbox cleared");
  }, [toastError, putBackActivity, offerArchiveUndo]);

  /* ---- profile ---- */
  const uploadAvatar = useCallback((file: File) => store.uploadAvatar(userIdRef.current, file), []);

  // leave avatarUrl out to keep the saved photo (a stale copy of the profile —
  // another tab, or before the photo loaded — must not put an old one back)
  const saveProfile = useCallback(async (draft: Omit<ProfileDraft, "avatarUrl"> & { avatarUrl?: string | null }) => {
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

  const saveNotifyPrefs = useCallback((prefs: Record<string, boolean>) => {
    setProfile((p) => p ? { ...p, notifyPrefs: prefs } : p);
    store.updateNotifyPrefs(userIdRef.current, prefs).catch((e) => { reportError(e, { op: "updateNotifyPrefs" }); toastError("Couldn't save notification preferences."); });
  }, [toastError]);

  // download all of the user's data as JSON (user-initiated, their own data)
  const exportData = useCallback(() => {
    const payload = {
      app: "Kanbo",
      exportedAt: new Date().toISOString(),
      profile,
      workspaces,
      members: wsMembers.map((m) => ({ workspaceId: m.workspaceId, userId: m.userId, name: getMember(m.userId ?? "")?.name || m.name, email: m.email, role: m.role, status: m.status })),
      projects,
      sections,
      customFields,
      tags,
      tasks: tasksRef.current ?? [],
      goals,
      portfolios,
      statusUpdates,
      automationRules,
      forms,
      savedSearches,
      activity,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kanbo-export-${toLocalISO(new Date())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toastSuccess("Your data is downloading");
  }, [profile, workspaces, wsMembers, projects, sections, customFields, tags, goals, portfolios, statusUpdates, automationRules, forms, savedSearches, activity, toastSuccess]);

  const deleteAccount = useCallback(async () => {
    await store.deleteAccount();
    // wipe local state and bounce to the signed-out site (a deleted account's
    // unsynced edits can never sync, so don't ask about them)
    if (auth.configured) await auth.signOut({ discardUnsynced: true });
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
      // the provider sends the browser back here (?calendar=finish) and the app finishes the connection
      const url = await store.getCalendarAuthUrl(provider, { finishInApp: true });
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

  // deep link: open ?task=<id> once tasks are loaded — in its own workspace —
  // then clean the URL. Say so when the task can't be opened.
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current || tasks === null) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const tid = params.get("task");
      if (!tid) return;
      deepLinkDone.current = true;
      const t = tasks.find((x) => x.id === tid);
      if (t) { setWorkspace(t.workspaceId ?? null); setDetailId(tid); }
      else toastInfo("That task doesn't exist any more, or you don't have access to it.");
      params.delete("task");
      window.history.replaceState({}, "", window.location.pathname + (params.toString() ? "?" + params : ""));
    } catch { /* ignore */ }
  }, [tasks, toastInfo]);

  // load connected calendars on sign-in, and handle the OAuth round-trip return
  useEffect(() => {
    if (!store.configured || !authUserId) return;
    refreshCalendar();
    const params = new URLSearchParams(window.location.search);
    const cal = params.get("calendar");
    const state = params.get("calendar_state"), code = params.get("calendar_code");
    // clean the URL first, so a reload (or the back button) never replays the one-time code
    if (cal) {
      ["calendar", "calendar_state", "calendar_code", "fresh"].forEach((k) => params.delete(k));
      const qs = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
    }
    if (cal === "finish") {
      if (!state || !code) toastError("Couldn't connect that calendar. Please try again.");
      else store.finishCalendarConnect(state, code).then(({ provider, accountEmail }) => {
        toastSuccess(`${provider === "microsoft" ? "Outlook" : "Google"} calendar connected${accountEmail ? ` (${accountEmail})` : ""}`);
        setRouteRaw({ view: "calendar" });
        refreshCalendar();
      }, (e) => {
        reportError(e, { op: "finishCalendarConnect" });
        toastError(e instanceof Error && e.message ? e.message : "Couldn't connect that calendar. Please try again.");
      });
    }
    // the older hand-off, which the server still uses for legacy connections
    if (cal === "connected") { toastSuccess("Calendar connected"); setRouteRaw({ view: "calendar" }); }
    if (cal === "error") toastError("Couldn't connect that calendar. Please try again.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId]);

  /* ================= task writes =================
     Every task mutation is optimistic, then saved. If the save fails the change
     is rolled back on screen (only the fields that write still owns) and a toast
     offers Retry — nothing ever "looks saved" and silently reverts later. */

  /** A section chosen while it was still being created: wait for its real id. */
  const realSectionId = useCallback((id: string | undefined): Promise<string | undefined> => {
    if (!id || !id.startsWith("tmp-")) return Promise.resolve(id);
    const done = sectionAliasRef.current.get(id); if (done) return Promise.resolve(done);
    const p = tmpSectionRef.current.get(id);
    return p ? p.then((x) => x, () => undefined) : Promise.resolve(undefined);
  }, []);
  const withRealSections = useCallback(<T extends Partial<Task>>(row: T): Promise<T> => {
    const sec = row.sectionId, my = row.mySectionId;
    if (!sec?.startsWith("tmp-") && !my?.startsWith("tmp-")) return Promise.resolve(row);
    return Promise.all([realSectionId(sec), realSectionId(my)]).then(([s, m]) => ({
      ...row, ...("sectionId" in row ? { sectionId: s } : {}), ...("mySectionId" in row ? { mySectionId: m } : {}),
    }));
  }, [realSectionId]);

  /** Save one task patch — after the task's own insert if it is still being created.
   *  Resolves to the id that was written (null when it will be saved with a retried insert). */
  const writeTask = useCallback((id: string, patch: Partial<Task>): Promise<string | null> => {
    if (unsavedRef.current.has(id)) return Promise.resolve(null); // its insert failed: the row, edit included, is saved on Retry
    const creating = createsRef.current.get(id);
    const send = (sid: string) => withRealSections(patch).then((p) => store.updateTask(sid, p)).then(() => sid);
    if (creating) return creating.then(send, () => null);
    return send(id);
  }, [withRealSections]);

  const applyLocal = useCallback((patches: Map<string, Partial<Task>>) => {
    setTasks((ts) => ts && ts.map((t) => { const p = patches.get(t.id); return p ? { ...t, ...p } : t; }));
    patches.forEach((p, id) => noteWrite(id, p));
  }, [noteWrite]);

  const commitRef = useRef<(patches: Map<string, Partial<Task>>, prevById: Map<string, Task>, opts?: CommitOpts) => Promise<boolean>>(() => Promise.resolve(true));
  commitRef.current = (patches, prevById, opts = {}) => {
    const seq = ++writeSeqRef.current;
    patches.forEach((p, id) => Object.keys(p).forEach((k) => fieldSeqRef.current.set(`${id}:${k}`, seq)));
    const entries = [...patches];
    const written: (string | null)[] = [];
    return Promise.all(entries.map(([id, p], i) => writeTask(id, p).then((sid) => { written[i] = sid; return true; }, (e) => { reportError(e, { op: opts.op ?? "updateTask" }); return false; })))
      .then((oks) => {
        const me = userIdRef.current;
        // assignment emails go out once the new assignee is actually saved
        if (opts.notify !== false) entries.forEach(([id, p], i) => {
          const prev = prevById.get(id), sid = written[i];
          if (!oks[i] || !sid || !prev || !p.assigneeId || p.assigneeId === prev.assigneeId || p.assigneeId === me) return;
          store.notify({ kind: "assigned", taskId: sid, taskTitle: p.title ?? prev.title, recipientIds: [p.assigneeId] });
        });
        const failed = entries.filter((_, i) => !oks[i]);
        if (!failed.length) return true;
        // roll back only the fields this write still owns — a newer edit to the same field wins
        const restore = new Map<string, Partial<Task>>();
        for (const [id, p] of failed) {
          const prev = prevById.get(id); if (!prev) continue;
          const keys = Object.keys(p).filter((k) => fieldSeqRef.current.get(`${id}:${k}`) === seq);
          keys.forEach((k) => fieldSeqRef.current.delete(`${id}:${k}`));
          if (keys.length) { restore.set(id, pickFields(prev, keys)); clearWrite(id, keys); }
        }
        if (restore.size) setTasks((ts) => ts && ts.map((t) => { const r = restore.get(t.id); return r ? { ...t, ...r } : t; }));
        opts.onFailed?.(failed.map(([id]) => id));
        const again = new Map(failed);
        toastAction(opts.failMessage ? opts.failMessage(failed.length) : failed.length === 1 ? "Couldn't save — change undone" : `Couldn't save ${failed.length} changes — undone`, "Retry", () => {
          if (opts.retry) { opts.retry(); return; }
          const cur = tasksRef.current ?? [];
          const prev2 = new Map(cur.filter((t) => again.has(t.id)).map((t) => [t.id, t]));
          const still = new Map([...again].filter(([id]) => prev2.has(id)));
          if (!still.size) return;
          applyLocal(still);
          commitRef.current(still, prev2, opts);
        }, UNDO_MS);
        return false;
      });
  };
  const commit = useCallback((patches: Map<string, Partial<Task>>, prevById: Map<string, Task>, opts?: CommitOpts) => commitRef.current(patches, prevById, opts), []);

  /** Optimistically apply per-task patches, then save them (rolled back + Retry on failure). */
  const updateTasks = useCallback((patches: Map<string, Partial<Task>>, opts?: CommitOpts): Promise<boolean> => {
    if (!patches.size) return Promise.resolve(true);
    const cur = tasksRef.current ?? [];
    const prevById = new Map(cur.filter((t) => patches.has(t.id)).map((t) => [t.id, t]));
    applyLocal(patches);
    return commit(patches, prevById, opts);
  }, [applyLocal, commit]);

  /* ---- creating tasks ---- */
  const markUnsaved = useCallback((rows: Task[], e?: unknown) => {
    if (!rows.length) return;
    rows.forEach((r) => unsavedRef.current.add(r.id));
    setUnsavedIds([...unsavedRef.current]);
    const now = Date.now();
    if (now - lastUnsavedToastRef.current < 2000) return; // one toast per burst (an import can fail many rows at once)
    lastUnsavedToastRef.current = now;
    const why = (e as Error)?.message;
    toastAction(rows.length === 1 ? `Couldn't save “${rows[0].title}”${why ? ` — ${why}` : ""}` : `Couldn't save ${plural(rows.length, "task")}`, "Retry", () => retryUnsavedRef.current(), UNDO_MS);
  }, [toastAction]);

  /** A create resolved: keep the row through reloads for 30s more, and adopt a server-assigned id. */
  const settleCreate = useCallback((clientId: string, serverId: string) => {
    createsRef.current.delete(clientId);
    const until = Date.now() + 30000;
    pendingTasksRef.current = pendingTasksRef.current.map((p) => (p.id === clientId ? { ...p, until } : p));
    if (serverId !== clientId) remapTaskId(clientId, serverId);
  }, [remapTaskId]);

  const startCreate = useCallback((t: Task, opts: CreateOpts = {}): Promise<string | null> => {
    // a sub-task waits for its parent's insert (tasks.parent_id is a real foreign key)
    const parentWait = t.parentId ? createsRef.current.get(t.parentId) : undefined;
    cancelledRef.current.delete(t.id);
    const slot = opts.slot; // big batches (import, duplicate project) take turns — a few inserts at a time
    const run: Promise<string> = (parentWait ? parentWait.then((pid) => ({ ...t, parentId: pid })) : Promise.resolve(t))
      .then((row) => withRealSections(row))
      .then(async (row) => {
        if (slot) await slot.acquire();
        try {
          if (cancelledRef.current.has(t.id)) throw new Error("cancelled"); // deleted while waiting for its parent
          const saved = await store.createTask(row, userIdRef.current);
          // the insert doesn't carry completion/archive stamps: write them straight
          // after (and before any edit that was waiting for this insert), so a task
          // created straight into Done keeps its completion date after a reload
          const stamps: Partial<Task> = {};
          if (row.completedAt) stamps.completedAt = row.completedAt;
          if (row.archivedAt) stamps.archivedAt = row.archivedAt;
          if (Object.keys(stamps).length) await store.updateTask(saved.id, stamps).catch(saveFailed("createTask-stamps", `“${t.title}” was saved, but not when it was completed.`));
          return saved;
        } finally { slot?.release(); }
      })
      .then((saved) => {
        settleCreate(t.id, saved.id);
        if (opts.log !== false) log("created", { id: saved.id, title: t.title }, "Task created");
        // assignment email when a task is created for someone else (in-app is the DB trigger)
        if (opts.notify !== false && t.assigneeId && t.assigneeId !== userIdRef.current) {
          store.notify({ kind: "assigned", taskId: saved.id, taskTitle: t.title, recipientIds: [t.assigneeId] });
        }
        return saved.id;
      });
    createsRef.current.set(t.id, run);
    return run.catch((e) => {
      createsRef.current.delete(t.id);
      if (cancelledRef.current.has(t.id)) return null; // it was deleted meanwhile — nothing to save
      reportError(e, { op: "createTask" });
      markUnsaved([t], e);
      return null;
    });
  }, [withRealSections, settleCreate, log, markUnsaved, saveFailed]);

  /** Show a new task at once and save it. Resolves to its saved id (null if the save failed). */
  const persistTask = useCallback((raw: Task, opts: CreateOpts = {}): Promise<string | null> => {
    const me = userIdRef.current;
    const t: Task = {
      ...raw,
      id: isTaskId(raw.id) ? raw.id : newTaskId(),
      assigneeId: raw.assigneeId === "m-self" ? me : raw.assigneeId,
      // a task lives in its project's workspace
      workspaceId: projectWs(raw.projectId),
      // new tasks sort to the bottom of their board column
      position: raw.position ?? Date.now(),
      // created straight into Done (a Done column, an import): it was completed today
      completedAt: raw.status === "done" ? raw.completedAt ?? toLocalISO(new Date()) : raw.completedAt,
    };
    setTasks((ts) => (ts ? [t, ...ts] : [t]));
    // visible to callbacks straight away (the next render sets the same list), so a
    // follow-up in this same tick — e.g. taking back a just-spawned recurrence — finds it
    tasksRef.current = [t, ...(tasksRef.current ?? [])];
    pendingTasksRef.current = [{ id: t.id, task: t, until: null }, ...pendingTasksRef.current.filter((p) => p.id !== t.id)];
    return startCreate(t, opts);
  }, [startCreate]);

  const retryUnsaved = useCallback(() => {
    const ids = unsavedRef.current; if (!ids.size) return;
    const rows = (tasksRef.current ?? []).filter((t) => ids.has(t.id));
    ids.clear(); setUnsavedIds([]);
    // parents first, so each sub-task can wait for its parent
    for (const level of parentsFirst(rows)) for (const r of level) {
      pendingTasksRef.current = [{ id: r.id, task: r, until: null }, ...pendingTasksRef.current.filter((p) => p.id !== r.id)];
      startCreate(r, { log: false });
    }
  }, [startCreate]);
  retryUnsavedRef.current = retryUnsaved;

  const discardUnsaved = useCallback(() => {
    const ids = new Set(unsavedRef.current); if (!ids.size) return;
    if (!window.confirm(`Discard ${plural(ids.size, "unsaved task")}? ${ids.size === 1 ? "It never" : "They never"} reached the server, so ${ids.size === 1 ? "it's" : "they're"} gone for good.`)) return;
    unsavedRef.current.clear(); setUnsavedIds([]);
    setTasks((ts) => ts && ts.filter((t) => !ids.has(t.id)));
    dropPending(ids);
  }, [dropPending]);

  /** Copy a legacy checklist onto a task once it exists on the server (ticked items stay ticked). */
  const copyChecklist = useCallback((created: Promise<string | null>, items: Subtask[]) => {
    if (!items.length) return;
    created.then((sid) => {
      if (!sid) return;
      return Promise.all(items.map((s, i) => store.addSubtask(sid, s.title, i)
        .then((sub) => (s.done ? store.setSubtaskDone(sub.id, true).then(() => ({ ...sub, done: true })) : sub))))
        .then((subs) => setTasks((ts) => ts && ts.map((x) => (x.id === sid ? { ...x, subtasks: subs } : x))));
    }).catch(saveFailed("copyChecklist", "Couldn't copy the checklist."));
  }, [saveFailed]);

  /* ---- deleting tasks ---- */
  /** Delete rows on the server (roots only — the database cascades to sub-tasks). Resolves to the root ids that failed. */
  const serverDelete = useCallback((rows: Task[]): Promise<string[]> => {
    const ids = new Set(rows.map((r) => r.id));
    // anything still waiting to be inserted must not be inserted after all
    rows.forEach((r) => { if (createsRef.current.has(r.id)) cancelledRef.current.add(r.id); });
    // inserts that failed never reached the server — nothing to delete
    const live = rows.filter((r) => !unsavedRef.current.delete(r.id));
    if (live.length !== rows.length) setUnsavedIds([...unsavedRef.current]);
    const roots = live.filter((r) => !r.parentId || !ids.has(r.parentId));
    return runLimited(roots, 6, (r) => {
      const creating = createsRef.current.get(r.id);
      return creating ? creating.then((sid) => store.deleteTask(sid), () => undefined) : store.deleteTask(r.id);
    }).then((oks) => roots.filter((_, i) => !oks[i]).map((r) => r.id));
  }, []);

  /** Remove tasks (and all their sub-tasks) now, send the delete after the Undo window —
   *  or straight away if the page is closed (or, on a phone, put in the background),
   *  so it can't be lost. */
  const removeTasks = useCallback((roots: Task[], label: string) => {
    const all = tasksRef.current ?? [];
    const rootIds = new Set(roots.map((r) => r.id));
    const rows = [...roots, ...descendantsOf([...rootIds], all).filter((k) => !rootIds.has(k.id))];
    const ids = rows.map((r) => r.id), idSet = new Set(ids);
    const wasPending = new Set(pendingTasksRef.current.filter((p) => idSet.has(p.id)).map((p) => p.id));
    setTasks((ts) => ts && ts.filter((x) => !idSet.has(x.id)));
    // hidden from reloads for the whole Undo window, and a while after the delete goes out
    noteDelete(ids, UNDO_MS + WRITE_TTL); dropPending(idSet);
    const putBack = (subset: Task[]) => {
      clearWrite(subset.map((r) => r.id));
      setTasks((ts) => { const have = new Set((ts ?? []).map((x) => x.id)); const back = subset.filter((r) => !have.has(r.id)); return ts ? [...back, ...ts] : back; });
      const until = Date.now() + 30000;
      subset.forEach((r) => { if (wasPending.has(r.id)) pendingTasksRef.current = [{ id: r.id, task: r, until }, ...pendingTasksRef.current.filter((p) => p.id !== r.id)]; });
    };
    const key = ++delSeqRef.current;
    let state: "waiting" | "sent" | "undone" = "waiting";
    let sent: Promise<string[]> = Promise.resolve([]);
    const send = () => {
      if (state !== "waiting") return;
      state = "sent"; clearTimeout(timer); pendingDeletesRef.current.delete(key);
      noteDelete(ids);
      sent = serverDelete(rows);
      sent.then((failed) => {
        if (state === "undone") return;
        if (!failed.length) {
          log("deleted", { id: null, title: roots.length === 1 ? roots[0].title : plural(roots.length, "task") }, roots.length === 1 ? "Task deleted" : `Deleted ${plural(roots.length, "task")}`);
          return;
        }
        const f = new Set(failed);
        const failedTrees = new Set([...failed, ...descendantsOf(failed, rows).map((d) => d.id)]);
        putBack(rows.filter((r) => failedTrees.has(r.id)));
        const first = rows.find((r) => f.has(r.id));
        toastAction(failed.length === 1 ? `Couldn't delete “${first?.title ?? "that task"}” — it's been put back` : `Couldn't delete ${plural(failed.length, "task")} — they've been put back`, "Retry", () => {
          const again = (tasksRef.current ?? []).filter((t) => f.has(t.id));
          if (again.length) removeTasksRef.current(again, again.length === 1 ? `Deleted “${again[0].title}”` : `Deleted ${plural(again.length, "task")}`);
        }, UNDO_MS);
      });
    };
    const timer = setTimeout(send, UNDO_MS);
    pendingDeletesRef.current.set(key, send);
    toastAction(label, "Undo", () => {
      if (state === "undone") return;
      const alreadySent = state === "sent";
      state = "undone"; clearTimeout(timer); pendingDeletesRef.current.delete(key);
      putBack(rows);
      if (!alreadySent) return;
      // The delete already went out (the page was closed or backgrounded). Rows whose
      // delete failed are still on the server — they're simply back. The rest are
      // saved again as copies, with their checklist and blocked-by links.
      sent.then((failed) => {
        const kept = new Set([...failed, ...descendantsOf(failed, rows).map((d) => d.id)]);
        const gone = rows.filter((r) => !kept.has(r.id)).map((r) => ({ ...r, comments: 0 }));
        if (!gone.length) return;
        const goneIds = new Set(gone.map((r) => r.id));
        setTasks((ts) => ts && ts.map((x) => (goneIds.has(x.id) ? { ...x, comments: 0 } : x))); // their comments didn't come back
        gone.forEach((r) => { pendingTasksRef.current = [{ id: r.id, task: r, until: null }, ...pendingTasksRef.current.filter((p) => p.id !== r.id)]; });
        const created = new Map<string, Promise<string | null>>();
        for (const level of parentsFirst(gone)) for (const r of level) {
          const p = startCreate(r, { log: false, notify: false });
          created.set(r.id, p);
          copyChecklist(p, r.subtasks);
        }
        // blocked-by links in both directions — the delete removed them on the server
        const onScreen = new Set((tasksRef.current ?? []).map((x) => x.id));
        const links: [string, string][] = [];
        gone.forEach((r) => (r.dependencies ?? []).forEach((d) => { if (onScreen.has(d) || goneIds.has(d)) links.push([r.id, d]); }));
        (tasksRef.current ?? []).forEach((x) => { if (!goneIds.has(x.id)) (x.dependencies ?? []).forEach((d) => { if (goneIds.has(d)) links.push([x.id, d]); }); });
        const sidOf = (id: string): Promise<string | null> => created.get(id) ?? createsRef.current.get(id) ?? Promise.resolve(id);
        runLimited(links, 4, ([a, b]) => Promise.all([sidOf(a), sidOf(b)]).then(([sa, sb]) => {
          if (!sa || !sb) throw new Error("restore: a task in the link wasn't saved");
          return store.addDependency(sa, sb);
        })).then((oks) => { const n = oks.filter((ok) => !ok).length; if (n) toastError(`${plural(n, "dependency link")} couldn't be restored.`); });
        toastInfo(gone.length === 1
          ? `Restored “${gone[0].title}” as a copy — it has a new link, and its comments, attachments and history couldn't be recovered.`
          : `Restored ${plural(gone.length, "task")} as copies — they have new links, and their comments, attachments and history couldn't be recovered.`);
      });
    }, UNDO_MS);
  }, [noteDelete, dropPending, clearWrite, serverDelete, log, toastAction, toastInfo, toastError, startCreate, copyChecklist]);
  removeTasksRef.current = removeTasks;

  // A pending delete must not be lost when the page is closed, reloaded or frozen.
  // A phone may discard a backgrounded tab without warning, so there a hidden tab
  // sends at once. On a computer a background tab keeps running (its Undo timer
  // still fires), so a quick switch to another tab keeps Undo lossless.
  useEffect(() => {
    const flush = () => { [...pendingDeletesRef.current.values()].forEach((send) => send()); };
    let touch = false;
    try { touch = window.matchMedia("(hover: none) and (pointer: coarse)").matches; } catch { /* old browser: treat as a computer */ }
    const onVis = () => { if (touch && document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("freeze", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("freeze", flush); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  /* ---- status side effects (one path for checkbox, menu, board and bulk) ---- */
  // automation: apply enabled rules for the task's project (no hot-path mutation, no loops)
  const applyRules = useCallback((t: Task, trigger: AutomationRule["trigger"]): Task => {
    const rules = rulesRef.current.filter((r) => r.enabled && r.trigger === trigger && r.projectId === t.projectId);
    if (rules.length === 0) return t;
    let next = { ...t };
    for (const r of rules) for (const a of r.actions) {
      if (!a.value) continue;
      if (a.type === "set_priority") next = { ...next, priority: a.value as Task["priority"] };
      else if (a.type === "set_assignee") next = { ...next, assigneeId: a.value };
      else if (a.type === "set_section") next = { ...next, sectionId: a.value };
      else if (a.type === "add_tag") {
        // older rules stored the tag's name, not its id: resolve it when the rule runs
        const tagId = tagsRef.current[a.value] ? a.value : (resolveTagId(a.value, tagsRef.current) ?? a.value);
        next = { ...next, tags: [...new Set([...(next.tags ?? []), tagId])] };
      }
    }
    return next;
  }, []);
  const applyAutomation = useCallback((t: Task): Task => applyRules(t, "task_created"), [applyRules]);

  /** Spawn the next occurrence of a recurring task right away (so closing the tab
   *  can't lose it); Undo or reopening removes it again. */
  const spawnRecurrence = useCallback((t: Task) => {
    if (spawnedRef.current.has(t.id)) return;
    const rows = buildRecurrence(t, tasksRef.current ?? []);
    if (!rows) return;
    spawnedRef.current.set(t.id, rows[0].id);
    rows.forEach((r, i) => {
      const created = persistTask({ ...r, subtasks: [] }, { log: false, notify: false });
      if (i === 0) copyChecklist(created, t.subtasks.map((s) => ({ ...s, done: false })));
    });
  }, [persistTask, copyChecklist]);
  /** Take back the occurrence spawned when `id` was completed here. True when it was removed. */
  const unspawnRecurrence = useCallback((id: string): boolean => {
    const nextId = spawnedRef.current.get(id); if (!nextId) return false;
    spawnedRef.current.delete(id);
    const all = tasksRef.current ?? [];
    const next = all.find((x) => x.id === nextId);
    if (!next || next.status !== "todo" || next.comments > 0) return false; // someone already started on it — keep it
    const rows = [next, ...descendantsOf([nextId], all)];
    const ids = new Set(rows.map((r) => r.id));
    setTasks((ts) => ts && ts.filter((x) => !ids.has(x.id)));
    noteDelete([...ids]); dropPending(ids);
    serverDelete(rows).then((failed) => { if (failed.length) reportError(new Error("unspawn recurrence failed"), { op: "unspawnRecurrence" }); });
    return true;
  }, [noteDelete, dropPending, serverDelete]);

  /** Everything a real status change does, from every entry point: stamps or
   *  clears completedAt (only on a real transition), runs "status changed" and
   *  "task completed" automations, and spawns/unspawns recurrences. The activity
   *  row waits in `fx` until the save lands (see updateWithStatus).
   *  Returns the extra fields to save alongside the status. */
  const onStatusChange = useCallback((prev: Task, next: Task, fx: StatusFx): Partial<Task> => {
    const { completing, reopening, patch: extra } = statusTransition(prev, next.status);
    const base: Task = { ...next, ...extra };
    let auto = applyRules(base, "status_changed");
    if (completing) auto = applyRules(auto, "task_completed");
    if (auto.priority !== base.priority) extra.priority = auto.priority;
    if (auto.assigneeId !== base.assigneeId) extra.assigneeId = auto.assigneeId;
    if (auto.sectionId !== base.sectionId) extra.sectionId = auto.sectionId;
    if ((auto.tags ?? []).join() !== (base.tags ?? []).join()) extra.tags = auto.tags;
    if (completing) {
      fx.logs.set(prev.id, () => log("completed", prev, "Marked complete"));
      fx.completing.add(prev.id); spawnRecurrence(prev);
    } else if (reopening) {
      fx.logs.set(prev.id, () => log("reopened", prev, "Reopened"));
      if (unspawnRecurrence(prev.id)) fx.unspawned.set(prev.id, prev);
    } else fx.logs.set(prev.id, () => log("status", prev, `Moved to ${STATUS_META[next.status].label}`));
    return extra;
  }, [applyRules, log, spawnRecurrence, unspawnRecurrence]);

  /** Dependency enforcement: confirm before completing tasks that are still blocked. */
  const confirmCompleteBlocked = useCallback((rows: Task[]): boolean => {
    const byId = new Map((tasksRef.current ?? []).map((t) => [t.id, t]));
    const openBlockers = (t: Task) => (t.dependencies ?? []).filter((d) => { const b = byId.get(d); return !!b && b.status !== "done"; }).length;
    const blocked = rows.filter((t) => openBlockers(t) > 0);
    if (!blocked.length) return true;
    if (rows.length === 1) { const n = openBlockers(rows[0]); return window.confirm(`“${rows[0].title}” is blocked by ${plural(n, "unfinished task")}. Mark it complete anyway?`); }
    return window.confirm(`${plural(blocked.length, "task")} ${blocked.length === 1 ? "is" : "are"} blocked by unfinished tasks. Complete ${blocked.length === 1 ? "it" : "them"} anyway?`);
  }, []);

  /** Adjust a patch for where the task is going: the workspace follows the project,
   *  a section from the old project is cleared, and people who can't see the task
   *  there are dropped. Mutates `patch`; returns a note for the user, if any. */
  const retarget = useCallback((prev: Task, patch: Partial<Task>): string | null => {
    if (patch.projectId !== undefined && patch.projectId !== prev.projectId) {
      if (patch.workspaceId === undefined) patch.workspaceId = projectWs(patch.projectId);
      if (!("sectionId" in patch)) patch.sectionId = undefined;
    }
    if (!("workspaceId" in patch) || (patch.workspaceId ?? null) === (prev.workspaceId ?? null)) return null;
    const toWs = patch.workspaceId ?? null, me = userIdRef.current;
    const visible = new Set(toWs === null ? [] : wsMembersRef.current.filter((m) => (m.workspaceId ?? null) === toWs && m.status === "active" && m.userId).map((m) => m.userId as string));
    if (toWs !== null && visible.size === 0) return null; // member list unavailable — let the server decide
    visible.add(me);
    const collabs = patch.collaborators ?? prev.collaborators ?? [];
    if (collabs.some((x) => !visible.has(x))) patch.collaborators = collabs.filter((x) => visible.has(x));
    const followers = patch.followers ?? prev.followers ?? [];
    if (followers.some((x) => !visible.has(x))) patch.followers = followers.filter((x) => visible.has(x));
    const assignee = patch.assigneeId ?? prev.assigneeId;
    if (assignee && !visible.has(assignee)) {
      patch.assigneeId = me;
      const where = workspacesRef.current.find((w) => w.id === toWs)?.name || "Personal";
      return `${getMember(assignee)?.name || "The assignee"} isn't in ${where}, so “${prev.title}” is now assigned to you.`;
    }
    return null;
  }, []);

  /** Sub-tasks go wherever their parent goes (project, workspace) and are archived with it. */
  const cascadeToDescendants = useCallback((prev: Task, patch: Partial<Task>, all: Task[], into: Map<string, Partial<Task>>) => {
    const moved = ("projectId" in patch && patch.projectId !== prev.projectId) || ("workspaceId" in patch && (patch.workspaceId ?? null) !== (prev.workspaceId ?? null));
    const archiving = "archivedAt" in patch && patch.archivedAt !== prev.archivedAt;
    if (!moved && !archiving) return;
    for (const d of descendantsOf([prev.id], all)) {
      if (into.has(d.id)) continue;
      const dp: Partial<Task> = {};
      if (moved) {
        if ("projectId" in patch) dp.projectId = patch.projectId;
        if ("workspaceId" in patch) dp.workspaceId = patch.workspaceId;
        dp.sectionId = undefined;
        retarget(d, dp);
      }
      if (archiving && (patch.archivedAt ? !d.archivedAt : d.archivedAt === prev.archivedAt)) dp.archivedAt = patch.archivedAt;
      if (Object.keys(dp).length) into.set(d.id, dp);
    }
  }, [retarget]);

  /** Save patches that include status changes: the activity rows are logged once
   *  their save lands, and a save that fails takes its recurrence back (or puts
   *  back the occurrence a failed reopen removed) along with the rollback. */
  const updateWithStatus = useCallback((patches: Map<string, Partial<Task>>, fx: StatusFx, opts: CommitOpts = {}): Promise<boolean> => {
    const failed = new Set<string>();
    return updateTasks(patches, {
      ...opts,
      onFailed: (ids) => {
        ids.forEach((id) => {
          failed.add(id);
          if (fx.completing.has(id)) unspawnRecurrence(id);
          const reopened = fx.unspawned.get(id); if (reopened) spawnRecurrence(reopened);
        });
        opts.onFailed?.(ids);
      },
    }).then((ok) => { fx.logs.forEach((write, id) => { if (!failed.has(id)) write(); }); return ok; });
  }, [updateTasks, unspawnRecurrence, spawnRecurrence]);

  const toggleTask = useCallback((id: string) => {
    const t = tasksRef.current?.find((x) => x.id === id); if (!t) return;
    if (denyGuest([t.workspaceId])) return;
    const completing = t.status !== "done";
    if (completing && !confirmCompleteBlocked([t])) return;
    const status: Status = completing ? "done" : "todo";
    const fx = newStatusFx();
    const patch: Partial<Task> = { status, ...onStatusChange(t, { ...t, status }, fx) };
    updateWithStatus(new Map([[id, patch]]), fx, {
      // run the whole toggle again, side effects included (the failed one was rolled back)
      retry: () => { const cur = tasksRef.current?.find((x) => x.id === id); if (cur && cur.status === t.status) toggleTask(id); },
    });
    if (completing) {
      // its Undo always works (it puts the old fields back), so it can wait while you read
      toastAction(`Completed “${t.title}”`, "Undo", () => {
        unspawnRecurrence(id);
        updateTasks(new Map([[id, pickFields(t, Object.keys(patch))]]), { notify: false });
      }, {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, confirmCompleteBlocked, onStatusChange, updateWithStatus, updateTasks, unspawnRecurrence, toastAction]);

  const patchTaskRef = useRef<(id: string, patch: Partial<Task>) => void>(() => {});
  const bulkPatchRef = useRef<(ids: string[], patch: Partial<Task>) => void>(() => {});
  const patchTask = useCallback((id: string, patchIn: Partial<Task>) => {
    const all = tasksRef.current ?? [];
    const prev = all.find((t) => t.id === id); if (!prev) return;
    const patch: Partial<Task> = { ...patchIn };
    // following a task is open to everyone who can see it (guests included)
    const onlyFollow = Object.keys(patch).length > 0 && Object.keys(patch).every((k) => k === "followers");
    if (!onlyFollow && denyGuest([prev.workspaceId])) return;
    // re-picking the same status must never restamp completedAt
    if ("status" in patch && (!patch.status || patch.status === prev.status)) { delete patch.status; delete patch.completedAt; }
    if (patch.status === "done" && !confirmCompleteBlocked([prev])) return;
    const note = retarget(prev, patch);
    if ("workspaceId" in patch && (patch.workspaceId ?? null) !== (prev.workspaceId ?? null) && denyGuest([patch.workspaceId])) return;
    const fx = newStatusFx();
    if (patch.status) Object.assign(patch, onStatusChange(prev, { ...prev, ...patch }, fx));
    if (!Object.keys(patch).length) return;
    const patches = new Map<string, Partial<Task>>([[id, patch]]);
    cascadeToDescendants(prev, patch, all, patches);
    // a failed status change is retried as a whole, so its side effects run again too
    if (fx.logs.size) updateWithStatus(patches, fx, { retry: () => patchTaskRef.current(id, patchIn) });
    else updateTasks(patches);
    if (note) toastInfo(note);
  }, [denyGuest, confirmCompleteBlocked, retarget, onStatusChange, cascadeToDescendants, updateWithStatus, updateTasks, toastInfo]);
  patchTaskRef.current = patchTask;

  // follow/unfollow a task (followers get its activity in their inbox)
  const followSeqRef = useRef(new Map<string, number>());
  const toggleFollow = useCallback((id: string) => {
    const t = tasksRef.current?.find((x) => x.id === id); if (!t) return;
    const uid = userIdRef.current;
    const mine = (f: string) => f.toLowerCase() === uid.toLowerCase();
    const follow = !(t.followers ?? []).some(mine); // what the person asked for; the server never toggles
    const apply = (list: string[], on: boolean) => (on ? (list.some(mine) ? list : [...list, uid]) : list.filter((f) => !mine(f)));
    const now = () => tasksRef.current?.find((x) => x.id === id)?.followers ?? [];
    const seq = (followSeqRef.current.get(id) ?? 0) + 1; followSeqRef.current.set(id, seq);
    const latest = () => followSeqRef.current.get(id) === seq; // a quicker second click wins
    applyLocal(new Map([[id, { followers: apply(t.followers ?? [], follow) }]]));
    store.setTaskFollow(id, follow).then((followers) => {
      if (!latest()) return;
      if (followers) { applyLocal(new Map([[id, { followers }]])); return; }
      // demo mode, offline or older edits to this task still queued, or 0042 not run yet:
      // a normal save, rolled back to the list before the click (with Retry) if it fails
      commit(new Map([[id, { followers: apply(now(), follow) }]]), new Map([[id, t]]));
    }, (e) => {
      reportError(e, { op: "setTaskFollow" });
      if (!latest()) return;
      applyLocal(new Map([[id, { followers: apply(now(), !follow) }]]));
      toastError(follow ? `Couldn't follow “${t.title}”` : `Couldn't unfollow “${t.title}”`);
    });
  }, [applyLocal, commit, toastError]);

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

  // ---- bulk actions (multi-select) ----
  const bulkPatch = useCallback((ids: string[], patchIn: Partial<Task>) => {
    if (!ids.length) return;
    const all = tasksRef.current ?? [];
    const rows = ids.map((id) => all.find((t) => t.id === id)).filter((t): t is Task => !!t);
    if (!rows.length) return;
    if (denyGuest(rows.map((r) => r.workspaceId))) return;
    if (patchIn.projectId && denyGuest([projectWs(patchIn.projectId)])) return;
    if (patchIn.status === "done" && !confirmCompleteBlocked(rows.filter((r) => r.status !== "done"))) return;
    const patches = new Map<string, Partial<Task>>();
    const notes = new Set<string>();
    const completed: string[] = [];
    const fx = newStatusFx();
    for (const prev of rows) {
      const p: Partial<Task> = { ...patchIn };
      // per task: completedAt only moves for tasks whose status really changes
      if ("status" in p && (!p.status || p.status === prev.status)) { delete p.status; delete p.completedAt; }
      const note = retarget(prev, p); if (note) notes.add(note);
      if (p.status) { if (p.status === "done") completed.push(prev.id); Object.assign(p, onStatusChange(prev, { ...prev, ...p }, fx)); }
      if (Object.keys(p).length) { patches.set(prev.id, p); cascadeToDescendants(prev, p, all, patches); }
    }
    if (!patches.size) { toastInfo(`Nothing to change — ${rows.length === 1 ? "it's" : "they're"} already like that.`); return; }
    if (fx.logs.size) {
      // retry just the tasks whose save failed, as a fresh bulk change (side effects included)
      const failedIds: string[] = [];
      const picked = new Set(rows.map((r) => r.id));
      updateWithStatus(patches, fx, {
        onFailed: (fids) => failedIds.push(...fids.filter((x) => picked.has(x))),
        retry: () => { if (failedIds.length) bulkPatchRef.current(failedIds, patchIn); },
      });
    } else updateTasks(patches);
    toastAction(`Updated ${plural(rows.length, "task")}`, "Undo", () => {
      completed.forEach(unspawnRecurrence);
      const present = new Set((tasksRef.current ?? []).map((t) => t.id));
      const back = new Map<string, Partial<Task>>();
      patches.forEach((p, id) => { const before = all.find((t) => t.id === id); if (before && present.has(id)) back.set(id, pickFields(before, Object.keys(p))); });
      updateTasks(back, { notify: false });
    }, {});
    if (notes.size === 1) toastInfo([...notes][0]);
    else if (notes.size > 1) toastInfo(`${plural(notes.size, "task")} ${notes.size === 1 ? "was" : "were"} reassigned to you — their assignees aren't in that workspace.`);
  }, [denyGuest, confirmCompleteBlocked, retarget, onStatusChange, cascadeToDescendants, updateWithStatus, updateTasks, toastAction, toastInfo, unspawnRecurrence]);
  bulkPatchRef.current = bulkPatch;

  const deleteTask = useCallback((id: string) => {
    const all = tasksRef.current ?? [];
    const t = all.find((x) => x.id === id); if (!t) return;
    if (denyGuest([t.workspaceId])) return;
    // deleting a parent removes its sub-tasks too (the DB cascades); mirror that locally
    const kids = descendantsOf([id], all).length;
    removeTasks([t], kids ? `Deleted “${t.title}” and ${plural(kids, "sub-task")}` : `Deleted “${t.title}”`);
  }, [denyGuest, removeTasks]);

  const bulkDelete = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const all = tasksRef.current ?? [];
    const sel = new Set(ids);
    const rows = all.filter((t) => sel.has(t.id));
    if (!rows.length) return;
    if (denyGuest(rows.map((r) => r.workspaceId))) return;
    const kids = descendantsOf(ids, all).filter((k) => !sel.has(k.id)).length;
    removeTasks(rows, `Deleted ${plural(rows.length, "task")}${kids ? ` and ${plural(kids, "sub-task")}` : ""}`);
  }, [denyGuest, removeTasks]);

  const archiveTask = useCallback((id: string) => {
    const all = tasksRef.current ?? [];
    const t = all.find((x) => x.id === id); if (!t) return;
    if (denyGuest([t.workspaceId])) return;
    const at = new Date().toISOString();
    const patches = new Map<string, Partial<Task>>([[id, { archivedAt: at }]]);
    cascadeToDescendants(t, { archivedAt: at }, all, patches);
    updateTasks(patches, { notify: false });
    const kids = patches.size - 1;
    toastAction(kids ? `Archived “${t.title}” and ${plural(kids, "sub-task")}` : `Archived “${t.title}”`, "Undo", () => {
      updateTasks(new Map([...patches.keys()].map((k) => [k, { archivedAt: undefined }])), { notify: false });
    }, {});
  }, [denyGuest, cascadeToDescendants, updateTasks, toastAction]);
  const unarchiveTask = useCallback((id: string) => {
    const all = tasksRef.current ?? [];
    const t = all.find((x) => x.id === id); if (!t) return;
    if (denyGuest([t.workspaceId])) return;
    // sub-tasks that were archived together with it come back with it
    const patches = new Map<string, Partial<Task>>([[id, { archivedAt: undefined }]]);
    cascadeToDescendants(t, { archivedAt: undefined }, all, patches);
    updateTasks(patches, { notify: false });
  }, [denyGuest, cascadeToDescendants, updateTasks]);

  // duplicate a task: a fresh to-do copy with its sub-tasks — no comments, reactions,
  // followers, time logged, schedule or plan carried over
  const duplicateTask = useCallback((id: string) => {
    const all = tasksRef.current ?? [];
    const src = all.find((t) => t.id === id); if (!src) return;
    if (denyGuest([src.workspaceId])) return;
    const rows = cloneTaskTree(src, all, (x, isRoot) => ({
      title: isRoot ? `${src.title} (copy)` : x.title,
      status: "todo", completedAt: undefined, archivedAt: undefined, comments: 0, dependencies: [], reactions: {}, followers: [],
      loggedHours: undefined, scheduled: null, planToday: false, createdAt: undefined, originalDueDate: undefined, subtasks: [],
      position: Date.now(),
    }));
    rows.forEach((r, i) => {
      const created = persistTask(r, { log: i === 0, notify: false });
      if (i === 0) copyChecklist(created, src.subtasks.map((s) => ({ ...s, done: false })));
    });
    toastSuccess(rows.length > 1 ? `Task duplicated with ${plural(rows.length - 1, "sub-task")}` : "Task duplicated");
  }, [denyGuest, persistTask, copyChecklist, toastSuccess]);

  /* ---- comments, checklists, sub-tasks, dependencies ---- */
  const addComment = useCallback(async (taskId: string, body: string, mentions: string[] = [], parentId?: string): Promise<Comment | null> => {
    const t = tasksRef.current?.find((x) => x.id === taskId);
    const authorName = getMember(userIdRef.current)?.name || "You";
    try {
      const c = await store.addComment(taskId, body, userIdRef.current, authorName, mentions, parentId);
      if (t) {
        const count = (tasksRef.current?.find((x) => x.id === taskId)?.comments ?? t.comments) + 1;
        setTasks((ts) => ts && ts.map((x) => x.id === taskId ? { ...x, comments: count } : x));
        noteWrite(taskId, { comments: count });
        // guests can comment but not write the task row — their count catches up on the next reload
        if (roleIn(t.workspaceId) !== "guest") writeTask(taskId, { comments: count }).catch(reportError);
        // no self-logged "comment" row: task_events keeps the history, and the
        // inbox only shows comments from other people (DB trigger)
        if (mentions.length) store.notify({ kind: "mention", taskId, taskTitle: t.title, recipientIds: mentions });
        store.notify({ kind: "comment", taskId, taskTitle: t.title });
      }
      return c;
    } catch (e) {
      reportError(e, { op: "addComment" });
      toastError("Couldn't post the comment.");
      return null;
    }
  }, [toastError, noteWrite, roleIn, writeTask]);

  const toggleSubtask = useCallback((taskId: string, subId: string) => {
    const task = tasksRef.current?.find((t) => t.id === taskId);
    const sub = task?.subtasks.find((s) => s.id === subId); if (!task || !sub) return;
    if (denyGuest([task.workspaceId])) return;
    const setDone = (done: boolean) => setTasks((ts) => ts && ts.map((t) => t.id === taskId ? { ...t, subtasks: t.subtasks.map((s) => s.id === subId ? { ...s, done } : s) } : t));
    const done = !sub.done;
    setDone(done);
    store.setSubtaskDone(subId, done).catch((e) => { reportError(e, { op: "setSubtaskDone" }); setDone(!done); toastError("Couldn't save — change undone"); });
  }, [denyGuest, toastError]);

  // a sub-task is a full task with parentId — it inherits the parent's project
  // (and therefore workspace) and assignee, and can be given its own due date,
  // priority, etc. just like any task.
  const addSubtask = useCallback((parentId: string, title: string) => {
    const parent = tasksRef.current?.find((t) => t.id === parentId);
    if (!parent) return;
    if (denyGuest([parent.workspaceId])) return;
    persistTask({
      id: newTaskId(),
      title, description: "", status: "todo", priority: "medium",
      projectId: parent.projectId, assigneeId: parent.assigneeId || userIdRef.current,
      parentId, tags: [], dependencies: [], subtasks: [], comments: 0,
      aiScore: 50, aiReason: undefined, focusMin: 30, dur: 30, scheduled: null,
      planToday: false, recurrence: "none", dueDate: undefined, position: Date.now(),
    });
  }, [denyGuest, persistTask]);

  /** Server ids for tasks that may still be being inserted. */
  const whenSaved = useCallback((ids: string[]): Promise<string[]> =>
    Promise.all(ids.map((id) => createsRef.current.get(id) ?? Promise.resolve(id))), []);

  // task dependencies (blocked-by)
  const setDeps = useCallback((taskId: string, deps: string[]) => {
    setTasks((ts) => ts && ts.map((t) => t.id === taskId ? { ...t, dependencies: deps } : t));
    noteWrite(taskId, { dependencies: deps });
  }, [noteWrite]);
  const addDependency = useCallback((taskId: string, dependsOn: string) => {
    if (taskId === dependsOn) return;
    const cur = tasksRef.current?.find((t) => t.id === taskId); if (!cur) return;
    if (denyGuest([cur.workspaceId])) return;
    const before = cur.dependencies ?? [];
    setDeps(taskId, [...new Set([...before, dependsOn])]);
    whenSaved([taskId, dependsOn]).then(([a, b]) => store.addDependency(a, b)).catch((e) => {
      reportError(e, { op: "addDependency" });
      const now = tasksRef.current?.find((t) => t.id === taskId)?.dependencies ?? [];
      setDeps(taskId, now.filter((d) => d !== dependsOn || before.includes(d)));
      toastError("Couldn't save — change undone");
    });
  }, [denyGuest, setDeps, whenSaved, toastError]);
  const removeDependency = useCallback((taskId: string, dependsOn: string) => {
    const cur = tasksRef.current?.find((t) => t.id === taskId); if (!cur) return;
    if (denyGuest([cur.workspaceId])) return;
    setDeps(taskId, (cur.dependencies ?? []).filter((d) => d !== dependsOn));
    whenSaved([taskId, dependsOn]).then(([a, b]) => store.removeDependency(a, b)).catch((e) => {
      reportError(e, { op: "removeDependency" });
      const now = tasksRef.current?.find((t) => t.id === taskId)?.dependencies ?? [];
      setDeps(taskId, [...new Set([...now, dependsOn])]);
      toastError("Couldn't save — change undone");
    });
  }, [denyGuest, setDeps, whenSaved, toastError]);

  /* ---- new tasks from every entry point ---- */
  /** Tell the user when a new task landed outside the workspace they're looking at. */
  const noteElsewhere = useCallback((projectIds: string[]) => {
    const ws = workspaceRef.current;
    const away = [...new Set(projectIds)].filter((pid) => projectWs(pid) !== ws);
    if (!away.length) return;
    const p = getProject(away[0]);
    const where = workspacesRef.current.find((w) => w.id === (p?.workspaceId ?? null))?.name || "Personal";
    const here = workspacesRef.current.find((w) => w.id === ws)?.name || "this workspace";
    const hasOpen = projectsRef.current.some((x) => (x.workspaceId ?? null) === ws && !x.archivedAt && !x.id.startsWith("tmp-"));
    toastInfo(`Added to “${p?.name ?? "Personal"}” in ${where}${hasOpen ? "." : ` — ${here} has no open projects yet.`}`);
  }, [toastInfo]);

  /** A full new task from a small partial (inline add, quick capture, import rows). */
  const buildNewTask = useCallback((partial: Partial<Task> & { title: string }): Task => {
    const r = routeRef.current, wsId = workspaceRef.current, me = userIdRef.current;
    const ps = projectsRef.current;
    const usable = (id?: string) => { const p = id ? ps.find((x) => x.id === id) : undefined; return p && !p.archivedAt && !p.id.startsWith("tmp-") ? p.id : undefined; };
    // the project you asked for, else the one you're looking at, else the first
    // open project in this workspace — never an archived one (it would vanish)
    const projectId = usable(partial.projectId)
      || (r.view === "project" ? usable(r.projectId) : undefined)
      || ps.find((p) => (p.workspaceId ?? null) === wsId && !p.archivedAt && !p.id.startsWith("tmp-"))?.id
      || "p-personal";
    const focusMin = partial.focusMin ?? 30;
    const base: Task = {
      id: newTaskId(),
      title: partial.title, description: partial.description ?? "", status: partial.status || "todo", priority: partial.priority || "medium",
      projectId, assigneeId: partial.assigneeId || me, tags: partial.tags ?? [], dependencies: [], subtasks: [],
      comments: 0, aiScore: 50, aiReason: undefined, focusMin, dur: focusMin, scheduled: null,
      // only tasks added from Plan my day go straight into today's plan
      planToday: r.view === "plan",
      recurrence: "none", dueDate: partial.dueDate, dueTime: partial.dueTime, startDate: partial.startDate,
      sectionId: partial.sectionId, mySectionId: partial.mySectionId, collaborators: partial.collaborators,
      position: partial.position ?? Date.now(),
    };
    return { ...base, energy: partial.energy ?? energyOf(base) };
  }, []);

  // inline quick-add + quick capture
  const quickAddTask = useCallback((partial: Partial<Task> & { title: string }) => {
    const t = applyAutomation(buildNewTask(partial));
    if (denyGuest([projectWs(t.projectId)])) return;
    persistTask(t);
    noteElsewhere([t.projectId]);
  }, [applyAutomation, buildNewTask, denyGuest, persistTask, noteElsewhere]);

  // genuine "new task" entry points (modal, forms) run automation rules;
  // duplicate / recurrence / sub-tasks call persistTask directly (no rules)
  const createTask = useCallback((t: Task) => {
    if (denyGuest([projectWs(t.projectId)])) return;
    persistTask(applyAutomation({ ...t, planToday: routeRef.current.view === "plan" ? (t.planToday ?? true) : false }));
  }, [denyGuest, persistTask, applyAutomation]);

  // Plan my day capture: yours, and in the workspace you're planning
  const createFromPlan = useCallback((t: Task) => {
    const wsId = workspaceRef.current;
    let projectId = t.projectId;
    if (wsId !== null && projectWs(projectId) !== wsId) {
      projectId = projectsRef.current.find((p) => (p.workspaceId ?? null) === wsId && !p.archivedAt && !p.id.startsWith("tmp-"))?.id ?? projectId;
    }
    if (denyGuest([projectWs(projectId)])) return;
    persistTask(applyAutomation({ ...t, id: newTaskId(), projectId, assigneeId: userIdRef.current, planToday: true }));
    noteElsewhere([projectId]);
  }, [denyGuest, persistTask, applyAutomation, noteElsewhere]);

  /* ---- optimistic tmp-* rows (projects, sections, goals, rules…) ----
     Edits or deletes made before the create returns its real id are queued and
     replayed once it does, instead of failing against the tmp id. */
  const deferTmp = useCallback((id: string, patch?: object): boolean => {
    if (!id.startsWith("tmp-")) return false;
    const op = tmpOpsRef.current.get(id) ?? { patch: {}, deleted: false };
    if (patch) op.patch = { ...op.patch, ...patch }; else op.deleted = true;
    tmpOpsRef.current.set(id, op);
    return true;
  }, []);
  const settleTmp = useCallback(<P extends object>(tmpId: string, realId: string, update: (id: string, patch: P) => Promise<void>, remove: (id: string) => Promise<void>): { deleted: boolean; patch: Partial<P> } => {
    const op = tmpOpsRef.current.get(tmpId); tmpOpsRef.current.delete(tmpId);
    if (!op) return { deleted: false, patch: {} };
    if (op.deleted) { remove(realId).catch(saveFailed("settleTmp-delete")); return { deleted: true, patch: {} }; }
    if (Object.keys(op.patch).length) update(realId, op.patch as P).catch(saveFailed("settleTmp-update"));
    return { deleted: false, patch: op.patch as Partial<P> };
  }, [saveFailed]);

  /* ---- projects ---- */
  const createProject = useCallback((input: NewProject) => {
    if (denyGuest([input.workspaceId])) return;
    // optimistic: show it immediately, reconcile/rollback with the server
    const tmpId = "tmp-proj-" + Date.now();
    const { templateId, ...fields } = input;
    const optimistic: Project = { id: tmpId, ...fields };
    applyProjects([...projectsRef.current, optimistic]);
    store.createProject(input, userIdRef.current)
      .then((p) => {
        const op = settleTmp(tmpId, p.id, (id, patch: Parameters<typeof store.updateProject>[1]) => store.updateProject(id, patch), (id) => store.deleteProject(id));
        if (!op.deleted) noteCreated(p.id); // a reload already under way doesn't know about it yet
        applyProjects(op.deleted ? projectsRef.current.filter((x) => x.id !== tmpId) : swapTmp(projectsRef.current, tmpId, { ...p, ...op.patch }));
        setRouteRaw((r) => (r.view === "project" && r.projectId === tmpId ? { ...r, projectId: p.id } : r));
        // started from a built-in template: add its sections, then its starter tasks
        const tpl = !op.deleted && templateId ? BUILTIN_PROJECT_TEMPLATES.find((t) => t.id === templateId) : undefined;
        if (tpl?.tasks?.length) {
          (async () => {
            const sectionIds: Record<string, string> = {};
            for (const [i, name] of (tpl.sections ?? []).entries()) {
              const sec = await store.createSection({ projectId: p.id, workspaceId: p.workspaceId ?? null, name, position: Date.now() + i }, userIdRef.current);
              sectionIds[name] = sec.id;
              setSections((cur) => [...cur, sec]);
            }
            projectTemplateTasks(tpl, { projectId: p.id, workspaceId: p.workspaceId ?? null, assigneeId: userIdRef.current, sectionIds })
              .forEach((t) => persistTask(t, { log: false, notify: false }));
          })().catch((e) => { reportError(e, { op: "projectTemplate" }); toastError("Project created, but its starter tasks couldn't be added."); });
        }
      })
      .catch((e) => {
        reportError(e, { op: "createProject" });
        applyProjects(projectsRef.current.filter((x) => x.id !== tmpId));
        toastError("Couldn't save the project: " + (e?.message || e));
      });
  }, [denyGuest, applyProjects, settleTmp, noteCreated, toastError, persistTask]);

  const updateProject = useCallback((id: string, patch: { name?: string; emoji?: string; color?: string; description?: string; status?: string; ownerId?: string | null; contributorIds?: string[] }) => {
    const p = projectsRef.current.find((x) => x.id === id); if (!p) return;
    if (denyGuest([p.workspaceId])) return;
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, (p as unknown as Record<string, unknown>)[k]]));
    applyProjects(projectsRef.current.map((x) => x.id === id ? { ...x, ...patch } : x));
    if (deferTmp(id, patch)) return;
    store.updateProject(id, patch).catch((e) => {
      reportError(e, { op: "updateProject" });
      applyProjects(projectsRef.current.map((x) => x.id === id ? { ...x, ...before } : x));
      toastError("Couldn't save the project — change undone.");
    });
  }, [denyGuest, applyProjects, deferTmp, toastError]);

  const setProjectArchived = useCallback((id: string, archived: boolean) => {
    const p = projectsRef.current.find((x) => x.id === id); if (!p) return;
    if (denyGuest([p.workspaceId])) return;
    if (id.startsWith("tmp-")) { toastInfo("That project is still saving — try again in a moment."); return; }
    const prevAt = p.archivedAt ?? null;
    applyProjects(projectsRef.current.map((x) => x.id === id ? { ...x, archivedAt: archived ? new Date().toISOString() : null } : x));
    store.setProjectArchived(id, archived).catch((e) => {
      reportError(e, { op: "archiveProject" });
      applyProjects(projectsRef.current.map((x) => x.id === id ? { ...x, archivedAt: prevAt } : x));
      toastError("Couldn't update the project — change undone.");
    });
    if (archived) {
      // one click in the sidebar hides a team project for everyone: make it easy to take back
      toastAction(`Archived “${p.name}”`, "Undo", () => setProjectArchivedRef.current(id, false), {});
      if (routeRef.current.view === "project" && routeRef.current.projectId === id) setRoute({ view: "home" });
    }
    else toastSuccess(`Restored “${p.name}”`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, applyProjects, toastError, toastSuccess, toastInfo, toastAction]);
  const setProjectArchivedRef = useRef(setProjectArchived); setProjectArchivedRef.current = setProjectArchived;

  // duplicate a project as a template: clones sections + tasks (statuses reset to
  // to-do, completion/scheduling/time/reactions/followers cleared, sections,
  // parents and dependencies remapped). Parents are saved before their
  // sub-tasks, and dependency links only once both ends exist.
  const duplicateProject = useCallback(async (projectId: string) => {
    const src = projectsRef.current.find((p) => p.id === projectId);
    if (!src) return;
    const wsId = src.workspaceId ?? null;
    if (denyGuest([wsId])) return;
    if (projectId.startsWith("tmp-")) { toastInfo("That project is still saving — try again in a moment."); return; }
    const me = userIdRef.current;
    try {
      const np = await store.createProject({ name: `${src.name} (copy)`, emoji: src.emoji, color: src.color, workspaceId: wsId }, me);
      noteCreated(np.id); // a reload already under way doesn't know about it yet
      applyProjects([...projectsRef.current, np]);
      if (src.description || src.status || (src.contributorIds?.length ?? 0)) {
        store.updateProject(np.id, { description: src.description, status: src.status, contributorIds: src.contributorIds }).catch(reportError);
      }
      // clone sections, keeping an old→new id map
      const secMap = new Map<string, string>();
      for (const s of sectionsRef.current.filter((x) => x.projectId === projectId && !x.id.startsWith("tmp-")).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
        const ns = await store.createSection({ projectId: np.id, workspaceId: wsId, name: s.name, position: s.position }, me);
        secMap.set(s.id, ns.id); setSections((cur) => [...cur, ns]);
      }
      const all = tasksRef.current ?? [];
      const srcTasks = all.filter((t) => t.projectId === projectId && !t.archivedAt);
      const idMap = new Map(srcTasks.map((t) => [t.id, newTaskId()]));
      const base = Date.now();
      const clones: Task[] = srcTasks.map((t, i) => ({
        ...t, id: idMap.get(t.id)!, projectId: np.id, workspaceId: wsId,
        status: "todo", completedAt: undefined, archivedAt: undefined, scheduled: null, planToday: false,
        loggedHours: undefined, reactions: {}, followers: [], mySectionId: undefined, comments: 0, subtasks: [],
        createdAt: undefined, originalDueDate: undefined,
        sectionId: t.sectionId ? secMap.get(t.sectionId) : undefined,
        parentId: t.parentId ? idMap.get(t.parentId) : undefined,
        dependencies: (t.dependencies ?? []).map((d) => idMap.get(d)).filter((x): x is string => !!x),
        position: t.position ?? base + i,
      }));
      // show the copy straight away; it saves in the background
      setTasks((ts) => (ts ? [...clones, ...ts] : clones));
      pendingTasksRef.current = [...clones.map((t) => ({ id: t.id, task: t, until: null })), ...pendingTasksRef.current];
      setWorkspace(wsId); setRoute({ view: "project", projectId: np.id });
      toastSuccess(`Duplicated “${src.name}”`);
      // each task is saved on its own, a few at a time, parents first (a sub-task's
      // insert waits for its parent's). A row that fails is flagged with Retry on its
      // own; rows that saved are never sent again.
      const slot = createLimiter(6);
      const runs: [string, Promise<string | null>][] = [];
      for (const level of parentsFirst(clones)) for (const t of level) runs.push([t.id, startCreate(t, { log: false, notify: false, slot })]);
      const saved = new Map<string, string>(); // clone id → server id
      await Promise.all(runs.map(([cid, p]) => p.then((sid) => { if (sid) saved.set(cid, sid); })));
      const deps = clones.flatMap((c) => c.dependencies.map((d) => [c.id, d] as [string, string]));
      const ready = deps.filter(([a, b]) => saved.has(a) && saved.has(b));
      const depOk = await runLimited(ready, 4, ([a, b]) => store.addDependency(saved.get(a)!, saved.get(b)!));
      const lists = srcTasks.filter((t) => t.subtasks.length && saved.has(idMap.get(t.id)!));
      await runLimited(lists, 4, (t) => {
        const sid = saved.get(idMap.get(t.id)!)!;
        return Promise.all(t.subtasks.map((s, i) => store.addSubtask(sid, s.title, i)))
          .then((subs) => setTasks((ts) => ts && ts.map((x) => (x.id === sid ? { ...x, subtasks: subs } : x))));
      });
      // links that didn't make it (a failed link, or an end that didn't save) come off the
      // screen too, so the copy never shows a dependency the server doesn't have
      const lost = [...deps.filter(([a, b]) => !(saved.has(a) && saved.has(b))), ...ready.filter((_, i) => !depOk[i])];
      if (lost.length) {
        const cur = (id: string) => saved.get(id) ?? id; // ids may have moved to the server's
        const drop = new Map<string, Set<string>>();
        lost.forEach(([a, b]) => { const k = cur(a); const set = drop.get(k) ?? new Set<string>(); set.add(cur(b)); drop.set(k, set); });
        setTasks((ts) => ts && ts.map((x) => { const d = drop.get(x.id); return d ? { ...x, dependencies: (x.dependencies ?? []).filter((y) => !d.has(y)) } : x; }));
        toastError(`${plural(lost.length, "dependency link")} couldn't be copied.`);
      }
    } catch (e) { reportError(e, { op: "duplicateProject" }); toastError("Couldn't duplicate the project: " + ((e as Error)?.message || e)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, applyProjects, startCreate, noteCreated, toastSuccess, toastError, toastInfo]);

  /** Mirrors the server rule (0041): a team project can be deleted by its creator/owner or a workspace owner/admin. */
  const canDeleteProject = useCallback((p: Project): boolean => {
    if ((p.workspaceId ?? null) === null) return true;
    const role = roleIn(p.workspaceId);
    if (role === "owner" || role === "admin") return true;
    if (role === "guest") return false;
    const me = userIdRef.current;
    if (p.ownerId === me || workspacesRef.current.find((w) => w.id === p.workspaceId)?.ownerId === me) return true;
    return !p.ownerId; // no owner recorded: the server knows the creator — let it decide
  }, [roleIn]);

  // Delete: the project is deleted FIRST; its tasks are only deleted once that succeeded.
  // Move: the tasks move FIRST; the project is only deleted once every one has left it,
  // so a move the server refuses never leaves tasks pointing at a deleted project.
  const confirmDeleteProject = useCallback(async (id: string, mode: DeleteMode, targetId?: string) => {
    setDeleteProjectId(null);
    if (id === "p-personal") return; // built-in default can't be deleted
    if (mode === "reassign" && !targetId) return; // never fall through to deleting
    const proj = projectsRef.current.find((p) => p.id === id); if (!proj) return;
    if (denyGuest([proj.workspaceId])) return;
    if (!canDeleteProject(proj)) { toastError(`Only the owner of “${proj.name}” or a workspace admin can delete it.`); return; }
    if (id.startsWith("tmp-")) { deferTmp(id); applyProjects(projectsRef.current.filter((p) => p.id !== id)); return; }
    const dropProject = () => {
      applyProjects(projectsRef.current.filter((p) => p.id !== id));
      setRouteRaw((r) => r.view === "project" && r.projectId === id ? { view: "tasks" } : r);
    };
    if (mode === "reassign" && targetId) {
      // tasks live in their project's workspace — carry the target's workspace so
      // moved tasks don't keep a stale one and vanish from view
      const targetWs = projectWs(targetId);
      const targetName = getProject(targetId)?.name ?? "another project";
      const moveThenDelete = async (): Promise<void> => {
        if (!projectsRef.current.some((p) => p.id === id)) return; // gone meanwhile
        const affected = (tasksRef.current || []).filter((t) => t.projectId === id);
        const patches = new Map(affected.map((t) => [t.id, { projectId: targetId, workspaceId: targetWs, sectionId: undefined } as Partial<Task>]));
        // a move that fails is undone on screen; its Retry toast runs the whole thing again
        const moved = await updateTasks(patches, {
          notify: false, op: "reassignOnProjectDelete", retry: () => { void moveThenDelete(); },
          failMessage: (n) => `Couldn't move ${plural(n, "task")} — “${proj.name}” was not deleted`,
        });
        if (!moved) return;
        try { await store.deleteProject(id); }
        catch (e) {
          reportError(e, { op: "deleteProject" });
          toastError(affected.length ? `Moved ${plural(affected.length, "task")} to “${targetName}”, but couldn't delete “${proj.name}”.` : `Couldn't delete “${proj.name}” — nothing was changed.`);
          return;
        }
        dropProject();
        toastSuccess(`Deleted “${proj.name}”${affected.length ? ` — ${plural(affected.length, "task")} moved to “${targetName}”` : ""}`);
      };
      await moveThenDelete();
      return;
    }
    try { await store.deleteProject(id); }
    catch (e) { reportError(e, { op: "deleteProject" }); toastError(`Couldn't delete “${proj.name}” — nothing was changed.`); return; }
    const affected = (tasksRef.current || []).filter((t) => t.projectId === id);
    dropProject();
    const ids = new Set(affected.map((t) => t.id));
    setTasks((ts) => ts && ts.filter((t) => !ids.has(t.id)));
    noteDelete([...ids]); dropPending(ids);
    const failed = await serverDelete(affected);
    if (failed.length) toastError(`Deleted “${proj.name}”, but ${plural(failed.length, "task")} couldn't be deleted — refresh to see ${failed.length === 1 ? "it" : "them"}.`);
    else toastSuccess(`Deleted “${proj.name}”${affected.length ? ` and ${plural(affected.length, "task")}` : ""}`);
  }, [denyGuest, canDeleteProject, deferTmp, applyProjects, updateTasks, noteDelete, dropPending, serverDelete, toastSuccess, toastError]);

  // ---- sections (ordered groupings within a project) ----
  const sectionWs = (s: Section | undefined) => (s ? s.workspaceId ?? projectWs(s.projectId) : null);
  /** Returns the new section's temporary id (tasks filed under it wait for the real one). */
  const createSection = useCallback((projectId: string, name: string, position?: number): string | undefined => {
    const wsId = projectWs(projectId);
    if (denyGuest([wsId])) return undefined;
    const pos = position ?? Date.now();
    const tmp: Section = { id: `tmp-sec-${pos}-${Math.round(Math.random() * 1e4)}`, projectId, workspaceId: wsId, name, position: pos };
    setSections((s) => [...s, tmp]);
    const saving = store.createSection({ projectId, workspaceId: wsId, name, position: pos }, userIdRef.current).then((sec) => {
      sectionAliasRef.current.set(tmp.id, sec.id);
      const op = settleTmp(tmp.id, sec.id, (id, patch: { name?: string; position?: number }) => store.updateSection(id, patch), (id) => store.deleteSection(id));
      setSections((s) => (op.deleted ? s.filter((x) => x.id !== tmp.id) : swapTmp(s, tmp.id, { ...sec, ...op.patch })));
      // tasks filed under it while it was saving move to the real id (their writes waited for it)
      const swap = (t: Partial<Task>) => ({ ...t, ...(t.sectionId === tmp.id ? { sectionId: sec.id } : {}), ...(t.mySectionId === tmp.id ? { mySectionId: sec.id } : {}) });
      setTasks((ts) => ts && ts.map((t) => (t.sectionId === tmp.id || t.mySectionId === tmp.id ? { ...t, ...swap(t) } : t)));
      recentWritesRef.current.forEach((w, id) => { if (w.patch.sectionId === tmp.id || w.patch.mySectionId === tmp.id) recentWritesRef.current.set(id, { ...w, patch: swap(w.patch) }); });
      return sec.id;
    });
    tmpSectionRef.current.set(tmp.id, saving);
    saving.catch((e) => {
      reportError(e, { op: "createSection" });
      setSections((s) => s.filter((x) => x.id !== tmp.id));
      toastError("Couldn't add the section: " + (e?.message || e));
    }).finally(() => tmpSectionRef.current.delete(tmp.id));
    return tmp.id;
  }, [denyGuest, settleTmp, toastError]);
  const renameSection = useCallback((id: string, name: string) => {
    const sec = sectionsRef.current.find((s) => s.id === id);
    if (denyGuest([sectionWs(sec)])) return;
    setSections((s) => s.map((x) => x.id === id ? { ...x, name } : x));
    if (deferTmp(id, { name })) return;
    store.updateSection(id, { name }).catch(saveFailed("renameSection", "Couldn't rename the section."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, deferTmp, saveFailed]);
  const deleteSection = useCallback((id: string) => {
    const sec = sectionsRef.current.find((s) => s.id === id);
    if (denyGuest([sectionWs(sec)])) return;
    setSections((s) => s.filter((x) => x.id !== id));
    const affected = (tasksRef.current ?? []).filter((t) => t.sectionId === id || t.mySectionId === id);
    updateTasks(new Map(affected.map((t) => [t.id, (t.sectionId === id ? { sectionId: undefined } : { mySectionId: undefined }) as Partial<Task>])), { notify: false });
    if (deferTmp(id)) return;
    store.deleteSection(id).catch(saveFailed("deleteSection", "Couldn't delete the section."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, updateTasks, deferTmp, saveFailed]);

  // CSV / paste import: positions in file order, one summary. Each row is saved on
  // its own (a few at a time), so one bad row only flags that row — the rest save,
  // and Retry never re-inserts a row that already made it. Rows nested under
  // another row become its sub-tasks; sections and tags the file names that
  // don't exist yet are created.
  const importTasks = useCallback((rows: ImportRow[]) => {
    if (!rows.length) return;
    const me = userIdRef.current, base = Date.now();
    const today = toLocalISO(new Date());
    const built: Task[] = rows.map((r, i) => applyAutomation({ ...buildNewTask({ ...r, position: base + i }), planToday: false }))
      .map((t, i) => ({
        ...t, assigneeId: t.assigneeId === "m-self" ? me : t.assigneeId, workspaceId: projectWs(t.projectId),
        // the file's own date (Asana "Completed At", Jira "Resolved"), else it was done today
        completedAt: t.status === "done" ? rows[i].completedAt ?? today : undefined,
      }));
    // sub-tasks: under their parent row, in the parent's project (a parent may come later in the file)
    built.forEach((t, i) => { const pi = rows[i].parentIndex; if (pi !== undefined && pi !== i && built[pi]) t.parentId = built[pi].id; });
    const byId = new Map(built.map((t) => [t.id, t]));
    const moved = new Set<string>();
    for (const level of parentsFirst(built)) for (const t of level) {
      const parent = t.parentId ? byId.get(t.parentId) : undefined;
      if (!parent || parent.projectId === t.projectId) continue;
      Object.assign(t, { projectId: parent.projectId, workspaceId: parent.workspaceId, sectionId: undefined });
      moved.add(t.id);
    }
    if (denyGuest(built.map((t) => t.workspaceId))) return;
    // sections the file names that this project doesn't have yet (tasks wait for their real ids)
    const newSections = new Map<string, string | undefined>();
    built.forEach((t, i) => {
      const name = rows[i].sectionName?.trim();
      if (!name || t.sectionId || moved.has(t.id)) return;
      const key = `${t.projectId}\u0000${name.toLowerCase()}`;
      if (!newSections.has(key)) newSections.set(key, createSection(t.projectId, name, base + newSections.size));
      t.sectionId = newSections.get(key);
    });
    setTasks((ts) => (ts ? [...built, ...ts] : built));
    pendingTasksRef.current = [...built.map((t) => ({ id: t.id, task: t, until: null })), ...pendingTasksRef.current];
    const slot = createLimiter(6);
    // assignment emails for what was imported for other people (bounded — the in-app notification covers every task)
    let emails = 0;
    // parents first: a sub-task's insert waits for its parent's
    const runs = parentsFirst(built).flat().map((t) => startCreate(t, { log: false, notify: !!t.assigneeId && t.assigneeId !== me && emails++ < 20, slot }));
    // tags the file uses that don't exist yet: create them, then add them to their rows
    const fresh = new Map<string, string>();
    rows.forEach((r) => (r.newTags ?? []).forEach((l) => { const k = l.trim().toLowerCase(); if (k && !fresh.has(k)) fresh.set(k, l.trim()); }));
    if (fresh.size) {
      const wsId = workspaceRef.current;
      Promise.all([...fresh.values()].map((label, i) => store.createTag(label, TAG_COLORS[i % TAG_COLORS.length].c, me, wsId)
        .then((tag) => tag, (e) => { reportError(e, { op: "importTags" }); return null; })))
        .then((made) => {
          const ok = made.filter((x): x is NonNullable<typeof x> => !!x);
          if (ok.length) applyTags({ ...tagsRef.current, ...Object.fromEntries(ok.map((tag) => [tag.id, { label: tag.label, color: tag.color }])) });
          const idOf = new Map(ok.map((tag) => [tag.label.trim().toLowerCase(), tag.id]));
          const patches = new Map<string, Partial<Task>>();
          built.forEach((t, i) => {
            const add = (rows[i].newTags ?? []).map((l) => idOf.get(l.trim().toLowerCase())).filter((x): x is string => !!x);
            const cur = add.length ? tasksRef.current?.find((x) => x.id === t.id) : undefined;
            if (cur) patches.set(cur.id, { tags: [...new Set([...cur.tags, ...add])] });
          });
          if (patches.size) updateTasks(patches, { notify: false, op: "importTags" });
          const lost = made.length - ok.length;
          if (lost) toastError(`${plural(lost, "new tag")} couldn't be created, so ${lost === 1 ? "it was" : "they were"} left off.`);
        });
    }
    Promise.all(runs).then((ids) => {
      const saved = ids.filter((x): x is string => !!x);
      if (saved.length) log("created", { id: saved[0], title: `Imported ${plural(saved.length, "task")}` }, `Imported ${plural(saved.length, "task")}`);
    });
    const projs = [...new Set(built.map((t) => t.projectId))];
    toastSuccess(`Imported ${plural(built.length, "task")}${projs.length === 1 ? ` into “${getProject(projs[0])?.name ?? "Personal"}”` : ""}`);
    noteElsewhere(projs);
  }, [applyAutomation, buildNewTask, denyGuest, startCreate, log, toastSuccess, toastError, noteElsewhere, createSection, applyTags, updateTasks]);

  // ---- saved searches (personal) ----
  const saveSearch = useCallback((name: string, query: Record<string, unknown>) => {
    const tmp: SavedSearch = { id: "tmp-ss-" + Date.now(), name, query };
    setSavedSearches((s) => [...s, tmp]);
    store.createSavedSearch(name, query, userIdRef.current)
      .then((ss) => {
        const op = settleTmp(tmp.id, ss.id, () => Promise.resolve(), (id) => store.deleteSavedSearch(id));
        setSavedSearches((s) => (op.deleted ? s.filter((x) => x.id !== tmp.id) : swapTmp(s, tmp.id, ss)));
      })
      .catch((e) => { reportError(e, { op: "saveSearch" }); setSavedSearches((s) => s.filter((x) => x.id !== tmp.id)); toastError("Couldn't save the search."); });
  }, [settleTmp, toastError]);
  // the Sidebar hides the row at once and calls this when its Undo window closes;
  // a rejected promise brings the row back (the Sidebar says so), SearchView ignores it
  const removeSavedSearch = useCallback((id: string): Promise<void> | undefined => {
    const prev = savedSearchesRef.current.find((x) => x.id === id);
    setSavedSearches((s) => s.filter((x) => x.id !== id));
    if (deferTmp(id)) return undefined;
    return store.deleteSavedSearch(id).catch((e) => {
      reportError(e, { op: "deleteSavedSearch" });
      if (prev) setSavedSearches((s) => (s.some((x) => x.id === id) ? s : [...s, prev]));
      throw e;
    });
  }, [deferTmp]);

  // ---- goals / OKRs ----
  type GoalPatch = Partial<Pick<Goal, "name" | "target" | "current" | "unit" | "due" | "status" | "parentId" | "projectId">>;
  const createGoal = useCallback((name: string) => {
    const wsId = workspaceRef.current;
    if (denyGuest([wsId])) return;
    const tmp: Goal = { id: "tmp-goal-" + Date.now(), workspaceId: wsId, name, status: "on_track", current: 0, target: 100 };
    setGoals((g) => [...g, tmp]);
    store.createGoal({ workspaceId: wsId, name, status: "on_track", current: 0, target: 100 }, userIdRef.current)
      .then((goal) => {
        const op = settleTmp(tmp.id, goal.id, (id, patch: GoalPatch) => store.updateGoal(id, patch), (id) => store.deleteGoal(id));
        setGoals((g) => (op.deleted ? g.filter((x) => x.id !== tmp.id) : swapTmp(g, tmp.id, { ...goal, ...op.patch })));
      })
      .catch((e) => { reportError(e, { op: "createGoal" }); setGoals((g) => g.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the goal: " + (e?.message || e)); });
  }, [denyGuest, settleTmp, toastError]);
  const updateGoal = useCallback((id: string, patch: GoalPatch) => {
    if (denyGuest([workspaceRef.current])) return;
    setGoals((g) => g.map((x) => x.id === id ? { ...x, ...patch } : x));
    if (deferTmp(id, patch)) return;
    store.updateGoal(id, patch).catch(saveFailed("updateGoal"));
  }, [denyGuest, deferTmp, saveFailed]);
  const deleteGoal = useCallback((id: string) => {
    if (denyGuest([workspaceRef.current])) return;
    setGoals((g) => g.filter((x) => x.id !== id));
    if (deferTmp(id)) return;
    store.deleteGoal(id).catch(saveFailed("deleteGoal", "Couldn't delete the goal."));
  }, [denyGuest, deferTmp, saveFailed]);

  // ---- portfolios ----
  const createPortfolio = useCallback((name: string) => {
    const wsId = workspaceRef.current;
    if (denyGuest([wsId])) return;
    const tmp: Portfolio = { id: "tmp-pf-" + Date.now(), workspaceId: wsId, name, projectIds: [] };
    setPortfolios((p) => [...p, tmp]);
    store.createPortfolio({ workspaceId: wsId, name }, userIdRef.current)
      .then((pf) => {
        const op = settleTmp(tmp.id, pf.id, (id, patch: { name?: string; projectIds?: string[] }) => store.updatePortfolio(id, patch), (id) => store.deletePortfolio(id));
        setPortfolios((p) => (op.deleted ? p.filter((x) => x.id !== tmp.id) : swapTmp(p, tmp.id, { ...pf, ...op.patch })));
      })
      .catch((e) => { reportError(e, { op: "createPortfolio" }); setPortfolios((p) => p.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the portfolio: " + (e?.message || e)); });
  }, [denyGuest, settleTmp, toastError]);
  const updatePortfolio = useCallback((id: string, patch: { name?: string; projectIds?: string[] }) => {
    if (denyGuest([workspaceRef.current])) return;
    setPortfolios((p) => p.map((x) => x.id === id ? { ...x, ...patch } : x));
    if (deferTmp(id, patch)) return;
    store.updatePortfolio(id, patch).catch(saveFailed("updatePortfolio"));
  }, [denyGuest, deferTmp, saveFailed]);
  const deletePortfolio = useCallback((id: string) => {
    if (denyGuest([workspaceRef.current])) return;
    setPortfolios((p) => p.filter((x) => x.id !== id));
    if (deferTmp(id)) return;
    store.deletePortfolio(id).catch(saveFailed("deletePortfolio", "Couldn't delete the portfolio."));
  }, [denyGuest, deferTmp, saveFailed]);

  // ---- project status updates ----
  const postStatusUpdate = useCallback((projectId: string, summary: string, status: StatusKind): Promise<boolean> => {
    const wsId = projectWs(projectId);
    if (denyGuest([wsId])) return Promise.resolve(false);
    return store.createStatusUpdate({ workspaceId: wsId, projectId, summary, status }, userIdRef.current)
      .then((su) => { setStatusUpdates((s) => [su, ...s]); return true; })
      .catch((e) => { reportError(e, { op: "statusUpdate" }); toastError("Couldn't post the update — your text is still there."); return false; });
  }, [denyGuest, toastError]);

  // ---- automation rules ----
  type RulePatch = { name?: string; actions?: AutomationAction[]; enabled?: boolean; trigger?: AutomationRule["trigger"] };
  const ruleWs = (id: string) => { const r = rulesRef.current.find((x) => x.id === id); return r ? r.workspaceId ?? projectWs(r.projectId) : workspaceRef.current; };
  const createRule = useCallback((projectId: string, name: string, actions: AutomationAction[], trigger: AutomationRule["trigger"] = "task_created") => {
    const wsId = projectWs(projectId);
    if (denyGuest([wsId])) return;
    const tmp: AutomationRule = { id: "tmp-rule-" + Date.now(), workspaceId: wsId, projectId, name, trigger, actions, enabled: true };
    setAutomationRules((rs) => [...rs, tmp]);
    store.createRule({ workspaceId: wsId, projectId, name, actions, trigger }, userIdRef.current)
      .then((rule) => {
        const op = settleTmp(tmp.id, rule.id, (id, patch: RulePatch) => store.updateRule(id, patch), (id) => store.deleteRule(id));
        setAutomationRules((rs) => (op.deleted ? rs.filter((x) => x.id !== tmp.id) : swapTmp(rs, tmp.id, { ...rule, ...op.patch })));
      })
      .catch((e) => { reportError(e, { op: "createRule" }); setAutomationRules((rs) => rs.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the rule: " + (e?.message || e)); });
  }, [denyGuest, settleTmp, toastError]);
  const updateRule = useCallback((id: string, patch: RulePatch) => {
    if (denyGuest([ruleWs(id)])) return;
    setAutomationRules((rs) => rs.map((x) => x.id === id ? { ...x, ...patch } : x));
    if (deferTmp(id, patch)) return;
    store.updateRule(id, patch).catch(saveFailed("updateRule"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, deferTmp, saveFailed]);
  const deleteRule = useCallback((id: string) => {
    if (denyGuest([ruleWs(id)])) return;
    setAutomationRules((rs) => rs.filter((x) => x.id !== id));
    if (deferTmp(id)) return;
    store.deleteRule(id).catch(saveFailed("deleteRule", "Couldn't delete the rule."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, deferTmp, saveFailed]);

  // ---- intake forms ----
  const formsRef = useRef<FormDef[]>([]); formsRef.current = forms;
  const formWs = (id: string) => { const f = formsRef.current.find((x) => x.id === id); return f ? f.workspaceId ?? projectWs(f.projectId) : workspaceRef.current; };
  const createForm = useCallback((projectId: string, name: string, fields: FormFieldKey[]) => {
    const wsId = projectWs(projectId);
    if (denyGuest([wsId])) return;
    const tmp: FormDef = { id: "tmp-form-" + Date.now(), workspaceId: wsId, projectId, name, fields };
    setForms((fs) => [...fs, tmp]);
    store.createForm({ workspaceId: wsId, projectId, name, fields }, userIdRef.current)
      .then((form) => {
        const op = settleTmp(tmp.id, form.id, (id, patch: { name?: string; fields?: FormFieldKey[] }) => store.updateForm(id, patch), (id) => store.deleteForm(id));
        setForms((fs) => (op.deleted ? fs.filter((x) => x.id !== tmp.id) : swapTmp(fs, tmp.id, { ...form, ...op.patch })));
      })
      .catch((e) => { reportError(e, { op: "createForm" }); setForms((fs) => fs.filter((x) => x.id !== tmp.id)); toastError("Couldn't add the form: " + (e?.message || e)); });
  }, [denyGuest, settleTmp, toastError]);
  const updateForm = useCallback((id: string, patch: { name?: string; fields?: FormFieldKey[] }) => {
    if (denyGuest([formWs(id)])) return;
    setForms((fs) => fs.map((x) => x.id === id ? { ...x, ...patch } : x));
    if (deferTmp(id, patch)) return;
    store.updateForm(id, patch).catch(saveFailed("updateForm"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, deferTmp, saveFailed]);
  const deleteForm = useCallback((id: string) => {
    if (denyGuest([formWs(id)])) return;
    setForms((fs) => fs.filter((x) => x.id !== id));
    if (deferTmp(id)) return;
    store.deleteForm(id).catch(saveFailed("deleteForm", "Couldn't delete the form."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denyGuest, deferTmp, saveFailed]);
  // a form submission becomes a task (and runs the project's automation rules).
  // It goes to the project's owner by default — never silently to the submitter.
  // A form that asks for an assignee sends "" for its explicit "Unassigned".
  const submitForm = useCallback((projectId: string, vals: FormValues) => {
    const proj = getProject(projectId);
    if (denyGuest([proj?.workspaceId ?? null])) return;
    createTask({
      id: newTaskId(),
      title: vals.title, description: vals.description ?? "", status: "todo", priority: (vals.priority as Task["priority"]) || "medium",
      projectId, assigneeId: vals.assigneeId ?? (proj?.ownerId || userIdRef.current), tags: [], dependencies: [], subtasks: [],
      comments: 0, aiScore: 50, aiReason: undefined, focusMin: 30, dur: 30, scheduled: null, planToday: false,
      recurrence: "none", dueDate: vals.dueDate || undefined, position: Date.now(),
    });
    toastSuccess("Submitted — task created");
  }, [denyGuest, createTask, toastSuccess]);

  // ---- custom fields (per-project definitions) ----
  const createCustomField = useCallback((projectId: string, name: string, type: CustomFieldDef["type"], options: string[] = []) => {
    const wsId = projectWs(projectId);
    if (denyGuest([wsId])) return;
    const tmp: CustomFieldDef = { id: "tmp-cf-" + Date.now(), projectId, workspaceId: wsId, name, type, options };
    setCustomFields((cs) => [...cs, tmp]);
    store.createCustomField({ projectId, workspaceId: wsId, name, type, options }, userIdRef.current)
      .then((def) => {
        const op = settleTmp(tmp.id, def.id, (id, patch: { name?: string; options?: string[]; position?: number }) => store.updateCustomField(id, patch), (id) => store.deleteCustomField(id));
        setCustomFields((cs) => (op.deleted ? cs.filter((c) => c.id !== tmp.id) : swapTmp(cs, tmp.id, { ...def, ...op.patch })));
      })
      .catch((e) => { reportError(e, { op: "createCustomField" }); setCustomFields((cs) => cs.filter((c) => c.id !== tmp.id)); toastError("Couldn't add the field: " + (e?.message || e)); });
  }, [denyGuest, settleTmp, toastError]);
  const customFieldsRef = useRef<CustomFieldDef[]>([]); customFieldsRef.current = customFields;
  const deleteCustomField = useCallback((id: string) => {
    const f = customFieldsRef.current.find((c) => c.id === id);
    if (denyGuest([f ? f.workspaceId ?? projectWs(f.projectId) : workspaceRef.current])) return;
    setCustomFields((cs) => cs.filter((c) => c.id !== id));
    if (deferTmp(id)) return;
    store.deleteCustomField(id).catch(saveFailed("deleteCustomField", "Couldn't delete the field."));
  }, [denyGuest, deferTmp, saveFailed]);

  /* ---- tags ---- */
  const createTag = useCallback((label: string, color: string) => {
    if (denyGuest([workspaceRef.current])) return;
    const tmpId = "tmp-tag-" + Date.now();
    applyTags({ ...tagsRef.current, [tmpId]: { label, color } });
    store.createTag(label, color, userIdRef.current, workspaceRef.current)
      .then((tag) => {
        const op = settleTmp(tmpId, tag.id, (id, patch: { label?: string; color?: string }) => store.updateTag(id, patch), (id) => store.deleteTag(id));
        const next = { ...tagsRef.current };
        delete next[tmpId];
        if (!op.deleted) next[tag.id] = { label: tag.label, color: tag.color, ...op.patch };
        applyTags(next);
        // tasks tagged while it was saving get the real id
        const tagged = (tasksRef.current ?? []).filter((t) => t.tags.includes(tmpId));
        if (tagged.length) updateTasks(new Map(tagged.map((t) => [t.id, { tags: op.deleted ? t.tags.filter((x) => x !== tmpId) : t.tags.map((x) => (x === tmpId ? tag.id : x)) }])), { notify: false });
      })
      .catch((e) => {
        reportError(e, { op: "createTag" });
        const next = { ...tagsRef.current }; delete next[tmpId]; applyTags(next);
        toastError("Couldn't save the tag: " + (e?.message || e));
      });
  }, [denyGuest, applyTags, settleTmp, updateTasks, toastError]);

  // tag edits touch tasks everywhere — only those you can edit are rewritten
  const editableTasks = useCallback((pred: (t: Task) => boolean) => (tasksRef.current ?? []).filter((t) => pred(t) && roleIn(t.workspaceId) !== "guest"), [roleIn]);

  const deleteTag = useCallback((id: string) => {
    if (denyGuest([workspaceRef.current])) return;
    // drop it from any tasks that use it, then remove the tag
    const affected = editableTasks((t) => t.tags.includes(id));
    if (affected.length) updateTasks(new Map(affected.map((t) => [t.id, { tags: t.tags.filter((x) => x !== id) }])), { notify: false });
    const next = { ...tagsRef.current }; delete next[id]; applyTags(next);
    if (deferTmp(id)) return;
    store.deleteTag(id).catch(saveFailed("deleteTag", "Couldn't delete the tag."));
  }, [denyGuest, editableTasks, updateTasks, applyTags, deferTmp, saveFailed]);

  const updateTag = useCallback((id: string, patch: { label?: string; color?: string }) => {
    const cur = tagsRef.current[id]; if (!cur) return;
    if (denyGuest([workspaceRef.current])) return;
    applyTags({ ...tagsRef.current, [id]: { ...cur, ...patch } });
    if (deferTmp(id, patch)) return;
    store.updateTag(id, patch).catch((e) => { reportError(e, { op: "updateTag" }); applyTags({ ...tagsRef.current, [id]: cur }); toastError("Couldn't update the tag — change undone."); });
  }, [denyGuest, applyTags, deferTmp, toastError]);

  // merge tag `fromId` into `intoId`: re-tag every task, then drop fromId
  const mergeTags = useCallback((fromId: string, intoId: string) => {
    if (fromId === intoId) return;
    if (denyGuest([workspaceRef.current])) return;
    const affected = editableTasks((t) => t.tags.includes(fromId));
    if (affected.length) updateTasks(new Map(affected.map((t) => [t.id, { tags: [...new Set(t.tags.map((x) => (x === fromId ? intoId : x)))] }])), { notify: false });
    const next = { ...tagsRef.current }; delete next[fromId]; applyTags(next);
    if (!deferTmp(fromId)) store.deleteTag(fromId).catch(saveFailed("mergeTags", "Couldn't finish merging the tags."));
    toastSuccess("Tags merged");
  }, [denyGuest, editableTasks, updateTasks, applyTags, deferTmp, saveFailed, toastSuccess]);

  /* ---- workspaces & people ---- */
  const createWorkspace = useCallback((name: string) => {
    const me = getMember(userIdRef.current);
    store.createWorkspace(name, { id: userIdRef.current, email: me?.email || "", name: me?.name || "You" })
      .then((w) => {
        if (w.id) noteCreated(w.id); // a reload already under way doesn't know about it yet
        setWorkspaces((ws) => [...ws, w]);
        setWsMembers((m) => [...m, { id: "owner-" + w.id, workspaceId: w.id!, userId: userIdRef.current, email: me?.email || "", name: me?.name || "You", role: "owner", status: "active" }]);
        setReferenceData({ workspaces: [...workspacesRef.current, w] });
        setWorkspace(w.id);
        setRoute({ view: "team" });
      })
      .catch((e) => { reportError(e, { op: "createWorkspace" }); toastError("Couldn't create the workspace: " + (e?.message || e)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastError]);

  const updateWorkspace = useCallback((workspaceId: string, name: string, logoUrl: string | null) => {
    const before = workspacesRef.current;
    const next = before.map((w) => w.id === workspaceId ? { ...w, name, logoUrl: logoUrl ?? undefined } : w);
    setWorkspaces(next); setReferenceData({ workspaces: next });
    store.updateWorkspace(workspaceId, name, logoUrl).catch((e) => {
      reportError(e, { op: "updateWorkspace" });
      setWorkspaces(before); setReferenceData({ workspaces: before });
      toastError("Couldn't save workspace settings: " + (e?.message || e));
    });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastError, toastSuccess]);

  const refreshWorkspaceMembers = useCallback(() => {
    store.listWorkspaceMembers().then(setWsMembers).catch((e) => reportError(e, { op: "refreshWorkspaceMembers" }));
  }, []);

  // TeamView awaits this: it shows the outcome — and how the invite email went — next
  // to the field, so nothing is toasted here. Refusals the person can act on
  // ("already a member", not allowed) aren't errors worth reporting.
  const inviteMember = useCallback((workspaceId: string, email: string, role: Role = "member") =>
    store.inviteMember(workspaceId, email, role).then((res) => {
      const { inviteEmail, ...m } = res; // the email result isn't member state
      setWsMembers((xs) => [...xs.filter((x) => x.id !== m.id), m]);
      if (inviteEmail?.reason === "already_active") refreshWorkspaceMembers();
      return res;
    }, (e) => {
      if (!/already a member|not authori[sz]ed|only the (workspace )?owner|only workspace owners|valid email|invalid role|choose a role/i.test(String(e?.message))) reportError(e, { op: "inviteMember" });
      throw e;
    }), [refreshWorkspaceMembers]);
  // "Resend invite" only re-sends the email (the invite itself stands)
  const resendInvite = useCallback((memberId: string) => store.sendInviteEmail(memberId).then((r) => {
    if (r.reason === "already_active") refreshWorkspaceMembers();
    return r;
  }), [refreshWorkspaceMembers]);

  const removeMember = useCallback((memberId: string) => {
    const m = wsMembersRef.current.find((x) => x.id === memberId);
    const leaving = !!m && m.userId === userIdRef.current;
    setWsMembers((xs) => xs.filter((x) => x.id !== memberId));
    store.removeMember(memberId)
      .then(() => {
        if (!leaving || !m) return;
        // you left: stop pointing at a workspace you're no longer in
        const name = workspacesRef.current.find((w) => w.id === m.workspaceId)?.name || "the workspace";
        const next = workspacesRef.current.filter((w) => w.id !== m.workspaceId);
        setWorkspaces(next); setReferenceData({ workspaces: next });
        if (workspaceRef.current === m.workspaceId) { setWorkspace(null); setRoute({ view: "home" }); }
        toastSuccess(`You left ${name}`);
      })
      .catch((e) => { reportError(e, { op: "removeMember" }); toastError("Couldn't remove them: " + (e?.message || e)); refreshWorkspaceMembers(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastError, toastSuccess, refreshWorkspaceMembers]);

  const setMemberRole = useCallback((memberId: string, role: Role) => {
    setWsMembers((xs) => xs.map((m) => m.id === memberId ? { ...m, role } : m));
    store.setMemberRole(memberId, role).catch((e) => { reportError(e, { op: "setMemberRole" }); toastError("Couldn't change the role: " + (e?.message || e)); refreshWorkspaceMembers(); });
  }, [toastError, refreshWorkspaceMembers]);

  const setMemberTitle = useCallback((memberId: string, title: string) => {
    setWsMembers((xs) => xs.map((m) => m.id === memberId ? { ...m, title: title.trim() || undefined } : m));
    store.setMemberTitle(memberId, title).catch((e) => { reportError(e, { op: "setMemberTitle" }); toastError("Couldn't save the position: " + (e?.message || e)); refreshWorkspaceMembers(); });
  }, [toastError, refreshWorkspaceMembers]);

  const transferOwnership = useCallback((workspaceId: string, memberId: string) => {
    store.transferOwnership(workspaceId, memberId)
      .then(() => { toastSuccess("Ownership transferred"); refreshWorkspaceMembers(); })
      .catch((e) => { reportError(e, { op: "transferOwnership" }); toastError("Couldn't transfer ownership: " + (e?.message || e)); });
  }, [toastError, toastSuccess, refreshWorkspaceMembers]);

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

  // AI auto-prioritise: your own open tasks in this workspace (never teammates')
  const autoPrioritize = useCallback(async () => {
    const cur = tasksRef.current; if (!cur) return;
    const ws = workspaceRef.current;
    if (denyGuest([ws])) return;
    setRouteRaw({ view: "tasks" }); setSmart(true); setSidebarOpen(false); setDetailId(null);
    const me = userIdRef.current;
    const archivedP = new Set(projectsRef.current.filter((p) => p.archivedAt).map((p) => p.id));
    const scope = cur.filter((t) => (t.workspaceId ?? null) === ws && t.status !== "done" && !t.archivedAt && !archivedP.has(t.projectId)
      && (t.assigneeId === me || (t.collaborators ?? []).includes(me)));
    if (!scope.length) { toastInfo("Nothing open is assigned to you here yet."); return; }
    setAiBusy(true);
    try {
      const res = await store.aiPrioritize(scope, toLocalISO(new Date()));
      const mine = new Set(scope.map((t) => t.id));
      const patches = new Map(res.items.filter((i) => mine.has(i.id)).map((i) => [i.id, { aiScore: i.score, aiReason: i.reason } as Partial<Task>]));
      applyLocal(patches);
      patches.forEach((p, id) => { writeTask(id, p).catch(() => { /* scores are advisory — a failed write just recomputes next time */ }); });
      toastSuccess((res.source === "ai" ? "✨ " : "") + res.summary);
      // ranked without AI because the server said why (daily limit, awaiting approval): tell them
      const why = res.source === "heuristic" ? store.aiNotice() : null;
      if (why) toastInfo(why);
    } catch (e) {
      reportError(e, { op: "autoPrioritize" });
      toastError("Couldn't prioritise right now.");
    } finally { setAiBusy(false); }
  }, [denyGuest, applyLocal, writeTask, toastSuccess, toastError, toastInfo]);

  const openNewTask = useCallback((status: Status = "todo") => {
    const r = routeRef.current;
    const pid = r.view === "project" ? r.projectId : undefined;
    if (denyGuest([pid ? projectWs(pid) : workspaceRef.current])) return;
    // creating a task while viewing a project drops it into that project
    setNewTaskProjectId(pid);
    setNewTaskStatus(status); setNewTaskOpen(true);
  }, [denyGuest]);
  const openCapture = useCallback(() => {
    if (denyGuest([workspaceRef.current])) return;
    setQuickCaptureOpen(true);
  }, [denyGuest]);
  openNewTaskRef.current = () => openNewTask();
  openCaptureRef.current = openCapture;

  // opening Focus never resumes a paused timer by itself; "Start a focus block" does start it
  const openFocus = (start?: boolean) => { if (start === true && !focus.running) focus.setRunning(true); setFocusOpen(true); };
  // focus on one task: bank what was running for another task, then start fresh at this task's estimate
  const focusTask = (id: string) => {
    const t = tasksRef.current?.find((x) => x.id === id);
    if (focus.seconds > 0 && focus.taskId && focus.taskId !== id) focus.endSession();
    focus.setTaskId(id);
    if (!focus.pomodoro && t) focus.setTargetMin(Math.max(5, t.focusMin || t.dur || 30));
    setDetailId(null); setFocusOpen(true); focus.setRunning(true);
  };

  // Early-access gate: a platform admin is always let through — by the profile's
  // is_admin flag, or else by asking the server (is_admin(), which also knows the
  // founding account and, once 0042 is live, says no for a suspended admin).
  // Only asked when the gate would otherwise stop someone.
  const gated = auth.configured && !!profile && (profile.suspended === true || profile.approved === false);
  const adminByFlag = !!profile?.isAdmin && profile.suspended !== true;
  const [adminCheck, setAdminCheck] = useState<{ uid: string; admin: boolean } | null>(null);
  useEffect(() => {
    if (!gated || adminByFlag || !authUserId) return;
    let alive = true;
    store.amIAdmin().then((admin) => { if (alive) setAdminCheck({ uid: authUserId, admin }); }, () => { if (alive) setAdminCheck({ uid: authUserId, admin: false }); });
    return () => { alive = false; };
  }, [gated, adminByFlag, authUserId]);
  const adminChecked = adminCheck?.uid === authUserId;
  const letAdminIn = adminByFlag || (adminChecked && adminCheck!.admin);

  // "today" moved on (a tab left open overnight): day-based counts are recomputed
  const [dayKey, setDayKey] = useState(() => toLocalISO(KANBO_TODAY));
  useEffect(() => {
    const onDay = () => setDayKey(toLocalISO(KANBO_TODAY));
    window.addEventListener(DAY_CHANGE_EVENT, onDay);
    return () => window.removeEventListener(DAY_CHANGE_EVENT, onDay);
  }, []);
  // scope everything to the active workspace (memoised: the focus timer re-renders
  // App every second, and the Sidebar's badge counts key off this list)
  const allTasks = useMemo(() => {
    const archivedProjectIds = new Set(projects.filter((p) => p.archivedAt).map((p) => p.id));
    return (tasks ?? []).filter((t) => (t.workspaceId ?? null) === workspace && !t.archivedAt && !archivedProjectIds.has(t.projectId));
  }, [tasks, projects, workspace]);
  // Smart-list counts are computed over the SAME global task set the Search
  // view filters (search spans every workspace), so the sidebar badge and the
  // results it opens always agree. Saved searches become user-defined smart
  // lists with live counts over the same set (one predicate, always in sync).
  const { smartCounts, savedSearchCounts } = useMemo(() => {
    const all = tasks ?? [];
    const smart: Record<string, number> = {};
    for (const sl of SMART_LISTS) smart[sl.id] = all.filter((t) => sl.match(t, currentUserId)).length;
    const saved: Record<string, number> = {};
    for (const ss of savedSearches) { const q = toQuery(ss.query); saved[ss.id] = all.filter((t) => taskMatchesQuery(t, q)).length; }
    return { smartCounts: smart, savedSearchCounts: saved };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, projects, savedSearches, currentUserId, dayKey]);
  useEffect(() => { if (route.view !== "search" && searchPrefill) setSearchPrefill(null); }, [route.view, searchPrefill]);

  // ---- auth / loading gates ----
  if (auth.recovery) return <UpdatePasswordScreen />;
  // still restoring the session: a loader, never a flash of the marketing site
  if (auth.configured && auth.loading) return <FullLoader />;
  if (auth.configured && !auth.user) return <PublicSite />;
  if (auth.loading || tasks === null) return <FullLoader />;
  // Early-access gate: a brand-new account stays in a waiting room until an admin
  // approves it. Fail-open — only blocks when we KNOW approved === false (or
  // suspended), never on a load hiccup — and platform admins are let through.
  if (gated && !letAdminIn) {
    if (!adminByFlag && !adminChecked) return <FullLoader />; // asking the server whether this is an admin
    return profile!.suspended === true
      ? <PendingApproval email={auth.user?.email} onSignOut={auth.signOut} suspended />
      : <PendingApproval email={auth.user?.email} onSignOut={auth.signOut} />;
  }
  if (subscription && !hasAccess(subscription)) {
    const seats = Math.max(1, wsMembers.filter((m) => m.status === "active").length || 1);
    return <Paywall sub={subscription} seats={seats} busyPlan={checkoutBusy} onChoose={startCheckout} onManageBilling={manageBilling} onSignOut={auth.configured ? auth.signOut : undefined} />;
  }

  // "mine": assigned to me or I'm a collaborator. Planning, Focus and My week are
  // personal — they never show (or schedule) teammates' work.
  const isMine = (t: Task) => t.assigneeId === currentUserId || (t.collaborators ?? []).includes(currentUserId);
  const myTasks = allTasks.filter(isMine);
  // "Show archived" follows the page: this project's archived tasks, or mine in My tasks
  const wsArchived = tasks.filter((t) => (t.workspaceId ?? null) === workspace && !!t.archivedAt);
  const archivedTasks = route.view === "project" && route.projectId ? wsArchived.filter((t) => t.projectId === route.projectId) : wsArchived.filter(isMine);
  const savedActive = route.list ? savedSearches.find((s) => s.id === route.list) : undefined;
  const searchPreset = smartListQuery(route.list, currentUserId) ?? (savedActive ? (toQuery(savedActive.query) as unknown as Record<string, string>) : undefined)
    ?? (searchPrefill ? { text: searchPrefill.text } : undefined);
  const searchPresetKey = route.list ?? searchPrefill?.key;

  const activeWsName = workspaces.find((w) => w.id === workspace)?.name || "Personal";
  const myRole = wsMembers.find((m) => m.userId === currentUserId && (m.workspaceId ?? null) === workspace && m.status === "active")?.role;
  // guests can view and comment only — views can use these to hide editing controls
  const activeReadOnly = myRole === "guest";
  const detailTask = detailId ? tasks.find((t) => t.id === detailId) : undefined;
  const detailReadOnly = !!detailTask && roleIn(detailTask.workspaceId) === "guest";

  // scope tasks by route
  let scoped = allTasks, title = "My tasks", subtitle = "Everything assigned to you", breadcrumb = activeWsName;
  let newProj = getProject("");
  // "My tasks" stays within the workspace you're viewing — your personal tasks
  // never mix with a team workspace's, and vice versa.
  if (route.view === "tasks") { scoped = myTasks; }
  else if (route.view === "project" && route.projectId) {
    const p = getProject(route.projectId); newProj = p;
    scoped = allTasks.filter((t) => t.projectId === route.projectId);
    // top-level tasks only (sub-tasks nest under them), so the number matches the rows and the progress bar
    const prog = topLevelProgress(scoped);
    title = p?.name || "Project"; subtitle = `${plural(prog.count, "task")} · ${prog.pct}% complete`;
    breadcrumb = workspaces.find((w) => w.id === (p?.workspaceId ?? null))?.name || "Personal";
  }
  const wsProjects = projects.filter((p) => (p.workspaceId ?? null) === workspace && !p.archivedAt);
  // people you can assign/tag: active members of the ACTIVE workspace only, by
  // their profile name (then their invite name, then email). Personal resolves
  // to just you — you can never tag someone from another workspace.
  const personName = (m: WorkspaceMember) => getMember(m.userId ?? "")?.name || m.name || m.email;
  const assignees = (() => {
    const active = wsMembers.filter((m) => m.status === "active" && m.userId && (m.workspaceId ?? null) === workspace).map((m) => ({ id: m.userId!, name: personName(m) }));
    return active.length > 0 ? active : [{ id: currentUserId, name: getMember(currentUserId)?.name || "You" }];
  })();
  // Search spans every workspace, so its people filter does too
  const everyone = (() => {
    const seen = new Map<string, string>([[currentUserId, getMember(currentUserId)?.name || "You"]]);
    wsMembers.forEach((m) => { if (m.status === "active" && m.userId && !seen.has(m.userId)) seen.set(m.userId, personName(m)); });
    return [...seen].map(([id, name]) => ({ id, name }));
  })();

  const currentUser = getMember(currentUserId);
  const firstName = currentUser?.name?.trim().split(/\s+/)[0] || "there";
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const monthLabel = new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const wsKey = workspace ?? "personal";
  const canManageProject = (p: Project) => !activeReadOnly && (myRole === "owner" || myRole === "admin" || p.ownerId === currentUserId || !p.ownerId);
  // where Plan's quick capture files a task (createFromPlan uses the same rule), so its preview agrees
  const planProjectId = wsProjects.find((p) => !p.id.startsWith("tmp-"))?.id ?? "p-personal";

  const renderMain = () => {
    switch (route.view) {
      case "plan": return <PlanView tasks={myTasks} onUpdate={patchTask} onCreate={createFromPlan} onOpen={setDetailId} externalEvents={calEvents} calendarConnected={calConnections.length > 0} currentUserId={currentUserId} captureDefaults={{ projectId: planProjectId, assigneeId: currentUserId }} />;
      case "myweek": return <MyWeekView tasks={myTasks} onOpen={setDetailId} onPatch={patchTask} currentUserId={currentUserId} />;
      // Home keeps the workspace's tasks for its project cards and "is this workspace empty?"
      // (a new member with nothing assigned yet isn't on a clean slate); its personal
      // widgets — today's brief, focus queue, weekly chart — use yours
      case "home": return <HomeView tasks={allTasks} myTasks={myTasks} projects={wsProjects} userName={currentUser?.name} onOpen={setDetailId} setRoute={setRoute} openFocus={() => openFocus(true)} onNewProject={() => setNewProjectOpen(true)} onNewTask={() => openNewTask()} onAutoPrioritize={autoPrioritize} aiBusy={aiBusy} calendarConnected={calConnections.length > 0} hasTeam={workspaces.some((w) => w.id !== null)} canCreateProject={!activeReadOnly} />;
      case "analytics": return <AnalyticsView key={wsKey} tasks={allTasks} members={assignees} customFields={customFields} projects={wsProjects} onOpen={setDetailId} />;
      case "reports": return <ReportsView key={wsKey} tasks={allTasks} projects={wsProjects} members={assignees} onOpen={setDetailId} />;
      case "search": return <SearchView tasks={tasks} projects={projects} members={everyone} currentUserId={currentUserId} onOpen={setDetailId} savedSearches={savedSearches} onSaveSearch={saveSearch}
        onDeleteSavedSearch={(id) => { removeSavedSearch(id)?.catch(() => toastError("Couldn't delete the saved search.")); }}
        preset={searchPreset} presetKey={searchPresetKey} onBulkPatch={bulkPatch} onBulkDelete={bulkDelete} sections={sections} customFields={customFields} />;
      case "workload": return <WorkloadView tasks={allTasks} members={assignees} onOpen={setDetailId} />;
      case "goals": return <GoalsView goals={goals.filter((g) => (g.workspaceId ?? null) === workspace)} projects={wsProjects} tasks={allTasks} onCreate={createGoal} onUpdate={updateGoal} onDelete={deleteGoal} />;
      case "portfolios": return <PortfoliosView portfolios={portfolios.filter((p) => (p.workspaceId ?? null) === workspace)} projects={wsProjects} tasks={allTasks} onCreate={createPortfolio} onUpdate={updatePortfolio} onDelete={deletePortfolio} onOpenProject={(pid) => setRoute({ view: "project", projectId: pid })} statusUpdates={statusUpdates} />;
      case "automations": return <AutomationsView key={wsKey} rules={automationRules.filter((r) => wsProjects.some((p) => p.id === r.projectId))} projects={wsProjects} members={assignees} sections={sections} tags={tags} onCreate={createRule} onUpdate={updateRule} onDelete={deleteRule} />;
      case "forms": return <FormsView key={wsKey} forms={forms.filter((f) => wsProjects.some((p) => p.id === f.projectId))} projects={wsProjects} members={assignees} onCreate={createForm} onUpdate={updateForm} onDelete={deleteForm} onSubmit={submitForm} />;
      case "inbox": return <InboxView activity={scopedActivity} tasks={allTasks} onOpen={setDetailId} onArchive={archiveActivity} onClearAll={clearInbox} />;
      case "calendar": return <CalendarView tasks={allTasks} onOpen={setDetailId} onPatch={patchTask} connections={calConnections} externalEvents={calEvents} onConnect={connectCalendar} onDisconnect={disconnectCalendar} syncing={calSyncing} readOnly={activeReadOnly} />;
      case "team": return <TeamView tasks={allTasks} workspace={workspace} workspaces={workspaces} members={wsMembers} currentUserId={currentUserId} myRole={myRole} onInvite={inviteMember} onResendInvite={store.configured ? resendInvite : undefined} onRemoveMember={removeMember} onSetRole={setMemberRole} onSetTitle={setMemberTitle} onTransferOwnership={transferOwnership} onOpen={setDetailId} onNewWorkspace={() => setNewWorkspaceOpen(true)} onUpdateWorkspace={updateWorkspace} onUploadLogo={uploadWorkspaceLogo} onDeleteWorkspace={deleteWorkspace} />;
      case "tasks":
      case "project":
        return <TasksPage key={`${route.view}:${route.projectId ?? ""}:${wsKey}`} filterScope={route.view === "project" && route.projectId ? route.projectId : "my"} readOnly={activeReadOnly}
          boardScope={route.view === "project" && route.projectId ? `project:${route.projectId}` : `my:${wsKey}`}
          exportName={route.view === "project" && newProj ? newProj.name : "my-tasks"}
          tasks={scoped} allTasks={allTasks} projects={wsProjects} view={view} setView={setView} groupBy={groupBy} setGroupBy={setGroupBy} smart={smart} setSmart={setSmart} onOpen={setDetailId} onToggle={toggleTask} onToggleSubtask={toggleSubtask} onAdd={openNewTask} onMove={(id, status, position) => {
            // a reorder within the same column is not a status change (completedAt stays put)
            const prev = tasksRef.current?.find((t) => t.id === id);
            const patch: Partial<Task> = {};
            if (prev && prev.status !== status) patch.status = status;
            if (position !== undefined) patch.position = position;
            if (Object.keys(patch).length) patchTask(id, patch);
          }} onBulkPatch={bulkPatch} onBulkDelete={bulkDelete} onPatch={patchTask} onQuickAdd={quickAddTask} onOpenImport={activeReadOnly ? undefined : () => setImportOpen(true)} members={assignees} allTags={tags}
          archivedTasks={archivedTasks}
          sections={route.view === "tasks" ? sections.filter((s) => s.projectId === "__my") : (route.view === "project" && route.projectId ? sections.filter((s) => s.projectId === route.projectId) : sections)}
          onCreateSection={createSection} onRenameSection={renameSection} onDeleteSection={deleteSection}
          sectionField={route.view === "tasks" ? "mySectionId" : "sectionId"}
          sectionProjectId={route.view === "tasks" ? "__my" : route.projectId}
          customFields={route.view === "project" && route.projectId ? customFields.filter((f) => f.projectId === route.projectId) : customFields}
          exportOpts={{ sections, customFields: route.view === "project" && route.projectId ? customFields.filter((f) => f.projectId === route.projectId) : customFields, allTasks }}
          header={route.view === "project" && newProj && newProj.id !== "p-personal" ? <ProjectOverview project={newProj} tasks={scoped} onUpdate={updateProject} statusUpdates={statusUpdates} onPostStatus={activeReadOnly ? undefined : postStatusUpdate} members={assignees} onDuplicate={activeReadOnly ? undefined : duplicateProject} onArchive={activeReadOnly ? undefined : (id) => setProjectArchived(id, true)} canManagePeople={canManageProject(newProj)} /> : undefined} />;
      default: return null;
    }
  };

  const headerMap: Record<Route["view"], { title: string; subtitle: string; breadcrumb: string }> = {
    plan: { title: `${greet}, ${firstName}`, subtitle: "Here's your day.", breadcrumb: "Plan" },
    myweek: { title: "My week", subtitle: "Plan the week and clear what slipped.", breadcrumb: "Plan" },
    home: { title: "Home", subtitle: "A focused look at what's moving today.", breadcrumb: "Today" },
    analytics: { title: "Analytics", subtitle: "Your throughput, measured.", breadcrumb: "Insights" },
    reports: { title: "Reports", subtitle: "Trends, velocity, and cycle time.", breadcrumb: "Reporting" },
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

  // App keeps the open project valid (its route guard), so the Sidebar's own guard stays off
  const sidebar = (
    <Sidebar route={route} setRoute={setRoute} workspace={workspace} setWorkspace={setWorkspace} workspaces={workspaces} onNewWorkspace={() => setNewWorkspaceOpen(true)} focus={focus} openFocus={openFocus} tasks={allTasks} projects={projects} inboxCount={inboxCount}
      currentUserId={currentUserId} currentUser={currentUser} onSignOut={auth.configured ? auth.signOut : undefined} onOpenSettings={() => setSettingsOpen(true)} onNewProject={() => setNewProjectOpen(true)} onDeleteProject={(id) => setDeleteProjectId(id)} onArchiveProject={(id) => setProjectArchived(id, true)} onRestoreProject={(id) => setProjectArchived(id, false)}
      subscription={subscription} onUpgrade={() => setUpgradeOpen(true)} onManageBilling={manageBilling} smartCounts={smartCounts}
      savedSearches={savedSearches} savedSearchCounts={savedSearchCounts} onDeleteSavedSearch={removeSavedSearch}
      myRole={myRole} guardRoute={false} />
  );

  const bannerTone = (kind: string) => (kind === "warning" ? "var(--st-review)" : kind === "success" ? "var(--st-done)" : "var(--accent)");

  return (
    <div style={{ position: "relative", height: "100vh", display: "flex", overflow: "hidden" }}>
      <AppBg grid />
      <GlobalTipStyles />
      {isMobile ? (
        <>
          {sidebarOpen && <div aria-hidden="true" onClick={() => setSidebarOpen(false)} className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 49, background: "color-mix(in oklch, var(--bg-deep) 50%, transparent)", backdropFilter: "blur(2px)" }} />}
          <div ref={drawerRef} role="dialog" aria-modal={sidebarOpen ? true : undefined} aria-label="Menu" aria-hidden={sidebarOpen ? undefined : true} style={{ position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 50, transform: sidebarOpen ? "none" : "translateX(-100%)", boxShadow: sidebarOpen ? "var(--shadow-lg)" : "none",
            // hidden (not just off-screen) once the slide-out finishes, so nothing in it can be reached
            visibility: sidebarOpen ? "visible" : "hidden", transition: sidebarOpen ? "transform .25s var(--ease), visibility 0s" : "transform .25s var(--ease), visibility 0s linear .25s" }}>
            {sidebar}
          </div>
        </>
      ) : sidebar}
      <main id="main" tabIndex={-1} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative", zIndex: 1, outline: "none" }}>
        {!online && (
          <div role="status" style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 18px", background: "color-mix(in oklch, var(--st-review) 16%, var(--surface-raised))", borderBottom: "1px solid color-mix(in oklch, var(--st-review) 30%, transparent)" }}>
            <Icon name="refresh" size={14} style={{ color: "var(--st-review)", flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: "var(--ink-2)", fontWeight: 500 }}>
              You're offline — changes are saved on this device{pendingSync > 0 ? ` (${pendingSync} queued)` : ""} and will sync when you reconnect.
            </span>
          </div>
        )}
        {online && (syncing || pendingSync > 0) && (
          <div role="status" style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 18px", background: "color-mix(in oklch, var(--accent) 12%, var(--surface-raised))", borderBottom: "1px solid color-mix(in oklch, var(--accent) 26%, transparent)" }}>
            <Icon name="refresh" size={14} style={{ color: "var(--accent)", flexShrink: 0 }} className={syncing ? "spin" : undefined} />
            <span style={{ fontSize: 13, color: "var(--ink-2)", fontWeight: 500 }}>{syncing ? `Syncing ${pendingSync || ""} offline change${pendingSync === 1 ? "" : "s"}…` : `${plural(pendingSync, "change")} waiting to sync`}</span>
            {!syncing && <button onClick={flushOffline} className="btn btn-ghost" style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 12 }}>Retry now</button>}
          </div>
        )}
        {deadLetters.length > 0 && (
          <div role="status" style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", padding: "7px 18px", background: "color-mix(in oklch, var(--st-blocked) 11%, var(--surface-raised))", borderBottom: "1px solid color-mix(in oklch, var(--st-blocked) 26%, transparent)" }}>
            <Icon name="refresh" size={14} style={{ color: "var(--st-blocked)", flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 200, fontSize: 13, color: "var(--ink-2)", fontWeight: 500 }}>
              {/* retryable: a server problem that may clear up; otherwise the server refused the change itself (e.g. no permission) */}
              {plural(deadLetters.length, "change")} couldn't be synced{deadLetters.every((d) => !d.retryable) ? ` — the server turned ${deadLetters.length === 1 ? "it" : "them"} down` : ""}. {deadLetters.length === 1 ? "It's" : "They're"} kept on this device.
            </span>
            <button onClick={retryDeadLetters} disabled={!online || syncing} className="btn btn-ghost" style={{ padding: "3px 10px", fontSize: 12 }}>Retry</button>
            <button onClick={discardDeadLetters} className="btn btn-ghost" style={{ padding: "3px 10px", fontSize: 12, color: "var(--ink-3)" }}>Discard</button>
          </div>
        )}
        {unsavedIds.length > 0 && (
          <div role="status" style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", padding: "7px 18px", background: "color-mix(in oklch, var(--st-blocked) 11%, var(--surface-raised))", borderBottom: "1px solid color-mix(in oklch, var(--st-blocked) 26%, transparent)" }}>
            <Icon name="refresh" size={14} style={{ color: "var(--st-blocked)", flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 200, fontSize: 13, color: "var(--ink-2)", fontWeight: 500 }}>
              {plural(unsavedIds.length, "task")} couldn't be saved — {unsavedIds.length === 1 ? "it's" : "they're"} only on this screen for now.
            </span>
            <button onClick={retryUnsaved} className="btn btn-ghost" style={{ padding: "3px 10px", fontSize: 12 }}>Retry</button>
            <button onClick={discardUnsaved} className="btn btn-ghost" style={{ padding: "3px 10px", fontSize: 12, color: "var(--ink-3)" }}>Discard</button>
          </div>
        )}
        {activeReadOnly && (
          <div role="note" style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 18px", background: "var(--fill-1, var(--surface-2))", borderBottom: "1px solid var(--hairline)" }}>
            <Icon name="lock" size={13} style={{ color: "var(--ink-4)", flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>You're a guest in {activeWsName} — you can view and comment. Ask a workspace admin for member access to edit.</span>
          </div>
        )}
        {banner && banner.id !== bannerDismissed && (() => {
          const c = bannerTone(banner.kind);
          return (
            <div role="status" style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 18px", background: `color-mix(in oklch, ${c} 14%, var(--surface-raised))`, borderBottom: `1px solid color-mix(in oklch, ${c} 30%, transparent)` }}>
              <Icon name="bell" size={15} style={{ color: c, flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 13.5, color: "var(--ink-2)", fontWeight: 500 }}>{banner.message}</span>
              <button onClick={() => { setBannerDismissed(banner.id); try { localStorage.setItem("kanbo-banner-dismissed", banner.id); } catch { /* ignore */ } }} aria-label="Dismiss announcement" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", padding: 2, flexShrink: 0 }}><Icon name="x" size={16} /></button>
            </div>
          );
        })()}
        {BILLING_ENABLED && subscription?.status === "trialing" && <TrialBanner sub={subscription} onUpgrade={() => setUpgradeOpen(true)} />}
        <Topbar {...headerProps} theme={resolvedTheme} toggleTheme={flipTheme}
          hasUnread={inboxCount > 0} unreadCount={inboxCount} canCreateProject={!activeReadOnly} onMenu={isMobile ? () => setSidebarOpen(true) : undefined}
          onNewTask={() => openNewTask()} onNewProject={() => setNewProjectOpen(true)} onCommand={() => setCmdOpen(true)} onBell={() => setRoute({ view: "inbox" })}>
          {(route.view === "project") && newProj && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "0 4px" }}>
              <span style={{ fontSize: 22 }}>{newProj.emoji}</span>
            </span>
          )}
        </Topbar>
        <ErrorBoundary key={`${route.view}:${route.projectId ?? ""}`} inline name="view" onHome={() => setRoute({ view: "home" })}>
          <RenderView render={renderMain} />
        </ErrorBoundary>
        {isMobile && <MobileNav route={route} setRoute={setRoute} inboxCount={inboxCount} />}
      </main>

      <ImportTasksModal open={importOpen} onClose={() => setImportOpen(false)}
        projects={wsProjects} members={assignees.map((a) => ({ ...a, email: wsMembers.find((m) => m.userId === a.id)?.email }))}
        sections={sections.filter((s) => !s.id.startsWith("tmp-") && wsProjects.some((p) => p.id === s.projectId))}
        defaultProjectId={route.view === "project" ? route.projectId : undefined}
        defaultProjectName={route.view === "project" ? newProj?.name : undefined}
        supports={{ details: true, subtasks: true, newTags: true, newSections: true }}
        onImport={importTasks} />

      {/* tasks and projects from every workspace (like Search); opening a project elsewhere switches to its workspace */}
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} tasks={tasks} onOpenTask={setDetailId}
        projects={projects} workspaces={workspaces} canCreateProject={!activeReadOnly}
        onOpenProject={(id) => {
          const p = projects.find((x) => x.id === id);
          if (p && (p.workspaceId ?? null) !== workspace) setWorkspace(p.workspaceId ?? null);
          setRoute({ view: "project", projectId: id });
        }}
        onSearchAll={(text) => { setRoute({ view: "search" }); setSearchPrefill({ text, key: "q-" + Date.now() }); }}
        onAction={(s) => {
        if (s.id === "new-task") openNewTask();
        else if (s.id === "quick-capture") openCapture();
        else if (s.id === "new-project") setNewProjectOpen(true);
        else if (s.id === "prioritize") autoPrioritize();
        else if (s.id === "focus") openFocus(true);
        else if (s.id === "board") { setRoute({ view: "tasks" }); setView("board"); }
        else if (s.id === "manage-tags") setTagManagerOpen(true);
        else if (s.id === "toggle-theme") flipTheme();
        else if (s.id === "settings") setSettingsOpen(true);
      }} onNavigate={(v) => setRoute({ view: v as Route["view"] })} />

      <TagManagerModal open={tagManagerOpen} onClose={() => setTagManagerOpen(false)} tags={tags}
        taskCounts={(() => { const c: Record<string, number> = {}; (tasks ?? []).forEach((t) => (t.tags || []).forEach((tg) => { c[tg] = (c[tg] || 0) + 1; })); return c; })()}
        onUpdate={updateTag} onDelete={deleteTag} onMerge={mergeTags} onCreate={createTag} />
      {shortcutsOpen && (
        <div onClick={() => setShortcutsOpen(false)} className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 200, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}>
          <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="glass anim-scalein" style={{ width: 440, maxWidth: "94vw", borderRadius: 18, padding: 22, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
              <Icon name="command" size={18} style={{ color: "var(--accent)" }} />
              <h2 style={{ fontSize: 17, fontWeight: 600 }}>Keyboard shortcuts</h2>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <button autoFocus onClick={() => setShortcutsOpen(false)} className="btn-icon" aria-label="Close keyboard shortcuts" style={{ marginLeft: "auto", border: "none" }}><Icon name="x" size={16} /></button>
            </div>
            {([["⌘K · Ctrl+K", "Command palette"], ["c", "New task"], ["q", "Quick capture"], ["/", "Search"], ["g then h", "Home"], ["g then p", "Plan my day"], ["g then i", "Inbox"], ["g then t", "My tasks"], ["g then c", "Calendar"], ["g then s", "Search"], ["g then a", "Analytics"], ["g then r", "Reports"], ["g then w", "My week"], ["?", "This help"], ["Esc", "Close / dismiss"]] as [string, string][]).map(([k, d]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", padding: "7px 0", borderTop: "1px solid var(--hairline)" }}>
                <span style={{ flex: 1, fontSize: 13.5, color: "var(--ink-2)" }}>{d}</span>
                <kbd className="mono" style={{ fontSize: 11.5, padding: "2px 8px", borderRadius: 6, background: "var(--surface-2)", border: "1px solid var(--hairline)", color: "var(--ink-3)" }}>{k}</kbd>
              </div>
            ))}
            <p style={{ margin: "12px 0 0", fontSize: 12, color: "var(--ink-4)" }}>Single-key shortcuts pause while you're typing or a dialog is open.</p>
          </div>
        </div>
      )}
      {detailId && (
        <ErrorBoundary key={detailId} inline floating name="task-panel" onHome={() => setDetailId(null)} homeLabel="Close">
          <TaskDetail taskId={detailId} tasks={tasks} tags={tags} activity={activity} members={wsMembers} currentUserId={currentUserId} onClose={() => setDetailId(null)} onOpenTask={setDetailId} projects={projects} onToggle={toggleTask} onPatch={patchTask} onDelete={deleteTask} onDuplicate={duplicateTask} onArchive={archiveTask} onUnarchive={unarchiveTask} onToggleSubtask={toggleSubtask} onAddSubtask={addSubtask} onCreateTag={createTag} onDeleteTag={deleteTag} onAddComment={addComment} onFocus={focusTask} onAddDependency={addDependency} onRemoveDependency={removeDependency} onToggleFollow={toggleFollow} onToggleTaskReaction={toggleTaskReaction} onToggleCollaborator={toggleCollaborator} customFields={customFields.filter((f) => f.projectId === detailTask?.projectId)} onCreateCustomField={createCustomField} onDeleteCustomField={deleteCustomField} sections={sections.filter((s) => s.projectId === detailTask?.projectId)} onCreateSection={createSection} onConvertComment={(body, pid) => { quickAddTask({ title: body.slice(0, 200), projectId: pid }); toastSuccess("Comment added as a task"); }}
            readOnly={detailReadOnly} />
        </ErrorBoundary>
      )}
      {/* suggestions are yours; the task you chose to focus on (anyone's) is always included */}
      {focusOpen && <FocusMode focus={focus} tasks={focus.taskId && !myTasks.some((t) => t.id === focus.taskId) ? [...myTasks, ...tasks.filter((t) => t.id === focus.taskId)] : myTasks} onClose={() => setFocusOpen(false)} onOpenTask={(id) => { setFocusOpen(false); setDetailId(id); }} />}
      <NewTaskModal open={newTaskOpen} onClose={() => setNewTaskOpen(false)} onCreate={createTask} onCreateTag={createTag} onDeleteTag={deleteTag} projects={wsProjects} allTags={tags} members={wsMembers} currentUserId={currentUserId} defaultStatus={newTaskStatus} defaultProjectId={newTaskProjectId}
        tagUsage={(id) => tasks.filter((t) => t.tags.includes(id)).length} />
      <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} onCreate={createProject} workspaceId={workspace} />
      {/* one first-run dialog at a time: the name step (Welcome) first, then the tour */}
      <OnboardingModal open={onboardOpen && !welcomeOpen} profile={profile} workspaceId={workspace} onSaveProfile={saveProfile} onCreateProject={createProject} onFinish={finishOnboarding} />
      <NewWorkspaceModal open={newWorkspaceOpen} onClose={() => setNewWorkspaceOpen(false)} onCreate={createWorkspace} />
      <WelcomeModal open={welcomeOpen} onClose={dismissWelcome}
        canSkip={!!((profile?.firstName?.trim()) || (profile?.lastName?.trim()))}
        onSaveProfile={(firstName, lastName) => saveProfile({ firstName, lastName, pronouns: profile?.pronouns ?? "" })}
        name={currentUser?.name && !currentUser.name.includes("@") ? currentUser.name : undefined}
        initialFirst={profile?.firstName ?? ""} initialLast={profile?.lastName ?? ""} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)}
        initial={{ firstName: profile?.firstName ?? "", lastName: profile?.lastName ?? "", pronouns: profile?.pronouns ?? "", avatarUrl: profile?.avatarUrl ?? null }}
        email={auth.user?.email ?? currentUser?.email ?? ""} color={currentUser?.color ?? SELF_COLOR}
        onUpload={uploadAvatar} onSave={saveProfile} onExport={exportData} onDeleteAccount={deleteAccount}
        notifyPrefs={profile?.notifyPrefs ?? {}} onSaveNotifyPrefs={saveNotifyPrefs}
        appearance={appearance} onChangeAppearance={setAppearance}
        theme={theme} onChangeTheme={setTheme} />
      <QuickCapture open={quickCaptureOpen} onClose={() => setQuickCaptureOpen(false)} projects={wsProjects} members={assignees}
        defaultProjectId={routeRef.current.view === "project" ? routeRef.current.projectId : undefined} onCreate={quickAddTask} />
      <UpgradeModal open={upgradeOpen} onClose={() => setUpgradeOpen(false)} seats={Math.max(1, wsMembers.filter((m) => m.status === "active").length || 1)} busyPlan={checkoutBusy} onChoose={startCheckout} />
      {deleteProjectId && (() => {
        const proj = getProject(deleteProjectId);
        if (!proj) return null;
        // counted from every task (an archived project's tasks aren't in allTasks), so a
        // project holding only archived tasks never claims to be empty
        const own = tasks.filter((t) => t.projectId === deleteProjectId);
        return <DeleteProjectModal project={proj} taskCount={own.filter((t) => !t.archivedAt).length} archivedCount={own.filter((t) => !!t.archivedAt).length} projects={projects}
          onArchive={proj.archivedAt || !canArchiveProject(proj, { myRole: roleIn(proj.workspaceId) }) ? undefined : () => setProjectArchived(proj.id, true)}
          onConfirm={(mode, target) => { confirmDeleteProject(deleteProjectId, mode, target); }} onClose={() => setDeleteProjectId(null)} />;
      })()}
    </div>
  );
}

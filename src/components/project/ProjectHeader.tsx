/* ============================================================
   KANBO — project header. Today: the project overview card that
   sits above a project's tasks. The redesign's pieces (title
   addon, actions, panels, notice) start here as W0 stubs.
   ============================================================ */
import { useState, useEffect } from "react";
import { Icon, Avatar, StatusDot, EmojiPicker, Collapse } from "../primitives";
import { STATUS_KIND_META } from "../views/GoalsPortfolios";
import { AutomationsView, FormsView } from "../views/RulesForms";
import { STATUS_META, getMember, KANBO_TODAY } from "../../data/data";
import type { Task, Project, Status, StatusUpdate, StatusKind } from "../../data/types";
import type { ProjectTab } from "../../app-types";
import type { AiOutcome } from "../../lib/askTypes";
import type { Risk } from "../../lib/radar";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const PROJECT_STATUSES: { v: string; label: string; color: string }[] = [
  { v: "on_track", label: "On track", color: "var(--st-done)" },
  { v: "at_risk", label: "At risk", color: "var(--st-review)" },
  { v: "off_track", label: "Off track", color: "var(--st-blocked)" },
  { v: "on_hold", label: "On hold", color: "var(--ink-4)" },
];

/** "today", "yesterday", "3 days ago", or a date — for status-update freshness. */
export function relDay(iso: string): { label: string; days: number } {
  const then = new Date(iso); const now = new Date();
  const days = Math.max(0, Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / 86400000));
  const label = days === 0 ? "today" : days === 1 ? "yesterday" : days < 14 ? `${days} days ago` : then.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: then.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  return { label, days };
}

export function ProjectOverview({ project, tasks: allProjectTasks, onUpdate, statusUpdates = [], onPostStatus, members = [], canManagePeople = false, onDuplicate, onArchive }: { project: Project; tasks: Task[]; onUpdate: (id: string, patch: { name?: string; emoji?: string; color?: string; description?: string; status?: string; ownerId?: string | null; contributorIds?: string[] }) => void; statusUpdates?: StatusUpdate[]; onPostStatus?: (projectId: string, summary: string, status: StatusKind) => Promise<boolean> | void; members?: { id: string; name: string }[]; canManagePeople?: boolean; onDuplicate?: (projectId: string) => void; onArchive?: (projectId: string) => void }) {
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

/* ---------------- redesign pieces (W0 stubs; P11 builds them) ---------------- */

type PostStatus = (projectId: string, summary: string, status: StatusKind) => Promise<boolean> | void;
type AiStatus = (facts: unknown) => Promise<AiOutcome<{ summary: string; status: StatusKind }>>;

/** Beside the project's name in the page header: status pill, progress, people. */
export function ProjectTitleAddon(_props: { project: Project; tasks: Task[]; statusUpdates: StatusUpdate[]; onOpenUpdates: () => void }): JSX.Element {
  return <></>;
}

/** The page header's actions. For now: Post update, the same flow as the overview card's. */
export function ProjectActions({ project, readOnly, onPostStatus }: {
  project: Project;
  tasks: Task[];
  statusUpdates: StatusUpdate[];
  canManage: boolean;
  readOnly: boolean;
  onPostStatus?: PostStatus;
  aiStatus?: AiStatus;
  onTab: (tab: ProjectTab) => void;
  onDuplicate?: (id: string) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
  onSaveTemplate?: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<StatusKind>("on_track");
  const [posting, setPosting] = useState(false);
  if (readOnly || !onPostStatus) return <></>;
  // keep the draft until the update is actually saved
  const post = () => {
    const v = text.trim(); if (!v || posting) return;
    const done = () => { setText(""); setOpen(false); };
    const r = onPostStatus(project.id, v, kind);
    if (r && typeof (r as Promise<boolean>).then === "function") {
      setPosting(true);
      (r as Promise<boolean>).then((ok) => { setPosting(false); if (ok) done(); });
    } else done();
  };
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}>{open ? "Cancel" : "Post update"}</button>
      {open && (
        <div role="group" aria-label={`Post an update on ${project.name}`} className="anim-scalein" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 31, width: 340, padding: 12, borderRadius: 12, background: "var(--surface-solid)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 6 }}>
            {(Object.keys(STATUS_KIND_META) as StatusKind[]).map((k) => (
              <button key={k} onClick={() => setKind(k)} aria-pressed={kind === k} style={{ padding: "4px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12, border: `1px solid ${kind === k ? STATUS_KIND_META[k].color : "var(--hairline)"}`, background: kind === k ? `color-mix(in oklch, ${STATUS_KIND_META[k].color} 14%, transparent)` : "transparent", color: kind === k ? STATUS_KIND_META[k].color : "var(--ink-3)", fontFamily: "var(--font-display)" }}>{STATUS_KIND_META[k].label}</button>
            ))}
          </div>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="What's the latest? Wins, risks, next steps…" rows={3} aria-label="Update"
            style={{ width: "100%", resize: "vertical", padding: "8px 11px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, lineHeight: 1.55, outline: "none" }} />
          <button onClick={post} disabled={posting || !text.trim()} className="btn btn-accent" style={{ alignSelf: "flex-end", padding: "6px 13px", fontSize: 13, opacity: posting || !text.trim() ? 0.6 : 1 }}>{posting ? "Posting…" : "Post update"}</button>
        </div>
      )}
    </div>
  );
}

/** A project's non-task tabs. For now Rules and Requests show the workspace
 *  views, and Updates and About show the overview card. */
export function ProjectPanels({ tab, project, tasks, statusUpdates, members, canManage, readOnly, onUpdate, onPostStatus, rules, forms }: {
  tab: "updates" | "requests" | "rules" | "about";
  project: Project;
  tasks: Task[];
  statusUpdates: StatusUpdate[];
  members: { id: string; name: string }[];
  canManage: boolean;
  readOnly: boolean;
  onUpdate: (id: string, patch: Record<string, unknown>) => void;
  onPostStatus?: PostStatus;
  aiStatus?: AiStatus;
  rules: React.ComponentProps<typeof AutomationsView>;
  forms: React.ComponentProps<typeof FormsView>;
}): JSX.Element {
  if (tab === "rules") return <AutomationsView {...rules} />;
  if (tab === "requests") return <FormsView {...forms} />;
  return <ProjectOverview project={project} tasks={tasks} onUpdate={onUpdate} statusUpdates={statusUpdates}
    onPostStatus={readOnly ? undefined : onPostStatus} members={members} canManagePeople={canManage} />;
}

/** One line under the tabs when the project needs attention (a stale update, risks). */
export function ProjectNotice(_props: { project: Project; statusUpdates: StatusUpdate[]; risks: Risk[]; onOpenUpdates: () => void; onOpenRisks: () => void }): JSX.Element | null {
  return null;
}

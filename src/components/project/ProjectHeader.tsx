/* ============================================================
   KANBO — a project's header parts and panels. P02 places them:
   ProjectTitleAddon beside the name in the page header (status,
   progress, people), ProjectActions on its right (Draft update ·
   Post update · ⋯), ProjectNotice as the one line under the tabs,
   and ProjectPanels for the Updates · Requests · Rules · About tabs.
   ProjectOverview is the retired overview card, kept working until
   the shell stops rendering it.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, Avatar, AvatarStack, StatusDot, EmojiPicker, Collapse, AiMark, Button, EmptyState, IconButton, Meter, Pill, ProgressRing, ProjectTile, projectPaint } from "../primitives";
import { Popover } from "../primitives/Popover";
import { STATUS_KIND_META } from "../views/GoalsPortfolios";
import { AutomationsView, FormsView } from "../views/RulesForms";
import { STATUS_META, getMember, KANBO_TODAY, todayISO } from "../../data/data";
import type { Task, Project, Status, StatusUpdate, StatusKind, IconName } from "../../data/types";
import type { ProjectTab } from "../../app-types";
import type { Risk } from "../../lib/radar";
import { fmtShortDay, isStale, kanbosRead, oldestTaskAge, projectUpdates, statusFacts, STALE_DAYS } from "../../lib/statusDraft";
import { storeProjectTemplate, projectBlueprint } from "../../lib/templates";
import { ComposerPanel, ComposerPopover, POP_STYLE, useStatusComposer, type AiStatus, type PostStatus } from "./StatusComposer";
import { DraftInput } from "./DraftInput";
import { EditIdentitySheet, IdentityFields } from "./IdentityPicker";
import "./projects.css";

export type { AiStatus, PostStatus } from "./StatusComposer";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const PROJECT_STATUSES: { v: string; label: string; color: string }[] = [
  { v: "on_track", label: "On track", color: "var(--st-done)" },
  { v: "at_risk", label: "At risk", color: "var(--st-review)" },
  { v: "off_track", label: "Off track", color: "var(--st-blocked)" },
  { v: "on_hold", label: "On hold", color: "var(--ink-4)" },
];
/** the six project colours (names for the pickers' accessible labels) */
export const PROJECT_COLOURS: { value: string; name: string }[] = [
  { value: "oklch(0.74 0.14 230)", name: "Blue" },
  { value: "oklch(0.74 0.16 305)", name: "Violet" },
  { value: "oklch(0.75 0.13 155)", name: "Green" },
  { value: "oklch(0.78 0.15 70)", name: "Amber" },
  { value: "oklch(0.66 0.2 20)", name: "Red" },
  { value: "oklch(0.78 0.1 45)", name: "Sand" },
];

/** "today", "yesterday", "3 days ago", or a date — for status-update freshness. */
export function relDay(iso: string): { label: string; days: number } {
  const then = new Date(iso); const now = new Date();
  const days = Math.max(0, Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / 86400000));
  const label = days === 0 ? "today" : days === 1 ? "yesterday" : days < 14 ? `${days} days ago` : then.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: then.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  return { label, days };
}

type Tone = "neutral" | "accent" | "ok" | "warn" | "signal";
export const STATUS_TONE: Record<StatusKind, Tone> = { on_track: "ok", at_risk: "warn", off_track: "signal" };

/** A project's status pill: its latest update's call; without one, the status
 *  set by hand in About; otherwise "No update". */
export function projectStatusPill(project: Project, latest?: StatusUpdate): { tone: Tone; label: string; title: string } {
  if (latest && STATUS_KIND_META[latest.status]) {
    const age = relDay(latest.createdAt);
    return { tone: STATUS_TONE[latest.status], label: STATUS_KIND_META[latest.status].label, title: `Latest update, ${age.label}` };
  }
  const manual = PROJECT_STATUSES.find((s) => s.v === project.status);
  if (manual) {
    const tone: Tone = manual.v === "on_hold" ? "neutral" : STATUS_TONE[manual.v as StatusKind];
    return { tone, label: manual.label, title: "Set by hand; no update posted yet" };
  }
  return { tone: "neutral", label: "No update", title: "No status update posted yet" };
}

/** Owner first, then contributors (people we can still name). */
export function projectPeople(project: Project): string[] {
  const ids = [project.ownerId, ...(project.contributorIds ?? [])].filter((id): id is string => !!id);
  return [...new Set(ids)].filter((id) => !!getMember(id));
}

/** A printable report of the project: every task, each sub-task under its parent. */
export function printProjectReport(project: Project, allProjectTasks: Task[]): void {
  const tasks = allProjectTasks.filter((t) => !t.parentId);
  const total = tasks.length;
  const prog = total ? Math.round((tasks.filter((t) => t.status === "done").length / total) * 100) : 0;
  const w = window.open("", "_blank"); if (!w) return;
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
  const kids = new Map<string, Task[]>();
  allProjectTasks.forEach((t) => { if (t.parentId) { const l = kids.get(t.parentId); if (l) l.push(t); else kids.set(t.parentId, [t]); } });
  const ordered: { t: Task; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (t: Task, depth: number) => { if (seen.has(t.id)) return; seen.add(t.id); ordered.push({ t, depth }); (kids.get(t.id) ?? []).forEach((k) => walk(k, depth + 1)); };
  [...tasks].sort((a, b) => a.status.localeCompare(b.status)).forEach((t) => walk(t, 0));
  allProjectTasks.forEach((t) => walk(t, 0)); // a sub-task whose parent isn't in this list
  const rows = ordered.map(({ t, depth }) => `<tr><td style="padding-left:${8 + Math.min(depth, 4) * 16}px">${depth ? "↳ " : ""}${esc(t.title)}</td><td>${esc(STATUS_META[t.status].label)}</td><td>${esc(t.priority)}</td><td>${esc(t.dueDate || "")}</td><td>${esc(getMember(t.assigneeId)?.name || "")}</td></tr>`).join("");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(project.name)} — report</title><style>body{font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;padding:32px;max-width:900px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin:0 0 20px}.bar{height:10px;background:#eee;border-radius:6px;overflow:hidden;margin:8px 0 20px}.bar>div{height:100%;background:#6a5cff;width:${prog}%}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #eee}th{color:#666;font-weight:600;font-size:12px}@media print{.noprint{display:none}}</style></head><body><h1>${esc(project.emoji)} ${esc(project.name)}</h1><p class="sub">${total} tasks · ${prog}% complete · ${esc(new Date().toLocaleDateString("en-GB"))}</p><div class="bar"><div></div></div><table><thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Due</th><th>Assignee</th></tr></thead><tbody>${rows}</tbody></table><p class="noprint" style="margin-top:24px;color:#888;font-size:12px">Use your browser's Print dialog to save as PDF.</p></body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
}

/* ============================ ProjectTitleAddon ============================ */

/** Under the project's name in its header: status pill (opens Updates), a
 *  progress ring with the count behind it, the next milestone, and the people. */
export function ProjectTitleAddon({ project, tasks, statusUpdates, onOpenUpdates }: {
  project: Project;
  tasks: Task[];
  statusUpdates: StatusUpdate[];
  onOpenUpdates: () => void;
}): JSX.Element {
  // the facts read today's date: recompute when the day rolls over in a tab left open
  const today = todayISO();
  const facts = useMemo(() => statusFacts(project, tasks, statusUpdates, KANBO_TODAY), [project, tasks, statusUpdates, today]);
  const pill = projectStatusPill(project, facts.latest);
  const people = projectPeople(project);
  const names = people.map((id) => getMember(id)?.name).filter(Boolean).join(", ");
  const done = facts.total - facts.open;
  const ms = facts.nextMilestone;
  return (
    <span className="kpj-addon">
      <Pill tone={pill.tone} onClick={onOpenUpdates} title={`${pill.title} · open Updates`}>{pill.label}</Pill>
      <span className="kpj-addon-progress" title={`${facts.pct}% of ${plural(facts.total, "task")} done`}>
        <ProgressRing value={facts.pct} size={16} label={`${project.name} progress`} />
        <span className="kpj-mono">{facts.pct}%</span>
        {facts.total > 0 && <span className="kpj-addon-of" aria-hidden="true">{done} of {facts.total}</span>}
      </span>
      {ms?.dueDate && (
        <span className="kpj-addon-ms" title={`Next milestone: ${ms.title}`}>
          <Icon name="flag" size={14} sw={1.75} />
          <span className="kpj-addon-ms-title">{ms.title}</span>
          <span className="kpj-mono">{fmtShortDay(ms.dueDate, KANBO_TODAY)}</span>
        </span>
      )}
      {people.length > 0 && (
        <span className="kpj-people" title={names} role="img" aria-label={`People: ${names}`}>
          <AvatarStack ids={people.slice(0, 3)} size={24} />
          {people.length > 3 && <span className="kpj-people-more" aria-hidden="true">+{people.length - 3}</span>}
        </span>
      )}
    </span>
  );
}

/* ============================ ProjectActions ============================ */

interface MenuItem { id: string; label: string; icon: IconName; run: () => void; tone?: "danger"; sepBefore?: boolean }

/** The page header's actions: Draft update (Kanbo writes it) · Post update (an empty field) ·
 *  ⋯ Project actions. Both buttons open the same composer, on the project's one shared draft. */
export function ProjectActions({ project, tasks, statusUpdates, canManage, readOnly, onPostStatus, aiStatus, onTab, onDuplicate, onArchive, onDelete, onSaveTemplate, onEditIdentity }: {
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
  /** "Edit identity": saves the project's icon and colour together */
  onEditIdentity?: (patch: { emoji: string; color: string }) => void;
}): JSX.Element {
  const canPost = !readOnly && !!onPostStatus;
  const [identityOpen, setIdentityOpen] = useState(false);
  const [open, setOpen] = useState<null | "draft" | "post">(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // "Save as template" answers in place: saved, or this device's storage refused it
  const [saved, setSaved] = useState<null | "saved" | "failed">(null);
  const draftRef = useRef<HTMLButtonElement>(null);
  const postRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const c = useStatusComposer({ project, tasks, statusUpdates, onPost: canPost ? onPostStatus : undefined, aiStatus, onPosted: () => setOpen(null) });
  useEffect(() => { setOpen(null); setMenuOpen(false); setSaved(null); setIdentityOpen(false); }, [project.id]);
  useEffect(() => {
    if (saved !== "saved") return;
    const t = window.setTimeout(() => { setSaved(null); setMenuOpen(false); }, 1200);
    return () => window.clearTimeout(t);
  }, [saved]);

  const openDraft = () => {
    if (open === "draft") { setOpen(null); return; }
    setOpen("draft");
    c.ensureDraft();
  };
  const openPost = () => {
    if (open === "post") { setOpen(null); return; }
    setOpen("post");
    c.startFresh();
  };
  const run = (fn: () => void) => () => { setMenuOpen(false); fn(); };
  const items: MenuItem[] = [
    ...(!readOnly && onEditIdentity ? [{ id: "identity", label: "Edit identity", icon: "palette" as IconName, run: run(() => setIdentityOpen(true)) }] : []),
    { id: "about", label: "Details", icon: "notes", run: run(() => onTab("about")) },
    ...(!readOnly ? [{ id: "rules", label: "Rules", icon: "zap" as IconName, run: run(() => onTab("rules")) }] : []),
    { id: "requests", label: "Requests", icon: "inbox", run: run(() => onTab("requests")) },
    { id: "report", label: "Print report", icon: "arrowUpRight", run: run(() => printProjectReport(project, tasks.filter((t) => t.projectId === project.id && !t.archivedAt))) },
  ];
  if (!readOnly) {
    if (onDuplicate) items.push({ id: "duplicate", label: "Duplicate", icon: "copy", run: run(() => onDuplicate(project.id)), sepBefore: true });
    items.push({
      id: "template", sepBefore: !onDuplicate,
      label: saved === "saved" ? "Saved as a template" : saved === "failed" ? "Couldn't save: try again" : "Save as template",
      icon: saved === "saved" ? "check" : saved === "failed" ? "refresh" : "layers",
      run: () => {
        if (saved === "saved") return;
        if (onSaveTemplate) { setMenuOpen(false); onSaveTemplate(project.id); return; }
        const tpl = storeProjectTemplate({ name: project.name, emoji: project.emoji, color: project.color, tasks: projectBlueprint(tasks.filter((t) => t.projectId === project.id)) });
        setSaved(tpl ? "saved" : "failed"); // says so in place (and closes once saved)
      },
    });
    if (onArchive) items.push({
      id: "archive", label: "Archive project", icon: "archive", sepBefore: true,
      run: run(() => { if (window.confirm(`Archive "${project.name}"? It's hidden but kept, and you can restore it from the sidebar.`)) onArchive(project.id); }),
    });
    // any member may archive (it's restorable); deleting is for whoever runs the project
    if (onDelete && canManage) items.push({ id: "delete", label: "Delete project", icon: "trash", tone: "danger", sepBefore: !onArchive, run: run(() => onDelete(project.id)) });
  }

  return (
    <div className="kpj-actions">
      {canPost && (
        <>
          <Button ref={draftRef} variant="ghost" size="sm" className="kpj-hide-phone" onClick={openDraft}
            aria-haspopup="dialog" aria-expanded={open === "draft"}>
            <span className="kpj-btn-mark"><AiMark size={14} thinking={c.drafting} />Draft update</span>
          </Button>
          <Button ref={postRef} variant="secondary" size="sm" onClick={openPost}
            aria-haspopup="dialog" aria-expanded={open === "post"}>Post update</Button>
        </>
      )}
      <IconButton ref={moreRef} icon="more" label="Project actions" size="sm" aria-haspopup="menu" aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)} />
      {canPost && <ComposerPopover open={open !== null} anchorRef={open === "draft" ? draftRef : postRef} onClose={() => setOpen(null)} c={c} />}
      <Popover open={menuOpen} anchorRef={moreRef} onClose={() => { setMenuOpen(false); setSaved(null); }} role="menu" label={`Actions for ${project.name}`}
        align="end" minWidth={208} className="kpj-pop" style={{ ...POP_STYLE, padding: 4 }}>
        {items.flatMap((it) => [
          ...(it.sepBefore ? [<div key={`${it.id}-sep`} className="kpj-menu-sep" role="separator" />] : []),
          <button key={it.id} type="button" role="menuitem" className="kpj-menu-item" data-tone={it.tone ?? (it.id === "template" && saved === "failed" ? "warn" : undefined)} onClick={it.run}>
            <Icon name={it.icon} size={16} sw={1.75} />{it.label}
          </button>,
        ])}
      </Popover>
      {onEditIdentity && !readOnly && (
        <EditIdentitySheet project={project} open={identityOpen} onClose={() => { setIdentityOpen(false); moreRef.current?.focus(); }} onSave={onEditIdentity} />
      )}
    </div>
  );
}

/* ============================ ProjectNotice ============================ */

/** One 32px line under the project's tabs: the latest update (under 14 days old)
 *  and any risks. Nothing when there's neither. */
export function ProjectNotice({ project, statusUpdates, risks, onOpenUpdates, onOpenRisks }: {
  project: Project;
  statusUpdates: StatusUpdate[];
  risks: Risk[];
  onOpenUpdates: () => void;
  onOpenRisks: () => void;
}): JSX.Element | null {
  const latest = projectUpdates(statusUpdates, project.id)[0];
  const age = latest ? relDay(latest.createdAt) : null;
  const fresh = !!latest && !!age && age.days < STALE_DAYS;
  const mine = risks.filter((r) => !r.projectId || r.projectId === project.id);
  if (!fresh && mine.length === 0) return null;
  const tone = mine.some((r) => r.severity === "signal") ? "signal" : "warn";
  return (
    <div className="kpj-notice">
      {fresh && (
        <button type="button" className="kpj-notice-part kpj-notice-update" onClick={onOpenUpdates} title={latest!.summary}>
          <span className="kpj-notice-lead">Update</span>
          <span className="kpj-notice-sep" aria-hidden="true">·</span>
          <span>{age!.label}</span>
          <span className="kpj-notice-sep" aria-hidden="true">·</span>
          <span className="kpj-notice-text">{latest!.summary}</span>
        </button>
      )}
      {fresh && mine.length > 0 && <span className="kpj-notice-sep" aria-hidden="true">·</span>}
      {mine.length > 0 && (
        <button type="button" className="kpj-notice-part kpj-notice-risks" data-tone={tone} onClick={onOpenRisks}>
          <span className="kpj-notice-lead">{plural(mine.length, "risk")}</span>
          {mine.slice(0, 2).map((r) => (
            <span key={r.id} className="kpj-notice-text"><span className="kpj-notice-sep" aria-hidden="true">· </span>{r.title}</span>
          ))}
          <Icon name="arrowRight" size={14} sw={1.75} />
        </button>
      )}
    </div>
  );
}

/* ============================ ProjectPanels ============================ */

/** A project's non-task tabs: Updates · Requests · Rules · About. */
export function ProjectPanels({ tab, project, tasks, statusUpdates, members, canManage, readOnly, onUpdate, onPostStatus, aiStatus, rules, forms }: {
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
  if (tab === "rules") {
    if (readOnly) {
      return (
        <div className="kpj-page"><div className="kpj-wrap">
          <EmptyState art="layers" title="Rules are for members" body="The people running this project set up what happens automatically when its tasks change." />
        </div></div>
      );
    }
    return <AutomationsView {...rules} projectId={project.id} />;
  }
  if (tab === "requests") return <FormsView {...forms} projectId={project.id} readOnly={readOnly || forms.readOnly} />;
  if (tab === "about") return <AboutPanel project={project} tasks={tasks} statusUpdates={statusUpdates} members={members} canManage={canManage} readOnly={readOnly} onUpdate={onUpdate} />;
  return <UpdatesPanel project={project} tasks={tasks} statusUpdates={statusUpdates} readOnly={readOnly} onPostStatus={onPostStatus} aiStatus={aiStatus} />;
}

const HISTORY_PAGE = 20;

function UpdatesPanel({ project, tasks, statusUpdates, readOnly, onPostStatus, aiStatus }: {
  project: Project; tasks: Task[]; statusUpdates: StatusUpdate[]; readOnly: boolean; onPostStatus?: PostStatus; aiStatus?: AiStatus;
}) {
  const canPost = !readOnly && !!onPostStatus;
  const c = useStatusComposer({ project, tasks, statusUpdates, onPost: canPost ? onPostStatus : undefined, aiStatus });
  const history = useMemo(() => projectUpdates(statusUpdates, project.id), [statusUpdates, project.id]);
  const [shown, setShown] = useState(HISTORY_PAGE);
  // draft first: the composer opens on the on-device draft of this week (the AI one is a click away),
  // unless this project already has a draft in hand (yours, or one Kanbo is writing)
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!canPost || seeded.current === project.id) return;
    seeded.current = project.id;
    if (!c.text.trim() && !c.drafting) c.draft("template");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPost, project.id]);

  return (
    <div className="kpj-page">
      <div className="kpj-wrap kpj-readw kpj-panel">
        {canPost && (
          <section className="kpj-composer-card" aria-label="Post an update">
            <ComposerPanel c={c} title="Post an update" />
          </section>
        )}
        {history.length === 0 ? (
          <EmptyState art="chart" size="sm" title="No updates yet"
            body={canPost ? "A short update keeps everyone in the loop. Kanbo has drafted one from this week's changes above." : "Nobody has posted an update on this project yet."} />
        ) : (
          <section aria-label="Update history">
            <h2 className="kpj-panel-title">History <span className="kpj-count">{history.length}</span></h2>
            <ol className="kpj-history">
              {history.slice(0, shown).map((u) => {
                const meta = STATUS_KIND_META[u.status];
                const age = relDay(u.createdAt);
                return (
                  <li key={u.id}>
                    <div className="kpj-history-meta">
                      <Pill tone={STATUS_TONE[u.status] ?? "neutral"}>{meta?.label ?? u.status}</Pill>
                      <span className="kpj-mono" title={new Date(u.createdAt).toLocaleString("en-GB")}>{fmtShortDay(u.createdAt, KANBO_TODAY)}</span>
                      {age.days < 14 && <span>· {age.label}</span>}
                    </div>
                    <p className="kpj-history-text">{u.summary}</p>
                  </li>
                );
              })}
            </ol>
            {history.length > shown && (
              <Button variant="ghost" size="sm" icon="chevronDown" onClick={() => setShown((n) => n + HISTORY_PAGE)}>
                Show {plural(Math.min(HISTORY_PAGE, history.length - shown), "older update")}
              </Button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function AboutPanel({ project, tasks, statusUpdates, members, canManage, readOnly, onUpdate }: {
  project: Project; tasks: Task[]; statusUpdates: StatusUpdate[]; members: { id: string; name: string }[];
  canManage: boolean; readOnly: boolean; onUpdate: (id: string, patch: Record<string, unknown>) => void;
}) {
  const today = todayISO();
  const facts = useMemo(() => statusFacts(project, tasks, statusUpdates, KANBO_TODAY), [project, tasks, statusUpdates, today]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [descEditing, setDescEditing] = useState(false);
  const [descDraft, setDescDraft] = useState(project.description || "");
  useEffect(() => { setEmojiOpen(false); setDescEditing(false); }, [project.id]);
  const editable = !readOnly;
  const ownerId = project.ownerId ?? null;
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name || getMember(id)?.name || "Former member";
  const contribIds = (project.contributorIds ?? []).filter((id) => id !== ownerId);
  const toggleContrib = (id: string) => {
    const set = new Set(contribIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    onUpdate(project.id, { contributorIds: [...set] });
  };
  const mine = tasks.filter((t) => t.projectId === project.id && !t.archivedAt);
  const dated = mine.map((t) => t.dueDate).filter((d): d is string => !!d).sort();
  const age = oldestTaskAge(mine, project.id, KANBO_TODAY);
  const stale = isStale(facts, age);

  return (
    <div className="kpj-page">
      <div className="kpj-wrap kpj-readw kpj-panel">
        <dl className="kpj-about">
          <dt>Name</dt>
          <dd>
            {canManage ? (
              <>
                <span className="kpj-about-tile"><ProjectTile project={project} size={28} /></span>
                <DraftInput value={project.name} required label="Project name" onCommit={(v) => onUpdate(project.id, { name: v })} className="kpj-field" style={{ flex: "1 1 220px" }} />
              </>
            ) : <span className="kpj-about-named"><ProjectTile project={project} size={20} /><span style={{ color: "var(--ink)" }}>{project.name}</span></span>}
          </dd>

          {canManage && (
            <>
              <dt>Identity</dt>
              <dd>
                <button type="button" className="kpj-about-identity" aria-expanded={emojiOpen} onClick={() => setEmojiOpen((v) => !v)}>
                  <span>{emojiOpen ? "Done" : "Change icon and colour"}</span>
                  <Icon name="chevronDown" size={14} sw={1.75} />
                </button>
                {emojiOpen && (
                  <div className="kpj-about-idf">
                    <IdentityFields name={project.name} emoji={project.emoji ?? ""} color={project.color}
                      onEmoji={(e) => onUpdate(project.id, { emoji: e })} onColor={(c) => onUpdate(project.id, { color: c })} />
                  </div>
                )}
              </dd>
            </>
          )}

          <dt>Description</dt>
          <dd>
            {descEditing ? (
              // eslint-disable-next-line jsx-a11y/no-autofocus
              <textarea autoFocus className="kpj-field kpj-about-desc" rows={4} value={descDraft} aria-label="Project description"
                placeholder="What is this project for? What does done look like?"
                onChange={(e) => setDescDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setDescDraft(project.description || ""); setDescEditing(false); } }}
                onBlur={() => { setDescEditing(false); if (descDraft !== (project.description || "")) onUpdate(project.id, { description: descDraft }); }} />
            ) : editable ? (
              <button type="button" className="kpj-about-desc-view" data-empty={!project.description || undefined}
                onClick={() => { setDescDraft(project.description || ""); setDescEditing(true); }}>
                {project.description || "Add a description…"}
              </button>
            ) : <p className="kpj-about-desc-view" data-empty={!project.description || undefined} style={{ cursor: "default" }}>{project.description || "No description."}</p>}
          </dd>

          <dt>Status</dt>
          <dd>
            {(() => { const p = projectStatusPill(project, facts.latest); return <Pill tone={p.tone} title={p.title}>{p.label}</Pill>; })()}
            <span className="kpj-card-meta">{kanbosRead(facts)}</span>
            {editable && !facts.latest && (
              <select className="kpj-field" data-size="sm" value={project.status ?? ""} aria-label="Status set by hand"
                onChange={(e) => onUpdate(project.id, { status: e.target.value })}>
                <option value="">Not set</option>
                {PROJECT_STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
              </select>
            )}
            {stale && <span className="kpj-card-meta kpj-warn">{facts.lastUpdateDays == null ? "No update yet" : `No update in ${facts.lastUpdateDays} days`}</span>}
          </dd>

          <dt>Owner</dt>
          <dd>
            {canManage ? (
              <select className="kpj-field" value={ownerId ?? ""} onChange={(e) => onUpdate(project.id, { ownerId: e.target.value || null })} aria-label="Project owner" style={{ minWidth: 200 }}>
                {!ownerId && <option value="">Select owner…</option>}
                {ownerId && !members.some((m) => m.id === ownerId) && <option value={ownerId}>{nameOf(ownerId)}</option>}
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            ) : ownerId ? (
              <span className="kpj-person"><Avatar id={ownerId} size={24} />{nameOf(ownerId)}</span>
            ) : <span className="kpj-muted">No owner</span>}
          </dd>

          <dt>Contributors</dt>
          <dd>
            {canManage ? (
              members.filter((m) => m.id !== ownerId).length === 0
                ? <span className="kpj-muted">Invite teammates to add contributors.</span>
                : (
                  <div className="kpj-checklist" role="group" aria-label="Contributors">
                    {members.filter((m) => m.id !== ownerId).map((m) => (
                      <label key={m.id} className="kpj-check">
                        <input type="checkbox" checked={contribIds.includes(m.id)} onChange={() => toggleContrib(m.id)} />
                        <Avatar id={m.id} size={20} /><span className="truncate">{m.name}</span>
                      </label>
                    ))}
                  </div>
                )
            ) : contribIds.length ? (
              contribIds.map((id) => <span key={id} className="kpj-person"><Avatar id={id} size={24} />{nameOf(id)}</span>)
            ) : <span className="kpj-muted">None yet</span>}
          </dd>

          <dt>Dates</dt>
          <dd>
            {dated.length ? (
              <span className="kpj-mono" style={{ fontSize: 12 }}>{fmtShortDay(dated[0], KANBO_TODAY)} → {fmtShortDay(dated[dated.length - 1], KANBO_TODAY)}</span>
            ) : <span className="kpj-muted">No due dates yet</span>}
            {facts.nextMilestone && (
              <span className="kpj-card-meta" style={{ marginLeft: 8 }}>Next milestone: {facts.nextMilestone.title}, <span className="kpj-mono">{fmtShortDay(facts.nextMilestone.dueDate, KANBO_TODAY)}</span></span>
            )}
          </dd>

          <dt>Tasks</dt>
          <dd>
            <span className="kpj-progress" title={`${facts.total - facts.open} of ${plural(facts.total, "task")} done`}>
              <Meter value={facts.pct} width={96} height={4} label={`${project.name} progress`} />
              <span className="kpj-mono">{facts.pct}%</span>
            </span>
            {/* open, overdue and blocked all count sub-tasks too, so they always add up */}
            <span className="kpj-card-meta">{facts.total === 0 ? "No tasks yet" : `${facts.openAll} open`}
              {facts.overdue.length > 0 && <span className="kpj-signal"> · {facts.overdue.length} overdue</span>}
              {facts.blocked.length > 0 && <span className="kpj-signal"> · {facts.blocked.length} blocked</span>}
            </span>
          </dd>
        </dl>
      </div>
    </div>
  );
}

/* ============================ legacy: the overview card ============================ */

/** The retired overview card (the shell rendered it above a project's tasks). Kept working until it stops. */
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
  const printReport = () => printProjectReport(project, allProjectTasks);
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


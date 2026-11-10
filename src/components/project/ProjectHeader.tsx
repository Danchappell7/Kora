/* ============================================================
   KANBO — a project's header parts and panels. P02 places them:
   ProjectTitleAddon beside the name in the page header (status,
   progress, people), ProjectActions on its right (Draft update ·
   Post update · ⋯), ProjectNotice as the one line under the tabs,
   and ProjectPanels for the Updates · Requests · Rules · About tabs.
   0058: About's people are project_members once project access is in
   (People & access while it's on).
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, Avatar, AvatarStack, AiMark, Button, EmptyState, IconButton, Meter, Pill, ProgressRing, ProjectTile, projectLocked } from "../primitives";
import { Popover } from "../primitives/Popover";
import { STATUS_KIND_META } from "../views/GoalsPortfolios";
import { AutomationsView, FormsView } from "../views/RulesForms";
import { STATUS_META, getMember, KANBO_TODAY, todayISO } from "../../data/data";
import type { Task, Project, Status, StatusUpdate, StatusKind, IconName } from "../../data/types";
import type { ProjectTab } from "../../app-types";
import type { Risk } from "../../lib/radar";
import { fmtShortDay, isStale, kanbosRead, oldestTaskAge, projectUpdates, statusFacts, STALE_DAYS, updateAuthor } from "../../lib/statusDraft";
import { projectRhythm } from "../../lib/updateRhythm";
import { progressOf } from "../../lib/countRules";
import { storeProjectTemplate, projectBlueprint } from "../../lib/templates";
import { ComposerPanel, ComposerPopover, POP_STYLE, focusInPageComposer, useHasInPageComposer, useInPageComposer, useStatusComposer, type AiStatus, type PostStatus } from "./StatusComposer";
import { DraftInput } from "./DraftInput";
import { SlackPostButton } from "../integrations";
import { EditIdentitySheet, IdentityFields } from "./IdentityPicker";
import { PresenceAvatars, useProjectPresence, type PresenceMe } from "../presence";
import { UpdateDayField } from "../updates/UpdateDay";
import { UpdateCard, type UpdateEditPatch } from "../updates/UpdateCard";
import { markUpdatesSeen, useUpdateConversation, threadOf } from "../../lib/updateConversation";
import { PeopleAccess, accessSummary, type PeopleAccessProps } from "./PeopleAccess";
import { accessOn, canManagePeople, memberRole, roleOf, visibilityOf, VISIBILITY_LABEL } from "../../lib/projectAccess";
import "./projects.css";

export type { AiStatus, PostStatus } from "./StatusComposer";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** does this project read its updates by an update day (0053) rather than the 14-day rule? */
const rhythmOnFor = (p: Project) => !!projectRhythm(p);

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
export const STATUS_TONE: Record<StatusKind, Tone> = { on_track: "ok", at_risk: "warn", off_track: "signal", on_hold: "neutral" };

/** A project's status pill: its latest update's call; without one, the status
 *  set by hand in About; otherwise "No update". On hold set by hand stays,
 *  whatever's posted meanwhile, until it's taken off in About. */
export function projectStatusPill(project: Project, latest?: StatusUpdate): { tone: Tone; label: string; title: string } {
  if (project.status === "on_hold") return { tone: "neutral", label: "On hold", title: latest ? "Put on hold by hand (take it off in About)" : "Set by hand; no update posted yet" };
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
  const { total, pct: prog } = progressOf(allProjectTasks);
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
export function ProjectTitleAddon({ project, tasks, statusUpdates, onOpenUpdates, me }: {
  project: Project;
  tasks: Task[];
  statusUpdates: StatusUpdate[];
  onOpenUpdates: () => void;
  /** 0048 live presence: you on the project's channel (who else is here shows beside the people); null: alone */
  me?: PresenceMe | null;
}): JSX.Element {
  // (temporary ids aren't on the server yet: nobody can be there)
  const { peers: here } = useProjectPresence(me && !project.id.startsWith("tmp-") ? project.id : null, me ?? null);
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
      {here.length > 0 && <PresenceAvatars peers={here} size="sm" max={3} />}
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
export function ProjectActions({ project, tasks, statusUpdates, canManage, readOnly, onPostStatus, aiStatus, onTab, onDuplicate, onArchive, onDelete, onSaveTemplate, onEditIdentity, onPlanTasks, people }: {
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
  /** 0047: "Add tasks with Kanbo" (the AI planner, adding to this project) */
  onPlanTasks?: () => void;
  /** 0054: who an Ask in the update can be for (people who can read it; never you) */
  people?: { id: string; name: string }[];
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
  // on the Updates tab the page has the composer: the buttons fill and focus that one (no popover)
  const inPage = useHasInPageComposer(project.id);
  useEffect(() => { setOpen(null); setMenuOpen(false); setSaved(null); setIdentityOpen(false); }, [project.id]);
  useEffect(() => { if (inPage) setOpen(null); }, [inPage]);
  useEffect(() => {
    if (saved !== "saved") return;
    const t = window.setTimeout(() => { setSaved(null); setMenuOpen(false); }, 1200);
    return () => window.clearTimeout(t);
  }, [saved]);

  const openDraft = () => {
    if (inPage) { c.ensureDraft(); focusInPageComposer(project.id); return; }
    if (open === "draft") { setOpen(null); return; }
    setOpen("draft");
    c.ensureDraft();
  };
  const openPost = () => {
    if (inPage) { c.startFresh(); focusInPageComposer(project.id); return; }
    if (open === "post") { setOpen(null); return; }
    setOpen("post");
    c.startFresh();
  };
  const run = (fn: () => void) => () => { setMenuOpen(false); fn(); };
  const items: MenuItem[] = [
    ...(!readOnly && onPlanTasks ? [{ id: "plan", label: "Add tasks with Kanbo", icon: "kanbo" as IconName, run: run(onPlanTasks) }] : []),
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
            aria-haspopup={inPage ? undefined : "dialog"} aria-expanded={inPage ? undefined : open === "draft"}>
            <span className="kpj-btn-mark"><AiMark size={14} thinking={c.drafting} />Draft update</span>
          </Button>
          <Button ref={postRef} variant="secondary" size="sm" onClick={openPost}
            aria-haspopup={inPage ? undefined : "dialog"} aria-expanded={inPage ? undefined : open === "post"}>Post update</Button>
        </>
      )}
      <IconButton ref={moreRef} icon="more" label="Project actions" size="sm" aria-haspopup="menu" aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)} />
      {canPost && <ComposerPopover open={open !== null && !inPage} anchorRef={open === "draft" ? draftRef : postRef} onClose={() => setOpen(null)} c={c} people={people} />}
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
        <button type="button" className="kpj-notice-part kpj-notice-update" onClick={onOpenUpdates} title={updateAuthor(latest!) ? `${updateAuthor(latest!)}: ${latest!.summary}` : latest!.summary}>
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

/** 0054: what the Updates tab needs for each update's conversation (who you are, whether you lead the
 *  workspace, an author's edit and delete, and the update to open from the Inbox). */
export interface UpdatesConversation {
  me: string;
  /** an owner or admin of the project's workspace: deletes any update, removes any reply */
  lead: boolean;
  onEdit?: (u: StatusUpdate, patch: UpdateEditPatch) => Promise<boolean>;
  onDelete?: (u: StatusUpdate) => void;
  /** open this update's replies (arriving from the Inbox) */
  focusUpdateId?: string | null;
}

/** A project's non-task tabs: Updates · Requests · Rules · About. */
export function ProjectPanels({ tab, project, tasks, statusUpdates, members, canManage, readOnly, onUpdate, onPostStatus, aiStatus, rules, forms, conversation, access }: {
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
  conversation?: UpdatesConversation;
  /** 0058: who's on it and who can see it (omit before 0058: About keeps today's contributors) */
  access?: AboutAccess;
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
  if (tab === "about") return <AboutPanel project={project} tasks={tasks} statusUpdates={statusUpdates} members={members} canManage={canManage} readOnly={readOnly} onUpdate={onUpdate} access={access} />;
  return <UpdatesPanel project={project} tasks={tasks} statusUpdates={statusUpdates} readOnly={readOnly} onPostStatus={onPostStatus} aiStatus={aiStatus}
    members={members} conversation={conversation} />;
}

const HISTORY_PAGE = 20;

function UpdatesPanel({ project, tasks, statusUpdates, readOnly, onPostStatus, aiStatus, members = [], conversation }: {
  project: Project; tasks: Task[]; statusUpdates: StatusUpdate[]; readOnly: boolean; onPostStatus?: PostStatus; aiStatus?: AiStatus;
  members?: { id: string; name: string }[]; conversation?: UpdatesConversation;
}) {
  const canPost = !readOnly && !!onPostStatus;
  const c = useStatusComposer({ project, tasks, statusUpdates, onPost: canPost ? onPostStatus : undefined, aiStatus });
  const textRef = useRef<HTMLTextAreaElement>(null);
  useInPageComposer(project.id, textRef, canPost);
  const history = useMemo(() => projectUpdates(statusUpdates, project.id), [statusUpdates, project.id]);
  const [shown, setShown] = useState(HISTORY_PAGE);
  // 0054: each shown update's reactions, seen by and replies; reading them here counts as seeing them
  const me = conversation?.me ?? "";
  const shownIds = useMemo(() => history.slice(0, shown).map((u) => u.id), [history, shown]);
  const { threads, on: conversationOn } = useUpdateConversation(shownIds);
  const ready = shownIds.every((id) => threads.has(id));
  useEffect(() => {
    if (!ready || !me || !conversationOn) return;
    void markUpdatesSeen(shownIds, me, (id) => history.find((u) => u.id === id)?.authorId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, me, conversationOn, shownIds.join(",")]);
  // who an Ask or a reply can be for: the project's people who can read it, not you
  const people = useMemo(() => members.filter((m) => m.id !== me), [members, me]);
  // draft first: the composer opens on the on-device draft of this week (the AI one is a click away),
  // unless this project already has a draft in hand (yours, or one Kanbo is writing). Someone arriving
  // from the Inbox to answer an update on a project they don't own came to reply, not to write one.
  const arriving = !!conversation?.focusUpdateId && history.some((u) => u.id === conversation.focusUpdateId) && project.ownerId !== me;
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!canPost || seeded.current === project.id) return;
    seeded.current = project.id;
    if (!c.text.trim() && !c.drafting && !arriving) c.draft("template");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPost, project.id]);

  return (
    <div className="kpj-page">
      <div className="kpj-wrap kpj-readw kpj-panel">
        {canPost && (
          <section className="kpj-composer-card" aria-label="Post an update">
            <ComposerPanel c={c} title="Post an update" textRef={textRef} people={people} />
          </section>
        )}
        {history.length === 0 ? (
          <EmptyState art="chart" size="sm" title="No updates yet"
            body={canPost ? "A short update keeps everyone in the loop. Kanbo has drafted one from this week's changes above." : "Nobody has posted an update on this project yet."} />
        ) : (
          <section aria-label="Update history">
            <h2 className="kpj-panel-title">History <span className="kpj-count">{history.length}</span></h2>
            <ol className="kpj-history">
              {history.slice(0, shown).map((u, i) => (
                <li key={u.id} id={`update-${u.id}`}>
                  <UpdateCard update={u} me={me} canWrite={!readOnly} lead={!!conversation?.lead} thread={threadOf(threads, u.id)}
                    conversation={conversationOn && !!me} people={people} onEdit={conversation?.onEdit} onDelete={conversation?.onDelete}
                    defaultOpen={conversation?.focusUpdateId === u.id}
                    // the latest update can go to the team's Slack channel (the button renders
                    // nothing in Personal, before Slack is connected, or for guests)
                    // (0058: never a Members only or Private project's: a Slack channel is the whole team's)
                    actions={i === 0 && !readOnly && !projectLocked(project) ? (
                      <SlackPostButton workspaceId={project.workspaceId ?? null} kind="status" projectId={project.id} status={u.status}
                        getText={() => u.summary} label="Share to Slack" variant="ghost" />
                    ) : undefined} />
                </li>
              ))}
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

/** 0058: what About needs for a project's people once project access is in. */
export type AboutAccess = Omit<PeopleAccessProps, "project" | "tasks" | "nameOf"> & {
  /** open People & access (the header's lock chip, or arriving to manage it) */
  open?: boolean;
};

function AboutPanel({ project, tasks, statusUpdates, members, canManage, readOnly, onUpdate, access }: {
  project: Project; tasks: Task[]; statusUpdates: StatusUpdate[]; members: { id: string; name: string }[];
  canManage: boolean; readOnly: boolean; onUpdate: (id: string, patch: Record<string, unknown>) => void;
  access?: AboutAccess;
}) {
  const today = todayISO();
  const facts = useMemo(() => statusFacts(project, tasks, statusUpdates, KANBO_TODAY), [project, tasks, statusUpdates, today]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [descEditing, setDescEditing] = useState(false);
  const [descDraft, setDescDraft] = useState(project.description || "");
  useEffect(() => { setEmojiOpen(false); setDescEditing(false); }, [project.id]);
  const editable = !readOnly;
  const ownerId = project.ownerId ?? null;
  // (0058: someone a guest can't see is "Someone at …", never "Former member")
  const someone = access && accessOn(access.ctx.workspaces.find((w) => w.id === project.workspaceId)) ? `Someone at ${access.workspaceName}` : "Former member";
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name || getMember(id)?.name
    || access?.ctx.wsMembers.find((m) => m.userId === id && m.workspaceId === project.workspaceId)?.name || someone;
  const contribIds = (project.contributorIds ?? []).filter((id) => id !== ownerId);
  const toggleContrib = (id: string) => {
    const set = new Set(contribIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    onUpdate(project.id, { contributorIds: [...set] });
  };
  const mine = tasks.filter((t) => t.projectId === project.id && !t.archivedAt);
  // 0058: switch on, People & access (opened from the summary or the header's lock chip)
  const accessIsOn = !!access && accessOn(access.ctx.workspaces.find((w) => w.id === project.workspaceId));
  const [peopleOpen, setPeopleOpen] = useState(!!access?.open);
  useEffect(() => { if (access?.open) setPeopleOpen(true); }, [access?.open, project.id]);
  // (opened from the header's lock chip: brought into view, on a phone below the fold, with focus on its heading)
  const peopleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!access?.open || !peopleOpen) return;
    const el = peopleRef.current;
    if (!el) return;
    el.scrollIntoView?.({ block: "start" });
    el.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  }, [access?.open, peopleOpen, project.id]);
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
            {/* (how fresh the update is, only when the pill, the stale note and the update day don't say it already) */}
            <span className="kpj-card-meta">{kanbosRead(facts, { withUpdate: !stale && !!facts.latest && !rhythmOnFor(project) })}</span>
            {editable && !facts.latest && (
              <select className="kpj-field" data-size="sm" value={project.status ?? ""} aria-label="Status set by hand"
                onChange={(e) => onUpdate(project.id, { status: e.target.value })}>
                <option value="">Not set</option>
                {PROJECT_STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
              </select>
            )}
            {/* once updates are posting, the call is theirs; putting it on hold by hand still stays put. On hold
                because the latest update says so: it comes off with the next update, so this says that */}
            {editable && facts.latest && (project.status !== "on_hold" && facts.latest.status === "on_hold" ? (
              <span className="kpj-card-meta">On hold from the latest update. Post an update to take it off hold.</span>
            ) : (
              <select className="kpj-field" data-size="sm" value={project.status === "on_hold" ? "on_hold" : ""} aria-label="On hold"
                onChange={(e) => onUpdate(project.id, { status: e.target.value })}>
                <option value="">Active</option>
                <option value="on_hold">On hold</option>
              </select>
            ))}
            {stale && !rhythmOnFor(project) && <span className="kpj-card-meta kpj-warn">{facts.lastUpdateDays == null ? "No update yet" : `No update in ${facts.lastUpdateDays} days`}</span>}
          </dd>

          {/* 0053: when its updates are due (the team's day, or its own), and where this one stands */}
          <UpdateDayField project={project} tasks={mine} latest={facts.latest} lastUpdateDays={facts.lastUpdateDays} canManage={canManage} onUpdate={onUpdate} />

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

          <dt>{accessIsOn ? "People & access" : "Contributors"}</dt>
          <dd>
            {access && accessIsOn ? (
              <>
                <span className="kpj-card-meta" style={{ color: "var(--ink-2)" }}>{accessSummary(project, access.ctx)}</span>
                <Button size="sm" variant="ghost" aria-expanded={peopleOpen} onClick={() => setPeopleOpen((v) => !v)}>{peopleOpen ? "Done" : canManagePeople(project, access.ctx) ? "Manage" : "See who's on it"}</Button>
              </>
            ) : access ? (
              <>
                <ContributorsChecklist project={project} access={access} nameOf={nameOf} canManage={canManage} />
                {/* (set while it was on, or the default for new projects: it applies again the moment it's on) */}
                {visibilityOf(project) !== "workspace" && (
                  <span className="kpj-card-meta" style={{ display: "block", marginTop: 6 }}>
                    Set to {VISIBILITY_LABEL[visibilityOf(project)]}. It applies once project access is on; until then everyone here sees it.
                  </span>
                )}
              </>
            ) : canManage ? (
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
        {access && accessIsOn && peopleOpen && (
          <div ref={peopleRef}><PeopleAccess {...access} project={project} tasks={tasks} nameOf={nameOf} /></div>
        )}
      </div>
    </div>
  );
}

/** 0058 in, the switch off: the same contributors checklist, guests included (labelled), each tick
 *  a member call (an editor; a guest a commenter) rather than a write to contributor_ids. */
function ContributorsChecklist({ project, access, nameOf, canManage }: { project: Project; access: AboutAccess; nameOf: (id: string) => string; canManage: boolean }) {
  const { ctx } = access;
  const wsId = project.workspaceId ?? null;
  const ownerId = project.ownerId ?? null;
  const people = ctx.wsMembers.filter((m) => (m.workspaceId ?? null) === wsId && m.status === "active" && !!m.userId && m.userId !== ownerId);
  const on = (uid: string) => memberRole(ctx, project.id, uid) !== null;
  const [busy, setBusy] = useState(false);
  // (who edits the list is as before: the project's owner and the workspace's leads)
  if (!canManage || !canManagePeople(project, ctx)) {
    const ids = people.filter((m) => on(m.userId!)).map((m) => m.userId!);
    return ids.length ? <>{ids.map((id) => <span key={id} className="kpj-person"><Avatar id={id} size={24} />{nameOf(id)}</span>)}</> : <span className="kpj-muted">None yet</span>;
  }
  if (!people.length) return <span className="kpj-muted">Invite teammates to add contributors.</span>;
  const toggle = async (uid: string) => {
    setBusy(true);
    try {
      if (on(uid)) await access.onRemoveMember(project.id, uid);
      else await access.onSetMember(project.id, uid, roleOf(ctx, wsId, uid) === "guest" ? "commenter" : "editor");
    } finally { setBusy(false); }
  };
  return (
    <div className="kpj-checklist" role="group" aria-label="Contributors">
      {people.map((m) => (
        <label key={m.userId} className="kpj-check">
          <input type="checkbox" checked={on(m.userId!)} disabled={busy} onChange={() => void toggle(m.userId!)} />
          <Avatar id={m.userId!} size={20} /><span className="truncate">{nameOf(m.userId!)}</span>
          {m.role === "guest" && <span className="kpj-card-meta">Guest</span>}
        </label>
      ))}
    </div>
  );
}

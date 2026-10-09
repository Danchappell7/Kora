/* ============================================================
   KANBO — Inbox: a triage queue you empty.
   Needs your reply · New to you · FYI, with one-key actions
   (J/K move · ↵ open · →/← show or hide a group · R reply ·
   A add to Today · D schedule · H snooze · E archive), an inline
   reply, snooze and archive, and Inbox zero at the end of it.
   0048 (u4): related items fold into one row ("3 comments on Launch
   deck from Sana and Theo", open it for the items; nothing that asks
   something of you is ever folded); snooze is per thread (notification_snoozes, every device:
   1 hour · Tomorrow 09:00 · Next week · a date and time) and a snoozed
   thread sends no push or email; kudos rows; quiet hours say so; rows
   with a task can be dragged to Today or a day (Add to Today / Schedule
   do the same from the keyboard).
   ============================================================ */
import { Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type HTMLAttributes, type PointerEvent, type ReactNode } from "react";
import { Icon, EmptyArt, EmptyState, Avatar, Button, DateChip, Kbd, ProjectTile, SectionLabel } from "../primitives";
import { Popover } from "../primitives/Popover";
import { timeAgo, getProject, getMember, MEMBERS, todayISO, toLocalISO } from "../../data/data";
import type { Task, Activity, ActivityKind, IconName, ApprovalWithTask, Member, NotificationSnooze, NotifyPrefs, Project } from "../../data/types";
import { ApprovalsInboxGroup } from "../approvals/ApprovalsInboxGroup";
import { approvalInboxLine, shownInApprovalsGroup } from "../../lib/approvals";
import { docMentionRoute } from "../../lib/docs";
import { triage, requestSource, isRequestTask, TRIAGE_GROUPS, bundleInbox, actorList, type BundleFamily, type InboxBundle, type TriageGroup } from "../../lib/inboxTriage";
import { deviceTimeZone, planLegacySnoozeMigration, quietNow, readNotifyPrefs, snoozeFailureMessage, zoneLabel } from "../../lib/notifyPrefs";
import { useTaskDragSource } from "../../lib/dnd";
import { useThreadSnoozes } from "../inbox/useThreadSnoozes";
import { SnoozeMenu } from "../inbox/SnoozeMenu";
import { dayLabel } from "../../lib/rituals";
import { prefersReducedMotion, useOptionalToast } from "../rituals/shared";
import { useEntrance } from "../../hooks/useEntrance";
import { useMediaQuery } from "../../hooks/useMediaQuery";

const KIND_META: Record<ActivityKind, { icon: IconName; verb: string }> = {
  created:   { icon: "plus",    verb: "created" },
  status:    { icon: "refresh", verb: "updated" },
  completed: { icon: "check",   verb: "completed" },
  reopened:  { icon: "refresh", verb: "reopened" },
  comment:   { icon: "message", verb: "commented on" },
  deleted:   { icon: "trash",   verb: "deleted" },
  assigned:  { icon: "user",    verb: "assigned you" },
  mention:   { icon: "message", verb: "mentioned you in" },
  integration: { icon: "zap",   verb: "" },
  // 0047: approvals (meta.event picks the words: approvalInboxLine) and doc mentions (no task: they open the doc)
  approval:    { icon: "check", verb: "asked for your approval on" },
  doc_mention: { icon: "notes", verb: "mentioned you in" },
  kudos:       { icon: "sparkles", verb: "sent you kudos for" },   // 0048: "Theo sent you 👏 for Launch deck — “Great work”"
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* Comment rows come from two sources. The notify_comment trigger (0037)
   writes detail = the commenter's name (or email, or "Someone"). Until this
   release the app ALSO self-logged a "comment" row for each of your own
   comments, with detail = an excerpt of what you wrote. This release stops
   the self-logging, so a comment row created after SELF_LOGGED_COMMENTS_END is
   a teammate's whatever their name looks like ("priya", "dan smith"). Rows
   from before it are a mix, told apart by how they read. Set it to the
   release's deploy date: the team rollout is the week of 5 October 2026, so
   it's the Monday after (erring late is the safe side — until then rows are
   told apart by how they read, whereas a date before the deploy would show
   your own short comments from the old build as "<comment> commented on…"). */
const SELF_LOGGED_COMMENTS_END = Date.parse("2026-10-12T00:00:00Z");
// sentence punctuation, or the "…" a long excerpt was cut with: never part of a profile name
const SENTENCE_RE = /[!?;:,\n\r…]|\.{3}/;
// words a whole comment is made of but a name isn't ("Sounds Good", "Great Work", "Will Do")
const REPLY_WORDS = new Set([
  "ok", "okay", "yes", "yep", "yeah", "nope", "thanks", "thank", "thx", "cheers", "done", "great", "good", "nice",
  "cool", "perfect", "agreed", "agree", "sure", "noted", "lgtm", "approved", "fixed", "updated", "awesome",
  "brilliant", "lovely", "sorted", "sounds", "looks", "ship", "it", "i", "we", "me", "you", "do", "see", "got",
  "please", "the", "is", "are", "this", "that", "all", "work", "job", "well", "hi", "hey", "hello", "fyi", "asap",
]);

/* Who a notification row is from. Assignment and mention rows are written by
   DB triggers with detail = the actor's name. Returns null for a self-logged
   comment row, so a teammate's comment never reads "You commented on…" with
   their name quoted as if it were the comment. */
function actorOf(a: Activity): string | null {
  if (a.kind === "assigned" || a.kind === "mention" || a.kind === "doc_mention") return a.detail?.trim() || "Someone";
  if (a.kind === "approval" || a.kind === "kudos") return a.detail?.trim() || "Someone";
  if (a.kind !== "comment") return null;
  const d = (a.detail || "").trim();
  if (!d || d === "Someone" || EMAIL_RE.test(d)) return d || "Someone";
  const k = d.toLowerCase();
  if (MEMBERS.some((m) => m.name?.trim().toLowerCase() === k || m.email?.toLowerCase() === k)) return d;
  // reads as a sentence: your own comment (even from a tab still on the old build)
  if (SENTENCE_RE.test(d)) return null;
  if (Date.parse(a.createdAt) >= SELF_LOGGED_COMMENTS_END) return d;
  // older rows: up to four capitalised words that aren't a stock reply read as a
  // name, e.g. a teammate who has since left the workspace ("Priya", "Priya Natarajan")
  const words = d.split(/\s+/);
  if (words.length > 4 || /[\d"“”()[\]{}<>@#/\\]/.test(d)) return null;
  if (words.some((w) => REPLY_WORDS.has(w.toLowerCase().replace(/[.'’]+$/, "")))) return null;
  return words.every((w) => /^\p{Lu}/u.test(w)) ? d : null;
}
const ACTOR_VERB: Partial<Record<ActivityKind, string>> = {
  assigned: "assigned you",
  mention: "mentioned you in",
  comment: "commented on",
  doc_mention: "mentioned you in",
  kudos: "sent you kudos for",
};

/* Work that arrived through a request form reads "New request: {title}",
   not "<Request via Launch requests> assigned you…": an assignment or
   creation row whose own detail says "Request via …", or the row for the
   request task being created. An assignment by a person keeps their name
   ("Sana Rao assigned you …"), even on a task that began as a request. */
const REQUEST_RE = /^\s*Request via\s+/i;
const viaRequest = (a: Activity, task: Task | undefined): string | null => {
  if ((a.kind === "assigned" || a.kind === "created") && REQUEST_RE.test(a.detail || "")) return a.detail.replace(REQUEST_RE, "").trim() || "a request form";
  if (a.kind === "created" && isRequestTask(task)) return requestSource(task) ?? "a request form";
  return null;
};

/** a teammate's member id from how the feed names them (name or email) */
function memberIdByName(name: string, members?: { id: string; name: string }[]): string | null {
  const k = name.trim().toLowerCase();
  if (!k) return null;
  const hit = MEMBERS.find((m) => m.name?.trim().toLowerCase() === k || m.email?.toLowerCase() === k)
    ?? members?.map((m) => getMember(m.id)).find((m) => m?.name?.trim().toLowerCase() === k);
  return hit?.id ?? null;
}
const initialsOf = (name: string) => {
  if (EMAIL_RE.test(name)) return name[0]?.toUpperCase() ?? "?";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
};

const isEditable = (el: EventTarget | null): boolean => {
  const n = el as HTMLElement | null;
  if (!n || typeof n.closest !== "function") return false;
  return !!n.isContentEditable || !!n.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
};
/* Widgets that own their keys: dialogs and the task panel, menus, popovers,
   the date picker's grid, list boxes and the like. The Inbox's letters never
   reach past them. */
const OWN_KEYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="menubar"], [role="listbox"], [role="grid"], [role="tree"], [role="treegrid"], [role="combobox"], [role="slider"], [role="spinbutton"], [data-kpop], [data-kpop-panel]';
const ownsKeys = (el: EventTarget | null): boolean => {
  const n = el as HTMLElement | null;
  return !!n && typeof n.closest === "function" && !!n.closest(OWN_KEYS);
};
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------- snoozes on this device ----------
   Since 0048 a snooze is per thread and lives on the server (useThreadSnoozes);
   the per-device ones that are left are for items without a task (a doc
   mention, an integration notice), the old ones that have ended, and every
   snooze while the server can't keep them yet (0048 not run).
   Storage holds id → wake time for every account and workspace used in this
   browser, but the inbox only ever sees the current workspace's activity, so
   everything here touches only ids that are in `activity`. A snooze that has
   ended stays stored until its item turns up in an inbox (it may belong to
   another workspace), and is then flagged "Back from snooze" once. Ones that
   ended more than WAKE_WINDOW ago are stale: dropped, never flagged. */
const SNOOZE_KEY = "kanbo-inbox-snooze";
const ZERO_KEY = "kanbo-inbox-zero-day";
const MAX_TIMEOUT = 2 ** 31 - 1;
const WAKE_WINDOW = 7 * 86400000;
type SnoozeState = {
  until: Record<string, number>;   // persisted: id → wake time (ms), including ended snoozes not yet flagged
  woke: Record<string, number>;    // this visit: came back during/just before it, flagged until acted on
};
function readSnoozes(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(SNOOZE_KEY) || "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  } catch { return {}; }
}
function withoutStale(rec: Record<string, number>, now = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec)) if (v > now - WAKE_WINDOW) out[k] = v;
  return out;
}
function initialSnoozes(): SnoozeState {
  return { until: withoutStale(readSnoozes()), woke: {} };
}
function omit<T>(rec: Record<string, T>, ids: string[]): Record<string, T> {
  if (!ids.some((id) => id in rec)) return rec;
  const next = { ...rec };
  for (const id of ids) delete next[id];
  return next;
}
function withoutIds(s: Set<string>, ids: string[]): Set<string> {
  if (!ids.some((id) => s.has(id))) return s;
  const next = new Set(s);
  for (const id of ids) next.delete(id);
  return next;
}

// one formatter for every row (toLocaleString builds a new one per call)
const FULL_DATE = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const WAKE_TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
function fullDate(iso: string | number): string | undefined {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : FULL_DATE.format(d);
}
/** "07:00" in a timezone */
function timeIn(d: Date, tz: string): string {
  try { return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(d); }
  catch { return WAKE_TIME.format(d); }
}
/** "15:42" today, "Tomorrow 09:00", else "Mon 5 Oct 09:00" */
function wakeLabel(ms: number): string {
  const d = new Date(ms), now = new Date();
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
  const t = WAKE_TIME.format(d);
  return days <= 0 ? t : days === 1 ? `Tomorrow ${t}` : `${dayLabel(toLocalISO(d))} ${t}`;
}

/* Who the row is from: their avatar, initials for someone the workspace
   doesn't know (an email, a teammate who has left), or the kind of change
   for your own history. */
function ActorMark({ actor, kind, request, members }: { actor: string | null; kind: ActivityKind; request: boolean; members?: { id: string; name: string }[] }) {
  if (request) return <span className="kinbox-av" data-kind="icon" aria-hidden="true"><Icon name="inbox" size={14} sw={1.75} /></span>;
  if (actor) {
    const id = memberIdByName(actor, members);
    if (id && getMember(id)) return <span className="kinbox-av" aria-hidden="true"><Avatar id={id} size={28} /></span>;
    if (actor !== "Someone") return <span className="kinbox-av" data-kind="initials" aria-hidden="true">{initialsOf(actor)}</span>;
    return <span className="kinbox-av" data-kind="icon" aria-hidden="true"><Icon name="user" size={14} sw={1.75} /></span>;
  }
  return <span className="kinbox-av" data-kind="icon" aria-hidden="true"><Icon name={KIND_META[kind]?.icon ?? "refresh"} size={14} sw={1.75} /></span>;
}

type Segment = "inbox" | "snoozed" | "archived";
type ConfirmScope = "all" | "fyi";
type ReplyState = { id: string; sending: boolean; error?: string };
type RowAct = { act: string; icon: IconName; label: string; tip: string; kbd?: string; run: (anchor: HTMLElement) => void; pressed?: boolean; menu?: boolean };
/** A line in the list: one item, a bundle of related items (its head, `a` = the newest),
 *  or one of an open bundle's items (`parent` = the bundle's key). */
interface Row { id: string; a: Activity; items: Activity[]; bundle: InboxBundle | null; parent?: string }

const BUNDLE_NOUN: Record<BundleFamily, [string, string, string]> = {
  comment: ["comment", "comments", "on"], kudos: ["kudos", "kudos", "for"], history: ["update", "updates", "to"],
};
const domId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

/* A row that can be picked up and dropped on Today / a day of the week (u3's
   targets). Never the only way: Add to Today (A) and Schedule (D) do the same. */
function RowFrame({ rowRef, dragTaskId, dragOrigin, dragDisabled, dragLabel, children, ...div }: HTMLAttributes<HTMLDivElement> & {
  rowRef: (el: HTMLDivElement | null) => void;
  dragTaskId: string | null;
  dragOrigin: string;
  dragDisabled: boolean;
  dragLabel: string;
  children: ReactNode;
}) {
  const src = useTaskDragSource({
    taskIds: dragTaskId ? [dragTaskId] : [], source: "inbox", originId: dragOrigin, meta: { activityId: dragOrigin },
    disabled: dragDisabled || !dragTaskId, label: dragLabel,
  });
  // picked up by the row itself, never from its buttons, date chip or reply box
  const down = src.bind.onPointerDown;
  const onPointerDown = down && ((e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement | null)?.closest?.(".kinbox-acts, .kinbox-due, .kinbox-expand, .kinbox-compose")) return;
    down(e);
  });
  return <div {...div} {...src.bind} onPointerDown={onPointerDown} ref={rowRef}>{children}</div>;
}

export interface InboxViewProps {
  activity: Activity[];
  tasks: Task[];
  onOpen: (id: string) => void;
  onArchive: (id: string) => void;
  /** Archive the given items — "Archive all" passes exactly what the inbox is
      currently showing (minus snoozed items); archiving a bundle passes its items. */
  onClearAll: (ids?: string[]) => void;
  /** the signed-in user: "New to you" requests are the ones assigned to them */
  currentUserId?: string;
  members?: { id: string; name: string }[];
  /** R: post a comment on the item's task. Resolving to null counts as a failed
      send. `mentions` is only ever passed when replying to a mention: it holds
      the member id of the person who mentioned you, so your answer reaches
      them (commenters aren't followers, so a plain comment might not). Replies
      to assignments and comments are plain comments. */
  onReply?: (taskId: string, body: string, mentions?: string[]) => Promise<unknown>;
  /** A: put the task on your Today */
  onAcceptToday?: (taskId: string) => void;
  /** D: set the task's due date */
  onSchedule?: (taskId: string, dueDate: string) => void;
  /** ⋯ › Mark task done */
  onComplete?: (taskId: string) => void;
  /** guests: no Add to Today, scheduling or completing (they can still reply, snooze and archive) */
  readOnly?: boolean;
  /** the Archived filter's items; without it, what was archived on this visit */
  archived?: Activity[];
  /** Archived › Move back to Inbox */
  onUnarchive?: (ids: string[]) => void;
  /** the feed hasn't loaded yet: placeholder rows, and never "Inbox zero" */
  loading?: boolean;
  /** the feed couldn't be loaded: says so (with Try again) instead of "Inbox zero" */
  loadError?: boolean;
  onRetry?: () => void;
  /** How many items are new on this visit and still in the Inbox (the rows with a
   *  dot): told on every change, so the page header and the Inbox badges show the
   *  same number as the list — falling as items are opened, archived or snoozed. */
  onNewCount?: (n: number) => void;
  /** an integration notice (no task, e.g. "Webhook to … switched off"): open where it's fixed (Settings › Developers) */
  onOpenIntegration?: (a: Activity) => void;
  /** 0047 "Approvals for you": requests waiting on your decision (lib/approvals listMyApprovals().toReview),
   *  shown first; their request notices aren't repeated in the triage groups */
  approvals?: { toReview: ApprovalWithTask[]; projects: Project[]; members: Member[]; onDecided?: () => void };
  /** 0047: a doc mention (no task) opens its doc (/p/:projectId/docs/:docId) */
  onOpenDoc?: (a: Activity) => void;
  /** 0048 thread snoozes (notification_snoozes, your own rows). Absent: the Inbox reads
   *  and writes them itself through lib/notifyPrefs (demo: in memory). Pass App's copy
   *  with onSnooze / onUnsnooze to share it. */
  snoozes?: NotificationSnooze[];
  /** snooze, move or (with a time now) end a thread's snooze — used with `snoozes` */
  onSnooze?: (taskId: string, until: Date) => Promise<unknown> | void;
  /** forget a thread's snooze once it's been dealt with — used with `snoozes` */
  onUnsnooze?: (taskId: string) => Promise<unknown> | void;
  /** 0048 profiles.notify_prefs: "bundle" off shows every item on its own; quiet hours
   *  show a quiet line above the list */
  notifyPrefs?: NotifyPrefs;
  /** the quiet line's "Change" (Settings › Notifications) */
  onOpenNotificationSettings?: () => void;
}

export function InboxView({
  activity, tasks, onOpen, onArchive, onClearAll,
  currentUserId, members, onReply, onAcceptToday, onSchedule, onComplete, readOnly, archived, onUnarchive,
  loading, loadError, onRetry, onNewCount, onOpenIntegration, approvals, onOpenDoc,
  snoozes: snoozesProp, onSnooze, onUnsnooze, notifyPrefs, onOpenNotificationSettings,
}: InboxViewProps) {
  const entrance = useEntrance();
  const toast = useOptionalToast();
  const narrow = useMediaQuery("(max-width: 560px)");
  const [segment, setSegment] = useState<Segment>("inbox");
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [snz, setSnz] = useState<SnoozeState>(initialSnoozes);
  const [tick, setTick] = useState(0);
  const [confirm, setConfirm] = useState<ConfirmScope | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reply, setReply] = useState<ReplyState | null>(null);
  // what you've written, per row, for this visit: moving to another row (or
  // putting the composer away) never throws a half-written reply away
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replied, setReplied] = useState<Set<string>>(() => new Set());
  const [onToday, setOnToday] = useState<Set<string>>(() => new Set());
  const [visitArchived, setVisitArchived] = useState<Activity[]>([]);
  const [sweep, setSweep] = useState(false);
  // bundles opened to their items (by bundle key)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Unread snapshot: App marks everything read the moment the inbox opens, so
  // capture what was unread on arrival (and anything that lands while it's
  // open) to keep the dots for this visit.
  const [unread, setUnread] = useState<Set<string>>(() => new Set(activity.filter((a) => !a.readAt).map((a) => a.id)));
  const knownRef = useRef<Set<string> | null>(null);
  if (knownRef.current === null) knownRef.current = new Set(activity.map((a) => a.id));
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const snoozeRefs = useRef(new Map<string, HTMLButtonElement>());
  const moreRefs = useRef(new Map<string, HTMLButtonElement>());
  const moreAnchor = useRef<HTMLElement | null>(null);
  const focusNextRef = useRef<string | null>(null);
  // the confirm row replaces its trigger, so focus goes back through refs that
  // follow whichever button is mounted now (never a node that has unmounted)
  const archiveAllRef = useRef<HTMLButtonElement>(null);
  const archiveFyiRef = useRef<HTMLButtonElement>(null);
  const inboxSegRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreConfirmFocus = useRef<ConfirmScope | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  /* ---------- 0048: thread snoozes, prefs ---------- */
  const threads = useThreadSnoozes(currentUserId, snoozesProp ? { snoozes: snoozesProp, onSnooze, onUnsnooze } : undefined);
  // the server keeps thread snoozes; until it can (0048 not run), this device does, per item
  const threadsOn = threads.mode === "server";
  const threadUntil = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of threads.snoozes) { const t = Date.parse(s.until); if (Number.isFinite(t)) m.set(s.taskId, t); }
    return m;
  }, [threads.snoozes]);
  const prefs = useMemo(() => readNotifyPrefs(notifyPrefs), [notifyPrefs]);
  const zone = useMemo(() => deviceTimeZone(), []);

  useEffect(() => {
    const known = knownRef.current!;
    const fresh: string[] = [];
    for (const a of activity) {
      if (known.has(a.id)) continue;
      known.add(a.id);
      if (!a.readAt) fresh.push(a.id);
    }
    if (fresh.length) setUnread((s) => { const n = new Set(s); fresh.forEach((id) => n.add(id)); return n; });
  }, [activity]);

  // persist this device's snoozes (a woken one leaves storage once it's flagged here, so it's flagged once)
  useEffect(() => {
    try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(snz.until)); } catch { /* private mode */ }
  }, [snz.until]);

  // the old per-device snoozes move to their threads (once the server answers); the
  // rest stay here: items without a task, ended ones, and other workspaces' items.
  // They leave this device in the same moment their threads are snoozed (optimistic),
  // and come back to it if the server says no.
  const snoozeThreadRef = useRef(threads.snooze);
  snoozeThreadRef.current = threads.snooze;
  // threads the server refused this visit: they stay on this device (no retry loop)
  const refusedMoves = useRef(new Set<string>());
  useEffect(() => {
    if (!threadsOn || !threads.ready) return;
    const plan = planLegacySnoozeMigration(snz.until, activity, Date.now());
    const moves = plan.threads.filter((t) => !refusedMoves.current.has(t.taskId));
    if (!moves.length) return;
    const taskOfItem = new Map(activity.map((a) => [a.id, a.taskId]));
    const movingTasks = new Set(moves.map((t) => t.taskId));
    const moving = Object.keys(snz.until).filter((id) => !(id in plan.keep) && movingTasks.has(taskOfItem.get(id) ?? ""));
    const stored = Object.fromEntries(moving.map((id) => [id, snz.until[id]]));
    setSnz((s) => ({ ...s, until: omit(s.until, moving) }));
    for (const t of moves) {
      void snoozeThreadRef.current(t.taskId, new Date(t.until)).then((r) => {
        if (r.ok || !mounted.current) return;
        refusedMoves.current.add(t.taskId);
        const keep = Object.fromEntries(Object.entries(stored).filter(([id]) => taskOfItem.get(id) === t.taskId));
        setSnz((s) => ({ ...s, until: { ...keep, ...s.until } }));
      });
    }
  }, [threadsOn, threads.ready, activity, snz.until]);

  // wake snoozed items on time, even while the inbox stays open. Only items in
  // THIS inbox are flagged; an ended snooze for another workspace's item stays
  // stored for that inbox until it goes stale.
  const activityIds = useMemo(() => new Set(activity.map((a) => a.id)), [activity]);
  useEffect(() => {
    const t = Date.now();
    const woken: [string, number][] = [], stale: string[] = [];
    let next = Infinity;
    for (const [k, v] of Object.entries(snz.until)) {
      if (v > t) next = Math.min(next, v);
      else if (activityIds.has(k)) woken.push([k, v]);
      else if (v <= t - WAKE_WINDOW) stale.push(k);
    }
    if (woken.length || stale.length) {
      setSnz((s) => ({
        until: omit(s.until, [...woken.map(([k]) => k), ...stale]),
        woke: woken.length ? { ...s.woke, ...Object.fromEntries(woken) } : s.woke,
      }));
      return;
    }
    // threads wake too, and quiet hours end
    for (const u of threadUntil.values()) if (u > t) next = Math.min(next, u);
    const quiet = notifyPrefs ? quietNow(prefs) : null;
    if (quiet) next = Math.min(next, quiet.until.getTime());
    if (!Number.isFinite(next)) return;
    const id = window.setTimeout(() => setTick((x) => x + 1), Math.min(MAX_TIMEOUT, next - t + 50));
    return () => window.clearTimeout(id);
  }, [snz.until, activityIds, tick, threadUntil, prefs, notifyPrefs]);

  // keyboard continuity: after archiving/snoozing a row, focus its neighbour
  useEffect(() => {
    const id = focusNextRef.current;
    if (!id) return;
    focusNextRef.current = null;
    rowRefs.current.get(id)?.focus({ preventScroll: true });
  });

  useEffect(() => {
    if (confirm) { confirmRef.current?.focus(); return; }
    const from = restoreConfirmFocus.current;
    if (!from) return;
    restoreConfirmFocus.current = null;
    // back to the trigger; once its items are archived (and it's gone), to the
    // next control along the bar
    const el = (from === "fyi" ? archiveFyiRef.current : null) ?? archiveAllRef.current ?? inboxSegRef.current;
    el?.focus();
  }, [confirm]);

  /* ---------- what's on screen ---------- */
  const now = Date.now();
  const threadOf = (a: Activity) => (a.taskId ? threadUntil.get(a.taskId) ?? 0 : 0);
  /** when the item comes back (0: it isn't snoozed): its thread's snooze, or this device's for the item */
  const snoozedUntil = (a: Activity) => {
    const local = snz.until[a.id] ?? 0, thread = threadOf(a);
    return Math.max(local > now ? local : 0, thread > now ? thread : 0);
  };
  const isSnoozed = (a: Activity) => snoozedUntil(a) > 0;
  /** when it came back from a snooze, while that still needs saying (0: it didn't) */
  const backAt = (a: Activity) => {
    const local = snz.woke[a.id] ?? (a.id in snz.until && snz.until[a.id] <= now ? snz.until[a.id] : 0);
    const t = threadOf(a);
    return Math.max(local, t && t <= now && t > now - WAKE_WINDOW ? t : 0);
  };
  // a request still waiting in "Approvals for you" shows there (with its buttons), not twice
  const toReview = approvals?.toReview ?? [];
  const reviewCount = toReview.filter((r) => r.status === "pending" && r.canDecide !== false).length;
  const visible = activity.filter((a) => !isSnoozed(a) && !shownInApprovalsGroup(a, toReview));
  const snoozedItems = activity.filter(isSnoozed).sort((x, y) => snoozedUntil(x) - snoozedUntil(y));
  const snoozedCount = snoozedItems.length;
  const archivedItems = useMemo(() => {
    const src = archived ?? visitArchived;
    return src.filter((a) => !activityIds.has(a.id));
  }, [archived, visitArchived, activityIds]);
  // items back from a snooze lead, so the reminder actually reminds (an ended
  // snooze counts before the wake effect has moved it, so nothing jumps)
  const back = visible.filter((a) => backAt(a)).sort((x, y) => backAt(y) - backAt(x));
  const groups = triage(visible.filter((a) => !backAt(a)), { me: currentUserId, tasks: taskById });
  const sections: { id: TriageGroup | "back"; label: string; items: Activity[] }[] = segment === "inbox"
    ? [{ id: "back" as const, label: "Back from snooze", items: back }, ...TRIAGE_GROUPS.map((g) => ({ id: g.id, label: g.label, items: groups[g.id] }))]
        .filter((s) => s.items.length > 0)
    : [];
  // related items fold into one row (never a mention): "3 comments on Launch deck from Sana and Theo"
  const toRows = (items: Activity[], group: string, bundle = prefs.bundle): Row[] => {
    const out: Row[] = [];
    for (const b of bundleInbox(items, { tasks: taskById, group, actorOf, bundle })) {
      if (b.items.length === 1) { out.push({ id: b.items[0].id, a: b.items[0], items: b.items, bundle: null }); continue; }
      out.push({ id: b.key, a: b.items[0], items: b.items, bundle: b });
      if (expanded.has(b.key)) for (const a of b.items) out.push({ id: a.id, a, items: [a], bundle: null, parent: b.key });
    }
    return out;
  };
  const sectionRows = sections.map((s) => ({ ...s, rows: toRows(s.items, s.id) }));
  const rows: Row[] = segment === "inbox" ? sectionRows.flatMap((s) => s.rows)
    : segment === "snoozed" ? toRows(snoozedItems, "snoozed") : toRows(archivedItems, "archived", false);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  // new on this visit and still here: the dots, and the number App shows beside them
  // (+ a request's own unread notice, which shows as its row in "Approvals for you" rather than here)
  const inGroupNew = activity.reduce((n, a) => (!isSnoozed(a) && unread.has(a.id) && shownInApprovalsGroup(a, toReview) ? n + 1 : n), 0);
  const newCount = visible.reduce((n, a) => (unread.has(a.id) || backAt(a) > 0 ? n + 1 : n), 0) + inGroupNew;
  useEffect(() => { onNewCount?.(newCount); }, [newCount, onNewCount]);
  const fyiShown = segment === "inbox" ? groups.fyi : [];

  // the snoozed/archived row vanished (filter change, realtime archive, a bundle closing…) → drop its menus
  const menuOpenFor = menu && rowById.has(menu.id) ? menu : null;
  useEffect(() => { if (menu && !menuOpenFor) setMenu(null); }, [menu, menuOpenFor]);
  const moreOpenFor = more && rowById.has(more) ? more : null;
  useEffect(() => { if (more && !moreOpenFor) setMore(null); }, [more, moreOpenFor]);
  const confirmCount = confirm === "fyi" ? fyiShown.length : visible.length;
  useEffect(() => { if (confirm && (segment !== "inbox" || confirmCount === 0)) setConfirm(null); }, [confirm, segment, confirmCount]);
  const cursorOn = cursor && rowById.has(cursor) ? cursor : null;
  const replyOn = reply && rowById.has(reply.id) ? reply : null;

  /* Inbox zero. Only a feed that has loaded can be empty: while it loads (or
     if it failed) there's no zero state and no sweep. The gradient sweeps the
     bar once a day, and only when you empty the Inbox on this visit, so a
     page that opens on an empty (or not yet loaded) feed never uses it up.
     Never under reduced motion. */
  const settled = !loading && !loadError;
  const zero = segment === "inbox" && settled && visible.length === 0 && reviewCount === 0;
  const [hadItems, setHadItems] = useState(false);
  if (!hadItems && settled && visible.length > 0) setHadItems(true);
  const cleared = zero && hadItems;
  useEffect(() => {
    if (!cleared || prefersReducedMotion()) return;
    const day = todayISO();
    try {
      if (localStorage.getItem(ZERO_KEY) === day) return;
      localStorage.setItem(ZERO_KEY, day);
    } catch { return; }
    setSweep(true);
    const t = window.setTimeout(() => setSweep(false), 1600);
    return () => { window.clearTimeout(t); setSweep(false); };
  }, [cleared]);

  /* ---------- actions ---------- */
  const neighbourOf = (id: string) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const gone = new Set([id, ...rows.filter((r) => r.parent === id).map((r) => r.id)]);
    const after = rows.slice(i + 1).find((r) => !gone.has(r.id));
    const before = rows.slice(0, i).reverse().find((r) => !gone.has(r.id) && r.id !== rows[i].parent);
    return (after ?? before)?.id ?? null;
  };
  // acted on (opened/archived/replied): no longer new, no longer back from snooze —
  // a thread that came back is settled, so it stops coming back on every device
  const forget = (items: Activity[]) => {
    const ids = items.map((a) => a.id);
    setUnread((s) => withoutIds(s, ids));
    setSnz((s) => {
      const woke = omit(s.woke, ids), until = omit(s.until, ids);
      return woke === s.woke && until === s.until ? s : { until, woke };
    });
    const settle = new Set(items.filter((a) => a.taskId && threadOf(a) && threadOf(a) <= Date.now()).map((a) => a.taskId!));
    for (const t of settle) void threads.settle(t);
  };
  const openRow = (row: Row) => {
    const a = row.a;
    if (a.kind === "doc_mention") {
      if (!onOpenDoc || !docMentionRoute(a)) return;
      forget(row.items);
      onOpenDoc(a);
      return;
    }
    if (a.kind === "integration" && !a.taskId) {
      if (!onOpenIntegration) return;
      forget(row.items);
      onOpenIntegration(a);
      return;
    }
    if (!a.taskId || !taskById.has(a.taskId)) return;
    forget(row.items);
    onOpen(a.taskId);
  };
  const noteArchived = (items: Activity[]) => {
    if (archived || !items.length) return;
    setVisitArchived((xs) => [...items, ...xs.filter((x) => !items.some((i) => i.id === x.id))]);
  };
  const archiveRow = (row: Row) => {
    focusNextRef.current = neighbourOf(row.id);
    if (reply?.id === row.id) setReply(null);
    const items = row.items.filter((a) => activityIds.has(a.id));
    noteArchived(items);
    forget(items);
    if (items.length === 1) onArchive(items[0].id);
    else if (items.length > 1) onClearAll(items.map((a) => a.id));
  };
  const snoozeRow = (row: Row, until: number) => {
    focusNextRef.current = neighbourOf(row.id);
    setMenu(null);
    if (reply?.id === row.id) setReply(null);
    const ids = row.items.map((a) => a.id);
    setUnread((s) => withoutIds(s, ids));
    const taskId = row.a.taskId;
    if (taskId && threadsOn) {
      // the whole thread: everything on this task now and while it's snoozed
      const before = threadUntil.get(taskId);
      setSnz((s) => ({ ...s, woke: omit(s.woke, ids) }));
      void threads.snooze(taskId, new Date(until)).then((r) => {
        if (!mounted.current) return;
        if (!r.ok) { toast?.error(snoozeFailureMessage(r.failure)); return; }
        toast?.action(`Snoozed until ${wakeLabel(until)}`, "Undo", () => {
          void (before !== undefined ? threads.snooze(taskId, new Date(before)) : threads.settle(taskId));
        });
      });
      return;
    }
    // self-pruning drops only stale entries: ended snoozes for other inboxes wait their turn
    setSnz((s) => ({ until: { ...withoutStale(s.until), ...Object.fromEntries(ids.map((id) => [id, until])) }, woke: omit(s.woke, ids) }));
  };
  const closeMenu = (refocus: boolean) => {
    const m = menu;
    setMenu(null);
    if (refocus) m?.anchor.focus();
  };
  // only the snoozes counted in "{n} snoozed" (this inbox), which come back at the top
  const unsnooze = (only?: Activity[]) => {
    const t = Date.now();
    const items = only ?? activity;
    const threadsNow = new Set(items.filter((a) => a.taskId && threadOf(a) > t).map((a) => a.taskId!));
    for (const taskId of threadsNow) void threads.snooze(taskId, new Date(t));
    setSnz((s) => {
      const ids = items.map((a) => a.id).filter((id) => (s.until[id] ?? 0) > t);
      if (!ids.length) return s;
      return { until: omit(s.until, ids), woke: { ...s.woke, ...Object.fromEntries(ids.map((id) => [id, t])) } };
    });
  };
  const bringBack = (row: Row) => {
    focusNextRef.current = neighbourOf(row.id);
    unsnooze(row.items);
    toast?.toast("Back in your Inbox");
  };
  const toggleExpand = (id: string, open?: boolean) => setExpanded((s) => {
    const on = open ?? !s.has(id);
    if (on === s.has(id)) return s;
    const n = new Set(s);
    if (on) n.add(id); else n.delete(id);
    return n;
  });
  const cancelConfirm = () => { restoreConfirmFocus.current = confirm; setConfirm(null); };
  const archiveShown = () => {
    const items = confirm === "fyi" ? fyiShown : visible;
    const ids = items.map((a) => a.id);
    restoreConfirmFocus.current = confirm;
    setConfirm(null);
    if (!ids.length) return;
    if (reply && rows.some((r) => r.id === reply.id && r.items.some((a) => ids.includes(a.id)))) setReply(null);
    noteArchived(items);
    forget(items);
    onClearAll(ids);
  };
  const moveBack = (row: Row) => {
    if (!onUnarchive) return;
    focusNextRef.current = neighbourOf(row.id);
    const ids = row.items.map((a) => a.id);
    onUnarchive(ids);
    setVisitArchived((xs) => xs.filter((x) => !ids.includes(x.id)));
  };

  const taskOf = (a: Activity) => (a.taskId ? taskById.get(a.taskId) : undefined);
  const canReply = (a: Activity) => !!onReply && !!taskOf(a);
  const isOnToday = (t: Task) => !!t.planToday || onToday.has(t.id);
  const canToday = (a: Activity) => { const t = taskOf(a); return !!onAcceptToday && !readOnly && !!t && t.status !== "done" && !isOnToday(t); };
  const canSchedule = (a: Activity) => { const t = taskOf(a); return !!onSchedule && !readOnly && !!t && t.status !== "done"; };
  const canComplete = (a: Activity) => { const t = taskOf(a); return !!onComplete && !readOnly && !!t && t.status !== "done"; };

  const startReply = (row: Row) => {
    if (!canReply(row.a)) return;
    setCursor(row.id);
    setReply((r) => (r?.id === row.id ? r : { id: row.id, sending: false }));
  };
  const cancelReply = (refocus = true) => {
    const id = reply?.id;
    setReply(null);
    if (refocus && id) window.setTimeout(() => rowRefs.current.get(id)?.focus({ preventScroll: true }), 0);
  };
  const sendReply = async () => {
    const r = reply;
    const row = r && rowById.get(r.id);
    const a = row?.a;
    const t = a && taskOf(a);
    const body = r ? (drafts[r.id] ?? "").trim() : "";
    if (!r || !row || !a || !t || !body || !onReply || r.sending) return;
    // a reply to a mention goes back to whoever mentioned you; anything else is a plain comment
    const mentionId = a.kind === "mention" && !row.bundle ? memberIdByName(actorOf(a) ?? "", members) : null;
    const mentions = mentionId && mentionId !== currentUserId ? [mentionId] : undefined;
    setReply({ ...r, sending: true, error: undefined });
    let ok = false;
    try { ok = (await onReply(t.id, body, mentions)) !== null; } catch { ok = false; }
    if (!mounted.current) return;
    if (!ok) {
      setReply((cur) => (cur?.id === r.id ? { ...cur, sending: false, error: "Couldn't send your reply. Try again." } : cur));
      return;
    }
    setReply((cur) => (cur?.id === r.id ? null : cur));
    setDrafts((d) => omit(d, [r.id]));
    setReplied((s) => new Set(s).add(r.id));
    forget(row.items);
    toast?.success("Replied");
    window.setTimeout(() => rowRefs.current.get(r.id)?.focus({ preventScroll: true }), 0);
  };
  const acceptToday = (a: Activity) => {
    const t = taskOf(a);
    if (!t || !onAcceptToday || readOnly) return;
    if (isOnToday(t)) { toast?.toast("Already on Today"); return; }
    if (t.status === "done") return;
    onAcceptToday(t.id);
    setOnToday((s) => new Set(s).add(t.id));
    toast?.success("Added to Today");
  };
  const schedule = (row: Row) => {
    if (!canSchedule(row.a)) return;
    rowEls.current.get(row.id)?.querySelector<HTMLButtonElement>(".kinbox-due button.kdate")?.click();
  };
  // H: the menu hangs off the row's Snooze button, or (touch screens, where
  // only ⋯ and Archive show) off ⋯, or the row itself
  const openSnooze = (row: Row) => {
    const shown = (el: HTMLElement | null | undefined): el is HTMLElement =>
      !!el && el.isConnected && window.getComputedStyle(el).display !== "none";
    const anchor = [snoozeRefs.current.get(row.id), moreRefs.current.get(row.id), rowEls.current.get(row.id)].find(shown);
    if (anchor) setMenu({ id: row.id, anchor });
  };

  /* ---------- keyboard: J/K move · ↵ open · → / ← open or close a bundle · R · A · D · H · E ---------- */
  const moveCursor = (dir: 1 | -1) => {
    if (!rows.length) return;
    const i = cursorOn ? rows.findIndex((r) => r.id === cursorOn) : -1;
    const next = rows[i < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + dir))];
    focusRow(next.id);
  };
  const focusRow = (id: string) => {
    setCursor(id);
    rowRefs.current.get(id)?.focus({ preventScroll: true });
    // instant: a smooth scroll still running would close a menu opened next (H)
    rowEls.current.get(id)?.scrollIntoView?.({ block: "nearest", behavior: "instant" as ScrollBehavior });
  };
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const gAt = useRef(0);
  keyRef.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    // wherever focus is on the page (the Inbox, the page itself, or the sidebar
    // or phone-bar link you arrived by), except while typing, with a dialog or
    // popover open, or inside a widget that owns its keys
    const target = e.target as HTMLElement | null;
    if (isEditable(target) || ownsKeys(target)) return;
    if (document.querySelector('[aria-modal="true"], [data-kpop]')) return;
    if (!rootRef.current) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // the second key of a "g …" go-to sequence belongs to the app
    if (k === "g") { gAt.current = Date.now(); return; }
    if (gAt.current && Date.now() - gAt.current < 900) { gAt.current = 0; return; }
    // J/K anywhere in the Inbox; the arrows too while a row has focus
    const onRow = !!target?.classList?.contains("kinbox-main");
    if (k === "j" || (k === "ArrowDown" && onRow)) { e.preventDefault(); moveCursor(1); return; }
    if (k === "k" || (k === "ArrowUp" && onRow)) { e.preventDefault(); moveCursor(-1); return; }
    const row = cursorOn ? rowById.get(cursorOn) : undefined;
    if (!row) return;
    if (onRow && (k === "ArrowRight" || k === "ArrowLeft")) {
      if (row.bundle && (k === "ArrowRight") !== expanded.has(row.id)) { e.preventDefault(); toggleExpand(row.id, k === "ArrowRight"); return; }
      if (row.parent && k === "ArrowLeft") { e.preventDefault(); focusRow(row.parent); return; }
      return;
    }
    const onButton = !!target?.closest?.("button, a, [role='menuitem']");
    if (k === "Enter") { if (!onButton) { e.preventDefault(); openRow(row); } return; }
    if (e.repeat) return;
    if (segment === "inbox") {
      if (k === "r" && canReply(row.a)) { e.preventDefault(); startReply(row); return; }
      if (k === "a" && onAcceptToday && !readOnly) { e.preventDefault(); acceptToday(row.a); return; }
      if (k === "d" && canSchedule(row.a)) { e.preventDefault(); schedule(row); return; }
      if (k === "h") { e.preventDefault(); openSnooze(row); return; }
      if (k === "e") { e.preventDefault(); archiveRow(row); return; }
    } else if (segment === "snoozed") {
      if (k === "h") { e.preventDefault(); bringBack(row); return; }
      if (k === "e") { e.preventDefault(); archiveRow(row); return; }
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* ---------- rows ---------- */
  const actsFor = (row: Row, title: string): RowAct[] => {
    const a = row.a;
    const what = row.bundle ? `${row.bundle.items.length} updates on “${title}”` : `“${title}”`;
    if (segment === "snoozed") return [
      { act: "back", icon: "undo", label: `Bring back ${what}`, tip: "Bring back now", kbd: "H", run: () => bringBack(row) },
      { act: "archive", icon: "archive", label: `Archive ${what}`, tip: "Archive", kbd: "E", run: () => archiveRow(row) },
    ];
    if (segment === "archived") return onUnarchive
      ? [{ act: "back", icon: "undo", label: `Move “${title}” back to Inbox`, tip: "Move back to Inbox", run: () => moveBack(row) }]
      : [];
    const acts: RowAct[] = [];
    if (canReply(a)) acts.push({ act: "reply", icon: "message", label: `Reply to “${title}”`, tip: "Reply", kbd: "R", run: () => startReply(row), pressed: replyOn?.id === row.id });
    if (canToday(a)) acts.push({ act: "today", icon: "sun", label: `Add “${title}” to Today`, tip: "Add to Today", kbd: "A", run: () => acceptToday(a) });
    if (canSchedule(a)) acts.push({ act: "schedule", icon: "calendar", label: `Schedule “${title}”`, tip: "Schedule", kbd: "D", run: () => schedule(row) });
    acts.push({ act: "snooze", icon: "clock", label: `Snooze “${title}”`, tip: "Snooze", kbd: "H", menu: true,
      run: (el) => { if (menuOpenFor?.id === row.id) setMenu(null); else setMenu({ id: row.id, anchor: el }); } });
    acts.push({ act: "archive", icon: "archive", label: `Archive ${what}`, tip: "Archive", kbd: "E", run: () => archiveRow(row) });
    acts.push({ act: "more", icon: "more", label: `More actions for “${title}”`, tip: "More", menu: true,
      run: (el) => { moreAnchor.current = el; setMore((m) => (m === row.id ? null : row.id)); } });
    return acts;
  };

  const renderRow = (row: Row, asItem = true) => {
    const a = row.a;
    const b = row.bundle;
    const task = taskOf(a);
    const proj = task ? getProject(task.projectId) : undefined;
    const via = b ? null : viaRequest(a, task);
    const actor = via ? null : actorOf(a);
    const meta = KIND_META[a.kind] ?? KIND_META.status;
    const isUnread = row.items.some((x) => unread.has(x.id) || backAt(x) > 0);
    const title = a.taskTitle || "a task";
    const isCursor = cursorOn === row.id;
    const composing = replyOn?.id === row.id ? replyOn : null;
    const acts = actsFor(row, title);
    const snoozedUntilAt = segment === "snoozed" ? Math.max(...row.items.map(snoozedUntil)) : undefined;
    const integ = a.kind === "integration" && !a.taskId;
    const docRoute = docMentionRoute(a);
    const isDoc = a.kind === "doc_mention";
    const openable = !!task || (integ && !!onOpenIntegration) || (!!docRoute && !!onOpenDoc);
    const apv = a.kind === "approval" ? approvalInboxLine(a) : null;
    const kudosNote = a.kind === "kudos" && !b ? (a.meta?.note?.trim() || null) : null;
    const excerpt = b ? null : kudosNote ? `“${kudosNote}”` : apv?.quote ? `“${apv.quote}”`
      : !actor && !via && a.detail && (a.kind === "comment" || a.kind === "status" || integ)
      ? (a.kind === "comment" ? `“${a.detail}”` : a.detail) : null;
    const docProj = docRoute ? getProject(docRoute.projectId) : undefined;
    // the row's description: where it's from, its marks, its date (when it has
    // one) and its age; never the empty "Schedule" chip
    const subId = `kinbox-sub-${domId(row.id)}`;
    const kidsId = `kinbox-kids-${domId(row.id)}`;
    const open = !!b && expanded.has(row.id);
    const draft = segment === "inbox" && !composing && !!drafts[row.id]?.trim();
    const onTodayMark = !!task && segment === "inbox" && isOnToday(task) && task.status !== "done";
    const ctx = via
      ? <span id={`${subId}-ctx`} className="truncate">via {via}</span>
      : excerpt
        ? <span id={`${subId}-ctx`} className="kinbox-excerpt truncate">{excerpt}</span>
        : proj ?? docProj
          ? <span id={`${subId}-ctx`} className="kinbox-proj"><ProjectTile project={(proj ?? docProj)!} size={16} /><span className="truncate">{(proj ?? docProj)!.name}{isDoc ? " · Docs" : ""}</span></span>
          : null;
    const describedBy = [
      ctx && `${subId}-ctx`,
      replied.has(row.id) && `${subId}-replied`,
      draft && `${subId}-draft`,
      onTodayMark && `${subId}-today`,
      task?.dueDate && segment === "inbox" && `${subId}-due`,
      `${subId}-when`,
    ].filter(Boolean).join(" ");
    const when = snoozedUntilAt
      ? <time id={`${subId}-when`} dateTime={new Date(snoozedUntilAt).toISOString()} title={fullDate(snoozedUntilAt)} className="kinbox-when">Back {wakeLabel(snoozedUntilAt)}</time>
      : <time id={`${subId}-when`} dateTime={a.createdAt} title={fullDate(a.createdAt)} className="kinbox-when">{timeAgo(a.createdAt)}</time>;
    const due = task && segment === "inbox" && !row.parent && (task.dueDate || canSchedule(a)) ? (
      // one Tab stop per row: the chip joins the tab order on the cursor row
      // only, like the row's actions (D reaches it from anywhere)
      <span className="kinbox-due" id={`${subId}-due`} data-empty={!task.dueDate || undefined}
        ref={(el) => { const btn = el?.querySelector<HTMLButtonElement>("button.kdate"); if (btn) btn.tabIndex = isCursor ? 0 : -1; }}>
        <DateChip value={task.dueDate} time={task.dueTime} label={`Due date for “${title}”`} status={task.status} placeholder="Schedule"
          readOnly={!canSchedule(a)}
          onChange={(d) => {
            if (!onSchedule) return;
            // the picker's "No date": the Inbox only ever sets dates; clearing one is the task's business
            if (!d) { if (task.dueDate) toast?.action("To remove a due date, open the task", "Open", () => openRow(row)); return; }
            if (d === task.dueDate) return;
            onSchedule(task.id, d);
            toast?.success(`Scheduled for ${dayLabel(d)}`);
          }} />
      </span>
    ) : null;
    const [one, many] = b?.family ? BUNDLE_NOUN[b.family] : ["update", "updates"];
    const expand = b ? (
      <button type="button" className="kinbox-expand" aria-expanded={open} aria-controls={kidsId} tabIndex={isCursor ? 0 : -1}
        aria-label={open ? `Hide the ${b.items.length} ${many} on “${title}”` : `Show all ${b.items.length} ${many} on “${title}”`}
        onClick={() => toggleExpand(row.id)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} sw={2} />
        {open ? "Hide" : `Show all ${b.items.length}`}
      </button>
    ) : null;
    const marks = (
      <>
        {replied.has(row.id) && <span id={`${subId}-replied`} className="kinbox-mark" data-tone="ok"><Icon name="check" size={12} sw={2} /> Replied</span>}
        {draft && <span id={`${subId}-draft`} className="kinbox-mark" data-tone="quiet"><Icon name="notes" size={12} sw={2} /> Draft</span>}
        {onTodayMark && <span id={`${subId}-today`} className="kinbox-mark"><Icon name="sun" size={12} sw={2} /> On Today</span>}
      </>
    );
    const emoji = a.kind === "kudos" ? a.meta?.emoji?.trim() : undefined;
    const say = b?.family
      ? <>{b.items.length} {b.items.length === 1 ? one : many} {BUNDLE_NOUN[b.family][2]} <strong>{title}</strong>
          {b.family !== "history" && b.actors.length > 0 && <> from <strong>{actorList(b.actors)}</strong></>}</>
      : integ
        ? <strong>{a.taskTitle || "An integration needs you"}</strong>
        : via
        ? <>New request: <strong>{title}</strong></>
        : apv
        ? <><strong>{apv.actor}</strong> {apv.verb} <strong>{title}</strong></>
        : isDoc
        ? <><strong>{actor}</strong> {ACTOR_VERB.doc_mention} <strong>{a.taskTitle || "a doc"}</strong></>
        : a.kind === "kudos" && actor
        ? <><strong>{actor}</strong> sent you {emoji ? <span className="kinbox-emoji">{emoji}</span> : "kudos"} for <strong>{title}</strong></>
        : actor
          ? <><strong>{actor}</strong> {ACTOR_VERB[a.kind]} <strong>{title}</strong></>
          : <>You {meta.verb} <strong>{title}</strong></>;
    const style = { "--acts-w": `${Math.max(64, acts.length * 30)}px` } as CSSProperties;
    return (
      <RowFrame key={row.id} role={asItem ? "listitem" : undefined} className="kinbox-row" data-unread={isUnread || undefined} data-cursor={isCursor || undefined}
        data-open={composing ? true : undefined} data-gone={task || integ || (isDoc && openable) ? undefined : true}
        data-child={row.parent ? true : undefined} data-bundle={b ? true : undefined} style={style}
        rowRef={(el) => { if (el) rowEls.current.set(row.id, el); else rowEls.current.delete(row.id); }}
        dragTaskId={task && task.status !== "done" ? task.id : null} dragOrigin={a.id} dragDisabled={!!readOnly} dragLabel={title}
        onFocus={() => { if (cursorOn !== row.id) setCursor(row.id); }}>
        <ActorMark actor={b && !b.actors.length ? null : actor} kind={a.kind} request={!!via} members={members} />
        <div className="kinbox-body">
          <button type="button" className="kinbox-main" aria-describedby={describedBy}
            ref={(el) => { if (el) rowRefs.current.set(row.id, el); else rowRefs.current.delete(row.id); }}
            onClick={() => openRow(row)} aria-disabled={openable ? undefined : true}
            title={openable || integ ? undefined : isDoc ? "This doc is no longer available" : "This task has been archived or is no longer available"}>
            {isUnread && <span className="sr-only">Unread: </span>}
            {/* two lines before clipping, so "who did what" survives a phone-width row */}
            <span className="kinbox-say">{say}</span>
          </button>
          <div className="kinbox-sub">
            {ctx}
            {expand}
            {marks}
            {due}
            {narrow && when}
          </div>
          {composing && (
            <ReplyComposer state={composing} text={drafts[row.id] ?? ""} to={b ? null : actor} notifies={a.kind === "mention" && !b}
              onChange={(text) => {
                setDrafts((d) => ({ ...d, [row.id]: text }));
                setReply((r) => (r && r.id === row.id && r.error ? { ...r, error: undefined } : r));
              }}
              onSend={sendReply} onCancel={() => cancelReply()} />
          )}
        </div>
        <div className="kinbox-side">
          <span className="kinbox-stamp">
            {!narrow && when}
            {isUnread && <span className="kinbox-dot" aria-hidden="true" />}
          </span>
          {acts.length > 0 && (
            <span className="kinbox-acts">
              {acts.map((x) => (
                <button key={x.act} type="button" className="kibtn kinbox-act" data-size="sm" data-act={x.act}
                  aria-label={x.label} data-tip={x.kbd ? `${x.tip} · ${x.kbd}` : x.tip} aria-keyshortcuts={x.kbd}
                  aria-haspopup={x.menu ? "menu" : undefined}
                  aria-expanded={x.act === "snooze" ? menuOpenFor?.id === row.id : x.act === "more" ? moreOpenFor === row.id : undefined}
                  aria-pressed={x.act === "reply" ? !!x.pressed : undefined}
                  tabIndex={isCursor ? 0 : -1}
                  ref={x.act === "snooze" ? (el) => { if (el) snoozeRefs.current.set(row.id, el); else snoozeRefs.current.delete(row.id); }
                    : x.act === "more" ? (el) => { if (el) moreRefs.current.set(row.id, el); else moreRefs.current.delete(row.id); } : undefined}
                  onClick={(e) => x.run(e.currentTarget)}>
                  <Icon name={x.icon} size={16} sw={1.75} />
                </button>
              ))}
            </span>
          )}
        </div>
      </RowFrame>
    );
  };

  /** a list entry: a row, or a bundle with (when open) its items in a list of their own */
  const renderEntry = (row: Row) => {
    if (!row.bundle) return renderRow(row);
    const open = expanded.has(row.id);
    const kids = open ? rows.filter((r) => r.parent === row.id) : [];
    return (
      <div key={row.id} role="listitem" className="kinbox-bundle" data-open={open || undefined}>
        {renderRow(row, false)}
        {open && (
          <div role="list" id={`kinbox-kids-${domId(row.id)}`} className="kinbox-kids" aria-label={row.bundle.summary}>
            {kids.map((k) => renderRow(k))}
          </div>
        )}
      </div>
    );
  };
  const topRows = (list: Row[]) => list.filter((r) => !r.parent).map(renderEntry);

  const moreRow = moreOpenFor ? rowById.get(moreOpenFor) : undefined;
  const moreMenu = moreRow && (() => {
    const row = moreRow, a = row.a, title = a.taskTitle || "a task", task = taskOf(a);
    const run = (fn: () => void) => () => { setMore(null); fn(); };
    const items: { key: string; icon: IconName; label: string; kbd?: string; fn: () => void }[] = [];
    if (task) items.push({ key: "open", icon: "arrowUpRight", label: "Open task", kbd: "↵", fn: () => openRow(row) });
    else if (a.kind === "doc_mention" && onOpenDoc && docMentionRoute(a)) items.push({ key: "open", icon: "arrowUpRight", label: "Open doc", kbd: "↵", fn: () => openRow(row) });
    if (row.bundle) {
      const open = expanded.has(row.id);
      items.push({ key: "expand", icon: open ? "chevronDown" : "chevronRight", label: open ? "Hide the updates" : `Show all ${row.bundle.items.length}`, kbd: open ? "←" : "→", fn: () => toggleExpand(row.id) });
    }
    if (canReply(a)) items.push({ key: "reply", icon: "message", label: "Reply", kbd: "R", fn: () => startReply(row) });
    if (canToday(a)) items.push({ key: "today", icon: "sun", label: "Add to Today", kbd: "A", fn: () => acceptToday(a) });
    if (canSchedule(a)) items.push({ key: "schedule", icon: "calendar", label: "Schedule…", kbd: "D", fn: () => schedule(row) });
    items.push({ key: "snooze", icon: "clock", label: "Snooze…", kbd: "H", fn: () => { const el = moreRefs.current.get(row.id); if (el) setMenu({ id: row.id, anchor: el }); } });
    if (canComplete(a) && task) items.push({ key: "done", icon: "check", label: "Mark task done", fn: () => onComplete?.(task.id) });
    items.push({ key: "archive", icon: "archive", label: row.bundle ? `Archive all ${row.bundle.items.length}` : "Archive", kbd: "E", fn: () => archiveRow(row) });
    return (
      <Popover open anchorRef={moreAnchor} onClose={() => setMore(null)} role="menu" label={`Actions for “${title}”`} align="end" minWidth={220}
        style={{ padding: 4, borderRadius: "var(--r-lg, 12px)", boxShadow: "var(--e2, var(--shadow-lg))" }}>
        {items.map((it, i) => (
          <Fragment key={it.key}>
            {it.key === "archive" && i > 0 && <div className="kinbox-msep" role="separator" />}
            <button type="button" role="menuitem" className="kinbox-mi" onClick={run(it.fn)}>
              <Icon name={it.icon} size={16} sw={1.75} />
              <span>{it.label}</span>
              {it.kbd && !narrow && <Kbd>{it.kbd}</Kbd>}
            </button>
          </Fragment>
        ))}
      </Popover>
    );
  })();

  /* ---------- the bar: Inbox · Snoozed · Archived, Archive all ---------- */
  const SEGMENTS: { id: Segment; label: string; count?: number }[] = [
    { id: "inbox", label: "Inbox", count: visible.length },
    { id: "snoozed", label: "Snoozed", count: snoozedCount },
    { id: "archived", label: "Archived", count: archivedItems.length || undefined },
  ];
  const switchSegment = (s: Segment) => { setSegment(s); setConfirm(null); setCursor(null); setMore(null); setMenu(null); };
  const confirmRow = (scope: ConfirmScope) => {
    const n = scope === "fyi" ? fyiShown.length : visible.length;
    return (
      <div role="group" aria-label="Confirm archive" className="kinbox-confirm"
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancelConfirm(); } }}>
        <span className="kinbox-confirm-q">
          Archive {scope === "fyi" ? (n === 1 ? "1 FYI item" : `${n} FYI items`) : plural(n, "item")}?
          {scope === "all" && snoozedCount > 0 ? (snoozedCount === 1 ? " The snoozed item stays." : " Snoozed items stay.") : ""}
        </span>
        <Button variant="ghost" size="sm" onClick={cancelConfirm}>Cancel</Button>
        <Button ref={confirmRef} variant="primary" size="sm" icon="archive" onClick={archiveShown}>Archive</Button>
      </div>
    );
  };

  const hasBundles = rows.some((r) => r.bundle);
  const keysHint = !narrow && segment === "inbox" && rows.length > 0 && (
    <div className="kinbox-keys" aria-hidden="true">
      <span><Kbd>J</Kbd><Kbd>K</Kbd> move</span>
      <span><Kbd>↵</Kbd> open</span>
      {hasBundles && <span><Kbd>→</Kbd><Kbd>←</Kbd> show or hide a group</span>}
      {onReply && <span><Kbd>R</Kbd> reply</span>}
      {onAcceptToday && !readOnly && <span><Kbd>A</Kbd> add to Today</span>}
      {onSchedule && !readOnly && <span><Kbd>D</Kbd> schedule</span>}
      <span><Kbd>H</Kbd> snooze</span>
      <span><Kbd>E</Kbd> archive</span>
    </div>
  );

  const snoozeNote = segment === "inbox" && snoozedCount > 0 && (
    <p className="kinbox-note">
      <Icon name="clock" size={14} sw={1.75} />
      <span>{snoozedCount} snoozed · they'll come back here when their time is up</span>
      <button type="button" className="kinbox-link" onClick={() => unsnooze()}>Bring back now</button>
    </p>
  );

  // quiet hours right now: push and email wait, the Inbox doesn't
  const quiet = notifyPrefs && segment === "inbox" ? quietNow(prefs) : null;
  const quietLine = quiet && (
    <p className="kinbox-quiet">
      <Icon name="moon" size={14} sw={1.75} />
      <span>
        Quiet hours until {timeIn(quiet.until, prefs.timezone)}{prefs.timezone !== zone ? ` ${zoneLabel(prefs.timezone)}` : ""}.
        {" "}Push and email wait; your Inbox still updates.
      </span>
      {onOpenNotificationSettings && <button type="button" className="kinbox-link" onClick={onOpenNotificationSettings}>Change</button>}
    </p>
  );

  // "Approvals for you" leads the Inbox, above the triage groups and above loading / error states
  const approvalsGroup = segment === "inbox" && approvals && toReview.length > 0 ? (
    <ApprovalsInboxGroup approvals={toReview} projects={approvals.projects} members={approvals.members} currentUserId={currentUserId ?? ""}
      onOpenTask={onOpen} onDecided={() => approvals.onDecided?.()} />
  ) : null;

  let body: JSX.Element;
  if (segment === "inbox" && !visible.length && loading) {
    // not loaded yet: the shape of the queue, never a false "Inbox zero"
    body = (
      <div className="kinbox-group" aria-busy="true">
        <span className="kinbox-skel-label skel" aria-hidden="true" />
        <div className="kinbox-rows" aria-hidden="true">
          {[62, 48, 70, 54, 40].map((w, i) => (
            <div key={i} className="kinbox-skel">
              <span className="skel kinbox-skel-av" />
              <span className="kinbox-skel-lines">
                <span className="skel kinbox-skel-line" style={{ width: `${w}%` }} />
                <span className="skel kinbox-skel-line" data-sub="true" style={{ width: `${Math.round(w * 0.55)}%` }} />
              </span>
              <span className="skel kinbox-skel-when" />
            </div>
          ))}
        </div>
        <span className="sr-only" role="status">Loading your Inbox</span>
      </div>
    );
  } else if (segment === "inbox" && !visible.length && loadError) {
    body = (
      <EmptyState art="inbox" title="Couldn't load your Inbox" size="lg"
        body="Check your connection. Nothing has been lost."
        action={onRetry ? <Button variant="secondary" icon="refresh" onClick={onRetry}>Try again</Button> : undefined} />
    );
  } else if (segment === "inbox" && zero) {
    body = (
      <div className="kinbox-zero">
        <EmptyArt kind="inbox" size={96} />
        <h2 className="kinbox-zero-title">
          <span className="kinbox-zero-hero">Inbox zero.</span>{" "}
          <span className="kinbox-zero-sub">Nothing needs you.</span>
        </h2>
        <p className="kinbox-zero-body">New mentions, assignments and requests land here.</p>
        {snoozeNote}
      </div>
    );
  } else if (segment === "inbox") {
    body = (
      <>
        {sectionRows.map((s, i) => (
          <section key={s.id} className="kinbox-group" aria-label={s.label} data-tour={i === 0 ? "inbox-triage" : undefined}>
            <SectionLabel count={s.items.length}
              action={s.id === "fyi" && s.items.length > 1
                ? (confirm === "fyi" ? confirmRow("fyi")
                  : <Button ref={archiveFyiRef} variant="ghost" size="sm" aria-label="Archive FYI items" onClick={() => setConfirm("fyi")}>Archive FYI</Button>)
                : undefined}>
              {s.id === "back" && <Icon name="clock" size={12} sw={2} />}{s.label}
            </SectionLabel>
            <div role="list" className={"kinbox-rows " + entrance}>{topRows(s.rows)}</div>
          </section>
        ))}
        {snoozeNote}
        {keysHint}
      </>
    );
  } else if (segment === "snoozed") {
    body = snoozedItems.length ? (
      <section className="kinbox-group" aria-label="Snoozed">
        <SectionLabel count={snoozedItems.length}>Coming back later</SectionLabel>
        <div role="list" className="kinbox-rows">{topRows(rows)}</div>
        {threadsOn && <p className="kinbox-note">A snoozed thread sends no push or email until it's back.</p>}
      </section>
    ) : (
      <EmptyState art="calendar" title="Nothing snoozed" size="sm"
        body={<p>Snooze an item with <Kbd>H</Kbd> and it comes back to your Inbox at the time you pick. A snoozed thread sends no push or email meanwhile.</p>} />
    );
  } else {
    body = archivedItems.length ? (
      <section className="kinbox-group" aria-label="Archived">
        <SectionLabel count={archivedItems.length}>{archived ? "Archived" : "Archived this visit"}</SectionLabel>
        <div role="list" className="kinbox-rows">{topRows(rows)}</div>
        <p className="kinbox-note">Every update stays in its task's history.</p>
      </section>
    ) : (
      <EmptyState art="folder" title="Nothing archived yet" size="sm"
        body={<p>Archive an item with <Kbd>E</Kbd> once you've dealt with it. Every update stays in its task's history.</p>} />
    );
  }

  const menuRow = menuOpenFor ? rowById.get(menuOpenFor.id) : undefined;
  return (
    <div ref={rootRef} className="kinbox">
      <style>{INBOX_CSS}</style>
      <div className="kinbox-bar">
        <div className="kinbox-wrap kinbox-bar-in">
          <div className="kseg kinbox-seg" role="group" aria-label="Show">
            {SEGMENTS.map((s) => (
              <button key={s.id} ref={s.id === "inbox" ? inboxSegRef : undefined} type="button" className="kseg-btn"
                data-active={segment === s.id} aria-pressed={segment === s.id} onClick={() => switchSegment(s.id)}>
                {s.label}
                {s.count ? <span className="kinbox-segn">{s.count}</span> : null}
              </button>
            ))}
          </div>
          <div className="kinbox-bar-end">
            {segment === "inbox" && visible.length > 0 && (confirm === "all" ? confirmRow("all") : (
              <Button ref={archiveAllRef} variant="ghost" size="sm" icon="archive" onClick={() => setConfirm("all")}>Archive all</Button>
            ))}
            {segment === "snoozed" && snoozedCount > 1 && (
              <Button variant="ghost" size="sm" icon="undo" onClick={() => unsnooze()}>Bring all back</Button>
            )}
          </div>
        </div>
        <span className="kinbox-sweep" data-play={sweep || undefined} aria-hidden="true" />
      </div>
      <div className="kinbox-wrap kinbox-list">{quietLine}{approvalsGroup}{body}</div>
      {menuOpenFor && menuRow && (
        <SnoozeMenu key={menuOpenFor.id} anchor={menuOpenFor.anchor} timeZone={zone}
          itemTitle={menuRow.a.taskTitle || "this update"} thread={!!menuRow.a.taskId && threadsOn}
          onPick={(until) => snoozeRow(menuRow, until)} onClose={closeMenu} />
      )}
      {moreMenu}
      <span className="sr-only" aria-live="polite">{cleared ? "Inbox zero" : ""}</span>
    </div>
  );
}

/* The inline reply: a small composer that grows with what you write.
   ⌘↵ / Ctrl+↵ sends, Escape puts it away. */
function ReplyComposer({ state, text, to, notifies, onChange, onSend, onCancel }: {
  state: ReplyState;
  /** the draft (kept per item, so it survives moving to another row) */
  text: string;
  to: string | null;
  /** a reply to a mention: the person who mentioned you hears about it */
  notifies?: boolean;
  onChange: (text: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange?.(el.value.length, el.value.length);   // a restored draft: carry on where you left off
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, Math.max(40, el.scrollHeight))}px`;
  }, [text]);
  const first = to && to !== "Someone" && !EMAIL_RE.test(to) ? to.split(/\s+/)[0] : null;
  const errId = `kinbox-err-${state.id}`;
  return (
    <div className="kinbox-compose">
      <textarea ref={ref} rows={1} value={text} disabled={state.sending}
        placeholder={first ? `Reply to ${first}…` : "Write a reply…"} aria-label={first ? `Reply to ${first}` : "Reply"}
        aria-invalid={state.error ? true : undefined} aria-describedby={state.error ? errId : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }} />
      <div className="kinbox-compose-foot">
        {state.error
          ? <span id={errId} className="kinbox-compose-hint" data-tone="signal" role="alert">{state.error}</span>
          : <span className="kinbox-compose-hint">{notifies && first ? `Posts a comment on the task and lets ${first} know` : "Posts a comment on the task"}</span>}
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={state.sending}>Cancel</Button>
        <Button variant="primary" size="sm" icon="send" kbd={isMac ? "⌘↵" : "Ctrl ↵"} loading={state.sending}
          disabled={!text.trim()} onClick={onSend}>Send</Button>
      </div>
    </div>
  );
}

/* Scoped styles: the Inbox's rows, bar and celebration. Tokens only, each new
   one with a fallback so the page reads right before and after the token pass. */
const INBOX_CSS = `
.kinbox { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.kinbox-wrap { box-sizing: border-box; width: 100%; max-width: var(--list-max, 1120px); margin: 0 auto; padding-left: var(--gutter, 32px); padding-right: var(--gutter, 32px); }
@media (max-width: 859px) {
  .kinbox-wrap { padding-left: var(--gutter, 16px); padding-right: var(--gutter, 16px); }
  /* phones: the page scrolls under the app's own header, so the bar scrolls with it */
  .kinbox-bar { position: relative; }
}

/* the bar */
.kinbox-bar { position: sticky; top: 0; z-index: 3; flex-shrink: 0; background: var(--bg); box-shadow: inset 0 -1px 0 var(--hairline); }
.kinbox-bar-in { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-height: var(--tabs-h, 44px); padding-top: 6px; padding-bottom: 6px; }
.kinbox-seg { flex-shrink: 0; }
.kinbox-seg .kseg-btn { gap: 6px; }
.kinbox-segn { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-4); }
.kinbox-seg .kseg-btn[data-active="true"] .kinbox-segn { color: var(--ink-3); }
.kinbox-bar-end { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-left: auto; min-width: 0; }
.kinbox-confirm { display: inline-flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 4px 8px; }
.kinbox-confirm-q { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kinbox-sweep { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; pointer-events: none; opacity: 0; transform: scaleX(0); transform-origin: 0 50%;
  background: var(--grad, linear-gradient(90deg, #5B7CFA 0%, #8B5CF6 52%, #C24BE0 100%)); }
.kinbox-sweep[data-play="true"] { animation: kinboxSweep var(--d-4, 480ms) var(--ease) forwards, kinboxSweepOut 480ms var(--ease-exit, cubic-bezier(0.4, 0, 1, 1)) 1000ms forwards; }
@keyframes kinboxSweep { from { opacity: 1; transform: scaleX(0); } to { opacity: 1; transform: scaleX(1); } }
@keyframes kinboxSweepOut { from { opacity: 1; transform: scaleX(1); } to { opacity: 0; transform: scaleX(1); } }

/* groups and rows */
.kinbox-list { padding-top: 16px; padding-bottom: 48px; }
.kinbox-group + .kinbox-group { margin-top: 24px; }
.kinbox-group > .ksection { padding: 0 2px 0 12px; }
.kinbox-group > .ksection .ksection-title { align-items: center; }
.kinbox-rows { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
.kinbox-row {
  position: relative; display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px 12px;
  border-radius: var(--r-sm, 6px); scroll-margin: 60px 0 16px;
  transition: background var(--d-1, 90ms) var(--ease);
}
.kinbox-row:hover { background: var(--fill-1); }
.kinbox-row[data-cursor="true"] { background: var(--fill-1); box-shadow: inset 2px 0 0 var(--accent); }
.kinbox-row[data-open="true"] { align-items: flex-start; }
.kinbox-row[data-open="true"] > .kinbox-av, .kinbox-row[data-open="true"] > .kinbox-side { margin-top: 6px; }
.kinbox-av {
  flex-shrink: 0; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%;
  font: 600 12px/1 var(--font-ui, var(--font-display)); color: var(--ink-2); background: var(--surface-2);
}
.kinbox-av[data-kind="icon"] { color: var(--ink-3); background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline); }
.kinbox-av > * { flex-shrink: 0; }
.kinbox-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.kinbox-main {
  display: block; width: 100%; min-width: 0; margin: 0; padding: 0; border: 0; background: none;
  text-align: left; font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent;
}
.kinbox-main::before { content: ""; position: absolute; inset: 0; border-radius: var(--r-sm, 6px); }
.kinbox-main:focus-visible { outline: none; }
.kinbox-main:focus-visible::before { outline: 2px solid var(--accent); outline-offset: -2px; }
/* the keyboard cursor (fill + accent edge) is the focused row's indicator; no second ring on top */
.kinbox-row[data-cursor="true"] .kinbox-main:focus-visible::before { outline: none; }
.kinbox-row[data-gone="true"] .kinbox-main { cursor: default; }
.kinbox-say {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere;
  font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3);
}
.kinbox-say strong { font-weight: 600; color: var(--ink-2); }
.kinbox-row[data-unread="true"] .kinbox-say { color: var(--ink-2); }
.kinbox-row[data-unread="true"] .kinbox-say strong { color: var(--ink); }
.kinbox-sub {
  display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 20px;
  font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3);
}
.kinbox-sub:empty { display: none; }
.kinbox-excerpt { color: var(--ink-2); }
.kinbox-proj { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.kinbox-mark { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--accent-text, var(--accent)); }
.kinbox-mark[data-tone="ok"] { color: var(--ok, var(--st-done)); }
.kinbox-mark[data-tone="quiet"] { color: var(--ink-3); }
.kinbox-due { position: relative; z-index: 1; display: inline-flex; flex-shrink: 0; margin: -2px 0 -2px -6px; }
/* no date yet: the chip ("Schedule") shows on the active row, or while its picker is open */
.kinbox-due[data-empty="true"] { opacity: 0; pointer-events: none; transition: opacity var(--d-1, 90ms) var(--ease); }
.kinbox-row:is(:hover, :focus-within, [data-cursor="true"]) .kinbox-due[data-empty="true"],
.kinbox-due[data-empty="true"]:has([aria-expanded="true"]) { opacity: 1; pointer-events: auto; }
.kinbox-sub .kinbox-when { margin-left: auto; }

.kinbox-side { position: relative; flex-shrink: 0; display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-height: 28px; pointer-events: none; }
@media (hover: hover) and (pointer: fine) { .kinbox-side { min-width: var(--acts-w, 0px); } }
.kinbox-stamp { display: inline-flex; align-items: center; gap: 8px; }
.kinbox-when { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-4); white-space: nowrap; }
.kinbox-row[data-unread="true"] .kinbox-when { color: var(--ink-3); }
.kinbox-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--accent); }
.kinbox-acts {
  position: absolute; top: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 2px;
  opacity: 0; transition: opacity var(--d-1, 90ms) var(--ease);
}
.kinbox-row:is(:hover, :focus-within, [data-cursor="true"]) .kinbox-acts { opacity: 1; pointer-events: auto; }
.kinbox-row:is(:hover, :focus-within, [data-cursor="true"]) .kinbox-stamp { visibility: hidden; }
.kinbox-act[aria-expanded="true"] { color: var(--accent-text, var(--accent)); background: var(--fill-2); }
@media (hover: none) {
  .kinbox-acts { position: static; opacity: 1; pointer-events: auto; }
  .kinbox-act:not([data-act="more"]):not([data-act="back"]):not([data-act="archive"]) { display: none; }
  .kinbox-row:is(:hover, :focus-within, [data-cursor="true"]) .kinbox-stamp { visibility: visible; }
}

/* bundles: a row for related items, opened to the items under it (0048) */
.kinbox-bundle { display: flex; flex-direction: column; }
.kinbox-kids { position: relative; display: flex; flex-direction: column; gap: 2px; margin: 0 0 4px 26px; padding-left: 14px; box-shadow: inset 1px 0 0 var(--hairline); }
.kinbox-row[data-child="true"] { min-height: 48px; padding-top: 6px; padding-bottom: 6px; }
.kinbox-row[data-child="true"] > .kinbox-av { width: 24px; height: 24px; }
.kinbox-row[data-child="true"] .kinbox-say { -webkit-line-clamp: 1; }
.kinbox-expand {
  position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; height: 24px; margin: -2px 0;
  padding: 0 8px 0 6px; border: 0; border-radius: var(--r-pill, 999px); background: var(--fill-1); cursor: pointer;
  font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); white-space: nowrap;
  transition: background var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease);
}
.kinbox-expand:hover { background: var(--fill-2); color: var(--ink); }
.kinbox-expand[aria-expanded="true"] { color: var(--accent-text, var(--accent)); }
.kinbox-expand:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.kinbox-expand > svg { flex-shrink: 0; }
.kinbox-emoji { font-weight: 400; }
/* dragged to Today or a day (u3's kit): the row it came from stays, quieter */
.kinbox-row[data-kdnd-dragging="true"] { opacity: 0.5; }
@media (hover: hover) and (pointer: fine) { .kinbox-row[data-kdnd-source]:not([data-gone="true"]) { touch-action: pan-y; } }

/* quiet hours: push and email wait */
.kinbox-quiet {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 0 0 16px; padding: 8px 12px; border-radius: var(--r-md, 8px);
  background: var(--fill-1); font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2);
}
.kinbox-quiet > svg { flex-shrink: 0; color: var(--icon-quiet, var(--ink-3)); }
.kinbox-quiet > span { flex: 1 1 220px; min-width: 0; }

/* the inline reply */
.kinbox-compose { position: relative; z-index: 1; display: grid; gap: 8px; margin-top: 8px; }
.kinbox-compose textarea {
  box-sizing: border-box; width: 100%; min-height: 40px; max-height: 160px; resize: none; margin: 0;
  padding: 9px 12px; border-radius: var(--r-md, 8px); border: 1px solid var(--field-border, var(--hairline-strong));
  background: var(--field-bg, var(--surface-solid)); color: var(--ink); font: 400 13px/20px var(--font-ui, var(--font-display));
}
.kinbox-compose textarea::placeholder { color: var(--ink-4); }
.kinbox-compose textarea:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.kinbox-compose-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kinbox-compose-hint { margin-right: auto; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kinbox-compose-hint[data-tone="signal"] { color: var(--signal, var(--st-blocked)); }

/* notes, hints, empty and zero states */
.kinbox-note { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 24px 0 0; padding: 0 12px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kinbox-note svg { color: var(--icon-quiet, var(--ink-4)); }
.kinbox-link {
  margin: -2px -4px; padding: 2px 4px; border: 0; border-radius: var(--r-xs, 4px); background: none; cursor: pointer;
  font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--accent-text, var(--accent));
}
.kinbox-link:hover { background: var(--fill-1); }
.kinbox-keys { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 32px; padding: 0 12px; font: 500 12px/18px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kinbox-keys > span { display: inline-flex; align-items: center; gap: 4px; }
.kinbox-keys .kkbd + .kkbd { margin-left: 2px; }
@media (hover: none), (max-width: 859px) { .kinbox-keys { display: none; } }
.kinbox .kempty { padding-top: 64px; }
.kinbox .kempty-body .kkbd { margin: 0 2px; vertical-align: 1px; }
/* loading: rows in the queue's own rhythm (the .skel shimmer stops under reduced motion) */
.kinbox-skel-label { display: block; width: 112px; height: 12px; margin: 6px 0 8px 12px; border-radius: var(--r-xs, 4px); }
.kinbox-skel { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px 12px; }
.kinbox-skel-av { flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; }
.kinbox-skel-lines { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.kinbox-skel-line { display: block; height: 10px; border-radius: var(--r-xs, 4px); }
.kinbox-skel-line[data-sub="true"] { height: 8px; opacity: 0.7; }
.kinbox-skel-when { flex-shrink: 0; width: 28px; height: 8px; border-radius: var(--r-xs, 4px); }
.kinbox-skel .skel, .kinbox-skel-label { background: var(--fill-2, var(--surface-2)); }
.kinbox-zero { display: flex; flex-direction: column; align-items: center; max-width: 440px; margin: 0 auto; padding: 72px 16px 48px; text-align: center; }
.kinbox-zero-title { display: flex; flex-direction: column; align-items: center; gap: 4px; margin: 24px 0 0; font-weight: 600; }
/* a display lede (Sora 28, 22 on phones), then Manrope for the rest */
.kinbox-zero-hero { font: 600 var(--t-display, 28px)/var(--lh-display, 36px) var(--font-head); letter-spacing: -0.02em; color: var(--ink); }
.kinbox-zero-sub { font: 600 15px/24px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kinbox-zero-body { max-width: 360px; margin: 8px 0 0; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kinbox-zero .kinbox-note { justify-content: center; margin-top: 20px; }
@media (max-width: 859px) {
  .kinbox-zero { padding-top: 48px; }
  .kinbox-zero-hero { font-size: 22px; line-height: 30px; }
}

/* menus (snooze, ⋯) */
.kinbox-menu {
  box-sizing: border-box; min-width: 216px; padding: 4px; border-radius: var(--r-lg, 12px); color: var(--ink);
  background: linear-gradient(var(--surface-raised), var(--surface-raised)), var(--surface-solid);
  box-shadow: var(--e2, var(--shadow-lg)); animation: kinboxMenuIn var(--d-2, 160ms) var(--ease);
}
.kinbox-menu[data-up="true"] { animation-name: kinboxMenuUp; }
@keyframes kinboxMenuIn { from { opacity: 0.35; translate: 0 4px; } }
@keyframes kinboxMenuUp { from { opacity: 0.35; translate: 0 -4px; } }
.kinbox-menu-label { padding: 6px 8px 4px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kinbox-mi {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; cursor: pointer; text-align: left; white-space: nowrap;
  font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2);
}
.kinbox-mi:hover, .kinbox-mi:focus-visible { background: var(--fill-1); color: var(--ink); }
.kinbox-mi:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.kinbox-mi > svg { flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); }
.kinbox-mi > span:first-of-type { flex: 1; }
.kinbox-mi .kkbd { margin-left: auto; }
.kinbox-mi-hint { margin-left: auto; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-4); }
.kinbox-msep { height: 1px; margin: 4px; background: var(--hairline); }
/* "Pick a date and time…": the menu becomes a small form */
.kinbox-menu[data-mode="custom"] { width: 280px; max-width: calc(100vw - 16px); }
.kinbox-custom { display: grid; gap: 8px; padding: 0 4px 4px; }
.kinbox-custom-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.kinbox-field { display: grid; gap: 4px; min-width: 0; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kinbox-field input {
  box-sizing: border-box; width: 100%; min-width: 0; height: 36px; padding: 0 8px; border-radius: var(--r-md, 8px);
  border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface-solid)); color: var(--ink);
  font: 500 13px/20px var(--font-ui, var(--font-display));
}
.kinbox-field input:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.kinbox-field input[aria-invalid="true"] { border-color: var(--signal, var(--st-blocked)); }
.kinbox-custom-err { margin: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--signal, var(--st-blocked)); }
.kinbox-custom-foot { display: flex; justify-content: space-between; gap: 8px; }

@media (prefers-reduced-motion: reduce) {
  .kinbox-sweep, .kinbox-menu { animation: none !important; }
  .kinbox-sweep { opacity: 0; }
}
`;

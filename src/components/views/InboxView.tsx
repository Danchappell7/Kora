/* ============================================================
   KANBO — Inbox: a triage queue you empty.
   Needs your reply · New to you · FYI, with one-key actions
   (J/K move · ↵ open · R reply · A add to Today · D schedule ·
   H snooze · E archive), an inline reply, snooze and archive,
   and Inbox zero at the end of it.
   ============================================================ */
import { Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon, EmptyArt, EmptyState, Avatar, Button, DateChip, Kbd, ProjectTile, SectionLabel } from "../primitives";
import { Popover } from "../primitives/Popover";
import { timeAgo, getProject, getMember, MEMBERS, todayISO, toLocalISO } from "../../data/data";
import type { Task, Activity, ActivityKind, IconName } from "../../data/types";
import { triage, requestSource, isRequestTask, TRIAGE_GROUPS, type TriageGroup } from "../../lib/inboxTriage";
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
  if (a.kind === "assigned" || a.kind === "mention") return a.detail?.trim() || "Someone";
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

/* ---------- snoozes (per device) ----------
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

function snoozeOptions(from: Date): { label: string; hint: string; until: number }[] {
  const later = new Date(from.getTime() + 3 * 3600000);
  const tomorrow = new Date(from); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(from); monday.setDate(monday.getDate() + (((8 - monday.getDay()) % 7) || 7)); monday.setHours(9, 0, 0, 0);
  if (monday.getTime() === tomorrow.getTime()) monday.setDate(monday.getDate() + 7); // Sunday: "next week" ≠ tomorrow
  const time = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return [
    { label: "In 3 hours", hint: time(later), until: later.getTime() },
    { label: "Tomorrow, 9am", hint: tomorrow.toLocaleDateString("en-GB", { weekday: "short" }), until: tomorrow.getTime() },
    { label: "Next week", hint: monday.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }), until: monday.getTime() },
  ];
}

// one formatter for every row (toLocaleString builds a new one per call)
const FULL_DATE = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const WAKE_TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
function fullDate(iso: string | number): string | undefined {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : FULL_DATE.format(d);
}
/** "15:42" today, "Tomorrow 09:00", else "Mon 5 Oct 09:00" */
function wakeLabel(ms: number): string {
  const d = new Date(ms), now = new Date();
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
  const t = WAKE_TIME.format(d);
  return days <= 0 ? t : days === 1 ? `Tomorrow ${t}` : `${dayLabel(toLocalISO(d))} ${t}`;
}

/* Snooze menu — portalled to <body> with fixed positioning so no card, scroll
   container or sticky ancestor can clip it; opens upward when the trigger
   sits near the bottom of the viewport. Menu-button keyboard model: focus
   lands on the first option, arrows move, Escape/Tab close and return focus
   to the trigger. */
function SnoozeMenu({ anchor, itemTitle, onPick, onClose }: {
  anchor: HTMLElement;
  itemTitle: string;
  onPick: (until: number) => void;
  onClose: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const options = useMemo(() => snoozeOptions(new Date()), []);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const mh = el.offsetHeight, mw = el.offsetWidth, gap = 6, edge = 8;
    const vh = window.innerHeight, vw = window.innerWidth;
    const below = vh - r.bottom;
    const up = below < mh + gap + edge && r.top > below;
    const top = up ? Math.max(edge, r.top - gap - mh) : Math.max(edge, Math.min(vh - edge - mh, r.bottom + gap));
    const left = Math.max(edge, Math.min(vw - edge - mw, r.right - mw));
    setPos({ top, left, up });
  }, [anchor]);

  const placed = pos !== null;
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (ref.current?.contains(t) || anchor.contains(t))) return;
      closeRef.current(false);
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      closeRef.current(false);
    };
    const onResize = () => closeRef.current(false);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [anchor]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); closeRef.current(true); }
    else if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? items.length - 1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  };

  return createPortal(
    <div ref={ref} role="menu" aria-label={`Snooze “${itemTitle}” until`} onKeyDown={onKeyDown}
      className="kinbox-menu" data-up={pos?.up || undefined}
      style={{
        position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, zIndex: 1100,
        visibility: placed ? "visible" : "hidden", transformOrigin: pos?.up ? "100% 100%" : "100% 0",
      }}>
      <div className="kinbox-menu-label" aria-hidden="true">Snooze until</div>
      {options.map((o) => (
        <button key={o.label} type="button" role="menuitem" tabIndex={-1} className="kinbox-mi" onClick={() => onPick(o.until)}>
          <span>{o.label}</span>
          <span className="kinbox-mi-hint">{o.hint}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
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

export interface InboxViewProps {
  activity: Activity[];
  tasks: Task[];
  onOpen: (id: string) => void;
  onArchive: (id: string) => void;
  /** Archive the given items — "Archive all" passes exactly what the inbox is
      currently showing (minus snoozed items). */
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
  /** guests: no Add to Today, scheduling or completing (they can still reply) */
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
}

export function InboxView({
  activity, tasks, onOpen, onArchive, onClearAll,
  currentUserId, members, onReply, onAcceptToday, onSchedule, onComplete, readOnly, archived, onUnarchive,
  loading, loadError, onRetry, onNewCount,
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
  // what you've written, per item, for this visit: moving to another row (or
  // putting the composer away) never throws a half-written reply away
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replied, setReplied] = useState<Set<string>>(() => new Set());
  const [onToday, setOnToday] = useState<Set<string>>(() => new Set());
  const [visitArchived, setVisitArchived] = useState<Activity[]>([]);
  const [sweep, setSweep] = useState(false);
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

  // persist snoozes (a woken one leaves storage once it's flagged here, so it's flagged once)
  useEffect(() => {
    try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(snz.until)); } catch { /* private mode */ }
  }, [snz.until]);

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
    if (!Number.isFinite(next)) return;
    const id = window.setTimeout(() => setTick((x) => x + 1), Math.min(MAX_TIMEOUT, next - t + 50));
    return () => window.clearTimeout(id);
  }, [snz.until, activityIds, tick]);

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
  const isSnoozed = (id: string) => (snz.until[id] ?? 0) > now;
  const visible = activity.filter((a) => !isSnoozed(a.id));
  const snoozedItems = activity.filter((a) => isSnoozed(a.id)).sort((x, y) => snz.until[x.id] - snz.until[y.id]);
  const snoozedCount = snoozedItems.length;
  const archivedItems = useMemo(() => {
    const src = archived ?? visitArchived;
    return src.filter((a) => !activityIds.has(a.id));
  }, [archived, visitArchived, activityIds]);
  // items back from a snooze lead, so the reminder actually reminds (an ended
  // snooze counts before the wake effect has moved it, so nothing jumps)
  const backAt = (id: string) => snz.woke[id] ?? (id in snz.until && snz.until[id] <= now ? snz.until[id] : 0);
  const back = visible.filter((a) => backAt(a.id)).sort((x, y) => backAt(y.id) - backAt(x.id));
  const groups = triage(visible.filter((a) => !backAt(a.id)), { me: currentUserId, tasks: taskById });
  const sections: { id: TriageGroup | "back"; label: string; items: Activity[] }[] = segment === "inbox"
    ? [{ id: "back" as const, label: "Back from snooze", items: back }, ...TRIAGE_GROUPS.map((g) => ({ id: g.id, label: g.label, items: groups[g.id] }))]
        .filter((s) => s.items.length > 0)
    : [];
  const ordered = segment === "inbox" ? sections.flatMap((s) => s.items) : segment === "snoozed" ? snoozedItems : archivedItems;
  // new on this visit and still here: the dots, and the number App shows beside them
  const newCount = visible.reduce((n, a) => (unread.has(a.id) || backAt(a.id) > 0 ? n + 1 : n), 0);
  useEffect(() => { onNewCount?.(newCount); }, [newCount, onNewCount]);
  const fyiShown = segment === "inbox" ? groups.fyi : [];

  // the snoozed/archived item vanished (filter change, realtime archive…) → drop its menus
  const menuOpenFor = menu && ordered.some((a) => a.id === menu.id) ? menu : null;
  useEffect(() => { if (menu && !menuOpenFor) setMenu(null); }, [menu, menuOpenFor]);
  const moreOpenFor = more && ordered.some((a) => a.id === more) ? more : null;
  useEffect(() => { if (more && !moreOpenFor) setMore(null); }, [more, moreOpenFor]);
  const confirmCount = confirm === "fyi" ? fyiShown.length : visible.length;
  useEffect(() => { if (confirm && (segment !== "inbox" || confirmCount === 0)) setConfirm(null); }, [confirm, segment, confirmCount]);
  const cursorOn = cursor && ordered.some((a) => a.id === cursor) ? cursor : null;
  const replyOn = reply && ordered.some((a) => a.id === reply.id) ? reply : null;

  /* Inbox zero. Only a feed that has loaded can be empty: while it loads (or
     if it failed) there's no zero state and no sweep. The gradient sweeps the
     bar once a day, and only when you empty the Inbox on this visit, so a
     page that opens on an empty (or not yet loaded) feed never uses it up.
     Never under reduced motion. */
  const settled = !loading && !loadError;
  const zero = segment === "inbox" && settled && visible.length === 0;
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
    const i = ordered.findIndex((a) => a.id === id);
    return i < 0 ? null : (ordered[i + 1] ?? ordered[i - 1])?.id ?? null;
  };
  // acted on (opened/archived): no longer new, no longer back from snooze.
  // Only ever called with shown ids, so any stored snooze for them has ended.
  const forget = (ids: string[]) => {
    setUnread((s) => withoutIds(s, ids));
    setSnz((s) => {
      const woke = omit(s.woke, ids), until = omit(s.until, ids);
      return woke === s.woke && until === s.until ? s : { until, woke };
    });
  };
  const openItem = (a: Activity) => {
    if (!a.taskId || !taskById.has(a.taskId)) return;
    forget([a.id]);
    onOpen(a.taskId);
  };
  const noteArchived = (items: Activity[]) => {
    if (archived || !items.length) return;
    setVisitArchived((xs) => [...items, ...xs.filter((x) => !items.some((i) => i.id === x.id))]);
  };
  const archiveItem = (id: string) => {
    focusNextRef.current = neighbourOf(id);
    if (reply?.id === id) setReply(null);
    noteArchived(activity.filter((a) => a.id === id));
    forget([id]);
    onArchive(id);
  };
  const snoozeItem = (id: string, until: number) => {
    focusNextRef.current = neighbourOf(id);
    setMenu(null);
    if (reply?.id === id) setReply(null);
    setUnread((s) => withoutIds(s, [id]));
    // self-pruning drops only stale entries: ended snoozes for other inboxes wait their turn
    setSnz((s) => ({ until: { ...withoutStale(s.until), [id]: until }, woke: omit(s.woke, [id]) }));
  };
  const closeMenu = (refocus: boolean) => {
    const m = menu;
    setMenu(null);
    if (refocus) m?.anchor.focus();
  };
  // only the snoozes counted in "{n} snoozed" (this inbox), which come back at the top
  const unsnooze = (only?: string[]) => setSnz((s) => {
    const t = Date.now();
    const ids = (only ?? activity.map((a) => a.id)).filter((id) => (s.until[id] ?? 0) > t);
    if (!ids.length) return s;
    return { until: omit(s.until, ids), woke: { ...s.woke, ...Object.fromEntries(ids.map((id) => [id, t])) } };
  });
  const bringBack = (id: string) => {
    focusNextRef.current = neighbourOf(id);
    unsnooze([id]);
    toast?.toast("Back in your Inbox");
  };
  const cancelConfirm = () => { restoreConfirmFocus.current = confirm; setConfirm(null); };
  const archiveShown = () => {
    const items = confirm === "fyi" ? fyiShown : visible;
    const ids = items.map((a) => a.id);
    restoreConfirmFocus.current = confirm;
    setConfirm(null);
    if (!ids.length) return;
    if (reply && ids.includes(reply.id)) setReply(null);
    noteArchived(items);
    forget(ids);
    onClearAll(ids);
  };
  const moveBack = (id: string) => {
    if (!onUnarchive) return;
    focusNextRef.current = neighbourOf(id);
    onUnarchive([id]);
    setVisitArchived((xs) => xs.filter((x) => x.id !== id));
  };

  const taskOf = (a: Activity) => (a.taskId ? taskById.get(a.taskId) : undefined);
  const canReply = (a: Activity) => !!onReply && !!taskOf(a);
  const isOnToday = (t: Task) => !!t.planToday || onToday.has(t.id);
  const canToday = (a: Activity) => { const t = taskOf(a); return !!onAcceptToday && !readOnly && !!t && t.status !== "done" && !isOnToday(t); };
  const canSchedule = (a: Activity) => { const t = taskOf(a); return !!onSchedule && !readOnly && !!t && t.status !== "done"; };
  const canComplete = (a: Activity) => { const t = taskOf(a); return !!onComplete && !readOnly && !!t && t.status !== "done"; };

  const startReply = (a: Activity) => {
    if (!canReply(a)) return;
    setCursor(a.id);
    setReply((r) => (r?.id === a.id ? r : { id: a.id, sending: false }));
  };
  const cancelReply = (refocus = true) => {
    const id = reply?.id;
    setReply(null);
    if (refocus && id) window.setTimeout(() => rowRefs.current.get(id)?.focus({ preventScroll: true }), 0);
  };
  const sendReply = async () => {
    const r = reply;
    const a = r && activity.find((x) => x.id === r.id);
    const t = a && taskOf(a);
    const body = r ? (drafts[r.id] ?? "").trim() : "";
    if (!r || !a || !t || !body || !onReply || r.sending) return;
    // a reply to a mention goes back to whoever mentioned you; anything else is a plain comment
    const mentionId = a.kind === "mention" ? memberIdByName(actorOf(a) ?? "", members) : null;
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
    forget([r.id]);
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
  const schedule = (a: Activity) => {
    if (!canSchedule(a)) return;
    rowEls.current.get(a.id)?.querySelector<HTMLButtonElement>(".kinbox-due button.kdate")?.click();
  };
  // H: the menu hangs off the row's Snooze button, or (touch screens, where
  // only ⋯ and Archive show) off ⋯, or the row itself
  const openSnooze = (a: Activity) => {
    const shown = (el: HTMLElement | null | undefined): el is HTMLElement =>
      !!el && el.isConnected && window.getComputedStyle(el).display !== "none";
    const anchor = [snoozeRefs.current.get(a.id), moreRefs.current.get(a.id), rowEls.current.get(a.id)].find(shown);
    if (anchor) setMenu({ id: a.id, anchor });
  };

  /* ---------- keyboard: J/K move · ↵ open · R · A · D · H · E ---------- */
  const moveCursor = (dir: 1 | -1) => {
    if (!ordered.length) return;
    const i = cursorOn ? ordered.findIndex((a) => a.id === cursorOn) : -1;
    const next = ordered[i < 0 ? (dir > 0 ? 0 : ordered.length - 1) : Math.max(0, Math.min(ordered.length - 1, i + dir))];
    setCursor(next.id);
    const el = rowRefs.current.get(next.id);
    el?.focus({ preventScroll: true });
    // instant: a smooth scroll still running would close a menu opened next (H)
    rowEls.current.get(next.id)?.scrollIntoView?.({ block: "nearest", behavior: "instant" as ScrollBehavior });
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
    const a = cursorOn ? ordered.find((x) => x.id === cursorOn) : undefined;
    if (!a) return;
    const onButton = !!target?.closest?.("button, a, [role='menuitem']");
    if (k === "Enter") { if (!onButton) { e.preventDefault(); openItem(a); } return; }
    if (e.repeat) return;
    if (segment === "inbox") {
      if (k === "r" && canReply(a)) { e.preventDefault(); startReply(a); return; }
      if (k === "a" && onAcceptToday && !readOnly) { e.preventDefault(); acceptToday(a); return; }
      if (k === "d" && canSchedule(a)) { e.preventDefault(); schedule(a); return; }
      if (k === "h") { e.preventDefault(); openSnooze(a); return; }
      if (k === "e") { e.preventDefault(); archiveItem(a.id); return; }
    } else if (segment === "snoozed") {
      if (k === "h") { e.preventDefault(); bringBack(a.id); return; }
      if (k === "e") { e.preventDefault(); archiveItem(a.id); return; }
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* ---------- rows ---------- */
  const actsFor = (a: Activity, title: string): RowAct[] => {
    if (segment === "snoozed") return [
      { act: "back", icon: "undo", label: `Bring back “${title}”`, tip: "Bring back now", kbd: "H", run: () => bringBack(a.id) },
      { act: "archive", icon: "archive", label: `Archive “${title}”`, tip: "Archive", kbd: "E", run: () => archiveItem(a.id) },
    ];
    if (segment === "archived") return onUnarchive
      ? [{ act: "back", icon: "undo", label: `Move “${title}” back to Inbox`, tip: "Move back to Inbox", run: () => moveBack(a.id) }]
      : [];
    const acts: RowAct[] = [];
    if (canReply(a)) acts.push({ act: "reply", icon: "message", label: `Reply to “${title}”`, tip: "Reply", kbd: "R", run: () => startReply(a), pressed: replyOn?.id === a.id });
    if (canToday(a)) acts.push({ act: "today", icon: "sun", label: `Add “${title}” to Today`, tip: "Add to Today", kbd: "A", run: () => acceptToday(a) });
    if (canSchedule(a)) acts.push({ act: "schedule", icon: "calendar", label: `Schedule “${title}”`, tip: "Schedule", kbd: "D", run: () => schedule(a) });
    acts.push({ act: "snooze", icon: "clock", label: `Snooze “${title}”`, tip: "Snooze", kbd: "H", menu: true,
      run: (el) => { if (menuOpenFor?.id === a.id) setMenu(null); else setMenu({ id: a.id, anchor: el }); } });
    acts.push({ act: "archive", icon: "archive", label: `Archive “${title}”`, tip: "Archive", kbd: "E", run: () => archiveItem(a.id) });
    acts.push({ act: "more", icon: "more", label: `More actions for “${title}”`, tip: "More", menu: true,
      run: (el) => { moreAnchor.current = el; setMore((m) => (m === a.id ? null : a.id)); } });
    return acts;
  };

  const renderRow = (a: Activity) => {
    const task = taskOf(a);
    const proj = task ? getProject(task.projectId) : undefined;
    const via = viaRequest(a, task);
    const actor = via ? null : actorOf(a);
    const meta = KIND_META[a.kind] ?? KIND_META.status;
    const isUnread = unread.has(a.id) || backAt(a.id) > 0;
    const title = a.taskTitle || "a task";
    const isCursor = cursorOn === a.id;
    const composing = replyOn?.id === a.id ? replyOn : null;
    const acts = actsFor(a, title);
    const snoozedUntil = segment === "snoozed" ? snz.until[a.id] : undefined;
    const excerpt = !actor && !via && a.detail && (a.kind === "comment" || a.kind === "status")
      ? (a.kind === "comment" ? `“${a.detail}”` : a.detail) : null;
    // the row's description: where it's from, its marks, its date (when it has
    // one) and its age; never the empty "Schedule" chip
    const subId = `kinbox-sub-${a.id}`;
    const draft = segment === "inbox" && !composing && !!drafts[a.id]?.trim();
    const onTodayMark = !!task && segment === "inbox" && isOnToday(task) && task.status !== "done";
    const ctx = via
      ? <span id={`${subId}-ctx`} className="truncate">via {via}</span>
      : excerpt
        ? <span id={`${subId}-ctx`} className="kinbox-excerpt truncate">{excerpt}</span>
        : proj
          ? <span id={`${subId}-ctx`} className="kinbox-proj"><ProjectTile project={proj} size={16} /><span className="truncate">{proj.name}</span></span>
          : null;
    const describedBy = [
      ctx && `${subId}-ctx`,
      replied.has(a.id) && `${subId}-replied`,
      draft && `${subId}-draft`,
      onTodayMark && `${subId}-today`,
      task?.dueDate && segment === "inbox" && `${subId}-due`,
      `${subId}-when`,
    ].filter(Boolean).join(" ");
    const when = snoozedUntil
      ? <time id={`${subId}-when`} dateTime={new Date(snoozedUntil).toISOString()} title={fullDate(snoozedUntil)} className="kinbox-when">Back {wakeLabel(snoozedUntil)}</time>
      : <time id={`${subId}-when`} dateTime={a.createdAt} title={fullDate(a.createdAt)} className="kinbox-when">{timeAgo(a.createdAt)}</time>;
    const due = task && segment === "inbox" && (task.dueDate || canSchedule(a)) ? (
      // one Tab stop per row: the chip joins the tab order on the cursor row
      // only, like the row's actions (D reaches it from anywhere)
      <span className="kinbox-due" id={`${subId}-due`} data-empty={!task.dueDate || undefined}
        ref={(el) => { const b = el?.querySelector<HTMLButtonElement>("button.kdate"); if (b) b.tabIndex = isCursor ? 0 : -1; }}>
        <DateChip value={task.dueDate} time={task.dueTime} label={`Due date for “${title}”`} status={task.status} placeholder="Schedule"
          readOnly={!canSchedule(a)}
          onChange={(d) => {
            if (!onSchedule) return;
            // the picker's "No date": the Inbox only ever sets dates; clearing one is the task's business
            if (!d) { if (task.dueDate) toast?.action("To remove a due date, open the task", "Open", () => openItem(a)); return; }
            if (d === task.dueDate) return;
            onSchedule(task.id, d);
            toast?.success(`Scheduled for ${dayLabel(d)}`);
          }} />
      </span>
    ) : null;
    const marks = (
      <>
        {replied.has(a.id) && <span id={`${subId}-replied`} className="kinbox-mark" data-tone="ok"><Icon name="check" size={12} sw={2} /> Replied</span>}
        {draft && <span id={`${subId}-draft`} className="kinbox-mark" data-tone="quiet"><Icon name="notes" size={12} sw={2} /> Draft</span>}
        {onTodayMark && <span id={`${subId}-today`} className="kinbox-mark"><Icon name="sun" size={12} sw={2} /> On Today</span>}
      </>
    );
    const style = { "--acts-w": `${Math.max(64, acts.length * 30)}px` } as CSSProperties;
    return (
      <div key={a.id} role="listitem" className="kinbox-row" data-unread={isUnread || undefined} data-cursor={isCursor || undefined}
        data-open={composing ? true : undefined} data-gone={task ? undefined : true} style={style}
        ref={(el) => { if (el) rowEls.current.set(a.id, el); else rowEls.current.delete(a.id); }}
        onFocus={() => { if (cursorOn !== a.id) setCursor(a.id); }}>
        <ActorMark actor={actor} kind={a.kind} request={!!via} members={members} />
        <div className="kinbox-body">
          <button type="button" className="kinbox-main" aria-describedby={describedBy}
            ref={(el) => { if (el) rowRefs.current.set(a.id, el); else rowRefs.current.delete(a.id); }}
            onClick={() => openItem(a)} aria-disabled={task ? undefined : true}
            title={task ? undefined : "This task has been archived or is no longer available"}>
            {isUnread && <span className="sr-only">Unread: </span>}
            {/* two lines before clipping, so "who did what" survives a phone-width row */}
            <span className="kinbox-say">
              {via
                ? <>New request: <strong>{title}</strong></>
                : actor
                  ? <><strong>{actor}</strong> {ACTOR_VERB[a.kind]} <strong>{title}</strong></>
                  : <>You {meta.verb} <strong>{title}</strong></>}
            </span>
          </button>
          <div className="kinbox-sub">
            {ctx}
            {marks}
            {due}
            {narrow && when}
          </div>
          {composing && (
            <ReplyComposer state={composing} text={drafts[a.id] ?? ""} to={actor} notifies={a.kind === "mention"}
              onChange={(text) => {
                setDrafts((d) => ({ ...d, [a.id]: text }));
                setReply((r) => (r && r.id === a.id && r.error ? { ...r, error: undefined } : r));
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
                  aria-expanded={x.act === "snooze" ? menuOpenFor?.id === a.id : x.act === "more" ? moreOpenFor === a.id : undefined}
                  aria-pressed={x.act === "reply" ? !!x.pressed : undefined}
                  tabIndex={isCursor ? 0 : -1}
                  ref={x.act === "snooze" ? (el) => { if (el) snoozeRefs.current.set(a.id, el); else snoozeRefs.current.delete(a.id); }
                    : x.act === "more" ? (el) => { if (el) moreRefs.current.set(a.id, el); else moreRefs.current.delete(a.id); } : undefined}
                  onClick={(e) => x.run(e.currentTarget)}>
                  <Icon name={x.icon} size={16} sw={1.75} />
                </button>
              ))}
            </span>
          )}
        </div>
      </div>
    );
  };

  const moreItem = moreOpenFor ? ordered.find((a) => a.id === moreOpenFor) : undefined;
  const moreMenu = moreItem && (() => {
    const a = moreItem, title = a.taskTitle || "a task", task = taskOf(a);
    const run = (fn: () => void) => () => { setMore(null); fn(); };
    const items: { key: string; icon: IconName; label: string; kbd?: string; fn: () => void }[] = [];
    if (task) items.push({ key: "open", icon: "arrowUpRight", label: "Open task", kbd: "↵", fn: () => openItem(a) });
    if (canReply(a)) items.push({ key: "reply", icon: "message", label: "Reply", kbd: "R", fn: () => startReply(a) });
    if (canToday(a)) items.push({ key: "today", icon: "sun", label: "Add to Today", kbd: "A", fn: () => acceptToday(a) });
    if (canSchedule(a)) items.push({ key: "schedule", icon: "calendar", label: "Schedule…", kbd: "D", fn: () => schedule(a) });
    items.push({ key: "snooze", icon: "clock", label: "Snooze…", kbd: "H", fn: () => { const el = moreRefs.current.get(a.id); if (el) setMenu({ id: a.id, anchor: el }); } });
    if (canComplete(a) && task) items.push({ key: "done", icon: "check", label: "Mark task done", fn: () => onComplete?.(task.id) });
    items.push({ key: "archive", icon: "archive", label: "Archive", kbd: "E", fn: () => archiveItem(a.id) });
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

  const keysHint = !narrow && segment === "inbox" && ordered.length > 0 && (
    <div className="kinbox-keys" aria-hidden="true">
      <span><Kbd>J</Kbd><Kbd>K</Kbd> move</span>
      <span><Kbd>↵</Kbd> open</span>
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
        {sections.map((s) => (
          <section key={s.id} className="kinbox-group" aria-label={s.label}>
            <SectionLabel count={s.items.length}
              action={s.id === "fyi" && s.items.length > 1
                ? (confirm === "fyi" ? confirmRow("fyi")
                  : <Button ref={archiveFyiRef} variant="ghost" size="sm" aria-label="Archive FYI items" onClick={() => setConfirm("fyi")}>Archive FYI</Button>)
                : undefined}>
              {s.id === "back" && <Icon name="clock" size={12} sw={2} />}{s.label}
            </SectionLabel>
            <div role="list" className={"kinbox-rows " + entrance}>{s.items.map(renderRow)}</div>
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
        <div role="list" className="kinbox-rows">{snoozedItems.map(renderRow)}</div>
      </section>
    ) : (
      <EmptyState art="calendar" title="Nothing snoozed" size="sm"
        body={<p>Snooze an item with <Kbd>H</Kbd> and it comes back to your Inbox at the time you pick.</p>} />
    );
  } else {
    body = archivedItems.length ? (
      <section className="kinbox-group" aria-label="Archived">
        <SectionLabel count={archivedItems.length}>{archived ? "Archived" : "Archived this visit"}</SectionLabel>
        <div role="list" className="kinbox-rows">{archivedItems.map(renderRow)}</div>
        <p className="kinbox-note">Every update stays in its task's history.</p>
      </section>
    ) : (
      <EmptyState art="folder" title="Nothing archived yet" size="sm"
        body={<p>Archive an item with <Kbd>E</Kbd> once you've dealt with it. Every update stays in its task's history.</p>} />
    );
  }

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
      <div className="kinbox-wrap kinbox-list">{body}</div>
      {menuOpenFor && (
        <SnoozeMenu key={menuOpenFor.id} anchor={menuOpenFor.anchor}
          itemTitle={activity.find((a) => a.id === menuOpenFor.id)?.taskTitle || "this update"}
          onPick={(until) => snoozeItem(menuOpenFor.id, until)} onClose={closeMenu} />
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

@media (prefers-reduced-motion: reduce) {
  .kinbox-sweep, .kinbox-menu { animation: none !important; }
  .kinbox-sweep { opacity: 0; }
}
`;

/* ============================================================
   KANBO — Inbox: the activity feed (assignments, mentions,
   comments, updates) with filters, snooze and archive
   ============================================================ */
import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon, EmptyArt } from "../primitives";
import { timeAgo, getProject, MEMBERS } from "../../data/data";
import type { Task, Activity, ActivityKind, IconName } from "../../data/types";
import { useEntrance } from "../../hooks/useEntrance";
import { useMediaQuery } from "../../hooks/useMediaQuery";

const KIND_META: Record<ActivityKind, { icon: IconName; color: string; verb: string }> = {
  created:   { icon: "plus",    color: "var(--accent)",     verb: "created" },
  status:    { icon: "refresh", color: "var(--st-progress)", verb: "updated" },
  completed: { icon: "check",   color: "var(--st-done)",    verb: "completed" },
  reopened:  { icon: "refresh", color: "var(--st-review)",  verb: "reopened" },
  comment:   { icon: "message", color: "var(--accent)",     verb: "commented on" },
  deleted:   { icon: "trash",   color: "var(--st-blocked)", verb: "deleted" },
  assigned:  { icon: "user",    color: "var(--accent)",     verb: "assigned you" },
  mention:   { icon: "message", color: "var(--accent)",     verb: "mentioned you in" },
};

const INBOX_FILTERS: { v: string; label: string; kinds?: ActivityKind[]; noun: [string, string]; empty: string }[] = [
  { v: "all", label: "All", noun: ["update", "updates"], empty: "You're all caught up — everything else is snoozed." },
  { v: "assigned", label: "Assigned", kinds: ["assigned"], noun: ["assignment", "assignments"], empty: "No new assignments." },
  { v: "mention", label: "Mentions", kinds: ["mention"], noun: ["mention", "mentions"], empty: "No mentions." },
  { v: "comment", label: "Comments", kinds: ["comment"], noun: ["comment", "comments"], empty: "No comments." },
  { v: "updates", label: "Updates", kinds: ["created", "status", "completed", "reopened", "deleted"], noun: ["update", "updates"], empty: "No task updates." },
];

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

// neutral wash (hover, tracks, chips) that stays visible on white porcelain
// cards — --surface-2 is itself white there
const FILL_1 = "var(--fill-1, color-mix(in oklch, var(--ink) 6%, transparent))";
const isFocusVisible = (el: Element) => { try { return el.matches(":focus-visible"); } catch { return false; } };

/* ---------- snoozes (per device) ----------
   Storage holds id → wake time for every account and workspace used in this
   browser, but the inbox only ever sees the current workspace's activity, so
   everything here touches only ids that are in `activity`. A snooze that has
   ended stays stored until its item turns up in an inbox (it may belong to
   another workspace), and is then flagged "Back from snooze" once. Ones that
   ended more than WAKE_WINDOW ago are stale: dropped, never flagged. */
const SNOOZE_KEY = "kanbo-inbox-snooze";
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
function fullDate(iso: string): string | undefined {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : FULL_DATE.format(d);
}

/* Snooze menu — portalled to <body> with fixed positioning so no card, scroll
   container or backdrop-filter ancestor can clip it; opens upward when the
   trigger sits near the bottom of the viewport. Menu-button keyboard model:
   focus lands on the first option, arrows move, Escape/Tab close and return
   focus to the trigger. */
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
      className="glass anim-scalein"
      style={{
        position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, zIndex: 60,
        visibility: placed ? "visible" : "hidden", transformOrigin: pos?.up ? "100% 100%" : "100% 0",
        padding: 5, borderRadius: 12, background: "var(--surface-solid)", border: "1px solid var(--hairline)",
        boxShadow: "var(--shadow-lg)", minWidth: 208,
      }}>
      <div className="kicker" aria-hidden="true" style={{ padding: "6px 11px 4px" }}>Snooze until</div>
      {options.map((o) => (
        <button key={o.label} type="button" role="menuitem" tabIndex={-1} onClick={() => onPick(o.until)}
          onMouseEnter={(e) => (e.currentTarget.style.background = FILL_1)}
          onMouseLeave={(e) => { if (!isFocusVisible(e.currentTarget)) e.currentTarget.style.background = "transparent"; }}
          onFocus={(e) => { if (isFocusVisible(e.currentTarget)) e.currentTarget.style.background = FILL_1; }}
          onBlur={(e) => (e.currentTarget.style.background = "transparent")}
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, width: "100%", textAlign: "left", padding: "8px 11px", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13, color: "var(--ink-2)" }}>
          <span>{o.label}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>{o.hint}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function InboxView({ activity, tasks, onOpen, onArchive, onClearAll }: {
  activity: Activity[];
  tasks: Task[];
  onOpen: (id: string) => void;
  onArchive: (id: string) => void;
  /** Archive the given items — "Archive all" passes exactly what the inbox is
      currently showing (the active filter, minus snoozed items). */
  onClearAll: (ids?: string[]) => void;
}) {
  const entrance = useEntrance();
  const narrow = useMediaQuery("(max-width: 560px)");
  const [filter, setFilter] = useState("all");
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [snz, setSnz] = useState<SnoozeState>(initialSnoozes);
  const [tick, setTick] = useState(0);
  const [confirmArchive, setConfirmArchive] = useState(false);
  // Unread snapshot: App marks everything read the moment the inbox opens, so
  // capture what was unread on arrival (and anything that lands while it's
  // open) to keep the dots for this visit.
  const [unread, setUnread] = useState<Set<string>>(() => new Set(activity.filter((a) => !a.readAt).map((a) => a.id)));
  const knownRef = useRef<Set<string> | null>(null);
  if (knownRef.current === null) knownRef.current = new Set(activity.map((a) => a.id));
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusNextRef = useRef<string | null>(null);
  const archiveAllRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreArchiveFocus = useRef(false);
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
    if (confirmArchive) confirmRef.current?.focus();
    else if (restoreArchiveFocus.current) { restoreArchiveFocus.current = false; archiveAllRef.current?.focus(); }
  }, [confirmArchive]);

  const now = Date.now();
  const activeFilter = INBOX_FILTERS.find((f) => f.v === filter) || INBOX_FILTERS[0];
  const matches = (f: (typeof INBOX_FILTERS)[number], a: Activity) => !f.kinds || f.kinds.includes(a.kind);
  const visible = activity.filter((a) => !((snz.until[a.id] ?? 0) > now));
  const shown = visible.filter((a) => matches(activeFilter, a));
  const snoozedCount = activity.length - visible.length;
  const snoozedHere = activeFilter.kinds ? activity.filter((a) => (snz.until[a.id] ?? 0) > now && matches(activeFilter, a)).length : snoozedCount;
  // group by recency so the feed reads as "what just happened" vs "earlier";
  // items back from a snooze lead, so the reminder actually reminds (an ended
  // snooze counts before the wake effect has moved it, so nothing jumps)
  const backAt = (id: string) => snz.woke[id] ?? (id in snz.until && snz.until[id] <= now ? snz.until[id] : 0);
  const back = shown.filter((a) => backAt(a.id)).sort((x, y) => backAt(y.id) - backAt(x.id));
  const rest = shown.filter((a) => !backAt(a.id));
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const weekAgo = now - 7 * 86400000;
  const today = rest.filter((a) => new Date(a.createdAt).getTime() >= startOfToday.getTime());
  const earlier = rest.filter((a) => { const t = new Date(a.createdAt).getTime(); return t < startOfToday.getTime() && t >= weekAgo; });
  const grouped = new Set([...today, ...earlier]);
  const buckets: { label: string; items: Activity[] }[] = [
    { label: "Back from snooze", items: back },
    { label: "Today", items: today },
    { label: "Earlier this week", items: earlier },
    // catch-all: anything older — and anything with an unparseable date, so no item is ever dropped
    { label: "Older", items: rest.filter((a) => !grouped.has(a)) },
  ].filter((b) => b.items.length > 0);
  const ordered = buckets.flatMap((b) => b.items);

  // the snoozed/archived item vanished (filter change, realtime archive…) → drop its menu
  const menuOpenFor = menu && ordered.some((a) => a.id === menu.id) ? menu : null;
  useEffect(() => { if (menu && !menuOpenFor) setMenu(null); }, [menu, menuOpenFor]);
  useEffect(() => { if (confirmArchive && shown.length === 0) setConfirmArchive(false); }, [confirmArchive, shown.length]);

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
  const archiveItem = (id: string) => {
    focusNextRef.current = neighbourOf(id);
    forget([id]);
    onArchive(id);
  };
  const snoozeItem = (id: string, until: number) => {
    focusNextRef.current = neighbourOf(id);
    setMenu(null);
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
  const unsnoozeAll = () => setSnz((s) => {
    const t = Date.now();
    const ids = activity.filter((a) => (s.until[a.id] ?? 0) > t).map((a) => a.id);
    if (!ids.length) return s;
    return { until: omit(s.until, ids), woke: { ...s.woke, ...Object.fromEntries(ids.map((id) => [id, t])) } };
  });
  const cancelArchiveAll = () => { restoreArchiveFocus.current = true; setConfirmArchive(false); };
  const archiveShown = () => {
    const ids = shown.map((a) => a.id);
    restoreArchiveFocus.current = true;
    setConfirmArchive(false);
    if (!ids.length) return;
    forget(ids);
    onClearAll(ids);
  };

  if (activity.length === 0) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 420 }}>
          <div style={{ marginBottom: 14 }}><EmptyArt kind="inbox" /></div>
          <p style={{ fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>You're all caught up</p>
          <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>Activity on your tasks — creates, completions, comments — shows up here. Archived items stay in your history.</p>
        </div>
      </div>
    );
  }
  const [one, many] = activeFilter.noun;
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", maxWidth: 760, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <div role="group" aria-label="Filter inbox" style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 9, background: "var(--surface)", border: "1px solid var(--hairline)", maxWidth: "100%", overflowX: "auto", scrollbarWidth: "none" }}>
          {INBOX_FILTERS.map((f) => {
            const n = f.kinds ? visible.filter((a) => matches(f, a)).length : visible.length;
            return (
              <button key={f.v} type="button" aria-pressed={filter === f.v} onClick={() => { setFilter(f.v); setConfirmArchive(false); }} style={{ padding: "5px 11px", borderRadius: 7, border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", background: filter === f.v ? "var(--accent)" : "transparent", color: filter === f.v ? "var(--on-accent)" : "var(--ink-3)" }}>{f.label}{f.v !== "all" && n > 0 ? ` ${n}` : ""}</button>
            );
          })}
        </div>
        {confirmArchive ? (
          <div role="group" aria-label="Confirm archive" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancelArchiveAll(); } }}
            style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
              Archive {shown.length} {shown.length === 1 ? one : many}?{snoozedHere === 1 ? ` The snoozed ${one} stays.` : snoozedHere > 1 ? ` Snoozed ${many} stay.` : ""}
            </span>
            <button type="button" className="btn btn-ghost" onClick={cancelArchiveAll} style={{ fontSize: 13, padding: "7px 12px" }}>Cancel</button>
            <button ref={confirmRef} type="button" className="btn btn-accent" onClick={archiveShown} style={{ fontSize: 13, padding: "7px 12px" }}>
              <Icon name="archive" size={14} /> Archive
            </button>
          </div>
        ) : (
          <button ref={archiveAllRef} type="button" className="btn btn-ghost" onClick={() => setConfirmArchive(true)} disabled={shown.length === 0}
            style={{ marginLeft: "auto", fontSize: 13, opacity: shown.length === 0 ? 0.5 : 1, cursor: shown.length === 0 ? "default" : "pointer" }}>
            <Icon name="archive" size={15} /> Archive all
          </button>
        )}
      </div>
      {snoozedCount > 0 && (
        <div style={{ fontSize: 12, color: "var(--ink-4)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Icon name="clock" size={13} /> {snoozedCount} snoozed · they'll come back here when their time is up
          <button type="button" onClick={unsnoozeAll} style={{ border: "none", background: "transparent", padding: "2px 4px", borderRadius: 6, cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>Bring back now</button>
        </div>
      )}
      {shown.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 24px", color: "var(--ink-4)", fontSize: 13 }}>{activeFilter.empty}</div>
      ) : buckets.map((bucket) => (
      <section key={bucket.label} aria-label={bucket.label} style={{ marginBottom: 16 }}>
        <div className="kicker" style={{ marginBottom: 8, paddingLeft: 2, display: "flex", alignItems: "center", gap: 6 }}>
          {bucket.label === "Back from snooze" && <Icon name="clock" size={12} />}{bucket.label}
        </div>
        {/* no overflow:hidden here — it clipped the snooze menu; the first and
            last rows carry the card's rounding instead (16px card − 1px border) */}
        <div className={"glass " + entrance} style={{ borderRadius: 16 }}>
        {bucket.items.map((a, i) => {
          const meta = KIND_META[a.kind] ?? KIND_META.status;
          const task = a.taskId ? taskById.get(a.taskId) : undefined;
          const proj = task ? getProject(task.projectId) : undefined;
          const actor = actorOf(a);
          const isUnread = unread.has(a.id) || backAt(a.id) > 0;
          const title = a.taskTitle || "a task";
          const first = i === 0, last = i === bucket.items.length - 1;
          const rTop = first ? 15 : 0, rBottom = last ? 15 : 0;
          const sub = actor
            ? proj && <><span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 2, background: proj.color, flexShrink: 0 }} /><span className="truncate">{proj.name}</span></>
            : a.detail && <span className="truncate">{a.kind === "comment" ? `“${a.detail}”` : a.detail}</span>;
          // phones: the time joins the subtitle so the sentence gets the width
          const when = <time dateTime={a.createdAt} title={fullDate(a.createdAt)} className="mono" style={{ fontSize: 11, color: isUnread ? "var(--ink-3)" : "var(--ink-4)", flexShrink: 0 }}>{timeAgo(a.createdAt)}</time>;
          return (
            <div key={a.id} className="kinbox-row" style={{
              position: "relative", display: "flex", alignItems: "center", gap: 13, width: "100%", padding: "13px 18px",
              borderTop: i ? "1px solid var(--hairline)" : "none", borderRadius: `${rTop}px ${rTop}px ${rBottom}px ${rBottom}px`,
              transition: "background .14s",
            }}
              onMouseEnter={(e) => (e.currentTarget.style.background = FILL_1)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              {isUnread && (
                <span aria-hidden="true" style={{ position: "absolute", left: 6, top: "50%", width: 7, height: 7, marginTop: -3.5, borderRadius: 99, background: "var(--accent)", boxShadow: "0 0 0 3px color-mix(in oklch, var(--accent) 16%, transparent)" }} />
              )}
              <span style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 99, flexShrink: 0, background: `color-mix(in oklch, ${meta.color} 14%, transparent)`, color: meta.color }}>
                <Icon name={meta.icon} size={15} />
              </span>
              <button type="button" ref={(el) => { if (el) rowRefs.current.set(a.id, el); else rowRefs.current.delete(a.id); }}
                onClick={() => openItem(a)} aria-disabled={task ? undefined : true}
                title={task ? undefined : "This task has been archived or is no longer available"}
                style={{
                  flex: 1, minWidth: 0, display: "block", textAlign: "left", border: "none", background: "transparent",
                  padding: 0, cursor: task ? "pointer" : "default", fontFamily: "var(--font-display)", borderRadius: 6,
                }}>
                {isUnread && <span className="sr-only">Unread: </span>}
                {/* two lines before clipping, so "who did what" survives a phone-width row */}
                <span style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere", lineHeight: 1.4, fontSize: 13.5, color: isUnread ? "var(--ink)" : "var(--ink-2)", fontWeight: isUnread ? 600 : 400 }}>
                  {actor
                    ? <><strong style={{ color: "var(--ink)" }}>{actor}</strong> {ACTOR_VERB[a.kind]} <strong style={{ color: "var(--ink)" }}>{title}</strong></>
                    : <>You {meta.verb} <strong style={{ color: "var(--ink)" }}>{title}</strong></>}
                </span>
                {(sub || narrow) && (
                  <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 12, color: "var(--ink-4)", marginTop: 2 }}>
                    {sub}
                    {narrow && <>{sub && <span aria-hidden="true">·</span>}{when}</>}
                  </span>
                )}
              </button>
              {!narrow && when}
              <button type="button" className="btn-icon kinbox-archive" title="Snooze" aria-label={`Snooze “${title}”`}
                aria-haspopup="menu" aria-expanded={menuOpenFor?.id === a.id}
                onClick={(e) => { if (menuOpenFor?.id === a.id) setMenu(null); else setMenu({ id: a.id, anchor: e.currentTarget }); }}
                style={{ border: "none", width: 30, height: 30, flexShrink: 0, color: menuOpenFor?.id === a.id ? "var(--accent)" : "var(--ink-4)" }}>
                <Icon name="clock" size={16} />
              </button>
              <button type="button" className="btn-icon kinbox-archive" title="Archive" aria-label={`Archive “${title}”`}
                onClick={() => archiveItem(a.id)}
                style={{ border: "none", width: 30, height: 30, flexShrink: 0, color: "var(--ink-4)" }}>
                <Icon name="archive" size={16} />
              </button>
            </div>
          );
        })}
        </div>
      </section>
      ))}
      {menuOpenFor && (
        <SnoozeMenu key={menuOpenFor.id} anchor={menuOpenFor.anchor}
          itemTitle={activity.find((a) => a.id === menuOpenFor.id)?.taskTitle || "this update"}
          onPick={(until) => snoozeItem(menuOpenFor.id, until)} onClose={closeMenu} />
      )}
    </div>
  );
}

/* ============================================================
   KANBO — Projects › Recycle bin (/projects/bin).            [0047, w1]
   The workspace's deleted tasks and projects for 30 days: kind icon,
   title, project identity (ProjectChip), deleted by / when, days left;
   search and a Tasks / Projects filter; Restore (with the server's note
   in the toast, and "Open project"), select + bulk restore, Delete
   forever (owners/admins for team items, the creator for personal ones)
   with a confirm; an empty state, a loading shape, and a "not switched
   on yet" state before 0047. Guests see it read-only.

   Built on the Projects page frame (projects.css) and the Inbox's row
   rhythm, so it reads as a native Projects tab; bin.css adds the rows.
   Every outcome reaches a toast (or, rendered on its own, a polite live
   region); a row's own failure sits under it. Motion is 160ms and off
   under prefers-reduced-motion. Data: lib/trash (demo: realistic fakes).
   ============================================================ */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Member, Project, Role, TrashCounts, TrashItem, TrashKind, TrashRestoreResult } from "../../data/types";
import { Avatar, Button, EmptyState, Icon, IconButton, Pill, ProjectChip, ProjectTile, SectionLabel, Segmented, Sheet, StatusGlyph } from "../primitives";
import { getMember, PERSONAL_PROJECT, toLocalISO } from "../../data/data";
import {
  daysLeft, listTrash, purgeTrash, restoreFromTrash, restoreTrashItems, trashFailure, trashFailureText, TRASH_DAYS, TRASH_LIST_MAX,
} from "../../lib/trash";
import { prefersReducedMotion, useOptionalToast } from "../rituals/shared";
import "../project/projects.css";
import "./bin.css";

export interface RecycleBinProps {
  /** the workspace open in the app; null = your Personal bin */
  workspaceId: string | null;
  workspaceName: string;
  /** your role here; null in Personal (you own everything there) */
  role: Role | null;
  currentUserId: string;
  /** for "deleted by" avatars */
  members: Member[];
  /** the workspace's live projects (a restored task's destination, chips) */
  projects: Project[];
  /** after a restore succeeds: the host merges the rows back (realtime also brings them) and may toast */
  onRestored?: (results: TrashRestoreResult[]) => void;
  onOpenProject?: (projectId: string) => void;
  onOpenTask?: (taskId: string) => void;
}

type Load = { state: "loading" } | { state: "ready"; items: TrashItem[] } | { state: "problem"; why: ReturnType<typeof trashFailure> };
type KindFilter = "all" | TrashKind;
const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "task", label: "Tasks" },
  { value: "project", label: "Projects" },
];
const LEAVE_MS = 160;
/** a value safe inside a [data-row="…"] selector */
const sel = (v: string) => v.replace(/["\\]/g, "\\$&");
const SOON_DAYS = 3;

/* ---------------- words (pure; tested) ---------------- */

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** What a bin item holds, biggest first: "2 sub-tasks", "4 comments", "1 file"… */
export function binContents(counts: TrashCounts, kind: TrashKind): string[] {
  const out: string[] = [];
  if (kind === "project") {
    if (counts.tasks) out.push(plural(counts.tasks, "task"));
    if (counts.sections) out.push(plural(counts.sections, "section"));
    if (counts.docs) out.push(plural(counts.docs, "doc"));
  } else if (counts.subtasks) out.push(plural(counts.subtasks, "sub-task"));
  if (counts.comments) out.push(plural(counts.comments, "comment"));
  if (counts.attachments) out.push(plural(counts.attachments, "file"));
  if (kind === "task" && counts.checklist) out.push(plural(counts.checklist, "checklist item"));
  return out;
}

/** "a, b and c" */
export function listWords(xs: string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** The days-left label and how loudly to say it. */
export function daysLeftLabel(purgeAfter: string, now = Date.now()): { text: string; tone: "signal" | "warn" | null } {
  const d = daysLeft(purgeAfter, now);
  if (d <= 0) return { text: "Going today", tone: "signal" };
  if (d === 1) return { text: "1 day left", tone: "signal" };
  return { text: `${d} days left`, tone: d <= SOON_DAYS ? "warn" : null };
}

/** "just now", "25 min ago", "3 h ago", then calendar days: "yesterday", "4 days ago"
 *  (the same days the list is grouped by). */
export function agoWords(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const day = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
  const d = Math.max(1, Math.round((day(now) - day(t)) / 86_400_000));
  return d === 1 ? "yesterday" : `${d} days ago`;
}

type Bucket = "today" | "yesterday" | "week" | "older";
const BUCKET_LABEL: Record<Bucket, string> = { today: "Today", yesterday: "Yesterday", week: "Last 7 days", older: "Older" };
/** Which group a delete falls in, by your own calendar days. */
export function binBucket(deletedAt: string, now = new Date()): Bucket {
  const t = new Date(deletedAt);
  if (!Number.isFinite(t.getTime())) return "older";
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((day(now) - day(t)) / 86_400_000);
  return diff <= 0 ? "today" : diff === 1 ? "yesterday" : diff < 7 ? "week" : "older";
}

const longDate = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fullDate = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? longDate.format(t) : ""; };

/* ---------------- the empty bin (EmptyArt's line, one accent element: the way back) ---------------- */

function BinArt() {
  const line = { stroke: "var(--icon-quiet)", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  const faint = { ...line, opacity: 0.5 };
  const accent = { ...line, stroke: "var(--accent)" };
  return (
    <svg className="kbin-art kempty-art" width={96} height={70} viewBox="0 0 132 96" aria-hidden="true" focusable="false">
      <rect x="16" y="50" width="22" height="28" rx="4" {...faint} style={{ fill: "var(--fill-1)" }} />
      <path d="M22 60h10M22 66h7" {...faint} />
      <path d="M47 40h38l-3.4 41.2a4 4 0 0 1-4 3.8H54.4a4 4 0 0 1-4-3.8z" {...line} style={{ fill: "var(--surface-raised)" }} />
      <rect x="41" y="31" width="50" height="9" rx="3" {...line} style={{ fill: "var(--surface-raised)" }} />
      <path d="M58 31v-3.5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3V31" {...line} />
      <path d="M59 50v24M66 50v24M73 50v24" {...faint} />
      <path d="M112 50a18 18 0 0 0-18-18h-3" {...accent} />
      <path d="M96 26l-6 6 6 6" {...accent} />
    </svg>
  );
}

/* ---------------- the page ---------------- */

export function RecycleBin({ workspaceId, workspaceName, role, currentUserId, members, projects, onRestored, onOpenProject, onOpenTask: _onOpenTask }: RecycleBinProps) {
  const ids = "kbin" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const personal = workspaceId === null;
  const canRestore = personal || role === "owner" || role === "admin" || role === "member";
  const canPurge = personal || role === "owner" || role === "admin";
  const toast = useOptionalToast();

  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<Record<string, "restore" | "purge">>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<TrashItem | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<{ tone: "ok" | "signal"; text: string } | null>(null);
  const [said, setSaid] = useState("");

  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // where focus lands when the last row goes (the toolbar goes with it)
  const introRef = useRef<HTMLParagraphElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<(() => void) | null>(null);
  useEffect(() => { const f = focusAfter.current; if (f) { focusAfter.current = null; f(); } });

  /* ---- loading ---- */
  const seq = useRef(0);
  // the visible load still on its way (the first load or "Try again"), 0 when none is
  const shownLoad = useRef(0);
  const reload = useCallback(async (quiet = false) => {
    // a quiet refresh never overtakes a visible load: that answer is just as fresh, and the page is waiting on it
    if (quiet && shownLoad.current) return;
    const n = ++seq.current;
    if (!quiet) { shownLoad.current = n; setLoad((l) => (l.state === "ready" ? l : { state: "loading" })); }
    try {
      const items = await listTrash(workspaceId);
      if (!alive.current || n !== seq.current) return;
      setLoad({ state: "ready", items });
      // forget selections and errors for rows that have gone (restored or purged elsewhere)
      const have = new Set(items.map((t) => t.id));
      setSelected((s) => (([...s].every((id) => have.has(id))) ? s : new Set([...s].filter((id) => have.has(id)))));
    } catch (e) {
      if (!alive.current || n !== seq.current) return;
      const problem: Load = { state: "problem", why: trashFailure(e) };
      // a background refresh that failed keeps a list that's on screen, but never leaves the page without an answer
      if (quiet) setLoad((l) => (l.state === "ready" ? l : problem));
      else setLoad(problem);
    } finally {
      if (shownLoad.current === n) shownLoad.current = 0;
    }
  }, [workspaceId]);
  useEffect(() => {
    setLoad({ state: "loading" });
    setSelected(new Set()); setRowError({}); setBusy({}); setBulkMsg(null); setQuery(""); setKind("all");
    void reload();
  }, [reload]);
  // coming back to the tab: someone may have restored or deleted something meanwhile
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") void reload(true); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [reload]);

  const items = load.state === "ready" ? load.items : [];
  const liveProject = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const binnedProjects = useMemo(() => new Set(items.filter((t) => t.kind === "project").map((t) => t.itemId)), [items]);

  /* ---- what's shown ---- */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((t) => (kind === "all" || t.kind === kind) && (!q
      || t.title.toLowerCase().includes(q)
      || (t.summary.project?.name ?? "").toLowerCase().includes(q)
      || (t.deletedByName ?? "").toLowerCase().includes(q)));
  }, [items, query, kind]);
  const groups = useMemo(() => {
    const now = new Date();
    const by = new Map<Bucket, TrashItem[]>();
    for (const t of shown) { const b = binBucket(t.deletedAt, now); by.set(b, [...(by.get(b) ?? []), t]); }
    return (["today", "yesterday", "week", "older"] as Bucket[]).filter((b) => by.has(b)).map((b) => ({ bucket: b, rows: by.get(b)! }));
  }, [shown]);
  const soon = useMemo(() => items.filter((t) => daysLeft(t.purgeAfter) <= SOON_DAYS).length, [items]);
  const selectedShown = shown.filter((t) => selected.has(t.id));
  const selectedAll = items.filter((t) => selected.has(t.id));

  /* ---- telling people ---- */
  const say = (text: string, action?: { label: string; run: () => void }, tone: "info" | "error" = "info") => {
    if (toast) {
      if (action) toast.action(text, action.label, action.run, {});
      else if (tone === "error") toast.error(text);
      else toast.toast(text, "info");
    } else {
      setSaid(text);
    }
  };
  const openProject = (pid: string | null) => (pid && onOpenProject ? { label: "Open project", run: () => onOpenProject(pid) } : undefined);

  /* ---- removing rows (restored / purged / gone): a short exit, then focus where it makes sense ---- */
  const removeRows = (gone: Set<string>, moveFocus: boolean | (() => void)) => {
    if (!gone.size) { if (typeof moveFocus === "function") focusAfter.current = moveFocus; return; }
    const order = shown.map((t) => t.id);
    const first = order.findIndex((id) => gone.has(id));
    const rest = order.filter((id) => !gone.has(id));
    const target = first >= 0 ? rest[Math.min(first, rest.length - 1)] : undefined;
    const finish = () => {
      if (!alive.current) return;
      setLoad((l) => (l.state === "ready" ? { state: "ready", items: l.items.filter((t) => !gone.has(t.id)) } : l));
      setLeaving((s) => { const n = new Set(s); gone.forEach((id) => n.delete(id)); return n; });
      setSelected((s) => { const n = new Set(s); gone.forEach((id) => n.delete(id)); return n.size === s.size ? s : n; });
      setRowError((e) => { const n = { ...e }; gone.forEach((id) => delete n[id]); return n; });
      if (typeof moveFocus === "function") focusAfter.current = moveFocus;
      else if (moveFocus) {
        focusAfter.current = () => {
          const row = target ? listRef.current?.querySelector<HTMLElement>(`[data-row="${sel(target)}"] [data-row-focus]`) : null;
          (row ?? searchRef.current ?? introRef.current)?.focus({ preventScroll: false });
        };
      }
    };
    if (prefersReducedMotion()) { finish(); return; }
    setLeaving((s) => new Set([...s, ...gone]));
    window.setTimeout(finish, LEAVE_MS);
  };

  const focusedIn = (id: string) => {
    const el = document.activeElement;
    return !!el && !!listRef.current?.querySelector(`[data-row="${sel(id)}"]`)?.contains(el);
  };

  /* ---- restore one ---- */
  const restoreOne = async (t: TrashItem) => {
    if (!canRestore || busy[t.id]) return;
    const hadFocus = focusedIn(t.id);
    setBusy((b) => ({ ...b, [t.id]: "restore" }));
    setRowError((e) => { const n = { ...e }; delete n[t.id]; return n; });
    try {
      const r = await restoreFromTrash(t.id);
      if (!alive.current) return;
      removeRows(new Set([t.id]), hadFocus);
      const name = `“${t.title || "Untitled"}”`;
      const text = r.status === "already_restored" ? `${name} was already restored.` : `Restored ${name}.${r.note ? ` ${r.note}` : ""}`;
      say(text, openProject(r.projectId));
      onRestored?.([r]);
    } catch (e) {
      if (!alive.current) return;
      const why = trashFailure(e);
      if (why === "not_found") {
        removeRows(new Set([t.id]), hadFocus);
        say(`“${t.title || "Untitled"}” is no longer in the bin: someone restored it or deleted it for good.`);
      } else {
        setRowError((x) => ({ ...x, [t.id]: trashFailureText(why, t.kind) }));
      }
    } finally {
      if (alive.current) setBusy((b) => { const n = { ...b }; delete n[t.id]; return n; });
    }
  };

  /* ---- bulk restore ---- */
  const restoreSelected = async () => {
    if (!canRestore || bulkBusy || !selectedAll.length) return;
    // newest delete first, so a parent comes back before a sub-task deleted earlier
    const chosen = [...selectedAll].sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
    setBulkBusy(true); setBulkMsg(null);
    setBusy((b) => ({ ...b, ...Object.fromEntries(chosen.map((t) => [t.id, "restore" as const])) }));
    const answers = await restoreTrashItems(chosen.map((t) => t.id));
    if (!alive.current) return;
    const byId = new Map(chosen.map((t) => [t.id, t]));
    const ok: TrashRestoreResult[] = [], gone = new Set<string>(), errs: Record<string, string> = {};
    for (const a of answers) {
      const t = byId.get(a.id);
      if (a.ok && a.result) { ok.push(a.result); gone.add(a.id); }
      else if (a.error === "not_found") gone.add(a.id);
      else if (t) errs[a.id] = trashFailureText(a.error ?? "error", t.kind);
    }
    setBusy((b) => { const n = { ...b }; chosen.forEach((t) => delete n[t.id]); return n; });
    setRowError((e) => ({ ...e, ...errs }));
    setBulkBusy(false);
    // keep the ones that failed selected, so Restore can be tried again
    setSelected(new Set(Object.keys(errs)));
    const failed = Object.keys(errs).length;
    const notes = [...new Set(ok.map((r) => r.note).filter(Boolean))];
    if (ok.length) {
      const one = ok.length === 1 ? byId.get(ok[0].id) : undefined;
      const head = one ? `Restored “${one.title || "Untitled"}”.` : `Restored ${plural(ok.length, "item")}.`;
      const pids = [...new Set(ok.map((r) => r.projectId).filter(Boolean))] as string[];
      say([head, ...notes, failed ? `${plural(failed, "item")} couldn't be restored.` : ""].filter(Boolean).join(" "), pids.length === 1 ? openProject(pids[0]) : undefined);
      onRestored?.(ok);
    } else if (failed) {
      say(failed === 1 ? "That item couldn't be restored." : `None of the ${failed} items could be restored.`, undefined, "error");
    }
    if (failed) setBulkMsg({ tone: "signal", text: `${plural(failed, "item")} couldn't be restored. Each one says why.` });
    // once the restored rows have gone: the first that failed, else the first row left, else the page
    removeRows(gone, () => {
      const firstFailed = Object.keys(errs)[0];
      const el = firstFailed ? listRef.current?.querySelector<HTMLElement>(`[data-row="${sel(firstFailed)}"] [data-row-focus]`) : null;
      (el ?? listRef.current?.querySelector<HTMLElement>("[data-row-focus]") ?? searchRef.current ?? introRef.current)?.focus();
    });
  };

  /* ---- delete forever ---- */
  const askPurge = (t: TrashItem) => { setPurgeError(null); setConfirm(t); };
  const purge = async () => {
    const t = confirm;
    if (!t || busy[t.id]) return;
    setBusy((b) => ({ ...b, [t.id]: "purge" })); setPurgeError(null);
    try {
      await purgeTrash(t.id);
      if (!alive.current) return;
      setConfirm(null);
      removeRows(new Set([t.id]), true);
      say(`Deleted “${t.title || "Untitled"}” for good.`);
    } catch (e) {
      if (!alive.current) return;
      const why = trashFailure(e);
      if (why === "not_found") {
        setConfirm(null);
        removeRows(new Set([t.id]), true);
        say(`“${t.title || "Untitled"}” is no longer in the bin: someone restored it or deleted it for good.`);
      } else {
        setPurgeError(why === "not_allowed" ? "Only owners and admins can delete team items for good." : trashFailureText(why, t.kind));
      }
    } finally {
      if (alive.current) setBusy((b) => { const n = { ...b }; delete n[t.id]; return n; });
    }
  };

  /* ---- selection ---- */
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allShownSelected = shown.length > 0 && selectedShown.length === shown.length;
  const toggleAll = () => setSelected((s) => {
    const n = new Set(s);
    if (allShownSelected) shown.forEach((t) => n.delete(t.id)); else shown.forEach((t) => n.add(t.id));
    return n;
  });
  const clearSelection = () => { setSelected(new Set()); setBulkMsg(null); };
  const onPageKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || !selected.size || e.defaultPrevented) return;
    // (the delete dialog is a portal: its Escape closes it, and leaves the selection alone)
    if ((e.target as HTMLElement).closest?.('[role="dialog"]')) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" && (e.target as HTMLInputElement).value) return; // the search box clears itself first
    if (tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    clearSelection();
  };

  /* ---- words ---- */
  const scopeWords = personal ? "Your deleted tasks and projects" : <>Tasks and projects deleted in <strong>{workspaceName}</strong></>;
  const roleWords = !canRestore
    ? " You're a guest here, so you can look but not restore anything."
    : !canPurge ? " Only owners and admins can delete things for good before then." : "";
  const intro = (
    <p className="kbin-intro" id={`${ids}-intro`} ref={introRef} tabIndex={-1}>
      <Icon name="clock" size={16} sw={1.75} />
      <span>{scopeWords} wait here for {TRASH_DAYS} days, then they're deleted for good.{roleWords}</span>
    </p>
  );

  /* ---- states ---- */
  let body: ReactNode;
  if (load.state === "loading") {
    body = (
      <div className="kbin-list" aria-busy="true">
        <span className="sr-only" role="status">Loading the recycle bin</span>
        {[64, 48, 72, 40].map((w, i) => (
          <div key={i} className="kbin-skel" aria-hidden="true">
            <span className="skel kbin-skel-kind" />
            <span className="kbin-skel-lines">
              <span className="skel kbin-skel-line" style={{ width: `${w}%` }} />
              <span className="skel kbin-skel-line" data-sub="true" style={{ width: `${Math.round(w * 0.6)}%` }} />
            </span>
            <span className="skel kbin-skel-btn" />
          </div>
        ))}
      </div>
    );
  } else if (load.state === "problem") {
    body = load.why === "unavailable"
      ? <EmptyState art="folder" title="The recycle bin isn't switched on yet"
          body={`Once it is, deleted tasks and projects wait here for ${TRASH_DAYS} days, so they can be brought back.`} />
      : <EmptyState art="folder" title="Couldn't load the recycle bin"
          body={load.why === "network" ? "Check your connection, then try again. Nothing in the bin has been lost." : "Something went wrong on our side. Nothing in the bin has been lost."}
          action={<Button variant="secondary" icon="refresh" onClick={() => { setLoad({ state: "loading" }); void reload(); }}>Try again</Button>} />;
  } else if (!items.length) {
    body = (
      <div className="kempty" data-size="md">
        <BinArt />
        <p className="kempty-title">The recycle bin is empty</p>
        <div className="kempty-body">
          {personal
            ? `When you delete one of your tasks or projects, it waits here for ${TRASH_DAYS} days, so you can bring it back.`
            : `When someone in ${workspaceName} deletes a task or project, it waits here for ${TRASH_DAYS} days, so it can be brought back.`}
        </div>
      </div>
    );
  } else if (!shown.length) {
    const q = query.trim();
    body = (
      <EmptyState size="sm" art="search"
        title={q ? "Nothing in the bin matches" : kind === "project" ? "No deleted projects" : "No deleted tasks"}
        body={q ? `Nothing here is called “${q}”.` : `There ${kind === "project" ? "are only tasks" : "are only projects"} in the bin.`}
        action={<Button variant="ghost" size="sm" onClick={() => { setQuery(""); setKind("all"); searchRef.current?.focus(); }}>Show everything</Button>} />
    );
  } else {
    body = (
      <div className="kbin-list" ref={listRef}>
        {groups.map(({ bucket, rows }) => (
          <section key={bucket} className="kbin-group" aria-labelledby={`${ids}-g-${bucket}`}>
            <SectionLabel id={`${ids}-g-${bucket}`} count={rows.length}>{BUCKET_LABEL[bucket]}</SectionLabel>
            <ul className="kbin-rows">
              {rows.map((t) => (
                <BinRow key={t.id} item={t} rowId={`${ids}-r-${t.id}`} currentUserId={currentUserId} members={members}
                  liveProject={liveProject} binnedProjects={binnedProjects} canRestore={canRestore} canPurge={canPurge}
                  selected={selected.has(t.id)} leaving={leaving.has(t.id)} busy={busy[t.id] ?? null} error={rowError[t.id] ?? null}
                  onToggle={() => toggle(t.id)} onRestore={() => void restoreOne(t)} onPurge={() => askPurge(t)} />
              ))}
            </ul>
          </section>
        ))}
        {items.length >= TRASH_LIST_MAX && (
          <p className="kbin-intro" style={{ marginTop: 16, paddingLeft: 12 }}>Showing the {TRASH_LIST_MAX.toLocaleString("en-GB")} most recent. Older ones are still deleted on time.</p>
        )}
      </div>
    );
  }

  const ready = load.state === "ready" && items.length > 0;
  const allState: boolean | "mixed" = allShownSelected ? true : selectedShown.length ? "mixed" : false;
  const contents = confirm ? binContents(confirm.summary.counts, confirm.kind) : [];

  return (
    <div className="kpj-page kbin" onKeyDown={onPageKey}>
      <div className="kpj-wrap">
        {intro}
        {ready && (
          <div className="kpj-toolbar kbin-toolbar">
            {canRestore && (
              <span className="kbin-hit">
                <button type="button" role="checkbox" aria-checked={allState} className="kcheck kbin-check" onClick={toggleAll} disabled={!shown.length}
                  aria-label={query || kind !== "all" ? "Select all shown" : "Select everything in the bin"}>
                  {allState === true && <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" /></svg>}
                  {allState === "mixed" && <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinecap="round" /></svg>}
                </button>
              </span>
            )}
            <label className="kpj-search">
              <Icon name="search" size={16} sw={1.75} />
              <input ref={searchRef} className="kpj-field" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
                placeholder="Search the bin" aria-label="Search the recycle bin" autoComplete="off" spellCheck={false} />
            </label>
            <Segmented ariaLabel="Show" options={KIND_OPTIONS} value={kind} onChange={setKind} />
            <span className="kpj-spacer" />
            <span className="kpj-count" aria-live="polite">
              {shown.length === items.length ? plural(items.length, "item") : `${shown.length} of ${items.length}`}
            </span>
          </div>
        )}
        {ready && canRestore && selectedAll.length > 0 && (
          <div className="kbin-selbar" role="group" aria-label="Selected items">
            <span className="kbin-selbar-text" aria-live="polite">
              {plural(selectedAll.length, "item")} selected
              {selectedShown.length < selectedAll.length && <span> · {selectedAll.length - selectedShown.length} hidden by the filter</span>}
            </span>
            <span className="kbin-selbar-acts">
              <Button variant="ghost" size="sm" onClick={clearSelection} disabled={bulkBusy}>Clear</Button>
              <Button variant="primary" size="sm" icon="undo" loading={bulkBusy} onClick={() => void restoreSelected()}>
                {bulkBusy ? "Restoring…" : `Restore ${selectedAll.length}`}
              </Button>
            </span>
          </div>
        )}
        {bulkMsg && <p className="kbin-msg" data-tone={bulkMsg.tone} role="alert">{bulkMsg.text}</p>}
        {ready && soon > 0 && (
          <p className="kbin-soon"><Icon name="hourglass" size={14} sw={1.75} />
            {soon === 1 ? "1 item is deleted for good" : `${soon} items are deleted for good`} within {SOON_DAYS} days.
          </p>
        )}
        {body}
        {!toast && <p className="sr-only" role="status" aria-live="polite">{said}</p>}
      </div>

      <Sheet open={!!confirm} onClose={() => { if (!confirm || busy[confirm.id] !== "purge") setConfirm(null); }} label="Delete forever" title="Delete forever?" width={460}
        initialFocus={cancelRef}
        footer={confirm ? (
          <>
            <Button ref={cancelRef} variant="ghost" onClick={() => setConfirm(null)} disabled={busy[confirm.id] === "purge"}>Cancel</Button>
            <Button variant="danger" icon="trash" loading={busy[confirm.id] === "purge"} onClick={() => void purge()}>Delete forever</Button>
          </>
        ) : undefined}>
        {confirm && (
          <div className="kpj-dialog">
            <p className="kpj-dialog-text">
              <strong>“{confirm.title || "Untitled"}”</strong>
              {contents.length ? <>{confirm.kind === "project" ? " and its " : " with its "}{listWords(contents)}</> : ""}
              {" "}will be deleted for good. This can't be undone.
            </p>
            {confirm.kind === "project" && (
              <p className="kpj-hint" style={{ margin: 0 }}>Its tasks, sections, docs and files go with it.</p>
            )}
            {purgeError && <p className="kpj-hint" data-tone="signal" role="alert" style={{ margin: 0 }}>{purgeError}</p>}
          </div>
        )}
      </Sheet>
    </div>
  );
}

/* ---------------- one row ---------------- */

function BinRow({ item: t, rowId, currentUserId, members, liveProject, binnedProjects, canRestore, canPurge, selected, leaving, busy, error, onToggle, onRestore, onPurge }: {
  item: TrashItem;
  rowId: string;
  currentUserId: string;
  members: Member[];
  liveProject: Map<string, Project>;
  binnedProjects: Set<string>;
  canRestore: boolean;
  canPurge: boolean;
  selected: boolean;
  leaving: boolean;
  busy: "restore" | "purge" | null;
  error: string | null;
  onToggle: () => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const title = t.title || "Untitled";
  const s = t.summary;
  const left = daysLeftLabel(t.purgeAfter);
  const contents = binContents(s.counts, t.kind).slice(0, 3);
  // where a task sits now: its live project (current name and identity), else what it was
  const pid = s.project?.id ?? t.projectId;
  const live = pid ? liveProject.get(pid) : undefined;
  const chipProject = t.kind === "task"
    ? live ?? s.project ?? (pid === PERSONAL_PROJECT.id || t.workspaceId === null ? (liveProject.get(PERSONAL_PROJECT.id) ?? PERSONAL_PROJECT) : null)
    : null;
  const projectGone = t.kind === "task" && !!s.project && !live;
  const projectInBin = projectGone && binnedProjects.has(s.project!.id);
  const byMe = !!t.deletedBy && t.deletedBy === currentUserId;
  const byName = byMe ? "you" : t.deletedByName || "someone";
  const byMember = t.deletedBy && !byMe && (members.some((m) => m.id === t.deletedBy) || getMember(t.deletedBy)) ? t.deletedBy : null;
  const meta: ReactNode[] = [];
  if (t.kind === "project") meta.push(<span>Project{s.archived ? " (archived)" : ""}</span>);
  if (chipProject) {
    meta.push(
      <>
        <ProjectChip project={chipProject} />
        {projectInBin
          ? <span className="kbin-gone" title="Restore its project first to put this back where it was"><Icon name="alert" size={12} sw={2} />Its project is in the bin too</span>
          : projectGone && <span className="kbin-gone" title="It comes back in the workspace's first project"><Icon name="alert" size={12} sw={2} />Its project was deleted</span>}
      </>,
    );
  }
  if (s.parent) meta.push(<span className="truncate">Sub-task of “{s.parent.title || "Untitled"}”</span>);
  if (contents.length) meta.push(<span>{contents.join(" · ")}</span>);
  meta.push(
    <>
      {byMember && <Avatar id={byMember} size={16} />}
      <span>Deleted by {byName} · <time dateTime={t.deletedAt} title={fullDate(t.deletedAt)}>{agoWords(t.deletedAt)}</time></span>
    </>,
  );
  const metaId = `${rowId}-meta`, errId = `${rowId}-err`;
  const describedBy = [metaId, error ? errId : null].filter(Boolean).join(" ");

  return (
    <li className="kbin-row" data-row={t.id} data-selected={selected || undefined} data-leaving={leaving || undefined}
      data-readonly={!canRestore || undefined} aria-busy={busy ? true : undefined}>
      {canRestore && (
        <span className="kbin-hit">
          <button type="button" role="checkbox" aria-checked={selected} className="kcheck kbin-check" onClick={onToggle}
            aria-label={`Select “${title}”`} aria-describedby={metaId}>
            {selected && <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </button>
        </span>
      )}
      <span className="kbin-kind" data-kind={t.kind} aria-hidden="true">
        {t.kind === "project"
          ? <ProjectTile project={s.project ?? { id: t.itemId, color: "", name: title }} size={28} />
          : <StatusGlyph status={s.status ?? "todo"} size={16} readOnly />}
      </span>
      <div className="kbin-body">
        <p className="kbin-title" title={title}>
          <span className="sr-only">{t.kind === "project" ? "Project: " : s.parent ? "Sub-task: " : "Task: "}</span>{title}
        </p>
        <p className="kbin-meta" id={metaId}>
          {meta.map((node, i) => (
            <span key={i} className="kbin-part">
              {i > 0 && <span className="kbin-dot" aria-hidden="true">·</span>}
              {node}
            </span>
          ))}
        </p>
        {error && <p className="kbin-err" id={errId} role="alert"><Icon name="alert" size={14} sw={1.75} />{error}</p>}
      </div>
      <div className="kbin-side">
        <span title={`Deleted for good on ${fullDate(t.purgeAfter)}`}>
          {left.tone ? <Pill tone={left.tone}>{left.text}</Pill> : <span className="kbin-left">{left.text}</span>}
        </span>
        {canRestore && (
          <span className="kbin-acts">
            <Button size="sm" variant="secondary" icon="undo" loading={busy === "restore"} disabled={busy === "purge"} onClick={onRestore}
              aria-label={`Restore “${title}”`} aria-describedby={describedBy} data-row-focus="">
              Restore
            </Button>
            {canPurge && (
              <IconButton icon="trash" size="sm" tone="danger" label={`Delete “${title}” forever`} onClick={onPurge} disabled={!!busy} />
            )}
          </span>
        )}
      </div>
    </li>
  );
}

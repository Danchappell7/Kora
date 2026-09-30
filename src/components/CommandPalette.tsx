/* ============================================================
   KANBO — the ⌘K bar: search tasks and projects, go anywhere, run
   an action, or ask Kanbo. One field; an ARIA combobox driving a
   listbox, announced to screen readers.

   Typing shows, in order: Ask Kanbo · Tasks · Projects · Go to ·
   Actions. The Ask row is picked for you when the text reads like a
   question or an instruction ("…?", "move …", "what …"), or when
   nothing matches; otherwise the first result is. Tab swaps the two.
   Enter on it asks: the model when Kanbo AI is on and reachable, the
   on-device rules otherwise, and the answer (with any proposed
   changes) replaces the list. Nothing changes until Apply, and Enter
   only applies from a keyboard, once the answer has been on screen a
   moment (never on a held key, and never from a phone's return key).
   With nothing typed: Recent · Go to · Ask Kanbo (two examples) ·
   Actions; opened `askFirst` (an "Ask Kanbo" button), the examples
   lead and the Ask row is always the pick.
   ============================================================ */
import { useState, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { AiMark, Icon, IconButton, Kbd, ProjectDot, StatusGlyph } from "./primitives";
import { AskKanbo, type AskKanboHandle, type AskSummary, type AskView, type AskVia } from "./AskKanbo";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { getProject, getMember, MEMBERS, PROJECTS, STATUS_META, todayISO } from "../data/data";
import { GO_TARGETS, PLACES, navItems, titleOf, type GoTarget } from "../lib/nav";
import { parseTask, type NlpSpan } from "../lib/nlp";
import { localAsk } from "../lib/askFallback";
import { fmtDay } from "../lib/askActions";
import type { AiOutcome, AskAction, AskContext, AskResult } from "../lib/askTypes";
import type { Route } from "../app-types";
import type { IconName, Task, Status, Project, Workspace } from "../data/types";

export interface Suggestion {
  id: string;
  icon: IconName;
  label: string;
  hint: string;
  accent?: boolean;
  /** a Kanbo AI action: shows the Kanbo mark instead of `icon` */
  ai?: boolean;
}

/** The action ids App handles. Kept: new-task, quick-capture, new-project,
 *  prioritize, focus, board, manage-tags, toggle-theme, settings. New:
 *  paste-notes, plan, shutdown, shortcuts, import. */
const ACTIONS: Suggestion[] = [
  { id: "new-task", icon: "plus", label: "New task", hint: "C" },
  { id: "quick-capture", icon: "zap", label: "Quick capture", hint: "Q" },
  { id: "paste-notes", icon: "notes", label: "Paste notes → tasks", hint: "" },
  { id: "new-project", icon: "folder", label: "New project", hint: "" },
  { id: "plan", icon: "calendarPlus", label: "Plan my day", hint: "" },
  { id: "prioritize", icon: "kanbo", label: "Prioritise my tasks", hint: "", accent: true, ai: true },
  { id: "focus", icon: "play", label: "Start focus", hint: "F" },
  { id: "shutdown", icon: "sunset", label: "Shut down my day", hint: "" },
  { id: "toggle-theme", icon: "moon", label: "Toggle theme", hint: "" },
  { id: "settings", icon: "settings", label: "Open settings", hint: "⌘," },
  { id: "manage-tags", icon: "tasks", label: "Manage tags", hint: "" },
  { id: "shortcuts", icon: "keyboard", label: "Keyboard shortcuts", hint: "?" },
  { id: "import", icon: "layers", label: "Import tasks", hint: "" },
  { id: "board", icon: "board", label: "Switch to board view", hint: "" },
];
/** actions that create or change work: not for guests */
const WRITES = new Set(["new-task", "quick-capture", "paste-notes", "new-project", "prioritize", "shutdown", "import"]);

/** Words that make the text read as a question or an instruction for Kanbo. */
const ASK_VERBS = /^(move|assign|plan|what|who|when|which|show|list|summarise|summarize|mark|set|reschedule|push|how)\b/i;
/** Should Enter ask Kanbo rather than open the first result? */
export function looksLikeAsk(text: string): boolean {
  const t = text.trim();
  return !!t && (t.endsWith("?") || ASK_VERBS.test(t));
}

const ASK_EXAMPLES = { act: "Move my unstarted tasks this week to Monday", read: "What's due this week?", overdue: "What's overdue?" };

// subsequence fuzzy match — "bd" matches "board", "anl" matches "analytics"
const fuzzy = (text: string, q: string): boolean => {
  if (!q) return true;
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of q) { i = t.indexOf(ch, i); if (i === -1) return false; i += 1; }
  return true;
};

// how well a name matches: whole prefix > word prefix > substring > fuzzy
const nameScore = (name: string, q: string, allowFuzzy = true): number => {
  const t = name.toLowerCase();
  if (t.startsWith(q)) return 4;
  if (t.split(/[\s\-_/·()]+/).some((w) => w.startsWith(q))) return 3;
  if (t.includes(q)) return 2;
  return allowFuzzy && q.length >= 2 && fuzzy(t, q) ? 1 : 0;
};

const sameRoute = (a: Route, b: Route) => a.view === b.view && (a.tab ?? "") === (b.tab ?? "") && (a.list ?? "") === (b.list ?? "") && (a.projectId ?? "") === (b.projectId ?? "");

type Item =
  | { kind: "ask"; text: string; example?: boolean }
  | { kind: "task"; id: string; label: string; status: Status; where?: string; due?: string; overdue?: boolean }
  | { kind: "project"; id: string; label: string; color: string; where?: string }
  | { kind: "search"; label: string }
  | { kind: "action"; s: Suggestion }
  | { kind: "go"; target: GoTarget; crumb?: string; color?: string };
interface Group { key: string; heading?: string; items: Item[] }

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** Touch first (a phone): no hardware keyboard, and the on-screen return key must never apply anything. */
const coarsePointer = () => typeof window !== "undefined" && !!window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;

const LIST_ID = "kcmd-list";
const ANSWER_ID = "kcmd-answer";
const optId = (i: number) => `kcmd-opt-${i}`;

const PALETTE_CSS = `
.kcmd-layer { position: fixed; inset: 0; z-index: var(--z-palette, 120); display: flex; align-items: flex-start; justify-content: center; padding: 12vh 16px 16px; }
.kcmd-layer::before { content: ""; position: fixed; inset: 0; z-index: -1; background: var(--scrim); animation: kcmdScrim var(--d-3, 240ms) var(--ease); }
@keyframes kcmdScrim { from { opacity: 0; } }
.kcmd {
  display: flex; flex-direction: column; width: 680px; max-width: 100%; max-height: min(680px, calc(100dvh - 12vh - 16px));
  border-radius: var(--r-xl, 16px); overflow: hidden; color: var(--ink);
  background: linear-gradient(var(--surface-raised), var(--surface-raised)), var(--surface-solid);
  box-shadow: var(--e3, var(--shadow-lg));
  animation: kcmdIn var(--d-3, 240ms) var(--ease);
}
@keyframes kcmdIn { from { opacity: 0.35; translate: 0 8px; } }

/* the field: 56px, the Kanbo mark, live token highlighting behind the text */
.kcmd-bar { display: flex; align-items: center; gap: 12px; flex-shrink: 0; height: 56px; padding: 0 12px 0 18px; border-bottom: 1px solid var(--hairline); }
.kcmd-field { position: relative; flex: 1; min-width: 0; height: 100%; overflow: hidden; }
.kcmd-input, .kcmd-mirror { font: 500 16px/24px var(--font-ui, var(--font-display)); letter-spacing: 0; }
.kcmd-input { position: relative; z-index: 1; width: 100%; height: 100%; padding: 0; border: 0; outline: none; background: transparent; color: var(--ink); caret-color: var(--accent); }
.kcmd-input::placeholder { color: var(--ink-4); }
.kcmd-mirror { position: absolute; left: 0; top: 50%; translate: 0 -50%; white-space: pre; color: transparent; pointer-events: none; will-change: transform; }
.kcmd-tok { color: transparent; background: var(--accent-tint, var(--accent-dim)); border-radius: var(--r-xs, 4px); box-shadow: 0 0 0 2px var(--accent-tint, var(--accent-dim)); }
.kcmd-esc { flex-shrink: 0; }
.kcmd-close { display: none; }
@media (hover: none) and (pointer: coarse) { .kcmd-esc { display: none; } .kcmd-close { display: inline-grid; } }

/* the list */
.kcmd-list { flex: 1 1 auto; min-height: 0; max-height: 424px; overflow-y: auto; overscroll-behavior: contain; padding: 4px 8px 8px; }
.kcmd-list[data-mode="ask"] { max-height: none; padding-top: 8px; outline: none; }
.kcmd-group + .kcmd-group, .kcmd-list > .kcmd-opt + .kcmd-group { margin-top: 4px; }
.kcmd-heading { display: flex; align-items: center; height: 32px; padding: 4px 12px 0; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kcmd-opt {
  position: relative; display: flex; align-items: center; gap: 12px; height: 40px; padding: 0 12px; border-radius: var(--r-md, 8px);
  cursor: pointer; color: var(--ink); font: 500 14px/20px var(--font-ui, var(--font-display));
  transition: background var(--d-1, 90ms) var(--ease);
}
.kcmd-opt[aria-selected="true"] { background: var(--fill-2); box-shadow: inset 2px 0 0 var(--accent); }
.kcmd-ico { display: grid; place-items: center; width: 16px; height: 16px; flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); }
.kcmd-opt[aria-selected="true"] .kcmd-ico { color: var(--ink-2); }
.kcmd-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kcmd-crumb { color: var(--ink-3); }
.kcmd-meta { flex-shrink: 1; min-width: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kcmd-due { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kcmd-due[data-tone="overdue"] { color: var(--signal, var(--st-blocked)); }
.kcmd-keys { display: inline-flex; gap: 4px; flex-shrink: 0; }
.kcmd-ask-lead { font-weight: 600; color: var(--accent-text, var(--accent)); }
.kcmd-opt[data-kind="ask"] .kcmd-label { color: var(--ink-2); }
.kcmd-opt[data-example="true"] .kcmd-label { color: var(--ink-2); }
.kcmd-empty { margin: 2px 12px 8px 40px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }

/* footer: the keys, and today's AI use */
.kcmd-foot { display: flex; align-items: center; gap: 16px; flex-shrink: 0; height: 40px; padding: 0 16px; border-top: 1px solid var(--hairline);
  background: var(--bg-sunken, var(--bg-deep)); font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kcmd-hint { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.kcmd-hint .kkbd + .kkbd { margin-left: -2px; }
.kcmd-usage { margin-left: auto; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }

@media (max-width: 859px) {
  .kcmd-layer { padding: 8px 8px 16px; }
  .kcmd { max-height: calc(100dvh - 24px); }
  .kcmd-list { max-height: none; }
  .kcmd-foot .kcmd-hint { display: none; }
  .kcmd-foot:not(:has(.kcmd-usage)) { display: none; }
}
@media (prefers-reduced-motion: reduce) { .kcmd, .kcmd-layer::before { animation: none; } }
`;

export function CommandPalette({
  open, onClose, onAction, onNavigate, tasks = [], onOpenTask, projects, onOpenProject, workspaces, onSearchAll, canCreateProject = true,
  ai, askContext, onApplyAsk, canAct, onGo, recent, recentTaskIds, initialQuery, personal, askFirst = false,
}: {
  open: boolean;
  onClose: () => void;
  onAction: (s: Suggestion) => void;
  /** legacy: go to a view by id (used when `onGo` isn't given; loses tabs and lists) */
  onNavigate?: (view: string) => void;
  tasks?: Task[];
  onOpenTask?: (id: string) => void;
  /** projects to offer as jump targets (archived ones are skipped) */
  projects?: Project[];
  /** navigate to a project; the Projects group only appears when this is given */
  onOpenProject?: (id: string) => void;
  /** lets results show which workspace a project/task lives in */
  workspaces?: Workspace[];
  /** open the Search view pre-filled with the text; adds a "See all results" row */
  onSearchAll?: (text: string) => void;
  /** false drops the "New project" action (guests can view and comment, not create) */
  canCreateProject?: boolean;
  /** Kanbo AI for Ask; undefined → on-device rules only (AI off, or no backend) */
  ai?: (q: string, tasks: Task[], ctx: AskContext) => Promise<AiOutcome<AskResult>>;
  /** today, me, the workspace's people and projects (defaults to the demo reference data) */
  askContext?: AskContext;
  /** apply the changes the person approved (App patches, creates and opens) */
  onApplyAsk?: (actions: AskAction[]) => void;
  /** false: Ask answers but never proposes changes, and writing actions are hidden (guests) */
  canAct?: boolean;
  /** go to a route (Go to rows, Recent, Ask's "Go to Today") */
  onGo?: (route: Route) => void;
  /** the last few places visited, newest first (the Recent group) */
  recent?: Route[];
  /** tasks opened recently, newest first (the Recent group) */
  recentTaskIds?: string[];
  /** text to open with */
  initialQuery?: string;
  /** the Personal workspace: Go to lists Insights where a team has Team */
  personal?: boolean;
  /** opened to ask (an "Ask Kanbo" button): the example questions lead, and
   *  whatever is typed goes to Kanbo unless another row is picked */
  askFirst?: boolean;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [ask, setAsk] = useState<(AskView & { seq: number }) | null>(null);
  // what the open answer would do on Enter (reported by AskKanbo, for this answer's seq)
  const [summary, setSummary] = useState<(AskSummary & { seq: number }) | null>(null);
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null);
  // tasks opened from here (the Recent group, alongside App's own list)
  const [openedHere, setOpenedHere] = useState<string[]>([]);
  const remember = (id: string) => setOpenedHere((ids) => [id, ...ids.filter((x) => x !== id)].slice(0, 10));
  // the query the selection was last defaulted for (see below)
  const [selFor, setSelFor] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const askRef = useRef<AskKanboHandle>(null);
  const askSeq = useRef(0);
  const limitRef = useRef<number | null>(null);
  const downOnScrim = useRef(false);
  const close = () => { askSeq.current += 1; onClose(); };
  const trapRef = useFocusTrap<HTMLDivElement>(open, close);

  useEffect(() => {
    if (!open) { askSeq.current += 1; return; }
    const text = initialQuery ?? "";
    setQ(text); setAsk(null); setSel(0); setSelFor(null);
    const t = window.setTimeout(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(text.length, text.length); } }, 30);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ctx: AskContext = useMemo(() => askContext ?? {
    today: todayISO(),
    me: MEMBERS.find((m) => m.type === "self")?.id ?? "",
    members: MEMBERS.map((m) => ({ id: m.id, name: m.name })),
    projects: (projects ?? PROJECTS).filter((p) => !p.archivedAt).map((p) => ({ id: p.id, name: p.name })),
  }, [askContext, projects]);
  const guest = canAct === false;
  const canApply = !guest && !!onApplyAsk;
  // read when the palette opens: a phone never applies from its return key
  const coarse = useMemo(() => open && coarsePointer(), [open]);

  const query = q.trim().toLowerCase();
  const spans = useMemo<NlpSpan[]>(() => {
    if (!open || !q.trim()) return [];
    try { return parseTask(q, { projects: ctx.projects, members: ctx.members }).spans.filter((s) => s.end > s.start && s.start >= 0 && s.end <= q.length); }
    catch { return []; }
  }, [open, q, ctx]);
  // the mirror follows the field when the text scrolls sideways
  const syncMirror = () => { const el = inputRef.current, m = mirrorRef.current; if (el && m) m.style.transform = `translateX(${-el.scrollLeft}px)`; };
  useLayoutEffect(syncMirror, [q, spans]);

  // keep the highlighted row visible when navigating by keyboard
  useEffect(() => { if (open && !ask) document.getElementById(optId(sel))?.scrollIntoView?.({ block: "nearest" }); }, [sel, open, ask]);

  /* ---------------- results ---------------- */
  const groups = useMemo<Group[]>(() => {
    if (!open) return [];
    // workspace names are only worth showing when results can span several
    const wsName = (id: string | null | undefined): string | undefined => {
      if (!workspaces || workspaces.length < 2) return undefined;
      return workspaces.find((w) => w.id === (id ?? null))?.name;
    };
    const projectName = (id: string) => projects?.find((p) => p.id === id)?.name ?? getProject(id)?.name;
    const today = ctx.today;
    const taskItem = (t: Task): Item => {
      const where = [projectName(t.projectId), wsName(t.workspaceId)].filter(Boolean).join(" · ") || undefined;
      const due = t.dueDate && t.status !== "done" ? fmtDay(t.dueDate, today) : undefined;
      return { kind: "task", id: t.id, label: t.title, status: t.status, where, due, overdue: !!t.dueDate && t.dueDate < today && t.status !== "done" };
    };
    const actions = ACTIONS.filter((a) => !(a.id === "new-project" && !canCreateProject) && !(guest && WRITES.has(a.id)));
    const targets = GO_TARGETS.filter((g) => !(guest && g.route.view === "automations"));
    const crumbOf = (g: GoTarget): string | undefined => { const place = titleOf(g.route); return place !== g.label ? place : undefined; };

    if (!query) {
      // Recent: places you've been, then tasks you've opened
      const routes: Item[] = [];
      for (const r of recent ?? []) {
        if (routes.length >= 5) break;
        if (routes.some((x) => x.kind === "go" && sameRoute(x.target.route, r))) continue;
        if (r.view === "project") {
          const p = projects?.find((x) => x.id === r.projectId) ?? (r.projectId ? getProject(r.projectId) : undefined);
          if (!p || p.archivedAt) continue;
          routes.push({ kind: "go", target: { id: `recent-p-${p.id}`, label: p.name, keywords: "", icon: "folder", route: r }, color: p.color });
          continue;
        }
        const g = GO_TARGETS.find((x) => sameRoute(x.route, r)) ?? GO_TARGETS.find((x) => x.route.view === r.view);
        if (g) routes.push({ kind: "go", target: { ...g, route: r }, crumb: crumbOf(g) });
      }
      const ids = [...(recentTaskIds ?? []), ...openedHere].filter((id, i, all) => all.indexOf(id) === i);
      const recentTasks = ids.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => !!t && !t.archivedAt).slice(0, 5).map(taskItem);
      const places: Item[] = navItems({ personal: !!personal, guest, admin: false }).map((n) => {
        const key = n.id === "insights" ? "a" : PLACES.find((p) => p.id === n.id)?.gKey;
        return { kind: "go", target: { id: n.id, label: n.label, keywords: "", icon: n.icon, route: n.route, hint: key ? `G ${key.toUpperCase()}` : undefined } };
      });
      const examples: Item[] = [
        { kind: "ask", text: ASK_EXAMPLES.overdue, example: true },
        { kind: "ask", text: canApply ? ASK_EXAMPLES.act : ASK_EXAMPLES.read, example: true },
      ];
      const recentGroup: Group = { key: "recent", heading: "Recent", items: [...routes, ...recentTasks] };
      const goGroup: Group = { key: "go", heading: "Go to", items: places };
      const tryGroup: Group = { key: "try", heading: "Ask Kanbo", items: examples };
      const actionGroup: Group = { key: "actions", heading: "Actions", items: actions.map((s) => ({ kind: "action", s })) };
      return askFirst ? [tryGroup, recentGroup, goGroup, actionGroup] : [recentGroup, goGroup, tryGroup, actionGroup];
    }

    // ---- tasks: title, project name, assignee name or tag; best matches and open work first ----
    const taskScore = (t: Task): number => {
      const title = t.title.toLowerCase();
      let s = title.startsWith(query) ? 6 : title.includes(query) ? 4 : 0;
      if (!s) {
        if (projectName(t.projectId)?.toLowerCase().includes(query)) s = 2;
        else if (getMember(t.assigneeId)?.name?.toLowerCase().includes(query)) s = 2;
        else if ((t.tags || []).some((tg) => tg.toLowerCase().includes(query))) s = 1;
      }
      return s && t.status !== "done" ? s + 0.5 : s;
    };
    const taskItems: Item[] = tasks
      .filter((t) => !t.archivedAt)
      .map((t) => ({ t, score: taskScore(t) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ t }) => taskItem(t));
    const searchItems: Item[] = onSearchAll ? [{ kind: "search", label: `See all results for “${q.trim()}” in Search` }] : [];
    const projectItems: Item[] = !onOpenProject || !projects ? [] : projects
      .filter((p) => !p.archivedAt)
      .map((p) => ({ p, score: nameScore(p.name, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
      .slice(0, 5)
      .map(({ p }) => ({ kind: "project", id: p.id, label: p.name, color: p.color, where: wsName(p.workspaceId) }));

    // places and actions keep their curated order on ties; the best-named match rises
    const ranked = <T,>(list: T[], score: (x: T) => number, max: number): T[] => list
      .map((x, i) => ({ x, i, s: score(x) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, max)
      .map((r) => r.x);
    const goItems: Item[] = ranked(targets, (g) => Math.max(
      nameScore(g.label, query) * 2,                         // its own name beats a keyword
      nameScore(g.keywords, query, false),
      fuzzy(g.label, query) ? 0.5 : 0,
    ), 6).map((g) => ({ kind: "go", target: g, crumb: crumbOf(g) }));
    const actionItems: Item[] = ranked(actions, (a) => Math.max(nameScore(a.label, query), fuzzy(a.label, query) ? 0.5 : 0), 8)
      .map((s) => ({ kind: "action", s }));

    return [
      { key: "ask", items: [{ kind: "ask", text: q.trim() }] },
      // "See all results" follows the tasks; with none, it stands alone where they'd be
      { key: "tasks", heading: taskItems.length ? "Tasks" : undefined, items: [...taskItems, ...searchItems] },
      { key: "projects", heading: "Projects", items: projectItems },
      { key: "go", heading: "Go to", items: goItems },
      { key: "actions", heading: "Actions", items: actionItems },
    ];
  }, [open, query, q, tasks, projects, workspaces, onOpenProject, onSearchAll, canCreateProject, guest, canApply, recent, recentTaskIds, openedHere, personal, askFirst, ctx.today]);

  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // real matches: tasks, projects, places and actions (not the Ask row, and not "See all results")
  const firstResult = query ? items.findIndex((it) => it.kind !== "ask" && it.kind !== "search") : -1;
  const hasResults = firstResult > 0;
  const resultCount = hasResults ? items.filter((it) => it.kind !== "ask" && it.kind !== "search").length : 0;
  // where Tab goes from the Ask row: the first match, else "See all results"
  const tabTo = hasResults ? firstResult : query && items.length > 1 ? 1 : -1;
  // a new query picks its own default (decided while rendering, so the old
  // highlight never flashes): the Ask row when it reads like a question or an
  // instruction, when nothing matches, or when the palette was opened to ask;
  // otherwise the first match
  if (open && selFor !== q) {
    setSelFor(q);
    setSel(hasResults && !askFirst && !looksLikeAsk(q) ? firstResult : 0);
  }

  // on a phone, asking puts the keyboard away so the answer has the screen
  // (focus moves to the answer, still inside the palette; tap the field to ask again)
  const askedSeq = ask?.seq;
  useEffect(() => { if (coarse && askedSeq != null) answerRef.current?.focus({ preventScroll: true }); }, [coarse, askedSeq]);

  if (!open) return null;

  /* ---------------- Ask ---------------- */
  const startAsk = (text: string) => {
    const question = text.trim();
    if (!question) return;
    const seq = ++askSeq.current;
    // Ask reads this workspace: the tasks in the context's projects (all of them when there's no context)
    const inScope = askContext ? new Set(askContext.projects.map((p) => p.id)) : null;
    const sent = tasks.filter((t) => !t.archivedAt && (!inScope || inScope.has(t.projectId)));
    // the answer is checked and shown against what it was asked with, even if the workspace changes meanwhile
    const asked = ctx;
    if (!ai) {
      setAsk({ seq, question, phase: "done", sent, ctx: asked, result: localAsk(question, sent, asked, { canAct: canApply }), via: "off" });
      return;
    }
    setAsk({ seq, question, phase: "loading", sent, ctx: asked });
    void (async () => {
      let result: AskResult | null = null;
      let via: AskVia = "unavailable";
      try {
        const out = await ai(question, sent, asked);
        if (out.source === "ai") {
          const d = out.data;
          if (d && typeof d.answer === "string" && d.answer.trim()) {
            const used = out.usage ?? d.usage;
            // the model's shape is checked here and every action again in AskKanbo (validateActions)
            result = {
              answer: d.answer.trim(), source: "ai",
              actions: Array.isArray(d.actions) ? d.actions : [],
              cites: Array.isArray(d.cites) ? d.cites.filter((c): c is string => typeof c === "string") : [],
              ...(used ? { usage: used } : {}),
            };
            via = "ai";
          }
        } else {
          via = out.source;
          if (out.source === "limit") {
            const n = Number(/\d+/.exec(out.detail ?? "")?.[0]);
            if (n > 0) limitRef.current = n;
          }
        }
      } catch { via = "unavailable"; }
      if (seq !== askSeq.current) return;          // cancelled, closed or asked again: ignore the late answer
      if (!result) result = localAsk(question, sent, asked, { canAct: canApply });
      if (result.usage) { setUsage(result.usage); limitRef.current = result.usage.limit; }
      setAsk({ seq, question, phase: "done", sent, ctx: asked, result, via, limit: limitRef.current ?? usage?.limit ?? 200 });
    })();
  };
  const cancelAsk = () => { askSeq.current += 1; setAsk(null); inputRef.current?.focus(); };
  // focus lost from the answer (its button went away): back to the field, or on a phone to the answer itself
  const refocus = () => (coarse ? answerRef.current : inputRef.current)?.focus({ preventScroll: true });

  const go = (route: Route) => { if (onGo) onGo(route); else onNavigate?.(route.view); };
  const activate = (it: Item) => {
    if (it.kind === "ask") {
      if (it.example) setQ(it.text);
      startAsk(it.text);
      return;
    }
    if (it.kind === "task") { remember(it.id); onOpenTask?.(it.id); }
    else if (it.kind === "project") onOpenProject?.(it.id);
    else if (it.kind === "search") onSearchAll?.(q.trim());
    else if (it.kind === "action") onAction(it.s);
    else go(it.target.route);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (ask) {
      if (e.key === "Enter") {
        e.preventDefault();
        // applying or following closes the palette. Never on a held key (auto-repeat), and never from a
        // phone's return key: there it only puts the keyboard away, and Apply is the button
        if (!e.repeat && !coarse) askRef.current?.submit();
      }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => items.length ? (s + 1) % items.length : 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => items.length ? (s - 1 + items.length) % items.length : 0); }
    else if (e.key === "Enter") { e.preventDefault(); if (!e.repeat && items[sel]) activate(items[sel]); }
    // Tab swaps between the Ask row and the first result
    else if (e.key === "Tab" && tabTo > 0) { e.preventDefault(); setSel((s) => (s === 0 ? tabTo : 0)); }
  };
  // Escape: cancels a question in flight (back to the list), otherwise closes —
  // one press, as the Esc hint says, wherever focus is in the palette
  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing || e.defaultPrevented) return;
    e.preventDefault();
    if (ask?.phase === "loading") cancelAsk(); else close();
  };

  /* ---------------- rendering ---------------- */
  let idx = -1;
  const keys = (hint: string) => (
    <span className="kcmd-keys" aria-hidden="true">{hint.split(" ").map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>
  );
  const row = (it: Item, content: ReactNode, opts: { icon: ReactNode; hint?: string; kind?: string; example?: boolean }) => {
    idx += 1; const i = idx; const isActive = i === sel;
    const hint = opts.hint || (isActive ? "⏎" : "");
    return (
      <div key={`${it.kind}-${i}`} id={optId(i)} role="option" aria-selected={isActive} className="kcmd-opt"
        data-kind={opts.kind} data-example={opts.example || undefined}
        onMouseMove={() => { if (sel !== i) setSel(i); }}
        onMouseDown={(e) => e.preventDefault() /* keep focus in the input */}
        onClick={() => activate(it)}>
        <span className="kcmd-ico" aria-hidden="true">{opts.icon}</span>
        {content}
        {hint && keys(hint)}
      </div>
    );
  };
  const renderItem = (it: Item): ReactNode => {
    switch (it.kind) {
      case "ask":
        return row(it, it.example
          ? <span className="kcmd-label">“{it.text}”</span>
          : <span className="kcmd-label"><span className="kcmd-ask-lead">Ask Kanbo</span>: “{it.text}”</span>,
        { icon: <AiMark size={it.example ? 14 : 16} />, kind: "ask", example: it.example, hint: !it.example && tabTo > 0 && sel !== 0 ? "Tab" : undefined });
      case "task":
        return row(it, <>
          <span className="kcmd-label">{it.label}<span className="sr-only">, {STATUS_META[it.status]?.label}</span></span>
          {it.where && <span className="kcmd-meta">{it.where}</span>}
          {it.due && <span className="kcmd-due" data-tone={it.overdue ? "overdue" : undefined}>{it.due}</span>}
        </>, { icon: <StatusGlyph status={it.status} size={14} /> });
      case "project":
        return row(it, <>
          <span className="kcmd-label">{it.label}{it.where && <span className="sr-only">, project in {it.where}</span>}{!it.where && <span className="sr-only">, project</span>}</span>
          {it.where && <span className="kcmd-meta" aria-hidden="true">{it.where}</span>}
        </>, { icon: <ProjectDot color={it.color} size={10} /> });
      case "search":
        return row(it, <span className="kcmd-label">{it.label}</span>, { icon: <Icon name="search" size={16} sw={1.75} /> });
      case "action":
        return row(it, <span className="kcmd-label">{it.s.label}</span>, {
          icon: it.s.ai ? <AiMark size={16} /> : <Icon name={it.s.icon} size={16} sw={1.75} />,
          hint: it.s.hint,
        });
      case "go":
        return row(it, <span className="kcmd-label">{it.crumb && <span className="kcmd-crumb">{it.crumb} › </span>}{it.target.label}</span>, {
          icon: it.color ? <ProjectDot color={it.color} size={10} /> : <Icon name={it.target.icon} size={16} sw={1.75} />,
          hint: it.target.hint,
        });
    }
  };

  const count = items.length;
  const active = ask ? -1 : items[sel] ? sel : -1;
  const onlyAsk = !!query && !hasResults;
  const activeItem = items[sel];
  const enterVerb = !activeItem ? "" : activeItem.kind === "ask" ? "ask" : activeItem.kind === "action" ? "run" : "open";
  const inAsk = !!ask;
  // what the answer on screen would do, as AskKanbo counted it (after its checks and the person's edits)
  const sum = ask?.phase === "done" && summary?.seq === ask.seq ? summary : null;
  const enterTo = (label: string) => (coarse ? "" : ` Press Enter to ${label.charAt(0).toLowerCase()}${label.slice(1)}.`);
  const announcement = ask
    ? ask.phase === "loading" ? `Kanbo is reading ${ask.sent.length} ${plural(ask.sent.length, "task", "tasks")}.${coarse ? "" : " Press Escape to cancel."}`
      : !sum ? ""
        : [
          ask.result?.answer ?? "",
          sum.changes ? `${sum.changes} ${plural(sum.changes, "change", "changes")} to review.${enterTo("apply")}`
            : sum.follow ? enterTo(sum.follow).trim() : "",
          sum.leftOut ? `Kanbo left out ${sum.leftOut} ${plural(sum.leftOut, "change", "changes")}.` : "",
        ].filter(Boolean).join(" ")
    : query ? (hasResults ? `${resultCount} ${plural(resultCount, "result", "results")}` : "No results. Press Enter to ask Kanbo.") : "";
  const askVerb = !sum ? "" : sum.selected ? "apply" : !sum.changes && sum.follow ? "open" : "";

  return (
    <div className="kcmd-layer"
      // a press that starts inside (selecting text) and ends on the scrim mustn't close it
      onMouseDown={(e) => { downOnScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnScrim.current && e.target === e.currentTarget) close(); downOnScrim.current = false; }}>
      <style>{PALETTE_CSS}</style>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Command palette" className="kcmd"
        onKeyDown={onDialogKeyDown}>
        <div className="kcmd-bar">
          <AiMark size={16} thinking={ask?.phase === "loading"} />
          <div className="kcmd-field">
            {spans.length > 0 && (
              <div ref={mirrorRef} className="kcmd-mirror" aria-hidden="true">
                {(() => {
                  const out: ReactNode[] = [];
                  let at = 0;
                  [...spans].sort((a, b) => a.start - b.start).forEach((s, i) => {
                    if (s.start < at) return;                 // overlapping: keep the first
                    if (s.start > at) out.push(q.slice(at, s.start));
                    out.push(<mark key={i} className="kcmd-tok">{q.slice(s.start, s.end)}</mark>);
                    at = s.end;
                  });
                  out.push(q.slice(at));
                  return out;
                })()}
              </div>
            )}
            <input ref={inputRef} className="kcmd-input" value={q}
              onChange={(e) => { setQ(e.target.value); if (ask) { askSeq.current += 1; setAsk(null); } }}
              onKeyDown={onKeyDown} onScroll={syncMirror} onSelect={syncMirror}
              placeholder={askFirst ? "Ask Kanbo about your work…" : "Search, jump or ask Kanbo…"}
              role="combobox" aria-label="Search or ask Kanbo" aria-expanded={!inAsk && count > 0} aria-controls={inAsk ? ANSWER_ID : LIST_ID}
              aria-activedescendant={active >= 0 ? optId(active) : undefined} aria-autocomplete="list" aria-describedby="kcmd-help"
              autoComplete="off" spellCheck={false} data-focus-ring="none" enterKeyHint={inAsk ? undefined : "go"} />
          </div>
          <span className="kcmd-esc" aria-hidden="true"><Kbd>Esc</Kbd></span>
          <IconButton className="kcmd-close" icon="x" label="Close" size="sm" onClick={close} />
        </div>
        <span id="kcmd-help" className="sr-only">Use the up and down arrow keys to move through results and Enter to choose. Tab switches between asking Kanbo and the first result.</span>
        <div className="sr-only" aria-live="polite">{announcement}</div>

        {inAsk ? (
          <div ref={answerRef} id={ANSWER_ID} className="kcmd-list" data-mode="ask" role="region" aria-label="Kanbo's answer"
            tabIndex={-1} data-focus-ring="none">
            <AskKanbo key={ask.seq} ref={askRef} view={ask} canAct={canApply} guest={guest}
              onApply={onApplyAsk ? (actions) => { onApplyAsk(actions); close(); } : undefined}
              onOpenTask={(id) => { remember(id); onOpenTask?.(id); close(); }}
              onGo={(route) => { go(route); close(); }}
              onSummary={(s) => setSummary({ ...s, seq: ask.seq })}
              returnFocus={refocus} />
          </div>
        ) : (
          <div id={LIST_ID} className="kcmd-list" role="listbox" aria-label="Results">
            {groups.map((g) => g.items.length > 0 && (g.heading ? (
              <div key={g.key} className="kcmd-group" role="group" aria-labelledby={`kcmd-h-${g.key}`}>
                <div id={`kcmd-h-${g.key}`} role="presentation" className="kcmd-heading">{g.heading}</div>
                {g.items.map(renderItem)}
              </div>
            ) : (
              <div key={g.key} role="presentation">
                {g.items.map(renderItem)}
                {/* nothing matches: say so under the Ask row, which Enter will use */}
                {g.key === "ask" && onlyAsk && <p role="presentation" className="kcmd-empty">No tasks, projects or pages match “{q.trim()}”. Press Enter to ask Kanbo.</p>}
              </div>
            )))}
          </div>
        )}

        <div className="kcmd-foot">
          {!inAsk && <span className="kcmd-hint"><Kbd>↑</Kbd><Kbd>↓</Kbd>move</span>}
          {!inAsk && enterVerb && <span className="kcmd-hint"><Kbd>⏎</Kbd>{enterVerb}</span>}
          {!inAsk && tabTo > 0 && <span className="kcmd-hint"><Kbd>Tab</Kbd>{sel === 0 ? "results" : "ask Kanbo"}</span>}
          {inAsk && askVerb && <span className="kcmd-hint"><Kbd>⏎</Kbd>{askVerb}</span>}
          <span className="kcmd-hint"><Kbd>Esc</Kbd>{ask?.phase === "loading" ? "cancel" : "close"}</span>
          {usage && <span className="kcmd-usage">Kanbo AI · {usage.used} of {usage.limit} today</span>}
        </div>
      </div>
    </div>
  );
}

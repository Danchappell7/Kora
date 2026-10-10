/* ============================================================
   KANBO — what a search IS, whichever way it was made: the words typed
   (natural-language filters included: "Maya's overdue tasks in Launch")
   plus the filters panel. One shape for the Search view, its presets
   (smart lists, old saved searches) and saved search views:
     • SearchPanel: the panel's choices. Its task fields keep the old
       Search's shape (status "open", due "today"/"week"/"overdue"/"has"/
       "none", priority, tag) so smart lists and old saved searches open
       unchanged and the sidebar's counts still agree with the results.
     • panelToFilters: the panel as search_all filters (+ the task-only
       extras the server can't do — priority, tag, has / no due date —
       which are applied on the device).
     • resolveSearch: the words parsed, chips over the panel (a chip wins
       on its own field), and the kinds to show.
     • saved views (kind "search"): { search: { text, filters }, filters }
       — the words exactly as typed (so "this week" stays relative) and
       the panel; matchesSavedSearch is the list's own predicate, for
       the sidebar's live counts.
   ============================================================ */
import type { Priority, SavedViewQuery, SearchFilters, SearchHitKind, Status, Task } from "../../data/types";
import { parseSearchNL, effectiveKinds, addDaysISO, protectLiteral, todayIn, type ParsedSearchNL, type SearchNLContext } from "../searchNL";
import { parseSearchFilters } from "../searchRows";
import { searchTerms, type Query } from "../searchQuery";
import { taskMatchesText } from "./taskText";
import { taskPassesFilters } from "../searchApi";
import type { Project } from "../../data/types";

export type PanelDue = "all" | "today" | "week" | "overdue" | "has" | "none";
export interface SearchPanel {
  /** "all" or one kind (the Show tabs) */
  kind: "all" | SearchHitKind;
  /** "all" = everywhere you are · "personal" · a workspace id */
  scope: string;
  /** "all" · "open" · a status */
  status: string;
  priority: string;
  assignee: string;
  projectId: string;
  tag: string;
  due: string;
  /** comments by */
  author: string;
  includeArchived: boolean;
}
export const EMPTY_PANEL: SearchPanel = {
  kind: "all", scope: "all", status: "all", priority: "all", assignee: "all", projectId: "all", tag: "all", due: "all", author: "all", includeArchived: false,
};
const STATUSES: readonly Status[] = ["todo", "progress", "review", "blocked", "done"];
const PRIORITIES: readonly Priority[] = ["low", "medium", "high", "urgent"];
const KINDS: readonly SearchHitKind[] = ["task", "comment", "doc", "project", "person"];
const DUES: readonly string[] = ["today", "week", "overdue", "has", "none"];

/** Anything narrowing (the kind tab and the archived switch alone don't count). */
export function panelActive(p: SearchPanel): boolean {
  return p.scope !== "all" || p.status !== "all" || p.priority !== "all" || p.assignee !== "all" || p.projectId !== "all"
    || p.tag !== "all" || p.due !== "all" || p.author !== "all";
}
/** How many panel filters are on (the Filters button's count). */
export function panelCount(p: SearchPanel): number {
  return (["scope", "status", "priority", "assignee", "projectId", "tag", "due", "author"] as const).filter((k) => p[k] !== "all").length + (p.includeArchived ? 1 : 0);
}
export const panelsEqual = (a: SearchPanel, b: SearchPanel) => (Object.keys(EMPTY_PANEL) as (keyof SearchPanel)[]).every((k) => a[k] === b[k]);

/** An old saved search / smart-list preset (lib/searchQuery's Query) → the panel, and its text. */
export function panelFromQuery(q: Partial<Query> | Record<string, unknown> | null | undefined): SearchPanel {
  const r = (q ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === "string" && r[k] ? (r[k] as string) : "all");
  return {
    ...EMPTY_PANEL,
    status: s("status"), priority: s("priority"), assignee: s("assignee"), projectId: s("projectId"), tag: s("tag"), due: s("due"),
    includeArchived: r.includeArchived === true || r.includeArchived === "true",
  };
}

/** The task-only parts the server can't filter on (applied on the device). */
export interface TaskExtras { priority?: Priority; tag?: string; hasDue?: boolean; noDue?: boolean }

/** The panel as search_all filters (dates resolved against `today`, YYYY-MM-DD) + the device-only extras. */
export function panelToFilters(p: SearchPanel, today: string): { filters: SearchFilters; extras: TaskExtras } {
  const f: SearchFilters = {};
  const x: TaskExtras = {};
  if (p.kind !== "all" && KINDS.includes(p.kind)) f.kinds = [p.kind];
  if (p.scope === "personal") f.workspaceId = null;
  else if (p.scope !== "all" && p.scope) f.workspaceId = p.scope;
  if (p.status === "open") f.excludeDone = true;
  else if ((STATUSES as readonly string[]).includes(p.status)) f.statuses = [p.status as Status];
  if (p.assignee !== "all" && p.assignee) f.assigneeId = p.assignee;
  if (p.projectId !== "all" && p.projectId) f.projectId = p.projectId;
  if (p.author !== "all" && p.author) f.authorId = p.author;
  if (p.includeArchived) f.includeArchived = true;
  // the old Search's due options: "today" and "overdue" are open work only (dueState), "week" is the next 7 days
  if (p.due === "today") { f.dueFrom = today; f.dueTo = today; f.excludeDone = true; }
  else if (p.due === "overdue") { f.dueTo = addDaysISO(today, -1); f.excludeDone = true; }
  else if (p.due === "week") { f.dueFrom = today; f.dueTo = addDaysISO(today, 7); }
  else if (p.due === "has") x.hasDue = true;
  else if (p.due === "none") x.noDue = true;
  if ((PRIORITIES as readonly string[]).includes(p.priority)) x.priority = p.priority as Priority;
  if (p.tag !== "all" && p.tag) x.tag = p.tag;
  return { filters: f, extras: x };
}

export const hasExtras = (x: TaskExtras) => !!(x.priority || x.tag || x.hasDue || x.noDue);
export function taskPassesExtras(t: Pick<Task, "priority" | "tags" | "dueDate">, x: TaskExtras): boolean {
  if (x.priority && t.priority !== x.priority) return false;
  if (x.tag && !(t.tags ?? []).includes(x.tag)) return false;
  if (x.hasDue && !t.dueDate) return false;
  if (x.noDue && t.dueDate) return false;
  return true;
}

export interface ResolvedSearch {
  parsed: ParsedSearchNL;
  /** the words left to search for */
  text: string;
  /** chips over the panel, with the kinds to show */
  filters: SearchFilters;
  extras: TaskExtras;
  kinds: SearchHitKind[];
  /** is there anything to search for at all? */
  active: boolean;
}

/** The words parsed, every chip over the panel (a chip wins on its field), and the kinds to show. */
export function resolveSearch(input: string, panel: SearchPanel, ctx: SearchNLContext, today: string): ResolvedSearch {
  const parsed = parseSearchNL(input, ctx);
  const { filters: base, extras } = panelToFilters(panel, today);
  const chipFields = new Set(parsed.chips.flatMap((c) => Object.keys(c.patch)));
  // a due chip replaces the panel's due choice wholly (its extras too)
  const x: TaskExtras = { ...extras };
  if (chipFields.has("dueFrom") || chipFields.has("dueTo")) { delete x.hasDue; delete x.noDue; if (!chipFields.has("dueFrom")) delete base.dueFrom; if (!chipFields.has("dueTo")) delete base.dueTo; }
  if (chipFields.has("statuses")) delete base.excludeDone;
  const filters: SearchFilters = { ...base };
  for (const c of parsed.chips) Object.assign(filters, c.patch);
  const kinds = effectiveKinds(filters);
  // device-only task filters are task filters too
  const kindsOut = !filters.kinds?.length && !filters.authorId && hasExtras(x) ? (["task"] as SearchHitKind[]) : kinds;
  const textActive = searchTerms(parsed.text).length > 0;
  const narrows = !!(filters.projectId || filters.assigneeId || filters.statuses || filters.excludeDone || filters.dueFrom || filters.dueTo || hasExtras(x)
    || filters.authorId);
  return { parsed, text: parsed.text, filters: { ...filters, kinds: kindsOut }, extras: x, kinds: kindsOut, active: textActive || narrows };
}

/** Every task on hand that the search finds (the words, the filters and the device-only extras), in the
 *  order given. The Search view's Tasks: complete, where search_all's are capped. */
export function localTaskMatches(tasks: readonly Task[], r: ResolvedSearch, projectById: (id: string) => Pick<Project, "archivedAt"> | undefined): Task[] {
  if (!r.active || !r.kinds.includes("task")) return [];
  const words = searchTerms(r.text).length > 0;
  const byId = projectById as (id: string) => Project | undefined;
  return tasks.filter((t) => taskPassesFilters(t, r.filters, byId) && taskPassesExtras(t, r.extras) && (!words || taskMatchesText(t, r.text)));
}

/* ------------------------------------------------------------------ saved search views */

/** The panel's fields worth saving in the legacy (Query) shape. */
function panelLegacy(p: SearchPanel): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const k of ["status", "priority", "assignee", "projectId", "tag", "due"] as const) if (p[k] !== "all") out[k] = p[k];
  if (p.includeArchived) out.includeArchived = true;
  return out;
}

/** A search → a saved view's query (kind "search"). The words are kept as typed, so relative dates stay relative. */
export function searchToViewQuery(input: string, panel: SearchPanel): SavedViewQuery {
  const stored: SearchFilters = {};
  if (panel.kind !== "all") stored.kinds = [panel.kind];
  if (panel.scope === "personal") stored.workspaceId = null;
  else if (panel.scope !== "all") stored.workspaceId = panel.scope;
  if (panel.author !== "all") stored.authorId = panel.author;
  if (panel.includeArchived) stored.includeArchived = true;
  const legacy = panelLegacy(panel);
  return { v: 1, search: { text: input.trim(), filters: stored }, ...(Object.keys(legacy).length ? { filters: legacy } : {}) };
}

/** A saved view's query (kind "search", or an adopted old saved search) → the words and the panel. */
export function searchFromViewQuery(q: SavedViewQuery | null | undefined, ctx?: SearchNLContext): { input: string; panel: SearchPanel } {
  const panel = panelFromQuery(q?.filters ?? {});
  const legacyText = typeof q?.filters?.text === "string" ? (q.filters.text as string) : "";
  const s = q?.search;
  if (s) {
    const f = parseSearchFilters(s.filters ?? {});
    if (f.kinds?.length === 1) panel.kind = f.kinds[0];
    if ("workspaceId" in (s.filters ?? {})) panel.scope = f.workspaceId === null || f.workspaceId === undefined ? "personal" : f.workspaceId;
    if (f.authorId) panel.author = f.authorId;
    if (f.includeArchived) panel.includeArchived = true;
    // filters a search view might carry that the panel shows in its own shape
    if (f.projectId && panel.projectId === "all") panel.projectId = f.projectId;
    if (f.assigneeId && panel.assignee === "all") panel.assignee = f.assigneeId;
    if (f.statuses?.length === 1 && panel.status === "all") panel.status = f.statuses[0];
    if (f.excludeDone && panel.status === "all") panel.status = "open";
    return { input: typeof s.text === "string" ? s.text : legacyText, panel };
  }
  // an old saved search: its text was never read as filters, so keep it that way
  return { input: ctx && legacyText ? protectLiteral(legacyText, ctx) : legacyText, panel };
}

/** Which panel fields a chip stands in for (so a search saved in the old shape doesn't show a filter twice). */
const CHIP_PANEL_FIELDS: Record<string, (keyof SearchPanel)[]> = {
  assignee: ["assignee"], project: ["projectId"], status: ["status"], open: ["status"], due: ["due"], archived: ["includeArchived"],
  author: ["author"], kind: ["kind"],
};

/** A legacy preset (smart list / old saved search, or text handed over from ⌘K) → the words and the panel.
 *  A search saved from the new Search keeps its words as typed in `input` (its other fields are the old
 *  shape's best reading, for counts). `literal`: the text is an old saved search's, never read as filters. */
export function searchFromPreset(preset: Record<string, unknown> | null | undefined, ctx?: SearchNLContext, opts: { literal?: boolean } = { literal: true }): { input: string; panel: SearchPanel } {
  const panel = panelFromQuery(preset);
  if (typeof preset?.input === "string" && preset.input.trim()) {
    const input = preset.input as string;
    if (ctx) for (const c of parseSearchNL(input, ctx).chips) for (const k of CHIP_PANEL_FIELDS[c.kind] ?? []) (panel as unknown as Record<string, unknown>)[k] = EMPTY_PANEL[k];
    return { input, panel };
  }
  const text = typeof preset?.text === "string" ? (preset.text as string) : "";
  return { input: ctx && text && opts.literal !== false ? protectLiteral(text, ctx) : text, panel };
}

/** A search in the old saved-search shape (lib/searchQuery's Query, which the sidebar counts with), plus
 *  `input`: the words exactly as typed, which the Search view reads back. Chips become the old fields
 *  where the old shape has one (assignee, project, one status, open, overdue, today, archived). */
export function toLegacyQuery(input: string, panel: SearchPanel, ctx: SearchNLContext, today: string): Record<string, string | boolean> {
  const r = resolveSearch(input, panel, ctx, today);
  const q: Record<string, string | boolean> = {
    text: r.text, status: panel.status, priority: panel.priority, assignee: panel.assignee, projectId: panel.projectId,
    tag: panel.tag, due: panel.due, includeArchived: panel.includeArchived,
  };
  for (const c of r.parsed.chips) {
    const f = c.patch;
    if (c.kind === "assignee" && f.assigneeId) q.assignee = f.assigneeId;
    else if (c.kind === "project" && f.projectId) q.projectId = f.projectId;
    else if (c.kind === "status" && f.statuses?.length === 1) q.status = f.statuses[0];
    else if (c.kind === "open") { if (!r.parsed.chips.some((x) => x.kind === "status")) q.status = "open"; }
    else if (c.kind === "archived") q.includeArchived = true;
    else if (c.kind === "due") {
      if (!f.dueFrom && f.dueTo === addDaysISO(today, -1) && f.excludeDone) q.due = "overdue";
      else if (f.dueFrom === today && f.dueTo === today) q.due = "today";
    }
  }
  if (r.parsed.chips.length) q.input = input.trim();
  return q;
}

export interface MatchContext extends SearchNLContext {
  projects: (Pick<Project, "id" | "name"> & { archivedAt?: string | null })[];
}

/** Is this task in the saved search view? (its tasks: the sidebar's live count) — the Search view's own task rule. */
export function matchesSavedSearch(q: SavedViewQuery, t: Task, ctx: MatchContext): boolean {
  const { input, panel } = searchFromViewQuery(q, ctx);
  const r = resolveSearch(input, panel, ctx, todayIn(ctx.today, ctx.timezone));
  if (!r.active || !r.kinds.includes("task")) return false;
  const projects = new Map(ctx.projects.map((p) => [p.id, p]));
  return localTaskMatches([t], r, (id) => projects.get(id)).length === 1;
}

/** A name for a saved search: the chips and words, briefly ("Blocked in Launch", "pricing · Docs"). */
export function suggestSearchName(r: Pick<ResolvedSearch, "parsed" | "text">, panelLabels: string[] = []): string {
  const chipBits = r.parsed.chips.map((c) => c.label);
  const words = r.text.replace(/["“”]/g, "").trim();
  const parts = [words ? `“${words}”` : "", ...chipBits, ...panelLabels].filter(Boolean);
  const name = parts.join(" · ") || "Search";
  return name.length > 80 ? name.slice(0, 79) + "…" : name;
}

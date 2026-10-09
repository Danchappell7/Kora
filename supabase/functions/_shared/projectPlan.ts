// ============================================================
// KANBO — "Plan a project with Kanbo": the ai-assist mode "plan" wire
// contract, shared by the edge function and the app.          [architect → w3]
//
// The app POSTs an AiPlanRequest to ai-assist; the function prompts Claude
// for STRICT JSON, checks it with validatePlanReply() (server side, so a bad
// reply is a 502 { error: "bad_output" } and never reaches the app half
// formed), and answers { plan: AiPlanReply, usage }. A plan call counts once
// toward the person's daily AI limit (AI_DAILY_LIMIT, ai_usage), like every
// other mode. With no key, a 400 { error: "no_api_key" } (or offline / demo
// mode) the app plans on the device instead: lib/projectPlanner fallbackPlan().
//
// Offsets are WORKING days (Mon–Fri) from the plan's start day (day 0 =
// `today`, Europe/London, or the next working day when today is a weekend).
// `ref`s are the model's own short task keys ("t1", "t2"…): dependsOn names
// them; the app maps them to real ids when it creates the tasks.
//
// Pure module (no Deno globals): the app imports the types and limits.
// Package w3 implements validatePlanReply() (+ tests) and the prompt.
// ============================================================

/** Caps, enforced by validatePlanReply() and by the planner UI. */
export const PLAN_LIMITS = {
  /** tasks in one plan */
  tasks: 60,
  /** sections in one plan */
  sections: 10,
  /** the person's goal text */
  goal: 2000,
  /** constraints text ("no launches on Fridays", "budget £5k") */
  constraints: 1000,
  /** people the plan may assign */
  roster: 50,
  /** a task's title */
  title: 140,
  /** a task's description */
  description: 1000,
  /** a section's name */
  sectionName: 60,
  /** the latest start / due offset, in working days (~1 year) */
  maxOffset: 260,
  /** one task's estimate */
  estimateHours: 200,
} as const;

/** One person the plan may assign work to (the workspace roster). */
export interface AiPlanRosterEntry {
  id: string;
  name: string;
  /** their job title in the workspace ("Designer"), when set */
  title?: string | null;
}

/** POST body for ai-assist { mode: "plan" }. */
export interface AiPlanRequest {
  mode: "plan";
  /** what the person wants to achieve, in their words */
  goal: string;
  /** YYYY-MM-DD, optional: everything should be due by then */
  deadline?: string | null;
  /** YYYY-MM-DD in Europe/London: the plan's day 0 */
  today: string;
  roster: AiPlanRosterEntry[];
  constraints?: string | null;
  /** a name the person already gave the project */
  projectName?: string | null;
  /** "Add tasks with Kanbo" in an existing project: what's already there, so the plan adds rather than repeats */
  existing?: { sections: string[]; titles: string[] } | null;
}

export interface AiPlanTask {
  /** the model's own key for this task ("t1"): unique within the plan */
  ref: string;
  title: string;
  /** one of the reply's section names */
  section: string;
  /** a roster id, a roster name, or null (unassigned) — the app resolves it */
  assigneeHint: string | null;
  estimateHours: number | null;
  /** working days from day 0 */
  startOffset: number;
  /** working days from day 0 (≥ startOffset) */
  dueOffset: number;
  /** refs of tasks that must finish first (no cycles, no unknown refs) */
  dependsOn: string[];
  isMilestone: boolean;
  description: string;
}

/** What the function answers as `plan` (already checked and capped). */
export interface AiPlanReply {
  /** a suggested project: name + one emoji (null in "append" mode) */
  project: { name: string; emoji: string } | null;
  sections: { name: string }[];
  tasks: AiPlanTask[];
}

/* ---------------- checking a reply (w3) ---------------- */

/** A suggested project name's length (the app's own field takes the same). */
export const PLAN_PROJECT_NAME_MAX = 80;
/** a task's ref ("t12") */
const REF_MAX = 24;
/** prerequisites one task may name */
const DEPENDS_MAX = 12;
/** the section a plan's loose tasks go in when the reply names none */
export const PLAN_DEFAULT_SECTION = "Tasks";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// C0/C1 controls (tab and newline are handled by the callers), bidi overrides and zero-width oddities
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​‪-‮⁦-⁩﻿]/g;

/** One line of plain text: whitespace collapsed, controls gone, at most `max` characters. */
export function planLine(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(CONTROL_RE, "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}
/** A short paragraph: line breaks kept (at most one blank line in a row), controls gone, bounded. */
export function planText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROL_RE, "")
    .split("\n").map((l) => l.replace(/ {2,}/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim().slice(0, max).trim();
}

/** The first user-perceived character, when it's an emoji (a flag, a ZWJ family and a skin tone stay whole); else "". */
export function planEmoji(v: unknown): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (!t) return "";
  let first = "";
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: "grapheme" }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) { for (const { segment } of new Seg(undefined, { granularity: "grapheme" }).segment(t)) { first = segment; break; } }
  else first = Array.from(t)[0] ?? "";
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(first) ? first : "";
}

/** A whole number of working days, or undefined when it isn't a number. */
function offsetOf(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(PLAN_LIMITS.maxOffset, Math.max(0, Math.round(n)));
}

/** Hours, to the quarter hour, within (0, estimateHours]; null when absent or not positive. */
function hoursOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(PLAN_LIMITS.estimateHours, Math.max(0.25, Math.round(n * 4) / 4));
}

/**
 * The roster entry a hint names: its id, else its full name, else a first
 * name only one person on the roster has. null when it's nobody here (or
 * more than one person) — the model never gets to invent an owner.
 */
export function resolveRosterHint(hint: unknown, roster: readonly AiPlanRosterEntry[]): string | null {
  const h = planLine(hint, 120);
  if (!h) return null;
  const byId = roster.find((r) => r.id === h) ?? roster.find((r) => r.id.toLowerCase() === h.toLowerCase());
  if (byId) return byId.id;
  const n = h.toLowerCase();
  const full = roster.filter((r) => r.name.trim().toLowerCase() === n);
  if (full.length === 1) return full[0].id;
  if (full.length > 1 || n.includes(" ")) return null;
  const first = roster.filter((r) => r.name.trim().toLowerCase().split(/\s+/)[0] === n);
  return first.length === 1 ? first[0].id : null;
}

/** Does `from` already reach `to` by dependsOn edges? (to keep the graph acyclic as edges are added) */
function reaches(graph: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const at = stack.pop()!;
    if (at === to) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const next of graph.get(at) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Check and normalise the model's reply: the shape above, PLAN_LIMITS caps
 * (extra tasks / sections dropped, texts trimmed), refs unique, dependsOn
 * only to known refs and acyclic, offsets clamped to 0…maxOffset with
 * dueOffset ≥ startOffset, sections that tasks name all present. null when
 * it can't be salvaged.
 *
 * Also: an owner only when the hint is someone on the request's roster (else
 * unassigned); a milestone is a point in time (start = due) with no
 * estimate; a task that names no section — or a section past the cap — goes
 * in the first section (a reply with none gets "Tasks"); a duplicate task
 * (same section and title) is dropped; in "append" mode `project` is null,
 * and when the person named the project, their name stands.
 */
export function validatePlanReply(raw: unknown, req: AiPlanRequest): AiPlanReply | null {
  if (!isObj(raw) || !Array.isArray(raw.tasks)) return null;
  const roster = Array.isArray(req.roster) ? req.roster : [];

  // sections, in the reply's order: named, unique (case-insensitively), capped
  const sections: { name: string }[] = [];
  const sectionKey = new Map<string, string>(); // lower-case → the name as kept
  const addSection = (name: string): string | null => {
    const key = name.toLowerCase();
    const have = sectionKey.get(key);
    if (have) return have;
    if (sections.length >= PLAN_LIMITS.sections) return null;
    sections.push({ name });
    sectionKey.set(key, name);
    return name;
  };
  for (const s of Array.isArray(raw.sections) ? raw.sections.slice(0, PLAN_LIMITS.sections * 4) : []) {
    const name = planLine(isObj(s) ? s.name : s, PLAN_LIMITS.sectionName);
    if (name) addSection(name);
  }

  // tasks: titled, refs unique, owners from the roster, offsets in range
  interface Draft extends AiPlanTask { rawDeps: unknown[] }
  const tasks: Draft[] = [];
  const refs = new Set<string>();
  const seenTitles = new Set<string>();
  let fresh = 0;
  const freshRef = () => { let r: string; do { r = `t${++fresh}`; } while (refs.has(r)); return r; };
  for (const item of raw.tasks.slice(0, PLAN_LIMITS.tasks * 3)) {
    if (tasks.length >= PLAN_LIMITS.tasks) break;
    if (!isObj(item)) continue;
    const title = planLine(item.title, PLAN_LIMITS.title);
    if (!title) continue;
    const wanted = planLine(item.section, PLAN_LIMITS.sectionName);
    const section = (wanted && addSection(wanted)) || sections[0]?.name || addSection(PLAN_DEFAULT_SECTION)!;
    const dupKey = `${section.toLowerCase()}\u0000${title.toLowerCase()}`;
    if (seenTitles.has(dupKey)) continue;
    seenTitles.add(dupKey);
    let ref = planLine(item.ref, REF_MAX);
    if (!ref || refs.has(ref)) ref = freshRef();
    refs.add(ref);
    const isMilestone = item.isMilestone === true;
    const a = offsetOf(item.startOffset), b = offsetOf(item.dueOffset);
    let start = a ?? b ?? 0, due = b ?? a ?? 0;
    if (due < start) [start, due] = [due, start];
    if (isMilestone) start = due;
    tasks.push({
      ref, title, section,
      assigneeHint: resolveRosterHint(item.assigneeHint, roster),
      estimateHours: isMilestone ? null : hoursOf(item.estimateHours),
      startOffset: start,
      dueOffset: due,
      dependsOn: [],
      isMilestone,
      description: planText(item.description, PLAN_LIMITS.description),
      rawDeps: Array.isArray(item.dependsOn) ? item.dependsOn.slice(0, DEPENDS_MAX * 2) : [],
    });
  }
  if (!tasks.length) return null;

  // prerequisites: known refs only, never itself, no repeats — and an edge that
  // would close a loop is left out (the first-listed edges win)
  const graph = new Map<string, string[]>();
  for (const t of tasks) {
    const deps: string[] = [];
    for (const d of t.rawDeps) {
      const ref = planLine(d, REF_MAX);
      if (!ref || ref === t.ref || !refs.has(ref) || deps.includes(ref) || deps.length >= DEPENDS_MAX) continue;
      if (reaches(graph, ref, t.ref)) continue; // ref already waits on t: this edge would make a cycle
      deps.push(ref);
      graph.set(t.ref, [...(graph.get(t.ref) ?? []), ref]);
    }
    t.dependsOn = deps;
  }

  // only sections something is filed under (in the reply's order)
  const used = new Set(tasks.map((t) => t.section));
  const keptSections = sections.filter((s) => used.has(s.name));

  let project: AiPlanReply["project"] = null;
  if (!req.existing) {
    const p = isObj(raw.project) ? raw.project : {};
    const name = planLine(req.projectName, PLAN_PROJECT_NAME_MAX) || planLine(p.name, PLAN_PROJECT_NAME_MAX);
    if (name) project = { name, emoji: planEmoji(p.emoji) };
  }
  return {
    project,
    sections: keptSections,
    tasks: tasks.map(({ rawDeps: _raw, ...t }) => t),
  };
}

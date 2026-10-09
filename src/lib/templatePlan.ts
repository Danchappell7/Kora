/* ============================================================
   KANBO — applying a task template, pure and small.             [u9]
   The "/" picker (templateQueryOf, matchTemplates), the words a template
   is shown with (templateMeta, day and role labels, placeholders), and
   applying one (planTemplate, templateTasks): no data, no storage. Kept
   apart from lib/templates (the library's data and the built-ins) so
   Quick capture and New task carry only this; the library itself loads
   when it's first wanted. lib/templates re-exports all of it.
   The model (dates are "days after it's used", roles, weekends) is
   written up at the top of lib/templates' library section.
   ============================================================ */
import type { LibraryTemplate, Recurrence, Subtask, TagDef, Task, TaskTemplateBody, TemplateAssigneeRole } from "../data/types";
import { toLocalISO } from "../data/data";
import { foldText } from "./searchQuery";

/** local midnight of a day */
function dayOf(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;
export const parseDay = (iso: string | undefined | null): Date | null => {
  const m = iso ? ISO_DAY.exec(iso) : null;
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
export const daysBetween = (a: Date, b: Date) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };


/** "{client}" placeholders in a title, in order (to select after applying) */
export function templatePlaceholders(title: string): { start: number; end: number; name: string }[] {
  const out: { start: number; end: number; name: string }[] = [];
  const re = /\{([^{}\n]{1,40})\}/g;
  for (let m = re.exec(title); m; m = re.exec(title)) out.push({ start: m.index, end: m.index + m[0].length, name: m[1] });
  return out;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/* ---------- repeating ---------- */
/* A body may also say how the task repeats: `recurrence` (the per-browser
   templates always could, and keep it when they move up into the library).
   The database takes any key in body (0048's shape check is on title,
   sub-tasks and checklist only), so it rides along in the JSON. */
const REPEATS: readonly Recurrence[] = ["daily", "weekdays", "weekly", "biweekly", "monthly"];
/** A template body that repeats. */
export type RepeatingTemplateBody = TaskTemplateBody & { recurrence?: Recurrence };
/** How a template's task repeats (undefined: it doesn't). Reads any body, stored or not. */
export function templateRecurrence(body: unknown): Recurrence | undefined {
  const r = body && typeof body === "object" ? (body as { recurrence?: unknown }).recurrence : undefined;
  return typeof r === "string" && (REPEATS as readonly string[]).includes(r) ? (r as Recurrence) : undefined;
}
/** `body` repeating as `r` (none/undefined: not at all) */
export function withRecurrence<B extends TaskTemplateBody>(body: B, r: Recurrence | undefined): B {
  const { recurrence: _drop, ...rest } = body as B & { recurrence?: Recurrence };
  const rep = templateRecurrence({ recurrence: r });
  return (rep ? { ...rest, recurrence: rep } : rest) as B;
}
const REPEAT_WORDS: Record<Recurrence, string> = {
  none: "Doesn't repeat", daily: "Daily", weekdays: "Every weekday", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly",
};
/** "Weekly" · "Every weekday" · "Doesn't repeat" */
export const templateRepeatLabel = (r: Recurrence | undefined): string => REPEAT_WORDS[r ?? "none"];

/** the furthest day a template reaches (its own due date or a sub-task's), or 0 */
export function templateSpanDays(body: TaskTemplateBody): number {
  return Math.max(0, body.dueOffsetDays ?? 0, ...(body.subtasks ?? []).map((s) => s.offsetDays ?? 0));
}

/** "6 sub-tasks · 5 checklist items · 14 days" (a card's meta line; "· Weekly" when it repeats) */
export function templateMeta(body: TaskTemplateBody): string {
  const parts: string[] = [];
  const rep = templateRecurrence(body);
  const subs = body.subtasks?.length ?? 0, items = body.checklist?.length ?? 0;
  if (subs) parts.push(plural(subs, "sub-task"));
  if (items) parts.push(plural(items, "checklist item"));
  const span = templateSpanDays(body);
  if (span > 0) parts.push(plural(span, "day"));
  if (rep) parts.push(templateRepeatLabel(rep));
  return parts.length ? parts.join(" · ") : "A single task";
}

/** "Today" · "Tomorrow" · "In 3 days" — a template date, from the day it's used */
export function templateDayLabel(days: number | undefined): string {
  if (days === undefined) return "No date";
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

/** "You" · "Project owner" · "Unassigned" */
export function templateRoleLabel(role: TemplateAssigneeRole | undefined): string {
  return role === "project_owner" ? "Project owner" : role === "unassigned" ? "Unassigned" : "You";
}


/* ---------- the "/" picker ---------- */

/** The picker's query while the text calls for it: text that starts with "/" (one line).
 *  "/template onb" → "onb"; "/onb" → "onb"; "/", "/tem", "/template" → "" (everything). */
export function templateQueryOf(text: string): string | null {
  if (!text.startsWith("/") || /[\r\n]/.test(text)) return null;
  let q = text.slice(1);
  const m = /^templates?(?=\s|$)\s*/i.exec(q);
  if (m) q = q.slice(m[0].length);
  else if (q.length >= 3 && "template".startsWith(q.toLowerCase())) q = "";
  return q.trimStart();
}

const isWordStart = (s: string, i: number) => i === 0 || /[^a-z0-9]/.test(s[i - 1]);
function scoreIn(w: string, s: string): number {
  if (!w || !s) return 0;
  const at = s.indexOf(w);
  if (at === 0) return 100;
  if (at > 0) return isWordStart(s, at) ? 80 : 50;
  if (w.length >= 2) {
    const initials = s.split(/[^a-z0-9]+/).filter(Boolean).map((x) => x[0]).join("");
    if (initials.startsWith(w)) return 70;
  }
  // the letters in order: fewer gaps and more word starts score higher
  let from = 0, last = -1, gaps = 0, starts = 0;
  for (const ch of w) {
    const j = s.indexOf(ch, from);
    if (j < 0) return 0;
    if (last >= 0 && j > last + 1) gaps++;
    if (isWordStart(s, j)) starts++;
    last = j; from = j + 1;
  }
  return Math.max(1, 30 + starts * 4 - gaps * 5);
}

/** Fuzzy match for the "/" picker (name and title; best first). */
export function matchTemplates(query: string, templates: readonly LibraryTemplate[]): LibraryTemplate[] {
  const q = foldText(query.trim());
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [...templates];
  const scored: { t: LibraryTemplate; score: number; i: number }[] = [];
  templates.forEach((t, i) => {
    const name = foldText(t.name), title = foldText(t.body.title);
    let score = 0;
    for (const w of words) {
      const s = Math.max(scoreIn(w, name), scoreIn(w, title) * 0.8);
      if (s <= 0) return;
      score += s;
    }
    if (name.startsWith(q)) score += 60;
    else if (name.includes(q)) score += 30;
    scored.push({ t, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.t);
}

/* ---------- applying one ---------- */

/** What applying makes (pure): the task and its sub-tasks, dated from `today`, assignees resolved by role. */
export interface AppliedTemplatePlan { task: Partial<Task> & { title: string }; subtasks: (Partial<Task> & { title: string })[]; checklist: string[] }

/** A weekend date moves to the Monday after — or the Friday before, when that Monday is past `cap`
 *  (a sub-task never moves past its task's due date); never before `today`. */
function onWorkingDay(d: Date, today: Date, cap?: Date | null): Date {
  const wd = d.getDay();
  if (wd !== 0 && wd !== 6) return d;
  const monday = addDays(d, wd === 6 ? 2 : 1);
  // (a date already past the task's own is meant to be after it: Monday's fine)
  if (!cap || monday <= cap || d > cap) return monday;
  const friday = addDays(d, wd === 6 ? -1 : -2);
  return friday < today ? d : friday;
}
/** A template date: `days` after day 0, never before today, on a working day. */
function templateDate(zero: Date, days: number, today: Date, cap?: Date | null): string {
  const d = addDays(zero, days);
  return toLocalISO(onWorkingDay(d < today ? today : d, today, cap));
}

/** Tag ids for a template's tags: by id, else by label (case-insensitive); unknown ones are dropped. */
export function resolveTemplateTags(tags: readonly string[] | undefined, dict: Record<string, TagDef> | undefined): string[] {
  if (!tags?.length) return [];
  if (!dict) return [...tags];
  const byLabel = new Map(Object.entries(dict).map(([id, t]) => [t.label.trim().toLowerCase(), id]));
  return [...new Set(tags.map((x) => (dict[x] ? x : byLabel.get(x.trim().toLowerCase()))).filter((x): x is string => !!x))];
}

/** Who a role means here: me; the project's owner (else me); nobody (me in Personal). */
export function roleAssignee(role: TemplateAssigneeRole | undefined, ctx: { currentUserId: string; projectOwnerId?: string | null; workspaceId: string | null }): string {
  if (ctx.workspaceId === null) return ctx.currentUserId;
  if (role === "project_owner") return ctx.projectOwnerId || ctx.currentUserId;
  if (role === "unassigned") return "";
  return ctx.currentUserId;
}

/** Day 0 for a template applied with this due date for its task (see the model above). */
export function templateDayZero(body: Pick<TaskTemplateBody, "dueOffsetDays">, today: Date, dueDate?: string | null): Date {
  const t = dayOf(today);
  const due = parseDay(dueDate);
  if (!due || typeof body.dueOffsetDays !== "number") return t;
  // the template's own date (perhaps moved off a weekend) keeps day 0 today
  if (toLocalISO(due) === templateDate(t, body.dueOffsetDays, t)) return t;
  return addDays(due, -body.dueOffsetDays);
}

/**
 * What applying makes (pure): the task and its sub-tasks, dated from `today`,
 * assignees resolved by role, the checklist's items.
 * `dueDate`: the task's due date chosen when applying (null/"" = none) — omit
 * it to use the template's own; the sub-tasks follow it. `assigneeId`: the
 * task's assignee (default: whoever applies it). `tags`: the workspace's tag
 * dictionary (template tags are matched by id or label; unknown ones dropped).
 */
export function planTemplate(tpl: Pick<LibraryTemplate, "body">, ctx: {
  today: Date;
  currentUserId: string;
  projectId: string;
  projectOwnerId?: string | null;
  workspaceId: string | null;
  dueDate?: string | null;
  assigneeId?: string;
  tags?: Record<string, TagDef>;
}): AppliedTemplatePlan {
  const b = tpl.body;
  const today = dayOf(ctx.today);
  const given = ctx.dueDate !== undefined;
  const due = given
    ? (parseDay(ctx.dueDate) ? toLocalISO(parseDay(ctx.dueDate)!) : undefined)
    : typeof b.dueOffsetDays === "number" ? templateDate(today, b.dueOffsetDays, today) : undefined;
  const zero = templateDayZero(b, today, due ?? null);
  const focus = typeof b.estimate === "number" && b.estimate > 0 ? Math.round(b.estimate) : 30;
  const repeat = templateRecurrence(b);
  const where = { projectId: ctx.projectId, workspaceId: ctx.workspaceId };
  const task: AppliedTemplatePlan["task"] = {
    title: b.title, description: b.description ?? "", priority: b.priority ?? "medium", status: "todo",
    ...where, assigneeId: ctx.assigneeId ?? ctx.currentUserId,
    focusMin: focus, dur: focus, tags: resolveTemplateTags(b.tags, ctx.tags),
    ...(due ? { dueDate: due } : {}),
    ...(repeat ? { recurrence: repeat } : {}),
  };
  const cap = parseDay(due);
  const subtasks = (b.subtasks ?? []).map((s) => ({
    title: s.title, description: "", priority: "medium" as const, status: "todo" as const, ...where,
    assigneeId: roleAssignee(s.assigneeRole, ctx), focusMin: 30, dur: 30, tags: [] as string[],
    ...(typeof s.offsetDays === "number" ? { dueDate: templateDate(zero, s.offsetDays, today, cap) } : {}),
  }));
  return { task, subtasks, checklist: [...(b.checklist ?? [])] };
}

/**
 * A plan as real tasks for the host's create path. `build` turns a partial
 * into a full new task (App's buildNewTask); the sub-tasks then hang off the
 * task (parentId), live in its project and workspace, stay off anyone's day,
 * keep the assignee their role gave them (even nobody) and sort after it.
 * The checklist comes back as items to add once the task is saved (App's
 * copyChecklist: the server gives them their ids; the task starts with none,
 * so nothing can tick an item that doesn't exist yet).
 */
export function templateTasks(plan: AppliedTemplatePlan, build: (partial: Partial<Task> & { title: string }) => Task): { task: Task; subtasks: Task[]; checklist: Subtask[] } {
  const stamp = Date.now();
  const checklist: Subtask[] = plan.checklist.map((title, i) => ({ id: `cl-new-${stamp}-${i}`, title, done: false }));
  const parent = build(plan.task);
  const task: Task = { ...parent, subtasks: [] };
  const base = typeof task.position === "number" ? task.position : stamp;
  const subtasks = plan.subtasks.map((s, i) => {
    const t = build(s);
    return {
      ...t, parentId: task.id, projectId: task.projectId, workspaceId: task.workspaceId, sectionId: task.sectionId,
      assigneeId: s.assigneeId ?? task.assigneeId, planToday: false, scheduled: null, mySectionId: undefined,
      position: base + i + 1,
    };
  });
  return { task, subtasks, checklist };
}

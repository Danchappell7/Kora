/* ============================================================
   KANBO — Ask Kanbo: what a proposed change may do, how it reads,
   what it knocks on, and how to take it back. Pure functions.

   Nothing the model (or the on-device rules) proposes reaches a task
   without passing validateActions first:
   · only the whitelisted fields (AskField), with valid values;
   · only tasks that were sent with the question;
   · people and projects from this workspace;
   · never a delete, never an unknown op;
   · at most 25 changes; a guest (canAct = false) gets none.
   ============================================================ */
import { PRIORITY_META, STATUS_META, getMember } from "../data/data";
import type { Priority, Status, Task } from "../data/types";
import type { Route, ViewId } from "../app-types";
import type { AskAction, AskContext, AskField, AskPatch } from "./askTypes";

/** The fields Ask may change, in the order a diff lists them. */
export const ASK_FIELDS: readonly AskField[] = ["title", "status", "dueDate", "dueTime", "assigneeId", "priority", "projectId", "planToday"];

/** The most changes one question may make. */
export const MAX_ASK_CHANGES = 25;
export const CAP_REASON = `Kanbo can change up to ${MAX_ASK_CHANGES} tasks at once`;
export const GUEST_REASON = "Guests can ask, not change";

const STATUSES = Object.keys(STATUS_META) as Status[];
const PRIORITIES = Object.keys(PRIORITY_META) as Priority[];
// every ViewId, so an `open` route can be checked (the Record keeps it exhaustive)
const VIEWS: Record<ViewId, true> = {
  plan: true, home: true, inbox: true, tasks: true, calendar: true, team: true, analytics: true, reports: true, project: true,
  search: true, goals: true, portfolios: true, workload: true, automations: true, forms: true, myweek: true, projects: true, pulse: true,
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isField = (k: string): k is AskField => (ASK_FIELDS as readonly string[]).includes(k);

/** A real calendar day written YYYY-MM-DD. */
export function isIsoDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}
const normTime = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(v.trim());
  if (!m || Number(m[1]) > 23) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
};

type Checked = { patch: AskPatch } | { reason: string };

/** One patch's fields, value by value. `skipTitle`: creates check their title themselves. */
function checkPatch(raw: Record<string, unknown>, ctx: AskContext, skipTitle = false): Checked {
  const patch: AskPatch = {};
  for (const [key, value] of Object.entries(raw)) {
    if (skipTitle && key === "title") continue;
    if (!isField(key)) return { reason: `Kanbo can't change “${key}”` };
    switch (key) {
      case "title": {
        const title = typeof value === "string" ? value.trim() : "";
        if (!title || title.length > 200) return { reason: "A title needs 1 to 200 characters" };
        patch.title = title;
        break;
      }
      case "status":
        if (!STATUSES.includes(value as Status)) return { reason: `“${String(value)}” isn't a status` };
        patch.status = value as Status;
        break;
      case "priority":
        if (!PRIORITIES.includes(value as Priority)) return { reason: `“${String(value)}” isn't a priority` };
        patch.priority = value as Priority;
        break;
      case "dueDate":
        if (!isIsoDay(value)) return { reason: "A due date must be a real day (YYYY-MM-DD)" };
        patch.dueDate = value;
        break;
      case "dueTime": {
        const time = normTime(value);
        if (!time) return { reason: "A time must be HH:MM" };
        patch.dueTime = time;
        break;
      }
      case "assigneeId":
        if (typeof value !== "string" || (value !== "" && !ctx.members.some((m) => m.id === value))) return { reason: "That person isn't in this workspace" };
        patch.assigneeId = value;
        break;
      case "projectId":
        if (typeof value !== "string" || !ctx.projects.some((p) => p.id === value)) return { reason: "That project isn't in this workspace" };
        patch.projectId = value;
        break;
      case "planToday":
        if (typeof value !== "boolean") return { reason: "“On Today” is yes or no" };
        patch.planToday = value;
        break;
    }
  }
  return { patch };
}

/** The value a task has now for a field, in the same shape a patch carries it. */
const current = (task: Task, field: AskField): unknown => {
  if (field === "assigneeId") return task.assigneeId ?? "";
  if (field === "planToday") return !!task.planToday;
  return task[field];
};

export interface RejectedAction { action: AskAction; reason: string }

/** Check every proposed action. Updates to the same task are merged (the
 *  later value wins), fields that wouldn't change anything are dropped, and
 *  anything past the 25th change is turned away. `sentTasks` are the tasks the
 *  question was asked about: nothing else can be touched. */
export function validateActions(actions: unknown, sentTasks: Task[], ctx: AskContext, canAct: boolean): { valid: AskAction[]; rejected: RejectedAction[] } {
  const list: unknown[] = Array.isArray(actions) ? actions : [];
  const rejected: RejectedAction[] = [];
  const reject = (action: unknown, reason: string) => { rejected.push({ action: action as AskAction, reason }); };
  if (!canAct) {
    list.forEach((a) => reject(a, GUEST_REASON));
    return { valid: [], rejected };
  }
  const byId = new Map(sentTasks.map((t) => [t.id, t]));
  const out: AskAction[] = [];
  const updateAt = new Map<string, number>();   // task id → its (merged) update's place in `out`
  const opened = new Set<string>();

  for (const action of list) {
    if (!isObj(action)) { reject(action, "Kanbo didn't understand that change"); continue; }
    const op = action.op;
    if (op === "delete") { reject(action, "Kanbo never deletes tasks"); continue; }
    if (op === "update") {
      const id = action.id;
      if (typeof id !== "string" || !byId.has(id)) { reject(action, "Kanbo can only change the tasks it was asked about"); continue; }
      if (!isObj(action.patch)) { reject(action, "Kanbo didn't say what to change"); continue; }
      const checked = checkPatch(action.patch, ctx);
      if ("reason" in checked) { reject(action, checked.reason); continue; }
      const at = updateAt.get(id);
      if (at == null) { updateAt.set(id, out.length); out.push({ op: "update", id, patch: checked.patch }); }
      else {
        const prev = out[at] as Extract<AskAction, { op: "update" }>;
        out[at] = { op: "update", id, patch: { ...prev.patch, ...checked.patch } };
      }
      continue;
    }
    if (op === "create") {
      const task = action.task;
      if (!isObj(task)) { reject(action, "Kanbo didn't say what to create"); continue; }
      const title = typeof task.title === "string" ? task.title.trim() : "";
      if (!title || title.length > 200) { reject(action, "A title needs 1 to 200 characters"); continue; }
      const checked = checkPatch(task, ctx, true);
      if ("reason" in checked) { reject(action, checked.reason); continue; }
      out.push({ op: "create", task: { ...checked.patch, title } });
      continue;
    }
    if (op === "open") {
      const taskId = typeof action.taskId === "string" ? action.taskId : undefined;
      const route = isObj(action.route) ? action.route : undefined;
      if (taskId) {
        if (!byId.has(taskId)) { reject(action, "Kanbo can only open the tasks it was asked about"); continue; }
        if (!opened.has("t:" + taskId)) { opened.add("t:" + taskId); out.push({ op: "open", taskId }); }
        continue;
      }
      if (route && typeof route.view === "string" && route.view in VIEWS) {
        const r: Route = { view: route.view as ViewId };
        if (typeof route.projectId === "string") r.projectId = route.projectId;
        if (typeof route.tab === "string") r.tab = route.tab;
        if (typeof route.list === "string") r.list = route.list;
        if (r.view === "project" && !(r.projectId && ctx.projects.some((p) => p.id === r.projectId))) { reject(action, "That project isn't in this workspace"); continue; }
        const key = `r:${r.view}:${r.projectId ?? ""}:${r.tab ?? ""}:${r.list ?? ""}`;
        if (!opened.has(key)) { opened.add(key); out.push({ op: "open", route: r }); }
        continue;
      }
      reject(action, "Kanbo didn't say what to open");
      continue;
    }
    reject(action, "Kanbo can only change, create or open tasks");
  }

  // drop fields that already hold the proposed value; an update left empty changes nothing
  const valid: AskAction[] = [];
  let changes = 0;
  for (const action of out) {
    if (action.op === "update") {
      const task = byId.get(action.id)!;
      const patch: AskPatch = {};
      for (const [k, v] of Object.entries(action.patch) as [AskField, unknown][]) {
        if (current(task, k) !== v) (patch as Record<string, unknown>)[k] = v;
      }
      if (!Object.keys(patch).length) { reject(action, "Nothing would change"); continue; }
      if (changes >= MAX_ASK_CHANGES) { reject(action, CAP_REASON); continue; }
      changes += 1;
      valid.push({ op: "update", id: action.id, patch });
    } else if (action.op === "create") {
      if (changes >= MAX_ASK_CHANGES) { reject(action, CAP_REASON); continue; }
      changes += 1;
      valid.push(action);
    } else {
      valid.push(action);
    }
  }
  return { valid, rejected };
}

/** How many of these actions change something (updates and creates; opens are navigation). */
export const changeCount = (actions: AskAction[]): number => actions.filter((a) => a.op !== "open").length;

/* ---------------- display ---------------- */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon 5 Oct" (en-GB); the year is added when it isn't this one. `long`: "Monday 5 Oct". */
export function fmtDay(iso: string, today?: string, long = false): string {
  if (!isIsoDay(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const day = `${(long ? WEEKDAYS_LONG : WEEKDAYS)[date.getDay()]} ${d} ${MONTHS[m - 1]}`;
  const thisYear = today && isIsoDay(today) ? Number(today.slice(0, 4)) : new Date().getFullYear();
  return y === thisYear ? day : `${day} ${y}`;
}

const FIELD_LABEL: Record<AskField, string> = {
  title: "Title", status: "Status", dueDate: "Due", dueTime: "Time", assigneeId: "Assignee",
  priority: "Priority", projectId: "Project", planToday: "Today",
};

/** A field's value as a diff shows it. */
export function fmtValue(field: AskField, value: unknown, ctx: AskContext): string {
  switch (field) {
    case "dueDate": return typeof value === "string" && value ? fmtDay(value, ctx.today) : "No date";
    case "dueTime": return typeof value === "string" && value ? value : "No time";
    case "status": return STATUS_META[value as Status]?.label ?? String(value);
    case "priority": return PRIORITY_META[value as Priority]?.label ?? String(value);
    case "assigneeId": {
      if (!value) return "Unassigned";
      return ctx.members.find((m) => m.id === value)?.name ?? getMember(String(value))?.name ?? "Someone else";
    }
    case "projectId": return ctx.projects.find((p) => p.id === value)?.name ?? "Another project";
    case "planToday": return value ? "On Today" : "Off Today";
    case "title": return String(value ?? "");
  }
}

export interface DiffChange {
  field: AskField;
  label: string;
  /** null for a new task (there is nothing before) */
  from: string | null;
  to: string;
  /** dates and times read in the data face */
  mono: boolean;
}
export interface DiffRow {
  /** the action's place in `valid` (what Edit and "Keep it" exclude) */
  index: number;
  op: "update" | "create";
  taskId?: string;
  title: string;
  status: Status;
  changes: DiffChange[];
}

type TaskLookup = ReadonlyMap<string, Task> | Readonly<Record<string, Task>>;
const lookup = (tasks: TaskLookup, id: string): Task | undefined =>
  tasks instanceof Map ? tasks.get(id) : (tasks as Readonly<Record<string, Task>>)[id];

const ordered = (patch: AskPatch): AskField[] => ASK_FIELDS.filter((f) => f in patch);

/** The rows of the "what will change" table: one per task, one line per field. */
export function diffRows(valid: AskAction[], tasksById: TaskLookup, ctx: AskContext): DiffRow[] {
  const rows: DiffRow[] = [];
  valid.forEach((action, index) => {
    if (action.op === "update") {
      const task = lookup(tasksById, action.id);
      if (!task) return;
      rows.push({
        index, op: "update", taskId: task.id, title: task.title, status: task.status,
        changes: ordered(action.patch).map((f) => ({
          field: f, label: FIELD_LABEL[f], mono: f === "dueDate" || f === "dueTime",
          from: fmtValue(f, current(task, f), ctx), to: fmtValue(f, action.patch[f], ctx),
        })),
      });
    } else if (action.op === "create") {
      const { title, ...rest } = action.task;
      const fields: AskPatch = rest;
      rows.push({
        index, op: "create", title, status: rest.status ?? "todo",
        changes: ordered(fields).filter((f) => f !== "status" || rest.status !== "todo").map((f) => ({
          field: f, label: FIELD_LABEL[f], mono: f === "dueDate" || f === "dueTime", from: null, to: fmtValue(f, fields[f], ctx),
        })),
      });
    }
  });
  return rows;
}

/* ---------------- knock-on effects ---------------- */

export interface HeadsUp {
  id: string;
  kind: "reopen" | "blocker" | "milestone" | "others";
  /** read in bold: usually the task's title */
  lead: string;
  /** the rest of the sentence */
  text: string;
  /** the actions (places in `valid`) that "Keep it" leaves out */
  indices: number[];
  /** the inline button: "Keep it", "Keep it done", "Leave theirs" … */
  keep: string;
}

const firstName = (id: string, members?: { id: string; name: string }[]): string | null => {
  const name = members?.find((m) => m.id === id)?.name ?? getMember(id)?.name;
  return name ? name.trim().split(/\s+/)[0] : null;
};
const listNames = (names: string[]): string =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** What these changes would knock on, so nobody is surprised:
 *  · a blocker moved past the day a task waiting on it is due;
 *  · a milestone moved, or one of its dependencies moved past it;
 *  · someone else's task changed;
 *  · a done task reopened. */
export function headsUps(valid: AskAction[], allTasks: Task[], me: string, members?: { id: string; name: string }[]): HeadsUp[] {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  // every task as it would be after all the changes (a dependant may move too)
  const after = new Map<string, Task>();
  valid.forEach((a) => { if (a.op === "update") { const t = byId.get(a.id); if (t) after.set(a.id, { ...t, ...a.patch }); } });
  const now = (t: Task): Task => after.get(t.id) ?? t;
  const owner = (t: Task): string => {
    if (!t.assigneeId) return "an unassigned";
    if (t.assigneeId === me) return "your";
    const n = firstName(t.assigneeId, members);
    return n ? `${n}'s` : "a teammate's";
  };

  const reopen: HeadsUp[] = [], knock: HeadsUp[] = [];
  const theirs: { index: number; who: string }[] = [];
  valid.forEach((a, index) => {
    if (a.op !== "update") return;
    const task = byId.get(a.id);
    if (!task) return;
    const { patch } = a;
    if (task.status === "done" && patch.status && patch.status !== "done") {
      reopen.push({ id: `reopen:${task.id}`, kind: "reopen", lead: task.title, text: "is done — this reopens it.", indices: [index], keep: "Keep it done" });
    }
    if (patch.dueDate && patch.dueDate !== task.dueDate) {
      const newDue = patch.dueDate;
      const waiting = allTasks
        .filter((d) => d.id !== task.id && d.status !== "done" && !d.archivedAt && (d.dependencies ?? []).includes(task.id))
        .map(now)
        .filter((d) => !!d.dueDate && d.dueDate < newDue);
      const milestone = waiting.find((d) => d.isMilestone);
      if (task.isMilestone) {
        knock.push({ id: `milestone:${task.id}`, kind: "milestone", lead: task.title, text: "is a milestone — moving it moves the date others are working to.", indices: [index], keep: "Keep it" });
      } else if (milestone) {
        knock.push({ id: `milestone:${task.id}`, kind: "milestone", lead: task.title, text: `feeds the milestone “${milestone.title}”, due ${fmtDay(milestone.dueDate!)} — this lands after it.`, indices: [index], keep: "Keep it" });
      } else if (waiting.length === 1) {
        const d = waiting[0];
        knock.push({ id: `blocker:${task.id}`, kind: "blocker", lead: task.title, text: `unblocks ${owner(d)} “${d.title}”, due ${fmtDay(d.dueDate!)} — moving it later delays that.`, indices: [index], keep: "Keep it" });
      } else if (waiting.length > 1) {
        knock.push({ id: `blocker:${task.id}`, kind: "blocker", lead: task.title, text: `unblocks ${waiting.length} tasks due before ${fmtDay(newDue)} — moving it later delays them.`, indices: [index], keep: "Keep it" });
      }
    }
    if (task.assigneeId && task.assigneeId !== me) theirs.push({ index, who: firstName(task.assigneeId, members) ?? "a teammate" });
  });

  const others: HeadsUp[] = [];
  if (theirs.length === 1) {
    const [{ index, who }] = theirs;
    const task = byId.get((valid[index] as Extract<AskAction, { op: "update" }>).id)!;
    // one task, two warnings: say it once ("is Sana's task, and unblocks …")
    const same = knock.findIndex((k) => k.indices.length === 1 && k.indices[0] === index);
    if (same >= 0) knock[same] = { ...knock[same], text: `is ${who}'s task, and ${knock[same].text.replace(/^is /, "it's ")}` };
    else others.push({ id: "others", kind: "others", lead: task.title, text: `is ${who}'s task.`, indices: [index], keep: "Leave it" });
  } else if (theirs.length > 1) {
    const names = [...new Set(theirs.map((t) => t.who))];
    others.push({
      id: "others", kind: "others", lead: `${theirs.length} of these`,
      text: `belong to ${names.length === 1 ? names[0] : listNames(names)}.`,
      indices: theirs.map((t) => t.index), keep: "Leave theirs",
    });
  }
  return [...reopen, ...knock, ...others];
}

/* ---------------- undo ---------------- */

/** The patches that put every updated task back as it was (for Undo / ⌘Z).
 *  A field that was empty comes back as `undefined` (cleared). Creates have
 *  no inverse here: whoever created the task removes it. */
export function inversePatches(valid: AskAction[], tasksById: TaskLookup): AskAction[] {
  const out: AskAction[] = [];
  for (const a of valid) {
    if (a.op !== "update") continue;
    const task = lookup(tasksById, a.id);
    if (!task) continue;
    const patch: AskPatch = {};
    for (const f of ordered(a.patch)) (patch as Record<string, unknown>)[f] = task[f];
    out.push({ op: "update", id: a.id, patch });
  }
  return out;
}

/* ============================================================
   KANBO — what a saved view shows, in words: where it opens ("My
   tasks · Waiting on", "Q3 Product Launch · Board", "Search") and
   its filters, grouping and sort as short phrases ("Priority: Urgent",
   "Assigned to whoever's looking", "Grouped by assignee"). The editor
   lists them; the All views list uses the first line. Pure.
   ============================================================ */
import type { SavedViewKind, SavedViewQuery, SearchFilters } from "../../data/types";
import { getMember, getProject, PRIORITY_META, STATUS_META, TAGS } from "../../data/data";
import { VIEW_CUSTOM_PREFIX, VIEW_ME } from "../views";

export interface ViewDescription {
  /** where it opens */
  where: string;
  /** one short phrase per filter, then grouping and sort */
  parts: string[];
}

const MY_LIST: Record<string, string> = {
  open: "Open", waiting: "Waiting on", done: "Done", today: "Due today", overdue: "Overdue", week: "Due this week",
};
const VIEW_TYPE: Record<string, string> = { list: "List", board: "Board", calendar: "Calendar", timeline: "Timeline" };
const DUE: Record<string, string> = { overdue: "Overdue", today: "Due today", week: "Due in the next 7 days", has: "Has a due date", none: "No due date" };
const GROUP: Record<string, string> = {
  due: "due date", status: "status", section: "section", priority: "priority", project: "project", assignee: "assignee", none: "",
};
const SORT: Record<string, string> = { due: "due date", priority: "priority", title: "name", created: "date created", updated: "last updated" };
const KINDS: Record<string, string> = { task: "Tasks", comment: "Comments", doc: "Docs", project: "Projects", person: "People" };

const statusWord = (s: string) => (s === "open" ? "Open" : STATUS_META[s as keyof typeof STATUS_META]?.label ?? s);
const personWord = (id: string, viewer: string | undefined) =>
  id === VIEW_ME ? "Assigned to whoever's looking" : `Assigned to ${id === viewer ? "you" : getMember(id)?.name ?? "someone"}`;
const longDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${+m[3]} ${months[+m[2] - 1]}`;
};

/** The view in words. `viewer` makes "Assigned to you" read right; `workspaceName` names a search's scope. */
export function describeView(kind: SavedViewKind, query: SavedViewQuery | undefined, opts: {
  viewer?: string;
  workspaceName?: (id: string) => string | undefined;
  sectionName?: (id: string) => string | undefined;
} = {}): ViewDescription {
  const q = query ?? { v: 1 };
  const f = q.filters ?? {};
  const parts: string[] = [];
  let where: string;
  if (kind === "project") {
    const p = q.projectId ? getProject(q.projectId) : undefined;
    where = `${p?.name ?? "A project"} · ${VIEW_TYPE[q.viewType ?? "list"] ?? "List"}`;
  } else if (kind === "my_tasks") {
    where = `My tasks · ${MY_LIST[q.list ?? "open"] ?? "Open"}`;
  } else {
    const words = q.search?.text?.trim() || (typeof f.text === "string" ? f.text.trim() : "");
    where = words ? `Search for “${words}”` : "Search";
  }

  const s = (k: string) => (typeof f[k] === "string" && f[k] && f[k] !== "all" ? (f[k] as string) : "");
  if (s("status")) parts.push(`Status: ${statusWord(s("status"))}`);
  if (s("priority")) parts.push(`Priority: ${PRIORITY_META[s("priority") as keyof typeof PRIORITY_META]?.label ?? s("priority")}`);
  if (s("assignee")) parts.push(personWord(s("assignee"), opts.viewer));
  if (s("tag")) parts.push(`Tag: ${TAGS[s("tag")]?.label ?? s("tag")}`);
  if (s("due")) parts.push(DUE[s("due")] ?? `Due: ${s("due")}`);
  if (s("section")) parts.push(s("section") === "__none" ? "No section" : `Section: ${opts.sectionName?.(s("section")) ?? "one section"}`);
  if (s("projectId") && kind === "search") parts.push(`In ${getProject(s("projectId"))?.name ?? "a project"}`);
  if (f.hideDone === true || f.hideDone === "true") parts.push("Done tasks hidden");
  if (f.includeArchived === true || f.includeArchived === "true") parts.push("Archived included");
  const custom = Object.keys(f).filter((k) => k.startsWith(VIEW_CUSTOM_PREFIX) && s(k)).length;
  if (custom) parts.push(custom === 1 ? "1 custom field" : `${custom} custom fields`);
  if (kind !== "search" && s("text")) parts.push(`Title contains “${s("text")}”`);

  const sf: SearchFilters = q.search?.filters ?? {};
  if (sf.kinds?.length) parts.push(`${sf.kinds.map((k) => KINDS[k] ?? k).join(", ")} only`);
  if ("workspaceId" in sf) parts.push(sf.workspaceId ? `In ${opts.workspaceName?.(sf.workspaceId) ?? "one workspace"}` : "Personal only");
  if (sf.projectId) parts.push(`In ${getProject(sf.projectId)?.name ?? "a project"}`);
  if (sf.assigneeId) parts.push(personWord(sf.assigneeId, opts.viewer));
  if (sf.statuses?.length) parts.push(`Status: ${sf.statuses.map(statusWord).join(", ")}`);
  if (sf.excludeDone) parts.push("Open only");
  if (sf.dueFrom || sf.dueTo) parts.push(sf.dueFrom && sf.dueTo ? `Due ${longDate(sf.dueFrom)}–${longDate(sf.dueTo)}` : sf.dueTo ? `Due by ${longDate(sf.dueTo)}` : `Due from ${longDate(sf.dueFrom!)}`);
  if (sf.authorId) parts.push(`Comments by ${sf.authorId === opts.viewer ? "you" : getMember(sf.authorId)?.name ?? "someone"}`);
  if (sf.includeArchived && !parts.includes("Archived included")) parts.push("Archived included");

  if (q.groupBy && GROUP[q.groupBy]) parts.push(`Grouped by ${GROUP[q.groupBy]}`);
  if (q.sort && SORT[q.sort]) parts.push(`Sorted by ${SORT[q.sort]}${q.sortDir === "desc" ? " (descending)" : ""}`);
  return { where, parts };
}

/** One line: "My tasks · Open — Priority: Urgent, Grouped by due date". */
export function describeViewLine(kind: SavedViewKind, query: SavedViewQuery | undefined, opts: Parameters<typeof describeView>[2] = {}): string {
  const d = describeView(kind, query, opts);
  return d.parts.length ? `${d.where} — ${d.parts.join(", ")}` : d.where;
}

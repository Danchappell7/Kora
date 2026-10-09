/* ============================================================
   KANBO — workspace history (Settings › Workspace › History).
                                                  [0047 contract → w1]
   Contract (database 0047):
     table audit_events (select only; RLS: owners/admins read the whole
       workspace's, everyone else only their own actions — the server
       enforces it, the UI just says so). Written by triggers and definer
       functions only; kept 365 days.
       Page: .eq("workspace_id", ws) [.eq("actor_id", id)] [.in("action", …)]
             [.gte("created_at", from 00:00 Europe/London) .lt("created_at", day after `to`)]
             keyset: created_at < cursor.createdAt (ties: id < cursor.id)
             .order("created_at", desc).order("id", desc).limit(n)
       Index: (workspace_id, created_at desc, id), (workspace_id, actor_id, created_at desc).

   Package w1 implements listAuditEvents (real + demo fakes), the CSV
   export and the timeline; the catalogue and parser are final.
   ============================================================ */
import type { AuditAction, AuditCursor, AuditEvent, AuditFailure, AuditPage, AuditQuery, AuditTargetKind } from "../data/types";
import { supabase } from "./supabase";
import { MEMBERS, PROJECTS } from "../data/data";
import { toCsv } from "./exportTasks";

export type AuditGroup = "Tasks and projects" | "People" | "Workspace" | "Integrations";

/** Every action the database writes today, with its filter label and group. */
export const AUDIT_ACTION_INFO: Readonly<Record<AuditAction, { label: string; group: AuditGroup }>> = {
  "task.deleted":             { label: "Task deleted",              group: "Tasks and projects" },
  "task.restored":            { label: "Task restored",             group: "Tasks and projects" },
  "task.purged":              { label: "Task deleted for good",     group: "Tasks and projects" },
  "project.deleted":          { label: "Project deleted",           group: "Tasks and projects" },
  "project.restored":         { label: "Project restored",          group: "Tasks and projects" },
  "project.purged":           { label: "Project deleted for good",  group: "Tasks and projects" },
  "project.archived":         { label: "Project archived",          group: "Tasks and projects" },
  "project.unarchived":       { label: "Project unarchived",        group: "Tasks and projects" },
  "member.invited":           { label: "Invited",                   group: "People" },
  "member.joined":            { label: "Joined",                    group: "People" },
  "member.removed":           { label: "Removed or left",           group: "People" },
  "role.changed":             { label: "Role changed",              group: "People" },
  "workspace.renamed":        { label: "Workspace renamed",         group: "Workspace" },
  "integration.connected":    { label: "Integration connected",     group: "Integrations" },
  "integration.disconnected": { label: "Integration disconnected",  group: "Integrations" },
  "api_key.created":          { label: "API key created",           group: "Integrations" },
  "api_key.revoked":          { label: "API key revoked",           group: "Integrations" },
  "webhook.created":          { label: "Webhook added",             group: "Integrations" },
  "webhook.deleted":          { label: "Webhook deleted",           group: "Integrations" },
};
export const AUDIT_ACTIONS = Object.keys(AUDIT_ACTION_INFO) as AuditAction[];
/** The page size the UI asks for, and the most one query may return. */
export const AUDIT_PAGE = 100;
export const AUDIT_PAGE_MAX = 500;
/** How long history is kept (trash_housekeeping prunes older rows). */
export const AUDIT_RETENTION_DAYS = 365;

const TARGET_KINDS = new Set<string>(["task", "project", "member", "workspace", "integration", "api_key", "webhook"]);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const pick = (r: Record<string, unknown>, snake: string, camel: string) => (r[snake] !== undefined ? r[snake] : r[camel]);

/** An audit_events row (snake_case; camelCase also read) → AuditEvent; null if malformed. */
export function parseAuditEvent(raw: unknown): AuditEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id), workspaceId = str(pick(r, "workspace_id", "workspaceId")), action = str(r.action);
  const createdAt = str(pick(r, "created_at", "createdAt"));
  if (!id || !workspaceId || !action || !/^[a-z_]+\.[a-z_]+$/.test(action) || !createdAt) return null;
  const tk = str(pick(r, "target_kind", "targetKind"));
  const detail = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? (r.detail as Record<string, unknown>) : {};
  return {
    id, workspaceId,
    actorId: str(pick(r, "actor_id", "actorId")),
    actorName: str(pick(r, "actor_name", "actorName")) ?? "Someone",
    action: action as AuditAction,
    targetKind: tk ? (TARGET_KINDS.has(tk) ? (tk as AuditTargetKind) : tk) : null,
    targetId: str(pick(r, "target_id", "targetId")),
    targetTitle: str(pick(r, "target_title", "targetTitle")),
    detail,
    createdAt,
  };
}

/** A known action's label; an action from a later migration shows as its raw name. */
export function auditActionLabel(action: string): string {
  return (AUDIT_ACTION_INFO as Record<string, { label: string }>)[action]?.label ?? action;
}

export function auditFailure(e: unknown): AuditFailure {
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  if (code === "42P01" || code === "PGRST205" || /does not exist|could not find the table/i.test(msg)) return "unavailable";
  if (/failed to fetch|network|load failed/i.test(msg)) return "network";
  return "error";
}

/* ============================================================
   Package w1: the page query (real + demo), the sentences and the CSV.
   ============================================================ */

/** The columns the timeline reads (every column; listed so a later one never rides along). */
export const AUDIT_COLUMNS = "id,workspace_id,actor_id,actor_name,action,target_kind,target_id,target_title,detail,created_at";
/** Person filter value for what Kanbo did itself (cron, the bin's 30-day clean-up, a deleted account). */
export const AUDIT_ACTOR_KANBO = "kanbo";
/** Export CSV stops after this many rows (a year of a busy workspace fits easily). */
export const AUDIT_EXPORT_MAX = 10_000;
/** Days are Europe/London days: the filters, the timeline's day headings and the CSV's local time. */
export const AUDIT_TIME_ZONE = "Europe/London";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const londonFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: AUDIT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function londonParts(ms: number) {
  const p: Record<string, string> = {};
  for (const x of londonFmt.formatToParts(ms)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
const pad = (n: number) => String(n).padStart(2, "0");

/** The Europe/London day (YYYY-MM-DD) an instant falls on; "" for nonsense. */
export function londonDay(iso: string | number): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const p = londonParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** "2026-10-09 15:05:03": an instant as UK wall-clock time (BST or GMT, whichever applied). */
export function londonStamp(iso: string | number): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const p = londonParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/** Midnight at the start of a Europe/London day, as a UTC ISO instant (BST-aware;
 *  the clocks change at 01:00 UTC, so midnight is never skipped or doubled). */
export function londonDayStart(ymd: string): string | null {
  if (!YMD_RE.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(guess)) return null;
  const p = londonParts(guess);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - guess;
  return new Date(guess - offset).toISOString();
}

/** The day after a YYYY-MM-DD day. */
export function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

const clampLimit = (n: number | undefined) => Math.min(AUDIT_PAGE_MAX, Math.max(1, Math.floor(Number.isFinite(n as number) ? (n as number) : AUDIT_PAGE)));

/** An Error auditFailure() reads (message + code). */
function historyError(error: { message?: unknown; code?: unknown } | null | undefined): Error & { code?: string } {
  const message = typeof error?.message === "string" && error.message ? error.message : "error";
  return Object.assign(new Error(message), { code: typeof error?.code === "string" ? error.code : "" });
}

export function listAuditEvents(query: AuditQuery): Promise<AuditPage> {
  if (!supabase) return demoList(query);
  return (async () => {
    const limit = clampLimit(query.limit);
    let q = supabase.from("audit_events").select(AUDIT_COLUMNS).eq("workspace_id", query.workspaceId);
    if (query.actorId === AUDIT_ACTOR_KANBO) q = q.is("actor_id", null);
    else if (query.actorId) q = q.eq("actor_id", query.actorId);
    if (query.actions?.length) q = q.in("action", query.actions);
    const from = query.from ? londonDayStart(query.from) : null;
    const to = query.to && YMD_RE.test(query.to) ? londonDayStart(nextDay(query.to)) : null;
    if (from) q = q.gte("created_at", from);
    if (to) q = q.lt("created_at", to);
    const c = query.before;
    if (c) {
      // keyset on (created_at, id), both descending; the timestamp goes back exactly as the
      // server wrote it (microseconds and all), quoted because it holds reserved characters
      if (!STAMP_RE.test(c.createdAt) || !UUID_RE.test(c.id)) throw historyError({ message: "invalid cursor" });
      q = q.or(`created_at.lt."${c.createdAt}",and(created_at.eq."${c.createdAt}",id.lt.${c.id})`);
    }
    const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
    if (error) throw historyError(error);
    const rows = (Array.isArray(data) ? data : []).map(parseAuditEvent).filter((e): e is AuditEvent => !!e);
    return pageOf(rows, limit);
  })();
}

function pageOf(rows: AuditEvent[], limit: number): AuditPage {
  const events = rows.slice(0, limit);
  const last = events[events.length - 1];
  return { events, next: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null };
}

/** Every event matching a query (all pages, up to AUDIT_EXPORT_MAX), for Export CSV. */
export async function exportAuditEvents(query: Omit<AuditQuery, "before" | "limit">, onProgress?: (n: number) => void): Promise<{ events: AuditEvent[]; truncated: boolean }> {
  const events: AuditEvent[] = [];
  let before: AuditCursor | null = null;
  for (;;) {
    const page: AuditPage = await listAuditEvents({ ...query, before, limit: AUDIT_PAGE_MAX });
    events.push(...page.events);
    onProgress?.(events.length);
    if (!page.next) return { events, truncated: false };
    if (events.length >= AUDIT_EXPORT_MAX) return { events: events.slice(0, AUDIT_EXPORT_MAX), truncated: true };
    before = page.next;
  }
}

/* ---------------- sentences ---------------- */

/** A piece of a sentence: plain text, or a name to set in bold. */
export type AuditPart = string | { strong: string };

const quoted = (s: string | null | undefined) => `“${(s ?? "").trim() || "Untitled"}”`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const ROLES = new Set(["owner", "admin", "member", "guest"]);
const asRole = (v: unknown) => (typeof v === "string" && ROLES.has(v) ? v : null);
const withArticle = (role: string) => (/^[aeiou]/.test(role) ? `an ${role}` : `a ${role}`);
const PROVIDERS: Record<string, string> = { slack: "Slack", notion: "Notion" };
const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: AUDIT_TIME_ZONE });
const dateWords = (v: unknown) => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? shortDate.format(ms) : null;
};

/** The timeline's sentence, in parts (names in bold). `you`: your user id, so your own actions read "You". */
export function auditParts(e: AuditEvent, opts: { you?: string | null } = {}): AuditPart[] {
  const actor: AuditPart = { strong: opts.you && e.actorId === opts.you ? "You" : e.actorName || "Someone" };
  const d = e.detail;
  const title = e.targetTitle;
  const who: AuditPart = { strong: title || text(d.email) || "someone" };
  const kindWord = e.action.startsWith("project.") ? "project" : "task";
  switch (e.action) {
    case "task.deleted": {
      const n = num(d.subtasks);
      return [actor, ` deleted the task ${quoted(title)}${n ? ` and ${plural(n, "sub-task")}` : ""}`];
    }
    case "project.deleted": {
      const n = num(d.tasks);
      return [actor, ` deleted the project ${quoted(title)}${n ? ` and its ${plural(n, "task")}` : ""}`];
    }
    case "task.restored": case "project.restored":
      return [actor, ` restored the ${kindWord} ${quoted(title)} from the recycle bin`];
    case "task.purged": case "project.purged":
      return d.expired === true
        ? [actor, ` cleared the ${kindWord} ${quoted(title)} from the recycle bin after ${TRASH_WORDS}`]
        : [actor, ` deleted the ${kindWord} ${quoted(title)} for good`];
    case "project.archived": return [actor, ` archived the project ${quoted(title)}`];
    case "project.unarchived": return [actor, ` unarchived the project ${quoted(title)}`];
    case "member.invited": {
      const role = asRole(d.role);
      return [actor, " invited ", who, role ? ` as ${withArticle(role)}` : ""];
    }
    case "member.joined": {
      const role = asRole(d.role);
      const as = role ? ` as ${withArticle(role)}` : "";
      return e.actorId && e.actorId === e.targetId
        ? [actor, ` joined the workspace${as}`]
        : [actor, " added ", who, as];
    }
    case "member.removed":
      if (d.account_deleted === true) return [who, " left: their account was deleted"];
      if (d.self === true) return [actor, " left the workspace"];
      if (d.invite === true) return [actor, " cancelled the invitation for ", who];
      return [actor, " removed ", who, " from the workspace"];
    case "role.changed": {
      const from = asRole(d.from), to = asRole(d.to);
      const target: AuditPart = opts.you && e.targetId === opts.you && e.actorId !== opts.you ? "your" : who;
      const tail = from && to ? ` role from ${from} to ${to}` : to ? ` role to ${to}` : " role";
      return target === "your" ? [actor, ` changed your${tail}`] : [actor, " changed ", target, `’s${tail}`];
    }
    case "workspace.renamed": {
      const from = text(d.from), to = text(d.to) ?? title;
      return from ? [actor, ` renamed the workspace from ${quoted(from)} to ${quoted(to)}`] : [actor, ` renamed the workspace to ${quoted(to)}`];
    }
    case "integration.connected": case "integration.disconnected": {
      const provider = PROVIDERS[String(d.provider)] ?? title ?? "an integration";
      const on = e.action === "integration.connected";
      const where = on ? (d.provider === "slack" ? text(d.channel) : d.provider === "notion" && text(d.notion_workspace) ? quoted(text(d.notion_workspace)) : null) : null;
      return [actor, ` ${on ? "connected" : "disconnected"} ${provider}${where ? ` (${where})` : ""}`];
    }
    case "api_key.created": return [actor, ` created the API key ${quoted(title)}`];
    case "api_key.revoked": return [actor, ` revoked the API key ${quoted(title)}`];
    case "webhook.created": return [actor, ` added a webhook to ${text(d.host) ?? title ?? "an endpoint"}`];
    case "webhook.deleted": return [actor, ` deleted the webhook to ${text(d.host) ?? title ?? "an endpoint"}`];
    default:
      return [actor, ` · ${auditActionLabel(e.action)}${title ? ` · ${title}` : ""}`];
  }
}
const TRASH_WORDS = "30 days";

/** One line for the timeline ("Olive Owner changed Sana Rao’s role from member to admin"). */
export function describeAuditEvent(e: AuditEvent, opts: { you?: string | null } = {}): string {
  return auditParts(e, opts).map((p) => (typeof p === "string" ? p : p.strong)).join("");
}

/** The quieter second line (and the CSV's Details): what the sentence leaves out. */
export function auditEventDetails(e: AuditEvent): string {
  const d = e.detail;
  const email = text(d.email);
  const out: string[] = [];
  switch (e.action) {
    case "task.restored": case "project.restored":
      if (text(d.note)) out.push(text(d.note)!);
      break;
    case "task.purged": case "project.purged": {
      const when = dateWords(d.deleted_at), by = text(d.deleted_by);
      if (when || by) out.push(`Deleted${when ? ` ${when}` : ""}${by ? ` by ${by}` : ""}`);
      break;
    }
    case "project.deleted": {
      const s = num(d.sections);
      if (s) out.push(plural(s, "section"));
      break;
    }
    case "member.invited": case "member.joined": case "role.changed":
      if (email && email !== e.targetTitle) out.push(email);
      break;
    case "member.removed": {
      if (email && email !== e.targetTitle) out.push(email);
      const role = asRole(d.role);
      if (role && d.invite !== true) out.push(`Was ${withArticle(role)}`);
      break;
    }
    case "api_key.created": case "api_key.revoked": {
      const access = d.access === "write" ? "Read and write" : d.access === "read" ? "Read only" : null;
      if (access) out.push(access);
      if (text(d.prefix)) out.push(`${text(d.prefix)}…`);
      const exp = dateWords(d.expires_at);
      if (exp && e.action === "api_key.created") out.push(`Expires ${exp}`);
      break;
    }
    case "webhook.created": case "webhook.deleted": {
      const evs = Array.isArray(d.events) ? d.events.filter((x): x is string => typeof x === "string") : [];
      if (evs.length) out.push(evs.join(", "));
      break;
    }
  }
  return out.join(" · ");
}

/** CSV of these events (Export CSV): a header row, then one row per event — the
 *  time in UTC (ISO 8601) and in UK time, who, the action, what it was about,
 *  the sentence and its details. UTF-8 with a byte-order mark, CRLF, every cell
 *  quoted (RFC 4180), and a cell that would run as a spreadsheet formula
 *  (= + - @ …) starts with an apostrophe. */
export function auditEventsToCsv(events: AuditEvent[]): string {
  const rows: unknown[][] = [["Time (UTC)", "Time (UK)", "Who", "Action", "What", "Summary", "Details"]];
  for (const e of events) {
    const ms = Date.parse(e.createdAt);
    rows.push([
      Number.isFinite(ms) ? new Date(ms).toISOString() : e.createdAt,
      londonStamp(e.createdAt),
      e.actorName,
      auditActionLabel(e.action),
      e.targetTitle ?? e.targetId ?? "",
      describeAuditEvent(e),
      auditEventDetails(e),
    ]);
  }
  return toCsv(rows);
}

/* ============================================================ demo (no Supabase) */

let DEMO_DELAY_MS = 300;
const demoScopes = new Map<string, AuditEvent[]>();

/** Tests: start the demo history afresh (and answer at once). */
export function resetAuditDemo(opts: { demoDelayMs?: number } = {}) {
  demoScopes.clear();
  DEMO_DELAY_MS = opts.demoDelayMs ?? 300;
}

type DemoEvent = [minutesAgo: number, actorId: string | null, action: AuditAction, targetKind: AuditTargetKind, target: string, detail?: Record<string, unknown>, targetId?: string];

function demoSeed(ws: string): AuditEvent[] {
  const have = demoScopes.get(ws);
  if (have) return have;
  const name = (id: string | null) => (id ? MEMBERS.find((m) => m.id === id)?.name ?? "Someone" : "Kanbo");
  const email = (id: string) => MEMBERS.find((m) => m.id === id)?.email ?? "";
  const H = 60, D = 24 * 60;
  const own = PROJECTS.filter((p) => p.workspaceId === ws);
  const proj = (id: string, fallback: string) => own.find((p) => p.id === id)?.name ?? own[0]?.name ?? fallback;
  const list: DemoEvent[] = ws === "ws-foundrise" || !own.length ? [
    [25, "m-1", "task.deleted", "task", "Draft press release", { subtasks: 2, project_id: "p-launch" }],
    [2 * H + 10, "m-self", "task.restored", "task", "Competitor teardown", { project_id: "p-launch", note: null }],
    [3 * H + 40, "m-2", "role.changed", "member", "Idris Bell", { from: "member", to: "guest", email: email("m-4") }, "m-4"],
    [D + 5 * H, "m-3", "project.archived", "project", "Spring campaign"],
    [D + 7 * H, "m-self", "webhook.created", "webhook", "hooks.zapier.com", { host: "hooks.zapier.com", events: ["task.created", "task.completed"] }],
    [2 * D + 2 * H, "m-self", "api_key.created", "api_key", "Zapier", { access: "write", prefix: "kb_live_7Hq2", expires_at: null }],
    [3 * D + H, "m-1", "integration.connected", "integration", "Slack", { provider: "slack", channel: "#launch" }, "slack"],
    [4 * D + 6 * H, "m-self", "project.deleted", "project", "Webinar series", { tasks: 9, sections: 2 }],
    [5 * D + 3 * H, null, "task.purged", "task", "Old onboarding checklist", { expired: true, deleted_at: new Date(Date.now() - 35 * DAY_MS).toISOString(), deleted_by: name("m-2") }],
    [6 * D + 2 * H, "m-2", "task.deleted", "task", "Fix flaky checkout test", { subtasks: 0, project_id: "p-infra" }],
    [8 * D + 4 * H, "m-self", "member.invited", "member", "priya@foundrise.co", { email: "priya@foundrise.co", role: "member" }],
    [9 * D, "u-priya", "member.joined", "member", "Priya Natarajan", { email: "priya@foundrise.co", role: "member" }, "u-priya"],
    [12 * D + 3 * H, "m-self", "workspace.renamed", "workspace", "Foundrise", { from: "Foundrise Labs", to: "Foundrise" }],
    [14 * D + 6 * H, "m-3", "task.deleted", "task", "Moodboard v1", { subtasks: 1, project_id: "p-brand" }],
    [16 * D + 2 * H, "m-1", "project.unarchived", "project", proj("p-infra", "Platform Infra")],
    [18 * D + 5 * H, "m-self", "integration.connected", "integration", "Notion", { provider: "notion", notion_workspace: "Foundrise wiki" }, "notion"],
    [20 * D + H, "m-2", "api_key.revoked", "api_key", "Old CI key", { access: "read", prefix: "kb_live_k2Lp" }],
    [23 * D + 4 * H, "m-self", "member.removed", "member", "Jordan Fry", { email: "jordan@foundrise.co", role: "member", invite: false, self: false, account_deleted: false }, "u-jordan"],
    [25 * D + 2 * H, "m-1", "webhook.deleted", "webhook", "hook.eu1.make.com", { host: "hook.eu1.make.com", events: ["task.updated"] }],
    [27 * D, null, "project.purged", "project", "Q2 retro board", { expired: true, deleted_at: new Date(Date.now() - 57 * DAY_MS).toISOString(), deleted_by: name("m-3") }],
    [41 * D + 3 * H, "u-ben", "member.removed", "member", "Ben Adeyemi", { email: "ben@foundrise.co", role: "member", invite: false, self: true, account_deleted: false }, "u-ben"],
    [63 * D, "m-self", "integration.disconnected", "integration", "Slack", { provider: "slack", channel: "#general" }, "slack"],
  ] : [
    [3 * H, "m-1", "task.deleted", "task", "A/B test the pricing page", { subtasks: 1 }],
    [2 * D, "m-self", "role.changed", "member", name("m-1"), { from: "member", to: "admin", email: email("m-1") }, "m-1"],
    [8 * D, "m-self", "project.deleted", "project", "Referral programme", { tasks: 5, sections: 1 }],
    [15 * D, "m-self", "member.invited", "member", email("m-1") || "maya@kanbo.app", { email: email("m-1") || "maya@kanbo.app", role: "member" }],
    [16 * D, "m-1", "member.joined", "member", name("m-1"), { email: email("m-1"), role: "member" }, "m-1"],
    [30 * D, "m-self", "workspace.renamed", "workspace", "Reco HQ", { from: "Reco", to: "Reco HQ" }],
  ];
  const actorNames: Record<string, string> = { "u-priya": "Priya Natarajan", "u-ben": "Ben Adeyemi" };
  const now = Date.now();
  const events = list.map(([ago, actorId, action, targetKind, target, detail = {}, targetId], i): AuditEvent => ({
    id: `audit-demo-${ws}-${String(i).padStart(3, "0")}`,
    workspaceId: ws,
    actorId,
    actorName: actorId ? actorNames[actorId] ?? name(actorId) : "Kanbo",
    action, targetKind,
    targetId: targetId ?? `${targetKind}-${i}`,
    targetTitle: target,
    detail,
    createdAt: new Date(now - ago * 60_000).toISOString(),
  })).sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
  demoScopes.set(ws, events);
  return events;
}
const DAY_MS = 86_400_000;

async function demoList(query: AuditQuery): Promise<AuditPage> {
  if (DEMO_DELAY_MS > 0) await new Promise((r) => setTimeout(r, DEMO_DELAY_MS));
  const limit = clampLimit(query.limit);
  const from = query.from ? londonDayStart(query.from) : null;
  const to = query.to && YMD_RE.test(query.to) ? londonDayStart(nextDay(query.to)) : null;
  const acts = query.actions?.length ? new Set<string>(query.actions) : null;
  const c = query.before;
  const rows = demoSeed(query.workspaceId).filter((e) =>
    (query.actorId === AUDIT_ACTOR_KANBO ? e.actorId === null : !query.actorId || e.actorId === query.actorId)
    && (!acts || acts.has(e.action))
    && (!from || e.createdAt >= from) && (!to || e.createdAt < to)
    && (!c || e.createdAt < c.createdAt || (e.createdAt === c.createdAt && e.id < c.id)));
  return pageOf(rows.slice(0, limit + 1).map((e) => ({ ...e, detail: { ...e.detail } })), limit);
}

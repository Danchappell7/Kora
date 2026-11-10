// ============================================================
// KANBO — Slack app: what it reads and writes in Kanbo.           [0049]
//
// Two connections, as the public API (api/db.ts):
//   service    the privileged connection, ONLY for the Slack side of things:
//              who a Slack user is linked to (slack_user_links), a Slack
//              workspace's Kanbo workspace (slack_teams), one-time link
//              requests (slack_link_requests), rate limits and event
//              de-duplication (api_rate_hit on rate_limits).
//   withUser   EVERYTHING about tasks, projects and people, as the linked
//              Kanbo person (SET LOCAL ROLE authenticated + their JWT
//              claims): RLS decides what exists. A team workspace's work is
//              pinned to the Slack workspace's Kanbo workspace
//              (kanbo.api_workspace, the API's "api key scope" policies), and
//              the Personal list runs unpinned but only ever touches the
//              person's own personal rows (RLS).
// Creating, completing and assigning go through the public API's own
// handlers (api/handlers.ts): the same validation, automation rules,
// webhooks and checks as POST /v1/tasks — the Slack app is just another
// way in, never a way round.
//
// Project access (0058): a link preview is read by the whole channel, so a
// card says whether its project is open to the whole workspace (closedProject:
// the switch is on and the project is Members only or Private). Both come
// from the row as JSON (to_jsonb), so a database before 0058 just says "open".
//
// Pure (Tx / UserDb are interfaces): the PGlite replay runs these against
// the real migrations (scratchpad/pgtest-slack), vitest the edges.
// ============================================================
import { ApiFail, pgFailure } from "./api/core.ts";
import { completeTask as apiComplete, createTaskWith, updateTask as apiUpdate } from "./api/handlers.ts";
import type { RouteContext } from "./api/router.ts";
import type { ApiTask } from "./api/serialise.ts";
import type { ApiPrincipal, Tx, UserDb } from "./api/types.ts";
import { escapeLike, isUuid, PERSONAL_PROJECT_ID } from "./api/validate.ts";
import type { HomeTask, Option, TaskCard } from "./slackAppBlocks.ts";
import type { Member, Project } from "./slackAppParse.ts";

export interface SlackDb extends UserDb {
  service: Tx;
}

/** A Slack id as Slack writes them (team T…/E…, user U…/W…, channel C…/G…/D…). */
export const SLACK_ID_RE = /^[A-Z0-9]{2,32}$/;
export const isSlackId = (v: unknown): v is string => typeof v === "string" && SLACK_ID_RE.test(v);

/** A database error that means 0049 (or 0046) hasn't been run. */
export function isMissingSchema(e: unknown): boolean {
  const code = String((e as { code?: unknown })?.code ?? "");
  return code === "42P01" || code === "42883" || code === "42703";
}

/* ------------------------------------------------------------ the Slack side (service) */

export interface SlackLink { userId: string; canAct: boolean; slackUserName: string | null }

/** Who this Slack person is in Kanbo (null = not linked). */
export async function findLink(service: Tx, teamId: string, slackUserId: string): Promise<SlackLink | null> {
  if (!isSlackId(teamId) || !isSlackId(slackUserId)) return null;
  const rs = await service.query<{ user_id: string; slack_user_name: string | null; can_act: boolean }>(
    `select l.user_id::text as user_id, l.slack_user_name, public.user_can_act(l.user_id) as can_act
       from public.slack_user_links l where l.team_id = $1 and l.slack_user_id = $2`, [teamId, slackUserId]);
  const r = rs[0];
  return r ? { userId: r.user_id, canAct: r.can_act === true, slackUserName: r.slack_user_name } : null;
}

export interface TeamInfo { teamId: string; teamName: string | null; workspaceId: string | null; workspaceName: string | null }

/** The Slack workspace's Kanbo workspace (null workspace = none chosen yet; a team never seen = all null). */
export async function teamInfo(service: Tx, teamId: string): Promise<TeamInfo> {
  if (!isSlackId(teamId)) return { teamId, teamName: null, workspaceId: null, workspaceName: null };
  const rs = await service.query<{ team_name: string | null; ws: string | null; ws_name: string | null }>(
    `select t.team_name, t.default_workspace_id::text as ws, w.name as ws_name
       from public.slack_teams t left join public.workspaces w on w.id = t.default_workspace_id
      where t.team_id = $1`, [teamId]);
  const r = rs[0];
  return { teamId, teamName: r?.team_name ?? null, workspaceId: r?.ws ?? null, workspaceName: r?.ws_name ?? null };
}

/**
 * A new one-time link (only its SHA-256 is stored). Earlier unused links for the same person stop working.
 * slackAdmin: Slack's own users.info said they're an owner or admin of the Slack workspace (false when
 * Slack didn't answer): the say-so slack_app_set_default needs to choose its Kanbo workspace.
 */
export async function createLinkRequest(service: Tx, r: {
  tokenHash: string; teamId: string; teamName?: string | null; slackUserId: string; slackUserName?: string | null; slackEmail?: string | null;
  slackAdmin?: boolean;
}): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(r.tokenHash) || !isSlackId(r.teamId) || !isSlackId(r.slackUserId)) throw new Error("createLinkRequest: invalid input");
  const cut = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);
  await service.query(
    `delete from public.slack_link_requests
      where (team_id = $1 and slack_user_id = $2 and used_at is null) or expires_at < now() - interval '1 day'`, [r.teamId, r.slackUserId]);
  await service.query(
    `insert into public.slack_link_requests (token_hash, team_id, team_name, slack_user_id, slack_user_name, slack_email, slack_admin)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [r.tokenHash, r.teamId, cut(r.teamName, 200), r.slackUserId, cut(r.slackUserName, 200), cut(r.slackEmail?.trim().toLowerCase(), 320), r.slackAdmin === true]);
}

/** How often a refresh that changes nothing still brings slack_admin_checked_at up to date. */
export const SLACK_ADMIN_TOUCH_MINUTES = 15;

/**
 * Keep a linked person's Slack owner/admin flag as Slack says it is, and when Slack said it
 * (slack_admin_checked_at: a "yes" Slack hasn't confirmed for 24 hours decides nothing, 0049
 * slack_admin_state). From users.info just now (`asOf` omitted: the database's clock), or from Slack's
 * user_change event (`asOf` = its event time, never later than now). A new Slack admin gains the say over
 * the Kanbo workspace, a former one loses it. Writes on a change, or to bring the time up to date (at most
 * every 15 minutes). A "yes" never overwrites a newer answer (Slack can deliver events late); a "no" always
 * applies (taking the say away is the safe direction). Never fails the request it rides on.
 */
export async function refreshSlackAdmin(service: Tx, teamId: string, slackUserId: string, slackAdmin: boolean, asOf?: Date | null): Promise<void> {
  if (!isSlackId(teamId) || !isSlackId(slackUserId)) return;
  const at = asOf && Number.isFinite(asOf.getTime()) ? asOf.toISOString() : null;
  try {
    await service.query(
      `update public.slack_user_links l
          set slack_admin = $3, slack_admin_checked_at = s.at
         from (select least(coalesce($4::timestamptz, now()), now()) as at) s
        where l.team_id = $1 and l.slack_user_id = $2
          and (not $3 or l.slack_admin_checked_at is null or l.slack_admin_checked_at <= s.at)
          and (l.slack_admin is distinct from $3 or l.slack_admin_checked_at is null
               or l.slack_admin_checked_at < s.at - interval '${SLACK_ADMIN_TOUCH_MINUTES} minutes')`,
      [teamId, slackUserId, slackAdmin === true, at]);
  } catch {
    // a refresh that fails changes nothing: the flag (and its age) stay as they were
  }
}

/** One hit on a fixed window (0046 api_rate_hit). Fails open: a limiter problem never blocks someone. */
export async function rateHit(service: Tx, key: string, windowSec: number, max: number): Promise<{ allowed: boolean; retryAfter: number }> {
  try {
    const rs = await service.query<{ allowed: boolean; retry_after: number }>(`select * from public.api_rate_hit($1, $2, $3)`, [key, windowSec, max]);
    const r = rs[0];
    return r ? { allowed: r.allowed !== false, retryAfter: Number(r.retry_after) || 0 } : { allowed: true, retryAfter: 0 };
  } catch {
    return { allowed: true, retryAfter: 0 };
  }
}

/** Slack resends an event it thinks we missed: true the first time we see this event id (for an hour). */
export async function firstTimeSeen(service: Tx, eventId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9]{3,64}$/.test(eventId)) return true;
  try {
    const rs = await service.query<{ allowed: boolean }>(`select * from public.api_rate_hit($1, 3600, 1)`, [`kanbo:api:slack:evt:${eventId}`]);
    return rs[0]?.allowed !== false;
  } catch {
    return true;
  }
}

/**
 * A signed request seen before (a replay inside Slack's 5-minute window)? Slack never sends the same
 * signature twice: its retries are signed afresh. True the first time; fails open.
 */
export async function firstTimeSigned(service: Tx, signature: string): Promise<boolean> {
  const hex = /^v0=([0-9a-f]{64})$/.exec(signature)?.[1];
  if (!hex) return true;
  try {
    const rs = await service.query<{ allowed: boolean }>(`select * from public.api_rate_hit($1, 600, 1)`, [`kanbo:api:slack:sig:${hex}`]);
    return rs[0]?.allowed !== false;
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------ as the person */

/** Run as the person: pinned to the team workspace, or (null) unpinned for the Personal list. */
const asPerson = <T>(db: SlackDb, userId: string, ws: string | null, readOnly: boolean, fn: (tx: Tx) => Promise<T>) =>
  db.withUser({ userId, workspaceId: ws, readOnly }, fn);

const MEMBER_NAME = `coalesce(nullif(btrim(coalesce(pr.first_name, '') || ' ' || coalesce(pr.last_name, '')), ''), nullif(m.name, ''), m.email)`;
/** a task's project (tasks.project_id is text: a uuid, or "p-personal"); visibility (0058) read as JSON, null before it */
const PROJECT_JOIN = `left join lateral (
    select p.name, p.emoji, to_jsonb(p) ->> 'visibility' as visibility from public.projects p
     where case when t.project_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p.id = t.project_id::uuid else false end
  ) p on true`;
const ASSIGNEE_NAME = `(select ${MEMBER_NAME} from public.workspace_members m left join public.profiles pr on pr.id = m.user_id
    where t.workspace_id is not null and m.workspace_id = t.workspace_id and m.user_id::text = t.assignee_id limit 1)`;

export interface WorkspaceContext { role: string; projects: Project[]; members: Member[] }

/** The person's role in the team workspace, its live projects and its active members (for #project / @person). */
export async function workspaceContext(db: SlackDb, userId: string, ws: string): Promise<WorkspaceContext> {
  return asPerson(db, userId, ws, true, async (tx) => {
    const role = String((await tx.query<{ role: string }>(`select public.ws_role($1::uuid) as role`, [ws]))[0]?.role ?? "none");
    if (role === "none") return { role, projects: [], members: [] };
    const projects = await tx.query<Project>(
      `select p.id::text as id, p.name, p.emoji from public.projects p
        where p.workspace_id = $1::uuid and p.archived_at is null order by p.created_at, p.id limit 500`, [ws]);
    const members = await tx.query<Member>(
      `select m.user_id::text as id, ${MEMBER_NAME} as name, m.email
         from public.workspace_members m left join public.profiles pr on pr.id = m.user_id
        where m.workspace_id = $1::uuid and m.status = 'active' and m.user_id is not null
        order by m.created_at, m.id limit 1000`, [ws]);
    return { role, projects, members };
  });
}

/** Projects for the modal's picker: the Personal list, then the team workspace's live projects matching `q`. */
export async function projectOptions(db: SlackDb, userId: string, ws: string | null, q: string): Promise<Option[]> {
  const query = String(q ?? "").trim().slice(0, 80);
  const personal: Option[] = !query || "personal".startsWith(query.toLowerCase()) ? [{ text: "📥 Personal (only you)", value: PERSONAL_PROJECT_ID }] : [];
  if (!ws) return personal;
  const rows = await asPerson(db, userId, ws, true, (tx) => tx.query<{ id: string; name: string; emoji: string | null }>(
    `select p.id::text as id, p.name, p.emoji from public.projects p
      where p.workspace_id = $1::uuid and p.archived_at is null and ($2 = '' or p.name ilike '%' || $2 || '%' escape '\\')
      order by lower(p.name), p.id limit 99`, [ws, escapeLike(query)]));
  return [...personal, ...rows.map((r) => ({ text: `${r.emoji || "📁"} ${r.name}`, value: r.id }))];
}

/** People for the modal's picker: you first, then the team workspace's active members matching `q`. */
export async function memberOptions(db: SlackDb, userId: string, ws: string | null, q: string): Promise<Option[]> {
  const query = String(q ?? "").trim().slice(0, 80);
  if (!ws) return [{ text: "You", value: userId }];
  const rows = await asPerson(db, userId, ws, true, (tx) => tx.query<{ id: string; name: string }>(
    `select m.user_id::text as id, ${MEMBER_NAME} as name
       from public.workspace_members m left join public.profiles pr on pr.id = m.user_id
      where m.workspace_id = $1::uuid and m.status = 'active' and m.user_id is not null and m.role <> 'guest'
        and ($2 = '' or ${MEMBER_NAME} ilike '%' || $2 || '%' escape '\\' or m.email ilike '%' || $2 || '%' escape '\\')
      order by (m.user_id = $3::uuid) desc, lower(${MEMBER_NAME}), m.id limit 100`, [ws, escapeLike(query), userId]));
  return rows.map((r) => ({ text: r.id === userId ? `${r.name} (you)` : r.name, value: r.id }));
}

/** Where a task lives, as the person sees it: null = they can't see it. */
export async function taskScope(db: SlackDb, userId: string, taskId: string): Promise<{ workspaceId: string | null } | null> {
  if (!isUuid(taskId)) return null;
  const rs = await asPerson(db, userId, null, true, (tx) => tx.query<{ ws: string | null }>(
    `select t.workspace_id::text as ws from public.tasks t where t.id = $1::uuid`, [taskId]));
  return rs.length ? { workspaceId: rs[0].ws ?? null } : null;
}

export interface CardRow {
  id: string; title: string; status: string; priority: string; workspace_id: string | null; due_date: string | null; due_time: string | null;
  assignee_id: string | null; user_id: string; created_at: string | Date; project_name: string | null; project_emoji: string | null; assignee_name: string | null;
  /** 0058: the project's visibility and the workspace's switch, as JSON text (null before 0058) */
  project_visibility?: string | null; access_on?: string | null;
}
/** the workspace's Project access switch (0058) as JSON text: "true" / "false", null before 0058 */
const ACCESS_ON = (ws: string) => `(select to_jsonb(paw) ->> 'project_access' from public.workspaces paw where paw.id = ${ws})`;
const CARD_COLS = `t.id::text as id, t.title, t.status, t.priority, t.workspace_id::text as workspace_id, t.due_date::text as due_date, t.due_time,
  t.assignee_id, t.user_id::text as user_id, t.created_at, p.name as project_name, p.emoji as project_emoji, ${ASSIGNEE_NAME} as assignee_name,
  p.visibility as project_visibility, ${ACCESS_ON("t.workspace_id")} as access_on`;

/** Is a project closed to the whole workspace (0058: the switch on, and Members only or Private)? */
export const isClosedProject = (accessOn: unknown, visibility: unknown) =>
  String(accessOn ?? "") === "true" && typeof visibility === "string" && visibility !== "" && visibility !== "workspace";

export interface LoadedCard extends TaskCard {
  workspaceId: string | null; createdBy: string; createdAt: string;
  /** its project isn't open to the whole workspace (0058): a channel sees a neutral card */
  closedProject: boolean;
}
/**
 * A row → a card. assigneeName is the assignee's real name, never "You": a link preview is read by the
 * whole channel, not just the person who shared it. The cards only that person sees (their own
 * confirmation, the Home tab) say "You" from assignedToMe (cardFacts).
 */
export function toCard(r: CardRow, me: string): LoadedCard {
  const created = r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? "");
  return {
    id: r.id, title: r.title || "Untitled task", status: r.status, priority: r.priority,
    projectName: r.project_name, projectEmoji: r.project_emoji, personal: r.workspace_id == null,
    dueDate: r.due_date, dueTime: r.due_time, assigneeName: r.assignee_name,
    assignedToMe: !!r.assignee_id && r.assignee_id === me, workspaceId: r.workspace_id, createdBy: r.user_id, createdAt: created,
    closedProject: isClosedProject(r.access_on, r.project_visibility),
  };
}

/** A task as a card, as the person sees it, inside `ws` (null = only their own Personal list). */
export async function loadCard(db: SlackDb, userId: string, ws: string | null, taskId: string): Promise<LoadedCard | null> {
  if (!isUuid(taskId)) return null;
  const rs = await asPerson(db, userId, ws, true, (tx) => tx.query<CardRow>(
    `select ${CARD_COLS} from public.tasks t ${PROJECT_JOIN}
      where t.id = $1::uuid and t.archived_at is null
        and (case when $2::uuid is null then t.workspace_id is null else t.workspace_id = $2::uuid end)`, [taskId, ws]));
  return rs[0] ? toCard(rs[0], userId) : null;
}

/** A project link's preview data (team workspace only); closedProject: not open to the whole workspace (0058). */
export async function loadProjectCard(db: SlackDb, userId: string, ws: string, projectId: string) {
  if (!isUuid(projectId)) return null;
  const rs = await asPerson(db, userId, ws, true, (tx) => tx.query<{ id: string; name: string; emoji: string | null; description: string | null; open: number; done: number; visibility: string | null; access_on: string | null }>(
    `select p.id::text as id, p.name, p.emoji, p.description, to_jsonb(p) ->> 'visibility' as visibility, ${ACCESS_ON("p.workspace_id")} as access_on,
            (select count(*)::int from public.tasks t where t.project_id = p.id::text and t.parent_id is null and t.archived_at is null and t.status <> 'done') as open,
            (select count(*)::int from public.tasks t where t.project_id = p.id::text and t.parent_id is null and t.archived_at is null and t.status = 'done') as done
       from public.projects p where p.id = $1::uuid and p.workspace_id = $2::uuid and p.archived_at is null`, [projectId, ws]));
  const r = rs[0];
  return r ? {
    id: r.id, name: r.name, emoji: r.emoji, description: r.description, openCount: Number(r.open) || 0, doneCount: Number(r.done) || 0,
    closedProject: isClosedProject(r.access_on, r.visibility),
  } : null;
}

/** App Home: what's due today or overdue for the person (assigned to them in the team workspace, or in their Personal list). */
export async function homeTasks(db: SlackDb, userId: string, ws: string | null, today: string): Promise<{ tasks: HomeTask[]; more: number }> {
  const rs = await asPerson(db, userId, null, true, (tx) => tx.query<CardRow>(
    `select ${CARD_COLS} from public.tasks t ${PROJECT_JOIN}
      where t.status <> 'done' and t.archived_at is null and t.due_date is not null and t.due_date <= $3::date
        and ((t.workspace_id is null and t.user_id = $1::uuid)
          or ($2::uuid is not null and t.workspace_id = $2::uuid and t.assignee_id = $1::text))
      order by t.due_date, case t.priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, t.created_at, t.id
      limit 21`, [userId, ws, today]));
  const tasks = rs.slice(0, 20).map((r) => ({ ...toCard(r, userId), overdue: !!r.due_date && r.due_date < today }));
  return { tasks, more: rs.length > 20 ? 1 : 0 };
}

/* ------------------------------------------------------------ writes, through the API's handlers */

export interface WriteDeps { db: SlackDb; appUrl: string; apiBase: string }

/** A Kanbo-shaped refusal: a sentence safe to show in Slack. */
export class SlackWriteError extends Error {
  constructor(message: string, public kind: "invalid" | "forbidden" | "not_found" | "failed" = "failed", public fields: Record<string, string> = {}) {
    super(message);
    this.name = "SlackWriteError";
  }
}

function ctxFor(d: WriteDeps, userId: string, ws: string | null, method: "POST" | "PATCH", opts: { id?: string; path?: string; body?: Record<string, unknown> }): RouteContext {
  const url = new URL(`${d.apiBase.replace(/\/+$/, "")}/tasks${opts.id ? `/${opts.id}` : ""}${opts.path ?? ""}`);
  const principal: ApiPrincipal = { keyId: "slack-app", userId, workspaceId: ws, access: "write" };
  return {
    req: new Request(url, { method }), url, method, params: opts.id ? { id: opts.id } : {}, principal,
    db: d.db, service: d.db.service, requestId: "slack", appUrl: d.appUrl, apiBase: d.apiBase, body: opts.body ?? {},
  };
}

function fieldsOf(e: ApiFail): Record<string, string> {
  const f = (e.details as { fields?: Record<string, unknown> } | undefined)?.fields ?? {};
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)]));
}

/** ApiFail / Postgres error → SlackWriteError (never the SQL). Anything else is rethrown. */
function translate(e: unknown): never {
  const fail = e instanceof ApiFail ? e : pgFailure(e);
  if (!fail) throw e;
  if (fail.status === 422) {
    const fields = fieldsOf(fail);
    const first = Object.values(fields)[0];
    throw new SlackWriteError(first || fail.message, "invalid", fields);
  }
  if (fail.status === 404) throw new SlackWriteError("Kanbo couldn't find that task, or you can't see it any more.", "not_found");
  if (fail.status === 403) throw new SlackWriteError(fail.message.startsWith("Guests") ? fail.message : "You can't change that in Kanbo.", "forbidden");
  throw new SlackWriteError("Kanbo couldn't do that just now. Try again in a moment.", "failed");
}

async function body(res: Response): Promise<ApiTask> {
  return (await res.json()) as ApiTask;
}

export interface NewTask {
  title: string;
  description?: string;
  /** a project id in the team workspace, or "p-personal" */
  projectId: string;
  assigneeId?: string | null;
  dueDate?: string;
  dueTime?: string;
  startDate?: string;
  priority?: string;
  effortHours?: number;
}

/** Make a task as the person (POST /v1/tasks's handler); the Personal list runs unpinned. */
export async function createTask(d: WriteDeps, userId: string, ws: string | null, t: NewTask, slackPermalink?: string | null): Promise<ApiTask> {
  const personal = t.projectId === PERSONAL_PROJECT_ID;
  const b: Record<string, unknown> = { title: t.title, projectId: personal ? null : t.projectId };
  if (t.description) b.description = t.description;
  if (t.assigneeId) b.assigneeId = t.assigneeId;
  else if (personal) b.assigneeId = "me";
  if (t.dueDate) b.dueDate = t.dueDate;
  if (t.dueTime && t.dueDate) b.dueTime = t.dueTime;
  if (t.startDate && (!t.dueDate || t.startDate <= t.dueDate)) b.startDate = t.startDate;
  if (t.priority) b.priority = t.priority;
  if (t.effortHours !== undefined) b.effortHours = t.effortHours;
  try {
    return await body(await createTaskWith(ctxFor(d, userId, personal ? null : ws, "POST", { body: b }), { slackPermalink: slackPermalink ?? null }));
  } catch (e) { return translate(e); }
}

export async function completeTask(d: WriteDeps, userId: string, ws: string | null, taskId: string): Promise<ApiTask> {
  try { return await body(await apiComplete(ctxFor(d, userId, ws, "POST", { id: taskId, path: "/complete" }))); } catch (e) { return translate(e); }
}

export async function assignToMe(d: WriteDeps, userId: string, ws: string | null, taskId: string): Promise<ApiTask> {
  try { return await body(await apiUpdate(ctxFor(d, userId, ws, "PATCH", { id: taskId, body: { assigneeId: "me" } }))); } catch (e) { return translate(e); }
}

/** Undo a /kanbo task: only its maker, only within ~2 minutes; it goes to the recycle bin (0047's trigger). The title, or null. */
export async function undoCreate(db: SlackDb, userId: string, ws: string | null, taskId: string): Promise<string | null> {
  if (!isUuid(taskId)) return null;
  try {
    const rs = await asPerson(db, userId, ws, false, (tx) => tx.query<{ title: string }>(
      `delete from public.tasks t
        where t.id = $1::uuid and t.user_id = $2::uuid and t.parent_id is null and t.created_at > now() - interval '150 seconds'
          and (case when $3::uuid is null then t.workspace_id is null else t.workspace_id = $3::uuid end)
        returning t.title`, [taskId, userId, ws]));
    return rs[0]?.title ?? null;
  } catch (e) {
    const f = pgFailure(e);
    if (f) return null;
    throw e;
  }
}

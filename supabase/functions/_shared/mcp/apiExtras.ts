// ============================================================
// KANBO — the MCP server's own routes on the REST pipeline.
//
// Reads and writes the public REST API doesn't have, mounted only on the pipeline
// the tools call (never on the public API's route table):
//
//   GET    /my-day                 overdue, due today, approvals, planned, blocked
//   GET    /me/timezone            the person's saved time zone
//   GET    /search?q=              tasks and projects (search_all from 0048 when it's
//                                  there, a plain search when it isn't)
//   GET    /tasks/:id/blockers     the unfinished tasks this one waits for
//   GET    /tasks/:id/comments/recent  newest first, the cursor walks back
//   PATCH  /tasks/:id/tool         PATCH /tasks/:id, plus adding to the description
//                                  and refusing a shortened copy of it
//   POST   /tasks/:id/comments/tool    POST /tasks/:id/comments, plus @names read exactly
//   DELETE /tasks/:id/bin          into the recycle bin (handlers.ts binTask)
//
// They go through handleApiRequest like every other route, so rate limits, the
// read-only check and the "as the person, with RLS" transaction are the same.
// A one-workspace connection is filtered for here as well as by the "api key
// scope" policies, which don't cover approvals or task_user_state: both are
// always read joined to tasks, which they do cover.
//
// Pure module: exercised against the real migrations by the PGlite suite.
// ============================================================
import { asUser, badQuery, invalid, keyWorkspace, notFound, ok } from "../api/core.ts";
import {
  binTask, createCommentWith, inKeyWs, listRecentComments, savedZone, serialiseTasks, TASK_COLS, updateTaskWith, type CommentMentions,
} from "../api/handlers.ts";
import type { Route, RouteContext } from "../api/router.ts";
import { projectUrl, taskUrl } from "../api/serialise.ts";
import { API_LIMITS, escapeLike, isUuid, oneLine, parseLimit, text, unknownParams, type FieldErrors } from "../api/validate.ts";
import { dateInZone, DEFAULT_TIMEZONE, isTimeZone, MY_DAY_CAPS, planMyDay, type MyDayApproval, type MyDayCounts, type MyDayTask } from "./myDay.ts";
import { readMentions, type Named } from "./names.ts";
import { CUT_COPY_REFUSAL, isCutCopy } from "./text.ts";

type Row = Record<string, unknown>;

export async function getMyDay(ctx: RouteContext): Promise<Response> {
  const sp = ctx.url.searchParams;
  const extra = unknownParams(sp, ["timezone"]);
  if (extra.length) throw badQuery(Object.fromEntries(extra.map((k) => [k, "Unknown query parameter."])));
  const asked = sp.get("timezone");
  if (asked && !isTimeZone(asked)) throw badQuery({ timezone: "Use a time zone name like Europe/London." });
  const p = ctx.principal;
  const kws = keyWorkspace(p);
  const day = await asUser(ctx, async (tx) => {
    const saved = asked ? null : await savedZone(tx, p.userId);
    const timezone = asked || saved || DEFAULT_TIMEZONE;
    const today = dateInZone(new Date(), timezone);
    const [have] = await tx.query<{ plans: boolean; approvals: boolean }>(
      `select to_regclass('public.task_user_state') is not null as plans, to_regclass('public.approvals') is not null as approvals`);
    const openDep = `exists (select 1 from public.task_dependencies d join public.tasks o on o.id = d.depends_on
        where d.task_id = t.id and o.status <> 'done' and o.archived_at is null)`;
    const plan = have?.plans
      ? { cols: `s.plan_today as st_plan_today, s.plan_day::text as st_plan_day, s.scheduled as st_scheduled`,
          join: `left join public.task_user_state s on s.task_id = t.id and s.user_id = $1::uuid`,
          mine: `or (s.plan_today is true and s.plan_day = $3::date)`,
          // on your own tasks the plan is on the row; on someone else's it's yours alone, for one day
          planned: `case when t.assignee_id = $2 then t.plan_today is true else (s.plan_today is true and s.plan_day = $3::date) end`,
          slot: `case when t.assignee_id = $2 then t.scheduled when s.plan_day = $3::date then s.scheduled end` }
      : { cols: `null::boolean as st_plan_today, null::text as st_plan_day, null::int as st_scheduled`, join: `left join (select $1::uuid as u) s on true`, mine: ``,
          planned: `(t.assignee_id = $2 and t.plan_today is true)`, slot: `t.scheduled` };
    // Which list each task is in, the same rule as planMyDay, so each list has its own limit and its own true count
    const bucket = `case when t.due_date < $3::date then 'overdue'
        when t.due_date = $3::date then 'dueToday'
        when ${plan.planned} then 'planned'
        when t.status = 'blocked' or ${openDep} then 'blocked' end`;
    const priority = `case t.priority when 'urgent' then 0 when 'high' then 1 when 'low' then 3 else 2 end`;
    const rows = await tx.query<Row>(
      `select * from (
         select ${TASK_COLS}, t.plan_today as row_plan_today, t.scheduled as row_scheduled, ${plan.cols},
           (select o.title from public.task_dependencies d join public.tasks o on o.id = d.depends_on
             where d.task_id = t.id and o.status <> 'done' and o.archived_at is null order by o.due_date nulls last, o.id limit 1) as blocked_by,
           b.bucket,
           count(*) over (partition by b.bucket) as bucket_count,
           row_number() over (partition by b.bucket order by
             case when b.bucket = 'dueToday' then coalesce(t.due_time, '99') else '' end,
             case when b.bucket = 'planned' then coalesce(${plan.slot}, 100000) else 0 end,
             ${priority}, t.due_date nulls last, t.title, t.id) as bucket_rank
         from public.tasks t ${plan.join}
         cross join lateral (select ${bucket} as bucket) b
         where t.archived_at is null and t.status <> 'done' and ${inKeyWs("t.workspace_id", 4)}
           and ((t.assignee_id = $2 and (t.due_date <= $3::date or t.plan_today or t.status = 'blocked' or ${openDep})) ${plan.mine})
       ) x
       where x.bucket is not null and x.bucket_rank <= case x.bucket
         when 'overdue' then ${MY_DAY_CAPS.overdue} when 'dueToday' then ${MY_DAY_CAPS.dueToday}
         when 'planned' then ${MY_DAY_CAPS.planned} else ${MY_DAY_CAPS.blocked} end`, [p.userId, p.userId, today, kws]);
    const totals: MyDayCounts = { overdue: 0, dueToday: 0, approvals: 0, planned: 0, blocked: 0 };
    for (const r of rows) totals[String(r.bucket) as keyof MyDayCounts] = Number(r.bucket_count) || 0;
    const tasks = await serialiseTasks(ctx, tx, rows);
    const planned: MyDayTask[] = tasks.map((task, i) => {
      const r = rows[i];
      const mine = task.assigneeId === p.userId;
      const isPlanned = mine ? r.row_plan_today === true : r.st_plan_today === true && r.st_plan_day === today;
      const slot = mine ? r.row_scheduled : r.st_plan_day === today ? r.st_scheduled : null;
      return {
        task,
        planned: isPlanned,
        scheduled: typeof slot === "number" ? slot : null,
        blockedBy: typeof r.blocked_by === "string" ? r.blocked_by : null,
      };
    });
    let approvals: MyDayApproval[] = [];
    if (have?.approvals) {
      const asks = await tx.query<Row>(
        `select a.id::text as id, a.task_id::text as task_id, coalesce(nullif(a.title, ''), t.title) as title, a.created_at::text as created_at,
                t.status, t.priority, t.due_date::text as due_date, t.due_time, t.project_id, t.workspace_id::text as workspace_id,
                nullif(btrim(coalesce(pr.first_name, '') || ' ' || coalesce(pr.last_name, '')), '') as requester,
                count(*) over () as how_many
           from public.approval_reviewers r
           join public.approvals a on a.id = r.approval_id
           join public.tasks t on t.id = a.task_id
           left join public.profiles pr on pr.id = a.requested_by
          where r.user_id = $1::uuid and r.decision is null and a.status = 'pending' and t.archived_at is null
            and ${inKeyWs("a.workspace_id", 2)}
          order by a.created_at, a.id limit ${MY_DAY_CAPS.approvals}`, [p.userId, kws]);
      totals.approvals = Number(asks[0]?.how_many) || 0;
      approvals = asks.map((a) => ({
        id: String(a.id),
        taskId: String(a.task_id),
        title: String(a.title ?? ""),
        createdAt: String(a.created_at ?? ""),
        requester: typeof a.requester === "string" ? a.requester : null,
        status: String(a.status ?? "todo"),
        priority: String(a.priority ?? "medium"),
        dueDate: typeof a.due_date === "string" ? a.due_date : null,
        dueTime: typeof a.due_time === "string" ? a.due_time.slice(0, 5) : null,
        projectId: typeof a.project_id === "string" ? a.project_id : null,
        workspaceId: typeof a.workspace_id === "string" ? a.workspace_id : null,
        url: taskUrl(String(a.task_id), { appUrl: ctx.appUrl }),
      }));
    }
    return planMyDay({ today, timezone, tasks: planned, approvals, totals });
  });
  return ok(ctx, day);
}

/** GET /me/timezone: the zone add_task reads "today" in, so it agrees with my_day. */
async function getTimezone(ctx: RouteContext): Promise<Response> {
  if (unknownParams(ctx.url.searchParams, []).length) throw badQuery({ query: "This endpoint takes no query parameters." });
  const timezone = await asUser(ctx, (tx) => savedZone(tx, ctx.principal.userId));
  return ok(ctx, { object: "timezone", timezone });
}

/** GET /tasks/:id/blockers: the unfinished tasks this one waits for, that this person can see (as the app counts them). */
async function getBlockers(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id;
  if (!isUuid(id)) throw notFound("Task");
  if (unknownParams(ctx.url.searchParams, []).length) throw badQuery({ query: "This endpoint takes no query parameters." });
  const kws = keyWorkspace(ctx.principal);
  const out = await asUser(ctx, async (tx) => {
    const t = await tx.query<{ status: string }>(`select t.status from public.tasks t where t.id = $1::uuid and ${inKeyWs("t.workspace_id", 2)}`, [id.toLowerCase(), kws]);
    if (!t[0]) throw notFound("Task");
    const rows = await tx.query<{ id: string; title: string }>(
      `select o.id::text as id, o.title from public.task_dependencies d join public.tasks o on o.id = d.depends_on
        where d.task_id = $1::uuid and o.status <> 'done' and o.archived_at is null and ${inKeyWs("o.workspace_id", 2)}
        order by o.due_date nulls last, o.id limit 21`, [id.toLowerCase(), kws]);
    return { status: t[0].status, rows };
  });
  return ok(ctx, { object: "list", status: out.status, data: out.rows.slice(0, 20), hasMore: out.rows.length > 20 });
}

/** PATCH /tasks/:id, plus appendToDescription, and a shortened copy of the description refused. */
async function updateTaskForTool(ctx: RouteContext): Promise<Response> {
  const { appendToDescription: _a, confirmReplaceDescription: confirm, ...rest } = (ctx.body ?? {}) as Record<string, unknown>;
  const fields: FieldErrors = {};
  const append = text((ctx.body ?? {}) as Record<string, unknown>, "appendToDescription", fields, { max: API_LIMITS.description, min: 1, multiline: true }) ?? undefined;
  if (Object.keys(fields).length) throw invalid(fields);
  if (append !== undefined && "description" in rest) throw invalid({ appendToDescription: "Send description or appendToDescription, not both." });
  return updateTaskWith({ ...ctx, body: rest }, {
    appendDescription: append,
    refuseDescription: confirm === true ? undefined : (stored, next) => (isCutCopy(stored, next) ? CUT_COPY_REFUSAL : null),
  });
}

/** Who a comment's @names mean: the task's workspace's active people, exactly. */
const mentionsFromText: CommentMentions = async (tx, body, workspaceId) => {
  const nothing = { ids: [], answer: { mentioned: [], notes: [] } };
  if (!/(^|[\s(\[,;:])@\p{L}/u.test(body)) return nothing;
  let people: Named[] = [];
  if (workspaceId) {
    people = (await tx.query<{ id: string; name: string }>(
      `select m.user_id::text as id,
              coalesce(nullif(btrim(coalesce(pr.first_name, '') || ' ' || coalesce(pr.last_name, '')), ''), nullif(m.name, ''), m.email) as name
         from public.workspace_members m left join public.profiles pr on pr.id = m.user_id
        where m.workspace_id = $1::uuid and m.status = 'active' and m.user_id is not null limit 2000`, [workspaceId]));
  }
  const read = readMentions(body, people);
  return { ids: read.people.map((m) => m.id), answer: { mentioned: read.people.map((m) => m.name), notes: read.notes } };
};

const createCommentForTool = (ctx: RouteContext) => createCommentWith(ctx, mentionsFromText);

/** The highlight markers search_all puts round its matches. */
// deno-lint-ignore no-control-regex
const stripMarks = (s: string) => s.replace(/[]/g, "");

export interface SearchHit { kind: "task" | "project"; id: string; title: string; url: string | null }

export async function searchEverything(ctx: RouteContext): Promise<Response> {
  const sp = ctx.url.searchParams;
  const extra = unknownParams(sp, ["q", "limit"]);
  if (extra.length) throw badQuery(Object.fromEntries(extra.map((k) => [k, "Unknown query parameter."])));
  const q = oneLine(sp.get("q") ?? "");
  if (!q) throw badQuery({ q: "Say what to search for." });
  if (q.length > 200) throw badQuery({ q: "Search for at most 200 characters." });
  const limit = parseLimit(sp.get("limit"));
  if (limit === null) throw badQuery({ limit: "Use a whole number from 1 to 100." });
  const n = Math.min(limit, 25);
  const kws = keyWorkspace(ctx.principal);
  const out = await asUser(ctx, async (tx): Promise<SearchHit[]> => {
    const [have] = await tx.query<{ on: boolean }>(`select to_regprocedure('public.search_all(text,jsonb,integer)') is not null as "on"`);
    const hits = new Map<string, SearchHit>();
    const add = (h: SearchHit) => { if (hits.size < n && !hits.has(`${h.kind}:${h.id}`)) hits.set(`${h.kind}:${h.id}`, h); };
    if (have?.on) {
      // 0048's ranked search, narrowed to what a tool can show; it's SECURITY INVOKER, so RLS and the scope apply
      const filters: Record<string, unknown> = { kinds: ["task", "comment", "project"] };
      if (kws) filters.workspace_id = kws;
      const rows = await tx.query<Row>(
        `select s.kind, s.id::text as id, s.title, s.task_id::text as task_id, s.project_id, s.workspace_id::text as workspace_id
           from public.search_all($1, $2::jsonb, $3::int) s`, [q, JSON.stringify(filters), Math.min(n * 2, 50)]);
      // a comment's hit is shown as its task; its title comes from the task
      const taskIds = [...new Set(rows.filter((r) => r.kind === "comment" && r.task_id).map((r) => String(r.task_id)))];
      const titles = new Map<string, string>();
      if (taskIds.length) {
        const ts = await tx.query<{ id: string; title: string }>(
          `select t.id::text as id, t.title from public.tasks t where t.id in (select (jsonb_array_elements_text($1::jsonb))::uuid) and ${inKeyWs("t.workspace_id", 2)}`,
          [JSON.stringify(taskIds), kws]);
        for (const t of ts) titles.set(t.id, t.title);
      }
      for (const r of rows) {
        if (kws && r.workspace_id !== kws) continue;
        if (r.kind === "task") add({ kind: "task", id: String(r.id), title: stripMarks(String(r.title ?? "")), url: taskUrl(String(r.id), { appUrl: ctx.appUrl }) });
        else if (r.kind === "comment" && r.task_id && titles.has(String(r.task_id))) add({ kind: "task", id: String(r.task_id), title: titles.get(String(r.task_id))!, url: taskUrl(String(r.task_id), { appUrl: ctx.appUrl }) });
        else if (r.kind === "project") {
          const id = String(r.project_id ?? r.id);
          add({ kind: "project", id, title: stripMarks(String(r.title ?? "")), url: projectUrl(id, { appUrl: ctx.appUrl }) });
        }
      }
      return [...hits.values()];
    }
    // before 0048: a plain search
    const like = `%${escapeLike(q)}%`;
    const tasks = await tx.query<Row>(
      `select t.id::text as id, t.title from public.tasks t
        where t.archived_at is null and (t.title ilike $1 escape '\\' or t.description ilike $1 escape '\\') and ${inKeyWs("t.workspace_id", 2)}
        order by t.updated_at desc, t.id limit $3::int`, [like, kws, n]);
    for (const t of tasks) add({ kind: "task", id: String(t.id), title: String(t.title ?? ""), url: taskUrl(String(t.id), { appUrl: ctx.appUrl }) });
    const projects = await tx.query<Row>(
      `select p.id::text as id, p.name from public.projects p
        where p.archived_at is null and p.name ilike $1 escape '\\' and ${inKeyWs("p.workspace_id", 2)}
        order by p.created_at desc, p.id limit $3::int`, [like, kws, n]);
    for (const p of projects) add({ kind: "project", id: String(p.id), title: String(p.name ?? ""), url: projectUrl(String(p.id), { appUrl: ctx.appUrl }) });
    return [...hits.values()];
  });
  return ok(ctx, { object: "list", data: out });
}

export const mcpExtraRoutes: Route[] = [
  { method: "GET", path: "/my-day", handler: getMyDay, summary: "What needs doing today" },
  { method: "GET", path: "/me/timezone", handler: getTimezone, summary: "The person's saved time zone" },
  { method: "GET", path: "/search", handler: searchEverything, summary: "Search tasks and projects" },
  { method: "GET", path: "/tasks/:id/blockers", handler: getBlockers, summary: "What a task waits for" },
  { method: "GET", path: "/tasks/:id/comments/recent", handler: listRecentComments, summary: "A task's comments, newest first" },
  { method: "PATCH", path: "/tasks/:id/tool", handler: updateTaskForTool, summary: "Update a task, from a tool" },
  { method: "POST", path: "/tasks/:id/comments/tool", handler: createCommentForTool, summary: "Comment on a task, from a tool" },
  { method: "DELETE", path: "/tasks/:id/bin", handler: binTask, summary: "Move a task to the recycle bin" },
];

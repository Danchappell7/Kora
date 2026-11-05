// ============================================================
// KANBO — the MCP server's own routes on the REST pipeline.
//
// Three reads and writes the public REST API doesn't have, mounted only on the
// pipeline the tools call (never on the public API's route table):
//
//   GET    /my-day            overdue, due today, approvals, planned, blocked
//   GET    /search?q=         tasks and projects (search_all from 0048 when it's
//                             there, a plain search when it isn't)
//   DELETE /tasks/:id/bin     into the recycle bin (handlers.ts binTask)
//
// They go through handleApiRequest like every other route, so rate limits, the
// read-only check and the "as the person, with RLS" transaction are the same.
// A one-workspace connection is filtered for here as well as by the "api key
// scope" policies, which don't cover approvals or task_user_state: both are
// always read joined to tasks, which they do cover.
//
// Pure module: exercised against the real migrations by the PGlite suite.
// ============================================================
import { asUser, badQuery, keyWorkspace, ok } from "../api/core.ts";
import { binTask, inKeyWs, serialiseTasks, TASK_COLS } from "../api/handlers.ts";
import type { Route, RouteContext } from "../api/router.ts";
import { projectUrl, taskUrl } from "../api/serialise.ts";
import type { Tx } from "../api/types.ts";
import { escapeLike, oneLine, parseLimit, unknownParams } from "../api/validate.ts";
import { dateInZone, DEFAULT_TIMEZONE, isTimeZone, planMyDay, type MyDayApproval, type MyDayTask } from "./myDay.ts";

type Row = Record<string, unknown>;

/** Their saved time zone (notify_prefs.timezone, 0048), if any. Reads the row as JSON so nothing depends on 0048. */
async function savedZone(tx: Tx, me: string): Promise<string | null> {
  const rs = await tx.query<{ tz: string | null }>(
    `select to_jsonb(p) -> 'notify_prefs' ->> 'timezone' as tz from public.profiles p where p.id = $1::uuid`, [me]);
  return rs[0]?.tz ?? null;
}

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
    const timezone = asked || (isTimeZone(saved) ? saved : DEFAULT_TIMEZONE);
    const today = dateInZone(new Date(), timezone);
    const [have] = await tx.query<{ plans: boolean; approvals: boolean }>(
      `select to_regclass('public.task_user_state') is not null as plans, to_regclass('public.approvals') is not null as approvals`);
    const openDep = `exists (select 1 from public.task_dependencies d join public.tasks o on o.id = d.depends_on
        where d.task_id = t.id and o.status <> 'done' and o.archived_at is null)`;
    const plan = have?.plans
      ? { cols: `s.plan_today as st_plan_today, s.plan_day::text as st_plan_day, s.scheduled as st_scheduled`,
          join: `left join public.task_user_state s on s.task_id = t.id and s.user_id = $1::uuid`,
          mine: `or (s.plan_today is true and s.plan_day = $3::date)` }
      : { cols: `null::boolean as st_plan_today, null::text as st_plan_day, null::int as st_scheduled`, join: `left join (select $1::uuid as u) s on true`, mine: `` };
    const rows = await tx.query<Row>(
      `select ${TASK_COLS}, t.plan_today as row_plan_today, t.scheduled as row_scheduled, ${plan.cols},
         (select o.title from public.task_dependencies d join public.tasks o on o.id = d.depends_on
           where d.task_id = t.id and o.status <> 'done' and o.archived_at is null order by o.due_date nulls last, o.id limit 1) as blocked_by
       from public.tasks t ${plan.join}
       where t.archived_at is null and t.status <> 'done' and ${inKeyWs("t.workspace_id", 4)}
         and ((t.assignee_id = $2 and (t.due_date <= $3::date or t.plan_today or t.status = 'blocked' or ${openDep})) ${plan.mine})
       order by t.due_date nulls last, t.id limit 200`, [p.userId, p.userId, today, kws]);
    const tasks = await serialiseTasks(ctx, tx, rows);
    const planned: MyDayTask[] = tasks.map((task, i) => {
      const r = rows[i];
      const mine = task.assigneeId === p.userId;
      // on your own tasks the plan is on the row; on someone else's it's yours alone, for one day
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
                nullif(btrim(coalesce(pr.first_name, '') || ' ' || coalesce(pr.last_name, '')), '') as requester
           from public.approval_reviewers r
           join public.approvals a on a.id = r.approval_id
           join public.tasks t on t.id = a.task_id
           left join public.profiles pr on pr.id = a.requested_by
          where r.user_id = $1::uuid and r.decision is null and a.status = 'pending' and t.archived_at is null
            and ${inKeyWs("a.workspace_id", 2)}
          order by a.created_at, a.id limit 50`, [p.userId, kws]);
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
    return planMyDay({ today, timezone, tasks: planned, approvals });
  });
  return ok(ctx, day);
}

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
  { method: "GET", path: "/search", handler: searchEverything, summary: "Search tasks and projects" },
  { method: "DELETE", path: "/tasks/:id/bin", handler: binTask, summary: "Move a task to the recycle bin" },
];

// ============================================================
// KANBO — 0058, project access, attacked on the real migrations (PGlite).
//
// One world (§7.2 of the wave-4 design): a team workspace W (owner O) with an
// admin, four members, three guests, a removed member and a suspended one, an
// outsider from another workspace, four projects (Whole workspace, Members
// only, Private, and a Private one a member owns) and two loose tasks, each
// with everything that hangs off a project. One battery reads and writes every
// path as every person; one model (src/lib/projectAccessMatrix.json, the same
// table the app tests) says what each should get. With the switch off the
// battery must equal the run before 0058 existed (the live database replayed:
// 0001..0050), with it on it must equal the model, and off again it must equal
// the first run (the rollback loses nothing and changes nothing). Then the
// functions, triggers, notices, webhooks, the bin, meetings, search and the
// people a guest sees; then performance; then 0058 again, the undo file, and
// every older file run again.
//
// projectAccessSuite(pg, files, t) runs on a database built from `files`. When
// 0058 isn't among them (0001..0050, the live database), it takes the reference
// run first, applies 0058 itself, and at the end applies 0051..0057 after it.
// ============================================================
import { applyFile, makeUser, migrationFiles, migrationSql, WITH_USER_SQL, type Pg } from "./harness.ts";
import MATRIX from "../../../src/lib/projectAccessMatrix.json";

export interface Checks {
  test(name: string, fn: () => Promise<void>): Promise<void>;
  eq(a: unknown, b: unknown, what?: string): void;
  ok(v: unknown, what?: string): void;
  raises(p: Promise<unknown>, like: RegExp): Promise<void>;
}

const WHO = ["O", "A", "ME", "MC", "MV", "M2", "GC", "GV", "G2", "R", "S", "X"] as const;
type Who = (typeof WHO)[number];
const PROJ = ["PW", "PM", "PP", "PQ"] as const;
type Proj = (typeof PROJ)[number];
const SPOTS = [...PROJ, "L1", "L2"] as const;
type Spot = (typeof SPOTS)[number];
type Role = "editor" | "commenter" | "viewer";

const NAME: Record<Who | "O2", string> = {
  O: "Oona", A: "Ari", ME: "Meg", MC: "Mac", MV: "Viv", M2: "Moe", GC: "Gail", GV: "Gwen", G2: "Gil", R: "Rex", S: "Sid", X: "Xan", O2: "Ola",
};
const WS_ROLE: Record<Who, string> = {
  O: "owner", A: "admin", ME: "member", MC: "member", MV: "member", M2: "member", GC: "guest", GV: "guest", G2: "guest", R: "none", S: "none", X: "none",
};
const MEMBERS: Record<Proj, Partial<Record<Who, Role>>> = {
  PW: { GC: "commenter" },
  PM: { ME: "editor", MC: "commenter", MV: "viewer", GC: "commenter", GV: "viewer" },
  PP: { ME: "editor", R: "editor", S: "editor" },
  PQ: {},
};
const OWNER: Record<Proj, Who> = { PW: "O", PM: "O", PP: "O", PQ: "ME" };
const VIS: Record<Proj, string> = { PW: "workspace", PM: "members", PP: "private", PQ: "private" };
const isProj = (s: string): s is Proj => (PROJ as readonly string[]).includes(s);
const staff = (w: Who) => ["owner", "admin", "member"].includes(WS_ROLE[w]);

type Row = { on: boolean; wsRole: string; visibility: string | null; isOwner: boolean; memberRole: string | null; rank: number };
const ROWS = MATRIX as Row[];
/** The model: a person's rank on a spot, from the shared table. */
function rank(who: Who, spot: Spot, on: boolean): number {
  const vis = isProj(spot) ? VIS[spot] : null;
  const isOwner = isProj(spot) && OWNER[spot] === who;
  const mem = isProj(spot) ? MEMBERS[spot][who] ?? null : null;
  const r = ROWS.find((x) => x.on === on && x.wsRole === WS_ROLE[who] && x.visibility === vis && x.isOwner === isOwner && x.memberRole === mem);
  if (!r) throw new Error(`no matrix row for ${who} ${spot}`);
  return r.rank;
}

interface World {
  id: Record<Who | "O2", string>;
  ws: string; ws2: string;
  proj: Record<Proj, string>;
  task: Record<Spot, string>;        // T_<spot>
  sub: Record<Proj, string>;         // ST_<spot>
  comment: Record<Proj, string>;
  update: Record<Proj, string>;
  doc: Record<Proj, string>;
  rows: Record<string, Partial<Record<Spot, string[]>>>;   // what each table holds per spot (by its key column)
  key: Record<string, string>;
  invite: string;
}

class Rollback extends Error { constructor(public rows: Record<string, unknown>[]) { super("rollback"); } }
type Outcome = { rows: Record<string, unknown>[] } | { error: string; code?: string };
const errOf = (o: Outcome) => ("error" in o ? o.error : "");
const okOf = (o: Outcome) => !("error" in o) && o.rows.length > 0;

export async function projectAccessSuite(pg: Pg, files: string[], t: Checks): Promise<void> {
  const { test, eq, ok, raises } = t;
  const before0058 = !files.some((f) => f.startsWith("0058"));
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0];
  const has = async (rel: string) => (await one<{ ok: boolean }>(`select to_regclass($1) is not null as ok`, [`public.${rel}`])).ok;
  const hasFn = async (sig: string) => (await one<{ ok: boolean }>(`select to_regprocedure($1) is not null as ok`, [sig])).ok;
  const claims = (u: string) => JSON.stringify({ sub: u, role: "authenticated" });

  /** As someone (null: the service role / SQL editor), in a transaction that's always rolled back. */
  async function attempt(who: string | null, sql: string, params: unknown[] = [], setup: [string, unknown[]][] = []): Promise<Outcome> {
    try {
      await pg.transaction(async (tx) => {
        for (const [s, p] of setup) await tx.query(s, p);
        if (who) await tx.query(WITH_USER_SQL, [claims(who), ""]);
        const r = await tx.query(sql, params);
        throw new Rollback(r.rows as Record<string, unknown>[]);
      });
    } catch (e) {
      if (e instanceof Rollback) return { rows: e.rows };
      return { error: String((e as Error).message), code: (e as { code?: string }).code };
    }
    return { error: "no result" };
  }
  /** Several steps, each as someone (null: the service role / SQL editor), in one transaction that's
   *  always rolled back: the world is as it was afterwards. */
  type Run = (who: string | null, sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  /** (tryRun: one step that may raise, in a savepoint, so the scenario goes on) */
  async function scenario<T>(fn: (run: Run, exec: (sql: string) => Promise<unknown>, tryRun: (who: string | null, sql: string, params?: unknown[]) => Promise<Outcome>) => Promise<T>): Promise<T> {
    let out: T | undefined;
    try {
      await pg.transaction(async (tx) => {
        const run: Run = async (who, sql, params = []) => {
          await tx.query(`reset role`);
          await tx.query(`select set_config('request.jwt.claims', '', true)`);
          if (who) await tx.query(WITH_USER_SQL, [claims(who), ""]);
          return (await tx.query(sql, params)).rows as Record<string, unknown>[];
        };
        const tryRun = async (who: string | null, sql: string, params: unknown[] = []): Promise<Outcome> => {
          await tx.query(`savepoint pa_try`);
          try {
            const rows = await run(who, sql, params);
            await tx.query(`release savepoint pa_try`);
            return { rows };
          } catch (e) {
            await tx.query(`rollback to savepoint pa_try`);
            return { error: String((e as Error).message), code: (e as { code?: string }).code };
          }
        };
        out = await fn(run, async (sql) => { await tx.query(`reset role`); await tx.query(`select set_config('request.jwt.claims', '', true)`); return tx.exec(sql); }, tryRun);
        throw new Rollback([]);
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    return out as T;
  }
  /** As someone, for real (committed). */
  async function as<T = Record<string, unknown>>(who: string, sql: string, params: unknown[] = []): Promise<T[]> {
    return pg.transaction(async (tx) => {
      await tx.query(WITH_USER_SQL, [claims(who), ""]);
      return (await tx.query<T>(sql, params)).rows;
    }) as Promise<T[]>;
  }
  const mismatches = (got: Record<string, string>, want: Record<string, string>, only?: (k: string) => boolean) => {
    const out: string[] = [];
    for (const k of Object.keys(want)) if ((!only || only(k)) && got[k] !== want[k]) out.push(`${k}: got ${got[k]}, wanted ${want[k]}`);
    return out;
  };
  const noMismatch = (list: string[], what: string) => {
    if (list.length) throw new Error(`${what}: ${list.length} differ: ${list.slice(0, 8).join(" ; ")}${list.length > 8 ? " …" : ""}`);
  };

  // ---------------------------------------------------------------- the world
  const tables = {
    has48: await has("saved_views"), has52: await has("goal_links"), has53: await has("update_asks"),
    has54: await has("status_update_comments"), has55: await has("bill_rates"), has56: await has("meetings"),
  };
  const w = await buildWorld();

  async function buildWorld(): Promise<World> {
    const id = {} as World["id"];
    for (const k of [...WHO, "O2"] as const) {
      id[k] = await makeUser(pg, `${k.toLowerCase()}.pa@example.org`, NAME[k]);
      await pg.query(`update public.profiles set approved = true, first_name = $2, email = $3 where id = $1::uuid`, [id[k], NAME[k], `${k.toLowerCase()}.pa@example.org`]);
    }
    const ws = (await one<{ id: string }>(`insert into public.workspaces (name, owner_id) values ('Paddock', $1::uuid) returning id::text as id`, [id.O])).id;
    const ws2 = (await one<{ id: string }>(`insert into public.workspaces (name, owner_id) values ('Yonder', $1::uuid) returning id::text as id`, [id.O2])).id;
    const member = (wsId: string, who: Who | "O2", role: string) =>
      pg.query(`insert into public.workspace_members (workspace_id, user_id, email, name, role, status) values ($1::uuid, $2::uuid, $3, $4, $5, 'active')`,
        [wsId, id[who], `${who.toLowerCase()}.pa@example.org`, NAME[who], role]);
    await member(ws, "O", "owner");
    await member(ws, "A", "admin");
    for (const m of ["ME", "MC", "MV", "M2", "R", "S"] as const) await member(ws, m, "member");
    for (const g of ["GC", "GV", "G2"] as const) await member(ws, g, "guest");
    await member(ws2, "O2", "owner");
    await member(ws2, "X", "member");
    const invite = (await one<{ id: string }>(`insert into public.workspace_members (workspace_id, email, name, role, status) values ($1::uuid, 'inv.pa@example.org', 'Ivy', 'guest', 'invited') returning id::text as id`, [ws])).id;

    const proj = {} as Record<Proj, string>;
    const contrib: Record<Proj, Who[]> = { PW: ["GC"], PM: ["ME", "MC", "MV", "GC", "GV"], PP: ["ME", "R", "S"], PQ: [] };
    // (made in this order, a second apart: PGlite's clock moves in milliseconds, and "the workspace's first project" mustn't be a tie)
    for (const [i, p] of PROJ.entries()) {
      proj[p] = (await one<{ id: string }>(
        `insert into public.projects (user_id, owner_id, name, workspace_id, contributor_ids, description, created_at)
         values ($1::uuid, $1::uuid, $2, $3::uuid, $4::uuid[], 'zebra project', now() - make_interval(secs => $5)) returning id::text as id`,
        [id[OWNER[p]], `Zebra ${p}`, ws, contrib[p].map((x) => id[x]), 60 - i])).id;
    }
    const rows: World["rows"] = {};
    const key: World["key"] = {};
    const put = (t: string, s: Spot, v: string, k = "id") => { key[t] = k; ((rows[t] ??= {})[s] ??= []).push(v); };
    const task = {} as Record<Spot, string>, sub = {} as Record<Proj, string>, comment = {} as Record<Proj, string>;
    const update = {} as Record<Proj, string>, doc = {} as Record<Proj, string>;
    const mkTask = async (title: string, by: Who, project: string, assignee: string, extra: { parent?: string; collaborators?: string[]; status?: string } = {}) =>
      (await one<{ id: string }>(
        `insert into public.tasks (user_id, title, status, priority, project_id, assignee_id, workspace_id, parent_id, collaborators)
         values ($1::uuid, $2, $3, 'medium', $4, $5, $6::uuid, $7::uuid, $8::text[]) returning id::text as id`,
        [id[by], title, extra.status ?? "todo", project, assignee, ws, extra.parent ?? null, extra.collaborators ?? []])).id;
    const assignee: Record<Proj, Who> = { PW: "A", PM: "ME", PP: "ME", PQ: "ME" };
    for (const p of PROJ) {
      const by = OWNER[p];
      task[p] = await mkTask(`Zebra plan ${p}`, by, proj[p], id[assignee[p]], { collaborators: p === "PW" ? [id.MC] : [], status: "done" });
      sub[p] = await mkTask(`Sub ${p}`, by, proj[p], "nobody", { parent: task[p] });
      put("tasks", p, task[p]); put("tasks", p, sub[p]);
      const author: Who = p === "PM" ? "MC" : by;
      comment[p] = (await one<{ id: string }>(`insert into public.comments (task_id, user_id, body) values ($1::uuid, $2::uuid, $3) returning id::text as id`,
        [task[p], id[author], `zebra note ${p}`])).id;
      put("comments", p, comment[p]);
      put("attachments", p, (await one<{ id: string }>(`insert into public.attachments (task_id, user_id, name, path) values ($1::uuid, $2::uuid, 'f.txt', $3) returning id::text as id`,
        [task[p], id[by], `${id[by]}/${task[p]}/f.txt`])).id);
      put("task_events", p, (await one<{ id: string }>(`insert into public.task_events (task_id, actor_id, actor_name, field, old_value, new_value) values ($1::uuid, $2::uuid, 'x', 'status', 'todo', 'done') returning id::text as id`,
        [task[p], id[by]])).id);
      put("subtasks", p, (await one<{ id: string }>(`insert into public.subtasks (task_id, title) values ($1::uuid, 'tick') returning id::text as id`, [task[p]])).id);
      await pg.query(`insert into public.task_dependencies (task_id, depends_on) values ($1::uuid, $2::uuid)`, [sub[p], task[p]]);
      put("task_dependencies", p, sub[p], "task_id");
      for (const tb of ["sections", "custom_field_defs", "automation_rules", "forms"]) {
        const cols = tb === "custom_field_defs" ? "(user_id, workspace_id, project_id, name, type)" : "(user_id, workspace_id, project_id, name)";
        const vals = tb === "custom_field_defs" ? "($1::uuid, $2::uuid, $3, 'Zebra field', 'text')" : "($1::uuid, $2::uuid, $3, 'Zebra')";
        put(tb, p, (await one<{ id: string }>(`insert into public.${tb} ${cols} values ${vals} returning id::text as id`, [id[by], ws, proj[p]])).id);
      }
      update[p] = (await one<{ id: string }>(`insert into public.status_updates (user_id, workspace_id, project_id, summary, status) values ($1::uuid, $2::uuid, $3, $4, 'on_track') returning id::text as id`,
        [id[by], ws, proj[p], `Zebra update ${p}`])).id;
      put("status_updates", p, update[p]);
      doc[p] = (await one<{ id: string }>(`insert into public.project_docs (project_id, workspace_id, title, body, created_by) values ($1::uuid, $2::uuid, $3, '[]'::jsonb, $4::uuid) returning id::text as id`,
        [proj[p], ws, `Zebra doc ${p}`, id[by]])).id;
      put("project_docs", p, doc[p]);
      put("project_doc_versions", p, (await one<{ id: string }>(`insert into public.project_doc_versions (doc_id, title, body, saved_by) values ($1::uuid, 'v1', '[]'::jsonb, $2::uuid) returning id::text as id`,
        [doc[p], id[by]])).id);
      const reviewer: Who = p === "PW" || p === "PM" ? "MC" : p === "PP" ? "ME" : "O";
      const appr = (await one<{ id: string }>(`insert into public.approvals (task_id, workspace_id, requested_by, title) values ($1::uuid, $2::uuid, $3::uuid, 'Sign off') returning id::text as id`,
        [task[p], ws, id[by]])).id;
      put("approvals", p, appr);
      await pg.query(`insert into public.approval_reviewers (approval_id, user_id) values ($1::uuid, $2::uuid)`, [appr, id[reviewer]]);
      put("approval_reviewers", p, appr, "approval_id");
      put("projects", p, proj[p]);
      put("audit_events", p, (await one<{ id: string }>(`insert into public.audit_events (workspace_id, actor_id, actor_name, action, target_kind, target_id, target_title) values ($1::uuid, $2::uuid, 'Oona', 'task.renamed', 'task', $3, 'Zebra plan') returning id::text as id`,
        [ws, id.O, task[p]])).id);
    }
    for (const l of ["L1", "L2"] as const) {
      task[l] = await mkTask(`Zebra loose ${l}`, "O", l === "L1" ? "p-personal" : "8f8f8f8f-1111-4222-8333-444444444444", "nobody");
      put("tasks", l, task[l]);
    }
    // Notion: a connected workspace, a sync per project, a link and a cached page per task
    await pg.query(`insert into public.workspace_integrations (workspace_id, notion_token) values ($1::uuid, 'secret_' || repeat('p', 30)) on conflict (workspace_id) do update set notion_token = excluded.notion_token`, [ws]);
    for (const p of PROJ) {
      put("notion_syncs", p, (await one<{ id: string }>(`insert into public.notion_syncs (workspace_id, project_id, database_id, created_by) values ($1::uuid, $2::uuid, gen_random_uuid()::text, $3::uuid) returning id::text as id`,
        [ws, proj[p], id.O])).id);
      const page = (await one<{ id: string }>(`select gen_random_uuid()::text as id`)).id;
      put("notion_links", p, (await one<{ id: string }>(`insert into public.notion_links (workspace_id, task_id, notion_page_id) values ($1::uuid, $2::uuid, $3) returning id::text as id`,
        [ws, task[p], page])).id);
      await pg.query(`insert into public.notion_page_cache (workspace_id, notion_page_id, title) values ($1::uuid, $2, 'Zebra page')`, [ws, page]);
      put("notion_page_cache", p, page, "notion_page_id");
    }
    const world: World = { id, ws, ws2, proj, task, sub, comment, update, doc, rows, key, invite };
    await extend(world);
    return world;
  }

  /** Rows on the tables of 0048, 0052..0055 (where they're in; after 0051..0057 in the run without them). */
  async function extend(x: World) {
    const put = (t: string, s: Spot, v: string, k = "id") => { x.key[t] = k; ((x.rows[t] ??= {})[s] ??= []).push(v); };
    const fresh = (t: string) => !x.rows[t];
    if ((await has("kudos")) && fresh("kudos")) {
      for (const p of PROJ) {
        const to = p === "PW" ? x.id.A : x.id.ME;
        put("kudos", p, (await one<{ id: string }>(`insert into public.kudos (task_id, workspace_id, from_user, to_user) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid) returning id::text as id`,
          [x.task[p], x.ws, x.id.O, to])).id);
      }
    }
    if ((await has("saved_views")) && fresh("saved_views")) {
      for (const p of PROJ) {
        put("saved_views", p, (await one<{ id: string }>(`insert into public.saved_views (workspace_id, user_id, name, kind, query, shared) values ($1::uuid, $2::uuid, 'Zebra view', 'project', $3::jsonb, true) returning id::text as id`,
          [x.ws, x.id.O, JSON.stringify({ v: 1, projectId: x.proj[p] })])).id);
      }
    }
    if ((await has("goal_links")) && fresh("goal_links")) {
      const goal = (await one<{ id: string }>(`insert into public.goals (user_id, workspace_id, name) values ($1::uuid, $2::uuid, 'Zebra goal') returning id::text as id`, [x.id.O, x.ws])).id;
      for (const p of PROJ) {
        put("goal_links", p, (await one<{ id: string }>(`insert into public.goal_links (goal_id, kind, target_id) values ($1::uuid, 'project', $2) returning id::text as id`, [goal, x.proj[p]])).id);
        put("goal_links", p, (await one<{ id: string }>(`insert into public.goal_links (goal_id, kind, target_id) values ($1::uuid, 'task', $2) returning id::text as id`, [goal, x.task[p]])).id);
      }
    }
    if ((await has("update_asks")) && fresh("update_asks")) {
      for (const p of PROJ) {
        put("update_asks", p, (await one<{ id: string }>(`insert into public.update_asks (project_id, workspace_id, asked_by, owner_id) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid) returning id::text as id`,
          [x.proj[p], x.ws, x.id.O, x.id[OWNER[p]]])).id);
      }
    }
    if ((await has("bill_rates")) && fresh("bill_rates")) {
      for (const p of PROJ) {
        put("bill_rates", p, (await one<{ id: string }>(`insert into public.bill_rates (workspace_id, project_id, hourly_rate) values ($1::uuid, $2::uuid, 80) returning id::text as id`,
          [x.ws, x.proj[p]])).id);
      }
    }
    if ((await has("status_update_comments")) && fresh("status_update_comments")) {
      for (const p of PROJ) {
        put("status_update_comments", p, (await one<{ id: string }>(`insert into public.status_update_comments (update_id, user_id, body) values ($1::uuid, $2::uuid, 'zebra reply') returning id::text as id`,
          [x.update[p], x.id.O])).id);
        await pg.query(`insert into public.status_update_reactions (update_id, user_id, emoji) values ($1::uuid, $2::uuid, '👍')`, [x.update[p], x.id.O]);
        put("status_update_reactions", p, x.update[p], "update_id");
        await pg.query(`insert into public.status_update_views (update_id, user_id) values ($1::uuid, $2::uuid)`, [x.update[p], x.id.MC]);
        put("status_update_views", p, x.update[p], "update_id");
      }
    }
  }

  /** The roles and visibility of §7.2, the removed member and the suspended one (after 0058 is in). */
  async function configure() {
    await pg.query(`update public.project_members set role = 'commenter' where project_id = $1::uuid and user_id = $2::uuid`, [w.proj.PM, w.id.MC]);
    await pg.query(`update public.project_members set role = 'viewer' where project_id = $1::uuid and user_id in ($2::uuid, $3::uuid)`, [w.proj.PM, w.id.MV, w.id.GV]);
    for (const p of ["PM", "PP", "PQ"] as const) await pg.query(`update public.projects set visibility = $2 where id = $1::uuid`, [w.proj[p], VIS[p]]);
    // R was removed (their rows went with them) and S suspended; each keeps a stale editor row on PP,
    // planted past the triggers, to prove a row grants nothing on its own
    await pg.query(`delete from public.workspace_members where workspace_id = $1::uuid and user_id = $2::uuid`, [w.ws, w.id.R]).catch(() => undefined);
    await pg.query(`update public.profiles set suspended = true where id = $1::uuid`, [w.id.S]);
    await pg.exec(`set session_replication_role = replica`);
    for (const who of ["R", "S"] as const) {
      await pg.query(`insert into public.project_members (project_id, workspace_id, user_id, role) values ($1::uuid, $2::uuid, $3::uuid, 'editor') on conflict (project_id, user_id) do nothing`,
        [w.proj.PP, w.ws, w.id[who]]);
    }
    await pg.exec(`set session_replication_role = default`);
  }

  // ---------------------------------------------------------------- the battery and its model
  const TABLE_LIST = () => Object.keys(w.rows).filter((t) => t !== "audit_events" || true);
  /** What a person may see of a table's rows on a spot (the model). */
  function sees(table: string, who: Who, spot: Spot, on: boolean): boolean {
    const r = rank(who, spot, on);
    switch (table) {
      case "goal_links": return staff(who) && r >= 1;
      case "bill_rates": return ["owner", "admin"].includes(WS_ROLE[who]) && r >= 1;
      case "update_asks": return who === "O" || (isProj(spot) && OWNER[spot] === who);
      case "audit_events": return who === "O" || (WS_ROLE[who] === "admin" && r >= 1);
      default: return r >= 1;
    }
  }
  const visiblePeople = (who: Who, on: boolean): string[] => {
    if (WS_ROLE[who] === "none") return who === "S" ? ["S"] : [];
    if (on && WS_ROLE[who] === "guest") {
      if (who === "GC") return ["A", "GC", "GV", "MC", "ME", "MV", "O"];
      if (who === "GV") return ["GC", "GV", "MC", "ME", "MV", "O"];
      return ["G2", "O"];
    }
    return ["A", "G2", "GC", "GV", "M2", "MC", "ME", "MV", "O", "S"];
  };
  const visibleProfiles = (who: Who, on: boolean): string[] => {
    if (who === "X") return ["X"];
    if (who === "R") return ["R"];
    if (who === "S") return ["A", "G2", "GC", "GV", "M2", "MC", "ME", "MV", "O", "S"];   // (a suspended person reads profiles as before: 0025's rule)
    return visiblePeople(who, on);
  };

  const people = (ids: string[]) => {
    const back = new Map(Object.entries(w.id).map(([k, v]) => [v, k]));
    return ids.map((i) => back.get(i)).filter((x): x is string => !!x && x !== "O2").sort();
  };

  async function battery(opts: { search: boolean; realtime: boolean; post: boolean }): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const spotsOf = (t: string) => Object.keys(w.rows[t]) as Spot[];
    for (const who of WHO) {
      const u = w.id[who];
      // reads: every table, every spot
      for (const tb of TABLE_LIST()) {
        if (!(await has(tb))) continue;
        const map: Record<string, string[]> = {};
        for (const s of spotsOf(tb)) map[s] = w.rows[tb][s]!;
        const extra = tb === "audit_events" ? " and t.action not like 'project_access.%' and t.action not like 'project.%'" : "";
        const r = await attempt(u, `select j.key as k, (select count(*)::int from public.${tb} t where t.${w.key[tb]}::text in (select jsonb_array_elements_text(j.value))${extra}) as n from jsonb_each($1::jsonb) j`,
          [JSON.stringify(map)]);
        if ("error" in r) { for (const s of spotsOf(tb)) out[`read:${who}:${tb}:${s}`] = `error ${r.error}`; continue; }
        for (const row of r.rows) out[`read:${who}:${tb}:${row.k}`] = String(row.n);
      }
      // the helpers
      for (const s of SPOTS) {
        const r = await attempt(u, `select public.can_see_task($1::uuid) as a, public.can_edit_task($1::uuid) as b`, [w.task[s]]);
        out[`fn:${who}:can_see_task:${s}`] = "error" in r ? "error" : String(r.rows[0].a);
        out[`fn:${who}:can_edit_task:${s}`] = "error" in r ? "error" : String(r.rows[0].b);
      }
      for (const p of PROJ) {
        const r = await attempt(u, `select public.can_see_project($1::uuid) as a, public.can_edit_project($1::uuid) as b`, [w.proj[p]]);
        out[`fn:${who}:can_see_project:${p}`] = "error" in r ? "error" : String(r.rows[0].a);
        out[`fn:${who}:can_edit_project:${p}`] = "error" in r ? "error" : String(r.rows[0].b);
        if (tables.has54) {
          const s = await attempt(u, `select public.can_see_status_update($1::uuid) as a`, [w.update[p]]);
          out[`fn:${who}:can_see_status_update:${p}`] = "error" in s ? "error" : String(s.rows[0].a);
        }
        if (opts.realtime) {
          const rt = await attempt(u, `select public.kanbo_realtime_allowed('kanbo:task:' || $1, 'presence', false) as t,
                                              public.kanbo_realtime_allowed('kanbo:project:' || $2, 'presence', false) as p,
                                              public.kanbo_realtime_allowed('kanbo:doc:' || $3, 'presence', false) as d,
                                              public.kanbo_realtime_allowed('kanbo:doc:' || $3, 'broadcast', true) as b`, [w.task[p], w.proj[p], w.doc[p]]);
          for (const k of ["t", "p", "d", "b"]) out[`rt:${who}:${k}:${p}`] = "error" in rt ? "error" : String(rt.rows[0][k]);
        }
      }
      // writes (each rolled back)
      for (const s of SPOTS) {
        const proj = isProj(s) ? w.proj[s] : s === "L1" ? "p-personal" : "8f8f8f8f-1111-4222-8333-444444444444";
        out[`write:${who}:tasks:insert:${s}`] = okOf(await attempt(u, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, 'planted', $2, 'nobody', $3::uuid) returning id`, [u, proj, w.ws])) ? "ok" : "no";
        out[`write:${who}:tasks:update:${s}`] = okOf(await attempt(u, `update public.tasks set title = title || '.' where id = $1::uuid returning id`, [w.task[s]])) ? "ok" : "no";
        if (isProj(s)) out[`write:${who}:tasks:delete:${s}`] = okOf(await attempt(u, `delete from public.tasks where id = $1::uuid returning id`, [w.sub[s]])) ? "ok" : "no";
      }
      for (const p of PROJ) {
        for (const tb of ["sections", "custom_field_defs", "automation_rules", "forms"]) {
          const cols = tb === "custom_field_defs" ? "(user_id, workspace_id, project_id, name, type)" : "(user_id, workspace_id, project_id, name)";
          const vals = tb === "custom_field_defs" ? "($1::uuid, $2::uuid, $3, 'Planted', 'text')" : "($1::uuid, $2::uuid, $3, 'Planted')";
          out[`write:${who}:${tb}:insert:${p}`] = okOf(await attempt(u, `insert into public.${tb} ${cols} values ${vals} returning id`, [u, w.ws, w.proj[p]])) ? "ok" : "no";
          out[`write:${who}:${tb}:update:${p}`] = okOf(await attempt(u, `update public.${tb} set name = name || '.' where id = $1::uuid returning id`, [w.rows[tb][p]![0]])) ? "ok" : "no";
          out[`write:${who}:${tb}:delete:${p}`] = okOf(await attempt(u, `delete from public.${tb} where id = $1::uuid returning id`, [w.rows[tb][p]![0]])) ? "ok" : "no";
        }
        out[`write:${who}:status_updates:insert:${p}`] = okOf(await attempt(u, `insert into public.status_updates (user_id, workspace_id, project_id, summary, status) values ($1::uuid, $2::uuid, $3, 'Planted', 'on_track') returning id`, [u, w.ws, w.proj[p]])) ? "ok" : "no";
        out[`write:${who}:projects:update:${p}`] = okOf(await attempt(u, `update public.projects set description = 'changed' where id = $1::uuid returning id`, [w.proj[p]])) ? "ok" : "no";
        out[`write:${who}:projects:delete:${p}`] = okOf(await attempt(u, `delete from public.projects where id = $1::uuid returning id`, [w.proj[p]])) ? "ok" : "no";
        // comments and files: write your own; edit and delete your own
        out[`write:${who}:comments:insert:${p}`] = okOf(await attempt(u, `insert into public.comments (task_id, user_id, body) values ($1::uuid, $2::uuid, 'planted') returning id`, [w.task[p], u])) ? "ok" : "no";
        const mine: [string, unknown[]] = [`insert into public.comments (id, task_id, user_id, body) values ('99999999-0000-4000-8000-000000000001', $1::uuid, $2::uuid, 'mine')`, [w.task[p], u]];
        out[`write:${who}:comments:update:${p}`] = okOf(await attempt(u, `update public.comments set body = 'edited' where id = '99999999-0000-4000-8000-000000000001' returning id`, [], [mine])) ? "ok" : "no";
        out[`write:${who}:comments:delete:${p}`] = okOf(await attempt(u, `delete from public.comments where id = '99999999-0000-4000-8000-000000000001' returning id`, [], [mine])) ? "ok" : "no";
        out[`write:${who}:attachments:insert:${p}`] = okOf(await attempt(u, `insert into public.attachments (task_id, user_id, name, path) values ($1::uuid, $2::uuid, 'x', $3) returning id`, [w.task[p], u, `${u}/${w.task[p]}/x`])) ? "ok" : "no";
        const file: [string, unknown[]] = [`insert into public.attachments (id, task_id, user_id, name, path) values ('99999999-0000-4000-8000-000000000002', $1::uuid, $2::uuid, 'x', $3)`, [w.task[p], u, `${u}/${w.task[p]}/y`]];
        out[`write:${who}:attachments:delete:${p}`] = okOf(await attempt(u, `delete from public.attachments where id = '99999999-0000-4000-8000-000000000002' returning id`, [], [file])) ? "ok" : "no";
        const fol = await attempt(u, `select public.toggle_task_follow($1::uuid, true) as f`, [w.task[p]]);
        out[`rpc:${who}:follow:${p}`] = "error" in fol ? `error ${fol.error}` : "ok";
        const react = await attempt(u, `select public.toggle_comment_reaction($1::uuid, '👍') as r`, [w.comment[p]]);
        out[`rpc:${who}:react:${p}`] = "error" in react ? `error ${react.error}` : "ok";
        out[`write:${who}:subtasks:insert:${p}`] = okOf(await attempt(u, `insert into public.subtasks (task_id, title) values ($1::uuid, 'planted') returning id`, [w.task[p]])) ? "ok" : "no";
      }
      // people
      const m = await attempt(u, `select user_id::text as u from public.workspace_members where workspace_id = $1::uuid and user_id is not null`, [w.ws]);
      out[`people:${who}:members`] = "error" in m ? "error" : people(m.rows.map((r) => String(r.u))).join(",");
      const inv = await attempt(u, `select count(*)::int as n from public.workspace_members where id = $1::uuid`, [w.invite]);
      out[`people:${who}:invite`] = "error" in inv ? "error" : String(inv.rows[0].n);
      const pr = await attempt(u, `select id::text as u from public.profiles where id = any ($1::uuid[])`, [Object.values(w.id)]);
      out[`people:${who}:profiles`] = "error" in pr ? "error" : people(pr.rows.map((r) => String(r.u))).join(",");
      // search
      if (opts.search) {
        const known = new Map<string, string>();
        for (const s of SPOTS) known.set(w.task[s], `task:${s}`);
        for (const p of PROJ) { known.set(w.comment[p], `comment:${p}`); known.set(w.doc[p], `doc:${p}`); known.set(w.proj[p], `project:${p}`); }
        const sr = await attempt(u, `select kind, id::text as id from public.search_all('zebra', '{}'::jsonb, 50)`);
        out[`search:${who}`] = "error" in sr ? (/not authorized/.test(sr.error) ? "refused" : `error ${sr.error}`)
          : sr.rows.map((r) => known.get(String(r.id))).filter(Boolean).sort().join(",");
      }
      // the calendar feed's (service role)
      const tv = await attempt(null, `select id::text as id from public.tasks_visible_to($1::uuid) where id = any ($2::uuid[])`, [u, SPOTS.map((s) => w.task[s])]);
      out[`feed:${who}`] = "error" in tv ? "error" : tv.rows.map((r) => SPOTS.find((s) => w.task[s] === r.id)).sort().join(",");
      if (opts.post) {
        const c = await attempt(u, `select ${SPOTS.map((_, i) => `public.can_comment_task($${i + 1}::uuid) as c${i}`).join(", ")}`, SPOTS.map((s) => w.task[s]));
        SPOTS.forEach((s, i) => { out[`new:${who}:can_comment_task:${s}`] = "error" in c ? "error" : String(c.rows[0][`c${i}`]); });
        for (const p of PROJ) {
          const uc = await attempt(null, `select public.user_can_see_task($1::uuid, $2::uuid) as t, public.user_can_see_project($1::uuid, $3::uuid) as p,
                                                 public.user_project_rank($1::uuid, $4::uuid, $3::text) as r`, [u, w.task[p], w.proj[p], w.ws]);
          out[`new:${who}:user_can_see_task:${p}`] = "error" in uc ? "error" : String(uc.rows[0].t);
          out[`new:${who}:user_can_see_project:${p}`] = "error" in uc ? "error" : String(uc.rows[0].p);
          out[`new:${who}:user_project_rank:${p}`] = "error" in uc ? "error" : String(uc.rows[0].r);
        }
      }
    }
    return out;
  }

  function model(on: boolean, opts: { search: boolean; realtime: boolean; post: boolean }): Record<string, string> {
    const out: Record<string, string> = {};
    const b = (v: boolean) => String(v);
    for (const who of WHO) {
      for (const tb of TABLE_LIST()) {
        for (const s of Object.keys(w.rows[tb]) as Spot[]) out[`read:${who}:${tb}:${s}`] = String(sees(tb, who, s, on) ? w.rows[tb][s]!.length : 0);
      }
      for (const s of SPOTS) {
        out[`fn:${who}:can_see_task:${s}`] = b(rank(who, s, on) >= 1);
        out[`fn:${who}:can_edit_task:${s}`] = b(rank(who, s, on) >= 3);
      }
      for (const p of PROJ) {
        const r = rank(who, p, on);
        out[`fn:${who}:can_see_project:${p}`] = b(r >= 1);
        out[`fn:${who}:can_edit_project:${p}`] = b(r >= 3);
        if (tables.has54) out[`fn:${who}:can_see_status_update:${p}`] = b(r >= 1);
        if (opts.realtime) {
          out[`rt:${who}:t:${p}`] = b(r >= 1); out[`rt:${who}:p:${p}`] = b(r >= 1);
          out[`rt:${who}:d:${p}`] = b(r >= 1); out[`rt:${who}:b:${p}`] = b(r >= 3);
        }
      }
      for (const s of SPOTS) {
        const r = rank(who, s, on);
        out[`write:${who}:tasks:insert:${s}`] = r >= 3 ? "ok" : "no";
        out[`write:${who}:tasks:update:${s}`] = r >= 3 ? "ok" : "no";
        if (isProj(s)) out[`write:${who}:tasks:delete:${s}`] = r >= 3 ? "ok" : "no";
      }
      for (const p of PROJ) {
        const r = rank(who, p, on);
        for (const tb of ["sections", "custom_field_defs", "automation_rules", "forms"]) {
          for (const op of ["insert", "update", "delete"]) out[`write:${who}:${tb}:${op}:${p}`] = r >= 3 ? "ok" : "no";
        }
        out[`write:${who}:status_updates:insert:${p}`] = r >= 3 ? "ok" : "no";
        out[`write:${who}:projects:update:${p}`] = r >= 3 ? "ok" : "no";
        // (0041: a team project is deleted by its creator, its owner, or a workspace owner or admin)
        out[`write:${who}:projects:delete:${p}`] = r >= 3 && (["O", "A"].includes(who) || OWNER[p] === who) ? "ok" : "no";
        out[`write:${who}:comments:insert:${p}`] = r >= 2 ? "ok" : "no";
        out[`write:${who}:comments:update:${p}`] = r >= (on ? 2 : 1) ? "ok" : "no";
        out[`write:${who}:comments:delete:${p}`] = r >= 1 ? "ok" : "no";
        out[`write:${who}:attachments:insert:${p}`] = r >= 2 ? "ok" : "no";
        out[`write:${who}:attachments:delete:${p}`] = r >= 1 ? "ok" : "no";
        out[`rpc:${who}:follow:${p}`] = r >= 1 ? "ok" : WS_ROLE[who] === "none" && false ? "" : "error task not found";
        out[`rpc:${who}:react:${p}`] = r >= 2 ? "ok" : "error not authorized";
        out[`write:${who}:subtasks:insert:${p}`] = r >= 3 ? "ok" : "no";
      }
      out[`people:${who}:members`] = visiblePeople(who, on).join(",");
      out[`people:${who}:invite`] = staff(who) ? "1" : WS_ROLE[who] === "guest" ? (on ? "0" : "1") : "0";
      out[`people:${who}:profiles`] = visibleProfiles(who, on).join(",");
      if (opts.search) {
        out[`search:${who}`] = ["R", "S"].includes(who) && who === "S" ? "refused"
          : [...SPOTS.filter((s) => rank(who, s, on) >= 1).map((s) => `task:${s}`),
             ...PROJ.filter((p) => rank(who, p, on) >= 1).flatMap((p) => [`comment:${p}`, `doc:${p}`, `project:${p}`])].sort().join(",");
      }
      out[`feed:${who}`] = SPOTS.filter((s) => rank(who, s, on) >= 1).sort().join(",");
      if (opts.post) {
        for (const s of SPOTS) out[`new:${who}:can_comment_task:${s}`] = b(rank(who, s, on) >= 2);
        for (const p of PROJ) {
          out[`new:${who}:user_can_see_task:${p}`] = b(rank(who, p, on) >= 1);
          out[`new:${who}:user_can_see_project:${p}`] = b(rank(who, p, on) >= 1);
          out[`new:${who}:user_project_rank:${p}`] = String(rank(who, p, on));
        }
      }
    }
    return out;
  }

  const opts = { search: await hasFn("public.search_all(text,jsonb,integer)"), realtime: await hasFn("public.kanbo_realtime_allowed(text,text,boolean)"), post: false };
  const sw = async (on: boolean) => {
    const r = await as<{ r: { on: boolean } }>(w.id.O, `select public.set_project_access($1::uuid, $2) as r`, [w.ws, on]);
    eq(r[0].r.on, on, "the switch");
  };

  // ---------------------------------------------------------------- 1. the rank table
  let ref: Record<string, string> | null = null;
  if (before0058) {
    await test("0058 (the live database first): the model says exactly what 0001..0050 does today", async () => {
      // (a removed member and a suspended one, before 0058: R's gone from the workspace, S can't act)
      await pg.query(`delete from public.workspace_members where workspace_id = $1::uuid and user_id = $2::uuid`, [w.ws, w.id.R]);
      await pg.query(`update public.profiles set suspended = true where id = $1::uuid`, [w.id.S]);
      ref = await battery(opts);
      noMismatch(mismatches(ref, model(false, opts)), "before 0058 vs the switch-off model");
    });
    await applyFile(pg, "0058_project_access.sql");
  }
  opts.post = true;

  await test("0058: pa_rank_core answers every one of the 320 rows of src/lib/projectAccessMatrix.json", async () => {
    eq(ROWS.length, 320, "rows");
    const got = await q<{ r: number }>(`select public.pa_rank_core((x->>'on')::boolean, x->>'wsRole', x->>'visibility', (x->>'isOwner')::boolean, x->>'memberRole') as r
                                          from jsonb_array_elements($1::jsonb) with ordinality a(x, i) order by i`, [JSON.stringify(ROWS)]);
    const bad = ROWS.map((r, i) => ({ r, got: got[i].r })).filter((x) => x.got !== x.r.rank);
    eq(bad.map((x) => `${JSON.stringify(x.r)} → ${x.got}`), [], "rows that differ");
    // and the cross product is whole: 2 × 5 × 4 × 2 × 4, each once
    eq(new Set(ROWS.map((r) => `${r.on}|${r.wsRole}|${r.visibility}|${r.isOwner}|${r.memberRole}`)).size, 320, "distinct");
  });

  if (before0058) {
    await test("0058 seeds project_members from contributor_ids in their order (editors; guests comment; never the owner or a removed person; a suspended one keeps their place)", async () => {
      const rows = await q<{ p: string; u: string; role: string }>(`select project_id::text as p, user_id::text as u, role from public.project_members where workspace_id = $1::uuid order by 1, 2`, [w.ws]);
      const got = rows.map((r) => `${Object.entries(w.proj).find(([, v]) => v === r.p)![0]}:${people([r.u])[0]}:${r.role}`).sort();
      eq(got, ["PM:GC:commenter", "PM:GV:commenter", "PM:MC:editor", "PM:ME:editor", "PM:MV:editor", "PP:ME:editor", "PP:S:editor", "PW:GC:commenter"], "seeded");
      const kept = await one<{ c: string[] }>(`select contributor_ids::text[] as c from public.projects where id = $1::uuid`, [w.proj.PP]);
      eq(kept.c.length, 3, "contributor_ids isn't rewritten by the seeding (R and S stay in PP's)");
      // the mirror keeps contributor_ids' order, and a role change (here, or someone made a guest) rewrites nothing
      const pmIds = ["ME", "MC", "MV", "GC", "GV"].map((k) => w.id[k as Who]);
      const order = await one<{ m: string[] }>(`select array(select user_id::text from public.project_members where project_id = $1::uuid order by created_at, id) as m`, [w.proj.PM]);
      eq(order.m, pmIds, "seeded in contributor_ids' order");
      const after = await scenario(async (run) => {
        await run(w.id.O, `select public.set_project_member($1::uuid, $2::uuid, 'viewer')`, [w.proj.PM, w.id.MC]);
        await run(null, `update public.workspace_members set role = 'guest' where workspace_id = $1::uuid and user_id = $2::uuid`, [w.ws, w.id.MV]);
        const role = (await run(null, `select role from public.project_members where project_id = $1::uuid and user_id = $2::uuid`, [w.proj.PM, w.id.MV]))[0].role;
        await run(w.id.O, `select public.set_project_member($1::uuid, $2::uuid, 'commenter')`, [w.proj.PM, w.id.M2]);
        const added = (await run(null, `select contributor_ids::text[] as c from public.projects where id = $1::uuid`, [w.proj.PM]))[0].c;
        return { role, added };
      });
      eq(after.role, "commenter", "made a guest: their editor row comments");
      eq(after.added, [...pmIds, w.id.M2], "role changes kept contributor_ids as it was; someone added goes last");
      eq((await q(`select 1 from public.projects where visibility is distinct from 'workspace' and workspace_id = $1::uuid`, [w.ws])).length, 0, "every project starts Whole workspace");
      const hist = await one<{ n: number }>(`select count(*)::int as n from public.audit_events where workspace_id = $1::uuid and action = 'task.renamed' and project_id is not null`, [w.ws]);
      eq(hist.n, 4, "the history's existing rows know their project now");
    });
  }
  await configure();

  // ---------------------------------------------------------------- 2. switch off: exactly as before
  let off: Record<string, string> = {};
  await test(`0058, switch off: every read and write is ${before0058 ? "exactly what it was before 0058 (the same battery, 0001..0050)" : "the switch-off model (every member and guest reads every project)"}`, async () => {
    off = await battery(opts);
    if (ref) noMismatch(mismatches(off, ref, (k) => !k.startsWith("new:")), "after 0058 vs before");
    noMismatch(mismatches(off, model(false, opts)), "switch off vs the model");
  });

  // ---------------------------------------------------------------- 3. the switch
  await test("0058: only the workspace's owner turns project access on (an admin, a member and a guest are refused; the app can't write the column)", async () => {
    for (const who of ["A", "ME", "GC", "X"] as const) {
      await raises(as(w.id[who], `select public.set_project_access($1::uuid, true)`, [w.ws]), /not authorized/);
    }
    await raises(as(w.id.O, `select public.set_project_access($1::uuid, null, 'secret')`, [w.ws]), /invalid visibility/);
    for (const col of ["project_access = true", "project_access_default = 'private'", "project_access_member_private = true", "project_access_changed_at = now()"]) {
      await raises(as(w.id.O, `update public.workspaces set ${col} where id = $1::uuid`, [w.ws]), /not authorized/);
    }
    const ins = await as<{ on: boolean; d: string }>(w.id.O, `insert into public.workspaces (name, owner_id, project_access, project_access_default) values ('Mine', $1::uuid, true, 'private') returning project_access as on, project_access_default as d`, [w.id.O]);
    eq(ins[0], { on: false, d: "workspace" }, "a new workspace starts off, whatever it says");
    eq((await one<{ on: boolean }>(`select project_access as on from public.workspaces where id = $1::uuid`, [w.ws])).on, false, "still off");
    const r = (await as<{ r: Record<string, unknown> }>(w.id.O, `select public.set_project_access($1::uuid, true) as r`, [w.ws]))[0].r;
    eq([r.on, r.default, r.member_private], [true, "workspace", false], "on");
    ok(r.changed_at, "changed_at touched (open apps reload)");
    const h = await one<{ a: string }>(`select action as a from public.audit_events where workspace_id = $1::uuid order by created_at desc limit 1`, [w.ws]);
    eq(h.a, "project_access.on", "in the history");
  });

  // ---------------------------------------------------------------- 4. switch on: the matrix
  await test("0058, switch on: every person × project × table and path is exactly the model (reads, writes, helpers, realtime, search, people, the feed)", async () => {
    const on = await battery(opts);
    noMismatch(mismatches(on, model(true, opts)), "switch on vs the model");
  });

  await test("0058, switch on: realtime follows the reads (each published table that names a task or project is read through a rule that knows the project)", async () => {
    const rows = await q<{ t: string; quals: string | null }>(`
      select c.relname as t, string_agg(coalesce(p.qual, ''), ' ; ') as quals
        from pg_publication_tables pt join pg_class c on c.relname = pt.tablename and c.relnamespace = 'public'::regnamespace
        left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname and p.cmd in ('SELECT', 'ALL')
       where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public'
         and (c.relname = 'projects' or exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname in ('task_id', 'project_id', 'project_ids', 'doc_project_id') and not a.attisdropped))
       group by c.relname order by 1`);
    // reviewed: what these name isn't project content, or is checked when it's written
    const reviewed: Record<string, string> = {
      activity: "your own Inbox (its rows are dropped at write time for people who can't see the work)",
      goals: "a goal names the project its % comes from (an id), never the project's content",
      portfolios: "a portfolio lists project ids; the app shows only the ones you can read",
      meeting_items: "the meeting's audience; an item's task is checked when it's written (trg_meeting_items_pa)",
      meetings: "the meeting's audience; its agenda is scrubbed when it's written (trg_meetings_pa)",
    };
    const bad = rows.filter((r) => !reviewed[r.t] && !/(pa_|can_see_task|can_see_project|can_see_status_update|FROM tasks|FROM projects|FROM project_docs|FROM approvals)/i.test(r.quals ?? ""));
    eq(bad.map((r) => r.t), [], "published tables read without a project-aware rule");
    ok(!rows.some((r) => r.t === "project_members"), "project_members isn't published (a delete would broadcast who left what)");
    eq((await q(`select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('project_members', 'project_member_invites')`)).length, 0, "nor its invites");
  });

  await test("0058: no function a signed-in person can call reads project content past the rules (each reviewed one says why)", async () => {
    const rows = await q<{ name: string }>(`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
         and p.prosrc ~* '\\m(tasks|projects|comments|project_docs|project_doc_versions|status_updates|status_update_comments|sections|attachments|approvals|approval_reviewers|forms|custom_field_defs|automation_rules|task_events|kudos|notion_links|notion_syncs|subtasks|task_dependencies|trash|audit_events|meeting_items|meetings|bill_rates|update_asks|project_members)\\M'
         and p.prosrc !~ '(can_see_task|can_edit_task|can_see_project|can_edit_project|can_see_status_update|pa_[a-z_]+\\(|can_comment|tasks_visible_to)'
       order by 1`);
    const reviewed = new Set([
      // platform admins only (is_admin)
      "admin_account_detail", "admin_close_workspace", "admin_delete_user", "admin_funnel", "admin_series", "admin_series_range", "admin_stats",
      "admin_workspace_adoption", "admin_workspaces",
      // checked by 0058's triggers on the rows they write (update_asks, notion_syncs, bill_rates, trash, meetings, meeting_items)
      "ask_for_update", "notion_save_sync", "set_bill_rate", "restore_from_trash", "restore_trash_items", "purge_trash",
      "start_meeting", "add_meeting_item", "update_meeting_item", "set_meeting_doc", "end_meeting",
      // a meeting's own audience, owners and admins of a workspace, or the caller's own rows and files
      "can_see_meeting", "delete_meeting", "delete_meeting_item", "hand_meeting", "join_meeting", "move_meeting", "present_meeting",
      "delete_workspace", "remove_member", "workspace_activity", "my_task_file_attached", "take_back_kudos",
      // Notion's settings: owners and admins; a sync's id is only readable by people who can see its project
      "notion_delete_sync", "notion_disconnect", "notion_set_sync_enabled", "notion_status",
      // trigger functions (never callable directly); their Inbox rows pass the activity gate
      "log_task_event", "notify_comment", "notify_mentioned",
      // a form's link: trg_forms_pa_token; a yes/no about a project id in your own workspace
      "rotate_form_public_token", "status_update_project_ok",
    ]);
    eq(rows.map((r) => r.name).filter((n) => !reviewed.has(n)), [], "unreviewed security-definer functions");
  });

  // ---------------------------------------------------------------- 5. people
  await test("0058, switch on: a guest's people are their projects' (Gail sees Oona, Ari, Meg, Mac, Viv and Gwen; Gil only Oona); search_all's people too", async () => {
    if (!opts.search) return;
    for (const [who, target, found] of [["GC", "M2", false], ["GC", "MC", true], ["G2", "ME", false], ["M2", "GC", true], ["GV", "A", false]] as const) {
      const r = await as<{ id: string }>(w.id[who], `select id::text as id from public.search_all($1, '{"kinds": ["person"]}'::jsonb, 20)`, [NAME[target]]);
      eq(r.some((x) => x.id === w.id[target]), found, `${who} searching for ${NAME[target]}`);
    }
    // every guest's own row, and nothing from another workspace
    eq((await as<{ n: number }>(w.id.GC, `select count(*)::int as n from public.workspace_members where workspace_id = $1::uuid`, [w.ws2]))[0].n, 0, "another workspace's people");
    eq((await as<{ n: number }>(w.id.G2, `select count(*)::int as n from public.workspace_members where user_id = $1::uuid`, [w.id.G2]))[0].n, 1, "their own row");
    // pa_guest_people and pa_person_visible say the same thing
    for (const who of ["GC", "GV", "G2"] as const) {
      const keys = (await as<{ k: string[] }>(w.id[who], `select public.pa_guest_people() as k`))[0].k;
      for (const t of WHO) {
        const vis = (await as<{ v: boolean }>(w.id[who], `select public.pa_person_visible($1::uuid) as v`, [w.id[t]]))[0].v;
        eq(vis, keys.includes(`${w.ws}:${w.id[t]}`), `${who} → ${t}`);
      }
    }
  });

  // ---------------------------------------------------------------- 6. projects: creating, visibility, owners, people
  await test("0058, switch on: a member makes a Private project they own and reads it back (INSERT … RETURNING); private needs leave; another owner needs the owner", async () => {
    await raises(as(w.id.ME, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $1::uuid, 'Mine', $2::uuid, 'private') returning id`, [w.id.ME, w.ws]), /not authorized/);
    await as(w.id.O, `select public.set_project_access($1::uuid, null, null, true)`, [w.ws]);
    const r = await attempt(w.id.ME, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $1::uuid, 'Mine', $2::uuid, 'private') returning id::text as id, visibility`, [w.id.ME, w.ws]);
    ok(okOf(r), `inserted and returned: ${errOf(r)}`);
    eq("rows" in r ? r.rows[0].visibility : null, "private");
    const r2 = await attempt(w.id.A, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $1::uuid, 'Lead', $2::uuid, 'members') returning id`, [w.id.A, w.ws]);
    ok(okOf(r2), `an admin's Members only one: ${errOf(r2)}`);
    await raises(as(w.id.ME, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $2::uuid, 'For Oona', $3::uuid, 'members') returning id`, [w.id.ME, w.id.O, w.ws]), /not authorized/);
    await raises(as(w.id.ME, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $1::uuid, 'Odd', $2::uuid, 'secret') returning id`, [w.id.ME, w.ws]), /invalid visibility/);
    await as(w.id.O, `select public.set_project_access($1::uuid, null, null, false)`, [w.ws]);
    // the default applies to an insert that doesn't say (the API, MCP, Slack, old tabs); private falls back for members
    await as(w.id.O, `select public.set_project_access($1::uuid, null, 'private')`, [w.ws]);
    const d1 = await attempt(w.id.ME, `insert into public.projects (user_id, owner_id, name, workspace_id) values ($1::uuid, $1::uuid, 'Default', $2::uuid) returning visibility`, [w.id.ME, w.ws]);
    eq("rows" in d1 ? d1.rows[0].visibility : errOf(d1), "members", "a member's default 'private' becomes members only");
    const d2 = await attempt(w.id.O, `insert into public.projects (user_id, owner_id, name, workspace_id) values ($1::uuid, $1::uuid, 'Default', $2::uuid) returning visibility`, [w.id.O, w.ws]);
    eq("rows" in d2 ? d2.rows[0].visibility : errOf(d2), "private", "the owner's is private");
    await as(w.id.O, `select public.set_project_access($1::uuid, null, 'workspace')`, [w.ws]);
    const pers = await attempt(w.id.ME, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $1::uuid, 'Personal', null, 'private') returning visibility`, [w.id.ME]);
    eq("rows" in pers ? pers.rows[0].visibility : errOf(pers), "workspace", "a personal project is always 'workspace' (it means nothing there)");
    // a new project's maker (not its owner) and its people become its members
    const mk = await attempt(w.id.ME, `insert into public.projects (user_id, owner_id, name, workspace_id, contributor_ids) values ($1::uuid, $2::uuid, 'Handed', $3::uuid, $4::uuid[]) returning id::text as id, contributor_ids::text[] as c`,
      [w.id.ME, w.id.O, w.ws, [w.id.GC, w.id.O, w.id.R, w.id.MC]]);
    ok(okOf(mk), errOf(mk));
    eq("rows" in mk ? people(mk.rows[0].c as string[]) : [], ["GC", "MC", "ME"], "contributors: active people, not its owner, plus its maker");
  });

  await test("0058: visibility changes only through set_project_visibility, by the project's managers; nobody but the owner locks themselves out", async () => {
    await raises(as(w.id.O, `update public.projects set visibility = 'private' where id = $1::uuid`, [w.proj.PW]), /not authorized/);
    eq((await attempt(null, `update public.projects set visibility = 'private' where id = $1::uuid returning id`, [w.proj.PW]) as { rows: unknown[] }).rows.length, 1, "the SQL editor may");
    const tries: [Who, Proj, string, RegExp | string][] = [
      ["M2", "PW", "members", /not authorized/],      // a member who isn't on it can't manage it
      ["MC", "PM", "private", /not authorized/],      // a commenter can't
      ["GC", "PW", "members", /not authorized/],      // a guest never
      ["X", "PW", "members", /not found/],            // an outsider sees nothing
      ["A", "PP", "workspace", /not found/],          // an admin can't see a private project they're not on
      ["A", "PM", "private", /not authorized/],       // an admin making a project private they'd lose
      ["ME", "PM", "private", /not authorized/],      // members may not make projects private here (the default)
      ["ME", "PM", "workspace", "workspace"],         // an editor opens it up
      ["A", "PM", "members", "members"],              // an admin closes it again
      ["O", "PW", "nonsense", /invalid visibility/],
    ];
    for (const [who, p, v, want] of tries) {
      const r = await attempt(w.id[who], `select public.set_project_visibility($1::uuid, $2) as v`, [w.proj[p], v]);
      if (typeof want === "string") eq("rows" in r ? r.rows[0].v : errOf(r), want, `${who} ${p} → ${v}`);
      else ok(want.test(errOf(r)), `${who} ${p} → ${v}: ${errOf(r) || "allowed"}`);
    }
    // ME owns PQ; Members only with MC on it: MC still can't, ME can; a project's owner always keeps edit rights
    eq((await as<{ v: string }>(w.id.ME, `select public.set_project_visibility($1::uuid, 'members') as v`, [w.proj.PQ]))[0].v, "members");
    ok(/not authorized/.test(errOf(await attempt(w.id.ME, `select public.set_project_visibility($1::uuid, 'private')`, [w.proj.PQ]))), "back to private needs the owner's leave");
    await as(w.id.O, `select public.set_project_access($1::uuid, null, null, true)`, [w.ws]);
    eq((await as<{ v: string }>(w.id.ME, `select public.set_project_visibility($1::uuid, 'private') as v`, [w.proj.PQ]))[0].v, "private");
    await as(w.id.O, `select public.set_project_access($1::uuid, null, null, false)`, [w.ws]);
    const h = await one<{ d: Record<string, string> }>(`select detail as d from public.audit_events where action = 'project.visibility' and target_id = $1 order by created_at desc limit 1`, [w.proj.PQ]);
    eq([h.d.from, h.d.to], ["members", "private"], "in the history");
  });

  await test("0058: project people through set_project_member / remove_project_member (guests comment at most, the owner is implicit, outsiders refused)", async () => {
    const set = (who: Who, p: Proj, u: Who, role: string) => attempt(w.id[who], `select public.set_project_member($1::uuid, $2::uuid, $3) as r`, [w.proj[p], w.id[u], role]);
    eq((await set("O", "PP", "GV", "editor") as { rows: { r: string }[] }).rows[0].r, "commenter", "a guest's editor becomes commenter");
    eq((await set("O", "PP", "O", "viewer") as { rows: { r: string }[] }).rows[0].r, "owner", "the owner writes nothing");
    ok(/not a member of this workspace/.test(errOf(await set("O", "PP", "X", "viewer"))), "an outsider");
    ok(/not a member of this workspace/.test(errOf(await set("O", "PP", "R", "viewer"))), "someone removed");
    ok(/invalid role/.test(errOf(await set("O", "PP", "M2", "owner"))), "a role that isn't one");
    ok(/not authorized/.test(errOf(await set("MC", "PM", "M2", "viewer"))), "a commenter can't add people");
    ok(/not authorized/.test(errOf(await set("M2", "PW", "MC", "viewer"))), "a member who isn't on it (switch on)");
    ok(/not found/.test(errOf(await set("A", "PP", "M2", "viewer"))), "an admin who can't see it");
    eq((await set("ME", "PP", "M2", "viewer") as { rows: { r: string }[] }).rows[0].r, "viewer", "an editor adds someone");
    eq((await set("A", "PM", "M2", "commenter") as { rows: { r: string }[] }).rows[0].r, "commenter", "an admin on a members-only project");
    const leave = await attempt(w.id.MC, `select public.remove_project_member($1::uuid, $2::uuid) as r`, [w.proj.PM, w.id.MC]);
    eq("rows" in leave ? leave.rows[0].r : errOf(leave), true, "you can leave a project yourself");
    ok(/not authorized/.test(errOf(await attempt(w.id.MC, `select public.remove_project_member($1::uuid, $2::uuid)`, [w.proj.PM, w.id.MV]))), "but not take others off");
    ok(/not authorized/.test(errOf(await attempt(w.id.O, `select public.remove_project_member($1::uuid, $2::uuid)`, [w.proj.PQ, w.id.ME]))), "the owner can't be removed");
    // switch off: today's rule (any owner, admin or member), as contributor_ids is today
    await sw(false);
    eq((await set("M2", "PW", "MC", "viewer") as { rows: { r: string }[] }).rows[0]?.r, "viewer", "switch off: a member manages people");
    await sw(true);
    // direct writes are refused
    ok(/permission denied/.test(errOf(await attempt(w.id.O, `insert into public.project_members (project_id, workspace_id, user_id, role) values ($1::uuid, $2::uuid, $3::uuid, 'editor')`, [w.proj.PP, w.ws, w.id.M2]))), "insert");
    ok(/permission denied/.test(errOf(await attempt(w.id.O, `delete from public.project_members where project_id = $1::uuid`, [w.proj.PM]))), "delete");
  });

  await test("0058: contributor_ids mirrors project_members both ways (an old tab still works; non-managers are refused while the switch is on)", async () => {
    const tx = await attempt(w.id.ME, `update public.projects set contributor_ids = contributor_ids || $2::uuid where id = $1::uuid returning contributor_ids::text[] as c`, [w.proj.PP, w.id.M2]);
    ok(okOf(tx), errOf(tx));
    eq("rows" in tx ? people(tx.rows[0].c as string[]).includes("M2") : false, true, "the new contributor is listed");
    // (committed, then put back)
    await as(w.id.ME, `update public.projects set contributor_ids = contributor_ids || $2::uuid where id = $1::uuid`, [w.proj.PP, w.id.MC]);
    eq((await one<{ r: string }>(`select role as r from public.project_members where project_id = $1::uuid and user_id = $2::uuid`, [w.proj.PP, w.id.MC])).r, "editor", "an old tab's new contributor is an editor");
    await as(w.id.ME, `update public.projects set contributor_ids = array_remove(contributor_ids, $2::uuid) where id = $1::uuid`, [w.proj.PP, w.id.MC]);
    eq((await q(`select 1 from public.project_members where project_id = $1::uuid and user_id = $2::uuid`, [w.proj.PP, w.id.MC])).length, 0, "and taking them out removes them");
    await raises(as(w.id.M2, `update public.projects set contributor_ids = contributor_ids || $2::uuid where id = $1::uuid`, [w.proj.PW, w.id.G2]), /not authorized/);
    const mirror = await one<{ c: string[]; m: string[] }>(`select (select array_agg(x::text order by x) from unnest(p.contributor_ids) x) as c,
        (select array_agg(m.user_id::text order by m.user_id) from public.project_members m where m.project_id = p.id) as m from public.projects p where p.id = $1::uuid`, [w.proj.PM]);
    eq(mirror.c, mirror.m, "PM's contributor_ids are its members");
  });

  await test("0058: owners change hands only through a manager, to an active non-guest; the old owner stays an editor", async () => {
    await raises(as(w.id.M2, `update public.projects set owner_id = $2::uuid where id = $1::uuid`, [w.proj.PW, w.id.M2]), /not authorized/);
    await raises(as(w.id.O, `update public.projects set owner_id = $2::uuid where id = $1::uuid`, [w.proj.PW, w.id.GC]), /invalid owner/);
    const r = await attempt(w.id.O, `update public.projects set owner_id = $2::uuid where id = $1::uuid returning id`, [w.proj.PP, w.id.ME]);
    ok(okOf(r), errOf(r));
    const after = await attempt(null, `select (select role from public.project_members where project_id = $1::uuid and user_id = $2::uuid) as old_owner,
        (select count(*)::int from public.project_members where project_id = $1::uuid and user_id = $3::uuid) as new_owner_rows`, [w.proj.PP, w.id.O, w.id.ME],
      [[`update public.projects set owner_id = $2::uuid where id = $1::uuid`, [w.proj.PP, w.id.ME]]]);
    eq("rows" in after ? after.rows[0] : errOf(after), { old_owner: "editor", new_owner_rows: 0 }, "swapped");
  });

  await test("0058, switch off: a Members only or Private project's people and owner keep the switch-on rule (nobody takes one over while it's off and keeps it when it's on again)", async () => {
    const off: [string, unknown[]][] = [[`update public.workspaces set project_access = false where id = $1::uuid`, [w.ws]]];
    const refused = async (who: Who, sql: string, params: unknown[], what: string) => {
      const e = errOf(await attempt(w.id[who], sql, params, off));
      ok(/not authorized/.test(e), `${what}: ${e || "allowed"}`);
    };
    await refused("M2", `select public.set_project_member($1::uuid, $2::uuid, 'editor')`, [w.proj.PP, w.id.M2], "a member adding themselves to PP");
    await refused("A", `select public.set_project_member($1::uuid, $2::uuid, 'editor')`, [w.proj.PP, w.id.A], "an admin adding themselves to PP");
    await refused("MC", `update public.projects set owner_id = $2::uuid where id = $1::uuid returning id`, [w.proj.PM, w.id.MC], "a commenter taking PM over");
    await refused("M2", `update public.projects set contributor_ids = contributor_ids || $2::uuid where id = $1::uuid returning id`, [w.proj.PP, w.id.M2], "an old tab ticking a member onto PP");
    await refused("MV", `select public.remove_project_member($1::uuid, $2::uuid)`, [w.proj.PM, w.id.ME], "a viewer taking its editor off PM");
    const stored = async (who: Who, p: Proj, u: Who) => {
      const r = await attempt(w.id[who], `select public.set_project_member($1::uuid, $2::uuid, 'viewer') as r`, [w.proj[p], w.id[u]], off);
      return "rows" in r ? r.rows[0].r : errOf(r);
    };
    eq(await stored("ME", "PP", "M2"), "viewer", "PP's editor still manages its people");
    eq(await stored("A", "PM", "M2"), "viewer", "an admin manages a Members only project's");
    eq(await stored("M2", "PW", "MC"), "viewer", "and a Whole workspace project is today's rule (any member)");
    ok(okOf(await attempt(w.id.M2, `update public.projects set owner_id = $2::uuid where id = $1::uuid returning id`, [w.proj.PW, w.id.M2], off)), "a Whole workspace project's owner: today's rule");
    eq((await attempt(w.id.M2, `select id from public.tasks where project_id = $1`, [w.proj.PP]) as { rows: unknown[] }).rows.length, 0, "on again: M2 reads nothing of PP");
  });

  await test("0058: a project moved to Personal or another workspace and back can't hand anyone its ownership or drop its people (only its managers move one, switch on, and in the off window unless it's Whole workspace)", async () => {
    type Via = "Personal" | "ws2";
    const roundTrip = (who: Who, p: Proj, via: Via, on: boolean, empty = false) => scenario(async (run, _exec, tryRun) => {
      if (!on) await run(null, `update public.workspaces set project_access = false where id = $1::uuid`, [w.ws]);
      // (its work moved elsewhere first: a project leaves its workspace only without tasks or updates)
      if (empty) {
        await run(null, `update public.tasks set project_id = $2 where workspace_id = $1::uuid and project_id = $3`, [w.ws, w.proj.PW, w.proj[p]]);
        await run(null, `delete from public.status_updates where workspace_id = $1::uuid and project_id = $2`, [w.ws, w.proj[p]]);
      }
      if (via === "ws2") {
        await run(null, `insert into public.workspace_members (workspace_id, user_id, email, name, role, status) values ($1::uuid, $2::uuid, $3, $4, 'member', 'active')`,
          [w.ws2, w.id[who], `${who.toLowerCase()}.pa@example.org`, NAME[who]]);
      }
      const people = async () => Number((await run(null, `select count(*)::int as n from public.project_members where project_id = $1::uuid`, [w.proj[p]]))[0].n);
      const before = await people();
      const out = via === "Personal"
        ? await tryRun(w.id[who], `update public.projects set workspace_id = null, user_id = $2::uuid, owner_id = $2::uuid where id = $1::uuid returning id`, [w.proj[p], w.id[who]])
        : await tryRun(w.id[who], `update public.projects set workspace_id = $3::uuid, owner_id = $2::uuid where id = $1::uuid returning id`, [w.proj[p], w.id[who], w.ws2]);
      if (okOf(out)) await tryRun(w.id[who], `update public.projects set workspace_id = $2::uuid where id = $1::uuid returning id`, [w.proj[p], w.ws]);
      const after = (await run(null, `select owner_id::text as o, workspace_id::text as ws from public.projects where id = $1::uuid`, [w.proj[p]]))[0];
      return { moved: okOf(out), err: errOf(out), owner: after.o === w.id[OWNER[p]] ? OWNER[p] : after.o === w.id[who] ? who : String(after.o),
               home: after.ws === w.ws, kept: (await people()) === before };
    });
    // refused: a member with no say over it, switch on (any project) and in the off window (Members only, Private)
    for (const [who, p, via, on] of [["M2", "PW", "Personal", true], ["M2", "PW", "ws2", true], ["MC", "PM", "Personal", true], ["MV", "PM", "ws2", true],
                                     ["M2", "PP", "Personal", false], ["M2", "PM", "ws2", false], ["MC", "PM", "Personal", false], ["A", "PP", "ws2", false]] as const) {
      const r = await roundTrip(who, p, via, on);
      ok(!r.moved && (r.err === "" || /not authorized/.test(r.err)), `${who} moving ${p} to ${via}, switch ${on ? "on" : "off"}: ${r.err || (r.moved ? "moved" : "nothing")}`);
      eq([r.owner, r.home, r.kept], [OWNER[p], true, true], `${who}, ${p} via ${via} (switch ${on ? "on" : "off"}): its owner, workspace and people stay`);
    }
    // its managers too while its tasks or updates are still there (switch on, or a closed project in the off window):
    // what it left behind would be loose work every member of the workspace reads and edits
    for (const [who, p, via, on] of [["O", "PP", "Personal", true], ["ME", "PQ", "ws2", true], ["O", "PM", "ws2", false]] as const) {
      const r = await roundTrip(who, p, via, on);
      ok(!r.moved && /move its tasks first/.test(r.err), `${who} moving ${p} with its tasks to ${via}, switch ${on ? "on" : "off"}: ${r.err || (r.moved ? "moved" : "nothing")}`);
      eq([r.owner, r.home, r.kept], [OWNER[p], true, true], `${who}, ${p} with its tasks via ${via}: its owner, workspace and people stay`);
    }
    // allowed: its managers once its work has gone (switch on), and anyone on a Whole workspace project in the off window (today's rule)
    for (const [who, p, via, on, empty] of [["O", "PP", "Personal", true, true], ["ME", "PQ", "ws2", true, true], ["A", "PM", "Personal", true, true], ["M2", "PW", "Personal", false, false]] as const) {
      const r = await roundTrip(who, p, via, on, empty);
      ok(r.moved, `${who} moving ${p} to ${via}, switch ${on ? "on" : "off"}: ${r.err || "refused"}`);
    }
  });

  // ---------------------------------------------------------------- 7. triggers on tasks
  await test("0058, switch on: an assignee who can't see the project is refused from the app (42501) and handed to the owner from the server", async () => {
    const r = await attempt(w.id.ME, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, 'x', $2, $3, $4::uuid) returning id`, [w.id.ME, w.proj.PP, w.id.M2, w.ws]);
    ok(/assignee can't see this project/.test(errOf(r)), errOf(r));
    const upd = await attempt(w.id.ME, `update public.tasks set assignee_id = $2 where id = $1::uuid returning id`, [w.task.PP, w.id.GC]);
    eq("code" in upd ? upd.code : "allowed", "42501", "errcode (the app's isPermanentError dead-letters it)");
    const srv = await attempt(null, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, 'from a form', $2, $3, $4::uuid) returning assignee_id`, [w.id.O, w.proj.PP, w.id.M2, w.ws]);
    eq("rows" in srv ? srv.rows[0].assignee_id : errOf(srv), w.id.O, "the server's goes to the project's owner");
    const loose = await attempt(null, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, 'loose', 'p-personal', $2, $3::uuid) returning assignee_id`, [w.id.O, w.id.GC, w.ws]);
    eq("rows" in loose ? loose.rows[0].assignee_id : errOf(loose), w.id.O, "a loose one to the workspace's owner");
    const legacy = await attempt(w.id.ME, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, 'x', $2, 'nobody', $3::uuid) returning assignee_id`, [w.id.ME, w.proj.PP, w.ws]);
    eq("rows" in legacy ? legacy.rows[0].assignee_id : errOf(legacy), "nobody", "a non-uuid assignee is never checked");
    const col = await attempt(w.id.ME, `update public.tasks set collaborators = array[$2, $3, 'legacy'], followers = array[lower($2), lower($4)] where id = $1::uuid returning collaborators, followers`,
      [w.task.PP, w.id.MC, w.id.M2, w.id.GV]);
    eq("rows" in col ? [people(col.rows[0].collaborators as string[]), people(col.rows[0].followers as string[]), (col.rows[0].collaborators as string[]).includes("legacy")] : errOf(col),
      [[], [], true], "collaborators and followers who can't see it drop out (text kept as text)");
  });

  await test("0058, switch on: a sub-task has its parent's project, on insert, on a parent change and when the parent moves", async () => {
    const r = await attempt(w.id.ME, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id, parent_id) values ($1::uuid, 'child', $2, 'nobody', $3::uuid, $4::uuid) returning project_id`,
      [w.id.ME, w.proj.PW, w.ws, w.task.PP]);
    eq("rows" in r ? r.rows[0].project_id : errOf(r), w.proj.PP, "inherited");
    const lone = await attempt(w.id.ME, `update public.tasks set project_id = $2 where id = $1::uuid returning project_id`, [w.sub.PM, w.proj.PW]);
    eq("rows" in lone ? lone.rows[0].project_id : errOf(lone), w.proj.PM, "a sub-task alone stays with its parent");
    const moved = await attempt(null, `select project_id from public.tasks where id = $1::uuid`, [w.sub.PM],
      [[`update public.tasks set project_id = $2 where id = $1::uuid`, [w.task.PM, w.proj.PW]]]);
    eq("rows" in moved ? moved.rows[0].project_id : errOf(moved), w.proj.PW, "the parent's move takes it along");
    // moving a task: out of PP by its editor is fine; into PP or PQ without edit rights isn't
    const out = await attempt(w.id.ME, `update public.tasks set project_id = $2, assignee_id = 'nobody' where id = $1::uuid returning id`, [w.task.PP, w.proj.PW]);
    ok(okOf(out), `out of PP: ${errOf(out)}`);
    for (const [who, from, to] of [["MC", "PW", "PP"], ["A", "PW", "PQ"], ["M2", "PW", "PM"], ["MV", "PM", "PW"], ["GC", "PW", "PM"]] as const) {
      const mv = await attempt(w.id[who], `update public.tasks set project_id = $2, assignee_id = 'nobody' where id = $1::uuid returning id`, [w.task[from], w.proj[to]]);
      ok(!okOf(mv), `${who} moving ${from} → ${to} should be refused`);
    }
  });

  // ---------------------------------------------------------------- 8. docs, approvals, kudos
  await test("0058, switch on: docs (save, props, delete: edit rights; 'not allowed' to readers, 'doc not found' to the rest)", async () => {
    for (const who of WHO) for (const p of PROJ) {
      const r = rank(who, p, true);
      const s = await attempt(w.id[who], `select public.save_project_doc($1::uuid, $2::uuid, 'T', '[]'::jsonb, (select updated_at from public.project_docs where id = $1::uuid)) as r`, [w.doc[p], w.proj[p]]);
      const want = who === "S" ? "not authorized" : r >= 3 ? "" : r >= 1 ? "not allowed" : "doc not found";
      const got = errOf(s);
      if (want === "" ? got !== "" : !got.includes(want)) throw new Error(`${who} saving ${p}'s doc: ${got || "saved"}, wanted ${want || "saved"}`);
      const nw = await attempt(w.id[who], `select public.save_project_doc(gen_random_uuid(), $1::uuid, 'New', '[]'::jsonb) as r`, [w.proj[p]]);
      eq(okOf(nw), r >= 3, `${who} making a doc in ${p}`);
    }
  });

  await test("0058, switch on: approvals name reviewers who can comment (never a viewer, a member off the project or an outsider); a viewer reviewer can't decide", async () => {
    for (const [who, p, reviewer, okWanted] of [["O", "PP", "GV", false], ["O", "PP", "X", false], ["O", "PP", "M2", false], ["O", "PM", "MV", false],
                                                 ["O", "PM", "MC", true], ["O", "PP", "ME", true]] as const) {
      const r = await attempt(w.id[who], `select public.request_approval($1::uuid, array[$2::uuid]) as r`, [w.sub[p], w.id[reviewer]]);
      if (okWanted) ok(okOf(r), `${reviewer} on ${p}: ${errOf(r)}`);
      else ok(/invalid reviewers/.test(errOf(r)), `${reviewer} on ${p}: ${errOf(r) || "allowed"}`);
    }
    // MC reviews PM's request, then becomes a viewer: deciding is refused
    const d = await attempt(w.id.MC, `select public.decide_approval($1::uuid, 'approved') as r`, [w.rows.approvals.PM![0]],
      [[`update public.project_members set role = 'viewer' where project_id = $1::uuid and user_id = $2::uuid`, [w.proj.PM, w.id.MC]]]);
    ok(/approval not found/.test(errOf(d)), errOf(d) || "decided");
    const lists = await as<{ r: { to_review: { id: string }[] } }>(w.id.ME, `select public.list_my_approvals() as r`);
    eq(lists[0].r.to_review.map((a) => a.id).includes(w.rows.approvals.PP![0]), true, "ME still sees PP's");
    eq((await as<{ r: { to_review: { id: string }[] } }>(w.id.A, `select public.list_my_approvals() as r`))[0].r.to_review.length, 0, "A has none");
  });

  if (await has("kudos")) {
    await test("0058, switch on: kudos go only to someone who can see the task", async () => {
      // a collaborator planted past the triggers, who can't see PP
      const r = await attempt(w.id.ME, `select public.give_kudos($1::uuid, '🎉', null, $2::uuid) as r`, [w.task.PP, w.id.M2],
        [[`set session_replication_role = replica`, []], [`update public.tasks set collaborators = array[$2] where id = $1::uuid`, [w.task.PP, w.id.M2]], [`set session_replication_role = default`, []]]);
      ok(/invalid recipient/.test(errOf(r)), errOf(r) || "given");
      const g = await attempt(w.id.MC, `select public.give_kudos($1::uuid, '🎉') as r`, [w.task.PM]);
      ok(okOf(g), `to the assignee: ${errOf(g)}`);
    });
    await test("0058, switch on: a viewer can't give kudos or change one (a note is a comment); switch off, they can as before", async () => {
      for (const who of ["MV", "GV"] as const) {
        const give = await attempt(w.id[who], `select public.give_kudos($1::uuid, '🎉', 'viewer note: well done on the payroll', null) as r`, [w.task.PM]);
        ok(/not authorized/.test(errOf(give)), `${who} giving kudos with a note: ${errOf(give) || "given"}`);
        // one planted past the triggers (given before they were a viewer), then changed
        const edit = await attempt(w.id[who], `select public.update_kudos($1::uuid, '🔥', 'changed note') as r`, [w.task.PM],
          [[`set session_replication_role = replica`, []],
           [`insert into public.kudos (task_id, workspace_id, from_user, to_user, emoji) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, '🎉')`, [w.task.PM, w.ws, w.id[who], w.id.ME]],
           [`set session_replication_role = default`, []]]);
        ok(/not authorized/.test(errOf(edit)), `${who} changing their kudos: ${errOf(edit) || "changed"}`);
      }
      const off = await attempt(w.id.MV, `select public.give_kudos($1::uuid, '🎉', 'well done', null) ->> 'note' as r`, [w.task.PM],
        [[`update public.workspaces set project_access = false where id = $1::uuid`, [w.ws]]]);
      eq("rows" in off ? off.rows[0].r : errOf(off), "well done", "switch off: today's rule");
    });
  }

  // ---------------------------------------------------------------- 9. an update's conversation (0054)
  if (tables.has54) {
    await test("0058, switch on: replies and reactions need comment rights, \"seen\" needs read; Asks keep only people who can reply", async () => {
      for (const who of WHO) for (const p of PROJ) {
        const r = rank(who, p, true);
        eq(okOf(await attempt(w.id[who], `insert into public.status_update_comments (update_id, user_id, body) values ($1::uuid, $2::uuid, 'hi') returning id`, [w.update[p], w.id[who]])), r >= 2, `${who} replies on ${p}`);
        eq(okOf(await attempt(w.id[who], `insert into public.status_update_reactions (update_id, user_id, emoji) values ($1::uuid, $2::uuid, '🎉') returning update_id`, [w.update[p], w.id[who]])), r >= 2, `${who} reacts on ${p}`);
        const seen = await attempt(w.id[who], `select public.mark_status_updates_seen(array[$1::uuid]) as n`, [w.update[p]]);
        // (never your own update; MC has seen them all already; a suspended person is refused)
        const wantSeen = who === "S" ? -1 : r < 1 || who === OWNER[p] || who === "MC" ? 0 : 1;
        eq("rows" in seen ? Number(seen.rows[0].n) : -1, wantSeen, `${who} marks ${p} seen`);
      }
      const asks = await attempt(w.id.O, `insert into public.status_updates (user_id, workspace_id, project_id, summary, status, ask_user_ids) values ($1::uuid, $2::uuid, $3, 'Asks', 'on_track', $4::uuid[]) returning ask_user_ids::text[] as a`,
        [w.id.O, w.ws, w.proj.PM, [w.id.GV, w.id.M2, w.id.X, w.id.MC, w.id.ME, w.id.MV]]);
      eq("rows" in asks ? people(asks.rows[0].a as string[]) : errOf(asks), ["MC", "ME"], "asks: commenters and editors only");
      const mention = await attempt(w.id.O, `insert into public.status_update_comments (update_id, user_id, body, mentions) values ($1::uuid, $2::uuid, '@all', $3::uuid[]) returning mentions::text[] as m`,
        [w.update.PP, w.id.O, [w.id.ME, w.id.M2, w.id.GC]]);
      eq("rows" in mention ? people(mention.rows[0].m as string[]) : errOf(mention), ["ME"], "a reply's mentions: people who can read it");
    });
  }

  // ---------------------------------------------------------------- 10. goal links, saved views, notion, rates, asks, forms
  await test("0058, switch on: goal links, a goal's project, Notion syncs, bill rates, update asks and form links refuse work you can't see", async () => {
    if (tables.has52) {
      const goal = (await one<{ id: string }>(`select goal_id::text as id from public.goal_links where id = $1::uuid`, [w.rows.goal_links.PW![0]])).id;
      const link = await attempt(w.id.A, `insert into public.goal_links (goal_id, kind, target_id) values ($1::uuid, 'project', $2) returning id`, [goal, w.proj.PQ]);
      ok(/a goal can only link to work in its own workspace/.test(errOf(link)), errOf(link) || "linked");
      const tl = await attempt(w.id.A, `insert into public.goal_links (goal_id, kind, target_id) values ($1::uuid, 'task', $2) returning id`, [goal, w.task.PP]);
      ok(/a goal can only link to work in its own workspace/.test(errOf(tl)), errOf(tl) || "linked");
      ok(okOf(await attempt(w.id.A, `insert into public.goal_links (goal_id, kind, target_id) values ($1::uuid, 'task', $2) returning id`, [goal, w.sub.PM])), "a task they can see");
      const gp = await attempt(w.id.A, `update public.goals set project_id = $2 where id = $1::uuid returning id`, [goal, w.proj.PP]);
      ok(/a goal can only read its progress from a project in its own workspace/.test(errOf(gp)), errOf(gp) || "set");
    }
    const ns = await attempt(w.id.A, `select public.notion_save_sync($1::uuid, $2::uuid, gen_random_uuid()::text, 'DB', '{"title": "Name"}'::jsonb) as r`, [w.ws, w.proj.PP]);
    ok(/invalid project/.test(errOf(ns)), errOf(ns) || "saved");
    ok(okOf(await attempt(w.id.A, `select public.notion_save_sync($1::uuid, $2::uuid, gen_random_uuid()::text, 'DB', '{"title": "Name"}'::jsonb) as r`, [w.ws, w.proj.PM])), "into one they can edit");
    if (tables.has55) {
      const br = await attempt(w.id.A, `select public.set_bill_rate($1::uuid, $2::uuid, 90) as r`, [w.ws, w.proj.PP]);
      ok(/not authorized/.test(errOf(br)), errOf(br) || "set");
      ok(okOf(await attempt(w.id.A, `select public.set_bill_rate($1::uuid, $2::uuid, 90) as r`, [w.ws, w.proj.PM])), "a project they can see");
    }
    if (tables.has53) {
      const ask = await attempt(w.id.A, `select public.ask_for_update($1::uuid) as r`, [w.proj.PQ], [[`delete from public.update_asks where project_id = $1::uuid`, [w.proj.PQ]]]);
      ok(/not authorized/.test(errOf(ask)), errOf(ask) || "asked");
    }
    const form = w.rows.forms.PM![0];
    const tok = await attempt(w.id.A, `select public.rotate_form_public_token($1::uuid) as t`, [form]);
    ok(okOf(tok), `an admin on members-only: ${errOf(tok)}`);
    const tok2 = await attempt(w.id.A, `select public.rotate_form_public_token($1::uuid) as t`, [w.rows.forms.PP![0]]);
    ok(/not authorized|form not found/.test(errOf(tok2)), errOf(tok2) || "rotated");
    if (tables.has48) {
      const own = await attempt(w.id.M2, `insert into public.saved_views (workspace_id, user_id, name, kind, query, shared) values ($1::uuid, $2::uuid, 'mine', 'project', $3::jsonb, false) returning id`,
        [w.ws, w.id.M2, JSON.stringify({ v: 1, projectId: w.proj.PP })]);
      ok(okOf(own), `your own view always reads: ${errOf(own)}`);
    }
  });

  // ---------------------------------------------------------------- 11. meetings (0056)
  if (tables.has56) {
    await test("0058, switch on: a meeting's stored agenda carries only what its audience may see (team: Whole workspace; leadership: and Members only)", async () => {
      const agenda = [
        { key: "p", kind: "person", title: "Meg", personId: w.id.ME, done: PROJ.map((p) => ({ taskId: w.task[p], title: `Zebra plan ${p}`, status: "done" })),
          today: [{ taskId: w.task.L1, title: "loose", status: "todo" }], blocked: [], holding: [{ taskId: w.task.PP, title: "x", whoId: null }], more: { done: 0, today: 0, blocked: 0 } },
        { key: "risks", kind: "risks", title: "Risks", risks: [{ id: "r1", title: "a", reason: "b", severity: "warn", taskIds: [w.task.PW] }, { id: "r2", title: "c", reason: "d", severity: "warn", taskIds: [w.task.PW, w.task.PP] }] },
        { key: "projects", kind: "projects", title: "Projects", projects: PROJ.map((p) => ({ id: w.proj[p], name: `Zebra ${p}`, label: "x", detail: "y", pill: "z", tone: "ok", says: "", sees: "", mismatch: false })) },
        { key: "actions", kind: "actions", title: "Actions", from: null, actions: [{ itemId: "i1", body: "a", taskId: w.task.PM }, { itemId: "i2", body: "b", taskId: null }] },
      ];
      const kept = (a: { kind: string; done?: { taskId: string }[]; holding?: { taskId: string }[]; risks?: { id: string }[]; projects?: { id: string }[]; actions?: { itemId: string }[] }[]) => ({
        done: (a[0].done ?? []).map((e) => Object.entries(w.task).find(([, v]) => v === e.taskId)![0]),
        holding: (a[0].holding ?? []).length, risks: (a[1].risks ?? []).map((r) => r.id),
        projects: (a[2].projects ?? []).map((e) => Object.entries(w.proj).find(([, v]) => v === e.id)![0]), actions: (a[3].actions ?? []).map((x) => x.itemId),
      });
      const team = await attempt(w.id.O, `select agenda from public.start_meeting($1::uuid, 'team', 'Team', null, $2::jsonb, null, null, null)`, [w.ws, JSON.stringify(agenda)]);
      eq("rows" in team ? kept(team.rows[0].agenda as never) : errOf(team), { done: ["PW"], holding: 0, risks: ["r1"], projects: ["PW"], actions: ["i2"] }, "team");
      const lead = await attempt(w.id.O, `select agenda from public.start_meeting($1::uuid, 'leadership', 'Leads', array[$1::uuid], $2::jsonb, null, null, null)`, [w.ws, JSON.stringify(agenda)]);
      eq("rows" in lead ? kept(lead.rows[0].agenda as never) : errOf(lead), { done: ["PW", "PM"], holding: 0, risks: ["r1"], projects: ["PW", "PM"], actions: ["i1", "i2"] }, "leadership");
      const doc = await attempt(w.id.O, `select id from public.start_meeting($1::uuid, 'team', 'Team', null, '[]'::jsonb, null, $2::uuid, null)`, [w.ws, w.proj.PP]);
      ok(/not authorized/.test(errOf(doc)), `notes in a private project: ${errOf(doc) || "allowed"}`);
      const item = await attempt(w.id.O, `select public.add_meeting_item(m.id, 'action', 'Do it', null, null, null, $2::uuid) from public.start_meeting($1::uuid, 'team', 'T2', null, '[]'::jsonb, null, null, null) m`,
        [w.ws, w.task.PM]);
      ok(/not authorized/.test(errOf(item)), `a team meeting's item on a members-only task: ${errOf(item) || "allowed"}`);
    });

    await test("0058, switch on: a meeting still ends after its notes project narrows (or the switch goes on while it runs), and its recap goes out", async () => {
      const got = await scenario(async (run, _exec, tryRun) => {
        const m = (await run(w.id.O, `select id::text as id from public.start_meeting($1::uuid, 'team', 'Zebra sync', null, '[]'::jsonb, array[$3::uuid], $2::uuid, null)`, [w.ws, w.proj.PW, w.id.M2]))[0].id as string;
        await run(w.id.O, `select public.set_project_visibility($1::uuid, 'private')`, [w.proj.PW]);
        const ended = await tryRun(w.id.O, `select status from public.end_meeting($1::uuid, null, null)`, [m]);
        const recap = (await run(null, `select meta from public.activity where user_id = $1::uuid and kind = 'meeting' and meta ->> 'meeting_id' = $2`, [w.id.M2, m])).map((r) => r.meta as Record<string, unknown>);
        // a notes project it's given now is still checked
        const m2 = (await run(w.id.O, `select id::text as id from public.start_meeting($1::uuid, 'team', 'Zebra sync 2', null, '[]'::jsonb, null, null, null)`, [w.ws]))[0].id as string;
        const moved = errOf(await tryRun(w.id.O, `select public.set_meeting_doc($1::uuid, $2::uuid, $3::uuid)`, [m2, w.doc.PP, w.proj.PP]));
        await run(w.id.O, `select public.end_meeting($1::uuid, null, null)`, [m2]);
        // switched on while a leadership meeting with its notes in PP runs
        await run(w.id.O, `select public.set_project_access($1::uuid, false)`, [w.ws]);
        const l = (await run(w.id.O, `select id::text as id from public.start_meeting($1::uuid, 'leadership', 'Zebra leads', array[$1::uuid], '[]'::jsonb, null, $2::uuid, null)`, [w.ws, w.proj.PP]))[0].id as string;
        await run(w.id.O, `select public.set_project_access($1::uuid, true)`, [w.ws]);
        const ended2 = await tryRun(w.id.O, `select status from public.end_meeting($1::uuid, null, null)`, [l]);
        return { ended: "rows" in ended ? ended.rows[0].status : errOf(ended), recap, moved, ended2: "rows" in ended2 ? ended2.rows[0].status : errOf(ended2) };
      });
      eq(got.ended, "ended", "the team meeting ends after PW goes Private");
      eq(got.recap.length, 1, "Moe gets its recap");
      ok(!("doc_id" in got.recap[0]) && !("project_id" in got.recap[0]), `without the notes in a project Moe can't see: ${JSON.stringify(got.recap[0])}`);
      ok(/not authorized/.test(got.moved), `moving a team meeting's notes into a Private project: ${got.moved || "moved"}`);
      eq(got.ended2, "ended", "the leadership meeting ends after the switch went on");
    });
  }

  // ---------------------------------------------------------------- 12. switch off again: the rollback
  await test("0058: turning the switch off is the rollback: every read and write is exactly what it was (members and visibility kept)", async () => {
    await sw(false);
    const again = await battery(opts);
    noMismatch(mismatches(again, off), "off again vs off before");
    if (ref) noMismatch(mismatches(again, ref, (k) => !k.startsWith("new:")), "off again vs before 0058");
    ok((await q(`select 1 from public.project_members where workspace_id = $1::uuid`, [w.ws])).length > 0, "members kept");
    eq((await one<{ v: string }>(`select visibility as v from public.projects where id = $1::uuid`, [w.proj.PQ])).v, "private", "visibility kept");
    await sw(true);
  });

  // ---------------------------------------------------------------- 13. the bin and the history
  await test("0058, switch on: the bin follows the project's access (live, else as captured); restoring a project brings back its visibility and people", async () => {
    await as(w.id.ME, `delete from public.tasks where id = $1::uuid`, [w.sub.PP]);
    const bin = (await one<{ id: string; access: { visibility: string; members: [string, string][] } }>(`select id::text as id, access from public.trash where item_id = $1::uuid`, [w.sub.PP]));
    eq(bin.access.visibility, "private", "captured");
    for (const who of WHO) eq((await attempt(w.id[who], `select id from public.trash where id = $1::uuid`, [bin.id]) as { rows?: unknown[] }).rows?.length ?? 0, rank(who, "PP", true) >= 1 ? 1 : 0, `${who} sees the bin row`);
    ok(/not found/.test(errOf(await attempt(w.id.A, `select public.purge_trash($1::uuid)`, [bin.id]))), "an admin can't purge what they can't see");
    ok(/not found/.test(errOf(await attempt(w.id.A, `select public.restore_from_trash($1::uuid)`, [bin.id]))), "nor restore it");
    ok(okOf(await attempt(w.id.ME, `select public.restore_from_trash($1::uuid) as r`, [bin.id])), "its editor restores it");
    // the history row of the delete follows too
    const hist = await q<{ a: string }>(`select id::text as a from public.audit_events where action = 'task.deleted' and target_id = $1`, [w.sub.PP]);
    eq(hist.length, 1, "one history row");
    eq(((await attempt(w.id.A, `select id from public.audit_events where id = $1::uuid`, [hist[0].a])) as { rows: unknown[] }).rows.length, 0, "A doesn't see PP's task.deleted");
    eq(((await attempt(w.id.ME, `select id from public.audit_events where id = $1::uuid`, [hist[0].a])) as { rows: unknown[] }).rows.length, 1, "the actor sees their own");
    // the whole project: binned, its people captured, restored with them
    await as(w.id.ME, `select public.set_project_member($1::uuid, $2::uuid, 'commenter')`, [w.proj.PQ, w.id.MC]);
    const peopleBefore = await q<{ u: string; r: string }>(`select user_id::text as u, role as r from public.project_members where project_id = $1::uuid order by 1`, [w.proj.PQ]);
    eq(peopleBefore.length, 1, "PQ has MC");
    await as(w.id.ME, `delete from public.projects where id = $1::uuid`, [w.proj.PQ]);
    const pb = await one<{ id: string; a: { visibility: string; owner: string; members: unknown[] } }>(`select id::text as id, access as a from public.trash where item_id = $1::uuid and kind = 'project' and restored_at is null`, [w.proj.PQ]);
    eq([pb.a.visibility, pb.a.owner, pb.a.members.length], ["private", w.id.ME, 1], "captured: private, its owner, its people");
    for (const who of WHO) eq(((await attempt(w.id[who], `select id from public.trash where id = $1::uuid`, [pb.id])) as { rows?: unknown[] }).rows?.length ?? 0, rank(who, "PQ", true) >= 1 || who === "MC" ? 1 : 0, `${who} sees PQ in the bin`);
    for (const who of ["M2", "A", "MC"] as const) {
      const e = errOf(await attempt(w.id[who], `select public.restore_from_trash($1::uuid)`, [pb.id]));
      ok(/not found/.test(e), `${who} restoring PQ: ${e || "restored"}`);
    }
    await as(w.id.ME, `select public.restore_from_trash($1::uuid)`, [pb.id]);
    eq((await one<{ v: string }>(`select visibility as v from public.projects where id = $1::uuid`, [w.proj.PQ])).v, "private", "visibility back");
    eq(await q(`select user_id::text as u, role as r from public.project_members where project_id = $1::uuid order by 1`, [w.proj.PQ]), peopleBefore, "people back");
    eq((await one<{ c: string[] }>(`select contributor_ids::text[] as c from public.projects where id = $1::uuid`, [w.proj.PQ])).c, [w.id.MC], "and its contributor_ids");
    // a task of a deleted private project comes back only with its project, whoever asks
    await as(w.id.ME, `delete from public.tasks where id = $1::uuid`, [w.sub.PQ]);
    const tb = await one<{ id: string }>(`select id::text as id from public.trash where item_id = $1::uuid and restored_at is null`, [w.sub.PQ]);
    await as(w.id.ME, `delete from public.projects where id = $1::uuid`, [w.proj.PQ]);
    const pb2 = await one<{ id: string }>(`select id::text as id from public.trash where item_id = $1::uuid and kind = 'project' and restored_at is null`, [w.proj.PQ]);
    for (const who of ["ME", "O"] as const) {
      const gone = await attempt(w.id[who], `select public.restore_from_trash($1::uuid) as r`, [tb.id]);
      ok(/restore its project first/.test(errOf(gone)), `${who} restoring a task of a deleted private project: ${errOf(gone) || "restored"}`);
    }
    ok(/not found/.test(errOf(await attempt(w.id.M2, `select public.restore_from_trash($1::uuid) as r`, [tb.id]))), "M2 (not on it) hears nothing more");
    await as(w.id.O, `select public.restore_from_trash($1::uuid)`, [pb2.id]);
    await as(w.id.O, `select public.restore_from_trash($1::uuid)`, [tb.id]);
    eq((await one<{ p: string }>(`select project_id as p from public.tasks where id = $1::uuid`, [w.sub.PQ])).p, w.proj.PQ, "PQ and its sub-task are back where they were");
    await as(w.id.ME, `select public.remove_project_member($1::uuid, $2::uuid)`, [w.proj.PQ, w.id.MC]);
  });

  await test("0058, switch on: deleting for good (purge_trash, or housekeeping after 30 days) never shows an admin a Private task's or project's name in the history", async () => {
    const got = await scenario(async (run) => {
      const binOf = async (item: string) => (await run(null, `select id::text as id from public.trash where item_id = $1::uuid and restored_at is null order by deleted_at desc limit 1`, [item]))[0].id as string;
      // the owner deletes a PP sub-task and deletes it for good; an editor bins PP's task and housekeeping purges it;
      // the owner deletes PP itself and purges it; and a Whole workspace sub-task the same way (its row stays the admins')
      await run(w.id.O, `delete from public.tasks where id = $1::uuid`, [w.sub.PP]);
      await run(w.id.O, `select public.purge_trash($1::uuid)`, [await binOf(w.sub.PP)]);
      await run(w.id.ME, `delete from public.tasks where id = $1::uuid`, [w.task.PP]);
      await run(null, `update public.trash set purge_after = now() - interval '1 day' where id = $1::uuid`, [await binOf(w.task.PP)]);
      await run(null, `select public.trash_housekeeping()`);
      await run(w.id.O, `delete from public.projects where id = $1::uuid`, [w.proj.PP]);
      await run(w.id.O, `select public.purge_trash($1::uuid)`, [await binOf(w.proj.PP)]);
      await run(w.id.O, `delete from public.tasks where id = $1::uuid`, [w.sub.PW]);
      await run(w.id.O, `select public.purge_trash($1::uuid)`, [await binOf(w.sub.PW)]);
      const read = async (who: Who) => (await run(w.id[who], `select action || ' ' || target_title as x from public.audit_events where action like '%.purged'`)).map((r) => r.x as string).sort();
      return {
        A: await read("A"), O: await read("O"),
        stored: (await run(null, `select target_title || ': ' || (project_id is not null) || ' ' || coalesce(access ->> 'visibility', '-') as x from public.audit_events where action like '%.purged'`)).map((r) => r.x as string).sort(),
      };
    });
    eq(got.A, ["task.purged Sub PW"], "the admin reads only the Whole workspace purge");
    eq(got.O, ["project.purged Zebra PP", "task.purged Sub PP", "task.purged Sub PW", "task.purged Zebra plan PP"], "the owner reads all four");
    eq(got.stored, ["Sub PP: true private", "Sub PW: true workspace", "Zebra PP: true private", "Zebra plan PP: true private"],
      "each purge row keeps its project and its access from before");
  });

  await test("0058: a sub-task in another project than its parent is never taken along (switching on detaches it; a parent's move or delete, or its project's, leaves it; back from the bin it stands alone)", async () => {
    const got = await scenario(async (run) => {
      const at = async (id: string) => (await run(null, `select parent_id::text as parent, project_id as project from public.tasks where id = $1::uuid`, [id]))[0] ?? null;
      const mk = async (title: string, project: string, parent: string | null = null) => (await run(w.id.O,
        `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id, parent_id) values ($1::uuid, $2, $3, 'nobody', $4::uuid, $5::uuid) returning id::text as id`,
        [w.id.O, title, project, w.ws, parent]))[0].id as string;
      // switch off: a member hangs a PP task under a PW task (the app's task panel does it by moving a sub-task alone)
      await run(null, `update public.workspaces set project_access = false where id = $1::uuid`, [w.ws]);
      const stray = await mk("Stray PP", w.proj.PP);
      await run(w.id.M2, `update public.tasks set parent_id = $2::uuid where id = $1::uuid`, [stray, w.task.PW]);
      const hung = await at(stray);
      await run(w.id.O, `select public.set_project_access($1::uuid, true)`, [w.ws]);
      const afterOn = await at(stray);
      // planted with the switch on, past every trigger (the shape a restore or an old row may leave)
      const pw2 = (await run(w.id.O, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $1::uuid, 'Zebra PW2', $2::uuid, 'workspace') returning id::text as id`, [w.id.O, w.ws]))[0].id as string;
      const plant = async (title: string, parent: string) => {
        await run(null, `set local session_replication_role = replica`);
        const id = (await run(null, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id, parent_id) values ($1::uuid, $2, $3, 'nobody', $4::uuid, $5::uuid) returning id::text as id`,
          [w.id.O, title, w.proj.PP, w.ws, parent]))[0].id as string;
        await run(null, `set local session_replication_role = origin`);
        return id;
      };
      const s2 = await plant("Stray 2", w.task.PW);
      // a member moves the PW parent to another open project: its own sub-task goes along, the PP one doesn't
      await run(w.id.M2, `update public.tasks set project_id = $2 where id = $1::uuid`, [w.task.PW, pw2]);
      const moved = { s2: await at(s2), sub: await at(w.sub.PW), m2Reads: (await run(w.id.M2, `select id from public.tasks where id = $1::uuid`, [s2])).length };
      // an admin who can't see PP deletes the parent: the PP one stays, out of the parent's bin row
      const s3 = await plant("Stray 3", w.task.PW);
      await run(w.id.A, `delete from public.tasks where id = $1::uuid`, [w.task.PW]);
      const bin = (await run(null, `select (summary -> 'counts' ->> 'tasks')::int as n, snapshot::text like '%Stray%' as has_stray from public.trash where item_id = $1::uuid and restored_at is null`, [w.task.PW]))[0];
      const deleted = { s3: await at(s3), bin };
      // the owner deletes PW2 itself, with a PP task planted under one of its tasks
      const root = await mk("Root PW2", pw2);
      const s4 = await plant("Stray 4", root);
      await run(w.id.O, `delete from public.projects where id = $1::uuid`, [pw2]);
      const projectGone = { s4: await at(s4), root: await at(root) };
      // back from the bin under a parent that's moved to another project since: on its own
      const r1 = await mk("Parent R1", w.proj.PW);
      const c1 = await mk("Child C1", w.proj.PW, r1);
      await run(w.id.O, `delete from public.tasks where id = $1::uuid`, [c1]);
      await run(w.id.O, `update public.tasks set project_id = $2 where id = $1::uuid`, [r1, w.proj.PM]);
      const cb = (await run(null, `select id::text as id from public.trash where item_id = $1::uuid and restored_at is null`, [c1]))[0].id as string;
      await run(w.id.O, `select public.restore_from_trash($1::uuid)`, [cb]);
      return { hung, afterOn, moved, deleted, projectGone, restored: await at(c1) };
    });
    eq(got.hung, { parent: w.task.PW, project: w.proj.PP }, "switch off: hung under the PW task, still in PP");
    eq(got.afterOn, { parent: null, project: w.proj.PP }, "switching on: it stands on its own");
    eq(got.moved.s2, { parent: null, project: w.proj.PP }, "the parent's move leaves the PP one where it is");
    eq(got.moved.sub?.project !== w.proj.PW, true, "while the parent's own sub-task goes along");
    eq(got.moved.m2Reads, 0, "and the member still can't read it");
    eq(got.deleted.s3, { parent: null, project: w.proj.PP }, "the admin's delete leaves it");
    eq(got.deleted.bin, { n: 2, has_stray: false }, "the parent's bin row holds only the parent and its own sub-task");
    eq(got.projectGone, { s4: { parent: null, project: w.proj.PP }, root: null }, "deleting the project leaves the PP one too");
    eq(got.restored, { parent: null, project: w.proj.PW }, "a sub-task back from the bin under a parent that's moved stands alone");
  });

  await test("0058, switch on: a bin or history row of a deleted project keeps the narrowest access it had (binned while Whole workspace, or before 0058, then made Private and deleted: closed)", async () => {
    const got = await scenario(async (run, _exec, tryRun) => {
      const binOf = async (item: string) => (await run(null, `select id::text as id from public.trash where item_id = $1::uuid and restored_at is null order by deleted_at desc limit 1`, [item]))[0]?.id as string;
      const n = async (who: Who, sql: string, p: unknown[] = []) => (await run(w.id[who], sql, p)).length;
      const e = async (who: Who, sql: string, p: unknown[] = []) => errOf(await tryRun(w.id[who], sql, p));
      const mkProject = async (name: string) => (await run(w.id.O, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $1::uuid, $2, $3::uuid, 'workspace') returning id::text as id`, [w.id.O, name, w.ws]))[0].id as string;
      const mkTask = async (title: string, project: string) => (await run(w.id.O, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, $2, $3, $1::text, $4::uuid) returning id::text as id`, [w.id.O, title, project, w.ws]))[0].id as string;
      const binRow = `select 1 from public.trash where id = $1::uuid`;
      const histRow = `select 1 from public.audit_events where action = 'task.deleted' and target_id = $1`;
      // Payroll is Whole workspace when Meg bins its task; then Oona makes it Private, then deletes it
      const pay = await mkProject("Zebra Payroll");
      const tx = await mkTask("Zebra salary cut", pay);
      await run(w.id.ME, `delete from public.tasks where id = $1::uuid`, [tx]);
      const tbin = await binOf(tx);
      await run(w.id.O, `select public.set_project_visibility($1::uuid, 'private')`, [pay]);
      const whileLive = await n("M2", binRow, [tbin]);
      await run(w.id.O, `delete from public.projects where id = $1::uuid`, [pay]);
      const gone = {
        bin: { M2: await n("M2", binRow, [tbin]), A: await n("A", binRow, [tbin]), GC: await n("GC", binRow, [tbin]), O: await n("O", binRow, [tbin]) },
        hist: { A: await n("A", histRow, [tx]), ME: await n("ME", histRow, [tx]), O: await n("O", histRow, [tx]) },
        restoreM2: await e("M2", `select public.restore_from_trash($1::uuid)`, [tbin]),
        purgeA: await e("A", `select public.purge_trash($1::uuid)`, [tbin]),
        // (the owner may, but only with its project: anywhere else its audience would change)
        restoreO: await e("O", `select public.restore_from_trash($1::uuid)`, [tbin]),
      };
      await run(w.id.O, `select public.restore_from_trash($1::uuid)`, [await binOf(pay)]);
      await run(w.id.O, `select public.restore_from_trash($1::uuid)`, [tbin]);
      const back = (await run(null, `select project_id as p from public.tasks where id = $1::uuid`, [tx]))[0]?.p;
      // binned while Private, then the project deleted for good: it can't come back on its own
      const t2 = await mkTask("Zebra acquisition", pay);
      await run(w.id.O, `delete from public.tasks where id = $1::uuid`, [t2]);
      const t2bin = await binOf(t2);
      await run(w.id.O, `delete from public.projects where id = $1::uuid`, [pay]);
      await run(w.id.O, `select public.purge_trash($1::uuid)`, [await binOf(pay)]);
      const purged = {
        restoreO: await e("O", `select public.restore_from_trash($1::uuid)`, [t2bin]),
        binA: await n("A", binRow, [t2bin]), histA: await n("A", histRow, [t2]), histO: await n("O", histRow, [t2]),
        // and the first task's history once its project is gone for good too
        firstHistA: await n("A", histRow, [tx]),
      };
      // before 0058: HR's task binned with nothing captured (the bin row and its history as 0057 wrote them)
      const hr = await mkProject("Zebra HR");
      const th = await mkTask("Zebra disciplinary note", hr);
      await run(w.id.ME, `delete from public.tasks where id = $1::uuid`, [th]);
      const thbin = await binOf(th);
      await run(null, `update public.trash set access = null where id = $1::uuid`, [thbin]);
      await run(null, `update public.audit_events set access = null where target_id = $1`, [th]);
      await run(w.id.O, `select public.set_project_visibility($1::uuid, 'private')`, [hr]);
      await run(w.id.O, `delete from public.projects where id = $1::uuid`, [hr]);
      const old = { binM2: await n("M2", binRow, [thbin]), histA: await n("A", histRow, [th]), binO: await n("O", binRow, [thbin]) };
      return { whileLive, gone, back, pay, purged, old };
    });
    eq(got.whileLive, 0, "while Payroll is there and Private, Moe doesn't see the bin row");
    eq(got.gone.bin, { M2: 0, A: 0, GC: 0, O: 1 }, "once it's deleted too, still only the owner");
    eq(got.gone.hist, { A: 0, ME: 1, O: 1 }, "its history row: the owner, and Meg's own");
    ok(/not found/.test(got.gone.restoreM2), `Moe restoring it: ${got.gone.restoreM2 || "restored"}`);
    ok(/not found/.test(got.gone.purgeA), `Ari purging it: ${got.gone.purgeA || "purged"}`);
    ok(/restore its project first/.test(got.gone.restoreO), `Oona restoring it before its project: ${got.gone.restoreO || "restored"}`);
    eq(got.back, got.pay, "after its project, it's back in Payroll");
    ok(/its project was deleted for good/.test(got.purged.restoreO), `a Private project's task after the project is purged: ${got.purged.restoreO || "restored"}`);
    eq([got.purged.binA, got.purged.histA, got.purged.histO, got.purged.firstHistA], [0, 0, 1, 0], "the history keeps it Private after the purge");
    eq(got.old, { binM2: 0, histA: 0, binO: 1 }, "a row from before 0058 follows the project's own bin row");
  });

  /** The access a project deleted for good was retired with (1g), or null. (hasRetired is asked before a
   *  scenario: a query outside its transaction would wait for it.) */
  const retiredVis = async (hasRetired: boolean, run: (who: string | null, sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>, id: string) =>
    hasRetired ? (await run(null, `select access ->> 'visibility' as v from public.project_ids_retired where id = $1::uuid`, [id]))[0]?.v ?? null : null;
  await test("0058, switch on: a Private project deleted for good keeps its id and its people's work (no new project takes the id; work written into it after the delete stays theirs and goes to the bin with it)", async () => {
    const hasSearch = await hasFn("public.search_all(text,jsonb,integer)");
    const hasRetired = await has("project_ids_retired");
    const got = await scenario(async (run, _exec, tryRun) => {
      const binOf = async (item: string) => (await run(null, `select id::text as id from public.trash where item_id = $1::uuid and restored_at is null order by deleted_at desc limit 1`, [item]))[0]?.id as string;
      const e = async (who: Who | null, sql: string, p: unknown[] = []) => errOf(await tryRun(who ? w.id[who] : null, sql, p)) || "ok";
      const n = async (who: Who, sql: string, p: unknown[] = []) => (await run(w.id[who], sql, p)).length;
      const pp = w.proj.PP;
      const ins = (title: string) => [`insert into public.tasks (user_id, title, description, project_id, assignee_id, workspace_id) values ($1::uuid, $2, 'zebra late body', $3, $1::text, $4::uuid) returning id::text as id`, title] as const;
      const newTask = async (who: Who, title: string) => {
        const [sql, t] = ins(title);
        const r = await tryRun(w.id[who], sql, [w.id[who], t, pp, w.ws]);
        return "error" in r ? r.error : String(r.rows[0].id);
      };
      // Oona bins a PP task on its own first (it waits in the bin), then PP itself
      const early = (await run(w.id.O, ins("Zebra early bin")[0], [w.id.O, "Zebra early bin", pp, w.ws]))[0].id as string;
      await run(w.id.O, `insert into public.comments (task_id, user_id, body) values ($1::uuid, $2::uuid, 'zebra early comment')`, [early, w.id.O]);
      await run(w.id.O, `delete from public.tasks where id = $1::uuid`, [early]);
      const megPW = (await run(w.id.ME, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, 'Zebra Meg PW', $2, $1::text, $3::uuid) returning id::text as id`, [w.id.ME, w.proj.PW, w.ws]))[0].id as string;
      await run(w.id.O, `delete from public.projects where id = $1::uuid`, [pp]);
      // in the bin: Meg (its editor, an old tab or her offline queue) writes nothing into it; Oona (the owner) still may
      const inBin = {
        megTask: await newTask("ME", "Zebra late task"),
        megMove: await e("ME", `update public.tasks set project_id = $2 where id = $1::uuid returning id`, [megPW, pp]),
        megSection: await e("ME", `insert into public.sections (user_id, workspace_id, project_id, name) values ($1::uuid, $2::uuid, $3, 'Zebra late section') returning id`, [w.id.ME, w.ws, pp]),
        impostor: await e("M2", `insert into public.projects (id, user_id, owner_id, name, workspace_id) values ($1::uuid, $2::uuid, $2::uuid, 'innocent', $3::uuid) returning id`, [pp, w.id.M2, w.ws]),
      };
      const ownerLate = await newTask("O", "Zebra owner late");
      // the off window: Meg's old tab writes into it as before, with a sub-task and a section
      await run(null, `update public.workspaces set project_access = false where id = $1::uuid`, [w.ws]);
      const offTask = await newTask("ME", "Zebra off task");
      await run(w.id.ME, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id, parent_id) values ($1::uuid, 'Zebra off sub', $2, $1::text, $3::uuid, $4::uuid)`, [w.id.ME, pp, w.ws, offTask]);
      await run(w.id.ME, `insert into public.sections (user_id, workspace_id, project_id, name) values ($1::uuid, $2::uuid, $3, 'Zebra off section')`, [w.id.ME, w.ws, pp]);
      await run(null, `update public.workspaces set project_access = true where id = $1::uuid`, [w.ws]);
      const lateTitles = `select title from public.tasks where title in ('Zebra off task', 'Zebra off sub', 'Zebra owner late') order by title`;
      const whileBinned = {
        closed: ((await run(null, `select public.closed_project_ids($1::uuid) as c`, [w.ws]))[0].c as string[]).includes(pp),
        open: (await run(null, `select public.project_is_open($1::uuid, $2) as o`, [w.ws, pp]))[0].o,
        M2: await n("M2", lateTitles), A: await n("A", lateTitles), ME: await n("ME", lateTitles), O: await n("O", lateTitles),
        megEdits: (await run(w.id.ME, `update public.tasks set title = 'Zebra off task!' where id = $1::uuid returning id`, [offTask])).length,
      };
      // Oona deletes PP for good (the early task still waits in the bin)
      await run(w.id.O, `select public.purge_trash($1::uuid)`, [await binOf(pp)]);
      const stragglerBins = `select title from public.trash where kind = 'task' and project_id = $1 and restored_at is null and title in ('Zebra off task', 'Zebra owner late') order by title`;
      const offBin = await binOf(offTask);
      const purged = {
        left: (await run(null, `select count(*)::int as n from public.tasks where workspace_id = $1::uuid and project_id = $2`, [w.ws, pp]))[0].n,
        sections: (await run(null, `select count(*)::int as n from public.sections where workspace_id = $1::uuid and project_id = $2`, [w.ws, pp]))[0].n,
        bins: (await run(null, stragglerBins, [pp])).map((r) => r.title),
        binAccess: (await run(null, `select access ->> 'visibility' as v from public.trash where id = $1::uuid`, [offBin]))[0]?.v,
        binOf: { ME: await n("ME", stragglerBins, [pp]), M2: await n("M2", stragglerBins, [pp]), A: await n("A", stragglerBins, [pp]), O: await n("O", stragglerBins, [pp]) },
        restoreO: await e("O", `select public.restore_from_trash($1::uuid)`, [offBin]),
        retired: await retiredVis(hasRetired, run, pp),
        search: hasSearch ? await n("M2", `select 1 from public.search_all('Zebra off task', '{}'::jsonb, 50) s where s.title in ('Zebra off task', 'Zebra off sub', 'Zebra owner late')`) : 0,
      };
      // a project under PP's id: from the app, a personal one, a Private one an admin makes, the service, or re-numbering one
      const m2Own = (await run(w.id.M2, `insert into public.projects (user_id, owner_id, name, workspace_id) values ($1::uuid, $1::uuid, 'Zebra M2 own', $2::uuid) returning id::text as id`, [w.id.M2, w.ws]))[0].id as string;
      const impostor = {
        member: await e("M2", `insert into public.projects (id, user_id, owner_id, name, workspace_id) values ($1::uuid, $2::uuid, $2::uuid, 'innocent', $3::uuid) returning id`, [pp, w.id.M2, w.ws]),
        personal: await e("M2", `insert into public.projects (id, user_id, owner_id, name) values ($1::uuid, $2::uuid, $2::uuid, 'innocent') returning id`, [pp, w.id.M2]),
        adminPrivate: await e("A", `insert into public.projects (id, user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $2::uuid, $2::uuid, 'x', $3::uuid, 'private') returning id`, [pp, w.id.A, w.ws]),
        service: await e(null, `insert into public.projects (id, user_id, owner_id, name, workspace_id) values ($1::uuid, $2::uuid, $2::uuid, 'x', $3::uuid) returning id`, [pp, w.id.O, w.ws]),
        renumber: await e("M2", `update public.projects set id = $2::uuid where id = $1::uuid returning id`, [m2Own, pp]),
      };
      // what's left of PP stays its people's: the early bin row and the history
      const history = `select 1 from public.audit_events where target_id in ($1, $2) or project_id = $1`;
      const after = {
        earlyBin: { M2: await n("M2", `select 1 from public.trash where item_id = $1::uuid`, [early]), MC: await n("MC", `select 1 from public.trash where item_id = $1::uuid`, [early]) },
        restoreM2: await e("M2", `select public.restore_from_trash($1::uuid)`, [await binOf(early)]),
        history: { A: await n("A", history, [pp, early]), M2: await n("M2", history, [pp, early]), O: Math.min(1, await n("O", history, [pp, early])) },
        // a write into the id after the purge: read-only to its people, nothing to anyone else
        megTask: await newTask("ME", "Zebra after purge"),
        m2Task: await newTask("M2", "Zebra after purge"),
        rank: Object.fromEntries(await Promise.all((["ME", "M2", "A", "O"] as const).map(async (k) =>
          [k, (await run(null, `select public.user_project_rank($1::uuid, $2::uuid, $3) as r`, [w.id[k], w.ws, pp]))[0].r]))),
        closed: ((await run(null, `select public.closed_project_ids($1::uuid) as c`, [w.ws]))[0].c as string[]).includes(pp),
      };
      return { inBin, ownerLate: /^[0-9a-f-]{36}$/.test(ownerLate), whileBinned, purged, impostor, after };
    });
    const refused = /row-level security|not authorized/;
    ok(refused.test(got.inBin.megTask), `Meg adding a task to the binned PP: ${got.inBin.megTask}`);
    ok(refused.test(got.inBin.megMove), `Meg moving a task into it: ${got.inBin.megMove}`);
    ok(refused.test(got.inBin.megSection), `Meg adding a section to it: ${got.inBin.megSection}`);
    ok(/id in use/.test(got.inBin.impostor), `a project under its id while it's in the bin: ${got.inBin.impostor}`);
    eq(got.ownerLate, true, "the workspace's owner may still write into it");
    eq(got.whileBinned, { closed: true, open: false, M2: 0, A: 0, ME: 3, O: 3, megEdits: 0 },
      "while it's in the bin: closed to the stand-up, read by its people only, and Meg can't change what she wrote in the off window");
    eq([got.purged.left, got.purged.sections], [0, 0], "deleted for good: no task or section still names it");
    eq(got.purged.bins, ["Zebra off task", "Zebra owner late"], "the late work went to the bin (the sub-task in its parent's entry)");
    eq(got.purged.binAccess, "private", "keeping PP's access");
    eq(got.purged.binOf, { ME: 2, M2: 0, A: 0, O: 2 }, "read by PP's people only");
    ok(/deleted for good/.test(got.purged.restoreO), `restoring it: ${got.purged.restoreO}`);
    eq(got.purged.retired, "private", "PP's id is retired with its access");
    eq(got.purged.search, 0, "search finds none of it for Moe");
    for (const [k, v] of Object.entries(got.impostor)) ok(/id in use/.test(v), `a project under PP's id (${k}): ${v}`);
    eq(got.after.earlyBin, { M2: 0, MC: 0 }, "the early task's bin row stays PP's people's");
    ok(/not found/.test(got.after.restoreM2), `Moe restoring it: ${got.after.restoreM2}`);
    eq(got.after.history, { A: 0, M2: 0, O: 1 }, "and the history");
    ok(refused.test(got.after.megTask), `Meg writing into the id after the purge: ${got.after.megTask}`);
    ok(/can't see this project/.test(got.after.m2Task), `Moe writing into it: ${got.after.m2Task}`);
    eq(got.after.rank, { ME: 1, M2: 0, A: 0, O: 3 }, "ranks on the retired id: its people read, the owner keeps edit");
    eq(got.after.closed, true, "and it's still closed to the stand-up");
  });

  await test("0058, switch on: a Whole workspace project deleted for good leaves later work where it is (as before 0058), and its id is retired too", async () => {
    const hasRetired = await has("project_ids_retired");
    const got = await scenario(async (run, _exec, tryRun) => {
      const binOf = async (item: string) => (await run(null, `select id::text as id from public.trash where item_id = $1::uuid and restored_at is null order by deleted_at desc limit 1`, [item]))[0]?.id as string;
      const pid = (await run(w.id.O, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $1::uuid, 'Zebra open', $2::uuid, 'workspace') returning id::text as id`, [w.id.O, w.ws]))[0].id as string;
      await run(w.id.O, `delete from public.projects where id = $1::uuid`, [pid]);
      // (written by the service, past the bin: a form or an old function)
      const t = (await run(null, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, 'Zebra open late', $2, 'nobody', $3::uuid) returning id::text as id`, [w.id.ME, pid, w.ws]))[0].id as string;
      await run(null, `update public.trash set purge_after = now() - interval '1 day' where id = $1::uuid`, [await binOf(pid)]);
      await run(null, `select public.trash_housekeeping()`);
      return {
        pid,
        task: (await run(null, `select project_id as p from public.tasks where id = $1::uuid`, [t]))[0]?.p,
        M2: (await run(w.id.M2, `select 1 from public.tasks where id = $1::uuid`, [t])).length,
        retired: await retiredVis(hasRetired, run, pid),
        impostor: errOf(await tryRun(w.id.M2, `insert into public.projects (id, user_id, owner_id, name, workspace_id) values ($1::uuid, $2::uuid, $2::uuid, 'x', $3::uuid) returning id`, [pid, w.id.M2, w.ws])),
      };
    });
    eq([got.task, got.M2, got.retired], [got.pid, 1, "workspace"], "the task stays where it was, every member still reads it, and the id is retired");
    ok(/id in use/.test(got.impostor), `a project under its id: ${got.impostor}`);
  });

  await test("0058, switch on: a task whose Whole workspace project has gone comes back in a Whole workspace project, never in the workspace's first project if that's Private", async () => {
    const got = await scenario(async (run, _exec, tryRun) => {
      const binOf = async (item: string) => (await run(null, `select id::text as id from public.trash where item_id = $1::uuid and restored_at is null order by deleted_at desc limit 1`, [item]))[0]?.id as string;
      // the workspace's first project (PW) goes Private; Meg's Launch (Whole workspace, Gail on it) has two tasks for Moe
      await run(w.id.O, `select public.set_project_visibility($1::uuid, 'private')`, [w.proj.PW]);
      await run(w.id.O, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $1::uuid, 'Zebra Open', $2::uuid, 'workspace')`, [w.id.O, w.ws]);
      const launch = (await run(w.id.ME, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $1::uuid, 'Zebra Launch', $2::uuid, 'workspace') returning id::text as id`, [w.id.ME, w.ws]))[0].id as string;
      await run(w.id.ME, `select public.set_project_member($1::uuid, $2::uuid, 'commenter')`, [launch, w.id.GC]);
      const mk = async (title: string) => (await run(w.id.ME, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id, collaborators) values ($1::uuid, $2, $3, $4, $5::uuid, $6::text[]) returning id::text as id`,
        [w.id.ME, title, launch, w.id.M2, w.ws, [w.id.GC]]))[0].id as string;
      const t1 = await mk("Zebra launch plan"), t2 = await mk("Zebra launch copy");
      await run(w.id.ME, `delete from public.tasks where id = $1::uuid`, [t1]);
      await run(w.id.ME, `delete from public.tasks where id = $1::uuid`, [t2]);
      await run(w.id.ME, `delete from public.projects where id = $1::uuid`, [launch]);
      const b1 = await binOf(t1), b2 = await binOf(t2);
      const firstOpen = (await run(null, `select id::text as id, name from public.projects where workspace_id = $1::uuid and visibility = 'workspace' order by (archived_at is not null), created_at, id limit 1`, [w.ws]))[0];
      const firstAny = (await run(null, `select id::text as id from public.projects where workspace_id = $1::uuid order by (archived_at is not null), created_at, id limit 1`, [w.ws]))[0].id;
      // with no Whole workspace project at all, it says so (and lands nowhere)
      await run(null, `select set_config('kanbo.pa_write', 'on', true)`);
      const narrowed = (await run(null, `update public.projects set visibility = 'members' where workspace_id = $1::uuid and visibility = 'workspace' returning id::text as id`, [w.ws])).map((r) => r.id as string);
      const none = errOf(await tryRun(w.id.M2, `select public.restore_from_trash($1::uuid)`, [b2]));
      await run(null, `select set_config('kanbo.pa_write', 'on', true)`);
      await run(null, `update public.projects set visibility = 'workspace' where id = any ($1::uuid[])`, [narrowed]);
      await run(null, `select set_config('kanbo.pa_write', '', true)`);
      // Moe (its assignee) brings one back
      const r = (await run(w.id.M2, `select public.restore_from_trash($1::uuid) as r`, [b1]))[0].r as { note: string; project_id: string };
      const reads = async (who: Who) => (await run(w.id[who], `select id from public.tasks where id = $1::uuid`, [t1])).length;
      const row = (await run(null, `select assignee_id, collaborators from public.tasks where id = $1::uuid`, [t1]))[0];
      return { firstOpen, firstAny, none, r, row, reads: { M2: await reads("M2"), ME: await reads("ME"), A: await reads("A"), GC: await reads("GC") } };
    });
    eq(got.firstAny, w.proj.PW, "PW is the workspace's first project");
    ok(/no project to restore into/.test(got.none), `with no Whole workspace project: ${got.none || "restored"}`);
    eq(got.r.project_id, got.firstOpen.id, "it lands in the first Whole workspace project");
    ok(got.r.project_id !== w.proj.PW, "not in Private PW");
    eq(got.r.note, `Its project was deleted, so it's back in “${got.firstOpen.name}”.`, "and the note names only that one");
    eq(got.reads, { M2: 1, ME: 1, A: 1, GC: 0 }, "its assignee, its maker and an admin read it; Gail (not on the new project) doesn't");
    eq([got.row.assignee_id, got.row.collaborators], [w.id.M2, []], "Moe keeps it; Gail, who can't see it there, drops off");
  });

  await test("0058, switch on: re-parenting a task (parent_id alone) takes its sub-tasks to its new parent's project too", async () => {
    const got = await scenario(async (run) => {
      const mk = async (title: string, parent: string | null) => (await run(w.id.ME, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id, parent_id) values ($1::uuid, $2, $3, 'nobody', $4::uuid, $5::uuid) returning id::text as id`,
        [w.id.ME, title, w.proj.PW, w.ws, parent]))[0].id as string;
      const t = await mk("Zebra parent", null), c = await mk("Zebra child", t);
      await run(w.id.ME, `update public.tasks set parent_id = $2::uuid where id = $1::uuid`, [t, w.task.PP]);
      const at = async (id: string) => (await run(null, `select parent_id::text as parent, project_id as project from public.tasks where id = $1::uuid`, [id]))[0];
      return { t: await at(t), c: await at(c), c2: t };
    });
    eq(got.t, { parent: w.task.PP, project: w.proj.PP }, "the task has its new parent's project");
    eq(got.c, { parent: got.c2, project: w.proj.PP }, "and so does its sub-task");
  });

  await test("0058, switch on: a guest who owns a project (made a guest after making it) keeps it as a commenter, and sees its people", async () => {
    const got = await scenario(async (run, _exec, tryRun) => {
      const gp = (await run(w.id.O, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $1::uuid, 'Zebra Gil', $2::uuid, 'private') returning id::text as id`, [w.id.O, w.ws]))[0].id as string;
      await run(w.id.O, `select public.set_project_member($1::uuid, $2::uuid, 'viewer')`, [gp, w.id.ME]);
      // (the shape a member's own project has after they're made a guest)
      await run(null, `update public.projects set owner_id = $2::uuid where id = $1::uuid`, [gp, w.id.G2]);
      const task = await tryRun(w.id.O, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, 'Zebra Gil task', $2, $3, $4::uuid) returning id::text as id`, [w.id.O, gp, w.id.G2, w.ws]);
      const tid = "rows" in task ? task.rows[0].id as string : null;
      return {
        task: errOf(task),
        reads: (await run(w.id.G2, `select 1 from public.projects where id = $1::uuid`, [gp])).length,
        readsTask: tid ? (await run(w.id.G2, `select 1 from public.tasks where id = $1::uuid`, [tid])).length : -1,
        comments: tid ? okOf(await tryRun(w.id.G2, `insert into public.comments (task_id, user_id, body) values ($1::uuid, $2::uuid, 'mine') returning id`, [tid, w.id.G2])) : false,
        edits: tid ? (await run(w.id.G2, `update public.tasks set title = 'x' where id = $1::uuid returning id`, [tid])).length : -1,
        seesMeg: (await run(w.id.G2, `select public.pa_person_visible($1::uuid) as v`, [w.id.ME]))[0].v,
        seesMoe: (await run(w.id.G2, `select public.pa_person_visible($1::uuid) as v`, [w.id.M2]))[0].v,
        m2: (await run(w.id.M2, `select 1 from public.projects where id = $1::uuid`, [gp])).length,
        asMember: (await run(w.id.O, `select public.set_project_member($1::uuid, $2::uuid, 'editor') as r`, [gp, w.id.G2]))[0].r,
        manages: errOf(await tryRun(w.id.G2, `select public.set_project_visibility($1::uuid, 'workspace')`, [gp])),
      };
    });
    eq(got.task, "", "Gil can be assigned there");
    eq([got.reads, got.readsTask, got.comments, got.edits], [1, 1, true, 0], "Gil reads it and comments, and can't edit");
    eq([got.seesMeg, got.seesMoe], [true, false], "Gil sees its people (Meg), not the rest (Moe)");
    eq(got.m2, 0, "it's still Private to everyone else");
    eq(got.asMember, "owner", "Gil stays its owner");
    ok(/not authorized/.test(got.manages), `Gil can't change who sees it: ${got.manages || "changed"}`);
  });

  await test("0058: a signed-out request reads none of a workspace's rows, and no error (the switch on and off)", async () => {
    const tables = ["tasks", "projects", "profiles", "workspace_members", "comments", "sections", "status_updates", "forms"];
    const read = async () => {
      const out: Record<string, unknown> = {};
      for (const tb of tables) {
        const r = await attempt(null, `select count(*)::int as n from public.${tb}`, [],
          [[`select set_config('role', 'anon', true), set_config('request.jwt.claims', '{"role":"anon"}', true)`, []]]);
        out[tb] = "rows" in r ? r.rows[0].n : errOf(r);
      }
      return out;
    };
    const zero = Object.fromEntries(tables.map((tb) => [tb, 0]));
    eq(await read(), zero, "switch on");
    await sw(false);
    eq(await read(), zero, "switch off");
    await sw(true);
  });

  // ---------------------------------------------------------------- 14. what the database queues: the Inbox, held notices, webhooks
  await test("0058, switch on: the Inbox only tells people who can see the work (mentions, followers, update notices; a recap loses its private notes doc)", async () => {
    const mark = (await one<{ t: string }>(`select now()::text as t`)).t;
    await as(w.id.ME, `insert into public.comments (task_id, user_id, body, mentions) values ($1::uuid, $2::uuid, 'hey', $3::uuid[])`, [w.task.PP, w.id.ME, [w.id.M2, w.id.GC, w.id.O]]);
    const got = await q<{ u: string; k: string }>(`select user_id::text as u, kind as k from public.activity where task_id = $1::uuid and created_at >= $2::timestamptz`, [w.task.PP, mark]);
    eq(people(got.filter((r) => r.k === "mention").map((r) => r.u)), ["O"], "only the owner hears the mention");
    // a service-role insert for someone who can't see it: silently none, no error
    const svc = await attempt(null, `insert into public.activity (user_id, task_id, task_title, kind, detail) values ($1::uuid, $2::uuid, 'x', 'assigned', 'y') returning id`, [w.id.M2, w.task.PP]);
    eq("rows" in svc ? svc.rows.length : errOf(svc), 0, "dropped without an error");
    const rec = await attempt(null, `insert into public.activity (user_id, task_title, kind, detail, meta) values ($1::uuid, 'Recap', 'meeting', 'Oona', $2::jsonb) returning meta`,
      [w.id.M2, JSON.stringify({ meeting_id: w.task.PW, doc_id: w.doc.PP, project_id: w.proj.PP })]);
    eq("rows" in rec ? rec.rows[0].meta : errOf(rec), { meeting_id: w.task.PW }, "a recap is kept, without the doc");
    const doc = await attempt(null, `insert into public.activity (user_id, task_title, kind, detail, meta) values ($1::uuid, 'Doc', 'doc_mention', 'Oona', $2::jsonb) returning id`,
      [w.id.A, JSON.stringify({ doc_id: w.doc.PP, project_id: w.proj.PP })]);
    eq("rows" in doc ? doc.rows.length : errOf(doc), 0, "a doc mention in a project they can't see");
    const upd = await attempt(null, `insert into public.activity (user_id, task_title, kind, detail, meta) values ($1::uuid, 'Upd', 'update', 'Oona', $2::jsonb) returning id`,
      [w.id.MC, JSON.stringify({ status_update_id: w.update.PP, project_id: w.proj.PP })]);
    eq("rows" in upd ? upd.rows.length : errOf(upd), 0, "an update notice");
    const fine = await attempt(null, `insert into public.activity (user_id, task_id, task_title, kind, detail) values ($1::uuid, $2::uuid, 'x', 'assigned', 'y') returning id`, [w.id.M2, w.task.PW]);
    eq("rows" in fine ? fine.rows.length : errOf(fine), 1, "a task they can see");
  });

  if (await has("notify_queue")) {
    await test("0058, switch on: held notices never reach people who can't see the work (a service insert is dropped with no error; narrowing a project drops what's waiting)", async () => {
      const ins = (u: Who, task: string | null, payload: unknown, key: string) => attempt(null,
        `insert into public.notify_queue (user_id, channel, kind, event_key, bundle_key, task_id, payload) values ($1::uuid, 'email', $5, $2, $2, $3::uuid, $4::jsonb)
         on conflict (user_id, channel, event_key) do nothing returning id, payload`, [w.id[u], key, task, JSON.stringify(payload), task ? "comment" : "due"]);
      eq((await ins("M2", w.task.PP, { v: 1 }, "pa:1") as { rows: unknown[] }).rows.length, 0, "a hidden task: no row, no error");
      eq((await ins("ME", w.task.PP, { v: 1 }, "pa:2") as { rows: unknown[] }).rows.length, 1, "someone who can see it");
      const due = await ins("MC", null, { v: 1, due: { today: "2026-11-10", tasks: [{ id: w.task.PP, title: "x", due_date: "2026-11-10" }, { id: w.task.PW, title: "y", due_date: "2026-11-10" }], more: 0 } }, "pa:3");
      eq("rows" in due ? ((due.rows[0].payload as { due: { tasks: { id: string }[] } }).due.tasks.map((x) => x.id)) : errOf(due), [w.task.PW], "the due list keeps what they can see");
      eq((await ins("MC", null, { v: 1, due: { today: "2026-11-10", tasks: [{ id: w.task.PP, title: "x", due_date: "2026-11-10" }], more: 0 } }, "pa:4") as { rows: unknown[] }).rows.length, 0, "and goes when that's nothing");
      const about = await attempt(null, `insert into public.notify_queue (user_id, channel, kind, event_key, bundle_key, payload) values ($1::uuid, 'email', 'update', 'pa:5', 'pa:5', $2::jsonb) returning id`,
        [w.id.MC, JSON.stringify({ v: 1, about: { projects: [w.proj.PP] } })]);
      eq("rows" in about ? about.rows.length : errOf(about), 0, "an update notice about a project they can't see");
      // narrowing: M2's held notice on PW goes when PW turns Private (ME's stays: they're on it)
      await pg.query(`insert into public.notify_queue (user_id, channel, kind, event_key, bundle_key, task_id, payload) values ($1::uuid, 'email', 'comment', 'pa:held', 'pa:held', $2::uuid, '{}'::jsonb), ($3::uuid, 'email', 'comment', 'pa:held', 'pa:held', $2::uuid, '{}'::jsonb)`,
        [w.id.M2, w.task.PW, w.id.GC]);
      const left = await attempt(null, `select user_id::text as u from public.notify_queue where event_key = 'pa:held'`, [],
        [[`select set_config('request.jwt.claims', $1, true)`, [claims(w.id.O)]], [`select public.set_project_visibility($1::uuid, 'private')`, [w.proj.PW]]]);
      eq("rows" in left ? people(left.rows.map((r) => String(r.u))) : errOf(left), ["GC"], "M2's went when PW went private (GC is on it)");
      const kept = await attempt(null, `select user_id::text as u from public.notify_queue where event_key = 'pa:held'`, [],
        [[`select set_config('request.jwt.claims', $1, true)`, [claims(w.id.O)]], [`select public.set_project_visibility($1::uuid, 'members')`, [w.proj.PW]]]);
      eq("rows" in kept ? people(kept.rows.map((r) => String(r.u))) : errOf(kept), ["GC"], "and when it went Members only");
      await pg.query(`delete from public.notify_queue where event_key like 'pa:%'`);
    });
  }

  await test("0058, switch on: webhooks only deliver what their viewer can see (O's endpoint gets PP's events; M2's and a re-pointed one don't; a redeliver after narrowing fails)", async () => {
    const secret = "whsec_" + "a".repeat(43);
    const mkHook = async (by: Who, events: string[]) => (await one<{ id: string }>(`insert into public.webhooks (workspace_id, created_by, url, events, secret) values ($1::uuid, $2::uuid, 'https://hooks.example.com/' || gen_random_uuid(), $3::text[], $4) returning id::text as id`,
      [w.ws, w.id[by], events, secret])).id;
    const events = ["task.created", "task.updated", "comment.created", "project.updated"].concat((await one<{ e: string[] }>(`select public.webhook_event_names() as e`)).e.filter((e) => /approval|kudos|status_update/.test(e)));
    const hO = await mkHook("O", events), hME = await mkHook("ME", events), hM2 = await mkHook("M2", events), hRe = await mkHook("O", events);
    // (update_webhook as A: the definer function writes the row as A)
    await as(w.id.A, `select public.update_webhook($1::uuid, 'https://other.example.com/x')`, [hRe]);
    eq((await one<{ u: string }>(`select url_set_by::text as u from public.webhooks where id = $1::uuid`, [hRe])).u, w.id.A, "re-pointing makes A its viewer");
    await pg.query(`update public.webhook_outbox set processed_at = now() where processed_at is null`);
    // events in PP: a task, a comment, the project, an approval, kudos, an update
    await as(w.id.ME, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, 'hooked', $2, 'nobody', $3::uuid)`, [w.id.ME, w.proj.PP, w.ws]);
    await as(w.id.ME, `insert into public.comments (task_id, user_id, body) values ($1::uuid, $2::uuid, 'hooked')`, [w.task.PP, w.id.ME]);
    await as(w.id.O, `update public.projects set description = 'hooked' where id = $1::uuid`, [w.proj.PP]);
    await as(w.id.O, `select public.request_approval($1::uuid, array[$2::uuid])`, [w.sub.PP, w.id.ME]).catch(() => undefined);
    await as(w.id.O, `insert into public.status_updates (user_id, workspace_id, project_id, summary, status) values ($1::uuid, $2::uuid, $3, 'hooked', 'on_track')`, [w.id.O, w.ws, w.proj.PP]);
    const fanned = await q<{ n: number }>(`select public.webhook_claim_outbox(500) as n`);
    ok(fanned[0].n > 0, "something went out");
    const per = await q<{ h: string; n: number }>(`select webhook_id::text as h, count(*)::int as n from public.webhook_deliveries where webhook_id = any ($1::uuid[]) group by 1`, [[hO, hME, hM2, hRe]]);
    const n = (h: string) => per.find((x) => x.h === h)?.n ?? 0;
    ok(n(hO) >= 3, `O's endpoint: ${n(hO)}`);
    eq(n(hME), n(hO), "ME (an editor on PP) gets the same");
    eq(n(hM2), 0, "M2's gets none");
    eq(n(hRe), 0, "the one A re-pointed gets none");
    // narrowing PM: ME's pending delivery of a PM event fails once ME can't see it
    await pg.query(`update public.webhook_outbox set processed_at = now() where processed_at is null`);
    await as(w.id.O, `update public.tasks set title = title || '!' where id = $1::uuid`, [w.task.PW]);
    await q(`select public.webhook_claim_outbox(500)`);
    const mine = await q<{ id: string }>(`select d.id::text as id from public.webhook_deliveries d join public.webhook_outbox o on o.id = d.outbox_id where d.webhook_id = $1::uuid and o.payload #>> '{task,id}' = $2 and d.state = 'pending'`, [hM2, w.task.PW]);
    eq(mine.length, 1, "M2 gets PW's");
    await pg.query(`update public.webhook_deliveries set state = 'failed' where id = $1::uuid`, [mine[0].id]);
    await pg.query(`select set_config('kanbo.pa_write', 'on', false)`);
    await pg.query(`update public.projects set visibility = 'members' where id = $1::uuid`, [w.proj.PW]);
    await pg.query(`select set_config('kanbo.pa_write', '', false)`);
    const re = await attempt(w.id.M2, `select public.redeliver_webhook_delivery($1::uuid)`, [mine[0].id]);
    ok(okOf(re), errOf(re));
    const st = await attempt(null, `select state, error from public.webhook_deliveries where id = $1::uuid`, [mine[0].id],
      [[`update public.webhook_deliveries set state = 'pending', attempt = 0 where id = $1::uuid`, [mine[0].id]]]);
    eq("rows" in st ? st.rows[0] : errOf(st), { state: "failed", error: "not sent: no longer visible" }, "a redeliver to a viewer who can't see it");
    await pg.query(`update public.projects set visibility = 'workspace' where id = $1::uuid`, [w.proj.PW]);
    await pg.query(`delete from public.webhooks where id = any ($1::uuid[])`, [[hO, hME, hM2, hRe]]);
  });

  await test("0058, switch on: what's queued for a webhook follows its viewer (re-pointed by someone who can't see it, its owner made a guest, or the switch turned on in the SQL editor: it's never sent)", async () => {
    const got = await scenario(async (run) => {
      const secret = "whsec_" + "b".repeat(43);
      const mkHook = async (by: Who) => (await run(null, `insert into public.webhooks (workspace_id, created_by, url, events, secret) values ($1::uuid, $2::uuid, 'https://hooks.example.com/' || gen_random_uuid(), array['task.created'], $3) returning id::text as id`,
        [w.ws, w.id[by], secret]))[0].id as string;
      // (nothing else waiting, so the claim's per-workspace limits are all this test's)
      await run(null, `update public.webhook_deliveries set state = 'failed' where state = 'pending'`);
      await run(null, `update public.webhook_outbox set processed_at = now() where processed_at is null`);
      const hME = await mkHook("ME"), hMC = await mkHook("MC");
      const queue = async (title: string, project: string) => {
        await run(w.id.O, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, $2, $3, 'nobody', $4::uuid)`, [w.id.O, title, project, w.ws]);
        await run(null, `select public.webhook_claim_outbox(500)`);
      };
      const pending = async (hook: string) => (await run(null, `select o.payload #>> '{task,title}' as t from public.webhook_deliveries d join public.webhook_outbox o on o.id = d.outbox_id
                                                                where d.webhook_id = $1::uuid and d.state = 'pending' order by 1`, [hook])).map((r) => r.t as string);
      await queue("Zebra hooked PP", w.proj.PP);
      await queue("Zebra hooked PW", w.proj.PW);
      // ME's endpoint is down: the first try fails, and both wait for the next
      const first = await run(null, `select delivery_id::text as id from public.webhook_claim_deliveries(50, 90) where webhook_id = $1::uuid`, [hME]);
      for (const d of first) await run(null, `select public.webhook_record_result($1::uuid, 503)`, [d.id]);
      const before = await pending(hME);
      // Ari (an admin, not on PP) fixes the address
      await run(w.id.A, `select public.update_webhook($1::uuid, 'https://hooks.example.com/fixed')`, [hME]);
      const afterRepoint = await pending(hME);
      await run(null, `update public.webhook_deliveries set next_attempt_at = now() - interval '1 minute' where webhook_id = $1::uuid and state = 'pending'`, [hME]);
      const sent = (await run(null, `select payload #>> '{task,title}' as t from public.webhook_claim_deliveries(50, 90) where webhook_id = $1::uuid`, [hME])).map((r) => r.t as string);
      // Mac's endpoint has a PW event waiting; Mac is made a guest (not on PW)
      const macBefore = await pending(hMC);
      await run(null, `update public.workspace_members set role = 'guest' where workspace_id = $1::uuid and user_id = $2::uuid`, [w.ws, w.id.MC]);
      const macAfter = await pending(hMC);
      // the switch off, M2's endpoint gets a PP event; then the SQL editor switches it on
      await run(w.id.O, `select public.set_project_access($1::uuid, false)`, [w.ws]);
      const hM2 = await mkHook("M2");
      await queue("Zebra hooked PP off", w.proj.PP);
      const offPending = await pending(hM2);
      await run(null, `update public.workspaces set project_access = true where id = $1::uuid`, [w.ws]);
      return { first: first.length, before, afterRepoint, sent, macBefore, macAfter, offPending, onPending: await pending(hM2) };
    });
    eq(got.first, 2, "both went out once");
    eq(got.before, ["Zebra hooked PP", "Zebra hooked PW"], "and wait to be tried again");
    eq(got.afterRepoint, ["Zebra hooked PW"], "re-pointed by Ari, only what Ari can see still waits");
    eq(got.sent, ["Zebra hooked PW"], "so the new address never gets PP's");
    eq([got.macBefore.includes("Zebra hooked PW"), got.macAfter.includes("Zebra hooked PW")], [true, false], "Mac's PW event goes when Mac becomes a guest");
    eq(got.offPending, ["Zebra hooked PP off"], "with the switch off, Moe's endpoint gets PP's");
    eq(got.onPending, [], "switched on in the SQL editor, it's never sent");
  });

  // ---------------------------------------------------------------- 14b. narrowing roles, the bin's summaries, invites (hardening r1)
  await test("0058, switch on: what's queued for a webhook follows its viewer's role too (an admin made a member, an owner who hands over: never sent)", async () => {
    const got = await scenario(async (run) => {
      const secret = "whsec_" + "c".repeat(43);
      const mkHook = async (by: Who) => (await run(null, `insert into public.webhooks (workspace_id, created_by, url, events, secret) values ($1::uuid, $2::uuid, 'https://hooks.example.com/' || gen_random_uuid(), array['task.created'], $3) returning id::text as id`,
        [w.ws, w.id[by], secret]))[0].id as string;
      await run(null, `update public.webhook_deliveries set state = 'failed' where state = 'pending'`);
      await run(null, `update public.webhook_outbox set processed_at = now() where processed_at is null`);
      const hA = await mkHook("A"), hO = await mkHook("O");
      const queue = async (title: string, project: string) => {
        await run(w.id.O, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, $2, $3, 'nobody', $4::uuid)`, [w.id.O, title, project, w.ws]);
        await run(null, `select public.webhook_claim_outbox(500)`);
      };
      const pending = async (hook: string) => (await run(null, `select o.payload #>> '{task,title}' as t from public.webhook_deliveries d join public.webhook_outbox o on o.id = d.outbox_id
                                                                where d.webhook_id = $1::uuid and d.state = 'pending' order by 1`, [hook])).map((r) => r.t as string);
      await queue("Zebra hook PM", w.proj.PM);
      await queue("Zebra hook PQ", w.proj.PQ);
      await queue("Zebra hook PW", w.proj.PW);
      const before = { A: await pending(hA), O: await pending(hO) };
      // Oona makes Ari a member (not on PM): what waits for Ari's endpoint from PM never goes
      await run(w.id.O, `select public.set_member_role((select id from public.workspace_members where workspace_id = $1::uuid and user_id = $2::uuid), 'member')`, [w.ws, w.id.A]);
      const afterDemote = await pending(hA);
      // Oona hands the workspace to Moe and is an admin now (not on Meg's Private PQ): PQ's never goes to Oona's endpoint
      await run(w.id.O, `select public.transfer_ownership($1::uuid, (select id from public.workspace_members where workspace_id = $1::uuid and user_id = $2::uuid))`, [w.ws, w.id.M2]);
      const afterHandover = await pending(hO);
      await run(null, `update public.webhook_deliveries set next_attempt_at = now() - interval '1 minute' where state = 'pending'`);
      const claimed = (await run(null, `select webhook_id::text as h, payload #>> '{task,title}' as t from public.webhook_claim_deliveries(50, 90) where webhook_id in ($1::uuid, $2::uuid)`, [hA, hO]))
        .map((r) => `${r.h === hA ? "A" : "O"}:${r.t}`).sort();
      return { before, afterDemote, afterHandover, claimed };
    });
    eq(got.before, { A: ["Zebra hook PM", "Zebra hook PW"], O: ["Zebra hook PM", "Zebra hook PQ", "Zebra hook PW"] }, "queued for each as they could see then (Ari never had PQ's)");
    eq(got.afterDemote, ["Zebra hook PW"], "Ari made a member: PM's goes");
    eq(got.afterHandover, ["Zebra hook PM", "Zebra hook PW"], "Oona hands over and is an admin: Meg's Private PQ goes");
    eq(got.claimed, ["A:Zebra hook PW", "O:Zebra hook PM", "O:Zebra hook PW"], "and only those go out");
  });

  await test("0058: a bin row's summary names only its own scope's project and parent (a task of your own naming a Private project or task: whatever the switch says)", async () => {
    const got = await scenario(async (run) => {
      await run(null, `update public.projects set emoji = '🦓', color = '#123456' where id = $1::uuid`, [w.proj.PP]);
      const out: Record<string, unknown> = {};
      for (const who of ["M2", "GC", "X"] as const) {
        const u = w.id[who];
        // a Personal task "in" PP, under PP's task (ids read off a goal and a dependency), then binned
        const mine = (await run(u, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id, parent_id) values ($1::uuid, 'probe', $2, 'nobody', null, $3::uuid) returning id::text as id`,
          [u, w.proj.PP, w.task.PP]))[0].id as string;
        await run(u, `delete from public.tasks where id = $1::uuid`, [mine]);
        const s = (await run(u, `select summary from public.trash where item_id = $1::uuid`, [mine]))[0]?.summary as Record<string, unknown> | undefined;
        out[who] = s ? Object.keys(s).filter((k) => k === "project" || k === "parent").sort() : "no bin row";
      }
      // Xan, in Yonder (the switch off there): a team task naming Paddock's PP and its task
      const yt = (await run(w.id.X, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id, parent_id) values ($1::uuid, 'probe', $2, 'nobody', $3::uuid, $4::uuid) returning id::text as id`,
        [w.id.X, w.proj.PP, w.ws2, w.task.PP]))[0].id as string;
      await run(w.id.X, `delete from public.tasks where id = $1::uuid`, [yt]);
      const ys = (await run(w.id.O2, `select summary from public.trash where item_id = $1::uuid`, [yt]))[0]?.summary as Record<string, unknown>;
      out.yonder = Object.keys(ys).filter((k) => k === "project" || k === "parent").sort();
      // a sub-task of its own project keeps both; a Personal one under your own Personal task keeps its parent
      await run(w.id.ME, `delete from public.tasks where id = $1::uuid`, [w.sub.PM]);
      const pm = (await run(w.id.ME, `select summary from public.trash where item_id = $1::uuid`, [w.sub.PM]))[0].summary as { project?: { name: string }; parent?: { title: string } };
      out.own = [pm.project?.name, pm.parent?.title];
      const par = (await run(w.id.X, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, 'my parent', 'p-personal', 'nobody', null) returning id::text as id`, [w.id.X]))[0].id as string;
      const kid = (await run(w.id.X, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id, parent_id) values ($1::uuid, 'kid', 'p-personal', 'nobody', null, $2::uuid) returning id::text as id`, [w.id.X, par]))[0].id as string;
      await run(w.id.X, `delete from public.tasks where id = $1::uuid`, [kid]);
      out.personal = ((await run(w.id.X, `select summary #>> '{parent,title}' as t from public.trash where item_id = $1::uuid`, [kid]))[0] as { t: string }).t;
      return out;
    });
    eq(got.M2, [], "Moe (a member, not on PP) reads neither PP's name nor its task's title");
    eq(got.GC, [], "nor Gail (a guest)");
    eq(got.X, [], "nor Xan (an outsider)");
    eq(got.yonder, [], "a team task in another workspace naming them: neither");
    eq(got.own, ["Zebra PM", "Zebra plan PM"], "a sub-task in its own project keeps both");
    eq(got.personal, "my parent", "a Personal sub-task keeps its own parent");
  });

  await test("0058: switching on, the bin forgets a parent's title from another project (a sub-task moved on its own and binned while it was off, or before 0058)", async () => {
    const got = await scenario(async (run) => {
      await run(null, `update public.workspaces set project_access = false where id = $1::uuid`, [w.ws]);
      // off: a PW task under PP's task (as an old move would leave it), and PW's own sub-task; both binned
      const stray = (await run(w.id.M2, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id, parent_id) values ($1::uuid, 'stray', $2, 'nobody', $3::uuid, $4::uuid) returning id::text as id`,
        [w.id.M2, w.proj.PW, w.ws, w.task.PP]))[0].id as string;
      await run(w.id.M2, `delete from public.tasks where id = $1::uuid`, [stray]);
      await run(w.id.M2, `delete from public.tasks where id = $1::uuid`, [w.sub.PW]);
      const parentOf = async (who: Who, id: string) => {
        const r = (await run(w.id[who], `select summary #>> '{parent,title}' as t from public.trash where item_id = $1::uuid`, [id]))[0] as { t: string | null } | undefined;
        return r ? r.t ?? "none" : "no bin row";
      };
      const off = await parentOf("M2", stray);
      await run(null, `update public.workspaces set project_access = true where id = $1::uuid`, [w.ws]);
      const pwTitle = ((await run(null, `select title from public.tasks where id = $1::uuid`, [w.task.PW]))[0] as { title: string }).title;
      return { off, M2: await parentOf("M2", stray), GC: await parentOf("GC", stray), own: await parentOf("GC", w.sub.PW), pwTitle };
    });
    eq(got.off, "Zebra plan PP", "switched off, as before 0058");
    eq([got.M2, got.GC], ["none", "none"], "switched on, Moe and Gail still read the row, but no title from PP");
    eq(got.own, got.pwTitle, "a sub-task of the same project keeps its parent");
  });

  await test("0058, switch on: a pending invite's grant is its project's managers' to see and take off (made Private since: the admin who made it no longer reads it, and an edit of the whole list keeps it)", async () => {
    const got = await scenario(async (run, _exec, tryRun) => {
      // Meg's PQ is Members only for now: Ari (an admin) invites Ivy onto it (members may make projects private here)
      await run(null, `update public.workspaces set project_access_member_private = true where id = $1::uuid`, [w.ws]);
      await run(w.id.ME, `select public.set_project_visibility($1::uuid, 'members')`, [w.proj.PQ]);
      await run(w.id.A, `select public.set_invite_projects($1::uuid, $2::jsonb)`, [w.invite, JSON.stringify([{ project_id: w.proj.PQ, role: "commenter" }, { project_id: w.proj.PW, role: "viewer" }])]);
      const reads = async (who: Who) => (await run(w.id[who], `select project_id::text as p from public.project_member_invites where member_id = $1::uuid order by 1`, [w.invite]))
        .map((r) => Object.entries(w.proj).find(([, v]) => v === r.p)?.[0] ?? "?").sort();
      const before = { ME: await reads("ME"), A: await reads("A"), M2: await reads("M2") };
      // Meg makes it Private: Ari can't see it any more
      await run(w.id.ME, `select public.set_project_visibility($1::uuid, 'private')`, [w.proj.PQ]);
      const after = { ME: await reads("ME"), A: await reads("A") };
      // Ari's edit of the whole list (what Ari can read) keeps PQ's, and can't add one
      const edit = await tryRun(w.id.A, `select public.set_invite_projects($1::uuid, $2::jsonb) as n`, [w.invite, JSON.stringify([{ project_id: w.proj.PW, role: "commenter" }])]);
      const add = await tryRun(w.id.A, `select public.set_invite_projects($1::uuid, $2::jsonb) as n`, [w.invite, JSON.stringify([{ project_id: w.proj.PW, role: "commenter" }, { project_id: w.proj.PQ, role: "viewer" }])]);
      const stored = (await run(null, `select count(*)::int as n from public.project_member_invites where member_id = $1::uuid`, [w.invite]))[0].n;
      // only its managers take it off
      const byM2 = await tryRun(w.id.M2, `select public.remove_invite_project($1::uuid, $2::uuid) as r`, [w.invite, w.proj.PQ]);
      const byA = await tryRun(w.id.A, `select public.remove_invite_project($1::uuid, $2::uuid) as r`, [w.invite, w.proj.PQ]);
      const byME = await tryRun(w.id.ME, `select public.remove_invite_project($1::uuid, $2::uuid) as r`, [w.invite, w.proj.PQ]);
      return { before, after, edit: "rows" in edit ? edit.rows[0]?.n : errOf(edit), add: errOf(add), stored, byM2: errOf(byM2), byA: errOf(byA), byME: okOf(byME), left: await reads("O") };
    });
    eq(got.before, { ME: ["PQ"], A: ["PQ", "PW"], M2: [] }, "Meg (PQ's owner) reads PQ's grant; Ari both; Moe none");
    eq(got.after, { ME: ["PQ"], A: ["PW"] }, "made Private: Meg still sees it, Ari doesn't");
    eq(got.edit, 2, "Ari's edit of what Ari reads keeps PQ's");
    ok(/not authorized/.test(String(got.add)), `nor can Ari give a project Ari can't manage: ${got.add || "allowed"}`);
    eq(got.stored, 2, "both still there");
    ok(/not found/.test(String(got.byM2)) && /not found/.test(String(got.byA)), `Moe and Ari can't take it off: ${got.byM2} / ${got.byA}`);
    ok(got.byME, "Meg takes it off");
    eq(got.left, ["PW"], "only PW's is left");
  });

  await test("0058, switch on: work written into a Private project after its delete never counts as open to a team meeting (server)", async () => {
    const got = await scenario(async (run) => {
      await run(w.id.O, `delete from public.projects where id = $1::uuid`, [w.proj.PP]);
      // an old tab (the owner's offline queue, or the off window) writes into PP's id meanwhile
      const stray = (await run(w.id.O, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, 'Acme price: 4.2m', $2, $3, $4::uuid) returning id::text as id`,
        [w.id.O, w.proj.PP, w.id.ME, w.ws]))[0].id as string;
      const open = (await run(null, `select public.pa_task_audience_open('team', array[$1::uuid], $2) as t, public.pa_task_audience_open('leadership', array[$1::uuid], $2) as l,
                                            public.pa_task_audience_open('team', array[$1::uuid], $3) as loose`, [w.ws, stray, w.task.L2]))[0];
      let agenda: unknown = null;
      if (tables.has56) {
        const a = [{ key: "p", kind: "person", title: "Meg", personId: w.id.ME, done: [], today: [{ taskId: stray, title: "Acme price: 4.2m", status: "todo" }], blocked: [], holding: [], more: { done: 0, today: 0, blocked: 0 } }];
        agenda = (await run(w.id.ME, `select agenda from public.start_meeting($1::uuid, 'team', 'Team', null, $2::jsonb, null, null, null)`, [w.ws, JSON.stringify(a)]))[0].agenda;
      }
      return { open, agenda };
    });
    eq(got.open, { t: false, l: false, loose: true }, "closed for both presets (a loose id stays open)");
    if (tables.has56) eq((got.agenda as { today: unknown[] }[])[0].today, [], "and a team agenda drops it");
  });

  await test("0058: switched off (the rollback window), a task from a Members only or Private project that's gone doesn't land in the workspace's first project", async () => {
    const got = await scenario(async (run, _exec, tryRun) => {
      await run(w.id.ME, `delete from public.tasks where id = $1::uuid`, [w.sub.PP]);
      const bin = (await run(null, `select id::text as id from public.trash where item_id = $1::uuid and restored_at is null`, [w.sub.PP]))[0].id as string;
      await run(w.id.O, `delete from public.projects where id = $1::uuid`, [w.proj.PP]);
      await run(null, `update public.workspaces set project_access = false where id = $1::uuid`, [w.ws]);
      const r = await tryRun(w.id.M2, `select public.restore_from_trash($1::uuid) as r`, [bin]);
      // a Whole workspace project's task still goes 0047's way while it's off
      await run(w.id.M2, `delete from public.tasks where id = $1::uuid`, [w.sub.PW]);
      const bw = (await run(null, `select id::text as id from public.trash where item_id = $1::uuid and restored_at is null`, [w.sub.PW]))[0].id as string;
      await run(w.id.O, `delete from public.projects where id = $1::uuid`, [w.proj.PW]);
      const rw = await tryRun(w.id.M2, `select public.restore_from_trash($1::uuid) as r`, [bw]);
      return { r: errOf(r) || "restored", rw: errOf(rw) || "restored" };
    });
    ok(/restore its project first/.test(got.r), `a Private project's task: ${got.r}`);
    eq(got.rw, "restored", "a Whole workspace project's task");
  });

  if (await hasFn("public.goals_v2_guard()")) {
    await test("0058, switch on: a goal can't be pointed at a project you can't see by nulling its workspace in the same statement", async () => {
      const got = await scenario(async (run, _exec, tryRun) => {
        const g = (await run(null, `insert into public.goals (user_id, owner_id, workspace_id, name) values ($1::uuid, $1::uuid, $2::uuid, 'Grow') returning id::text as id`, [w.id.M2, w.ws]))[0].id as string;
        const plain = await tryRun(w.id.M2, `update public.goals set project_id = $2::uuid where id = $1::uuid returning id`, [g, w.proj.PP]);
        const nulled = await tryRun(w.id.M2, `update public.goals set project_id = $2::uuid, workspace_id = null where id = $1::uuid returning workspace_id::text as ws, project_id::text as p`, [g, w.proj.PP]);
        return { plain: errOf(plain), nulled: errOf(nulled) || JSON.stringify("rows" in nulled ? nulled.rows[0] : null) };
      });
      ok(/progress from a project in its own workspace/.test(got.plain), `plain: ${got.plain}`);
      ok(/progress from a project in its own workspace/.test(got.nulled), `with workspace_id = null: ${got.nulled}`);
    });
  }

  // ---------------------------------------------------------------- 15. leaving, demotion, invites
  await test("0058: removing someone from the workspace deletes their project rows (contributor_ids follows); demoting to guest caps editor at commenter", async () => {
    const tx = await attempt(null, `select (select count(*)::int from public.project_members where user_id = $2::uuid and workspace_id = $1::uuid) as rows,
        (select $2::uuid = any (contributor_ids) from public.projects where id = $3::uuid) as listed`, [w.ws, w.id.MC, w.proj.PM],
      [[`select set_config('request.jwt.claims', $1, true)`, [claims(w.id.O)]],
       [`select public.remove_member((select id from public.workspace_members where workspace_id = $1::uuid and user_id = $2::uuid))`, [w.ws, w.id.MC]]]);
    eq("rows" in tx ? tx.rows[0] : errOf(tx), { rows: 0, listed: false }, "removed");
    const dm = await attempt(null, `select role from public.project_members where user_id = $1::uuid and project_id = $2::uuid`, [w.id.ME, w.proj.PM],
      [[`update public.workspace_members set role = 'guest' where workspace_id = $1::uuid and user_id = $2::uuid`, [w.ws, w.id.ME]]]);
    eq("rows" in dm ? dm.rows[0].role : errOf(dm), "commenter", "demoted");
  });

  await test("0058, switch on: someone removed and invited back as a guest for one project sees only that one (the projects they owned went to the workspace's owner; the bin forgot them, and a restore doesn't bring them back)", async () => {
    const got = await scenario(async (run, _exec, tryRun) => {
      await run(null, `update public.workspaces set project_access = true where id = $1::uuid`, [w.ws]);
      // Meg owns PQ (Private), a Members only and a Whole workspace project of her own, and edits PP
      const mine = async (name: string, vis: string) =>
        (await run(w.id.ME, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility) values ($1::uuid, $1::uuid, $2, $3::uuid, $4) returning id::text as id`, [w.id.ME, name, w.ws, vis]))[0].id as string;
      const pz = await mine("Zebra Meg members", "members");
      const px = await mine("Zebra Meg open", "workspace");
      await run(w.id.ME, `insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) values ($1::uuid, 'Zebra Meg secret', $2, '', $3::uuid)`, [w.id.ME, pz, w.ws]);
      // a project of hers and one she edits go to the bin first
      const pb = (await run(w.id.ME, `insert into public.projects (user_id, owner_id, name, workspace_id, visibility, contributor_ids) values ($1::uuid, $1::uuid, 'Zebra Meg binned', $2::uuid, 'members', $3::uuid[]) returning id::text as id`, [w.id.ME, w.ws, [w.id.MC]]))[0].id as string;
      await run(w.id.ME, `delete from public.projects where id = $1::uuid`, [pb]);
      await run(w.id.O, `delete from public.projects where id = $1::uuid`, [w.proj.PP]);
      const bins = await run(null, `select id::text as id, item_id::text as item from public.trash where item_id = any ($1::uuid[]) and restored_at is null`, [[pb, w.proj.PP]]);
      const binOf = (p: string) => bins.find((b) => b.item === p)!.id as string;
      await run(w.id.O, `select public.remove_member((select id from public.workspace_members where workspace_id = $1::uuid and user_id = $2::uuid))`, [w.ws, w.id.ME]);
      const owners = await run(null, `select id::text as id, owner_id::text as o from public.projects where id = any ($1::uuid[])`, [[w.proj.PQ, pz, px]]);
      const binned = await run(null, `select item_id::text as item, access, snapshot #>> '{project,owner_id}' as snap_owner,
          snapshot #> '{project,contributor_ids}' as snap_people from public.trash where id = any ($1::uuid[])`, [[binOf(pb), binOf(w.proj.PP)]]);
      // invited back as a guest who should see PW only
      const inv = (await run(w.id.O, `select (public.invite_member($1::uuid, 'me.pa@example.org', 'Meg', 'guest')).id::text as id`, [w.ws]))[0].id as string;
      await run(w.id.O, `select public.set_invite_projects($1::uuid, $2::jsonb)`, [inv, JSON.stringify([{ project_id: w.proj.PW, role: "commenter" }])]);
      await run(null, `update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1::uuid`, [w.id.ME]);
      await run(w.id.ME, `select public.claim_invites()`);
      const reads = await run(w.id.ME, `select name from public.projects where workspace_id = $1::uuid order by name`, [w.ws]);
      const secret = await run(w.id.ME, `select 1 from public.tasks where project_id = $1`, [pz]);
      const comment = (await run(w.id.ME, `select public.can_comment_task($1::uuid) as c`, [w.task.PQ]))[0].c;
      const manages = errOf(await tryRun(w.id.ME, `select public.set_project_member($1::uuid, $2::uuid, 'viewer')`, [w.proj.PQ, w.id.M2]));
      const binReads = await run(w.id.ME, `select 1 from public.trash where id = any ($1::uuid[])`, [[binOf(pb), binOf(w.proj.PP)]]);
      const ppLeft = await run(w.id.ME, `select 1 from public.forms where project_id = $1 union all select 1 from public.status_updates where project_id = $1`, [w.proj.PP]);
      // the owner restores both
      await run(w.id.O, `select public.restore_from_trash($1::uuid)`, [binOf(w.proj.PP)]);
      await run(w.id.O, `select public.restore_from_trash($1::uuid)`, [binOf(pb)]);
      const rowsAfter = await run(null, `select project_id::text as p, role from public.project_members where user_id = $1::uuid order by 1`, [w.id.ME]);
      const pbOwner = (await run(null, `select owner_id::text as o from public.projects where id = $1::uuid`, [pb]))[0].o;
      const readsAfter = await run(w.id.ME, `select name from public.projects where workspace_id = $1::uuid order by name`, [w.ws]);
      return { owners, binned, reads, secret: secret.length, comment, manages, binReads: binReads.length, ppLeft: ppLeft.length, rowsAfter, pbOwner, readsAfter, pb };
    });
    for (const o of got.owners) eq(o.o, w.id.O, "a project Meg owned is the workspace owner's now");
    for (const b of got.binned) {
      const a = b.access as { owner: string; members: [string, string][] };
      ok(!a.members.some((m) => m[0] === w.id.ME), `the bin forgot Meg on ${b.item}`);
      ok(a.owner !== w.id.ME, "and as its owner");
      if (b.item === got.pb) {
        eq(b.snap_owner, w.id.O, "the binned project's own row is the owner's");
        ok(!(b.snap_people as string[]).includes(w.id.ME), "and doesn't list Meg");
      }
    }
    eq(got.reads.map((r) => r.name), ["Zebra PW"], "Meg, back as a guest for PW, reads PW only");
    eq([got.secret, got.comment], [0, false], "nothing of her old projects");
    ok(/not found|not authorized/.test(got.manages), `nor manages one: ${got.manages || "managed"}`);
    eq([got.binReads, got.ppLeft], [0, 0], "nor what's in the bin, nor what the binned PP left behind");
    eq(got.rowsAfter, [{ p: w.proj.PW, role: "commenter" }], "a restore puts her on nothing she wasn't given");
    eq(got.pbOwner, w.id.O, "and a restored project of hers is the workspace owner's");
    eq(got.readsAfter.map((r) => r.name), ["Zebra PW"], "she still reads PW only");
  });

  await test("0058, switch off: the per-row checks older rules make (approvals, their reviewers, kudos, plans) answer from the role alone, with no project lookups", async () => {
    const calls = await scenario(async (run) => {
      const count = async (on: boolean) => {
        await run(null, `update public.workspaces set project_access = $2 where id = $1::uuid`, [w.ws, on]);
        await run(null, `set local track_functions = 'all'`);
        const before = await run(null, `select funcname as f, calls::int as n from pg_stat_xact_user_functions where funcname in ('can_see_task', 'pa_rank_for')`);
        const tables = ["approvals", "approval_reviewers", "task_user_state", ...(await run(null, `select 1 from pg_class where oid = to_regclass('public.kudos')`)).length ? ["kudos"] : []];
        for (const tb of tables) await run(w.id.ME, `select count(*) from public.${tb}`);
        const after = await run(null, `select funcname as f, calls::int as n from pg_stat_xact_user_functions where funcname in ('can_see_task', 'pa_rank_for')`);
        const n = (rows: Record<string, unknown>[], f: string) => Number(rows.find((r) => r.f === f)?.n ?? 0);
        return { helper: n(after, "can_see_task") - n(before, "can_see_task"), rank: n(after, "pa_rank_for") - n(before, "pa_rank_for") };
      };
      return { off: await count(false), on: await count(true) };
    });
    ok(calls.off.helper > 0, `the helper is asked once a row: ${JSON.stringify(calls)}`);
    eq(calls.off.rank, 0, "switched off, no rank is worked out");
    ok(calls.on.rank > 0, `switched on, it is: ${JSON.stringify(calls)}`);
  });

  await test("0058: anyone who left before 0058 (or while its undo had the triggers out) is forgotten the same way when it runs (pa_forget_departed)", async () => {
    const got = await scenario(async (run) => {
      // R left long ago; the old rules left them owning PM, in a bin row's people and a history row's
      await run(null, `set local session_replication_role = replica`);
      await run(null, `update public.projects set owner_id = $2::uuid where id = $1::uuid`, [w.proj.PM, w.id.R]);
      const tr = (await run(null, `insert into public.trash (workspace_id, user_id, kind, item_id, project_id, title, snapshot, access)
          values ($1::uuid, $2::uuid, 'project', gen_random_uuid(), null, 'Zebra gone', jsonb_build_object('project', jsonb_build_object('owner_id', $3::text, 'contributor_ids', jsonb_build_array($3::text, $4::text))),
                  jsonb_build_object('v', 1, 'visibility', 'private', 'owner', $3::text, 'members', jsonb_build_array(jsonb_build_array($3::text, 'editor'), jsonb_build_array($4::text, 'viewer'))))
          returning id::text as id`, [w.ws, w.id.O, w.id.R, w.id.MC]))[0].id as string;
      await run(null, `set local session_replication_role = origin`);
      const n = (await run(null, `select public.pa_forget_departed() as n`))[0].n;
      const again = (await run(null, `select public.pa_forget_departed() as n`))[0].n;
      const pm = (await run(null, `select owner_id::text as o from public.projects where id = $1::uuid`, [w.proj.PM]))[0].o;
      const t = (await run(null, `select access, snapshot from public.trash where id = $1::uuid`, [tr]))[0];
      return { n, again, pm, t };
    });
    eq([got.n, got.again], [1, 0], "one project changed hands, once");
    eq(got.pm, w.id.O, "PM is the workspace owner's");
    const a = got.t.access as { owner: string; members: [string, string][] };
    eq([a.owner, a.members], [w.id.O, [[w.id.MC, "viewer"]]], "the bin row forgot R (Mac stays)");
    const s = got.t.snapshot as { project: { owner_id: string; contributor_ids: string[] } };
    eq([s.project.owner_id, s.project.contributor_ids], [w.id.O, [w.id.MC]], "and so did its snapshot");
  });

  await test("0058: a guest invited straight onto projects gets them when they join (set_invite_projects, then the claim)", async () => {
    const inv = await as<{ id: string }>(w.id.O, `select (public.invite_member($1::uuid, 'joiner.pa@example.org', 'Jo', 'guest')).id::text as id`, [w.ws]);
    ok(/invalid grants/.test(errOf(await attempt(w.id.O, `select public.set_invite_projects($1::uuid, '[{"project_id": "nope", "role": "viewer"}]'::jsonb)`, [inv[0].id]))), "junk");
    ok(/not found/.test(errOf(await attempt(w.id.ME, `select public.set_invite_projects($1::uuid, '[]'::jsonb)`, [inv[0].id]))), "a member can't");
    ok(/not authorized/.test(errOf(await attempt(w.id.A, `select public.set_invite_projects($1::uuid, $2::jsonb)`, [inv[0].id, JSON.stringify([{ project_id: w.proj.PP, role: "viewer" }])]))), "a project the admin can't manage");
    const n = await as<{ n: number }>(w.id.O, `select public.set_invite_projects($1::uuid, $2::jsonb) as n`, [inv[0].id, JSON.stringify([{ project_id: w.proj.PP, role: "editor" }, { project_id: w.proj.PM, role: "viewer" }])]);
    eq(n[0].n, 2, "stored");
    eq((await as(w.id.GC, `select 1 from public.project_member_invites`)).length, 0, "a guest can't read invites");
    const jo = await makeUser(pg, "joiner.pa@example.org", "Jo");
    await pg.query(`update auth.users set email_confirmed_at = now() where id = $1::uuid`, [jo]);
    await pg.query(`update public.profiles set approved = true where id = $1::uuid`, [jo]);
    await as(jo, `select public.claim_invites()`);
    const rows = await q<{ p: string; r: string }>(`select project_id::text as p, role as r from public.project_members where user_id = $1::uuid order by role`, [jo]);
    eq(rows.map((r) => [Object.entries(w.proj).find(([, v]) => v === r.p)![0], r.r]), [["PP", "commenter"], ["PM", "viewer"]], "a guest's editor is a commenter");
    eq((await q(`select 1 from public.project_member_invites where member_id = $1::uuid`, [inv[0].id])).length, 0, "the invites are used up");
    const theirs = (await one<{ n: number }>(`select count(*)::int as n from public.tasks where workspace_id = $1::uuid and project_id in ($2, $3)`, [w.ws, w.proj.PP, w.proj.PM])).n;
    eq((await as<{ n: number }>(jo, `select count(*)::int as n from public.tasks where workspace_id = $1::uuid`, [w.ws]))[0].n, theirs, "they see PP's and PM's tasks only");
  });

  // ---------------------------------------------------------------- 16. API key scope
  await test("0058: a team API key for another workspace reads nothing of this one's project people", async () => {
    const r = await pg.transaction(async (tx) => {
      await tx.query(WITH_USER_SQL, [claims(w.id.O), w.ws2]);
      return (await tx.query<{ n: number }>(`select (select count(*)::int from public.project_members) + (select count(*)::int from public.project_member_invites) as n`)).rows[0].n;
    });
    eq(r, 0, "w2's key");
  });

  await test("0058: the service helpers (closed_project_ids, project_is_open, user_visible_task_ids) and their grants", async () => {
    const closed = (await one<{ c: string[] }>(`select public.closed_project_ids($1::uuid) as c`, [w.ws])).c;
    eq([...closed].sort(), [w.proj.PM, w.proj.PP, w.proj.PQ].sort(), "Members only and Private, switch on");
    eq((await one<{ a: boolean; b: boolean; c: boolean }>(`select public.project_is_open($1::uuid, $2) as a, public.project_is_open($1::uuid, $3) as b, public.project_is_open($1::uuid, 'p-personal') as c`,
      [w.ws, w.proj.PW, w.proj.PP])), { a: true, b: false, c: true }, "open: Whole workspace and loose");
    const ids = (await one<{ v: string[] }>(`select public.user_visible_task_ids($1::uuid, $2::uuid[]) as v`, [w.id.MC, SPOTS.map((s) => w.task[s])])).v;
    eq(ids.map((i) => SPOTS.find((s) => w.task[s] === i)).sort(), SPOTS.filter((s) => rank("MC", s, true) >= 1).sort(), "MC's visible tasks");
    await sw(false);
    eq((await one<{ c: string[] }>(`select public.closed_project_ids($1::uuid) as c`, [w.ws])).c, [], "none while it's off");
    await sw(true);
    for (const f of ["public.user_project_rank(uuid,uuid,text)", "public.user_can_see_task(uuid,uuid)", "public.closed_project_ids(uuid)", "public.project_access_intact()",
                     "public.project_access_restore()", "public.pa_rank_for(uuid,uuid,text)", "public.pa_flush_held(uuid,uuid)", "public.pa_trg_tasks()"]) {
      eq((await one<{ a: boolean; b: boolean }>(`select has_function_privilege('authenticated', $1, 'execute') as a, has_function_privilege('anon', $1, 'execute') as b`, [f])), { a: false, b: false }, `${f} isn't callable from the app`);
    }
    for (const f of ["public.pa_rank(uuid,text)", "public.can_comment_task(uuid)", "public.set_project_member(uuid,uuid,text)"]) {
      eq((await one<{ a: boolean; b: boolean }>(`select has_function_privilege('authenticated', $1, 'execute') as a, has_function_privilege('anon', $1, 'execute') as b`, [f])), { a: true, b: false }, `${f}: signed in only`);
    }
  });

  await test("0058, switch on: a task's files in storage follow the task (a shared file reads only for people who can see its task)", async () => {
    for (const p of PROJ) {
      await pg.query(`insert into storage.objects (bucket_id, name, owner) values ('task-files', $1, $2::uuid)`, [`${w.id[OWNER[p]]}/${w.task[p]}/f.txt`, w.id[OWNER[p]]]);
    }
    for (const who of WHO) for (const p of PROJ) {
      const r = await attempt(w.id[who], `select name from storage.objects where bucket_id = 'task-files' and name = $1`, [`${w.id[OWNER[p]]}/${w.task[p]}/f.txt`]);
      eq("rows" in r ? r.rows.length : errOf(r), rank(who, p, true) >= 1 || who === OWNER[p] ? 1 : 0, `${who} reads ${p}'s file`);
    }
  });

  // ---------------------------------------------------------------- 17. VERIFY and grants
  await test("0058: its VERIFY block says true in every column", async () => {
    const sql = migrationSql("0058_project_access.sql");
    const block = sql.slice(sql.indexOf("-- VERIFY")).split("\n").filter((l) => /^-- {0,3}\S|^--\s{2,}/.test(l)).map((l) => l.replace(/^--\s?/, "")).join("\n");
    const at = block.indexOf("\nselect");
    const select = block.slice(at, block.indexOf(";", at) + 1).replace("not exists (select 1 from public.workspaces where project_access)", "true");
    const row = (await q<Record<string, boolean>>(select))[0];
    eq(Object.entries(row).filter(([, v]) => v !== true).map(([k]) => k), [], "columns not true");
    ok(Object.keys(row).length >= 10, `${Object.keys(row).length} columns`);
  });

  // ---------------------------------------------------------------- 18. performance
  await test("0058: 5 000 tasks in 50 projects behind the switch: a member's and a guest's count(*) under 3 s, through an InitPlan; an owner's costs no per-row lookups", async () => {
    const wp = (await one<{ id: string }>(`insert into public.workspaces (name, owner_id) values ('Busy', $1::uuid) returning id::text as id`, [w.id.O])).id;
    await pg.query(`insert into public.workspace_members (workspace_id, user_id, email, name, role, status) values ($1::uuid, $2::uuid, 'o', 'o', 'owner', 'active'), ($1::uuid, $3::uuid, 'm', 'm', 'member', 'active'), ($1::uuid, $4::uuid, 'g', 'g', 'guest', 'active')`, [wp, w.id.O, w.id.ME, w.id.GC]);
    await pg.query(`insert into public.projects (user_id, owner_id, name, workspace_id, visibility) select $1::uuid, $1::uuid, 'P' || i, $2::uuid, (array['workspace','members','private'])[1 + i % 3] from generate_series(1, 50) i`, [w.id.O, wp]);
    await pg.query(`insert into public.project_members (project_id, workspace_id, user_id, role) select p.id, $1::uuid, $2::uuid, 'editor' from public.projects p where p.workspace_id = $1::uuid and right(p.name, 1) in ('1', '2')`, [wp, w.id.ME]);
    await pg.query(`insert into public.project_members (project_id, workspace_id, user_id, role) select p.id, $1::uuid, $2::uuid, 'commenter' from public.projects p where p.workspace_id = $1::uuid and right(p.name, 1) = '3'`, [wp, w.id.GC]);
    await pg.query(`set session_replication_role = replica`);
    await pg.query(`insert into public.tasks (user_id, title, project_id, assignee_id, workspace_id) select $1::uuid, 'Busy ' || i, (select id::text from public.projects where workspace_id = $2::uuid order by name offset (i % 50) limit 1), 'nobody', $2::uuid from generate_series(1, 5000) i`, [w.id.O, wp]);
    await pg.query(`set session_replication_role = default`);
    await pg.query(`update public.workspaces set project_access = true where id = $1::uuid`, [wp]);
    const timed = async (who: string) => { const t0 = Date.now(); const n = (await as<{ n: number }>(who, `select count(*)::int as n from public.tasks where workspace_id = $1::uuid`, [wp]))[0].n; return { ms: Date.now() - t0, n }; };
    const me = await timed(w.id.ME), gc = await timed(w.id.GC), o = await timed(w.id.O);
    ok(me.ms < 3000, `member: ${me.ms} ms`); ok(gc.ms < 3000, `guest: ${gc.ms} ms`);
    // ME: Whole workspace (17 projects) + their Members only and Private ones; GC: their commenter projects only
    ok(me.n > 0 && me.n < 5000, `member reads ${me.n}`); ok(gc.n > 0 && gc.n < me.n, `guest reads ${gc.n}`);
    eq(o.n, 5000, "the owner reads all");
    const plan = (await pg.transaction(async (tx) => {
      await tx.query(WITH_USER_SQL, [claims(w.id.ME), ""]);
      return (await tx.query<{ "QUERY PLAN": string }>(`explain (verbose, costs off) select count(*) from public.tasks where workspace_id = '${wp}'`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    }));
    ok(/InitPlan/.test(plan) && /pa_gated_ws/.test(plan), `the plan computes pa_gated_ws once: ${plan.slice(0, 400)}`);
    await pg.query(`update public.workspaces set project_access = false where id = $1::uuid`, [wp]);
    const oOff = await timed(w.id.O);
    await pg.query(`update public.workspaces set project_access = true where id = $1::uuid`, [wp]);
    const oOn = await timed(w.id.O);
    ok(oOn.ms <= Math.max(oOff.ms * 1.5, oOff.ms + 150), `owner on ${oOn.ms} ms vs off ${oOff.ms} ms`);
    console.log(`  0058, 5 000 tasks behind the switch: member ${me.ms} ms (${me.n} rows), guest ${gc.ms} ms (${gc.n}), owner ${oOn.ms} ms (switch off: ${oOff.ms} ms)`);
  });

  // ---------------------------------------------------------------- 19. again, undone, and older files again
  const snapshot = async () => {
    const qk = async (sql: string) => (await q<{ k: string }>(sql)).map((r) => r.k);
    return {
      policies: await qk(`select concat_ws(' | ', schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check) as k from pg_policies where schemaname in ('public', 'realtime') order by 1`),
      mine: await qk(`select concat_ws(' | ', tablename, policyname, permissive, cmd, qual, with_check) as k from pg_policies where schemaname = 'public'
                       and (policyname like 'project access:%' or policyname in ('project members: read', 'project invites: leads read')
                            or (policyname = 'api key scope' and tablename in ('project_members', 'project_member_invites'))) order by 1`),
      triggers: await qk(`select concat_ws(' | ', c.relname, t.tgname) as k from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ('public', 'auth') order by 1`),
      myTriggers: await qk(`select concat_ws(' | ', c.relname, t.tgname, pg_get_triggerdef(t.oid)) as k from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and t.tgname ~ '^trg_.*_pa(_|$)' order by 1`),
      bodies: await qk(`select concat_ws(' | ', p.proname, md5(p.prosrc)) as k from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'pa\\_%' or p.proname in
                         ('can_see_task','can_edit_task','can_see_project','can_edit_project','tasks_visible_to','toggle_task_follow','toggle_comment_reaction','can_see_status_update',
                          'can_comment_task','can_comment_project','set_project_access','set_project_visibility','set_project_member','remove_project_member','set_invite_projects',
                          'restore_from_trash')) order by 1`),
      rls: await qk(`select concat_ws(' | ', c.relname, c.relrowsecurity::text) as k from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`),
      grants: await qk(`select concat_ws(' | ', table_name, grantee, privilege_type) as k from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated') order by 1`),
    };
  };
  const diff = (was: string[], now: string[]) => [...was.filter((x) => !now.includes(x)).map((x) => `- ${x}`), ...now.filter((x) => !was.includes(x)).map((x) => `+ ${x}`)];
  const same = (before: Awaited<ReturnType<typeof snapshot>>, now: Awaited<ReturnType<typeof snapshot>>, after: string, keys: (keyof Awaited<ReturnType<typeof snapshot>>)[]) => {
    for (const k of keys) {
      const d = diff(before[k], now[k]);
      if (d.length) throw new Error(`${after}: ${k} changed: ${d.slice(0, 4).join(" ; ")}${d.length > 4 ? ` (and ${d.length - 4} more)` : ""}`);
    }
  };
  /** M2 can't read PP's task; GC can't comment on PW's task they aren't… (they are: so on PM's MV-only task); A can't see PP's bin row. */
  const spotChecks = async (label: string) => {
    eq((await as(w.id.M2, `select 1 from public.tasks where id = $1::uuid`, [w.task.PP])).length, 0, `${label}: M2 reads PP's task`);
    ok(!okOf(await attempt(w.id.GV, `insert into public.comments (task_id, user_id, body) values ($1::uuid, $2::uuid, 'x') returning id`, [w.task.PM, w.id.GV])), `${label}: GV (a viewer) comments on PM`);
    ok(!okOf(await attempt(w.id.G2, `insert into public.comments (task_id, user_id, body) values ($1::uuid, $2::uuid, 'x') returning id`, [w.task.PW, w.id.G2])), `${label}: G2 comments on PW they aren't on`);
    const bin = await one<{ id: string } | undefined>(`select id::text as id from public.trash where workspace_id = $1::uuid and project_id = $2 order by deleted_at desc limit 1`, [w.ws, w.proj.PP]);
    if (bin) eq((await as(w.id.A, `select 1 from public.trash where id = $1::uuid`, [bin.id])).length, 0, `${label}: A reads PP's bin row`);
    eq((await one<{ ok: boolean }>(`select public.project_access_intact() as ok`)).ok, true, `${label}: intact`);
  };

  await test("0058 run twice: nothing changes (policies, triggers, bodies, grants), recorded once, no member added or removed, contributor_ids as they were", async () => {
    const before = await snapshot();
    const members = await q(`select project_id, user_id, role from public.project_members order by 1, 2`);
    const contrib = await q(`select id, contributor_ids from public.projects order by id`);
    await applyFile(pg, "0058_project_access.sql");
    await applyFile(pg, "0058_project_access.sql");
    same(before, await snapshot(), "after 0058 twice", ["policies", "triggers", "myTriggers", "bodies", "rls", "grants"]);
    eq((await one<{ n: number }>(`select count(*)::int as n from public.schema_migrations where version = '0058'`)).n, 1, "recorded once");
    eq(await q(`select project_id, user_id, role from public.project_members order by 1, 2`), members, "members");
    eq(await q(`select id, contributor_ids from public.projects order by id`), contrib, "contributor_ids");
    await spotChecks("0058 twice");
  });

  await test("0058's undo: the old bodies come back word for word, the rules go, the data stays; then 0058 again puts every rule back (nobody re-added)", async () => {
    const before = await snapshot();
    const members = await q(`select project_id, user_id, role from public.project_members order by 1, 2`);
    // (0058 again brings the rows back to the people still in the workspace: R's stale row, planted past the triggers, goes)
    const staying = await q(`select m.project_id, m.user_id, m.role from public.project_members m
                              where public.pa_ws_member_role(m.user_id, m.workspace_id) <> 'none' order by 1, 2`);
    ok(staying.length === members.length - 1, "one stale row (R's)");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const undo = readFileSync(join(process.cwd(), "supabase", "rollback", "0058_project_access_undo.sql"), "utf8");
    await pg.exec(undo);
    await pg.exec(undo);   // (twice: safe)
    const body = (file: string, sig: string) => {
      const s = migrationSql(file); const i = s.indexOf(`create or replace function public.${sig}`);
      const a = s.indexOf("$$", i) + 2; return s.slice(a, s.indexOf("$$", a));
    };
    const originals: [string, string, string][] = [
      ["0025_security_hardening.sql", "toggle_comment_reaction(p_comment uuid, p_emoji text)", "public.toggle_comment_reaction(uuid,text)"],
      ["0042_rollout_hardening.sql", "can_edit_task(p_task uuid)", "public.can_edit_task(uuid)"],
      ["0042_rollout_hardening.sql", "toggle_task_follow(p_task uuid, p_follow boolean default null)", "public.toggle_task_follow(uuid,boolean)"],
      ["0043_integrations_push_forms_plans.sql", "can_see_task(p_task uuid)", "public.can_see_task(uuid)"],
      ["0043_integrations_push_forms_plans.sql", "tasks_visible_to(p_user uuid)", "public.tasks_visible_to(uuid)"],
      ["0047_bin_history_approvals_docs.sql", "can_see_project(p_project uuid)", "public.can_see_project(uuid)"],
      ["0047_bin_history_approvals_docs.sql", "can_edit_project(p_project uuid)", "public.can_edit_project(uuid)"],
      ["0047_bin_history_approvals_docs.sql", "restore_from_trash(p_id uuid)", "public.restore_from_trash(uuid)"],
    ];
    if (await has("status_update_comments")) originals.push(["0054_update_conversation.sql", "can_see_status_update(p_update uuid)", "public.can_see_status_update(uuid)"]);
    for (const [file, sig, reg] of originals) {
      const src = (await one<{ s: string }>(`select prosrc as s from pg_proc where oid = $1::regprocedure`, [reg])).s;
      eq(src, body(file, sig), `${reg} is ${file}'s again`);
    }
    eq((await q(`select 1 from pg_policies where policyname like 'project access:%'`)).length, 0, "the rules are gone");
    eq((await q(`select 1 from pg_trigger where tgname in ('trg_projects_pa_guard', 'trg_tasks_pa', 'trg_activity_pa_gate')`)).length, 0, "the triggers are gone");
    eq((await q(`select 1 from public.workspaces where project_access`)).length, 0, "every switch is off");
    eq((await q(`select 1 from public.schema_migrations where version = '0058'`)).length, 0, "not recorded");
    eq(await q(`select project_id, user_id, role from public.project_members order by 1, 2`), members, "the members are kept");
    // an older file run now skips its hook
    await applyFile(pg, "0043_integrations_push_forms_plans.sql");
    eq((await q(`select 1 from pg_policies where policyname like 'project access:%'`)).length, 0, "0043 again doesn't bring them back");
    const proj = await attempt(w.id.ME, `insert into public.projects (user_id, owner_id, name, workspace_id) values ($1::uuid, $1::uuid, 'After undo', $2::uuid) returning visibility`, [w.id.ME, w.ws]);
    eq("rows" in proj ? proj.rows[0].visibility : errOf(proj), "workspace", "inserts still work (the default is back)");
    await applyFile(pg, "0058_project_access.sql");
    await as(w.id.O, `select public.set_project_access($1::uuid, true)`, [w.ws]);
    same(before, await snapshot(), "after the undo and 0058 again", ["mine", "myTriggers", "bodies"]);
    eq(await q(`select project_id, user_id, role from public.project_members order by 1, 2`), staying, "nobody re-added; only the row of someone who'd left the workspace went");
    await spotChecks("undo + 0058");
  });

  await test("0058's undo, people changed the old way meanwhile, then 0058 again: project_members follows contributor_ids (nobody taken off comes back, nor anyone who left, nor anyone who listed themselves on a closed project)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const undo = readFileSync(join(process.cwd(), "supabase", "rollback", "0058_project_access_undo.sql"), "utf8");
    const back = new Map(Object.entries(w.id).map(([k, v]) => [v as string, k]));
    const pmPeople = (rows: Record<string, unknown>[]) => rows.map((r) => `${back.get(r.u as string) ?? r.u}:${r.role}`).sort();
    const peopleOf = async (run: Run, p: string) => pmPeople(await run(null, `select user_id::text as u, role from public.project_members where project_id = $1::uuid`, [p]));
    const got = await scenario(async (run, exec) => {
      const before = await peopleOf(run, w.proj.PM);
      await exec(undo);
      // the app as before 0058: PM's people are contributor_ids again (Gail off, Gil on); Gil goes on PW too;
      // Gwen leaves the workspace; and Moe, with no rules in the way, lists himself on Private PP
      await run(w.id.O, `update public.projects set contributor_ids = array_append(array_remove(contributor_ids, $2::uuid), $3::uuid) where id = $1::uuid`, [w.proj.PM, w.id.GC, w.id.G2]);
      await run(w.id.O, `update public.projects set contributor_ids = array_append(contributor_ids, $2::uuid) where id = $1::uuid`, [w.proj.PW, w.id.G2]);
      await run(null, `delete from public.workspace_members where workspace_id = $1::uuid and user_id = $2::uuid`, [w.ws, w.id.GV]);
      const selfAdd = (await run(w.id.M2, `update public.projects set contributor_ids = array_append(contributor_ids, $2::uuid) where id = $1::uuid returning id`, [w.proj.PP, w.id.M2])).length;
      const stale = (await run(null, `select count(*)::int as n from public.project_members where project_id = $1::uuid and user_id in ($2::uuid, $3::uuid)`, [w.proj.PM, w.id.GC, w.id.GV]))[0].n;
      await exec(migrationSql("0058_project_access.sql"));
      // Gwen is invited back as a guest, and the switch goes on again
      await run(null, `insert into public.workspace_members (workspace_id, user_id, email, name, role, status) values ($1::uuid, $2::uuid, 'gv.pa@example.org', 'Gwen', 'guest', 'active')`, [w.ws, w.id.GV]);
      await run(w.id.O, `select public.set_project_access($1::uuid, true)`, [w.ws]);
      const reads = async (who: Who, p: string) => (await run(w.id[who], `select id from public.projects where id = $1::uuid`, [p])).length;
      return {
        before, stale, selfAdd, GC: await reads("GC", w.proj.PM), GV: await reads("GV", w.proj.PM), G2: await reads("G2", w.proj.PM), G2PW: await reads("G2", w.proj.PW), M2PP: await reads("M2", w.proj.PP),
        people: await peopleOf(run, w.proj.PM), pw: await peopleOf(run, w.proj.PW), pp: await peopleOf(run, w.proj.PP),
        listed: (await run(null, `select $2::uuid = any (contributor_ids) as g2pm from public.projects where id = $1::uuid`, [w.proj.PM, w.id.G2]))[0],
        listedPP: (await run(null, `select $2::uuid = any (contributor_ids) as m2 from public.projects where id = $1::uuid`, [w.proj.PP, w.id.M2]))[0].m2,
        intact: (await run(null, `select public.project_access_intact() as ok`))[0].ok,
      };
    });
    eq(got.stale, 2, "while it's out, nothing keeps project_members in step");
    eq(got.selfAdd, 1, "while it's out, Moe could list himself on PP");
    eq([got.GC, got.GV, got.G2], [0, 0, 0], "Gail (taken off) and Gwen (left, back as a guest) don't read Members only PM, nor Gil (added there meanwhile)");
    eq(got.people, got.before.filter((x) => !x.startsWith("GC:") && !x.startsWith("GV:")), "PM's people, the others' roles kept");
    eq([got.G2PW, got.pw.includes("G2:commenter")], [1, true], "Gil added to Whole workspace PW meanwhile is on it");
    eq([got.M2PP, got.pp.some((x) => x.startsWith("M2:")), got.listedPP], [0, false, false], "Moe isn't on Private PP, nor listed");
    eq(got.listed.g2pm, false, "PM's list follows its people");
    eq(got.intact, true, "every rule back");
  });

  const ALL = migrationFiles();
  const applied = new Set(files);
  const rerun = async (label: string, chain: string[], full: boolean) => {
    const present = chain.filter((f) => applied.has(f));
    if (!present.length) return;
    await test(`0058 survives ${label} run again${full ? " (every policy kept, everywhere)" : ""}`, async () => {
      const before = await snapshot();
      for (const f of present) await applyFile(pg, f);
      same(before, await snapshot(), `after ${label}`, full ? ["policies", "mine", "triggers", "myTriggers", "bodies"] : ["mine", "myTriggers", "bodies"]);
      await spotChecks(label);
    });
  };
  const reruns = async () => {
    // (0046 and 0047 check every endpoint's events against their own lists, which later files widen:
    // before running them again, no endpoint may name a later file's event)
    await pg.query(`update public.webhooks set events = array['task.created']`);
    await rerun("0041", ["0041_security_hardening_2.sql"], true);
    await rerun("0048", ["0048_ux_wave.sql"], true);
    await rerun("0025 (then 0042, as 0042 asks)", ["0025_security_hardening.sql", "0042_rollout_hardening.sql"], false);
    await rerun("0042", ["0042_rollout_hardening.sql"], false);
    await rerun("0043", ["0043_integrations_push_forms_plans.sql"], false);
    await rerun("0046 (then 0047, 0048 and 0054, as they ask)", ["0046_api_webhooks_notion.sql", "0047_bin_history_approvals_docs.sql", "0048_ux_wave.sql", "0054_update_conversation.sql"], false);
    await rerun("0047", ["0047_bin_history_approvals_docs.sql"], false);
    for (const f of ["0051_guest_leadership_lock.sql", "0052_goals_v2.sql", "0053_update_rhythm.sql", "0054_update_conversation.sql", "0055_shared_availability.sql",
                     "0056_meetings.sql", "0057_adoption_health.sql"]) {
      await rerun(f.slice(0, 4), [f], false);
    }
  };
  if (!before0058) await reruns();

  // ---------------------------------------------------------------- 20. the live database: 0051..0057 after 0058
  if (before0058) {
    await test("0058 then 0051..0057 (the owner may run them in any order): every rule ends up on their tables too", async () => {
      for (const f of ALL.filter((x) => x >= "0051" && x < "0058")) await applyFile(pg, f);
      eq((await one<{ ok: boolean }>(`select public.project_access_intact() as ok`)).ok, true, "intact");
      for (const [tb, pol] of [["goal_links", "project access: read"], ["status_update_comments", "project access: replies"], ["bill_rates", "project access: read"]] as const) {
        eq((await q(`select 1 from pg_policies where tablename = $1 and policyname = $2`, [tb, pol])).length, 1, `${tb}`);
      }
      for (const [tb, tg] of [["meetings", "trg_meetings_pa"], ["update_asks", "trg_update_asks_pa"], ["goal_links", "trg_goal_links_pa"], ["status_updates", "trg_status_update_pa"]] as const) {
        eq((await q(`select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = $1 and t.tgname = $2`, [tb, tg])).length, 1, `${tb}'s ${tg}`);
      }
      ok((await one<{ s: string }>(`select prosrc as s from pg_proc where oid = 'public.can_see_status_update(uuid)'::regprocedure`)).s.includes("public.pa_"), "0054's helper has 0058's body");
      await spotChecks("0051..0057 after 0058");
    });
    tables.has48 = await has("saved_views"); tables.has52 = await has("goal_links"); tables.has53 = await has("update_asks");
    tables.has54 = await has("status_update_comments"); tables.has55 = await has("bill_rates"); tables.has56 = await has("meetings");
    await test("0058 then 0051..0057: the world gets its goal links, update replies, rates and asks", async () => { await extend(w); });
    await test("0058 then 0051..0057: their tables follow the model too (goal links, update replies, rates, asks), switch on and off", async () => {
      const newer = new Set(["goal_links", "update_asks", "bill_rates", "status_update_comments", "status_update_reactions", "status_update_views"]);
      const want = model(true, opts);
      const got = await battery(opts);
      noMismatch(mismatches(got, want, (k) => k.startsWith("read:") && newer.has(k.split(":")[2]) || k.startsWith("fn:")), "on");
      await sw(false);
      const gotOff = await battery(opts);
      noMismatch(mismatches(gotOff, model(false, opts), (k) => k.startsWith("read:") && newer.has(k.split(":")[2]) || k.startsWith("fn:")), "off");
      await sw(true);
    });
    for (const f of ALL.filter((x) => x >= "0051" && x <= "0058")) applied.add(f);
    await reruns();
  }
}

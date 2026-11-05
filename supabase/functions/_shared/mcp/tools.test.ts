// @vitest-environment node
// The tool list against the handlers it says it calls, and each tool's answers
// against its own outputSchema, with a fake API.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coreRoutes } from "../api/routes.ts";
import { matchRoute } from "../api/router.ts";
import type { ApiTask } from "../api/serialise.ts";
import type { ApiPrincipal } from "../api/types.ts";
import { MCP_ROUTES } from "./handler.ts";
import { mcpExtraRoutes } from "./apiExtras.ts";
import { schemaErrors } from "./jsonSchema.ts";
import { cut, describeTool, faultOf, MAX_JSON_CHARS, runTool, taskView, toolNamed, TOOLS, toolsFor, type ApiAnswer, type ApiCall, type ToolEnv } from "./tools.ts";

const ME = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const SANA = "55555555-5555-4555-8555-555555555555";

const apiTask = (o: Partial<ApiTask> = {}): ApiTask => ({
  object: "task", id: TASK, title: "Write the plan", description: "Some notes", status: "todo", priority: "medium", workspaceId: WS, projectId: PROJECT, sectionId: null, parentId: null,
  assigneeId: ME, createdBy: ME, dueDate: "2026-11-06", dueTime: null, startDate: null, completedAt: null, tags: [{ id: "design", label: "Design", color: "x" }, { id: "abc", label: null, color: null }], effortHours: null, loggedHours: null,
  isMilestone: false, recurrence: "none", archived: false, archivedAt: null, createdAt: null, updatedAt: "2026-11-01T00:00:00.000Z", url: `https://www.kanbo.co.uk/?task=${TASK}`, slackPermalink: null, ...o,
});
const apiProject = { object: "project", id: PROJECT, workspaceId: WS, name: "Launch", emoji: "🚀", color: null, description: "Launching", status: "on_track", ownerId: ME, contributorIds: [], createdBy: ME, archived: false, archivedAt: null, createdAt: null, url: `https://www.kanbo.co.uk/p/${PROJECT}` };
const apiComment = { object: "comment", id: "c1", taskId: TASK, parentId: null, authorId: ME, authorName: "Daniel", body: "Hello", mentions: [], createdAt: "2026-11-02T10:00:00.000Z" };
const list = <T,>(data: T[], nextCursor: string | null = null) => ({ object: "list", data, nextCursor, hasMore: nextCursor !== null });

const principal = (o: Partial<ApiPrincipal> = {}): ApiPrincipal => ({ keyId: "g", userId: ME, workspaceId: null, access: "write", ...o });

type Call = { method: string; path: string; query?: Record<string, string | undefined>; body?: unknown; idempotencyKey?: string };

function env(routes: (c: Call) => ApiAnswer | undefined, o: { principal?: ApiPrincipal; via?: "oauth" | "api_key"; clientName?: string | null } = {}) {
  const calls: Call[] = [];
  const api: ApiCall = async (method, path, opts = {}) => {
    const c = { method, path, ...opts };
    calls.push(c);
    return routes(c) ?? { status: 404, body: { error: { code: "not_found", message: "Task not found.", status: 404 } } };
  };
  const e: ToolEnv = { api, principal: o.principal ?? principal(), via: o.via ?? "oauth", clientName: o.clientName === undefined ? "Claude" : o.clientName, now: () => new Date("2026-11-04T12:00:00Z") };
  return { e, calls };
}

const standard = (c: Call): ApiAnswer | undefined => {
  if (c.path === "/me") return { status: 200, body: { object: "user", id: ME, email: "d@example.org", name: "Daniel", key: { id: "g", access: "write", workspaceId: null } } };
  if (c.path === "/workspaces") return { status: 200, body: list([{ object: "workspace", id: WS, name: "Foundry", logoUrl: null, ownerId: ME, role: "owner", createdAt: null }]) };
  if (c.path === "/projects" && c.method === "GET") return { status: 200, body: list([apiProject]) };
  if (c.path === "/projects" && c.method === "POST") return { status: 201, body: { ...apiProject, name: (c.body as { name: string }).name } };
  if (c.path === `/projects/${PROJECT}`) return { status: 200, body: apiProject };
  if (c.path === "/members") return { status: 200, body: list([{ object: "member", id: "m", workspaceId: WS, userId: SANA, name: "Sana Rao", email: "s@example.org", role: "member", status: "active", title: null, createdAt: null }]) };
  if (c.path === "/tasks" && c.method === "GET") return { status: 200, body: list([apiTask()], "next") };
  if (c.path === "/tasks" && c.method === "POST") return { status: 201, body: apiTask(c.body as Partial<ApiTask>) };
  if (c.path === `/tasks/${TASK}` && c.method === "GET") return { status: 200, body: apiTask() };
  if (c.path === `/tasks/${TASK}` && c.method === "PATCH") return { status: 200, body: apiTask(c.body as Partial<ApiTask>) };
  if (c.path === `/tasks/${TASK}/complete`) return { status: 200, body: apiTask({ status: "done" }) };
  if (c.path === `/tasks/${TASK}/bin`) return { status: 200, body: { object: "task", id: TASK, title: "Write the plan", inRecycleBin: true, keptForDays: 30 } };
  if (c.path === `/tasks/${TASK}/comments` && c.method === "GET") return { status: 200, body: list([apiComment]) };
  if (c.path === `/tasks/${TASK}/comments` && c.method === "POST") return { status: 201, body: apiComment };
  if (c.path === "/search") return { status: 200, body: { object: "list", data: [{ kind: "task", id: TASK, title: "Write the plan", url: `https://www.kanbo.co.uk/?task=${TASK}` }, { kind: "project", id: PROJECT, title: "Launch", url: null }] } };
  if (c.path === "/my-day") return { status: 200, body: { object: "my_day", date: "2026-11-04", timezone: "Europe/London", summary: "1 overdue.", counts: { overdue: 1, dueToday: 0, approvals: 0, planned: 0, blocked: 0 }, truncated: false, items: [{ kind: "overdue", taskId: TASK, title: "Late", reason: "Was due yesterday.", status: "todo", priority: "high", dueDate: "2026-11-03", dueTime: null, projectId: PROJECT, workspaceId: WS, url: "https://www.kanbo.co.uk/", approvalId: null }] } };
  return undefined;
};

/** Good arguments for every tool. A new tool fails this suite until it has some. */
const FIXTURES: Record<string, Record<string, unknown>> = {
  whoami: {},
  list_workspaces: {},
  list_projects: { workspaceId: WS, includeArchived: true, limit: 5 },
  list_members: { workspaceId: WS },
  list_tasks: { assignee: "me", status: ["todo", "progress"], projectId: PROJECT, dueBefore: "2026-12-01", dueAfter: "2026-01-01", query: "plan", cursor: "abc", limit: 10 },
  get_task: { taskId: TASK },
  search: { query: "plan" },
  fetch: { id: `task:${TASK}` },
  my_day: { timezone: "Europe/London" },
  add_task: { title: "New", dueDate: "2026-11-06", priority: "high", projectId: PROJECT },
  update_task: { taskId: TASK, title: "Changed", status: "review" },
  complete_task: { taskId: TASK },
  delete_task: { taskId: TASK },
  add_comment: { taskId: TASK, body: "Hello" },
  create_project: { name: "New project", workspaceId: WS },
};

describe("the tool list", () => {
  it("is the agreed fifteen, in a fixed order", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "whoami", "list_workspaces", "list_projects", "list_members", "list_tasks", "get_task", "search", "fetch", "my_day",
      "add_task", "update_task", "complete_task", "delete_task", "add_comment", "create_project",
    ]);
  });

  it("has no bulk delete and nothing permanent", () => {
    for (const t of TOOLS) expect(t.name).not.toMatch(/purge|bulk|delete_.*s$|empty|hard/);
    const del = toolNamed("delete_task")!;
    expect(del.routes).toEqual([["DELETE", "/tasks/:id/bin"]]);
    expect(del.inputSchema.properties).not.toHaveProperty("hard");
    expect(Object.keys(del.inputSchema.properties!)).toEqual(["taskId"]);
  });

  it.each(TOOLS.map((t) => [t.name, t] as const))("%s is well formed", (_n, t) => {
    expect(t.name.length).toBeLessThanOrEqual(64);
    expect(t.name).toMatch(/^[a-z_]+$/);
    expect(t.title).toBeTruthy();
    expect(t.annotations.title).toBe(t.title);
    expect(t.description.length).toBeGreaterThan(30);
    expect(t.inputSchema.type).toBe("object");
    expect(t.inputSchema.additionalProperties).toBe(false);
    expect(t.outputSchema.type).toBe("object");
    for (const bad of ["oneOf", "anyOf", "allOf"]) {
      expect(t.inputSchema).not.toHaveProperty(bad);
      expect(t.outputSchema).not.toHaveProperty(bad);
    }
    expect(t.annotations.openWorldHint).toBe(false);
    expect(describeTool(t)).toEqual({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations });
  });

  it("descriptions say what happens, without telling the model what to do", () => {
    for (const t of TOOLS) {
      expect(t.description, t.name).not.toMatch(/\byou must\b|\balways\b|\bnever\b ask|ignore|before using/i);
      if (t.write) expect(t.description, t.name).toMatch(/\b(doesn't|can't|only|one)\b/);
      else expect(t.description, t.name).toMatch(/Changes nothing/);
    }
  });

  it("annotations match what each tool does", () => {
    for (const t of TOOLS) {
      expect(t.annotations.readOnlyHint, t.name).toBe(!t.write);
      if (!t.write) { expect(t.annotations.destructiveHint, t.name).toBe(false); expect(t.annotations.idempotentHint, t.name).toBe(true); }
    }
    expect(toolNamed("delete_task")!.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(toolNamed("update_task")!.annotations.destructiveHint).toBe(true);
    expect(toolNamed("complete_task")!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
    for (const n of ["add_task", "add_comment", "create_project"]) expect(toolNamed(n)!.annotations, n).toMatchObject({ destructiveHint: false, idempotentHint: false });
  });

  it("read-only credentials don't see write tools", () => {
    expect(toolsFor("read").map((t) => t.name)).toEqual(["whoami", "list_workspaces", "list_projects", "list_members", "list_tasks", "get_task", "search", "fetch", "my_day"]);
    expect(toolsFor("write")).toHaveLength(15);
  });

  it("the order doesn't depend on who's asking", () => {
    expect(toolsFor("read").map((t) => t.name)).toEqual(toolsFor("write").map((t) => t.name).filter((n) => toolsFor("read").some((t) => t.name === n)));
  });
});

describe("the contract with the handlers", () => {
  const sample = (p: string) => p.replace(/:id/g, TASK);

  it.each(TOOLS.flatMap((t) => t.routes.map((r) => [t.name, r[0], r[1]] as const)))("%s calls %s %s, which exists", (_n, method, path) => {
    const m = matchRoute(MCP_ROUTES, method, sample(path));
    expect(m.kind, `${method} ${path}`).toBe("match");
  });

  it("a read tool only calls GET routes; a write tool has a write route", () => {
    for (const t of TOOLS) {
      if (!t.write) expect(t.routes.every((r) => r[0] === "GET"), t.name).toBe(true);
      else expect(t.routes.some((r) => r[0] !== "GET"), t.name).toBe(true);
    }
  });

  it("every task, project and comment write and read in the REST API has its tool; the rest are named on purpose", () => {
    const used = new Set(TOOLS.flatMap((t) => t.routes.map((r) => `${r[0]} ${r[1]}`)));
    const notExposed = new Set([
      "GET /sections", "POST /sections", "PATCH /projects/:id", "DELETE /tasks/:id",   // archive-style delete: delete_task uses the bin
    ]);
    for (const r of coreRoutes) {
      const k = `${r.method} ${r.path}`;
      expect(used.has(k) || notExposed.has(k), `${k} has no tool: add one, or say why not here`).toBe(true);
    }
  });

  it("the extra routes are the MCP pipeline's only, never the public REST API's", () => {
    for (const r of mcpExtraRoutes) {
      expect(coreRoutes.some((c) => c.method === r.method && c.path === r.path)).toBe(false);
      expect(MCP_ROUTES).toContain(r);
    }
    expect(MCP_ROUTES.some((r) => r.path.startsWith("/webhooks"))).toBe(false);
    const openapi = readFileSync("supabase/functions/_shared/api/openapi.ts", "utf8");
    expect(openapi).not.toContain("/my-day");
  });

  it("every structured result fits its outputSchema", async () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const t of TOOLS) {
      const { e } = env(standard);
      expect(schemaErrors(t.inputSchema, FIXTURES[t.name]), `${t.name} fixture`).toEqual([]);
      const r = await runTool(t, FIXTURES[t.name], e);
      expect(r.isError, `${t.name}: ${r.content[0].text}`).toBeFalsy();
      expect(schemaErrors(t.outputSchema, r.structuredContent), t.name).toEqual([]);
      // the text fallback has the ids and the JSON
      expect(r.content[0].text, t.name).toContain(JSON.stringify(r.structuredContent));
    }
  });
});

describe("runTool", () => {
  it("a bad argument comes back as an isError in plain words", async () => {
    const { e, calls } = env(standard);
    const r = await runTool(toolNamed("get_task")!, {}, e);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/taskId is required/);
    expect(calls).toEqual([]);
    expect((await runTool(toolNamed("list_tasks")!, { nope: 1 }, e)).content[0].text).toMatch(/nope isn't a field/);
    expect((await runTool(toolNamed("list_tasks")!, { limit: 500 }, e)).content[0].text).toMatch(/at most 50/);
    expect((await runTool(toolNamed("list_tasks")!, { status: ["nope"] }, e)).content[0].text).toMatch(/one of/);
    expect((await runTool(toolNamed("whoami")!, [], e)).content[0].text).toMatch(/must be object/);
    // no arguments at all is the same as {}
    expect((await runTool(toolNamed("whoami")!, undefined, e)).isError).toBeFalsy();
    expect((await runTool(toolNamed("whoami")!, null, e)).isError).toBeFalsy();
  });

  it("read-only: a write tool is refused without calling anything", async () => {
    for (const via of ["oauth", "api_key"] as const) {
      const { e, calls } = env(standard, { principal: principal({ access: "read" }), via });
      const r = await runTool(toolNamed("add_task")!, { title: "x" }, e);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/read-only/);
      expect(calls).toEqual([]);
    }
  });

  it("API errors become plain sentences with the field named, never a stack", async () => {
    const { e } = env(() => ({ status: 422, body: { error: { code: "validation_failed", message: "Some fields need attention.", status: 422, details: { fields: { dueDate: "Use a date like 2026-10-31, or null." } } } } }));
    expect((await runTool(toolNamed("update_task")!, { taskId: TASK, dueDate: "soon" }, e)).content[0].text).toBe("dueDate: Use a date like 2026-10-31, or null.");
    const { e: e2 } = env(() => ({ status: 500, body: { error: { message: "secret detail" } } }));
    expect((await runTool(toolNamed("whoami")!, {}, e2)).content[0].text).toBe("Kanbo couldn't do that just now. Try again in a moment.");
    const { e: e3 } = env(() => { throw new Error("connection string leaked"); });
    const logged: string[] = [];
    const r = await runTool(toolNamed("whoami")!, {}, e3, (m) => logged.push(m));
    expect(r.content[0].text).toBe("Kanbo couldn't do that just now. Try again in a moment.");
    expect(logged[0]).toMatch(/whoami/);
  });

  it("faultOf words pinned connections and rate limits", () => {
    expect(faultOf({ status: 403, body: { error: { message: "This key is limited to one workspace. Use a personal key to reach other workspaces or your Personal list." } } }).message).toMatch(/connection is limited to one workspace/);
    expect(faultOf({ status: 429, body: { error: { message: "Too many requests: a key can make 120 a minute. Try again in 5 seconds." } } }).message).toMatch(/Too many requests.*Nothing was changed/);
    expect(faultOf({ status: 404, body: null }).message).toBeTruthy();
  });

  it("the structured arguments reach the API by their REST names", async () => {
    const { e, calls } = env(standard);
    await runTool(toolNamed("list_tasks")!, FIXTURES.list_tasks, e);
    expect(calls[0].query).toMatchObject({ assignee: "me", status: "todo,progress", project: PROJECT, due_before: "2026-12-01", due_after: "2026-01-01", q: "plan", cursor: "abc", limit: "10" });
  });

  it("whoami says what kind of connection this is", async () => {
    const { e } = env(standard, { via: "api_key", clientName: null, principal: principal({ access: "read", workspaceId: WS }) });
    expect((await runTool(toolNamed("whoami")!, {}, e)).structuredContent).toEqual({ id: ME, name: "Daniel", email: "d@example.org", access: "read", workspaceId: WS, connection: "api_key", app: null });
  });

  it("list_workspaces says whether the Personal list is in reach", async () => {
    expect((await runTool(toolNamed("list_workspaces")!, {}, env(standard).e)).structuredContent).toMatchObject({ personalList: true });
    expect((await runTool(toolNamed("list_workspaces")!, {}, env(standard, { principal: principal({ workspaceId: WS }) }).e)).structuredContent).toMatchObject({ personalList: false });
  });

  it("get_task brings its comments and sub-tasks", async () => {
    const { e, calls } = env(standard);
    const r = await runTool(toolNamed("get_task")!, { taskId: TASK }, e);
    expect(r.structuredContent).toMatchObject({ task: { id: TASK, tags: ["Design", "abc"] }, comments: [{ id: "c1", body: "Hello" }], commentsTruncated: false, subtasksTruncated: true });
    expect(calls.map((c) => c.path)).toEqual([`/tasks/${TASK}`, `/tasks/${TASK}/comments`, "/tasks"]);
    expect(calls[2].query).toMatchObject({ parent: TASK });
  });

  it("search and fetch use ChatGPT's exact shapes, text being exactly the JSON", async () => {
    const s = await runTool(toolNamed("search")!, { query: "plan" }, env(standard).e);
    expect(s.structuredContent).toEqual({ results: [
      { id: `task:${TASK}`, title: "Write the plan", url: `https://www.kanbo.co.uk/?task=${TASK}` },
      { id: `project:${PROJECT}`, title: "Launch", url: "https://www.kanbo.co.uk" },
    ] });
    expect(JSON.parse(s.content[0].text)).toEqual(s.structuredContent);
    const f = await runTool(toolNamed("fetch")!, { id: `task:${TASK}` }, env(standard).e);
    expect(f.structuredContent).toMatchObject({ id: `task:${TASK}`, title: "Write the plan", url: `https://www.kanbo.co.uk/?task=${TASK}` });
    expect((f.structuredContent as { text: string }).text).toContain("Some notes");
    expect((f.structuredContent as { text: string }).text).toContain("Daniel");
    expect(JSON.parse(f.content[0].text)).toEqual(f.structuredContent);
    const bare = await runTool(toolNamed("fetch")!, { id: TASK }, env(standard).e);
    expect(bare.structuredContent).toMatchObject({ id: `task:${TASK}` });
    const p = await runTool(toolNamed("fetch")!, { id: `project:${PROJECT}` }, env(standard).e);
    expect(p.structuredContent).toMatchObject({ id: `project:${PROJECT}`, title: "Launch", text: "Launching" });
  });

  it("my_day passes on the time zone and the plan", async () => {
    const { e, calls } = env(standard);
    const r = await runTool(toolNamed("my_day")!, { timezone: "Asia/Tokyo" }, e);
    expect(calls[0].query).toEqual({ timezone: "Asia/Tokyo" });
    expect(r.content[0].text).toMatch(/^2026-11-04: 1 overdue\./);
    expect((r.structuredContent as { items: { reason: string }[] }).items[0].reason).toBe("Was due yesterday.");
  });

  it("delete_task says it's the recycle bin", async () => {
    const r = await runTool(toolNamed("delete_task")!, { taskId: TASK }, env(standard).e);
    expect(r.content[0].text).toMatch(/recycle bin.*30 days/);
    expect(r.structuredContent).toEqual({ id: TASK, title: "Write the plan", inRecycleBin: true, keptForDays: 30 });
  });

  it("update_task needs something to change", async () => {
    expect((await runTool(toolNamed("update_task")!, { taskId: TASK }, env(standard).e)).content[0].text).toMatch(/at least one field/);
  });

  it("idempotency keys travel as the header, not in the body", async () => {
    const { e, calls } = env(standard);
    await runTool(toolNamed("add_task")!, { title: "x", idempotencyKey: "k" }, e);
    expect(calls[0].idempotencyKey).toBe("k");
    expect(calls[0].body).not.toHaveProperty("idempotencyKey");
    const c = env(standard);
    await runTool(toolNamed("add_comment")!, { taskId: TASK, body: "hi", idempotencyKey: "k2" }, c.e);
    expect(c.calls[0].idempotencyKey).toBe("k2");
    const p = env(standard);
    await runTool(toolNamed("create_project")!, { name: "x", idempotencyKey: "k3" }, p.e);
    expect(p.calls[0].idempotencyKey).toBe("k3");
    expect(p.calls[0].body).toEqual({ name: "x" });
  });
});

describe("add_task reading a sentence", () => {
  const post = (calls: Call[]) => calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;

  it("reads the example from the brief", async () => {
    const { e, calls } = env(standard);
    const r = await runTool(toolNamed("add_task")!, { text: "Send the brief fri 3pm #launch @sana !high ~30m" }, e);
    expect(r.isError).toBeFalsy();
    expect(post(calls)).toEqual({ title: "Send the brief", dueDate: "2026-11-06", dueTime: "15:00", priority: "high", projectId: PROJECT, assigneeId: SANA, effortHours: 0.5 });
    expect((r.structuredContent as { notes: string[] }).notes).toEqual([]);
  });

  it("counts days from the person's time zone", async () => {
    const { e, calls } = env(standard);
    const late: ToolEnv = { ...e, now: () => new Date("2026-11-04T23:30:00Z") };
    await runTool(toolNamed("add_task")!, { text: "Ring back tomorrow", timezone: "Asia/Tokyo" }, late);
    expect(post(calls).dueDate).toBe("2026-11-06");
    const london = env(standard);
    await runTool(toolNamed("add_task")!, { text: "Ring back tomorrow" }, { ...london.e, now: late.now });
    expect(post(london.calls).dueDate).toBe("2026-11-05");
  });

  it("what you say in fields wins over the sentence", async () => {
    const { e, calls } = env(standard);
    await runTool(toolNamed("add_task")!, { text: "Call Sana fri !high", priority: "low", dueDate: "2027-01-01", title: "My title" }, e);
    expect(post(calls)).toMatchObject({ title: "My title", priority: "low", dueDate: "2027-01-01" });
  });

  it("no project: on your Personal list, assigned to you, and @someone can't be matched", async () => {
    const { e, calls } = env(standard);
    const r = await runTool(toolNamed("add_task")!, { text: "Buy milk @sana #nowhere" }, e);
    expect(post(calls).assigneeId).toBe("me");
    expect(post(calls).projectId).toBeUndefined();
    const notes = (r.structuredContent as { notes: string[] }).notes;
    expect(notes.join(" ")).toMatch(/nowhere/);
    expect(notes.join(" ")).toMatch(/sana/);
    expect(calls.some((c) => c.path === "/members")).toBe(false);
  });

  it("a one-workspace connection reads @people from its workspace, and doesn't default to the Personal list", async () => {
    const { e, calls } = env(standard, { principal: principal({ workspaceId: WS }) });
    await runTool(toolNamed("add_task")!, { text: "Plan @sana", projectId: PROJECT }, e);
    expect(calls.find((c) => c.path === "/members")?.query).toMatchObject({ workspace: WS });
    expect(post(calls)).toMatchObject({ assigneeId: SANA, projectId: PROJECT });
    const n = env(standard, { principal: principal({ workspaceId: WS }) });
    await runTool(toolNamed("add_task")!, { title: "No project" }, n.e);
    expect(post(n.calls).assigneeId).toBeUndefined();
  });

  it("@me is you", async () => {
    const { e, calls } = env(standard);
    await runTool(toolNamed("add_task")!, { text: "Do it #launch @me" }, e);
    expect(post(calls).assigneeId).toBe("me");
  });

  it("needs a title or a sentence, and a sentence with words left", async () => {
    expect((await runTool(toolNamed("add_task")!, {}, env(standard).e)).content[0].text).toMatch(/title, or a sentence/);
    expect((await runTool(toolNamed("add_task")!, { text: "fri 3pm" }, env(standard).e)).content[0].text).toMatch(/no words left/);
    expect((await runTool(toolNamed("add_task")!, { title: "x", timezone: "Mars/Olympus" }, env(standard).e)).content[0].text).toMatch(/time zone/);
  });
});

describe("long text and big answers", () => {
  it("cut flags what it cuts, and never splits an emoji", () => {
    expect(cut("hello", 10)).toEqual({ text: "hello", truncated: false });
    expect(cut("hello", 3)).toEqual({ text: "hel", truncated: true });
    expect(cut("ab😀", 3)).toEqual({ text: "ab", truncated: true });
  });

  it("a task's long description is cut and flagged", () => {
    const v = taskView(apiTask({ description: "x".repeat(5000) }));
    expect(v.description).toHaveLength(200);
    expect(v.descriptionTruncated).toBe(true);
    expect(taskView(apiTask(), 100).descriptionTruncated).toBe(false);
  });

  it("a page over the size cap comes back smaller, with a true cursor", async () => {
    const huge = apiTask({ title: "t".repeat(450), description: "d".repeat(5000) });
    const asked: string[] = [];
    const { e } = env((c) => {
      if (c.path !== "/tasks") return undefined;
      const limit = Number(c.query?.limit);
      asked.push(String(limit));
      return { status: 200, body: list(Array.from({ length: limit }, (_, i) => ({ ...huge, id: `id-${i}` })), `cursor-after-${limit}`) };
    });
    const r = await runTool(toolNamed("list_tasks")!, { limit: 50 }, e);
    const out = r.structuredContent as { tasks: unknown[]; nextCursor: string };
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_JSON_CHARS);
    expect(asked[0]).toBe("50");
    expect(asked).toHaveLength(2);
    expect(out.tasks.length).toBe(Number(asked[1]));
    expect(out.nextCursor).toBe(`cursor-after-${asked[1]}`);
    // JSON + its copy as text + a summary stay near the cap on the whole answer
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(2 * MAX_JSON_CHARS + 6000);
  });

  it("get_task: everything under the cap, flags saying what's missing", async () => {
    const { e } = env((c) => {
      if (c.path === `/tasks/${TASK}`) return { status: 200, body: apiTask({ description: "d".repeat(20000) }) };
      if (c.path === `/tasks/${TASK}/comments`) return { status: 200, body: list(Array.from({ length: 20 }, (_, i) => ({ ...apiComment, id: `c${i}`, body: "b".repeat(5000) }))) };
      if (c.path === "/tasks") return { status: 200, body: list(Array.from({ length: 20 }, (_, i) => apiTask({ id: `s${i}`, description: "s".repeat(5000) }))) };
      return undefined;
    });
    const r = await runTool(toolNamed("get_task")!, { taskId: TASK }, e);
    const out = r.structuredContent as { task: { descriptionTruncated: boolean }; comments: { bodyTruncated: boolean }[]; commentsTruncated: boolean; subtasks: unknown[]; subtasksTruncated: boolean };
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_JSON_CHARS);
    expect(out.task.descriptionTruncated).toBe(true);
    expect(out.subtasksTruncated).toBe(true);
    expect(schemaErrors(toolNamed("get_task")!.outputSchema, out)).toEqual([]);
  });

  it("my_day and search stay under the cap too", async () => {
    const item = { kind: "overdue", taskId: TASK, title: "t".repeat(500), reason: "r".repeat(200), status: "todo", priority: "low", dueDate: null, dueTime: null, projectId: null, workspaceId: null, url: "https://k", approvalId: null };
    const d = await runTool(toolNamed("my_day")!, {}, env(() => ({ status: 200, body: { date: "2026-11-04", timezone: "Europe/London", summary: "s", counts: { overdue: 40, dueToday: 0, approvals: 0, planned: 0, blocked: 0 }, items: Array(40).fill(item), truncated: false } })).e);
    const day = d.structuredContent as { items: unknown[]; truncated: boolean; counts: { overdue: number } };
    expect(JSON.stringify(day).length).toBeLessThanOrEqual(MAX_JSON_CHARS);
    expect(day.truncated).toBe(true);
    expect(day.counts.overdue).toBe(40);
    const s = await runTool(toolNamed("search")!, { query: "x" }, env(() => ({ status: 200, body: { data: Array.from({ length: 200 }, (_, i) => ({ kind: "task", id: `x${i}`, title: "t".repeat(500), url: "https://k" })) } })).e);
    expect(JSON.stringify(s.structuredContent).length).toBeLessThanOrEqual(MAX_JSON_CHARS);
  });
});

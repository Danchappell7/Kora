// @vitest-environment node
// The webhook REST routes (webhooks.ts webhookRoutes) against a fake UserDb:
// every query runs inside withUser as the key's user, workspace keys are held
// to their workspace, read keys can't change anything, inputs are checked and
// the database's refusals become the API's JSON errors. The SQL itself is
// replayed against the real 0046 functions in the PGlite harness.
import { describe, expect, it } from "vitest";
import { buildOpenApi } from "./openapi.ts";
import { matchRoute, type RouteContext } from "./router.ts";
import type { ApiPrincipal, Tx, UserScope } from "./types.ts";
import { WEBHOOK_SQL, webhookOpenApiPaths, webhookRoutes } from "./webhooks.ts";

const ME = "bbbbbbbb-0000-4000-8000-000000000002";
const W = "11111111-0000-4000-8000-000000000001";
const X = "22222222-0000-4000-8000-000000000002";
const HOOK_W = "c924fcff-0938-4900-a8e7-9cbbb564a762";
const HOOK_P = "d0d0d0d0-0938-4900-a8e7-9cbbb564a762";
const DEL = "1aefcd04-d7e3-4f30-96e8-2a7008b6045c";
const SECRET = "whsec_jdGsQXdTNkPSgmI33ZLnz23lIrUXcu9vDtOYAOWNaJQ";

const hookJson = (id: string, ws: string | null, extra: Record<string, unknown> = {}) => ({
  id, workspace_id: ws, url: "https://hooks.example.com/kanbo", description: null, events: ["task.created"], active: true,
  created_by: ME, created_by_name: "Bob", failure_count: 0, last_status: null, last_error: null, last_delivery_at: null,
  disabled_at: null, disabled_reason: null, created_at: "2026-10-05T18:04:26.295+00:00", updated_at: "2026-10-05T18:04:26.295+00:00",
  can_manage: true, ...extra,
});
const PING = "2bbbbbbb-d7e3-4f30-96e8-2a7008b6045c";
const deliveryJson = { id: DEL, webhook_id: HOOK_W, outbox_id: 4, event: "task.created", state: "failed", attempt: 6, status_code: 0,
  error: "timeout", duration_ms: 10000, next_attempt_at: null, delivered_at: null, created_at: "2026-10-05T18:04:26.351+00:00", updated_at: "2026-10-05T18:04:26.368+00:00" };

/** A fake database: the hooks it holds, and what each SQL statement answers. */
function fakeDb(opts: { hooks?: Record<string, unknown>[]; fail?: Partial<Record<keyof typeof WEBHOOK_SQL, Error>> } = {}) {
  const hooks = opts.hooks ?? [hookJson(HOOK_W, W), hookJson(HOOK_P, null)];
  const calls: { scope: UserScope; sql: string; params: readonly unknown[] }[] = [];
  const which = (sql: string) => (Object.entries(WEBHOOK_SQL).find(([, v]) => v === sql)?.[0] ?? "?") as keyof typeof WEBHOOK_SQL;
  const db = {
    calls,
    scopes: [] as UserScope[],
    async withUser<T>(scope: UserScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
      db.scopes.push(scope);
      const tx: Tx = {
        async query<R>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
          calls.push({ scope, sql, params });
          const k = which(sql);
          const err = opts.fail?.[k];
          if (err) throw err;
          switch (k) {
            case "visible": {
              const [ws, id] = params as [string | null, string | null];
              const list = hooks.filter((h) => (ws === null || h.workspace_id === ws) && (id === null || h.id === id));
              return [{ list }] as R[];
            }
            case "list": return [{ list: hooks.filter((h) => h.workspace_id === params[0]) }] as R[];
            case "create": return [{ webhook: { ...hookJson("eeeeeeee-0000-4000-8000-00000000000e", params[0] as string | null, { url: params[1], events: JSON.parse(params[2] as string) }), secret: SECRET } }] as R[];
            case "update": return [{ webhook: hookJson(params[0] as string, W, { active: params[3] ?? true }) }] as R[];
            case "remove": return [{ ok: true }] as R[];
            case "rotate": return [{ result: { id: params[0], secret: SECRET } }] as R[];
            case "test": return [{ result: { outbox_id: 4813 } }] as R[];
            case "deliveries": return [{ list: [deliveryJson, { ...deliveryJson, id: PING, event: "ping" }] }] as R[];
            case "redeliver": return [{ result: { id: params[0], state: "pending" } }] as R[];
            default: throw new Error(`unexpected SQL: ${sql}`);
          }
        },
      };
      return fn(tx);
    },
  };
  return db;
}

const personalWrite: ApiPrincipal = { keyId: "k1", userId: ME, workspaceId: null, access: "write" };
const personalRead: ApiPrincipal = { ...personalWrite, keyId: "k2", access: "read" };
const teamWrite: ApiPrincipal = { keyId: "k3", userId: ME, workspaceId: W, access: "write" };

async function call(principal: ApiPrincipal, method: string, pathAndQuery: string, body?: unknown, db = fakeDb(),
  init: { contentType?: string; raw?: string; preParsed?: boolean } = {}) {
  const url = new URL(`https://x.supabase.co/functions/v1/api/v1${pathAndQuery}`);
  const path = url.pathname.replace("/functions/v1/api/v1", "");
  const m = matchRoute(webhookRoutes, method, path);
  if (m.kind !== "match") return { res: null as Response | null, json: null as never, db, match: m };
  const hasBody = body !== undefined || init.raw !== undefined;
  const req = new Request(url, {
    method,
    headers: hasBody ? { "content-type": init.contentType ?? "application/json" } : {},
    body: hasBody ? (init.raw ?? JSON.stringify(body)) : undefined,
  });
  const ctx: RouteContext & { body?: unknown } = {
    req, url, method: method as RouteContext["method"], params: m.params, principal, db, service: { query: async () => [] },
    requestId: "req_0123456789abcdef", appUrl: "https://www.kanbo.co.uk", apiBase: "https://x.supabase.co/functions/v1/api/v1",
    ...(init.preParsed ? { body } : {}),
  };
  const res = await m.route.handler(ctx);
  const text = res.status === 204 ? "" : await res.text();
  return { res, json: text ? JSON.parse(text) : null, db, match: m };
}

describe("listing", () => {
  it("a personal key lists every endpoint it can see, read-only, as the key's user, camelCase, never a secret", async () => {
    const { res, json, db } = await call(personalRead, "GET", "/webhooks");
    expect(res!.status).toBe(200);
    expect(res!.headers.get("x-request-id")).toBe("req_0123456789abcdef");
    expect(db.scopes).toEqual([{ userId: ME, workspaceId: null, readOnly: true }]);
    expect(db.calls[0].sql).toBe(WEBHOOK_SQL.visible);
    expect(db.calls[0].params).toEqual([null, null]);
    expect(json.object).toBe("list");
    expect(json.data).toHaveLength(2);
    expect(json.data[0]).toMatchObject({ object: "webhook", id: HOOK_W, workspaceId: W, failureCount: 0, canManage: true, createdAt: "2026-10-05T18:04:26.295Z" });
    expect(JSON.stringify(json)).not.toContain("whsec_");
    expect(JSON.stringify(json)).not.toContain("workspace_id");
  });
  it("?workspace=personal / <id> pick one scope", async () => {
    let r = await call(personalRead, "GET", "/webhooks?workspace=personal");
    expect(r.db.calls[0]).toMatchObject({ sql: WEBHOOK_SQL.list, params: [null] });
    r = await call(personalRead, "GET", `/webhooks?workspace=${W.toUpperCase()}`);
    expect(r.db.calls[0]).toMatchObject({ sql: WEBHOOK_SQL.list, params: [W] });
    r = await call(personalRead, "GET", "/webhooks?workspace=nope");
    expect(r.res!.status).toBe(400);
    expect(r.json.error.code).toBe("bad_request");
    expect(r.db.calls).toHaveLength(0);
  });
  it("a workspace key lists only its workspace; personal or another workspace is refused before any query", async () => {
    let r = await call(teamWrite, "GET", "/webhooks");
    expect(r.db.scopes[0]).toEqual({ userId: ME, workspaceId: W, readOnly: true });
    expect(r.db.calls[0]).toMatchObject({ sql: WEBHOOK_SQL.list, params: [W] });
    expect(r.json.data.map((h: { id: string }) => h.id)).toEqual([HOOK_W]);
    for (const q of ["?workspace=personal", `?workspace=${X}`]) {
      r = await call(teamWrite, "GET", `/webhooks${q}`);
      expect(r.res!.status, q).toBe(403);
      expect(r.json.error.code).toBe("forbidden");
      expect(r.db.calls).toHaveLength(0);
    }
  });
  it("GET /webhooks/:id finds within the key's reach only", async () => {
    let r = await call(personalRead, "GET", `/webhooks/${HOOK_P}`);
    expect(r.res!.status).toBe(200);
    expect(r.json.id).toBe(HOOK_P);
    r = await call(teamWrite, "GET", `/webhooks/${HOOK_P}`); // a personal endpoint, a workspace key
    expect(r.res!.status).toBe(404);
    expect(r.db.calls[0].params).toEqual([W, HOOK_P]);
    r = await call(personalRead, "GET", "/webhooks/not-a-uuid");
    expect(r.res!.status).toBe(404);
    expect(r.db.calls).toHaveLength(0);
  });
});

describe("adding", () => {
  const good = { url: "https://hooks.zapier.com/hooks/catch/1/abc/", events: ["task.created", "task.completed", "task.created"] };
  it("returns 201 with the secret once; events de-duplicated and sorted; personal by default for a personal key", async () => {
    const { res, json, db } = await call(personalWrite, "POST", "/webhooks", { ...good, description: "  Ops sheet  " });
    expect(res!.status).toBe(201);
    expect(json.secret).toBe(SECRET);
    expect(json.object).toBe("webhook");
    expect(db.scopes[0]).toEqual({ userId: ME, workspaceId: null, readOnly: false });
    expect(db.calls[0].sql).toBe(WEBHOOK_SQL.create);
    expect(db.calls[0].params).toEqual([null, good.url, JSON.stringify(["task.completed", "task.created"]), "Ops sheet"]);
  });
  it("a personal key may add a team endpoint (the database checks it may write there)", async () => {
    const { res, db } = await call(personalWrite, "POST", "/webhooks", { ...good, workspaceId: W });
    expect(res!.status).toBe(201);
    expect(db.calls[0].params[0]).toBe(W);
  });
  it("a workspace key adds to its own workspace only", async () => {
    let r = await call(teamWrite, "POST", "/webhooks", good);
    expect(r.res!.status).toBe(201);
    expect(r.db.calls[0].params[0]).toBe(W);
    for (const workspaceId of [null, X]) {
      r = await call(teamWrite, "POST", "/webhooks", { ...good, workspaceId });
      expect(r.res!.status, String(workspaceId)).toBe(403);
      expect(r.db.calls).toHaveLength(0);
    }
  });
  it("a read-only key can't add one", async () => {
    const { res, json, db } = await call(personalRead, "POST", "/webhooks", good);
    expect(res!.status).toBe(403);
    expect(json.error.message).toMatch(/read-only/);
    expect(db.calls).toHaveLength(0);
  });
  it("checks every field and says which", async () => {
    const bad = [
      [{ ...good, url: "http://hooks.example.com/x" }, "url"],
      [{ ...good, url: "https://10.0.0.1/x" }, "url"],
      [{ ...good, url: "https://169.254.169.254/latest/meta-data" }, "url"],
      [{ ...good, url: "https://metadata.google.internal/" }, "url"],
      [{ ...good, url: 42 }, "url"],
      [{ events: good.events }, "url"],
      [{ ...good, events: [] }, "events"],
      [{ ...good, events: ["ping"] }, "events"],
      [{ ...good, events: "task.created" }, "events"],
      [{ ...good, description: "x".repeat(201) }, "description"],
      [{ ...good, workspaceId: "acme" }, "workspaceId"],
      [{ ...good, secret: "whsec_mine" }, "secret"],
    ] as const;
    for (const [body, field] of bad) {
      const { res, json, db } = await call(personalWrite, "POST", "/webhooks", body);
      expect(res!.status, JSON.stringify(body)).toBe(422);
      expect(json.error.code).toBe("validation_failed");
      expect(json.error.details.fields).toHaveProperty(field);
      expect(db.calls).toHaveLength(0);
    }
  });
  it("body problems: not JSON, not an object, wrong type, too big — or a body the api function already parsed", async () => {
    let r = await call(personalWrite, "POST", "/webhooks", undefined, fakeDb(), { raw: "{nope" });
    expect([r.res!.status, r.json.error.code]).toEqual([400, "invalid_body"]);
    r = await call(personalWrite, "POST", "/webhooks", undefined, fakeDb(), { raw: "[1,2]" });
    expect([r.res!.status, r.json.error.code]).toEqual([400, "invalid_body"]);
    r = await call(personalWrite, "POST", "/webhooks", good, fakeDb(), { contentType: "text/plain" });
    expect([r.res!.status, r.json.error.code]).toEqual([415, "unsupported_media_type"]);
    r = await call(personalWrite, "POST", "/webhooks", { ...good, description: "x".repeat(70_000) });
    expect([r.res!.status, r.json.error.code]).toEqual([413, "payload_too_large"]);
    r = await call(personalWrite, "POST", "/webhooks", good, fakeDb(), { preParsed: true, contentType: "text/plain" });
    expect(r.res!.status).toBe(201);
  });
});

describe("changing one endpoint", () => {
  it("PATCH: only what's sent; description null clears ('' to the database); the endpoint must be reachable and manageable", async () => {
    let r = await call(personalWrite, "PATCH", `/webhooks/${HOOK_W}`, { active: false, description: null });
    expect(r.res!.status).toBe(200);
    expect(r.db.calls.map((c) => c.sql)).toEqual([WEBHOOK_SQL.visible, WEBHOOK_SQL.update]);
    expect(r.db.calls[1].params).toEqual([HOOK_W, null, null, false, ""]);
    expect(r.json).toMatchObject({ object: "webhook", id: HOOK_W, active: false });

    r = await call(personalWrite, "PATCH", `/webhooks/${HOOK_W}`, { events: ["comment.created"], url: " https://new.example.com/h " });
    expect(r.db.calls[1].params).toEqual([HOOK_W, "https://new.example.com/h", '["comment.created"]', null, null]);

    r = await call(personalWrite, "PATCH", `/webhooks/${HOOK_W}`, {});
    expect(r.res!.status).toBe(422);
    r = await call(personalWrite, "PATCH", `/webhooks/${HOOK_W}`, { active: "yes" });
    expect(r.json.error.details.fields).toHaveProperty("active");

    const theirs = fakeDb({ hooks: [hookJson(HOOK_W, W, { can_manage: false })] });
    r = await call(personalWrite, "PATCH", `/webhooks/${HOOK_W}`, { active: false }, theirs);
    expect(r.res!.status).toBe(403);
    expect(r.db.calls.map((c) => c.sql)).toEqual([WEBHOOK_SQL.visible]);
  });
  it("a workspace key can't touch a personal endpoint (or one in another workspace): 404 before any change", async () => {
    for (const [method, path, body] of [
      ["PATCH", `/webhooks/${HOOK_P}`, { active: false }], ["DELETE", `/webhooks/${HOOK_P}`, undefined],
      ["POST", `/webhooks/${HOOK_P}/rotate-secret`, undefined], ["POST", `/webhooks/${HOOK_P}/test`, undefined],
      ["GET", `/webhooks/${HOOK_P}/deliveries`, undefined], ["POST", `/webhooks/${HOOK_P}/deliveries/${DEL}/redeliver`, undefined],
    ] as const) {
      const r = await call(teamWrite, method, path, body);
      expect(r.res!.status, `${method} ${path}`).toBe(404);
      expect(r.db.calls.map((c) => c.sql), path).toEqual([WEBHOOK_SQL.visible]);
      expect(r.db.calls[0].params[0]).toBe(W);
    }
  });
  it("a read key can't delete, rotate, test or redeliver (and never reaches the database)", async () => {
    for (const [method, path] of [["DELETE", `/webhooks/${HOOK_W}`], ["POST", `/webhooks/${HOOK_W}/rotate-secret`],
      ["POST", `/webhooks/${HOOK_W}/test`], ["POST", `/webhooks/${HOOK_W}/deliveries/${DEL}/redeliver`], ["PATCH", `/webhooks/${HOOK_W}`]] as const) {
      const r = await call(personalRead, method, path, method === "PATCH" ? { active: true } : undefined);
      expect(r.res!.status, path).toBe(403);
      expect(r.db.scopes).toHaveLength(0);
    }
  });
  it("DELETE 204, rotate gives the new secret, test is queued (202)", async () => {
    let r = await call(teamWrite, "DELETE", `/webhooks/${HOOK_W}`);
    expect(r.res!.status).toBe(204);
    expect(r.db.calls[1]).toMatchObject({ sql: WEBHOOK_SQL.remove, params: [HOOK_W] });
    r = await call(teamWrite, "POST", `/webhooks/${HOOK_W}/rotate-secret`);
    expect(r.json).toEqual({ object: "webhook_secret", webhookId: HOOK_W, secret: SECRET });
    r = await call(teamWrite, "POST", `/webhooks/${HOOK_W}/test`);
    expect(r.res!.status).toBe(202);
    expect(r.json).toEqual({ object: "webhook_test", webhookId: HOOK_W, eventId: "evt_4813", type: "ping", queued: true });
  });
  it("deliveries: limit checked, camelCase, event id; redelivery only for one of the endpoint's own", async () => {
    let r = await call(personalRead, "GET", `/webhooks/${HOOK_W}/deliveries?limit=10`);
    expect(r.db.calls[1]).toMatchObject({ sql: WEBHOOK_SQL.deliveries, params: [HOOK_W, 10] });
    expect(r.json.data[0]).toEqual({
      object: "webhook_delivery", id: DEL, webhookId: HOOK_W, eventId: "evt_4", event: "task.created", state: "failed", attempt: 6,
      statusCode: 0, error: "timeout", durationMs: 10000, nextAttemptAt: null, deliveredAt: null,
      createdAt: "2026-10-05T18:04:26.351Z", updatedAt: "2026-10-05T18:04:26.368Z",
    });
    for (const bad of ["0", "101", "x", "-1", "1.5"]) {
      r = await call(personalRead, "GET", `/webhooks/${HOOK_W}/deliveries?limit=${bad}`);
      expect(r.res!.status, bad).toBe(400);
    }
    r = await call(personalWrite, "POST", `/webhooks/${HOOK_W}/deliveries/${DEL}/redeliver`);
    expect(r.res!.status).toBe(202);
    expect(r.db.calls.map((c) => c.sql)).toEqual([WEBHOOK_SQL.visible, WEBHOOK_SQL.deliveries, WEBHOOK_SQL.redeliver]);
    r = await call(personalWrite, "POST", `/webhooks/${HOOK_W}/deliveries/eeeeeeee-0000-4000-8000-00000000000e/redeliver`);
    expect(r.res!.status).toBe(404);
    expect(r.db.calls.map((c) => c.sql)).not.toContain(WEBHOOK_SQL.redeliver);
    // a test ping isn't sent again (Send test makes a new one, 5 a minute)
    r = await call(personalWrite, "POST", `/webhooks/${HOOK_W}/deliveries/${PING}/redeliver`);
    expect(r.res!.status).toBe(409);
    expect(r.json.error.message).toMatch(/test event isn't sent again/);
    expect(r.db.calls.map((c) => c.sql)).not.toContain(WEBHOOK_SQL.redeliver);
  });
  it("someone who can't manage an endpoint gets its URL masked, even if a full one slipped through", async () => {
    const db = fakeDb({ hooks: [hookJson(HOOK_W, W, { can_manage: false, url: "https://hooks.zapier.com/hooks/catch/1234567/bq9x2kd/" }),
      hookJson(HOOK_P, null, { url: "https://hooks.zapier.com/hooks/catch/1234567/pr7k3nx/" })] });
    let r = await call(personalRead, "GET", "/webhooks", undefined, db);
    const byId = Object.fromEntries(r.json.data.map((w: { id: string; url: string }) => [w.id, w.url]));
    expect(byId[HOOK_W]).toBe("https://hooks.zapier.com/…x2kd");
    expect(byId[HOOK_P]).toBe("https://hooks.zapier.com/hooks/catch/1234567/pr7k3nx/");
    r = await call(personalRead, "GET", `/webhooks/${HOOK_W}`, undefined, db);
    expect(r.json).toMatchObject({ url: "https://hooks.zapier.com/…x2kd", canManage: false });
    expect(JSON.stringify(r.json)).not.toContain("1234567");
  });
});

describe("the database's refusals become JSON errors", () => {
  const cases: [keyof typeof WEBHOOK_SQL, string, number, string][] = [
    ["create", "not allowed", 403, "forbidden"],
    ["create", "too many webhooks", 409, "conflict"],
    ["create", "invalid url", 422, "validation_failed"],
    ["create", "invalid events", 422, "validation_failed"],
    ["test", "too many tests", 429, "rate_limited"],
    ["remove", "webhook not found", 404, "not_found"],
    ["redeliver", "already delivered", 409, "conflict"],
    ["redeliver", "test events can't be sent again", 409, "conflict"],
    ["redeliver", "too many redeliveries (retry after 37 s)", 429, "rate_limited"],
    ["create", "duplicate key value violates unique constraint \"webhooks_pkey\" DETAIL: Key (secret)=(whsec_x)", 500, "internal"],
  ];
  it.each(cases)("%s: %s → %d", async (k, message, status, code) => {
    const db = fakeDb({ fail: { [k]: Object.assign(new Error(message), { code: "P0001" }) } });
    const [method, path] = k === "create" ? ["POST", "/webhooks"] : k === "test" ? ["POST", `/webhooks/${HOOK_W}/test`]
      : k === "remove" ? ["DELETE", `/webhooks/${HOOK_W}`] : ["POST", `/webhooks/${HOOK_W}/deliveries/${DEL}/redeliver`];
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      const r = await call(personalWrite, method, path, k === "create" ? { url: "https://a.example.com/h", events: ["task.created"] } : undefined, db);
      expect(r.res!.status).toBe(status);
      expect(r.json.error.code).toBe(code);
      expect(r.json.error.requestId).toBe("req_0123456789abcdef");
      expect(JSON.stringify(r.json)).not.toContain("whsec_x");
      if (status === 429) expect(r.res!.headers.get("retry-after")).toBe(/retry after (\d+)/.exec(message)?.[1] ?? "60");
    } finally { console.error = orig; }
  });
  it("a read-only transaction refusing a write is a 403", async () => {
    const db = fakeDb({ fail: { list: Object.assign(new Error("cannot execute UPDATE in a read-only transaction"), { code: "25006" }) } });
    const r = await call(personalRead, "GET", "/webhooks?workspace=personal", undefined, db);
    expect(r.res!.status).toBe(403);
  });
});

describe("the OpenAPI description matches the routes", () => {
  it("every route is documented, with the right access", () => {
    for (const r of webhookRoutes) {
      const p = r.path.replace(/:([a-zA-Z]+)/g, "{$1}");
      const op = webhookOpenApiPaths[p]?.[r.method.toLowerCase() as "get"];
      expect(op, `${r.method} ${p}`).toBeTruthy();
      expect(op!["x-kanbo-access"]).toBe(r.method === "GET" ? "read" : "write");
      expect(op!.tags).toEqual(["Webhooks"]);
      for (const name of (p.match(/\{(\w+)\}/g) ?? []).map((x) => x.slice(1, -1))) {
        expect(op!.parameters?.some((q) => q.in === "path" && q.name === name), `${p} ${name}`).toBe(true);
      }
    }
    expect(Object.values(webhookOpenApiPaths).flatMap((o) => Object.keys(o))).toHaveLength(webhookRoutes.length);
    const doc = buildOpenApi("https://x.supabase.co/functions/v1/api/v1");
    expect(doc.paths["/webhooks"]?.post?.operationId).toBe("createWebhook");
    // a2's webhook operations are written out inline; a1's core paths use
    // $refs into components.schemas, and every one of those must resolve.
    expect(JSON.stringify(webhookOpenApiPaths)).not.toContain("$ref");
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]);
    expect(JSON.stringify(doc).match(/"\$ref"/g)?.length ?? 0).toBe(refs.length);
    for (const name of refs) expect(doc.components?.schemas?.[name], `$ref ${name}`).toBeTruthy();
  });
  it("no two routes collide", () => {
    for (const r of webhookRoutes) {
      const concrete = r.path.replace(/:[a-zA-Z]+/g, HOOK_W);
      const m = matchRoute(webhookRoutes, r.method, concrete);
      expect(m.kind === "match" && m.route).toBe(r);
    }
  });
});

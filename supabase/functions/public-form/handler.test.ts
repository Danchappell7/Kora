// @vitest-environment node
// The public-form function, end to end against an in-memory database
// (a stand-in for the supabase-js query builder, service role: no RLS)
// and the real rate limiter from _shared/limits.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { hashKey, hit, KEY_PREFIX } from "../_shared/limits.ts";
import { FIELD_MESSAGES } from "../_shared/publicForm.ts";
import { handlePublicForm, PUBLIC_FORM_LIMITS, type PublicFormDeps, type PublicFormRequest } from "./handler.ts";

type Row = Record<string, unknown>;

class FakeDb {
  tables = new Map<string, Row[]>();
  /** table → error every query on it returns */
  broken = new Map<string, { code: string; message: string }>();
  log: string[] = [];
  seq = 0;
  rows(t: string) {
    if (!this.tables.has(t)) this.tables.set(t, []);
    return this.tables.get(t)!;
  }
  from(t: string) { return new Query(this, t); }
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private filters: ((r: Row) => boolean)[] = [];
  private payload: Row = {};
  private conflict: string[] = [];
  private mode: "many" | "maybe" | "one" = "many";
  constructor(private db: FakeDb, private table: string) {}
  select() { return this; }
  insert(row: Row) { this.op = "insert"; this.payload = row; return this; }
  upsert(row: Row, opts: { onConflict: string }) { this.op = "upsert"; this.payload = row; this.conflict = opts.onConflict.split(","); return this; }
  update(p: Row) { this.op = "update"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  lt(c: string, v: string) { this.filters.push((r) => String(r[c]) < v); return this; }
  like() { return this; }
  limit() { return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  single() { this.mode = "one"; return this; }
  then<A, B>(ok?: ((v: { data: unknown; error: unknown }) => A) | null, bad?: ((e: unknown) => B) | null) {
    return Promise.resolve().then(() => this.exec()).then(ok, bad);
  }
  private exec(): { data: unknown; error: unknown } {
    this.db.log.push(`${this.op} ${this.table}`);
    const broken = this.db.broken.get(this.table);
    if (broken) return { data: null, error: broken };
    const rows = this.db.rows(this.table);
    const match = (r: Row) => this.filters.every((f) => f(r));
    if (this.op === "insert") {
      const row = { id: `00000000-0000-4000-8000-${String(++this.db.seq).padStart(12, "0")}`, ...this.payload };
      if (this.table === "tasks") row.id = `7f3a9c${String(this.db.seq).padStart(2, "0")}-0000-4000-8000-000000000000`;
      rows.push(row);
      return { data: this.mode === "many" ? [row] : row, error: null };
    }
    if (this.op === "upsert") {
      const clash = rows.find((r) => this.conflict.every((c) => r[c] === this.payload[c]));
      if (clash) return { data: [], error: null };
      const copy = { ...this.payload };
      rows.push(copy);
      return { data: [copy], error: null };
    }
    if (this.op === "update") {
      const hits = rows.filter(match);
      for (const r of hits) Object.assign(r, this.payload);
      return { data: hits.map((r) => ({ ...r })), error: null };
    }
    if (this.op === "delete") {
      this.db.tables.set(this.table, rows.filter((r) => !match(r)));
      return { data: null, error: null };
    }
    const found = rows.filter(match).map((r) => ({ ...r }));
    if (this.mode === "maybe") return { data: found[0] ?? null, error: null };
    if (this.mode === "one") return found.length === 1 ? { data: found[0], error: null } : { data: null, error: { code: "PGRST116", message: "not one row" } };
    return { data: found, error: null };
  }
}

const TOKEN = "0123456789abcdef0123456789abcdef";
const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // team owner
const CREATOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // made the form
const LEAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // owns the project
const PROJECT = "22222222-2222-4222-8222-222222222222";
const FORM = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-10-05T09:00:00.000Z");

let db: FakeDb;
let clock = T0;
let ids = 0;
const deps = (): PublicFormDeps => ({
  db,
  hit: (key, opts) => hit(db, key, { ...opts, now: clock }),
  hash: hashKey,
  randomId: () => `deadbeef-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  now: () => clock,
});
const get = (token: string | null = TOKEN, ip = "203.0.113.7") => handlePublicForm({ method: "GET", token, ip }, deps());
const post = (body: unknown, opts: Partial<PublicFormRequest> = {}) =>
  handlePublicForm({ method: "POST", token: TOKEN, ip: "203.0.113.7", body: typeof body === "string" ? body : JSON.stringify(body), ...opts }, deps());
const good = { title: "New hero banner", name: "Sam Jones", email: "sam@example.com", description: "Bigger and bolder.", priority: "high", dueDate: "2026-10-20" };

beforeEach(() => {
  db = new FakeDb();
  clock = T0;
  db.rows("workspaces").push({ id: WS, name: "Foundrise", logo_url: "https://abc.supabase.co/storage/v1/object/public/avatars/x/logo.png", owner_id: OWNER });
  db.rows("workspace_members").push(
    { workspace_id: WS, user_id: OWNER, role: "owner", status: "active" },
    { workspace_id: WS, user_id: CREATOR, role: "member", status: "active" },
    { workspace_id: WS, user_id: LEAD, role: "admin", status: "active" },
  );
  db.rows("profiles").push({ id: OWNER, suspended: false, approved: true, notify_prefs: {} }, { id: CREATOR, suspended: false, approved: true, notify_prefs: {} }, { id: LEAD, suspended: false, approved: true, notify_prefs: {} });
  db.rows("projects").push({ id: PROJECT, user_id: CREATOR, name: "Website refresh", emoji: "🎨", color: "oklch(0.62 0.16 293)", owner_id: LEAD, workspace_id: WS, archived_at: null });
  db.rows("forms").push({ id: FORM, user_id: CREATOR, workspace_id: WS, project_id: PROJECT, name: "Design requests", description: "Tell us what you need.", fields: ["description", "priority", "dueDate", "assignee"], public_token: TOKEN, public_enabled: true });
});

const form = () => db.rows("forms")[0];
const tasks = () => db.rows("tasks");
const activity = () => db.rows("activity");

describe("GET: the form's public face", () => {
  it("returns only what the page shows", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      form: {
        name: "Design requests", intro: "Tell us what you need.",
        project: { name: "Website refresh", emoji: "🎨", color: "oklch(0.62 0.16 293)" },
        workspace: { name: "Foundrise", logoUrl: "https://abc.supabase.co/storage/v1/object/public/avatars/x/logo.png" },
        fields: ["description", "priority", "dueDate"],
      },
    });
    const wire = JSON.stringify(r.body);
    for (const secret of [TOKEN, WS, OWNER, CREATOR, LEAD, PROJECT, FORM, "assignee"]) expect(wire).not.toContain(secret);
  });
  it("a token of the wrong shape is not found, without a database query", async () => {
    for (const t of [null, "", "demo", "short", "../../etc/passwd", "a".repeat(200)]) {
      const r = await get(t);
      expect(r.status).toBe(404);
      expect(r.body.reason).toBe("not_found");
    }
    expect(db.log).toEqual([]);
  });
  it("an unknown token is not found; a switched-off link is gone", async () => {
    expect((await get("f".repeat(32))).status).toBe(404);
    form().public_enabled = false;
    const r = await get();
    expect(r.status).toBe(410);
    expect(r.body).toMatchObject({ reason: "disabled" });
  });
  it("an archived, deleted or moved project takes no requests", async () => {
    db.rows("projects")[0].archived_at = "2026-10-01T00:00:00Z";
    expect((await get()).body.reason).toBe("disabled");
    db.rows("projects")[0].archived_at = null;
    db.rows("projects")[0].workspace_id = "99999999-9999-4999-8999-999999999999";
    expect((await get()).body.reason).toBe("disabled");
    db.tables.set("projects", []);
    expect((await get()).body.reason).toBe("disabled");
  });
  it("a suspended team owner's forms take no requests", async () => {
    db.rows("profiles")[0].suspended = true;
    expect((await get()).status).toBe(410);
  });
  it("a personal form works, and stops when its creator is suspended", async () => {
    Object.assign(form(), { workspace_id: null, project_id: "p-personal" });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.form).toMatchObject({ project: { name: "Personal", emoji: "📥" }, workspace: null });
    db.rows("profiles")[1].approved = false;
    expect((await get()).status).toBe(410);
  });
  it("before 0043 (no public_token column) it says it's unavailable", async () => {
    db.broken.set("forms", { code: "42703", message: "column forms.public_token does not exist" });
    const r = await get();
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe("unavailable");
  });
  it("limits reads per IP", async () => {
    for (let i = 0; i < PUBLIC_FORM_LIMITS.getPerIp.max; i++) expect((await get()).status).toBe(200);
    const r = await get();
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ reason: "rate_limited" });
    expect(Number(r.headers?.["Retry-After"])).toBeGreaterThan(0);
    expect((await get(TOKEN, "198.51.100.1")).status).toBe(200);
    expect(db.rows("rate_limits").every((x) => !String(x.key).includes("203.0.113.7"))).toBe(true);
  });
  it("answers a ping without a token, and refuses other methods", async () => {
    expect(await handlePublicForm({ method: "GET", token: null, ip: "", ping: true }, deps())).toEqual({ status: 200, body: { ok: true } });
    expect((await handlePublicForm({ method: "PUT", token: TOKEN, ip: "" }, deps())).status).toBe(405);
  });
});

describe("POST: filing a request", () => {
  it("files one task for the project's owner, with an Inbox item, and returns a reference", async () => {
    const r = await post(good);
    expect(r).toEqual({ status: 200, body: { ok: true, reference: "KB-7F3A9C" } });
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0]).toMatchObject({
      user_id: CREATOR, workspace_id: WS, project_id: PROJECT, title: "New hero banner", status: "todo", priority: "high",
      assignee_id: LEAD, due_date: "2026-10-20", plan_today: false, ai_score: 50, position: T0,
      description: "Request via Design requests (public link).\n\nFrom: Sam Jones <sam@example.com>\n\nBigger and bolder.",
    });
    expect(activity()).toEqual([expect.objectContaining({ user_id: LEAD, task_id: tasks()[0].id, task_title: "New hero banner", kind: "assigned", detail: "Request via Design requests (public link)" })]);
  });
  it("uses only the fields the form asks for; nothing else in the body is read", async () => {
    form().fields = ["description"];
    const r = await post({ ...good, status: "done", assignee_id: OWNER, user_id: OWNER, workspace_id: "x", project_id: "y", tags: ["vip"] });
    expect(r.status).toBe(200);
    expect(tasks()[0]).toMatchObject({ priority: "medium", due_date: null, status: "todo", assignee_id: LEAD, user_id: CREATOR, workspace_id: WS, project_id: PROJECT, tags: [] });
  });
  it("refuses a bad submission field by field, and stores nothing", async () => {
    const r = await post({ ...good, email: "sam@", title: " " });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ reason: "invalid", field: "title", error: FIELD_MESSAGES.titleMissing, fields: { title: FIELD_MESSAGES.titleMissing, email: FIELD_MESSAGES.emailInvalid } });
    expect(tasks()).toHaveLength(0);
  });
  it("refuses bodies it can't read", async () => {
    for (const body of ["not json", "[1,2]", "null", "\"text\""]) expect((await post(body)).body.reason).toBe("invalid");
    expect((await post(null as unknown as string, { body: null })).status).toBe(400);
    expect((await post("x".repeat(30_000))).status).toBe(400);
    expect(tasks()).toHaveLength(0);
  });
  it("the honeypot: looks like it worked, stores nothing", async () => {
    const r = await post({ ...good, website: "https://cheap-pills.example" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, reference: "KB-DEADBE" });
    expect(tasks()).toHaveLength(0);
    expect(activity()).toHaveLength(0);
    expect(db.log.filter((l) => !l.includes("rate_limits"))).toEqual([]);
  });
  it("a switched-off or unknown link files nothing", async () => {
    form().public_enabled = false;
    expect((await post(good)).status).toBe(410);
    expect((await post(good, { token: "e".repeat(32) })).status).toBe(404);
    expect(tasks()).toHaveLength(0);
  });
  it("limits sends per IP", async () => {
    for (let i = 0; i < PUBLIC_FORM_LIMITS.postPerIp.max; i++) expect((await post({ ...good, email: `p${i}@example.com` })).status).toBe(200);
    const r = await post({ ...good, email: "late@example.com" });
    expect(r.status).toBe(429);
    expect(r.body.retryAfter).toBeGreaterThan(0);
    expect(tasks()).toHaveLength(PUBLIC_FORM_LIMITS.postPerIp.max);
  });
  it("limits sends per email address (whatever the IP)", async () => {
    for (let i = 0; i < PUBLIC_FORM_LIMITS.postPerEmail.max; i++) expect((await post(good, { ip: `198.51.100.${i}` })).status).toBe(200);
    expect((await post({ ...good, email: "SAM@example.com" }, { ip: "198.51.100.99" })).status).toBe(429);
    expect(db.rows("rate_limits").some((x) => String(x.key).includes("sam@"))).toBe(false);
  });
  it("limits sends per form (whatever the IP and email)", async () => {
    for (let i = 0; i < PUBLIC_FORM_LIMITS.postPerForm.max; i++) {
      expect((await post({ ...good, email: `p${i}@example.com` }, { ip: `10.0.${Math.floor(i / 200)}.${i % 200}` })).status).toBe(200);
    }
    expect((await post({ ...good, email: "one-more@example.com" }, { ip: "10.9.9.9" })).status).toBe(429);
    expect(db.rows("rate_limits").some((x) => String(x.key).includes(TOKEN))).toBe(false);
    expect(db.rows("rate_limits").every((x) => String(x.key).startsWith(KEY_PREFIX + "pf:"))).toBe(true);
    clock += 3600_000;
    expect((await post({ ...good, email: "next-hour@example.com" }, { ip: "10.9.9.9" })).status).toBe(200);
  });
  it("without an IP it still applies the per-form and per-email limits", async () => {
    for (let i = 0; i < PUBLIC_FORM_LIMITS.postPerEmail.max; i++) expect((await post(good, { ip: "" })).status).toBe(200);
    expect((await post(good, { ip: "" })).status).toBe(429);
  });
});

describe("POST: who gets it", () => {
  it("the form's creator when the project's owner has left the team", async () => {
    db.tables.set("workspace_members", db.rows("workspace_members").filter((m) => m.user_id !== LEAD));
    await post(good);
    expect(tasks()[0].assignee_id).toBe(CREATOR);
    expect(activity()[0].user_id).toBe(CREATOR);
  });
  it("the form's creator when the project's owner is suspended, or only a guest", async () => {
    db.rows("profiles")[2].suspended = true;
    await post(good);
    expect(tasks()[0].assignee_id).toBe(CREATOR);
    db.rows("profiles")[2].suspended = false;
    db.rows("workspace_members")[2].role = "guest";
    await post({ ...good, email: "b@example.com" });
    expect(tasks()[1].assignee_id).toBe(CREATOR);
  });
  it("the team's owner when neither can take it", async () => {
    db.tables.set("workspace_members", db.rows("workspace_members").filter((m) => m.user_id === OWNER));
    await post(good);
    expect(tasks()[0].assignee_id).toBe(OWNER);
  });
  it("no Inbox item for someone who switched assignment notices off", async () => {
    db.rows("profiles")[2].notify_prefs = { assigned: false };
    expect((await post(good)).status).toBe(200);
    expect(tasks()).toHaveLength(1);
    expect(activity()).toHaveLength(0);
  });
  it("still files the task when the members lookup fails (assigns the project's owner)", async () => {
    db.broken.set("workspace_members", { code: "XX000", message: "boom" });
    expect((await post(good)).status).toBe(200);
    expect(tasks()[0].assignee_id).toBe(LEAD);
  });
  it("says so when the task can't be saved, and writes no Inbox item", async () => {
    db.broken.set("tasks", { code: "23514", message: "check constraint" });
    const r = await post(good);
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe("unavailable");
    expect(activity()).toHaveLength(0);
  });
  it("a personal form files into the creator's Personal project", async () => {
    Object.assign(form(), { workspace_id: null, project_id: "p-personal" });
    await post(good);
    expect(tasks()[0]).toMatchObject({ user_id: CREATOR, workspace_id: null, project_id: "p-personal", assignee_id: CREATOR });
  });
});

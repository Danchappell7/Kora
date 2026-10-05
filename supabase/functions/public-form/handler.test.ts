// @vitest-environment node
// The public-form function, end to end against an in-memory database
// (a stand-in for the supabase-js query builder, service role: no RLS)
// and the real rate limiter from _shared/limits.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { hashKey, hit, KEY_PREFIX, refund } from "../_shared/limits.ts";
import { FIELD_MESSAGES, identityColour, RATE_LIMIT_MESSAGES } from "../_shared/publicForm.ts";
import { handlePublicForm, planRules, PUBLIC_FORM_LIMITS, type PublicFormDeps, type PublicFormRequest } from "./handler.ts";

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
  private sortBy: { col: string; asc: boolean } | null = null;
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
  order(col: string, opts: { ascending?: boolean } = {}) { this.sortBy = { col, asc: opts.ascending !== false }; return this; }
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
      // like Postgres: an id given is kept, otherwise one is made up
      const row = { id: `00000000-0000-4000-8000-${String(++this.db.seq).padStart(12, "0")}`, ...this.payload };
      if (rows.some((r) => r.id === row.id)) return { data: null, error: { code: "23505", message: "duplicate key" } };
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
    if (this.sortBy) {
      const { col, asc } = this.sortBy;
      found.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
    }
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
  refund: (key) => refund(db, key),
  hash: hashKey,
  randomId: () => `7f3a9c01-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  now: () => clock,
});
const get = (token: string | null = TOKEN, ip = "203.0.113.7") => handlePublicForm({ method: "GET", token, ip }, deps());
const post = (body: unknown, opts: Partial<PublicFormRequest> = {}) =>
  handlePublicForm({ method: "POST", token: TOKEN, ip: "203.0.113.7", body: typeof body === "string" ? body : JSON.stringify(body), ...opts }, deps());
const good = { title: "New hero banner", name: "Sam Jones", email: "sam@example.com", description: "Bigger and bolder.", priority: "high", dueDate: "2026-10-20" };

beforeEach(() => {
  db = new FakeDb();
  clock = T0;
  ids = 0;
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
  it("a grey project wears the hue Kanbo gives it, without the page seeing its id", async () => {
    db.rows("projects").find((p) => p.id === PROJECT)!.color = "oklch(0.6 0 0)";
    const r = await get();
    expect((r.body.form as { project: { color: string } }).project.color).toBe(identityColour("oklch(0.6 0 0)", PROJECT));
    expect((r.body.form as { project: { color: string } }).project.color).not.toBe("oklch(0.6 0 0)");
    expect(JSON.stringify(r.body)).not.toContain(PROJECT);
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
      id: "7f3a9c01-0000-4000-8000-000000000001",
      user_id: CREATOR, workspace_id: WS, project_id: PROJECT, title: "New hero banner", status: "todo", priority: "high",
      assignee_id: LEAD, due_date: "2026-10-20", plan_today: false, ai_score: 50, position: T0,
      // the reference they were given is in the task, so the team can find it when they quote it
      description: "Request via Design requests (public link).\n\nFrom: Sam Jones <sam@example.com>\nReference: KB-7F3A9C\n\nBigger and bolder.",
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
    expect(r.body).toEqual({ ok: true, reference: "KB-7F3A9C" });
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
  it("limits one network on one form to a fifth of the form's hour", async () => {
    const cap = PUBLIC_FORM_LIMITS.postPerIpPerForm.max;
    expect(cap * 5).toBeLessThanOrEqual(PUBLIC_FORM_LIMITS.postPerForm.max);
    for (let i = 0; i < cap; i++) expect((await post({ ...good, email: `p${i}@example.com` })).status).toBe(200);
    const r = await post({ ...good, email: "late@example.com" });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ reason: "rate_limited", scope: "sender", error: RATE_LIMIT_MESSAGES.sender });
    expect(r.body.retryAfter).toBeGreaterThan(600);
    expect(tasks()).toHaveLength(cap);
    // another network has its own allowance, and the form still takes requests
    expect((await post({ ...good, email: "elsewhere@example.com" }, { ip: "198.51.100.20" })).status).toBe(200);
    // the same network on another form has its own hour
    db.rows("forms").push({ ...form(), id: "44444444-4444-4444-8444-444444444444", public_token: "abcdefabcdefabcdefabcdefabcdef12" });
    expect((await post({ ...good, email: "other-form@example.com" }, { token: "abcdefabcdefabcdefabcdefabcdef12" })).status).toBe(200);
    // and the hour passes
    clock += 3600_000;
    expect((await post({ ...good, email: "next-hour@example.com" })).status).toBe(200);
  });
  it("limits a burst from one network across every form", async () => {
    const forms = ["abcdefabcdefabcdefabcdefabcdef01", "abcdefabcdefabcdefabcdefabcdef02"];
    forms.forEach((tok, i) => db.rows("forms").push({ ...form(), id: `44444444-4444-4444-8444-00000000000${i}`, public_token: tok }));
    const per = PUBLIC_FORM_LIMITS.postPerIpPerForm.max;
    let sent = 0;
    for (const tok of [TOKEN, ...forms]) {
      for (let i = 0; i < per && sent < PUBLIC_FORM_LIMITS.postPerIp.max; i++, sent++) {
        expect((await post({ ...good, email: `b${sent}@example.com` }, { token: tok })).status).toBe(200);
      }
    }
    const r = await post({ ...good, email: "burst@example.com" }, { token: forms[1] });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ scope: "sender" });
    expect(Number(r.body.retryAfter)).toBeLessThanOrEqual(600);
  });
  it("lets a room on one network send: a QR code on a poster, everyone on the office Wi-Fi", async () => {
    expect(PUBLIC_FORM_LIMITS.postPerIp.max).toBeGreaterThanOrEqual(30);
    for (let i = 0; i < PUBLIC_FORM_LIMITS.postPerIpPerForm.max; i++) expect((await post({ ...good, email: `colleague${i}@example.com` })).status).toBe(200);
    expect(tasks()).toHaveLength(PUBLIC_FORM_LIMITS.postPerIpPerForm.max);
  });
  it("a sender the narrower limits refuse costs the form nothing", async () => {
    const formKey = `${KEY_PREFIX}pf:form:${await hashKey(TOKEN)}`;
    const used = () => Number(db.rows("rate_limits").find((x) => x.key === formKey)?.count ?? 0);
    // one email address from 20 networks: 3 filed, 17 refused (the reviewer's probe)
    let ok = 0;
    for (let i = 0; i < 20; i++) if ((await post(good, { ip: `10.0.0.${i}` })).status === 200) ok++;
    expect(ok).toBe(PUBLIC_FORM_LIMITS.postPerEmail.max);
    expect(used()).toBe(ok);
    // one network with fresh addresses: only what it files counts
    for (let i = 0; i < 30; i++) await post({ ...good, email: `n${i}@example.com` }, { ip: "192.0.2.50" });
    expect(used()).toBe(ok + PUBLIC_FORM_LIMITS.postPerIpPerForm.max);
    // bad submissions and the honeypot don't count either
    await post({ ...good, email: "nope" }, { ip: "192.0.2.51" });
    await post({ ...good, email: "bot@example.com", website: "x" }, { ip: "192.0.2.52" });
    expect(used()).toBe(tasks().length);
    // so one network alone can't lock real requesters out of the form
    expect((await post({ ...good, email: "real@example.com" }, { ip: "192.0.2.99" })).status).toBe(200);
  });
  it("a task that can't be saved gives the form its slot back", async () => {
    const formKey = `${KEY_PREFIX}pf:form:${await hashKey(TOKEN)}`;
    expect((await post(good)).status).toBe(200);
    db.broken.set("tasks", { code: "23514", message: "check constraint" });
    expect((await post({ ...good, email: "fails@example.com" })).status).toBe(503);
    expect(db.rows("rate_limits").find((x) => x.key === formKey)?.count).toBe(1);
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
    const r = await post({ ...good, email: "one-more@example.com" }, { ip: "10.9.9.9" });
    expect(r.status).toBe(429);
    // the visitor is told it's the form that's busy, not their network
    expect(r.body).toMatchObject({ reason: "rate_limited", scope: "form", error: RATE_LIMIT_MESSAGES.form });
    expect(db.rows("rate_limits").some((x) => String(x.key).includes(TOKEN))).toBe(false);
    expect(db.rows("rate_limits").every((x) => String(x.key).startsWith(KEY_PREFIX + "pf:"))).toBe(true);
    clock += 3600_000;
    expect((await post({ ...good, email: "next-hour@example.com" }, { ip: "10.9.9.9" })).status).toBe(200);
  });
  it("a regenerated link starts a fresh allowance", async () => {
    for (let i = 0; i < PUBLIC_FORM_LIMITS.postPerForm.max; i++) {
      await post({ ...good, email: `p${i}@example.com` }, { ip: `10.1.${Math.floor(i / 200)}.${i % 200}` });
    }
    expect((await post({ ...good, email: "x@example.com" }, { ip: "10.9.9.8" })).status).toBe(429);
    const fresh = "fedcba9876543210fedcba9876543210";
    form().public_token = fresh;
    expect((await post({ ...good, email: "y@example.com" }, { ip: "10.9.9.8", token: fresh })).status).toBe(200);
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
    // stored as text, as notif_on's ::boolean reads it
    db.rows("profiles")[2].notify_prefs = { assigned: "false" };
    await post({ ...good, email: "c@example.com" });
    expect(tasks()).toHaveLength(2);
    expect(activity()).toHaveLength(0);
    // anything else (or nothing) leaves it on
    db.rows("profiles")[2].notify_prefs = { mention: false };
    await post({ ...good, email: "d@example.com" });
    expect(activity()).toEqual([expect.objectContaining({ user_id: LEAD })]);
  });
  it("still files the task when the members lookup fails, for the team's owner (the one person surely in the team)", async () => {
    db.broken.set("workspace_members", { code: "XX000", message: "boom" });
    expect((await post(good)).status).toBe(200);
    expect(tasks()[0].assignee_id).toBe(OWNER);
    expect(activity()).toEqual([expect.objectContaining({ user_id: OWNER })]);
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

describe("a personal form only reaches its creator's own work", () => {
  const STRANGER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const THEIRS = "44444444-4444-4444-8444-444444444444";
  const MINE = "55555555-5555-4555-8555-555555555555";
  beforeEach(() => {
    db.rows("profiles").push({ id: STRANGER, suspended: false, approved: true, notify_prefs: {} });
    db.rows("projects").push(
      { id: THEIRS, user_id: STRANGER, name: "Stranger's secret project", emoji: "🔒", color: "oklch(0.6 0.1 20)", owner_id: STRANGER, workspace_id: null, archived_at: null },
      { id: MINE, user_id: CREATOR, name: "Side project", emoji: "🌱", color: "oklch(0.6 0.1 140)", owner_id: CREATOR, workspace_id: null, archived_at: null },
    );
  });

  it("pointed at someone else's personal project, it shows nothing about it", async () => {
    Object.assign(form(), { workspace_id: null, project_id: THEIRS, name: "Spoof" });
    const r = await get();
    expect(r.status).toBe(410);
    expect(r.body.reason).toBe("disabled");
    expect(JSON.stringify(r.body)).not.toMatch(/secret|🔒/);
    // the id's case doesn't get it past the check
    form().project_id = THEIRS.toUpperCase();
    expect((await get()).status).toBe(410);
  });

  it("pointed at someone else's personal project, it files nothing and tells nobody", async () => {
    Object.assign(form(), { workspace_id: null, project_id: THEIRS, name: "Spoof" });
    const r = await post({ ...good, title: "Your account is locked - click here" });
    expect(r.status).toBe(410);
    expect(tasks()).toHaveLength(0);
    expect(activity()).toHaveLength(0);
  });

  it("pointed at a team's project, it takes nothing", async () => {
    Object.assign(form(), { workspace_id: null, project_id: PROJECT });
    expect((await get()).status).toBe(410);
    expect((await post(good)).status).toBe(410);
    expect(tasks()).toHaveLength(0);
  });

  it("on the creator's own project, only the creator is assigned or told, whoever the row names as owner", async () => {
    Object.assign(form(), { workspace_id: null, project_id: MINE });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.form).toMatchObject({ project: { name: "Side project", emoji: "🌱" }, workspace: null });
    // projects.owner_id is only RLS-checked against the creator: it could name anyone
    db.rows("projects").find((p) => p.id === MINE)!.owner_id = STRANGER;
    expect((await post(good)).status).toBe(200);
    expect(tasks()[0]).toMatchObject({ user_id: CREATOR, workspace_id: null, project_id: MINE, assignee_id: CREATOR });
    expect(activity()).toEqual([expect.objectContaining({ user_id: CREATOR })]);
    expect(activity().some((a) => a.user_id === STRANGER)).toBe(false);
  });
});

describe("POST: the project's rules run, as for a form filled in inside Kanbo", () => {
  const SECTION = "66666666-6666-4666-8666-666666666666";
  const OTHER_SECTION = "77777777-7777-4777-8777-777777777777";
  const TEAM_TAG = "88888888-8888-4888-8888-888888888888";
  const MY_TAG = "99999999-9999-4999-8999-999999999999";
  const THEIR_TAG = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const GUEST = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  let n = 0;
  const rule = (actions: { type: string; value: string }[], extra: Record<string, unknown> = {}) => {
    n++;
    db.rows("automation_rules").push({
      id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`, user_id: CREATOR, workspace_id: WS, project_id: PROJECT,
      name: `Rule ${n}`, trigger: "task_created", actions, enabled: true, created_at: `2026-10-0${n}T00:00:00Z`, ...extra,
    });
  };
  beforeEach(() => {
    n = 0;
    db.rows("sections").push(
      { id: SECTION, user_id: LEAD, workspace_id: WS, project_id: PROJECT, name: "Intake" },
      { id: OTHER_SECTION, user_id: LEAD, workspace_id: WS, project_id: "some-other-project", name: "Elsewhere" },
    );
    db.rows("tags").push(
      { id: TEAM_TAG, user_id: OWNER, workspace_id: WS, label: "Triage" },
      { id: MY_TAG, user_id: CREATOR, workspace_id: null, label: "Mine" },
      { id: THEIR_TAG, user_id: OWNER, workspace_id: null, label: "Owner's private" },
    );
    db.rows("profiles").push({ id: GUEST, suspended: false, approved: true, notify_prefs: {} });
    db.rows("workspace_members").push({ workspace_id: WS, user_id: GUEST, role: "guest", status: "active" });
  });

  it("routes the request: assignee, section, tags and priority from the rules", async () => {
    rule([{ type: "set_assignee", value: CREATOR }, { type: "set_section", value: SECTION }, { type: "add_tag", value: TEAM_TAG }, { type: "set_priority", value: "urgent" }]);
    expect((await post(good)).status).toBe(200);
    expect(tasks()[0]).toMatchObject({ assignee_id: CREATOR, section_id: SECTION, tags: [TEAM_TAG], priority: "urgent" });
    // the Inbox item goes to whoever the rule handed it to
    expect(activity()).toEqual([expect.objectContaining({ user_id: CREATOR, kind: "assigned" })]);
  });

  it("applies rules oldest first, later ones winning, tags adding up", async () => {
    rule([{ type: "set_priority", value: "low" }, { type: "add_tag", value: "design" }]);
    rule([{ type: "set_priority", value: "high" }, { type: "add_tag", value: "design" }, { type: "add_tag", value: "bug" }]);
    // stored newest first: the order comes from created_at, not the table
    db.rows("automation_rules").reverse();
    await post({ ...good, priority: "low" });
    expect(tasks()[0]).toMatchObject({ priority: "high", tags: ["design", "bug"] });
  });

  it("an assignee the request couldn't go to anyway is skipped: guest, gone, suspended, stranger", async () => {
    const STRANGER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    db.rows("profiles").push({ id: STRANGER, suspended: false, approved: true, notify_prefs: {} });
    for (const who of [GUEST, STRANGER, "not-a-uuid"]) {
      db.tables.set("automation_rules", []);
      rule([{ type: "set_assignee", value: who }]);
      await post({ ...good, email: `${tasks().length}@example.com` });
      expect(tasks().at(-1)!.assignee_id).toBe(LEAD);
    }
    db.tables.set("automation_rules", []);
    rule([{ type: "set_assignee", value: OWNER }]);
    db.rows("profiles").find((p) => p.id === CREATOR)!.suspended = true;
    rule([{ type: "set_assignee", value: CREATOR }]);
    await post({ ...good, email: "susp@example.com" });
    // the later rule names a suspended member: the project's owner gets it instead
    expect(tasks().at(-1)!.assignee_id).toBe(LEAD);
    expect(activity().every((a) => a.user_id !== STRANGER && a.user_id !== GUEST && a.user_id !== CREATOR)).toBe(true);
  });

  it("a section outside the form's project, or not a section at all, is skipped", async () => {
    rule([{ type: "set_section", value: OTHER_SECTION }]);
    await post(good);
    expect(tasks()[0].section_id).toBeUndefined();
    db.tables.set("automation_rules", []);
    rule([{ type: "set_section", value: "s-intake" }]);
    await post({ ...good, email: "b@example.com" });
    expect(tasks()[1].section_id).toBeUndefined();
    expect(tasks().every((t) => t.status === "todo")).toBe(true);
  });

  it("tags: built in, the team's, the author's own, by id or (older rules) by name; nothing else", async () => {
    rule([
      { type: "add_tag", value: "Engineering" }, // a built-in tag's name
      { type: "add_tag", value: "triage" }, // the team's tag by name, any case
      { type: "add_tag", value: MY_TAG }, // the rule author's personal tag
      { type: "add_tag", value: THEIR_TAG }, // someone else's personal tag
      { type: "add_tag", value: "Owner's private" },
      { type: "add_tag", value: "No such tag" },
      { type: "add_tag", value: "constructor" },
      { type: "add_tag", value: "" },
    ]);
    await post(good);
    expect(tasks()[0].tags).toEqual(["eng", TEAM_TAG, MY_TAG]);
  });

  it("a personal tag only counts in its own author's rule", async () => {
    // the team owner's rule can't add the creator's personal tag (even when the
    // creator's own rule, also running, has their tags in reach), but can add their own
    rule([{ type: "add_tag", value: "ops" }]);
    rule([{ type: "add_tag", value: MY_TAG }, { type: "add_tag", value: "Mine" }], { user_id: OWNER });
    await post(good);
    expect(tasks()[0].tags).toEqual(["ops"]);
    db.tables.set("automation_rules", []);
    rule([{ type: "add_tag", value: THEIR_TAG }], { user_id: OWNER });
    await post({ ...good, email: "b@example.com" });
    expect(tasks()[1].tags).toEqual([THEIR_TAG]);
  });

  it("ignores rules that are off, for another moment, another project or another team", async () => {
    rule([{ type: "set_priority", value: "urgent" }], { enabled: false });
    rule([{ type: "set_priority", value: "urgent" }], { trigger: "task_completed" });
    rule([{ type: "set_priority", value: "urgent" }], { project_id: "33333333-0000-4000-8000-000000000000" });
    rule([{ type: "set_priority", value: "urgent" }], { workspace_id: "99999999-9999-4999-8999-999999999999" });
    rule([{ type: "set_priority", value: "urgent" }], { workspace_id: null });
    rule([{ type: "set_priority", value: "not-a-priority" }]);
    await post(good);
    expect(tasks()[0]).toMatchObject({ priority: "high", assignee_id: LEAD, tags: [] });
  });

  it("on a personal form, only its creator's own rules, and never another assignee", async () => {
    const STRANGER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    Object.assign(form(), { workspace_id: null, project_id: "p-personal" });
    db.rows("sections").push({ id: SECTION.replace("6666-4666", "6666-4667"), user_id: CREATOR, workspace_id: null, project_id: "p-personal", name: "Inbox" });
    rule([{ type: "set_assignee", value: OWNER }, { type: "add_tag", value: MY_TAG }, { type: "set_section", value: SECTION.replace("6666-4666", "6666-4667") }], { workspace_id: null, project_id: "p-personal" });
    // someone else's personal rule naming the same project id never counts
    rule([{ type: "set_priority", value: "urgent" }, { type: "add_tag", value: THEIR_TAG }], { user_id: STRANGER, workspace_id: null, project_id: "p-personal" });
    await post(good);
    expect(tasks()[0]).toMatchObject({ assignee_id: CREATOR, tags: [MY_TAG], priority: "high", section_id: SECTION.replace("6666-4666", "6666-4667") });
    expect(activity()).toEqual([expect.objectContaining({ user_id: CREATOR })]);
  });

  it("still files the request when the rules, sections or tags can't be read", async () => {
    rule([{ type: "set_section", value: SECTION }, { type: "add_tag", value: TEAM_TAG }, { type: "add_tag", value: "ops" }]);
    db.broken.set("sections", { code: "XX000", message: "boom" });
    db.broken.set("tags", { code: "XX000", message: "boom" });
    expect((await post(good)).status).toBe(200);
    expect(tasks()[0]).toMatchObject({ tags: ["ops"] });
    expect(tasks()[0].section_id).toBeUndefined();
    db.broken.set("automation_rules", { code: "42P01", message: "relation does not exist" });
    expect((await post({ ...good, email: "b@example.com" })).status).toBe(200);
    expect(tasks()[1]).toMatchObject({ assignee_id: LEAD, tags: [] });
  });

  it("planRules folds actions the way the app does, skipping anything malformed", () => {
    expect(planRules([
      { user_id: "u1", workspace_id: null, project_id: "p", trigger: null, actions: [{ type: "set_priority", value: "low" }, null, "x", { type: "add_tag" }, { type: "add_tag", value: 7 }] },
      { user_id: "u2", workspace_id: null, project_id: "p", actions: "not a list" },
      { user_id: "u3", workspace_id: null, project_id: "p", actions: [{ type: "add_tag", value: "bug" }, { type: "set_section", value: "s" }, { type: "explode", value: "x" }] },
    ])).toEqual({ priority: "low", sectionId: "s", tags: [{ value: "bug", author: "u3" }] });
  });
});

describe("POST: the form's allowance is only spent on a filed request", () => {
  it("gives the slot back when the database throws mid-way, and lets the error through", async () => {
    const formKey = `${KEY_PREFIX}pf:form:${await hashKey(TOKEN)}`;
    const real = db.from.bind(db);
    db.from = (t: string) => { if (t === "automation_rules") throw new Error("socket closed"); return real(t); };
    await expect(post(good)).rejects.toThrow("socket closed");
    expect(Number(db.rows("rate_limits").find((x) => x.key === formKey)?.count ?? 0)).toBe(0);
    expect(tasks()).toHaveLength(0);
  });
});

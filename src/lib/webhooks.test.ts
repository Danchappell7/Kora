/* lib/webhooks in demo mode (no Supabase): realistic endpoints, the secret
   shown once, tests, retries, switch-off and the error sentences. */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createWebhook, deleteWebhook, listWebhookDeliveries, listWebhooks, parseWebhook, redeliverWebhookDelivery, resetWebhookDemo, rotateWebhookSecret,
  sendTestWebhook, setWebhookDemoRoles, shortWebhookUrl, updateWebhook, WEBHOOK_COPY, webhookErrorText, webhookHealth,
} from "./webhooks";

const WS = "11111111-0000-4000-8000-000000000001";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => resetWebhookDemo({ delayMs: 0, arriveMs: 5 }));

describe("demo endpoints", () => {
  it("a team workspace has working, retrying and switched-off examples; Personal has one", async () => {
    const team = await listWebhooks(WS);
    expect(team.map(webhookHealth)).toEqual(["ok", "failing", "off"]);
    expect(team.every((h) => h.workspaceId === WS && h.url.startsWith("https://"))).toBe(true);
    expect(team[2].disabledReason).toMatch(/20 failed/);
    const mine = await listWebhooks(null);
    expect(mine).toHaveLength(1);
    expect(mine[0].workspaceId).toBeNull();
    expect(JSON.stringify([...team, ...mine])).not.toContain("whsec_");
    const deliveries = await listWebhookDeliveries(team[1].id);
    expect(deliveries.map((d) => d.state)).toEqual(expect.arrayContaining(["pending", "delivered", "failed"]));
    expect(deliveries[0].createdAt >= deliveries[deliveries.length - 1].createdAt).toBe(true);
  });

  it("adding one returns its secret once; the list never carries it", async () => {
    const w = await createWebhook({ workspaceId: WS, url: " https://hooks.zapier.com/hooks/catch/9/zz/ ", events: ["task.created", "task.created"], description: "  Zap  " });
    expect(w.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(w).toMatchObject({ url: "https://hooks.zapier.com/hooks/catch/9/zz/", events: ["task.created"], description: "Zap", active: true, canManage: true });
    const listed = (await listWebhooks(WS)).find((h) => h.id === w.id)!;
    expect(listed).not.toHaveProperty("secret");
    expect(await listWebhookDeliveries(w.id)).toEqual([]);
  });

  it("refuses what the database would refuse", async () => {
    for (const url of ["http://a.example.com/x", "https://10.0.0.1/x", "https://localhost/x", "nope"]) {
      await expect(createWebhook({ workspaceId: WS, url, events: ["task.created"] })).rejects.toThrow(/invalid url/);
    }
    await expect(createWebhook({ workspaceId: WS, url: "https://a.example.com/x", events: [] })).rejects.toThrow(/invalid events/);
    await expect(createWebhook({ workspaceId: WS, url: "https://a.example.com/x", events: ["task.created"], description: "x".repeat(201) })).rejects.toThrow(/invalid description/);
    for (let i = 0; i < 9; i++) await createWebhook({ workspaceId: null, url: `https://a.example.com/${i}`, events: ["task.created"] });
    await expect(createWebhook({ workspaceId: null, url: "https://a.example.com/11", events: ["task.created"] })).rejects.toThrow(/too many webhooks/);
  });

  it("switching off gives up on what's waiting; back on clears the failures", async () => {
    const [, failing] = await listWebhooks(WS);
    const off = await updateWebhook(failing.id, { active: false });
    expect(off).toMatchObject({ active: false, disabledReason: "Switched off by hand" });
    expect((await listWebhookDeliveries(failing.id)).some((d) => d.state === "pending")).toBe(false);
    const on = await updateWebhook(failing.id, { active: true, description: "" });
    expect(on).toMatchObject({ active: true, failureCount: 0, disabledReason: null, description: null });
    await expect(updateWebhook(failing.id, { events: [] })).rejects.toThrow(/invalid events/);
  });

  it("a test ping is queued, then arrives; five a minute at most", async () => {
    const w = await createWebhook({ workspaceId: WS, url: "https://a.example.com/x", events: ["task.created"] });
    await sendTestWebhook(w.id);
    let [ping] = await listWebhookDeliveries(w.id);
    expect(ping).toMatchObject({ event: "ping", state: "pending", attempt: 0 });
    await wait(20);
    [ping] = await listWebhookDeliveries(w.id);
    expect(ping).toMatchObject({ event: "ping", state: "delivered", statusCode: 200 });
    expect((await listWebhooks(WS)).find((h) => h.id === w.id)?.lastStatus).toBe(200);
    for (let i = 0; i < 4; i++) await sendTestWebhook(w.id);
    await expect(sendTestWebhook(w.id)).rejects.toThrow(/too many tests/);
  });

  it("redelivery: a failed one goes again; a delivered one can't", async () => {
    const [, failing] = await listWebhooks(WS);
    const ds = await listWebhookDeliveries(failing.id);
    const failed = ds.find((d) => d.state === "failed")!;
    const done = ds.find((d) => d.state === "delivered")!;
    await redeliverWebhookDelivery(failed.id);
    await wait(20);
    expect((await listWebhookDeliveries(failing.id)).find((d) => d.id === failed.id)?.state).toBe("delivered");
    await expect(redeliverWebhookDelivery(done.id)).rejects.toThrow(/already delivered/);
  });

  it("a test ping isn't sent again; ten sends-again a minute per endpoint at most", async () => {
    resetWebhookDemo({ delayMs: 0, arriveMs: 60_000 }); // nothing arrives during this test, so each one can be sent again
    const w = await createWebhook({ workspaceId: WS, url: "https://a.example.com/x", events: ["task.created"] });
    await sendTestWebhook(w.id);
    const [ping] = await listWebhookDeliveries(w.id);
    await expect(redeliverWebhookDelivery(ping.id)).rejects.toThrow(/test events can't be sent again/);
    const [, failing] = await listWebhooks(WS);
    const failed = (await listWebhookDeliveries(failing.id)).find((d) => d.state === "failed")!;
    for (let i = 0; i < 10; i++) await redeliverWebhookDelivery(failed.id);
    const e = await redeliverWebhookDelivery(failed.id).catch((x) => x);
    expect(String(e.message)).toMatch(/too many redeliveries/);
    expect(webhookErrorText(e)).toBe("That's 10 sent again in a minute for this endpoint. Try again shortly.");
  });

  it("a member sees teammates' endpoints masked and can't change them; their own stay whole", async () => {
    setWebhookDemoRoles([{ id: WS, role: "member" }]);
    const team = await listWebhooks(WS);
    const [priya, mine, ana] = team;
    expect(priya).toMatchObject({ url: "https://hooks.zapier.com/…x2kd", canManage: false, createdByName: "Priya Shah" });
    expect(ana).toMatchObject({ url: "https://hook.eu1.make.com/…hz3c", canManage: false });
    expect(mine).toMatchObject({ url: "https://api.northwind-studio.co.uk/kanbo/events?client=foundrise", canManage: true });
    expect(JSON.stringify(team)).not.toContain("bq9x2kd/");
    await expect(updateWebhook(priya.id, { active: false })).rejects.toThrow(/not found/);
    await expect(deleteWebhook(priya.id)).rejects.toThrow(/not found/);
    await expect(rotateWebhookSecret(priya.id)).rejects.toThrow(/not found/);
    await expect(sendTestWebhook(priya.id)).rejects.toThrow(/not found/);
    expect((await listWebhookDeliveries(priya.id)).length).toBeGreaterThan(0); // members still see how deliveries went
    setWebhookDemoRoles([{ id: WS, role: "admin" }]);
    expect((await listWebhooks(WS))[0]).toMatchObject({ url: "https://hooks.zapier.com/hooks/catch/1234567/bq9x2kd/", canManage: true });
  });

  it("rotating gives a new secret; deleting removes it", async () => {
    const w = await createWebhook({ workspaceId: null, url: "https://a.example.com/x", events: ["task.created"] });
    const s2 = await rotateWebhookSecret(w.id);
    expect(s2).toMatch(/^whsec_/);
    expect(s2).not.toBe(w.secret);
    await deleteWebhook(w.id);
    expect((await listWebhooks(null)).some((h) => h.id === w.id)).toBe(false);
    await expect(deleteWebhook(w.id)).rejects.toThrow(/not found/);
  });
});

describe("helpers", () => {
  it("error sentences", () => {
    expect(webhookErrorText(new Error("too many tests"))).toBe(WEBHOOK_COPY.too_many_tests);
    expect(webhookErrorText(new Error("not allowed"))).toMatch(/guests can't/);
    expect(webhookErrorText(new Error("invalid description"))).toMatch(/200 characters/);
    expect(webhookErrorText(new TypeError("Failed to fetch"))).toBe(WEBHOOK_COPY.network);
    expect(webhookErrorText({ code: "PGRST202", message: "Could not find the function public.list_webhooks" })).toBe(WEBHOOK_COPY.unavailable);
  });
  it("a webhook the reader can't manage is never shown with its full address", () => {
    const raw = { id: "c924fcff-0938-4900-a8e7-9cbbb564a762", workspace_id: WS, url: "https://hooks.zapier.com/hooks/catch/1234567/bq9x2kd/",
      events: ["task.created"], created_by: "00000000-0000-4000-8000-0000000a11ce", can_manage: false };
    expect(parseWebhook(raw)?.url).toBe("https://hooks.zapier.com/…x2kd");
    expect(parseWebhook({ ...raw, can_manage: true })?.url).toBe(raw.url);
    expect(parseWebhook({ ...raw, url: "https://hooks.zapier.com/…x2kd" })?.url).toBe("https://hooks.zapier.com/…x2kd");
    expect(webhookErrorText(new Error("test events can't be sent again"))).toMatch(/Send test/);
  });
  it("short URLs keep the host whole", () => {
    expect(shortWebhookUrl("https://hooks.zapier.com/…x2kd")).toBe("hooks.zapier.com/…x2kd");
    expect(shortWebhookUrl("https://hooks.zapier.com/hooks/catch/1234567/bq9x2kd/")).toBe("hooks.zapier.com/hooks/catch/1234567/bq9x2kd/");
    const long = shortWebhookUrl("https://api.northwind-studio.co.uk/kanbo/events/with/a/very/long/path/that/goes/on?client=foundrise", 52);
    expect(long.startsWith("api.northwind-studio.co.uk/")).toBe(true);
    expect(long).toContain("…");
    expect(long.length).toBeLessThanOrEqual(53);
  });
});

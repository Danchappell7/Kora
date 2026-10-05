/* lib/webhooks in demo mode (no Supabase): realistic endpoints, the secret
   shown once, tests, retries, switch-off and the error sentences. */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createWebhook, deleteWebhook, listWebhookDeliveries, listWebhooks, redeliverWebhookDelivery, resetWebhookDemo, rotateWebhookSecret,
  sendTestWebhook, shortWebhookUrl, updateWebhook, WEBHOOK_COPY, webhookErrorText, webhookHealth,
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
  it("short URLs keep the host whole", () => {
    expect(shortWebhookUrl("https://hooks.zapier.com/hooks/catch/1234567/bq9x2kd/")).toBe("hooks.zapier.com/hooks/catch/1234567/bq9x2kd/");
    const long = shortWebhookUrl("https://api.northwind-studio.co.uk/kanbo/events/with/a/very/long/path/that/goes/on?client=foundrise", 52);
    expect(long.startsWith("api.northwind-studio.co.uk/")).toBe(true);
    expect(long).toContain("…");
    expect(long.length).toBeLessThanOrEqual(53);
  });
});

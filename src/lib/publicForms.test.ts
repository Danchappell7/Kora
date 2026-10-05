/* lib/publicForms in demo mode (no Supabase, as every test runs) plus the
   page's calls to the public-form function through a stand-in fetch. The
   signed-in paths (switching a link, regenerating it) are in
   publicForms.supabase.test.ts, with a mocked client. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPublicTheme, DEMO_PUBLIC_TOKEN, demoPublicForm, FAILURE_MESSAGES, FIELD_MESSAGES, loadPublicForm, localISODate,
  publicFormEndpoint, publicFormTokenFromPath, publicFormUrl, publicLinksStatus, regenerateFormLink, setFormPublic,
  submissionBody, submitPublicForm, validateSubmission, PUBLIC_LIMITS,
} from "./publicForms";
import { isRequestTask, requestSource } from "./inboxTriage";
import { requestDescription } from "../../supabase/functions/_shared/publicForm.ts";
import { DEMO_FORMS, PROJECTS, WORKSPACES } from "../data/data";

const TOKEN = "0123456789abcdef0123456789abcdef";
const BASE = "https://abc.supabase.co";
const schema = { name: "Design requests", intro: "Tell us.", project: { name: "Website refresh", emoji: "🎨", color: "oklch(0.62 0.16 293)" }, workspace: { name: "Foundrise", logoUrl: null }, fields: ["description", "priority"] };

/** a fetch that answers once with this status, body and headers, and records the request */
function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("addresses", () => {
  it("the function endpoint carries the token, encoded", () => {
    expect(publicFormEndpoint(TOKEN, BASE + "/")).toBe(`${BASE}/functions/v1/public-form?t=${TOKEN}`);
    expect(publicFormUrl(TOKEN, "https://www.kanbo.co.uk")).toBe(`https://www.kanbo.co.uk/f/${TOKEN}`);
    expect(publicFormTokenFromPath(`/f/${TOKEN}`)).toBe(TOKEN);
  });
});

describe("the demo form", () => {
  it("is the demo workspace's own request form, so the in-app preview matches", () => {
    const f = DEMO_FORMS[0];
    const p = PROJECTS.find((x) => x.id === f.projectId)!;
    const d = demoPublicForm();
    expect(d.name).toBe(f.name);
    expect(d.intro).toBe(f.description);
    expect(d.project).toEqual({ name: p.name, emoji: p.emoji, color: p.color });
    expect(d.workspace?.name).toBe(WORKSPACES.find((w) => w.id === f.workspaceId)?.name);
    expect(d.fields).toEqual(f.fields.filter((k) => k !== "assignee"));
  });
  it("loads and submits without a network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await loadPublicForm(DEMO_PUBLIC_TOKEN)).toEqual({ ok: true, form: demoPublicForm() });
    const ok = await submitPublicForm(DEMO_PUBLIC_TOKEN, { title: "Fix the hero", name: "Sam", email: "sam@example.com" }, { demoDelayMs: 0 });
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.reference).toMatch(/^KB-[0-9A-F]{6}$/);
    const bad = await submitPublicForm(DEMO_PUBLIC_TOKEN, { title: "", name: "Sam", email: "nope" }, { demoDelayMs: 0 });
    expect(bad).toMatchObject({ ok: false, reason: "invalid", field: "title", fields: { title: FIELD_MESSAGES.titleMissing, email: FIELD_MESSAGES.emailInvalid } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("switching a link in the demo is local and always the example page", async () => {
    expect(await setFormPublic("form-launch", true)).toEqual({ publicEnabled: true, publicToken: DEMO_PUBLIC_TOKEN });
    expect(await setFormPublic("form-launch", false)).toEqual({ publicEnabled: false, publicToken: DEMO_PUBLIC_TOKEN });
    expect(await regenerateFormLink("form-launch")).toBe(DEMO_PUBLIC_TOKEN);
    expect(await publicLinksStatus({ checkPage: true })).toEqual({ links: "demo", page: "demo" });
  });
});

describe("validateSubmission (the page's check before sending)", () => {
  it("uses the server's rules plus 'not before today'", () => {
    const today = localISODate();
    const past = localISODate(new Date(Date.now() - 2 * 86400_000));
    const f = { ...demoPublicForm() };
    expect(validateSubmission(f, { title: "Hi", name: "Sam", email: "sam@example.com", dueDate: today })).toEqual({});
    expect(validateSubmission(f, { title: "Hi", name: "Sam", email: "sam@example.com", dueDate: past })).toEqual({ dueDate: FIELD_MESSAGES.duePast });
    expect(validateSubmission(f, { title: "x".repeat(PUBLIC_LIMITS.title + 1), name: "", email: "" })).toEqual({
      title: FIELD_MESSAGES.titleLong, name: FIELD_MESSAGES.nameMissing, email: FIELD_MESSAGES.emailMissing,
    });
  });
  it("sends only the whitelisted keys, blanks left out", () => {
    const s = { title: "T", name: "N", email: "e@x.io", description: "  ", priority: "high" as const, dueDate: "", website: "", extra: "no" };
    expect(submissionBody(s)).toEqual({ title: "T", name: "N", email: "e@x.io", priority: "high" });
  });
});

describe("the task a submission files", () => {
  it("is recognised by the Inbox as a request, from the right form", () => {
    const description = requestDescription("Design requests", { name: "Sam", email: "sam@example.com", description: "Bigger." });
    expect(isRequestTask({ description })).toBe(true);
    expect(requestSource({ description })).toBe("Design requests (public link)");
  });
});

describe("loadPublicForm", () => {
  it("reads the form from the function (GET, no cookies, no cache)", async () => {
    const { fetchImpl, calls } = answer(200, { form: { ...schema, secret: "x" } });
    const r = await loadPublicForm(TOKEN, { baseUrl: BASE, fetchImpl });
    expect(r).toEqual({ ok: true, form: { ...schema, fields: ["description", "priority"] } });
    expect(calls[0].url).toBe(`${BASE}/functions/v1/public-form?t=${TOKEN}`);
    expect(calls[0].init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store" });
  });
  it("tells not found, switched off, too many and broken apart", async () => {
    const cases: [number, unknown, Record<string, string>, object][] = [
      [404, { reason: "not_found", error: "x" }, {}, { reason: "not_found", message: FAILURE_MESSAGES.not_found }],
      [404, { code: "NOT_FOUND", message: "Requested function was not found" }, {}, { reason: "unavailable" }], // not deployed yet
      [410, { reason: "disabled" }, {}, { reason: "disabled" }],
      [429, { reason: "rate_limited", retryAfter: 120 }, {}, { reason: "rate_limited", retryAfter: 120 }],
      [429, "slow down", { "Retry-After": "30" }, { reason: "rate_limited", retryAfter: 30 }],
      [503, { reason: "unavailable" }, {}, { reason: "unavailable" }],
      [500, "<html>oops</html>", {}, { reason: "unavailable" }],
      [200, { form: { nope: true } }, {}, { reason: "unavailable" }],
    ];
    for (const [status, body, headers, want] of cases) {
      const { fetchImpl } = answer(status, body, headers);
      expect(await loadPublicForm(TOKEN, { baseUrl: BASE, fetchImpl })).toMatchObject({ ok: false, ...want });
    }
  });
  it("never throws: a failed fetch is a network problem; a bad token never leaves the browser", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect(await loadPublicForm(TOKEN, { baseUrl: BASE, fetchImpl })).toMatchObject({ ok: false, reason: "network" });
    const spy = vi.fn() as unknown as typeof fetch;
    expect(await loadPublicForm("short", { baseUrl: BASE, fetchImpl: spy })).toMatchObject({ ok: false, reason: "not_found" });
    expect(spy).not.toHaveBeenCalled();
    // no backend configured (tests run without one): unavailable, not a crash
    expect(await loadPublicForm(TOKEN)).toMatchObject({ ok: false, reason: "unavailable" });
  });
  it("gives up after the timeout", async () => {
    const fetchImpl = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
    expect(await loadPublicForm(TOKEN, { baseUrl: BASE, fetchImpl, timeoutMs: 20 })).toMatchObject({ ok: false, reason: "network" });
  });
  it("says offline without trying when the browser knows it's offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const spy = vi.fn() as unknown as typeof fetch;
    expect(await loadPublicForm(TOKEN, { baseUrl: BASE, fetchImpl: spy })).toMatchObject({ ok: false, reason: "network" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("submitPublicForm", () => {
  const s = { title: "Hero", name: "Sam", email: "sam@example.com", description: "Bigger", website: "" };
  it("POSTs JSON and returns the reference", async () => {
    const { fetchImpl, calls } = answer(200, { ok: true, reference: "KB-7F3A9C" });
    expect(await submitPublicForm(TOKEN, s, { baseUrl: BASE, fetchImpl })).toEqual({ ok: true, reference: "KB-7F3A9C" });
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ title: "Hero", name: "Sam", email: "sam@example.com", description: "Bigger" });
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
  it("hands back the server's field messages", async () => {
    const { fetchImpl } = answer(400, { reason: "invalid", error: "Bad email", field: "email", fields: { email: "Bad email", bogus: 5 } });
    expect(await submitPublicForm(TOKEN, s, { baseUrl: BASE, fetchImpl })).toEqual({ ok: false, reason: "invalid", message: "Bad email", field: "email", fields: { email: "Bad email" } });
  });
  it("rate limits, switched off, offline", async () => {
    expect(await submitPublicForm(TOKEN, s, { baseUrl: BASE, fetchImpl: answer(429, { reason: "rate_limited", retryAfter: 300 }).fetchImpl })).toMatchObject({ reason: "rate_limited", retryAfter: 300 });
    expect(await submitPublicForm(TOKEN, s, { baseUrl: BASE, fetchImpl: answer(410, { reason: "disabled" }).fetchImpl })).toMatchObject({ reason: "disabled" });
    expect(await submitPublicForm(TOKEN, s, { baseUrl: BASE, fetchImpl: answer(200, { ok: false }).fetchImpl })).toMatchObject({ reason: "unavailable" });
    const down = vi.fn(async () => { throw new TypeError("Load failed"); }) as unknown as typeof fetch;
    expect(await submitPublicForm(TOKEN, s, { baseUrl: BASE, fetchImpl: down })).toMatchObject({ ok: false, reason: "network" });
  });
});

describe("applyPublicTheme", () => {
  it("Paper unless the system is dark, following changes, ignoring the app's saved theme", () => {
    let listener: (() => void) | null = null;
    const mq = { matches: false, addEventListener: vi.fn((_: string, fn: () => void) => { listener = fn; }), removeEventListener: vi.fn() };
    vi.spyOn(window, "matchMedia").mockReturnValue(mq as unknown as MediaQueryList);
    try { localStorage.setItem("kanbo-theme", "dark"); } catch { /* ignore */ }
    document.documentElement.setAttribute("data-theme", "dark");
    const stop = applyPublicTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    mq.matches = true;
    listener!();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    stop();
    expect(mq.removeEventListener).toHaveBeenCalled();
  });
});

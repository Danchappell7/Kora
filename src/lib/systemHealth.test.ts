import { describe, it, expect, vi } from "vitest";
import {
  parseHealthReport, healthUrl, supabaseRef, fetchHealth, demoHealthResult, checkErrorText, failingChecks, healthSummary,
  timeAgo, formatLondon, opsLinks, commitUrl, HEALTH_DEPLOY_COMMAND, type HealthReport,
} from "./systemHealth";

const OK: HealthReport = {
  ok: true,
  db: { ok: true, ms: 31, error: null }, auth: { ok: true, ms: 48, error: null },
  storage: { ok: true, ms: 70, error: null }, functions: { ok: true, ms: 77, error: null },
  time: "2026-10-09T09:00:00.000Z", schema: "0047",
};
const DOWN: HealthReport = { ...OK, ok: false, db: { ok: false, ms: 3001, error: "timeout" }, storage: { ok: false, ms: 12, error: "HTTP 500" } };

const respond = (status: number, body: unknown) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("parseHealthReport", () => {
  it("takes a well-formed report and recomputes ok from the checks", () => {
    expect(parseHealthReport(OK)).toEqual(OK);
    expect(parseHealthReport({ ...OK, ok: true, auth: { ok: false, ms: 1, error: "HTTP 502" } })!.ok).toBe(false);
  });
  it("refuses anything else, and tidies odd fields", () => {
    expect(parseHealthReport(null)).toBeNull();
    expect(parseHealthReport({ ok: true })).toBeNull();
    expect(parseHealthReport({ ...OK, db: { ms: 1 } })).toBeNull();
    const odd = parseHealthReport({ ...OK, schema: "<b>x</b>", time: "nope", db: { ok: true, ms: -4, error: "  " } })!;
    expect(odd.schema).toBeNull();
    expect(odd.time).toBe(new Date(0).toISOString());
    expect(odd.db).toEqual({ ok: true, ms: null, error: null });
  });
});

describe("addresses", () => {
  it("builds the function URL and the project ref", () => {
    expect(healthUrl("https://htnchiljplrnjkwimgla.supabase.co/")).toBe("https://htnchiljplrnjkwimgla.supabase.co/functions/v1/health");
    expect(healthUrl("")).toBeNull();
    expect(healthUrl("not a url")).toBeNull();
    expect(supabaseRef("https://htnchiljplrnjkwimgla.supabase.co")).toBe("htnchiljplrnjkwimgla");
    expect(supabaseRef("http://localhost:54321")).toBeNull();
  });
  it("links the operations tools (no key, no secret)", () => {
    const links = opsLinks({ supabaseUrl: "https://abcdefghij.supabase.co", build: { repo: "Acme/kanbo" }, sentryIssuesUrl: null });
    expect(links.map((l) => l.id)).toEqual(["supabase", "functions", "vercel", "uptime", "sentry"]);
    expect(links[0].href).toBe("https://supabase.com/dashboard/project/abcdefghij");
    expect(links[3].href).toBe("https://github.com/Acme/kanbo/actions/workflows/uptime.yml");
    expect(links[4]).toMatchObject({ href: "https://sentry.io/", detail: "Not set up yet" });
    const fallback = opsLinks({ supabaseUrl: null, build: { repo: null }, sentryIssuesUrl: "https://sentry.io/orgredirect/organizations/:orgslug/issues/?project=1" });
    expect(fallback[0].href).toContain("htnchiljplrnjkwimgla");
    expect(fallback[3].href).toBe("https://github.com/Danchappell7/Kora/actions/workflows/uptime.yml");
    expect(fallback[4].detail).toBe("Errors and route timings");
    expect(commitUrl("a5d8cd6", null)).toBe("https://github.com/Danchappell7/Kora/commit/a5d8cd6");
    expect(commitUrl("not-a-sha", "x/y")).toBeNull();
    expect(HEALTH_DEPLOY_COMMAND).toBe("supabase functions deploy health --project-ref htnchiljplrnjkwimgla --no-verify-jwt");
  });
});

describe("fetchHealth", () => {
  it("reads a 200 as ok and a 503 as degraded", async () => {
    let t = 1000;
    const now = () => (t += 120);
    const ok = await fetchHealth("u", { fetch: respond(200, OK), now });
    expect(ok).toMatchObject({ state: "ok", httpStatus: 200, roundTripMs: 120 });
    const down = await fetchHealth("u", { fetch: respond(503, DOWN) });
    expect(down.state).toBe("degraded");
  });
  it("tells a missing function from an unreachable one", async () => {
    expect(await fetchHealth("u", { fetch: respond(404, { code: "NOT_FOUND" }) })).toMatchObject({ state: "missing", httpStatus: 404 });
    expect(await fetchHealth("u", { fetch: respond(502, "<html>bad gateway</html>") })).toMatchObject({ state: "unreachable", reason: "http", httpStatus: 502 });
    expect(await fetchHealth("u", { fetch: async () => { throw new TypeError("Failed to fetch"); } })).toMatchObject({ state: "unreachable", reason: "network", httpStatus: null });
  });
  it("gives up after its timeout", async () => {
    const hang = (_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const r = await fetchHealth("u", { fetch: hang, timeoutMs: 20 });
    expect(r).toMatchObject({ state: "unreachable", reason: "timeout" });
  });
  it("sends a plain GET with no credentials (no CORS preflight)", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(OK), { status: 200 }));
    await fetchHealth("https://x.supabase.co/functions/v1/health", { fetch: f });
    const init = f.mock.calls[0][1]!;
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toBeUndefined();
  });
});

describe("words", () => {
  it("summarises every state", () => {
    expect(healthSummary(null)).toEqual({ tone: "neutral", text: "Checking…" });
    expect(healthSummary({ state: "ok", report: OK, httpStatus: 200, checkedAt: 0, roundTripMs: 1 }).text).toBe("All systems working");
    expect(healthSummary({ state: "degraded", report: DOWN, httpStatus: 503, checkedAt: 0, roundTripMs: 1 })).toEqual({ tone: "signal", text: "2 checks failing" });
    expect(healthSummary({ state: "degraded", report: { ...OK, ok: false, auth: { ok: false, ms: 1, error: "HTTP 500" } }, httpStatus: 503, checkedAt: 0, roundTripMs: 1 }).text).toBe("Sign-in is failing");
    expect(healthSummary({ state: "missing", httpStatus: 404, checkedAt: 0 }).text).toBe("Health check not deployed");
    expect(healthSummary({ state: "unreachable", reason: "timeout", httpStatus: null, checkedAt: 0 }).text).toBe("Health check timed out");
    expect(failingChecks(DOWN)).toEqual(["Database", "File storage"]);
  });
  it("explains a check's reason", () => {
    expect(checkErrorText("timeout")).toBe("Didn’t answer within 3 seconds");
    expect(checkErrorText("HTTP 404")).toContain("0047");
    expect(checkErrorText("HTTP 500")).toBe("Error (HTTP 500)");
    expect(checkErrorText("not configured")).toContain("server keys");
    expect(checkErrorText(null)).toBe("Not answering");
  });
  it("says how long ago, and when in London", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(timeAgo(now - 3_000, now)).toBe("just now");
    expect(timeAgo(now - 40_000, now)).toBe("40 sec ago");
    expect(timeAgo(now - 12 * 60_000, now)).toBe("12 min ago");
    expect(timeAgo("2026-10-09T09:00:00Z", now)).toBe("3 hr ago");
    expect(timeAgo("2026-10-08T09:00:00Z", now)).toBe("yesterday");
    expect(timeAgo("2026-10-04T09:00:00Z", now)).toBe("5 days ago");
    expect(timeAgo(null, now)).toBe("—");
    expect(formatLondon("2026-10-09T13:05:00Z")).toBe("9 Oct 2026, 14:05");
    expect(formatLondon("2026-12-09T13:05:00Z")).toBe("9 Dec 2026, 13:05");
    expect(formatLondon(null)).toBeNull();
  });
  it("makes a believable demo report", () => {
    const r = demoHealthResult(Date.parse("2026-10-09T12:00:00Z"), () => 0.5);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.report.schema).toBe("0047");
    expect(r.report.db.ms).toBeGreaterThan(20);
    expect(r.report.functions.ms).toBeGreaterThanOrEqual(r.report.storage.ms!);
  });
});

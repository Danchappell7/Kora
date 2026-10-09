// @vitest-environment node
/* (Node's own WebCrypto hashes the user id; nothing here needs a DOM.) */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  scrubCapabilityUrls, scrubEvent, scrubText, routeName, resolveEnvironment, parseSampleRate, defaultTracesRate,
  routeLoadSampler, hashUserId, isSaveOp, surfaceOf, sentryIssuesUrl, shapeBreadcrumb, scrubDomPath, scrubSpan,
} from "./monitoring";

describe("scrubCapabilityUrls", () => {
  it("replaces a public form's token in its address", () => {
    expect(scrubCapabilityUrls("https://www.kanbo.co.uk/f/Ab3_x-9QwErTyUiOpAsDfGhJ")).toBe("https://www.kanbo.co.uk/f/:token");
    expect(scrubCapabilityUrls("/f/Ab3_x-9QwErTyUiOpAsDfGhJ?utm=1")).toBe("/f/:token?utm=1");
  });

  it("replaces ?t= tokens on form and calendar-feed requests, keeping the other parameters", () => {
    expect(scrubCapabilityUrls("https://x.supabase.co/functions/v1/public-form?t=Ab3_x-9QwErTyUiOp"))
      .toBe("https://x.supabase.co/functions/v1/public-form?t=:token");
    expect(scrubCapabilityUrls("https://x.supabase.co/functions/v1/ics-feed?ping=1&t=deadbeef#x"))
      .toBe("https://x.supabase.co/functions/v1/ics-feed?ping=1&t=:token#x");
  });

  it("works inside a serialised event and leaves everything else alone", () => {
    const event = JSON.stringify({ request: { url: "https://www.kanbo.co.uk/f/SECRET_token_123" }, transaction: "/today", breadcrumbs: [{ data: { url: "/functions/v1/public-form?t=SECRET" } }] });
    const clean = scrubCapabilityUrls(event);
    expect(clean).not.toContain("SECRET");
    expect(JSON.parse(clean)).toEqual({ request: { url: "https://www.kanbo.co.uk/f/:token" }, transaction: "/today", breadcrumbs: [{ data: { url: "/functions/v1/public-form?t=:token" } }] });
    expect(scrubCapabilityUrls("/functions/v1/notify?task=1")).toBe("/functions/v1/notify?task=1");
  });

  it("scrubs an event in place, leaving Sentry's own objects (and cycles) alone", () => {
    class Scope { url = "/f/SECRET_token_123"; }
    const scope = new Scope();
    const crumb: Record<string, unknown> = { category: "fetch", data: { url: "https://x.supabase.co/functions/v1/public-form?t=SECRET" } };
    crumb.self = crumb;
    const event = {
      request: { url: "https://www.kanbo.co.uk/f/SECRET_token_123" },
      transaction: "/f/SECRET_token_123",
      breadcrumbs: [crumb],
      spans: [{ description: "GET https://x.supabase.co/functions/v1/ics-feed?t=SECRET" }],
      sdkProcessingMetadata: { capturedSpanScope: scope, dynamicSamplingContext: { transaction: "/f/SECRET_token_123" } },
    };
    expect(scrubEvent(event)).toBe(event);
    expect(event.request.url).toBe("https://www.kanbo.co.uk/f/:token");
    expect(event.transaction).toBe("/f/:token");
    expect((crumb.data as { url: string }).url).toBe("https://x.supabase.co/functions/v1/public-form?t=:token");
    expect(event.spans[0].description).toBe("GET https://x.supabase.co/functions/v1/ics-feed?t=:token");
    expect(event.sdkProcessingMetadata.dynamicSamplingContext.transaction).toBe("/f/:token");
    expect(event.sdkProcessingMetadata.capturedSpanScope).toBe(scope);   // untouched
  });
});

describe("scrubText (PII and secrets)", () => {
  it("drops tokens from an OAuth redirect's hash, a PKCE code and an email link", () => {
    const hash = "https://www.kanbo.co.uk/#access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl&expires_in=3600&refresh_token=r3fr3sh&provider_token=ya29.abc&token_type=bearer";
    const out = scrubText(hash);
    for (const s of ["eyJhbGci", "r3fr3sh", "ya29.abc"]) expect(out).not.toContain(s);
    expect(out).toContain("expires_in=3600");
    expect(out).toContain("token_type=bearer");
    expect(scrubText("/admin?code=4f9a-secret-code&state=x")).toBe("/admin?code=:redacted&state=x");
    expect(scrubText("/?token_hash=pkce_abc123&type=recovery")).toBe("/?token_hash=:redacted&type=recovery");
  });

  it("drops JWTs, Bearer values, API keys, webhook secrets and Slack hooks", () => {
    expect(scrubText("auth eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ok"))
      .toBe("auth [jwt] ok");
    expect(scrubText("Authorization: Bearer abc.DEF-123_~+/=")).toBe("Authorization: Bearer [redacted]");
    expect(scrubText("key kanbo_sk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd failed")).toBe("key kanbo_sk_[redacted] failed");
    expect(scrubText("kanbo_pk_xyz")).toBe("kanbo_pk_[redacted]");
    expect(scrubText("secret whsec_3hF9+abc/def= rotated")).toBe("secret whsec_[redacted] rotated");
    expect(scrubText("https://hooks.slack.com/services/T000/B000/XXXXXXXX")).toBe("https://hooks.slack.com/services/[redacted]");
  });

  it("drops email addresses and PostgREST filters, keeping the rest", () => {
    // (an apostrophe isn't an address character: the part after it goes)
    expect(scrubText("Invite to sam.o'neil+kanbo@acme.co.uk failed")).toBe("Invite to sam.o'[email] failed");
    expect(scrubText("Owner: daniel@kanbo.co.uk")).toBe("Owner: [email]");
    expect(scrubText("GET https://x.supabase.co/rest/v1/tasks?select=*&title=ilike.*salary%20review*"))
      .toBe("GET https://x.supabase.co/rest/v1/tasks?:redacted");
    expect(scrubText("/functions/v1/notify?task=1")).toBe("/functions/v1/notify?task=1");
    expect(scrubText("node_modules/@sentry/react@8.47.0/index.js")).toBe("node_modules/@sentry/react@8.47.0/index.js");
  });

  it("stays fast on long runs of word characters", () => {
    const long = "a".repeat(200_000) + "@";
    const t0 = performance.now();
    scrubText(long);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("scrubEvent (who and what)", () => {
  it("keeps only the hashed user id and stops IP inference", () => {
    const ev: Record<string, unknown> = { user: { id: "0123456789abcdef0123", email: "sam@acme.co.uk", ip_address: "1.2.3.4", username: "sam" } };
    scrubEvent(ev);
    expect(ev.user).toEqual({ id: "0123456789abcdef0123" });
    expect((ev.sdk as { settings: { infer_ip: string } }).settings.infer_ip).toBe("never");
    const raw: Record<string, unknown> = { user: { id: "6f1c2b9e-1111-4111-8111-111111111111", email: "x@y.co" } };
    scrubEvent(raw);
    expect(raw.user).toBeUndefined();   // a raw account id or email never goes
  });

  it("keeps what people wrote out of error context and breadcrumbs, and secret-named fields everywhere", () => {
    const ev = {
      extra: { op: "updateTask", title: "Salary review for Sam", patch: { description: "private notes", status: "done" } },
      breadcrumbs: [{ category: "console", message: "Error", data: { arguments: [{ op: "addComment", body: "Call me on 07700 900000" }] } }],
      contexts: { state: { password: "hunter2", Authorization: "Bearer zzz", apikey: "anon", nested: { refresh_token: "r" } } },
      request: { url: "/today", cookies: { sb: "x" }, headers: { Cookie: "sb=1", "User-Agent": "UA" } },
      spans: [{ data: { url: "https://x.supabase.co/rest/v1/tasks?title=eq.secret", "http.query": "?title=eq.secret" } }],
    };
    scrubEvent(ev);
    expect(ev.extra.op).toBe("updateTask");
    expect(ev.extra.title).toBe("[redacted 21 chars]");
    expect(ev.extra.patch).toEqual({ description: "[redacted 13 chars]", status: "done" });
    expect(ev.breadcrumbs[0].data.arguments[0]).toEqual({ op: "addComment", body: "[redacted 23 chars]" });
    expect(ev.contexts.state).toEqual({ password: "[redacted]", Authorization: "[redacted]", apikey: "[redacted]", nested: { refresh_token: "[redacted]" } });
    expect(ev.request).toEqual({ url: "/today", headers: { "User-Agent": "UA" } });
    expect(JSON.stringify(ev.spans)).not.toContain("secret");
  });
});

describe("element paths (clicks, keypresses, interaction timings)", () => {
  // what Sentry's htmlTreeAsString makes of a click inside TaskDetail: the dialog's aria-label is the task title
  const TASK_CLICK = 'div.ktd-panel[aria-label="Task: Sack Sana Ahmed before Q4"] > div.ktd-head > button.kbtn[type="button"][title="Close"]';

  it("drops aria-label, title, name and alt values, keeping the shape of the path", () => {
    expect(scrubDomPath(TASK_CLICK)).toBe('div.ktd-panel[aria-label] > div.ktd-head > button.kbtn[type="button"][title]');
    expect(scrubDomPath('span.ktd-presence[title="Also viewing: Sana Ahmed, Tom Ruiz"]')).toBe("span.ktd-presence[title]");
    expect(scrubDomPath('button.ksb-pin[aria-label="Pin project Launch \u2014 Acme"]')).toBe("button.ksb-pin[aria-label]");
    expect(scrubDomPath('input#\u003Ar1\u003A.kfield[type="email"][name="email"]')).toBe('input#:r1:.kfield[type="email"][name]');
    expect(scrubDomPath('img.kav[alt="Sana Ahmed"]')).toBe("img.kav[alt]");
    expect(scrubDomPath('div[role="dialog"][aria-label="Task: Sack Sana Ahmed before Q4"] > button.kbtn')).toBe('div[role="dialog"][aria-label] > button.kbtn');
    expect(scrubDomPath("body > div#root > main.kapp")).toBe("body > div#root > main.kapp");
    expect(scrubDomPath("<unknown>")).toBe("<unknown>");
  });

  it("fails closed when a label could fool the parser", () => {
    for (const hostile of [
      'div[aria-label="Sana"] > secret plans"] > button',
      'div[aria-label="Tom said "hi" to Sana"] > button',
      'li[title="a > b"][data-x="Sana Ahmed"]',
      'div[aria-label="unterminated Sana Ahmed',
    ]) {
      const out = scrubDomPath(hostile);
      expect(out, hostile).not.toMatch(/Sana|secret|Tom/);
    }
    expect(scrubDomPath('div[aria-label="Tom said "hi" to Sana"] > button')).toBe("div[aria-label] > button");
    expect(scrubDomPath('div[aria-label="Sana"] > secret plans"] > button')).toBe("[element]");
  });

  it("scrubs click and keypress breadcrumbs as they're recorded, and leaves other crumbs' messages alone", () => {
    expect(shapeBreadcrumb({ category: "ui.click", message: TASK_CLICK }).message).not.toContain("Sana");
    expect(shapeBreadcrumb({ category: "ui.input", message: 'input.kfield[name="Sana\u2019s notes"]' }).message).toBe("input.kfield[name]");
    expect(shapeBreadcrumb({ category: "save", message: "Save failed: updateTask" }).message).toBe("Save failed: updateTask");
  });

  it("scrubs them again in the event, in transaction spans and in the page load's web-vital attributes", () => {
    const event = {
      breadcrumbs: [{ category: "ui.click", message: TASK_CLICK }],
      spans: [
        { op: "ui.interaction.click", origin: "auto.ui.browser.metrics", description: TASK_CLICK },
        { op: "http.client", description: "GET https://x.supabase.co/rest/v1/tasks?title=ilike.*Sana*" },
      ],
      contexts: { trace: { data: { "lcp.element": 'h2.ktd-title[title="Sack Sana Ahmed before Q4"]', "cls.source.1": 'li[aria-label="Tom Ruiz"]', "lcp.size": 1200 } } },
      extra: { __serialized__: { target: 'img.kav[alt="Sana Ahmed"]', isTrusted: true } },
    };
    scrubEvent(event);
    expect(JSON.stringify(event)).not.toMatch(/Sana|Tom/);
    expect(event.breadcrumbs[0].message).toBe('div.ktd-panel[aria-label] > div.ktd-head > button.kbtn[type="button"][title]');
    expect(event.spans[0].description).toBe('div.ktd-panel[aria-label] > div.ktd-head > button.kbtn[type="button"][title]');
    expect(event.contexts.trace.data["lcp.element"]).toBe("h2.ktd-title[title]");
    expect(event.contexts.trace.data["lcp.size"]).toBe(1200);
    expect(event.extra.__serialized__.target).toBe("img.kav[alt]");
  });

  it("scrubs a standalone interaction (INP) span before it's sent", () => {
    const span = {
      op: "ui.interaction.click", origin: "auto.http.browser.inp", description: TASK_CLICK,
      data: { "sentry.origin": "auto.http.browser.inp", transaction: "/p/:id/board", user: "3f9a0c1b2d4e5f60718a", "http.query": "?q=Sana" },
    };
    expect(scrubSpan(span)).toBe(span);
    expect(span.description).toBe('div.ktd-panel[aria-label] > div.ktd-head > button.kbtn[type="button"][title]');
    expect(span.data.transaction).toBe("/p/:id/board");
    expect(span.data["http.query"]).toBe("[redacted]");
    expect(JSON.stringify(span)).not.toContain("Sana");
    // a span that isn't named after an element keeps its name (scrubbed like any text)
    const fetchSpan = { op: "http.client", description: "GET /rest/v1/tasks?title=eq.Sana", data: {} };
    expect(scrubSpan(fetchSpan).description).toBe("GET /rest/v1/tasks?:redacted");
  });
});

describe("routes, environment and sampling", () => {
  it("names a route by its template", () => {
    expect(routeName("/p/9f0c2b9e-1111-4111-8111-111111111111/board")).toBe("/p/:id/board");
    expect(routeName("/p/p-launch")).toBe("/p/:id");
    expect(routeName("/p/abc/docs/6f1c2b9e-1111-4111-8111-111111111111")).toBe("/p/:id/docs/:docId");
    expect(routeName("/search/list/my-saved-list")).toBe("/search/list/:id");
    expect(routeName("https://www.kanbo.co.uk/f/Ab3_x-9QwErTyUiOpAsDfGhJ?x=1")).toBe("/f/:token");
    expect(routeName("/tasks/waiting?due=today#x")).toBe("/tasks/waiting");
    expect(routeName("/today")).toBe("/today");
    expect(routeName("")).toBe("/");
    expect(routeName("/team/insights/trends")).toBe("/team/insights/trends");
  });

  it("picks the environment: explicit, then Vercel's, then the build mode", () => {
    expect(resolveEnvironment("staging", "production", true)).toBe("staging");
    expect(resolveEnvironment("", "preview", true)).toBe("preview");
    expect(resolveEnvironment(undefined, null, true)).toBe("production");
    expect(resolveEnvironment(undefined, "weird", false)).toBe("development");
    expect(resolveEnvironment("not a valid name!", null, true)).toBe("production");
  });

  it("parses a sample rate and falls back sensibly", () => {
    expect(parseSampleRate("0.25", 0.1)).toBe(0.25);
    expect(parseSampleRate("25%", 0.1)).toBe(0.25);
    expect(parseSampleRate("2", 0.1)).toBe(1);
    expect(parseSampleRate("-1", 0.1)).toBe(0);
    expect(parseSampleRate("lots", 0.1)).toBe(0.1);
    expect(parseSampleRate(undefined, 0.3)).toBe(0.3);
    expect(defaultTracesRate("production")).toBe(0.1);
    expect(defaultTracesRate("preview")).toBe(0.5);
    expect(defaultTracesRate("development")).toBe(1);
  });

  it("times only page loads and route changes", () => {
    const s = routeLoadSampler(0.1);
    expect(s({ name: "/today", attributes: { "sentry.origin": "auto.pageload.browser" } })).toBe(0.1);
    expect(s({ name: "/today", attributes: { "sentry.origin": "auto.navigation.browser" } })).toBe(0.1);
    expect(s({ name: "/today", attributes: { "kanbo.route_load": true } })).toBe(0.1);
    expect(s({ name: "manual", attributes: {} })).toBe(0);
    expect(s({ name: "child", parentSampled: true })).toBe(true);
  });

  it("gives route changes their template and scrubs crumb addresses", () => {
    const nav = shapeBreadcrumb({ category: "navigation", data: { from: "/today", to: "/p/9f0c2b9e-1111-4111-8111-111111111111/board?code=abc" } });
    expect(nav.data).toEqual({ from: "/today", to: "/p/9f0c2b9e-1111-4111-8111-111111111111/board?code=:redacted", route: "/p/:id/board" });
    const f = shapeBreadcrumb({ category: "fetch", data: { url: "https://x.supabase.co/rest/v1/profiles?email=eq.sam@acme.co.uk" } });
    expect(f.data!.url).toBe("https://x.supabase.co/rest/v1/profiles?:redacted");
  });

  it("knows a failed save from a failed read, and which surface a page is", () => {
    for (const op of ["updateTask", "createTask", "flushQueue-retry", "addComment", "deleteProject", "setSubtaskDone", "markActivityRead"]) expect(isSaveOp(op)).toBe(true);
    for (const op of ["bootstrap", "realtime-open", "listProjectAttachments-sign", "confirmWorkspaceGone", "schema-behind", undefined]) expect(isSaveOp(op)).toBe(false);
    expect(surfaceOf("/admin")).toBe("admin");
    expect(surfaceOf("/f/abc")).toBe("public-form");
    expect(surfaceOf("/privacy")).toBe("legal");
    expect(surfaceOf("/today")).toBe("app");
  });

  it("links a sentry.io DSN to its project's issues (no key in the address)", () => {
    expect(sentryIssuesUrl("https://abc123@o450000.ingest.de.sentry.io/4508000000000001"))
      .toBe("https://sentry.io/orgredirect/organizations/:orgslug/issues/?project=4508000000000001");
    expect(sentryIssuesUrl("https://k@sentry.example.com/12")).toBe("https://sentry.example.com/");
    expect(sentryIssuesUrl("not a dsn")).toBeNull();
    expect(sentryIssuesUrl(undefined)).toBeNull();
  });
});

const SUBTLE = globalThis.crypto.subtle;

describe("hashUserId", () => {
  it("is a stable salted SHA-256 prefix, different per person", async () => {
    const a = await hashUserId("6f1c2b9e-1111-4111-8111-111111111111", SUBTLE);
    const b = await hashUserId("6f1c2b9e-1111-4111-8111-111111111111", SUBTLE);
    const c = await hashUserId("6f1c2b9e-2222-4111-8111-111111111111", SUBTLE);
    expect(a).toMatch(/^[0-9a-f]{20}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("6f1c2b9e");
  });
  it("is null when the browser can't hash", async () => {
    expect(await hashUserId("u1", null)).toBeNull();
    expect(await hashUserId("", SUBTLE)).toBeNull();
  });
});

describe("with a DSN", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock("@sentry/react"); vi.resetModules(); });

  async function load() {
    vi.resetModules();
    vi.stubEnv("VITE_SENTRY_DSN", "https://pub@o1.ingest.sentry.io/42");
    const sentry = {
      init: vi.fn(), setTag: vi.fn(), setUser: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn(),
      browserTracingIntegration: vi.fn((o: unknown) => ({ name: "BrowserTracing", o })),
    };
    vi.doMock("@sentry/react", () => sentry);
    const m = await import("./monitoring");
    return { m, sentry };
  }

  it("initialises once with the release, environment and the scrubbers", async () => {
    const { m, sentry } = await load();
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.initMonitoring();
    m.initMonitoring();
    expect(sentry.init).toHaveBeenCalledTimes(1);
    const opts = sentry.init.mock.calls[0][0];
    expect(opts.dsn).toBe("https://pub@o1.ingest.sentry.io/42");
    expect(opts.sendDefaultPii).toBe(false);
    expect(typeof opts.tracesSampler).toBe("function");
    expect(typeof opts.beforeBreadcrumb).toBe("function");
    expect(typeof opts.beforeSendSpan).toBe("function");
    expect(opts.beforeBreadcrumb({ category: "ui.click", message: 'button[aria-label="Delete Sana\u2019s task"]' }).message).toBe("button[aria-label]");
    expect(opts.environment).toBe(m.MONITORING_ENVIRONMENT);
    // route-load spans are named by template
    const bt = sentry.browserTracingIntegration.mock.calls[0][0] as { beforeStartSpan: (o: { name: string; attributes?: Record<string, unknown> }) => { name: string; attributes: Record<string, unknown> } };
    expect(bt.beforeStartSpan({ name: "/p/9f0c2b9e-1111-4111-8111-111111111111/list" })).toMatchObject({ name: "/p/:id/list", attributes: { "kanbo.route_load": true } });
    expect(m.monitoringInfo()).toMatchObject({ enabled: true, issuesUrl: "https://sentry.io/orgredirect/organizations/:orgslug/issues/?project=42" });
  });

  it("leaves a save breadcrumb and an op tag for a failed write, not for a read", async () => {
    const { m, sentry } = await load();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("boom");
    m.reportError(err, { op: "updateTask" });
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({ category: "save", message: "Save failed: updateTask" }));
    expect(sentry.captureException).toHaveBeenCalledWith(err, { extra: { op: "updateTask" }, tags: { op: "updateTask" } });
    sentry.addBreadcrumb.mockClear();
    m.reportError(err, { op: "bootstrap" });
    expect(sentry.addBreadcrumb).not.toHaveBeenCalled();
    m.reportError(err);
    expect(sentry.captureException).toHaveBeenLastCalledWith(err, { extra: undefined, tags: undefined });
  });

  it("sets the person as a hashed id only, and clears them on sign-out", async () => {
    const { m, sentry } = await load();
    m.setUserContext({ id: "6f1c2b9e-1111-4111-8111-111111111111", email: "sam@acme.co.uk" });
    await vi.waitFor(() => expect(sentry.setUser).toHaveBeenCalled());
    const set = sentry.setUser.mock.calls[0][0] as { id: string };
    expect(Object.keys(set)).toEqual(["id"]);
    expect(set.id).toMatch(/^[0-9a-f]{20}$/);
    expect(JSON.stringify(sentry.setUser.mock.calls)).not.toContain("sam@");
    m.setUserContext(null);
    expect(sentry.setUser).toHaveBeenLastCalledWith(null);
  });
});

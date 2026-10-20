// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formBody, isResponseUrl, slackApi } from "./slackAppApi.ts";

// a stand-in, built at run time so it never looks like a real Slack token
const TOKEN = ["xoxb", "test", "stand-in"].join("-");

function recorder(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  return { seen, fetch: async (url: string, init: RequestInit) => { seen.push({ url, init }); return reply(url, init); } };
}

describe("the Slack Web API client", () => {
  it("POSTs form-encoded args (objects as JSON) with the bot token only in the Authorization header", async () => {
    const r = recorder(() => new Response(JSON.stringify({ ok: true, view: { id: "V1" } })));
    const api = slackApi(TOKEN, { fetch: r.fetch });
    const out = await api.call("views.open", { trigger_id: "1.2.3", view: { type: "modal", blocks: [] }, skip: undefined });
    expect(out).toMatchObject({ ok: true, view: { id: "V1" } });
    const { url, init } = r.seen[0];
    expect(url).toBe("https://slack.com/api/views.open");
    expect(url).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe("manual");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("trigger_id")).toBe("1.2.3");
    expect(JSON.parse(body.get("view")!)).toEqual({ type: "modal", blocks: [] });
    expect(body.has("skip")).toBe(false);
    expect(String(init.body)).not.toContain(TOKEN);
  });

  it("only the methods the app needs; nothing without a token", async () => {
    const r = recorder(() => new Response("{}"));
    expect(await slackApi(TOKEN, { fetch: r.fetch }).call("chat.delete", {})).toEqual({ ok: false, error: "method_not_allowed" });
    expect(await slackApi("", { fetch: r.fetch }).call("users.info", { user: "U1" })).toEqual({ ok: false, error: "not_configured" });
    expect(r.seen).toHaveLength(0);
  });

  it("Slack's refusals, rate limits, timeouts and junk become error words (never the token)", async () => {
    const api = (reply: Parameters<typeof recorder>[0]) => slackApi(TOKEN, { fetch: recorder(reply).fetch });
    expect(await api(() => new Response(JSON.stringify({ ok: false, error: "expired_trigger_id" }))).call("views.open", {}))
      .toMatchObject({ ok: false, error: "expired_trigger_id" });
    expect(await api(() => new Response("", { status: 429, headers: { "retry-after": "12" } })).call("chat.unfurl", {}))
      .toEqual({ ok: false, error: "ratelimited", retryAfter: 12 });
    expect(await api(() => new Response("<html>", { status: 502 })).call("users.info", {})).toEqual({ ok: false, error: "http_502" });
    expect(await api(() => new Response("not json")).call("users.info", {})).toEqual({ ok: false, error: "bad_reply" });
    expect(await api(() => new Response(JSON.stringify({ ok: false, error: `bad ${TOKEN}` }))).call("users.info", {}))
      .toMatchObject({ ok: false, error: "unknown_error" });
    expect(await api(() => { throw Object.assign(new Error(`error sending request for url (https://slack.com/api?t=${TOKEN})`), { name: "TypeError" }); }).call("users.info", {}))
      .toEqual({ ok: false, error: "unreachable" });
    expect(await api(() => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }).call("users.info", {})).toEqual({ ok: false, error: "timeout" });
  });

  it("response_url: only hooks.slack.com, JSON, never redirected", async () => {
    expect(isResponseUrl("https://hooks.slack.com/commands/T1/123/abc")).toBe(true);
    expect(isResponseUrl("https://hooks.slack.com/actions/T1/123/abc")).toBe(true);
    expect(isResponseUrl("https://hooks.slack.com/app/T1/123/abc")).toBe(true);
    for (const bad of ["http://hooks.slack.com/commands/T1/1/a", "https://hooks.slack.com.evil.test/commands/x", "https://evil.test/commands/x",
      "https://hooks.slack.com/services/T/B/x", "https://hooks.slack.com/commands/../../x?y", 7]) expect(isResponseUrl(bad)).toBe(false);
    const r = recorder(() => new Response("ok"));
    const api = slackApi(TOKEN, { fetch: r.fetch });
    expect(await api.respond("https://evil.test/commands/x", { text: "hi" })).toBe(false);
    expect(r.seen).toHaveLength(0);
    expect(await api.respond("https://hooks.slack.com/commands/T1/1/a", { text: "hi" })).toBe(true);
    expect(r.seen[0].init).toMatchObject({ method: "POST", redirect: "manual", body: JSON.stringify({ text: "hi" }) });
    expect(JSON.stringify(r.seen[0].init.headers)).not.toContain(TOKEN);
  });

  it("form bodies", () => {
    expect(formBody({ a: 1, b: "x y", c: null, d: { e: [1] } })).toBe("a=1&b=x+y&d=%7B%22e%22%3A%5B1%5D%7D");
  });
});

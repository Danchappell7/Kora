/* lib/slack against a (mocked) real backend: slack_status() and friends over
   RPC, posts through the slack-post edge function, and every way they can
   fail — 0043 not run, function not deployed, refusals, offline. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { rpc, invoke } = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn() }));
vi.mock("./supabase", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), functions: { invoke: (...a: unknown[]) => invoke(...a) } },
  isSupabaseConfigured: true,
}));

import {
  connectSlack, disconnectSlack, getSlackStatus, loadSlackStatus, onSlackStatusChange, postToSlack, resetSlackState,
  setSlackAutopost, SLACK_COPY, testSlack,
} from "./slack";

const WS = "11111111-2222-4333-8444-555555555555";
const PROJECT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const HOOK = "https://hooks.slack.com/services/T0001/B0001/abcdefghijklmnopqrstuvwx";
const ROW = { connected: true, channel_label: "#team", autopost: false, autopost_time: null, can_manage: true, can_post: true, updated_at: null };

/** A FunctionsHttpError-shaped failure, as supabase-js returns it. */
const httpError = (status: number, body: unknown) => ({
  name: "FunctionsHttpError", message: "Edge Function returned a non-2xx status code",
  context: { status, json: async () => body, clone: () => ({ json: async () => body }) },
});

const setOnline = (on: boolean) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });

beforeEach(() => {
  resetSlackState({ demoDelayMs: 0 });
  rpc.mockReset(); invoke.mockReset();
  setOnline(true);
});
afterEach(() => setOnline(true));

describe("status", () => {
  it("reads slack_status() as the person, then serves it from the cache", async () => {
    rpc.mockResolvedValue({ data: ROW, error: null });
    expect(await getSlackStatus(WS)).toMatchObject({ connected: true, channelLabel: "#team", canPost: true });
    expect(rpc).toHaveBeenCalledWith("slack_status", { p_ws: WS });
    await getSlackStatus(WS);
    expect(rpc).toHaveBeenCalledTimes(1);
    await loadSlackStatus(WS, { fresh: true });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("two readers at once share one request", async () => {
    let resolve!: (v: unknown) => void;
    rpc.mockReturnValue(new Promise((r) => { resolve = r; }));
    const a = getSlackStatus(WS), b = getSlackStatus(WS);
    resolve({ data: ROW, error: null });
    expect((await a)?.connected).toBe(true);
    expect((await b)?.connected).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("an outsider (null) is null, with no problem", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await loadSlackStatus(WS)).toEqual({ status: null });
  });

  it("before 0043: unavailable, and it stops asking for the session", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.slack_status(p_ws) in the schema cache" } });
    expect(await loadSlackStatus(WS)).toEqual({ status: null, problem: "unavailable" });
    expect(await loadSlackStatus("other", { fresh: true })).toEqual({ status: null, problem: "unavailable" });
    expect(rpc).toHaveBeenCalledTimes(1);
    await expect(connectSlack(WS, HOOK)).rejects.toThrow(SLACK_COPY.unavailable);
  });

  it("offline: the last known status, or 'offline' without one", async () => {
    setOnline(false);
    expect(await loadSlackStatus(WS)).toEqual({ status: null, problem: "offline" });
    expect(rpc).not.toHaveBeenCalled();
    setOnline(true);
    rpc.mockResolvedValue({ data: ROW, error: null });
    await getSlackStatus(WS);
    setOnline(false);
    expect((await loadSlackStatus(WS, { fresh: true })).status?.connected).toBe(true);
  });

  it("another error keeps what was known and says 'error'", async () => {
    rpc.mockResolvedValueOnce({ data: ROW, error: null });
    await getSlackStatus(WS);
    rpc.mockResolvedValueOnce({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    expect(await loadSlackStatus(WS, { fresh: true })).toEqual({ status: expect.objectContaining({ connected: true }), problem: "error" });
  });
});

describe("owner/admin actions", () => {
  it("connect sends the trimmed URL and the channel label, and tells listeners", async () => {
    rpc.mockResolvedValue({ data: { ...ROW, channel_label: "#launch" }, error: null });
    const fn = vi.fn();
    onSlackStatusChange(fn);
    const s = await connectSlack(WS, ` ${HOOK} `, "launch");
    expect(rpc).toHaveBeenCalledWith("slack_connect", { p_ws: WS, p_url: HOOK, p_channel_label: "#launch" });
    expect(s.channelLabel).toBe("#launch");
    expect(fn).toHaveBeenCalledWith(WS, expect.objectContaining({ connected: true }));
  });

  it("maps the database's refusals to sentences", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "not allowed" } });
    await expect(connectSlack(WS, HOOK)).rejects.toThrow(SLACK_COPY.notAllowed);
    rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "invalid webhook url" } });
    await expect(connectSlack(WS, HOOK)).rejects.toThrow(SLACK_COPY.invalidUrl);
    rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "not connected" } });
    await expect(setSlackAutopost(WS, true, "09:00")).rejects.toThrow(SLACK_COPY.notConnected);
    rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "invalid time" } });
    await expect(setSlackAutopost(WS, true)).rejects.toThrow(SLACK_COPY.invalidTime);
    rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(disconnectSlack(WS)).rejects.toThrow(SLACK_COPY.saveFailed);
    rpc.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(disconnectSlack(WS)).rejects.toThrow(SLACK_COPY.offline);
  });

  it("auto-post and disconnect call their RPCs", async () => {
    rpc.mockResolvedValue({ data: { ...ROW, autopost: true, autopost_time: "08:30" }, error: null });
    expect((await setSlackAutopost(WS, true, "08:30")).autopostTime).toBe("08:30");
    expect(rpc).toHaveBeenLastCalledWith("slack_set_autopost", { p_ws: WS, p_enabled: true, p_time: "08:30" });
    await setSlackAutopost(WS, false);
    expect(rpc).toHaveBeenLastCalledWith("slack_set_autopost", { p_ws: WS, p_enabled: false, p_time: null });
    rpc.mockResolvedValue({ data: { ...ROW, connected: false }, error: null });
    expect((await disconnectSlack(WS)).connected).toBe(false);
    expect(rpc).toHaveBeenLastCalledWith("slack_disconnect", { p_ws: WS });
  });

  it("offline: no request, a sentence", async () => {
    setOnline(false);
    await expect(disconnectSlack(WS)).rejects.toThrow(SLACK_COPY.offline);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("posting", () => {
  it("posts through slack-post with the action and only the fields that apply", async () => {
    invoke.mockResolvedValue({ data: { ok: true }, error: null });
    expect(await postToSlack(WS, { kind: "status", text: "  Copy is late.  ", projectId: PROJECT, status: "at_risk", title: "  " })).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("slack-post", {
      body: { action: "post_status", workspaceId: WS, text: "Copy is late.", projectId: PROJECT, status: "at_risk" },
      timeout: expect.any(Number),
    });
    await postToSlack(WS, { kind: "risks", text: "x".repeat(20000) });
    const body = invoke.mock.calls[1][1].body;
    expect(body.action).toBe("post_risks");
    expect(body.text.length).toBe(12000);
    await testSlack(WS);
    expect(invoke.mock.calls[2][1].body).toEqual({ action: "test", workspaceId: WS });
  });

  it("reads the function's refusal", async () => {
    invoke.mockResolvedValueOnce({ data: null, error: httpError(429, { error: "slow down", reason: "rate_limited", retryAfter: 120 }) });
    expect(await postToSlack(WS, { kind: "standup", text: "x" })).toEqual({
      ok: false, reason: "rate_limited", retryAfter: 120, message: "That's a lot of posts in a short time. Try again in 2 minutes.",
    });
    invoke.mockResolvedValueOnce({ data: null, error: httpError(502, { error: "no", reason: "slack_rejected", detail: "no_service" }) });
    expect(await postToSlack(WS, { kind: "standup", text: "x" })).toMatchObject({ reason: "slack_rejected", message: expect.stringMatching(/reconnect Slack in Settings/) });
    invoke.mockResolvedValueOnce({ data: null, error: httpError(403, { error: "x", reason: "not_allowed" }) });
    expect(await testSlack(WS)).toMatchObject({ reason: "not_allowed", message: "Only owners and admins can send a test message." });
    invoke.mockResolvedValueOnce({ data: null, error: httpError(400, { error: "That project isn't in this workspace.", reason: "invalid" }) });
    expect(await postToSlack(WS, { kind: "status", text: "x", projectId: PROJECT })).toMatchObject({ reason: "invalid", message: "That project isn't in this workspace." });
  });

  it("not connected any more: says so and reads the status again", async () => {
    invoke.mockResolvedValueOnce({ data: null, error: httpError(409, { error: "x", reason: "not_connected" }) });
    rpc.mockResolvedValue({ data: { ...ROW, connected: false }, error: null });
    const fn = vi.fn();
    onSlackStatusChange(fn);
    expect(await postToSlack(WS, { kind: "standup", text: "x" })).toMatchObject({ reason: "not_connected" });
    await vi.waitFor(() => expect(fn).toHaveBeenCalledWith(WS, expect.objectContaining({ connected: false })));
  });

  it("the function isn't deployed / the gateway refused / the network failed", async () => {
    invoke.mockResolvedValueOnce({ data: null, error: httpError(404, { code: "NOT_FOUND", message: "Requested function was not found" }) });
    expect(await postToSlack(WS, { kind: "standup", text: "x" })).toMatchObject({ reason: "unavailable", message: "Posting to Slack isn't switched on yet." });
    invoke.mockResolvedValueOnce({ data: null, error: httpError(401, { msg: "Invalid JWT" }) });
    expect(await postToSlack(WS, { kind: "standup", text: "x" })).toMatchObject({ reason: "not_allowed" });
    invoke.mockResolvedValueOnce({ data: null, error: { name: "FunctionsFetchError", message: "Failed to send a request to the Edge Function" } });
    expect(await postToSlack(WS, { kind: "standup", text: "x" })).toMatchObject({ reason: "network" });
    invoke.mockResolvedValueOnce({ data: null, error: { name: "FunctionsRelayError", message: "Relay Error invoking the Edge Function" } });
    expect(await postToSlack(WS, { kind: "standup", text: "x" })).toMatchObject({ reason: "unavailable" });
    invoke.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await postToSlack(WS, { kind: "standup", text: "x" })).toMatchObject({ reason: "network" });
  });

  it("offline: no request", async () => {
    setOnline(false);
    expect(await postToSlack(WS, { kind: "standup", text: "x" })).toMatchObject({ ok: false, reason: "network", message: SLACK_COPY.offline });
    expect(invoke).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { constantTimeEqual, hmacSha256Hex, SLACK_MAX_SKEW_SEC, slackSignature, verifySlackRequest } from "./slackAppVerify.ts";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BODY = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&user_id=U2CERLKJA&command=%2Fkanbo&text=Buy+milk";
const NOW = 1_760_000_000_000;
const TS = String(NOW / 1000);
const node = (secret: string, ts: string, body: string) => "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

describe("Slack request signatures (v0 HMAC-SHA256)", () => {
  it("matches Node's HMAC (the reference)", async () => {
    expect(await hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog"))
      .toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
    expect(await slackSignature(SECRET, TS, BODY)).toBe(node(SECRET, TS, BODY));
  });

  it("accepts a correctly signed, fresh request", async () => {
    expect(await verifySlackRequest({ secret: SECRET, timestamp: TS, signature: node(SECRET, TS, BODY), rawBody: BODY, now: NOW })).toEqual({ ok: true });
    // 4 minutes 59 either way is fine
    const early = String(NOW / 1000 - SLACK_MAX_SKEW_SEC + 1);
    expect((await verifySlackRequest({ secret: SECRET, timestamp: early, signature: node(SECRET, early, BODY), rawBody: BODY, now: NOW })).ok).toBe(true);
  });

  it("refuses a body changed in any way (even one character, even whitespace)", async () => {
    const sig = node(SECRET, TS, BODY);
    for (const body of [BODY + " ", BODY.replace("Buy", "Bux"), BODY.slice(1), "", BODY.toUpperCase()]) {
      expect(await verifySlackRequest({ secret: SECRET, timestamp: TS, signature: sig, rawBody: body, now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
    }
  });

  it("refuses the wrong secret, a tampered timestamp, a malformed or upper-cased signature", async () => {
    const r = (o: Partial<Parameters<typeof verifySlackRequest>[0]>) =>
      verifySlackRequest({ secret: SECRET, timestamp: TS, signature: node(SECRET, TS, BODY), rawBody: BODY, now: NOW, ...o });
    expect(await r({ signature: node("another-secret", TS, BODY) })).toEqual({ ok: false, reason: "bad_signature" });
    const ts2 = String(Number(TS) + 1);
    expect(await r({ timestamp: ts2 })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await r({ signature: node(SECRET, TS, BODY).replace("v0=", "v1=") })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await r({ signature: node(SECRET, TS, BODY).toUpperCase() })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await r({ signature: "v0=abc" })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses replays older than 5 minutes and timestamps from the future", async () => {
    for (const ts of [String(NOW / 1000 - SLACK_MAX_SKEW_SEC - 1), String(NOW / 1000 + SLACK_MAX_SKEW_SEC + 1), "0"]) {
      expect(await verifySlackRequest({ secret: SECRET, timestamp: ts, signature: node(SECRET, ts, BODY), rawBody: BODY, now: NOW })).toEqual({ ok: false, reason: "stale" });
    }
  });

  it("refuses missing headers, a non-numeric timestamp, and fails closed without a secret", async () => {
    expect(await verifySlackRequest({ secret: SECRET, timestamp: null, signature: node(SECRET, TS, BODY), rawBody: BODY, now: NOW })).toEqual({ ok: false, reason: "missing" });
    expect(await verifySlackRequest({ secret: SECRET, timestamp: TS, signature: undefined, rawBody: BODY, now: NOW })).toEqual({ ok: false, reason: "missing" });
    expect(await verifySlackRequest({ secret: SECRET, timestamp: "1e9", signature: node(SECRET, "1e9", BODY), rawBody: BODY, now: NOW })).toEqual({ ok: false, reason: "missing" });
    for (const secret of ["", null, undefined]) {
      expect(await verifySlackRequest({ secret, timestamp: TS, signature: node("", TS, BODY), rawBody: BODY, now: NOW })).toEqual({ ok: false, reason: "no_secret" });
    }
  });

  it("compares in constant time over the whole string", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("é", "e")).toBe(false);
  });
});

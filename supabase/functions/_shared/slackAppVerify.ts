// ============================================================
// KANBO — Slack app: is this request really from Slack?          [0049]
//
// Every request Slack sends (slash commands, interactivity, options loads,
// events) is signed with the app's Signing Secret:
//   X-Slack-Request-Timestamp: <unix seconds>
//   X-Slack-Signature:         v0=<hex HMAC-SHA256(secret, "v0:" + ts + ":" + raw body)>
// https://api.slack.com/authentication/verifying-requests-from-slack
//
// The slack-app function checks it before it reads a single field: over the
// raw body exactly as received, a constant-time comparison, and the
// timestamp within 5 minutes of now either way (a captured request can't be
// replayed later). No secret configured → every request is refused (fails
// closed). The secret is never logged or echoed.
//
// Pure (WebCrypto only): vitest runs it (slackAppVerify.test.ts).
// ============================================================

/** How far a request's timestamp may be from now, either way (seconds). */
export const SLACK_MAX_SKEW_SEC = 5 * 60;

export type SlackVerifyResult =
  | { ok: true }
  | { ok: false; reason: "no_secret" | "missing" | "stale" | "bad_signature" };

const enc = new TextEncoder();

/** Lower-case hex of HMAC-SHA256(key, message). */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Equal strings, compared in time that doesn't depend on where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(String(a ?? ""));
  const y = enc.encode(String(b ?? ""));
  // compare against a same-length buffer either way, so the length check isn't an early exit on content
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The signature Slack would send for this body at this time. */
export async function slackSignature(secret: string, timestamp: string, rawBody: string): Promise<string> {
  return `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${rawBody}`)}`;
}

/**
 * Check a request's Slack signature. `now` in milliseconds (tests). Never
 * throws; never says which part of a signature was wrong.
 */
export async function verifySlackRequest(opts: {
  secret: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string;
  now?: number;
}): Promise<SlackVerifyResult> {
  const secret = String(opts.secret ?? "");
  if (!secret) return { ok: false, reason: "no_secret" };
  const ts = String(opts.timestamp ?? "").trim();
  const sig = String(opts.signature ?? "").trim();
  if (!ts || !sig) return { ok: false, reason: "missing" };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: "missing" };
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - Number(ts)) > SLACK_MAX_SKEW_SEC) return { ok: false, reason: "stale" };
  if (!/^v0=[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: "bad_signature" };
  try {
    const want = await slackSignature(secret, ts, opts.rawBody);
    return constantTimeEqual(want, sig) ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}

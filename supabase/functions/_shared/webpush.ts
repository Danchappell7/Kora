// ============================================================
// KANBO — Web Push for Edge Functions (0043 push_subscriptions).
//
// Sends a notification to a browser's push service the standard way, with
// WebCrypto only (no npm dependency):
//   - VAPID (RFC 8292): an ES256 JWT for the push service's origin, signed
//     with the VAPID_PRIVATE_KEY secret, sent as
//     `Authorization: vapid t=<jwt>, k=<public key>`;
//   - message encryption (RFC 8291, aes128gcm per RFC 8188): an ephemeral
//     ECDH P-256 key, HKDF-SHA-256 and AES-128-GCM, one record.
// The payload the service worker (public/sw.js) reads is JSON:
//   { title, body, url: "/?task=<id>" (same-origin path), tag?: "task-<id>", kind? }
//
// Safety: endpoints are browser-supplied URLs, so only the real push
// services are ever contacted (PUSH_HOSTS, https, port 443, no
// redirects); anything else is skipped and its row deleted. A 404/410
// means the browser dropped the subscription: the row is deleted too.
// Missing or malformed VAPID secrets → vapidFromEnv() returns null and
// callers skip push silently (email is unaffected).
//
// Pure module (no Deno globals, no remote imports): vitest runs it under
// Node's WebCrypto — see webpush.test.ts (RFC 8291's own test vector).
// ============================================================

/** The slice of a supabase-js client these helpers use (service role). */
// deno-lint-ignore no-explicit-any
export type Db = { from(table: string): any };

export interface PushSubscriptionKeys {
  endpoint: string;
  /** the browser's ECDH P-256 public key, base64url (65 bytes, uncompressed) */
  p256dh: string;
  /** the browser's 16-byte auth secret, base64url */
  auth: string;
}

export interface VapidKeys {
  /** base64url, 65-byte uncompressed P-256 point (the key the browser subscribed with) */
  publicKey: string;
  /** base64url, the 32-byte private scalar */
  privateKey: string;
  /** mailto: or https: contact for the push services */
  subject: string;
}

export type PushMessageKind = "assigned" | "mention" | "comment" | "due" | "test";

export interface PushMessage {
  title: string;
  body: string;
  /** a same-origin path, e.g. "/?task=<id>" */
  url: string;
  /** collapse key: a newer notification with the same tag replaces the older */
  tag?: string;
  kind?: PushMessageKind;
}

export interface SendResult {
  ok: boolean;
  /** HTTP status from the push service (0: not sent) */
  status: number;
  /** the subscription can never work again: delete its row */
  gone: boolean;
  /** why it wasn't sent at all */
  skipped?: "host" | "keys";
  error?: string;
}

export interface SendOptions {
  /** seconds the push service may hold the message for an offline device */
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** injected for tests */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** clock override for tests (ms since epoch) */
  now?: number;
}

/** The push services Kanbo talks to (browsers only ever hand out these). */
export const PUSH_HOSTS: readonly string[] = [
  "fcm.googleapis.com",               // Chrome, Edge on Android, Opera, Samsung Internet
  "updates.push.services.mozilla.com", // Firefox
  "*.push.apple.com",                 // Safari (macOS 13+, iOS/iPadOS 16.4+ Home Screen apps)
  "*.notify.windows.com",             // Edge on Windows
];

/** Biggest plaintext we send (the services accept ~4 KB of ciphertext). */
export const MAX_PAYLOAD_BYTES = 3072;
const RECORD_SIZE = 4096;
const enc = new TextEncoder();

/* ---------------------------- encoding ---------------------------- */

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url (or plain base64) → bytes; throws on anything else. */
export function b64urlDecode(s: string): Uint8Array {
  const clean = String(s ?? "").trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) throw new Error("not base64url");
  const bin = atob(clean + "===".slice((clean.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
/** a standalone ArrayBuffer copy (what WebCrypto's BufferSource wants, in every TS lib) */
const ab = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer;
const subtle = () => {
  const s = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!s) throw new Error("WebCrypto is not available");
  return s;
};

/* ---------------------------- endpoints ---------------------------- */

/** Is this a real push service URL (https, default port, an allowlisted host)? */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== "string" || endpoint.length > 1000) return false;
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const h = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

/* ------------------------------ VAPID ------------------------------ */

const warned = new Set<string>();
function warnOnce(tag: string, msg: string) {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(`[webpush] ${msg}`);
}

/**
 * The VAPID keys from the function's environment, or null when push isn't
 * set up (any of them missing or malformed). `get` is Deno.env.get.
 * VAPID_SUBJECT falls back to APP_URL when that's an https address.
 */
export function vapidFromEnv(get: (k: string) => string | undefined): VapidKeys | null {
  const publicKey = (get("VAPID_PUBLIC_KEY") ?? "").trim();
  const privateKey = (get("VAPID_PRIVATE_KEY") ?? "").trim();
  const appUrl = (get("APP_URL") ?? "").trim();
  const subject = (get("VAPID_SUBJECT") ?? "").trim() || (/^https:\/\//.test(appUrl) ? appUrl.replace(/\/+$/, "") : "");
  if (!publicKey && !privateKey) return null; // not set up: stay quiet
  if (!publicKey || !privateKey) { warnOnce("half", "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must both be set. Push is off."); return null; }
  let pub: Uint8Array, priv: Uint8Array;
  try {
    pub = b64urlDecode(publicKey);
    if (pub.length !== 65 || pub[0] !== 4) throw new Error("public key");
    priv = b64urlDecode(privateKey);
    if (priv.length !== 32) throw new Error("private key");
  } catch (e) {
    warnOnce("shape", `VAPID ${(e as Error).message === "private key" ? "private" : "public"} key isn't a base64url P-256 key. Push is off.`);
    return null;
  }
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) {
    warnOnce("subject", "VAPID_SUBJECT must be mailto:you@example.com or an https:// URL. Push is off.");
    return null;
  }
  // canonical unpadded base64url, whatever was pasted (padded or plain base64
  // too): the JWK import and the `k=` header both need exactly that form
  return { publicKey: b64urlEncode(pub), privateKey: b64urlEncode(priv), subject };
}

/** JWK for a P-256 key from its raw base64url parts. */
function p256Jwk(publicKey: string, privateKey?: string): JsonWebKey {
  const pub = b64urlDecode(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("bad P-256 public key");
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), ext: true };
  if (privateKey !== undefined) jwk.d = privateKey.trim();
  return jwk;
}

const signingKeys = new Map<string, Promise<CryptoKey>>();
function signingKey(v: VapidKeys): Promise<CryptoKey> {
  const k = `${v.publicKey}|${v.privateKey}`;
  let p = signingKeys.get(k);
  if (!p) {
    p = subtle().importKey("jwk", p256Jwk(v.publicKey, v.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    p.catch(() => signingKeys.delete(k));
    signingKeys.set(k, p);
  }
  return p;
}

/**
 * Do the VAPID keys belong together? (Signs a probe with the private key and
 * verifies it with the public one.) Cached per process. A mismatch would make
 * every push service refuse us, so callers skip push instead.
 */
const pairChecks = new Map<string, Promise<boolean>>();
export function vapidKeysMatch(v: VapidKeys): Promise<boolean> {
  const k = `${v.publicKey}|${v.privateKey}`;
  let p = pairChecks.get(k);
  if (!p) {
    p = (async () => {
      try {
        const probe = enc.encode("kanbo-vapid-probe");
        const sig = await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(v), ab(probe));
        const pub = await subtle().importKey("jwk", p256Jwk(v.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        return await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, ab(probe));
      } catch { return false; }
    })();
    pairChecks.set(k, p);
  }
  return p;
}

/** Longest a VAPID token lives (RFC 8292 allows 24 h; Kanbo uses at most 12 h). */
export const VAPID_MAX_TTL_SEC = 12 * 3600;
const jwtCache = new Map<string, { header: string; exp: number }>();

/**
 * `Authorization` for a push to `endpoint`: `vapid t=<ES256 JWT>, k=<public key>`.
 * The JWT's aud is the endpoint's origin, exp is ttlSec (default 1 h, never
 * more than 12 h) ahead, sub is the VAPID subject. Reused while it has more
 * than 5 minutes left.
 */
export async function vapidAuthHeader(endpoint: string, v: VapidKeys, opts: { now?: number; ttlSec?: number } = {}): Promise<string> {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const aud = new URL(endpoint).origin;
  const cacheKey = `${aud}|${v.publicKey}|${v.subject}`;
  const hit = jwtCache.get(cacheKey);
  if (hit && hit.exp - now > 300 && opts.now === undefined) return hit.header;
  const exp = now + Math.max(60, Math.min(opts.ttlSec ?? 3600, VAPID_MAX_TTL_SEC));
  const part = (o: unknown) => b64urlEncode(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud, exp, sub: v.subject })}`;
  const sig = new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(v), ab(enc.encode(unsigned))));
  const header = `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${v.publicKey}`;
  if (opts.now === undefined) jwtCache.set(cacheKey, { header, exp });
  return header;
}

/* -------------------------- aes128gcm (RFC 8291) -------------------------- */

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", ab(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: ab(salt), info: ab(info) }, key, bytes * 8));
}

/** An ECDH P-256 key pair from raw base64url parts (tests use RFC 8291's). */
export async function importEcdhKeyPair(publicKey: string, privateKey: string): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
  const priv = await subtle().importKey("jwk", p256Jwk(publicKey, privateKey), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey: priv, publicKey: b64urlDecode(publicKey) };
}

/**
 * Encrypt `plaintext` for one subscription (RFC 8291 + RFC 8188 aes128gcm,
 * one record, no padding). Returns the request body: salt(16) · rs(4) ·
 * idlen(1) · our ephemeral public key(65) · ciphertext. `salt` and
 * `localKey` are for tests; normally both are fresh per message.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  authSecret: string,
  opts: { salt?: Uint8Array; localKey?: { privateKey: CryptoKey; publicKey: Uint8Array } } = {},
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dh);
  const auth = b64urlDecode(authSecret);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("bad p256dh");
  if (auth.length < 16) throw new Error("bad auth secret");
  if (plaintext.length > RECORD_SIZE - 86 - 17) throw new Error("payload too large");

  let local = opts.localKey;
  if (!local) {
    const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    local = { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle().exportKey("raw", pair.publicKey)) };
  }
  const salt = opts.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");

  const uaKey = await subtle().importKey("raw", ab(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: uaKey } as EcdhKeyDeriveParams, local.privateKey, 256));
  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" 0x00 ua_public as_public, 32)
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, local.publicKey);
  const ikm = await hkdf(auth, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await subtle().importKey("raw", ab(cek), "AES-GCM", false, ["encrypt"]);
  // the last (only) record ends with the 0x02 delimiter
  const record = concat(plaintext, new Uint8Array([2]));
  const cipher = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: ab(nonce), tagLength: 128 }, aes, ab(record)));

  const header = new Uint8Array(16 + 4 + 1 + local.publicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = local.publicKey.length;
  header.set(local.publicKey, 21);
  return concat(header, cipher);
}

/* ---------------------------- messages ---------------------------- */

const oneLine = (s: unknown, max: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};
/** A same-origin path, or "/" for anything else (no scheme, no //host). */
export function safePushPath(url: string): string {
  const u = String(url ?? "");
  return u.startsWith("/") && !u.startsWith("//") && !u.startsWith("/\\") && !/[\s\0]/.test(u) ? u.slice(0, 500) : "/";
}

/** The JSON bytes for a message, trimmed (body first, then title) to MAX_PAYLOAD_BYTES. */
export function encodePushMessage(m: PushMessage): Uint8Array {
  let title = oneLine(m.title, 120) || "Kanbo";
  let body = oneLine(m.body, 300);
  const pack = () => {
    const o: Record<string, string> = { title, body, url: safePushPath(m.url) };
    if (m.tag) o.tag = oneLine(m.tag, 120);
    if (m.kind) o.kind = m.kind;
    return enc.encode(JSON.stringify(o));
  };
  let out = pack();
  while (out.length > MAX_PAYLOAD_BYTES && body.length > 1) { body = oneLine(body, Math.floor(body.length * 0.8)); out = pack(); }
  while (out.length > MAX_PAYLOAD_BYTES && title.length > 1) { title = oneLine(title, Math.floor(title.length * 0.8)); out = pack(); }
  return out;
}

/** assigned / mention / comment: who did it, on which task, a link to it. */
export function taskEventPush(kind: "assigned" | "mention" | "comment", actorName: string, taskTitle: string, taskId: string): PushMessage {
  const who = oneLine(actorName, 60) || "Someone";
  const title = kind === "assigned" ? `${who} assigned you a task` : kind === "mention" ? `${who} mentioned you` : `${who} commented`;
  return { title, body: oneLine(taskTitle, 200) || "A task", url: `/?task=${encodeURIComponent(taskId)}`, tag: `task-${taskId}`, kind };
}

/** The morning nudge: what's due today and what's overdue (oldest first). */
export function dueDigestPush(tasks: { title: string | null; due_date: string }[], today: string): PushMessage {
  const sorted = [...tasks].sort((a, b) => a.due_date.localeCompare(b.due_date));
  const overdue = sorted.filter((t) => t.due_date < today).length;
  const dueToday = sorted.length - overdue;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const title = overdue && dueToday ? `${dueToday} due today, ${overdue} overdue`
    : overdue ? `${plural(overdue, "task")} overdue`
    : `${plural(dueToday, "task")} due today`;
  const names = sorted.slice(0, 3).map((t) => oneLine(t.title || "Untitled task", 60));
  const more = sorted.length > 3 ? ` and ${sorted.length - 3} more` : "";
  return { title, body: names.join(" · ") + more, url: "/today", tag: `due-${today}`, kind: "due" };
}

/** Settings › Notifications › Send a test notification. */
export const TEST_PUSH: PushMessage = {
  title: "Notifications are on",
  body: "This is how Kanbo will let you know when something needs you.",
  url: "/today",
  tag: "kanbo-test",
  kind: "test",
};

/* ------------------------------ sending ------------------------------ */

/** POST one encrypted message to one subscription. Never throws. */
export async function sendWebPush(sub: PushSubscriptionKeys, message: PushMessage, vapid: VapidKeys, opts: SendOptions = {}): Promise<SendResult> {
  if (!isAllowedPushEndpoint(sub.endpoint)) return { ok: false, status: 0, gone: true, skipped: "host" };
  let body: Uint8Array;
  try {
    body = await encryptPayload(encodePushMessage(message), sub.p256dh, sub.auth);
  } catch (e) {
    // unusable keys: this subscription can never be delivered to
    return { ok: false, status: 0, gone: true, skipped: "keys", error: String((e as Error)?.message ?? e) };
  }
  const doFetch = opts.fetch ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(sub.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: ctl.signal,
      headers: {
        Authorization: await vapidAuthHeader(sub.endpoint, vapid, { now: opts.now }),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(Math.max(0, Math.floor(opts.ttl ?? 86_400))),
        Urgency: opts.urgency ?? "normal",
      },
      body: ab(body),
    });
    const status = res.status;
    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch { /* drained */ }
    const ok = status >= 200 && status < 300;
    if (!ok && status !== 404 && status !== 410) console.warn(`[webpush] ${new URL(sub.endpoint).hostname} answered ${status} ${detail}`);
    return { ok, status, gone: status === 404 || status === 410, ...(ok ? {} : { error: detail || `HTTP ${status}` }) };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

export interface PushRunResult {
  /** subscriptions found for the person */
  total: number;
  /** delivered to the push service */
  sent: number;
  /** not delivered this time (kept) */
  failed: number;
  /** deleted: gone (404/410), unusable keys or not a push service */
  pruned: number;
  /** true when `allow` said no (already pushed about this) */
  skipped?: boolean;
}

/* ---------- notify's guard rails for event pushes ---------- */

/** How recent an event must be for notify to push about it (the app calls
 *  notify straight after the save), and how long one event is remembered. */
export const PUSH_EVENT_WINDOW_SEC = 600;

/** A task_events row (0038; written only by the database's own trigger). */
export interface AssigneeEvent { id: string; actor_id: string | null; new_value: string | null; created_at: string }

/**
 * Proof that `actorId` really did just give this task to its current
 * assignee, so an "assigned" push can't be fired at will by naming people:
 * a task_events row from the last 10 minutes (the trigger records who changed
 * the assignee; clients can't write it), or the actor created the task,
 * already assigned, in the last 10 minutes. Returns a key naming that event
 * (notify pushes once per recipient per event), or null: no push.
 */
export function assignmentEventKey(
  task: { id: string; user_id: string | null; assignee_id: string | null; created_at?: string | null },
  events: readonly AssigneeEvent[],
  actorId: string,
  now = Date.now(),
): string | null {
  const assignee = String(task.assignee_id ?? "");
  if (!assignee || assignee === actorId) return null;
  const fresh = (iso: string | null | undefined) => {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) && t <= now + 60_000 && now - t <= PUSH_EVENT_WINDOW_SEC * 1000;
  };
  const ev = events
    .filter((e) => e.actor_id === actorId && e.new_value === assignee && fresh(e.created_at))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (ev) return `ev:${ev.id}`;
  if (task.user_id === actorId && fresh(task.created_at)) return `new:${task.id}`;
  return null;
}

/**
 * The rate_limits keys (with windows) an event push must get past for one
 * recipient: once per event (a replayed notify call alerts nobody again),
 * and at most once a minute per task and kind (a burst of real comments is
 * one alert). The caller adds its KEY_PREFIX.
 */
export function pushOnceKeys(recipientId: string, taskId: string, kind: string, eventKey: string): { key: string; windowSec: number }[] {
  return [
    { key: `push:${recipientId}:${eventKey}`, windowSec: PUSH_EVENT_WINDOW_SEC + 60 },
    { key: `push:${recipientId}:${taskId}:${kind}`, windowSec: 60 },
  ];
}

const isMissing = (err: unknown) => {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? err);
  return code === "42P01" || code === "PGRST205" || /does not exist|schema cache/i.test(msg);
};

/**
 * Push `message` to every device `userId` has switched on (or just the one
 * with `endpoint`), stamping last_ok_at on success and deleting rows that
 * can never work. Fails soft: without 0043 (or on a DB error) nothing is sent.
 */
export async function pushToUser(
  db: Db, userId: string, message: PushMessage, vapid: VapidKeys,
  opts: SendOptions & {
    endpoint?: string;
    /** asked once the person has at least one device, just before sending;
     *  false sends nothing (notify's per-recipient de-duplication) */
    allow?: () => Promise<boolean>;
  } = {},
): Promise<PushRunResult> {
  const out: PushRunResult = { total: 0, sent: 0, failed: 0, pruned: 0 };
  if (!(await vapidKeysMatch(vapid))) {
    warnOnce("pair", "VAPID_PRIVATE_KEY doesn't match VAPID_PUBLIC_KEY. Push is off until they're a pair.");
    return out;
  }
  let q = db.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id", userId);
  if (opts.endpoint) q = q.eq("endpoint", opts.endpoint);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(20);
  if (error) {
    if (isMissing(error)) warnOnce("missing", "push_subscriptions not found — run migration 0043. Push is off until then.");
    else console.warn("[webpush] couldn't read subscriptions:", String(error?.message ?? error));
    return out;
  }
  const subs = (data ?? []) as ({ id: string } & PushSubscriptionKeys)[];
  out.total = subs.length;
  if (!subs.length) return out;
  if (opts.allow) {
    let go = false;
    try { go = await opts.allow(); } catch { go = false; }
    if (!go) return { ...out, skipped: true };
  }
  const nowIso = new Date(opts.now ?? Date.now()).toISOString();
  await Promise.all(subs.map(async (s) => {
    const r = await sendWebPush(s, message, vapid, opts);
    if (r.ok) {
      out.sent++;
      await db.from("push_subscriptions").update({ last_ok_at: nowIso }).eq("id", s.id).then(() => {}, () => {});
    } else if (r.gone) {
      out.pruned++;
      await db.from("push_subscriptions").delete().eq("id", s.id).then(() => {}, () => {});
    } else {
      out.failed++;
    }
  }));
  return out;
}

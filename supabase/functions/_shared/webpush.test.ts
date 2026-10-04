// @vitest-environment node
// Web Push helpers: RFC 8291's own test vector for the encryption, an
// independent decrypt with node:crypto (the browser's side), the VAPID JWT
// checked with node:crypto, the endpoint allowlist, and the send/prune loop
// against an in-memory stand-in for supabase-js.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecipheriv, createECDH, createPublicKey, generateKeyPairSync, hkdfSync, verify as nodeVerify } from "node:crypto";
import {
  b64urlDecode, b64urlEncode, dueDigestPush, encodePushMessage, encryptPayload, importEcdhKeyPair, isAllowedPushEndpoint,
  MAX_PAYLOAD_BYTES, pushToUser, safePushPath, sendWebPush, taskEventPush, TEST_PUSH, vapidAuthHeader, vapidFromEnv,
  vapidKeysMatch, VAPID_MAX_TTL_SEC, type PushMessage, type VapidKeys,
} from "./webpush.ts";

const B = (s: string) => Buffer.from(b64urlDecode(s));

/** A throwaway P-256 pair as base64url (raw public point, private scalar). Never printed. */
function p256Pair() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return { publicKey: pub.toString("base64url"), privateKey: jwk.d };
}
function vapidKeys(): VapidKeys {
  return { ...p256Pair(), subject: "mailto:ops@kanbo.test" };
}

/** The browser's side of RFC 8291, written with node:crypto (not the module under test). */
function decrypt(body: Buffer, uaPrivate: string, uaPublic: string, authSecret: string): string {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  expect(rs).toBe(4096);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(B(uaPrivate));
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), B(uaPublic), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, B(authSecret), keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter, no padding
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

describe("base64url", () => {
  it("round-trips bytes and accepts padded / plain base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const s = b64urlEncode(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect([...b64urlDecode(s)]).toEqual([...bytes]);
    expect([...b64urlDecode(Buffer.from(bytes).toString("base64"))]).toEqual([...bytes]);
    expect(() => b64urlDecode("not base64!")).toThrow();
  });
});

describe("RFC 8291 aes128gcm (Appendix A test vector)", () => {
  const V = {
    plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
    asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
    uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
    salt: "DGv6ra1nlYgDCS1FRnbzlw",
    // Section 5's body, as printed (three lines joined)
    body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
      "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
      "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  };

  it("produces the RFC's exact body from its keys and salt", async () => {
    const localKey = await importEcdhKeyPair(V.asPublic, V.asPrivate);
    const body = await encryptPayload(b64urlDecode(V.plaintext), V.uaPublic, V.auth, { salt: b64urlDecode(V.salt), localKey });
    expect(b64urlEncode(body)).toBe(V.body);
  });

  it("the RFC body decrypts (independently, with node:crypto) to its plaintext", () => {
    expect(decrypt(B(V.body), V.uaPrivate, V.uaPublic, V.auth)).toBe("When I grow up, I want to be a watermelon");
  });

  it("fresh keys and salt: a browser can read what we send, and no two bodies match", async () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const uaPublic = ua.getPublicKey().toString("base64url");
    const uaPrivate = ua.getPrivateKey().toString("base64url");
    const auth = Buffer.from("0123456789abcdef").toString("base64url");
    const msg = encodePushMessage({ title: "Ana assigned you a task", body: "Write the brief · café ✓", url: "/?task=abc" });
    const a = Buffer.from(await encryptPayload(msg, uaPublic, auth));
    const b = Buffer.from(await encryptPayload(msg, uaPublic, auth));
    expect(a.equals(b)).toBe(false);
    expect(JSON.parse(decrypt(a, uaPrivate, uaPublic, auth))).toEqual({ title: "Ana assigned you a task", body: "Write the brief · café ✓", url: "/?task=abc" });
    expect(JSON.parse(decrypt(b, uaPrivate, uaPublic, auth)).title).toBe("Ana assigned you a task");
  });

  it("refuses unusable subscription keys and oversize payloads", async () => {
    await expect(encryptPayload(new Uint8Array(4), "AAAA", V.auth)).rejects.toThrow();
    await expect(encryptPayload(new Uint8Array(4), V.uaPublic, "AAAA")).rejects.toThrow();
    await expect(encryptPayload(new Uint8Array(4000), V.uaPublic, V.auth)).rejects.toThrow(/too large/);
  });
});

describe("VAPID", () => {
  it("signs an ES256 JWT for the push service's origin that its public key verifies", async () => {
    const v = vapidKeys();
    const now = Date.UTC(2026, 9, 4, 9, 0, 0);
    const header = await vapidAuthHeader("https://fcm.googleapis.com/fcm/send/abc:def", v, { now });
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m!;
    expect(k).toBe(v.publicKey);
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:ops@kanbo.test");
    expect(claims.exp).toBe(now / 1000 + 3600);
    const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: B(v.publicKey).subarray(1, 33).toString("base64url"), y: B(v.publicKey).subarray(33).toString("base64url") }, format: "jwk" });
    const sig = Buffer.from(s, "base64url");
    expect(sig.length).toBe(64); // JOSE r||s, not DER
    expect(nodeVerify("sha256", Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });

  it("never lets a token live longer than 12 hours", async () => {
    const v = vapidKeys();
    const now = Date.UTC(2026, 9, 4);
    const header = await vapidAuthHeader("https://web.push.apple.com/QGx", v, { now, ttlSec: 7 * 86400 });
    const claims = JSON.parse(Buffer.from(header.split(".")[1], "base64url").toString());
    expect(claims.aud).toBe("https://web.push.apple.com");
    expect(claims.exp - now / 1000).toBe(VAPID_MAX_TTL_SEC);
  });

  it("reads the secrets: missing → null (quietly), malformed → null, subject falls back to APP_URL", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const v = vapidKeys();
    const env = (o: Record<string, string>) => (k: string) => o[k];
    expect(vapidFromEnv(env({}))).toBeNull();
    expect(vapidFromEnv(env({ VAPID_PUBLIC_KEY: v.publicKey }))).toBeNull();
    expect(vapidFromEnv(env({ VAPID_PUBLIC_KEY: "short", VAPID_PRIVATE_KEY: v.privateKey, VAPID_SUBJECT: "mailto:a@b.co" }))).toBeNull();
    expect(vapidFromEnv(env({ VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: "AAAA", VAPID_SUBJECT: "mailto:a@b.co" }))).toBeNull();
    expect(vapidFromEnv(env({ VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey }))).toBeNull(); // no subject, no https APP_URL
    expect(vapidFromEnv(env({ VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, VAPID_SUBJECT: "ops@kanbo.test" }))).toBeNull();
    expect(vapidFromEnv(env({ VAPID_PUBLIC_KEY: ` ${v.publicKey} `, VAPID_PRIVATE_KEY: v.privateKey, VAPID_SUBJECT: "mailto:ops@kanbo.test" })))
      .toEqual({ publicKey: v.publicKey, privateKey: v.privateKey, subject: "mailto:ops@kanbo.test" });
    expect(vapidFromEnv(env({ VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, APP_URL: "https://www.kanbo.co.uk/" }))?.subject)
      .toBe("https://www.kanbo.co.uk");
    warn.mockRestore();
  });

  it("tells a matching pair from a mismatched one", async () => {
    const a = vapidKeys(), b = vapidKeys();
    expect(await vapidKeysMatch(a)).toBe(true);
    expect(await vapidKeysMatch({ ...a, privateKey: b.privateKey })).toBe(false);
  });
});

describe("endpoint allowlist", () => {
  it("accepts the real push services", () => {
    for (const u of [
      "https://fcm.googleapis.com/fcm/send/eXyZ:APA91b",
      "https://fcm.googleapis.com/wp/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGxkX2RhdGE",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
      "https://fcm.googleapis.com:443/fcm/send/x",
    ]) expect(isAllowedPushEndpoint(u)).toBe(true);
  });
  it("refuses anything else (SSRF shapes)", () => {
    for (const u of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.io/x",
      "https://evil.io/fcm.googleapis.com",
      "https://push.apple.com/x",
      "https://evilpush.apple.com/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://localhost/x",
      "https://169.254.169.254/latest",
      "javascript:alert(1)",
      "https://fcm.googleapis.com/" + "a".repeat(1000),
      "",
    ]) expect(isAllowedPushEndpoint(u)).toBe(false);
  });
});

describe("messages", () => {
  it("keeps links same-origin", () => {
    expect(safePushPath("/?task=1")).toBe("/?task=1");
    for (const u of ["https://evil.io", "//evil.io/x", "/\\evil.io", "javascript:alert(1)", "/a b", ""]) expect(safePushPath(u)).toBe("/");
  });

  it("caps the payload at 3 KB, trimming the body before the title", () => {
    const m: PushMessage = { title: "T".repeat(500), body: "é".repeat(5000), url: "/today", tag: "x" };
    const bytes = encodePushMessage(m);
    expect(bytes.length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const o = JSON.parse(new TextDecoder().decode(bytes));
    expect(o.title.length).toBeLessThanOrEqual(120);
    expect(o.body.endsWith("…")).toBe(true);
    expect(o.url).toBe("/today");
    expect(o.tag).toBe("x");
  });

  it("task events name who did what, and link to the task", () => {
    expect(taskEventPush("assigned", "Ana Lima", "Write the brief", "t-1")).toEqual({
      title: "Ana Lima assigned you a task", body: "Write the brief", url: "/?task=t-1", tag: "task-t-1", kind: "assigned",
    });
    expect(taskEventPush("mention", "", "  ", "t 2")).toMatchObject({ title: "Someone mentioned you", body: "A task", url: "/?task=t%202" });
    expect(taskEventPush("comment", "Ben", "Fix\nthe\tform", "t-3").title).toBe("Ben commented");
    expect(taskEventPush("comment", "Ben", "Fix\nthe\tform", "t-3").body).toBe("Fix the form");
  });

  it("the due digest leads with the count, oldest first, three names at most", () => {
    const today = "2026-10-05";
    expect(dueDigestPush([{ title: "A", due_date: today }], today)).toMatchObject({ title: "1 task due today", body: "A", url: "/today", tag: "due-2026-10-05", kind: "due" });
    expect(dueDigestPush([{ title: "A", due_date: "2026-10-01" }, { title: "B", due_date: "2026-10-02" }], today).title).toBe("2 tasks overdue");
    const mixed = dueDigestPush([
      { title: "Today 1", due_date: today }, { title: "Old", due_date: "2026-09-01" }, { title: null, due_date: today }, { title: "Today 3", due_date: today },
    ], today);
    expect(mixed.title).toBe("3 due today, 1 overdue");
    expect(mixed.body).toBe("Old · Today 1 · Untitled task and 1 more");
  });

  it("the test push says what it is", () => {
    expect(TEST_PUSH.kind).toBe("test");
    expect(TEST_PUSH.title).not.toMatch(/!/);
  });
});

/* ---------- sending + the subscription table (in-memory supabase-js stand-in) ---------- */

type Row = Record<string, unknown>;
class FakeDb {
  rows: Row[] = [];
  missing = false;
  log: string[] = [];
  from(t: string) { return new Q(this, t); }
}
class Q implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: "select" | "update" | "delete" = "select";
  private f: ((r: Row) => boolean)[] = [];
  private patch: Row = {};
  constructor(private db: FakeDb, private t: string) {}
  select() { return this; }
  update(p: Row) { this.op = "update"; this.patch = p; return this; }
  delete() { this.op = "delete"; return this; }
  eq(k: string, v: unknown) { this.f.push((r) => r[k] === v); return this; }
  order() { return this; }
  limit() { return this; }
  then<A, B>(ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(ok, bad);
  }
  private run() {
    if (this.db.missing) return { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.push_subscriptions' in the schema cache" } };
    const hit = this.db.rows.filter((r) => this.f.every((fn) => fn(r)));
    this.db.log.push(`${this.op} ${this.t} ${hit.map((r) => r.id).join(",")}`);
    if (this.op === "update") hit.forEach((r) => Object.assign(r, this.patch));
    if (this.op === "delete") this.db.rows = this.db.rows.filter((r) => !hit.includes(r));
    return { data: hit.map((r) => ({ ...r })), error: null };
  }
}

function browserSub(endpoint: string) {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return { endpoint, p256dh: ua.getPublicKey().toString("base64url"), auth: Buffer.from("fedcba9876543210").toString("base64url"), uaPrivate: ua.getPrivateKey().toString("base64url") };
}

describe("sendWebPush", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs the encrypted message with the VAPID and aes128gcm headers, no redirects", async () => {
    const v = vapidKeys();
    const sub = browserSub("https://fcm.googleapis.com/fcm/send/abc");
    const fetch = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => new Response("", { status: 201 }));
    const r = await sendWebPush(sub, taskEventPush("assigned", "Ana", "Brief", "t1"), v, { fetch: fetch as unknown as typeof globalThis.fetch, ttl: 600, urgency: "high" });
    expect(r).toEqual({ ok: true, status: 201, gone: false });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(sub.endpoint);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    const h = init?.headers as Record<string, string>;
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(h.TTL).toBe("600");
    expect(h.Urgency).toBe("high");
    expect(h.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const plain = decrypt(Buffer.from(init?.body as ArrayBuffer), sub.uaPrivate, sub.p256dh, sub.auth);
    expect(JSON.parse(plain)).toMatchObject({ title: "Ana assigned you a task", body: "Brief", url: "/?task=t1", tag: "task-t1" });
  });

  it("marks 404/410 as gone, other failures as retryable, and never contacts a non-push host", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const v = vapidKeys();
    const sub = browserSub("https://updates.push.services.mozilla.com/wpush/v2/x");
    const status = (s: number) => vi.fn(async () => new Response("nope", { status: s })) as unknown as typeof fetch;
    expect(await sendWebPush(sub, TEST_PUSH, v, { fetch: status(410) })).toMatchObject({ ok: false, status: 410, gone: true });
    expect(await sendWebPush(sub, TEST_PUSH, v, { fetch: status(404) })).toMatchObject({ ok: false, status: 404, gone: true });
    expect(await sendWebPush(sub, TEST_PUSH, v, { fetch: status(429) })).toMatchObject({ ok: false, status: 429, gone: false });
    const offline = vi.fn(async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;
    expect(await sendWebPush(sub, TEST_PUSH, v, { fetch: offline })).toMatchObject({ ok: false, status: 0, gone: false });
    const never = vi.fn();
    expect(await sendWebPush({ ...sub, endpoint: "https://evil.io/x" }, TEST_PUSH, v, { fetch: never as unknown as typeof fetch }))
      .toMatchObject({ ok: false, gone: true, skipped: "host" });
    expect(await sendWebPush({ ...sub, p256dh: "AAAA" }, TEST_PUSH, v, { fetch: never as unknown as typeof fetch }))
      .toMatchObject({ ok: false, gone: true, skipped: "keys" });
    expect(never).not.toHaveBeenCalled();
  });
});

describe("pushToUser", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends to each device, stamps last_ok_at, prunes gone and non-push endpoints, leaves others alone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const v = vapidKeys();
    const db = new FakeDb();
    const ok = browserSub("https://fcm.googleapis.com/fcm/send/ok");
    const gone = browserSub("https://updates.push.services.mozilla.com/wpush/v2/gone");
    const busy = browserSub("https://web.push.apple.com/busy");
    const evil = browserSub("https://evil.io/x");
    db.rows = [
      { id: "1", user_id: "u1", ...ok }, { id: "2", user_id: "u1", ...gone }, { id: "3", user_id: "u1", ...busy },
      { id: "4", user_id: "u1", ...evil }, { id: "5", user_id: "u2", ...browserSub("https://fcm.googleapis.com/fcm/send/other") },
    ];
    const fetch = vi.fn(async (u: string | URL | Request) => {
      const s = String(u);
      return new Response("", { status: s.endsWith("/ok") ? 201 : s.endsWith("/gone") ? 410 : 503 });
    }) as unknown as typeof globalThis.fetch;
    const now = Date.UTC(2026, 9, 4, 8, 0);
    const r = await pushToUser(db, "u1", TEST_PUSH, v, { fetch, now });
    expect(r).toEqual({ total: 4, sent: 1, failed: 1, pruned: 2 });
    expect(db.rows.map((x) => x.id).sort()).toEqual(["1", "3", "5"]);
    expect(db.rows.find((x) => x.id === "1")?.last_ok_at).toBe(new Date(now).toISOString());
    expect(db.rows.find((x) => x.id === "3")?.last_ok_at).toBeUndefined();
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))).not.toContain("https://evil.io/x");
  });

  it("can target one device (the test notification)", async () => {
    const v = vapidKeys();
    const db = new FakeDb();
    db.rows = [
      { id: "1", user_id: "u1", ...browserSub("https://fcm.googleapis.com/fcm/send/a") },
      { id: "2", user_id: "u1", ...browserSub("https://fcm.googleapis.com/fcm/send/b") },
    ];
    const fetch = vi.fn(async () => new Response("", { status: 201 })) as unknown as typeof globalThis.fetch;
    const r = await pushToUser(db, "u1", TEST_PUSH, v, { fetch, endpoint: "https://fcm.googleapis.com/fcm/send/b" });
    expect(r).toEqual({ total: 1, sent: 1, failed: 0, pruned: 0 });
  });

  it("sends nothing before 0043, or when the VAPID keys aren't a pair", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const v = vapidKeys();
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const missing = new FakeDb();
    missing.missing = true;
    expect(await pushToUser(missing, "u1", TEST_PUSH, v, { fetch })).toEqual({ total: 0, sent: 0, failed: 0, pruned: 0 });
    const db = new FakeDb();
    db.rows = [{ id: "1", user_id: "u1", ...browserSub("https://fcm.googleapis.com/fcm/send/a") }];
    expect(await pushToUser(db, "u1", TEST_PUSH, { ...v, privateKey: vapidKeys().privateKey }, { fetch })).toEqual({ total: 0, sent: 0, failed: 0, pruned: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });
});

// ============================================================
// KANBO — webhook delivery engine (0046).                                  [a2]
//
// Pure module (no Deno globals): the webhook-dispatch edge function hands in
// the privileged connection, a DNS resolver and a network API, and vitest
// hands in fakes (webhookDispatch.test.ts). The loop:
//
//   1. webhook_claim_outbox(500)        fan new events out to the endpoints
//                                        listening (SKIP LOCKED, marks them processed)
//   2. webhook_claim_deliveries(n, 90)  lease what's due, n = senders free right
//                                        now (attempt already +1, url + secret
//                                        included). The database hands out fair
//                                        shares: at most 2 in flight per endpoint,
//                                        4 per person and 4 per workspace, least
//                                        busy first — so one tenant's slow or
//                                        flooded endpoints only ever slow down
//                                        themselves.
//   3. per delivery (5 senders; each claims more as soon as it's free):
//        • the endpoint's viewer (who set its address, else its creator) must
//          still have access (else it's switched off)
//        • serialiseEvent → the same JSON as the REST API, ≤ 256 KB (long
//          descriptions trimmed first, "truncated": true); custom tag labels
//          come only from the endpoint's own workspace (or, for a personal
//          endpoint, its creator's own tags)
//        • the URL rule again, never our own Supabase host, DNS (A + AAAA):
//          EVERY address must be public (isPublicAddress)
//        • POST over HTTPS to one of THOSE addresses (TLS still checks the
//          hostname), 10 s timeout, redirects not followed, signed:
//            Kanbo-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>
//   4. webhook_record_result(id, status|0, error, ms)  → delivered, or retry
//      after 1m, 5m, 30m, 2h, 6h; 20 failures in a row switch the endpoint
//      off and tell its creator in their Inbox (all in SQL).
//   …until nothing is due that this run may take, or ~40 s have passed.
//
// Never logged: secrets, signatures, full URLs (host only), payloads.
// ============================================================
import { serialiseEvent, type OutboxEvent, type WebhookEnvelope } from "./serialise.ts";
import type { Tx } from "./types.ts";
import {
  DELIVERY_TIMEOUT_MS, isPublicAddress, isWebhookUrlShapeOk, MAX_PAYLOAD_BYTES, signatureHeader, WEBHOOK_HEADERS, WEBHOOK_USER_AGENT,
} from "./webhooks.ts";

/** A row of public.webhook_claim_deliveries(). */
export interface ClaimedDelivery {
  delivery_id: string;
  attempt: number;
  event: string;
  outbox_id: number | string;
  workspace_id: string | null;
  occurred_at: unknown;
  payload: Record<string, unknown> | null;
  webhook_id: string;
  url: string;
  secret: string;
}

/** The SQL the dispatcher runs on the privileged connection (replayed in the PGlite harness). */
export const DISPATCH_SQL = {
  claimOutbox: "select public.webhook_claim_outbox($1::int) as n",
  claimDeliveries: "select * from public.webhook_claim_deliveries($1::int, $2::int)",
  record: "select public.webhook_record_result($1::uuid, $2::int, $3::text, $4::int) as r",
  /**
   * Custom tag labels, looked up for each endpoint's own scope only ($1 = jsonb
   * [{key, ws, uid, ids}], ws/uid = the endpoint's workspace and creator): a team
   * endpoint gets that workspace's tags (while its creator is an owner, admin or
   * member there), a personal endpoint its creator's own personal tags. Any
   * other id in a task's tags (another workspace's, someone's personal tag)
   * stays unlabelled — this runs on the privileged connection, so it must never
   * reveal a tag the endpoint's creator couldn't read.
   */
  tags:
    "select s.key, t.id::text as id, t.label, t.color " +
    "from jsonb_to_recordset($1::jsonb) as s(key text, ws uuid, uid uuid, ids jsonb) " +
    "cross join lateral (select distinct e::uuid as id from jsonb_array_elements_text(s.ids) e " +
    "where e ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') i " +
    "join public.tags t on t.id = i.id " +
    "where (s.ws is not null and t.workspace_id = s.ws and public.user_ws_role(s.uid, s.ws) in ('owner', 'admin', 'member')) " +
    "or (s.ws is null and t.workspace_id is null and t.user_id = s.uid and public.user_can_act(s.uid))",
  /**
   * May each endpoint's viewer still see what it sends? and whose / which workspace's is it? ($1 =
   * jsonb array of webhook ids). The viewer is whoever last set its address (0058's url_set_by), else
   * who added it: read through to_jsonb, so this runs before 0058 too (no such column: the creator).
   */
  creators:
    "select w.id::text as id, v.uid::text as viewer, w.workspace_id::text as workspace_id, " +
    "case when w.workspace_id is null then public.user_can_act(v.uid) " +
    "else public.user_ws_role(v.uid, w.workspace_id) in ('owner', 'admin', 'member') end as allowed " +
    "from public.webhooks w cross join lateral (select coalesce((to_jsonb(w) ->> 'url_set_by')::uuid, w.created_by) as uid) v " +
    "where w.id::text = any (array(select jsonb_array_elements_text($1::jsonb)))",
  /** switch an endpoint off because its creator lost access, and give up on its queue */
  switchOff:
    "with off as (update public.webhooks set active = false, disabled_at = now(), disabled_reason = $2::text, " +
    "updated_at = now() where id = $1::uuid and active returning id) " +
    "update public.webhook_deliveries d set state = 'failed', error = $3::text, next_attempt_at = null, lease_until = null, " +
    "updated_at = now() where d.webhook_id = $1::uuid and d.state = 'pending'",
} as const;

/** (0058's pa_webhooks_viewer_gone writes the same two, word for word) */
export const CREATOR_GONE_REASON = "Switched off: the person who set its address no longer has access";
export const CREATOR_GONE_ERROR = "Not sent: the person who set this endpoint's address no longer has access, so it was switched off.";

/** The app's built-in tags (src/data/data.ts BUILTIN_TAGS; a test keeps them equal). Custom tags come from public.tags. */
export const BUILTIN_TAG_LABELS: Readonly<Record<string, { label: string; color: string }>> = {
  design: { label: "Design", color: "oklch(0.74 0.16 305)" },
  eng: { label: "Engineering", color: "oklch(0.74 0.14 230)" },
  research: { label: "Research", color: "oklch(0.75 0.13 155)" },
  writing: { label: "Writing", color: "oklch(0.78 0.15 70)" },
  ops: { label: "Ops", color: "oklch(0.7 0.02 240)" },
  bug: { label: "Bug", color: "oklch(0.66 0.2 20)" },
};

const enc = new TextEncoder();
const byteLength = (s: string) => enc.encode(s).length;
/** Control characters out, one line, at most `max` characters (for errors people read). */
const clean = (s: string, max = 160) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/* ------------------------------------------------------------ payload */

/**
 * The POST body for an envelope, at most `max` bytes. Too big: the longest
 * free text (a task or project description, a comment body) is trimmed
 * until it fits and the envelope says "truncated": true; if that still isn't
 * enough, data shrinks to {object, id, url} (fetch the rest from the API).
 */
export function fitPayload(env: WebhookEnvelope, max = MAX_PAYLOAD_BYTES): { body: string; truncated: boolean } {
  const first = JSON.stringify(env);
  if (byteLength(first) <= max) return { body: first, truncated: false };
  const data = { ...(env.data as Record<string, unknown>) };
  const textKeys = ["description", "body", "title", "name"].filter((k) => typeof data[k] === "string");
  let out: WebhookEnvelope & { truncated?: boolean } = { ...env, data, truncated: true };
  for (let round = 0; round < 8; round++) {
    const body = JSON.stringify(out);
    const over = byteLength(body) - max;
    if (over <= 0) return { body, truncated: true };
    const key = textKeys.filter((k) => (data[k] as string).length > 0).sort((a, b) => (data[b] as string).length - (data[a] as string).length)[0];
    if (!key) break;
    const v = data[key] as string;
    // keep the share of the field's (JSON-escaped) bytes that fits, less a little room for the marker
    const fieldBytes = byteLength(JSON.stringify(v));
    const keep = Math.max(0, fieldBytes - over - 64) / fieldBytes;
    data[key] = v.slice(0, Math.floor(v.length * keep)) + "…";
    out = { ...out, data };
  }
  const d = env.data as Record<string, unknown>;
  const slim = { object: d?.object ?? null, id: d?.id ?? null, url: d?.url ?? null };
  const body = JSON.stringify({ id: env.id, type: env.type, createdAt: env.createdAt, workspaceId: env.workspaceId, data: slim, truncated: true });
  return { body, truncated: true };
}

/* ------------------------------------------------------------ destination (SSRF) */

/** Looks a host up: every A and AAAA address ([] when it has none). Throws when it can't tell. */
export type Resolver = (host: string) => Promise<string[]>;

export type Destination =
  | { ok: true; url: string; host: string; port: number; path: string; addresses: string[] }
  | { ok: false; error: string };

/**
 * May Kanbo send to this URL now? The database's URL rule again, never our
 * own hosts, and every address the host resolves to must be public. The
 * addresses come back IPv4 first: the sender connects to exactly these.
 */
export async function checkDestination(url: string, resolve: Resolver, blockedHosts: readonly string[] = []): Promise<Destination> {
  if (!isWebhookUrlShapeOk(url)) return { ok: false, error: "Not sent: Kanbo only sends to public https:// addresses with a hostname." };
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, error: "Not sent: that address can't be read." }; }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const blocked = blockedHosts.map((h) => h.toLowerCase()).filter(Boolean);
  if (blocked.some((b) => host === b || host.endsWith("." + b))) {
    return { ok: false, error: "Not sent: Kanbo doesn't send webhooks to its own servers." };
  }
  let addresses: string[];
  try { addresses = await resolve(host); } catch { return { ok: false, error: `Couldn't look up ${host} (DNS). Kanbo will try again.` }; }
  const uniq = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))];
  if (!uniq.length) return { ok: false, error: `Couldn't find ${host}: it has no DNS address.` };
  if (uniq.some((a) => !isPublicAddress(a))) {
    return { ok: false, error: `Not sent: ${host} points to a private or reserved address, which Kanbo never calls.` };
  }
  const v4 = uniq.filter((a) => !a.includes(":")), v6 = uniq.filter((a) => a.includes(":"));
  return { ok: true, url, host, port: u.port ? Number(u.port) : 443, path: (u.pathname || "/") + u.search, addresses: [...v4, ...v6] };
}

/** One DNS-over-HTTPS answer (Cloudflare / Google JSON API) → addresses of that type. */
export function parseDohAnswer(json: unknown, type: "A" | "AAAA"): string[] | null {
  const r = json as { Status?: unknown; Answer?: unknown };
  if (!r || typeof r !== "object") return null;
  if (r.Status === 3) return [];            // NXDOMAIN
  if (r.Status !== 0) return null;          // SERVFAIL etc.: can't tell
  const want = type === "A" ? 1 : 28;
  return (Array.isArray(r.Answer) ? r.Answer : [])
    .filter((a: { type?: unknown; data?: unknown }) => a && a.type === want && typeof a.data === "string")
    .map((a: { data: string }) => a.data);
}

/** A resolver over DNS-over-HTTPS (for runtimes without Deno.resolveDns). */
export function dohResolver(fetchImpl: typeof fetch, servers: readonly string[] = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"], timeoutMs = 4000): Resolver {
  const one = async (host: string, type: "A" | "AAAA"): Promise<string[]> => {
    let lastErr: unknown = null;
    for (const base of servers) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const res = await fetchImpl(`${base}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: ac.signal });
          if (!res.ok) { lastErr = new Error(`DoH ${res.status}`); continue; }
          const got = parseDohAnswer(await res.json(), type);
          if (got) return got;
          lastErr = new Error("DoH could not answer");
        } finally { clearTimeout(t); }
      } catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error("DNS failed");
  };
  return async (host) => {
    const [a, aaaa] = await Promise.allSettled([one(host, "A"), one(host, "AAAA")]);
    if (a.status === "rejected" && aaaa.status === "rejected") throw a.reason;
    return [...(a.status === "fulfilled" ? a.value : []), ...(aaaa.status === "fulfilled" ? aaaa.value : [])];
  };
}

/**
 * The runtime's DNS when it has it (Deno.resolveDns, passed in), and DNS-over-HTTPS when it doesn't or
 * can't answer. [] only when the host really has no address; anything else that can't be told throws.
 */
export function systemResolver(dns: ((host: string, type: "A" | "AAAA") => Promise<unknown>) | null, fallback: Resolver): Resolver {
  return async (host) => {
    if (dns) {
      const [a, aaaa] = await Promise.allSettled([dns(host, "A"), dns(host, "AAAA")]);
      const got = [
        ...(a.status === "fulfilled" && Array.isArray(a.value) ? a.value : []),
        ...(aaaa.status === "fulfilled" && Array.isArray(aaaa.value) ? aaaa.value : []),
      ].filter((x): x is string => typeof x === "string");
      if (got.length) return got;
      const notFound = (r: PromiseSettledResult<unknown>) =>
        r.status === "rejected" && (r.reason?.name === "NotFound" || /not ?found|no (?:record|data)|nxdomain/i.test(String(r.reason?.message ?? "")));
      // one family answered empty / "no records" and the other likewise: the host really has no address
      if ((a.status === "fulfilled" || notFound(a)) && (aaaa.status === "fulfilled" || notFound(aaaa))) return [];
    }
    return fallback(host);
  };
}

/* ------------------------------------------------------------ sending */

/** The parts of a Deno connection the sender uses (Deno.TcpConn / Deno.TlsConn fit). */
export interface Conn {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}
/** Deno.connect + Deno.startTls (fakes in tests). */
export interface NetApi {
  connect(o: { hostname: string; port: number }): Promise<Conn>;
  startTls(conn: Conn, o: { hostname: string }): Promise<Conn>;
}

export interface SendTarget { url: string; host: string; port: number; path: string; address: string }
export interface SendResult { status: number; reason: string }
export type Sender = (target: SendTarget, headers: Record<string, string>, body: string, timeoutMs: number) => Promise<SendResult>;

/** A failure the endpoint should hear about in plain words (stored as the delivery's error). */
export class DeliveryError extends Error {
  /** connect = never reached the endpoint (another address may be tried); anything else may have reached it */
  constructor(message: string, readonly kind: "timeout" | "connect" | "tls" | "protocol" | "closed" | "network" = "network") { super(message); }
}

const HEAD_LIMIT = 32 * 1024;

/** The runtime itself can't open raw TCP / TLS (not the endpoint's fault): the caller falls back to fetch. */
export function isRuntimeUnsupported(e: unknown): boolean {
  const name = String((e as { name?: unknown })?.name ?? "");
  const m = String((e as { message?: unknown })?.message ?? "");
  return name === "NotSupported" || (e instanceof TypeError && /not a function|not supported|not implemented/i.test(m));
}

/**
 * POST over HTTP/1.1 + TLS to one exact IP address (the one checked), with
 * SNI and certificate checks for the hostname. Reads only the status line
 * (skipping 1xx), then hangs up. No redirects, no keep-alive, no proxies.
 */
export async function postPinned(net: NetApi, target: SendTarget, headers: Record<string, string>, body: string, timeoutMs = DELIVERY_TIMEOUT_MS): Promise<SendResult> {
  let conn: Conn | null = null;
  let done = false;
  const hangUp = () => { if (conn) { try { conn.close(); } catch { /* already closed */ } } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      hangUp();
      reject(new DeliveryError(`No answer within ${Math.round(timeoutMs / 1000)} seconds.`, "timeout"));
    }, timeoutMs);
  });
  const work = (async (): Promise<SendResult> => {
    let tcp: Conn;
    try { tcp = await net.connect({ hostname: target.address, port: target.port }); }
    catch (e) { if (isRuntimeUnsupported(e)) throw e; throw new DeliveryError(networkMessage(e, target.host), "connect"); }
    conn = tcp;
    if (done) { hangUp(); throw new DeliveryError("Timed out.", "timeout"); }
    let tls: Conn;
    try { tls = await net.startTls(tcp, { hostname: target.host }); }
    catch (e) { if (isRuntimeUnsupported(e)) throw e; throw new DeliveryError(tlsMessage(e, target.host), "tls"); }
    conn = tls;
    if (done) { hangUp(); throw new DeliveryError("Timed out.", "timeout"); }
    const bodyBytes = enc.encode(body);
    const lines = [
      `POST ${target.path || "/"} HTTP/1.1`,
      `Host: ${target.port === 443 ? target.host : `${target.host}:${target.port}`}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, " ")}`),
      `Content-Length: ${bodyBytes.length}`,
      "Connection: close",
      "", "",
    ];
    const head = enc.encode(lines.join("\r\n"));
    const all = new Uint8Array(head.length + bodyBytes.length);
    all.set(head, 0);
    all.set(bodyBytes, head.length);
    try {
      let off = 0;
      while (off < all.length) {
        const n = await tls.write(all.subarray(off));
        if (!n) throw new DeliveryError("The connection closed while sending.", "closed");
        off += n;
      }
      return await readStatus(tls);
    } catch (e) {
      throw e instanceof DeliveryError ? e : new DeliveryError(networkMessage(e, target.host), "network");
    }
  })();
  work.catch(() => { /* reported through the race */ });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    done = true;
    clearTimeout(timer);
    hangUp();
  }
}

/** Reads response heads until a final (non-1xx) status line. */
export async function readStatus(conn: Conn): Promise<SendResult> {
  const dec = new TextDecoder("latin1");
  let buf = "";
  const chunk = new Uint8Array(4096);
  for (;;) {
    const end = buf.indexOf("\r\n\r\n");
    if (end >= 0) {
      const statusLine = buf.slice(0, buf.indexOf("\r\n"));
      const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
      if (!m) throw new DeliveryError("The endpoint didn't answer with HTTP.", "protocol");
      const status = Number(m[1]);
      if (status >= 100 && status < 200 && status !== 101) { buf = buf.slice(end + 4); continue; }
      return { status, reason: clean(m[2] ?? "", 60) };
    }
    if (buf.length > HEAD_LIMIT) throw new DeliveryError("The endpoint's answer was too long to read.", "protocol");
    const n = await conn.read(chunk);
    if (n === null || n === 0) {
      throw new DeliveryError(buf ? "The endpoint closed the connection mid-answer." : "The endpoint closed the connection without answering.", "closed");
    }
    buf += dec.decode(chunk.subarray(0, n));
  }
}

/** A body sent in chunks, back to plain bytes; null while it isn't all here yet. */
function dechunk(b: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let at = 0;
  for (;;) {
    let eol = at;
    while (eol + 1 < b.length && !(b[eol] === 13 && b[eol + 1] === 10)) eol++;
    if (eol + 1 >= b.length) return null;
    const n = parseInt(new TextDecoder().decode(b.subarray(at, eol)).split(";")[0].trim(), 16);
    if (!Number.isFinite(n) || n < 0) throw new DeliveryError("The answer's chunks can't be read.", "protocol");
    if (n === 0) break;
    if (eol + 2 + n + 2 > b.length) return null;
    parts.push(b.subarray(eol + 2, eol + 2 + n));
    at = eol + 2 + n + 2;
  }
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * GET over HTTP/1.1 + TLS to one exact IP address (the one checked), with SNI and certificate checks for
 * the hostname, so a second DNS answer can't swap in a private address. No redirects, no keep-alive, no
 * proxies. Reads at most `maxBytes` of body: past that, `text` is null. Anything but a 200 has no text.
 */
export async function getPinned(net: NetApi, target: SendTarget, maxBytes: number, timeoutMs: number, userAgent = WEBHOOK_USER_AGENT): Promise<{ status: number; text: string | null }> {
  let conn: Conn | null = null;
  let done = false;
  const hangUp = () => { if (conn) { try { conn.close(); } catch { /* already closed */ } } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      hangUp();
      reject(new DeliveryError(`No answer within ${Math.round(timeoutMs / 1000)} seconds.`, "timeout"));
    }, timeoutMs);
  });
  const work = (async () => {
    let tcp: Conn;
    try { tcp = await net.connect({ hostname: target.address, port: target.port }); }
    catch (e) { if (isRuntimeUnsupported(e)) throw e; throw new DeliveryError(networkMessage(e, target.host), "connect"); }
    conn = tcp;
    if (done) { hangUp(); throw new DeliveryError("Timed out.", "timeout"); }
    let tls: Conn;
    try { tls = await net.startTls(tcp, { hostname: target.host }); }
    catch (e) { if (isRuntimeUnsupported(e)) throw e; throw new DeliveryError(tlsMessage(e, target.host), "tls"); }
    conn = tls;
    if (done) { hangUp(); throw new DeliveryError("Timed out.", "timeout"); }
    const request = enc.encode([
      `GET ${target.path || "/"} HTTP/1.1`,
      `Host: ${target.port === 443 ? target.host : `${target.host}:${target.port}`}`,
      "Accept: application/json",
      "Accept-Encoding: identity",
      `User-Agent: ${userAgent}`,
      "Connection: close",
      "", "",
    ].join("\r\n"));
    let off = 0;
    while (off < request.length) {
      const n = await tls.write(request.subarray(off));
      if (!n) throw new DeliveryError("The connection closed while sending.", "closed");
      off += n;
    }
    // room for the head and a chunked body's framing: past this the answer is too long, whatever it says
    const limit = HEAD_LIMIT + maxBytes * 2 + 1024;
    const chunk = new Uint8Array(4096);
    let buf = new Uint8Array(0);
    let status = 0, bodyAt = -1, length = -1, chunked = false;
    const parseHead = () => {
      const end = new TextDecoder("latin1").decode(buf.subarray(0, Math.min(buf.length, HEAD_LIMIT))).indexOf("\r\n\r\n");
      if (end < 0) { if (buf.length > HEAD_LIMIT) throw new DeliveryError("The answer's head was too long to read.", "protocol"); return; }
      const head = new TextDecoder("latin1").decode(buf.subarray(0, end));
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      if (!m) throw new DeliveryError("The endpoint didn't answer with HTTP.", "protocol");
      if (Number(m[1]) >= 100 && Number(m[1]) < 200) { buf = buf.subarray(end + 4); parseHead(); return; }
      status = Number(m[1]);
      bodyAt = end + 4;
      const cl = /\r\ncontent-length:[ \t]*(\d+)/i.exec(head);
      if (cl) length = Number(cl[1]);
      chunked = /\r\ntransfer-encoding:[^\r]*chunked/i.test(head);
    };
    const finished = (body: Uint8Array): Uint8Array | null => {
      if (chunked) return dechunk(body);
      return length >= 0 && body.length >= length ? body.subarray(0, length) : null;
    };
    for (;;) {
      if (bodyAt < 0) parseHead();
      if (bodyAt >= 0) {
        if (status !== 200) return { status, text: null };
        if (length > maxBytes) return { status, text: null };
        const whole = finished(buf.subarray(bodyAt));
        if (whole) return { status, text: whole.length > maxBytes ? null : new TextDecoder().decode(whole) };
      }
      if (buf.length > limit) return { status: status || 200, text: null };
      let n: number | null;
      try { n = await tls.read(chunk); }
      // some servers close without saying goodbye: with no length to wait for, what arrived is the answer
      catch (e) { if (bodyAt >= 0 && !chunked && length < 0) n = null; else throw new DeliveryError(networkMessage(e, target.host), "network"); }
      if (n === null || n === 0) {
        if (bodyAt < 0) throw new DeliveryError("The connection closed without an answer.", "closed");
        if (chunked || length >= 0) throw new DeliveryError("The connection closed mid-answer.", "closed");
        const body = buf.subarray(bodyAt);
        return { status, text: body.length > maxBytes ? null : new TextDecoder().decode(body) };
      }
      const next = new Uint8Array(buf.length + n);
      next.set(buf, 0);
      next.set(chunk.subarray(0, n), buf.length);
      buf = next;
    }
  })();
  work.catch(() => { /* reported through the race */ });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    done = true;
    clearTimeout(timer);
    hangUp();
  }
}

function tlsMessage(e: unknown, host: string): string {
  const m = String((e as { message?: unknown })?.message ?? "");
  if (/certificate|cert|issuer|expired|self.signed|unknown ?ca|NotValidForName|hostname/i.test(m)) return `The TLS certificate isn't valid for ${host}.`;
  return `Couldn't start a secure (TLS) connection with ${host}.`;
}

/** fetch-based sender for runtimes without Deno.startTls: same checks before, but the runtime resolves the host again. */
export function fetchSender(fetchImpl: typeof fetch): Sender {
  return async (target, headers, body, timeoutMs) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(target.url, { method: "POST", headers, body, redirect: "manual", signal: ac.signal });
      try { await res.body?.cancel(); } catch { /* nothing to read */ }
      return { status: res.status, reason: clean(res.statusText ?? "", 60) };
    } catch (e) {
      if (ac.signal.aborted) throw new DeliveryError(`No answer within ${Math.round(timeoutMs / 1000)} seconds.`, "timeout");
      // the runtime resolves and connects itself here: never retried on another address
      throw new DeliveryError(networkMessage(e, target.host), "network");
    } finally { clearTimeout(t); }
  };
}

/** A network error (Deno's error names) → a sentence without the URL. */
export function networkMessage(e: unknown, host: string): string {
  if (e instanceof DeliveryError) return e.message;
  const name = String((e as { name?: unknown })?.name ?? "");
  const m = String((e as { message?: unknown })?.message ?? "");
  if (name === "ConnectionRefused" || /refused/i.test(m)) return `${host} refused the connection.`;
  if (name === "ConnectionReset" || /reset/i.test(m)) return `${host} reset the connection.`;
  if (name === "TimedOut" || /timed? ?out/i.test(m)) return `No answer from ${host} in time.`;
  if (/certificate|tls|ssl/i.test(m)) return `The TLS certificate isn't valid for ${host}.`;
  if (/dns|lookup|resolve|not ?found/i.test(m)) return `Couldn't look up ${host} (DNS).`;
  return `Couldn't connect to ${host}.`;
}

/** What a finished attempt means for the delivery's record. */
export function describeResult(r: SendResult): { status: number; error: string | null } {
  if (r.status >= 200 && r.status < 300) return { status: r.status, error: null };
  if (r.status >= 300 && r.status < 400) {
    return { status: r.status, error: `Redirects aren't followed (HTTP ${r.status}). Use the final address.` };
  }
  return { status: r.status, error: clean(`HTTP ${r.status}${r.reason ? " " + r.reason : ""}`, 120) };
}

/* ------------------------------------------------------------ the loop */

export interface DispatchDeps {
  /** privileged connection (claims, results, tag labels, creator checks) */
  service: Tx;
  resolve: Resolver;
  send: Sender;
  /** APP_URL, for the url fields in payloads */
  appUrl?: string | null;
  /** hosts never called (our own Supabase project) */
  blockedHosts?: readonly string[];
  now?: () => number;
  log?: (line: string) => void;
}

export interface DispatchOptions {
  /** stop claiming new work after this long (ms) */
  deadlineMs?: number;
  /** most deliveries claimed at once (never more than there are free senders) */
  batch?: number;
  /** sent at once */
  concurrency?: number;
  leaseSeconds?: number;
  /** most claims in one run */
  maxRounds?: number;
  timeoutMs?: number;
}

export interface DispatchStats {
  queued: number;
  attempted: number;
  delivered: number;
  retrying: number;
  failed: number;
  disabled: number;
  skipped: number;
  /** claims made */
  rounds: number;
  ms: number;
}

const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return "endpoint"; } };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TagMap = Map<string, { label: string | null; color: string | null }>;
/** Whose an endpoint is: its workspace (null = personal) and the person who added it. */
interface HookScope { ws: string | null; uid: string }
const scopeKey = (s: HookScope) => (s.ws ? `ws:${s.ws}` : `me:${s.uid}`);
const builtinTags = (): TagMap => new Map(Object.entries(BUILTIN_TAG_LABELS));

/**
 * Tag ids in these deliveries' tasks → labels, per endpoint scope: the
 * built-ins, plus custom tags from that scope only (DISPATCH_SQL.tags). Returns
 * the map to use for each delivery.
 */
async function tagMaps(service: Tx, rows: readonly ClaimedDelivery[], scopes: ReadonlyMap<string, HookScope>): Promise<(row: ClaimedDelivery) => TagMap> {
  const groups = new Map<string, { key: string; ws: string | null; uid: string; ids: Set<string> }>();
  for (const r of rows) {
    const scope = scopes.get(String(r.webhook_id));
    const task = (r.payload as { task?: { tags?: unknown } } | null)?.task;
    if (!scope || !Array.isArray(task?.tags)) continue;
    const key = scopeKey(scope);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, ws: scope.ws, uid: scope.uid, ids: new Set() }));
    for (const t of task.tags) if (typeof t === "string" && UUID_RE.test(t)) g.ids.add(t);
  }
  const maps = new Map<string, TagMap>();
  const wanted = [...groups.values()].filter((g) => g.ids.size).map((g) => ({ key: g.key, ws: g.ws, uid: g.uid, ids: [...g.ids].slice(0, 2000) }));
  if (wanted.length) {
    try {
      const got = await service.query<{ key: string; id: string; label: string | null; color: string | null }>(DISPATCH_SQL.tags, [JSON.stringify(wanted)]);
      for (const g of got) {
        let m = maps.get(String(g.key));
        if (!m) maps.set(String(g.key), (m = builtinTags()));
        m.set(String(g.id), { label: g.label ?? null, color: g.color ?? null });
      }
    } catch { /* labels are a nicety: ids still go out */ }
  }
  const plain = builtinTags();
  return (row) => {
    const scope = scopes.get(String(row.webhook_id));
    return (scope && maps.get(scopeKey(scope))) || plain;
  };
}

/**
 * Each endpoint's scope, and the endpoints whose viewer (who set its address,
 * else who added it) can no longer see what they send (removed, made a guest,
 * suspended).
 */
async function checkCreators(service: Tx, rows: readonly ClaimedDelivery[]): Promise<{ gone: Set<string>; scopes: Map<string, HookScope> }> {
  const ids = [...new Set(rows.map((r) => String(r.webhook_id)))];
  const scopes = new Map<string, HookScope>();
  if (!ids.length) return { gone: new Set(), scopes };
  const got = await service.query<{ id: string; viewer: string | null; workspace_id: string | null; allowed: boolean | null }>(DISPATCH_SQL.creators, [JSON.stringify(ids)]);
  const allowed = new Set<string>();
  for (const g of got) {
    if (g.allowed !== true || !g.viewer) continue;
    allowed.add(String(g.id));
    scopes.set(String(g.id), { ws: g.workspace_id ? String(g.workspace_id) : null, uid: String(g.viewer) });
  }
  return { gone: new Set(ids.filter((id) => !allowed.has(id))), scopes };
}

/** Claim → send → record until nothing is due or the deadline passes. */
export async function runDispatch(deps: DispatchDeps, opts: DispatchOptions = {}): Promise<DispatchStats> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const deadline = opts.deadlineMs ?? 40_000;
  const batch = Math.max(1, opts.batch ?? 20);
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const lease = opts.leaseSeconds ?? 90;
  const maxRounds = opts.maxRounds ?? 500;
  const timeoutMs = opts.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  const start = now();
  const stats: DispatchStats = { queued: 0, attempted: 0, delivered: 0, retrying: 0, failed: 0, disabled: 0, skipped: 0, rounds: 0, ms: 0 };

  const record = async (row: ClaimedDelivery, status: number, error: string | null, ms: number | null) => {
    try {
      const got = await deps.service.query<{ r: { state?: string; disabled?: boolean } | null }>(DISPATCH_SQL.record, [row.delivery_id, status, error, ms]);
      const r = got[0]?.r ?? null;
      if (r?.state === "delivered") stats.delivered++;
      else if (r?.state === "pending") stats.retrying++;
      else if (r?.state === "failed") stats.failed++;
      if (r?.disabled) {
        stats.disabled++;
        log(`[webhooks] endpoint on ${hostOf(row.url)} switched off after repeated failures`);
      }
    } catch (e) {
      // the lease runs out and the delivery is claimed again
      log(`[webhooks] couldn't record a result for ${hostOf(row.url)}: ${clean(String((e as Error)?.message ?? e), 120)}`);
    }
  };

  const deliver = async (row: ClaimedDelivery, tags: TagMap) => {
    stats.attempted++;
    let env: WebhookEnvelope;
    try {
      env = serialiseEvent(row as unknown as OutboxEvent, { appUrl: deps.appUrl ?? null, tags });
    } catch {
      await record(row, 0, "Kanbo couldn't build this event.", null);
      return;
    }
    const { body } = fitPayload(env);
    const dest = await checkDestination(String(row.url ?? ""), deps.resolve, deps.blockedHosts ?? []);
    if (!dest.ok) {
      await record(row, 0, dest.error, null);
      log(`[webhooks] ${row.event} to ${hostOf(row.url)} not sent: ${dest.error}`);
      return;
    }
    const t = Math.floor(now() / 1000);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": WEBHOOK_USER_AGENT,
      [WEBHOOK_HEADERS.event]: String(row.event),
      [WEBHOOK_HEADERS.delivery]: String(row.delivery_id),
      [WEBHOOK_HEADERS.signature]: await signatureHeader(String(row.secret), body, t),
      "Kanbo-Attempt": String(row.attempt),
    };
    const started = now();
    let result: SendResult | null = null;
    let error = "";
    // the first address, then (if it couldn't even connect) one more
    for (const address of dest.addresses.slice(0, 2)) {
      try {
        result = await deps.send({ url: dest.url, host: dest.host, port: dest.port, path: dest.path, address }, headers, body, timeoutMs);
        break;
      } catch (e) {
        error = networkMessage(e, dest.host);
        // only a refused / unreachable connection moves on to the next address: anything later may have arrived
        if (!(e instanceof DeliveryError) || e.kind !== "connect") break;
      }
    }
    const ms = Math.max(0, Math.round(now() - started));
    if (!result) {
      await record(row, 0, error || `Couldn't connect to ${dest.host}.`, ms);
      log(`[webhooks] ${row.event} to ${dest.host}: no answer (${error}) in ${ms}ms`);
      return;
    }
    const d = describeResult(result);
    await record(row, d.status, d.error, ms);
    log(`[webhooks] ${row.event} to ${dest.host}: ${result.status} in ${ms}ms`);
  };

  // A pipeline rather than batches: a sender that's free claims more at once
  // (only as many as there are free senders, so nothing leased waits here),
  // and a slow endpoint holds up only the sender it's on. Fair shares across
  // endpoints, people and workspaces come from webhook_claim_deliveries.
  const queue: { row: ClaimedDelivery; tags: TagMap }[] = [];
  let inFlight = 0;
  let stopped = false; // the deadline, the round limit or a database problem: claim nothing more
  let claiming: Promise<number> | null = null;
  let wakers: (() => void)[] = [];
  const finished = () => { const w = wakers; wakers = []; for (const f of w) f(); };
  const nextFinish = () => new Promise<void>((resolve) => { wakers.push(resolve); });

  /** One claim: new events fanned out, then up to one delivery per free sender. Returns how many were claimed. */
  const claim = async (): Promise<number> => {
    if (stats.rounds >= maxRounds || now() - start >= deadline) { stopped = true; return 0; }
    try {
      const q = await deps.service.query<{ n: number | string }>(DISPATCH_SQL.claimOutbox, [500]);
      stats.queued += Number(q[0]?.n ?? 0) || 0;
    } catch (e) {
      log(`[webhooks] fan-out failed: ${clean(String((e as Error)?.message ?? e), 160)}`);
    }
    let rows: ClaimedDelivery[];
    try {
      rows = await deps.service.query<ClaimedDelivery>(DISPATCH_SQL.claimDeliveries, [Math.min(batch, Math.max(1, concurrency - inFlight)), lease]);
    } catch (e) {
      log(`[webhooks] claim failed: ${clean(String((e as Error)?.message ?? e), 160)}`);
      stopped = true;
      return 0;
    }
    stats.rounds++;
    if (!rows.length) return 0;
    // endpoints whose creator lost access: switched off, nothing sent
    let access: Awaited<ReturnType<typeof checkCreators>>;
    try { access = await checkCreators(deps.service, rows); } catch (e) {
      log(`[webhooks] access check failed, holding this batch: ${clean(String((e as Error)?.message ?? e), 160)}`);
      stopped = true; // fail closed: the leases expire and the next run tries again
      return 0;
    }
    for (const id of access.gone) {
      try {
        await deps.service.query(DISPATCH_SQL.switchOff, [id, CREATOR_GONE_REASON, CREATOR_GONE_ERROR]);
        stats.disabled++;
      } catch { /* the next run tries again; nothing was sent */ }
    }
    const sendable = rows.filter((r) => !access.gone.has(String(r.webhook_id)));
    stats.skipped += rows.length - sendable.length;
    const tagsFor = await tagMaps(deps.service, sendable, access.scopes);
    for (const r of sendable) queue.push({ row: r, tags: tagsFor(r) });
    return rows.length;
  };

  const sender = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (item) {
        inFlight++;
        try { await deliver(item.row, item.tags); } catch { /* one delivery's problem stays its own */ } finally { inFlight--; finished(); }
        continue;
      }
      if (stopped) return;
      if (!claiming) claiming = claim().finally(() => { claiming = null; });
      const got = await claiming;
      if (queue.length || got > 0) continue;   // something to send (or only switched-off endpoints: look again)
      if (stopped || inFlight === 0) return;   // nothing due that this run may take, and nothing of ours in flight
      await nextFinish();                       // a delivery finishing frees a share: look again then
    }
  };
  await Promise.all(Array.from({ length: concurrency }, sender));
  stats.ms = Math.round(now() - start);
  return stats;
}

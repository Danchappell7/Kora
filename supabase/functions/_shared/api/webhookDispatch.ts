// ============================================================
// KANBO — webhook delivery engine (0046).                                  [a2]
//
// Pure module (no Deno globals): the webhook-dispatch edge function hands in
// the privileged connection, a DNS resolver and a network API, and vitest
// hands in fakes (webhookDispatch.test.ts). The loop:
//
//   1. webhook_claim_outbox(500)        fan new events out to the endpoints
//                                        listening (SKIP LOCKED, marks them processed)
//   2. webhook_claim_deliveries(20, 90) lease what's due (attempt already +1,
//                                        url + secret included)
//   3. per delivery (5 at a time):
//        • the endpoint's creator must still have access (else it's switched off)
//        • serialiseEvent → the same JSON as the REST API, ≤ 256 KB (long
//          descriptions trimmed first, "truncated": true)
//        • the URL rule again, never our own Supabase host, DNS (A + AAAA):
//          EVERY address must be public (isPublicAddress)
//        • POST over HTTPS to one of THOSE addresses (TLS still checks the
//          hostname), 10 s timeout, redirects not followed, signed:
//            Kanbo-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>
//   4. webhook_record_result(id, status|0, error, ms)  → delivered, or retry
//      after 1m, 5m, 30m, 2h, 6h; 20 failures in a row switch the endpoint
//      off and tell its creator in their Inbox (all in SQL).
//   …repeated until nothing is due or ~40 s have passed.
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
  /** custom tag labels for the tasks in a batch ($1 = jsonb array of tag ids) */
  tags:
    "select t.id::text as id, t.label, t.color from public.tags t " +
    "where t.id::text = any (array(select jsonb_array_elements_text($1::jsonb)))",
  /** may each endpoint's creator still see what it sends? ($1 = jsonb array of webhook ids) */
  creators:
    "select w.id::text as id, case when w.workspace_id is null then public.user_can_act(w.created_by) " +
    "else public.user_ws_role(w.created_by, w.workspace_id) in ('owner', 'admin', 'member') end as allowed " +
    "from public.webhooks w where w.id::text = any (array(select jsonb_array_elements_text($1::jsonb)))",
  /** switch an endpoint off because its creator lost access, and give up on its queue */
  switchOff:
    "with off as (update public.webhooks set active = false, disabled_at = now(), disabled_reason = $2::text, " +
    "updated_at = now() where id = $1::uuid and active returning id) " +
    "update public.webhook_deliveries d set state = 'failed', error = $3::text, next_attempt_at = null, lease_until = null, " +
    "updated_at = now() where d.webhook_id = $1::uuid and d.state = 'pending'",
} as const;

export const CREATOR_GONE_REASON = "Switched off: the person who added it no longer has access";
export const CREATOR_GONE_ERROR = "Not sent: the person who added this endpoint no longer has access, so it was switched off.";

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
  /** deliveries claimed per round */
  batch?: number;
  /** sent at once */
  concurrency?: number;
  leaseSeconds?: number;
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
  rounds: number;
  ms: number;
}

const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return "endpoint"; } };

async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await fn(item); } catch { /* one delivery's problem stays its own */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
}

/** Tag ids of the tasks in these deliveries → their labels (built-in + custom). */
async function tagMap(service: Tx, rows: readonly ClaimedDelivery[]): Promise<Map<string, { label: string | null; color: string | null }>> {
  const map = new Map<string, { label: string | null; color: string | null }>();
  for (const [id, t] of Object.entries(BUILTIN_TAG_LABELS)) map.set(id, t);
  const ids = new Set<string>();
  for (const r of rows) {
    const task = (r.payload as { task?: { tags?: unknown } } | null)?.task;
    if (Array.isArray(task?.tags)) for (const t of task.tags) if (typeof t === "string" && !map.has(t) && t.length <= 64) ids.add(t);
  }
  if (!ids.size) return map;
  try {
    const got = await service.query<{ id: string; label: string | null; color: string | null }>(DISPATCH_SQL.tags, [JSON.stringify([...ids].slice(0, 2000))]);
    for (const g of got) map.set(String(g.id), { label: g.label ?? null, color: g.color ?? null });
  } catch { /* labels are a nicety: ids still go out */ }
  return map;
}

/** Endpoints whose creator can no longer see what they send (removed, made a guest, suspended). */
async function lostAccess(service: Tx, rows: readonly ClaimedDelivery[]): Promise<Set<string>> {
  const ids = [...new Set(rows.map((r) => String(r.webhook_id)))];
  if (!ids.length) return new Set();
  const got = await service.query<{ id: string; allowed: boolean | null }>(DISPATCH_SQL.creators, [JSON.stringify(ids)]);
  const allowed = new Map(got.map((g) => [String(g.id), g.allowed === true]));
  return new Set(ids.filter((id) => allowed.get(id) !== true));
}

/** Claim → send → record until nothing is due or the deadline passes. */
export async function runDispatch(deps: DispatchDeps, opts: DispatchOptions = {}): Promise<DispatchStats> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const deadline = opts.deadlineMs ?? 40_000;
  const batch = opts.batch ?? 20;
  const concurrency = opts.concurrency ?? 5;
  const lease = opts.leaseSeconds ?? 90;
  const maxRounds = opts.maxRounds ?? 50;
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

  const deliver = async (row: ClaimedDelivery, tags: Map<string, { label: string | null; color: string | null }>) => {
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

  while (stats.rounds < maxRounds && now() - start < deadline) {
    try {
      const q = await deps.service.query<{ n: number | string }>(DISPATCH_SQL.claimOutbox, [500]);
      stats.queued += Number(q[0]?.n ?? 0) || 0;
    } catch (e) {
      log(`[webhooks] fan-out failed: ${clean(String((e as Error)?.message ?? e), 160)}`);
    }
    const rows = await deps.service.query<ClaimedDelivery>(DISPATCH_SQL.claimDeliveries, [batch, lease]);
    stats.rounds++;
    if (!rows.length) break;
    // endpoints whose creator lost access: switched off, nothing sent
    let gone = new Set<string>();
    try { gone = await lostAccess(deps.service, rows); } catch (e) {
      log(`[webhooks] access check failed, holding this batch: ${clean(String((e as Error)?.message ?? e), 160)}`);
      break; // fail closed: the leases expire and the next run tries again
    }
    for (const id of gone) {
      try {
        await deps.service.query(DISPATCH_SQL.switchOff, [id, CREATOR_GONE_REASON, CREATOR_GONE_ERROR]);
        stats.disabled++;
      } catch { /* the next run tries again; nothing was sent */ }
    }
    const sendable = rows.filter((r) => !gone.has(String(r.webhook_id)));
    stats.skipped += rows.length - sendable.length;
    const tags = await tagMap(deps.service, sendable);
    await pool(sendable, concurrency, (r) => deliver(r, tags));
    if (rows.length < batch) {
      // a short batch: anything new that arrived meanwhile is picked up by one more pass
      const more = await deps.service.query<{ n: number | string }>(DISPATCH_SQL.claimOutbox, [500]).catch(() => [{ n: 0 }]);
      const n = Number(more[0]?.n ?? 0) || 0;
      stats.queued += n;
      if (!n) break;
    }
  }
  stats.ms = Math.round(now() - start);
  return stats;
}

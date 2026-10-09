// ============================================================
// KANBO — signed webhooks: the shared contract (0046).           [architect]
//
// Package a2 owns the dispatcher (webhook-dispatch), the SSRF guard and the
// REST routes below; the pieces here are the contract everyone shares:
// event names, headers, the signature scheme, the retry schedule, limits.
// The delivery engine itself (DNS check, pinned HTTPS POST, payload cap,
// the claim → send → record loop) is in webhookDispatch.ts.
//
// Every delivery is an HTTPS POST of a WebhookEnvelope (serialise.ts) with
//   Content-Type:     application/json
//   User-Agent:       Kanbo-Webhooks/1.0
//   Kanbo-Event:      task.updated
//   Kanbo-Delivery:   <delivery uuid>            (new per endpoint, same across retries)
//   Kanbo-Signature:  t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>
// The receiver recomputes v1 over the raw body with its whsec_… secret,
// compares in constant time and rejects a t more than 5 minutes old.
//
// Database side (0046, service role): webhook_claim_outbox(),
// webhook_claim_deliveries(), webhook_record_result(), api_housekeeping().
//
// Pure module (Web Crypto only; no Deno globals, so the app can import the
// constants): webhooks.test.ts.
// ============================================================
import { scopeFor } from "./auth.ts";
import type { OpenApiDoc } from "./openapi.ts";
import { apiError, json, type Route, type RouteContext } from "./router.ts";
import { isoTime, type WebhookEventType } from "./serialise.ts";
import type { ApiErrorCode, Tx } from "./types.ts";

export const WEBHOOK_EVENTS: readonly WebhookEventType[] = [
  "task.created", "task.updated", "task.completed", "task.deleted",
  "comment.created", "project.created", "project.updated", "member.joined",
  "approval.requested", "approval.decided",
];

/** The event catalogue (docs, Settings checklist). */
export const WEBHOOK_EVENT_INFO: Readonly<Record<WebhookEventType, { label: string; description: string }>> = {
  "task.created":    { label: "Task created",    description: "A task is added (or moved into this workspace)." },
  "task.updated":    { label: "Task updated",    description: "A task's title, status, dates, assignee, project, section, tags or estimate changes. `changes` lists the fields." },
  "task.completed":  { label: "Task completed",  description: "A task is marked done (sent as well as task.updated)." },
  "task.deleted":    { label: "Task deleted",    description: "A task is archived, permanently deleted or moved to another workspace. `deletion` says which." },
  "comment.created": { label: "Comment added",   description: "Someone comments on a task." },
  "project.created": { label: "Project created", description: "A project is added." },
  "project.updated": { label: "Project updated", description: "A project's name, look, description, status, owner, people or archive state changes." },
  "member.joined":   { label: "Member joined",   description: "Someone joins the workspace (accepts an invite)." },
  "approval.requested": { label: "Approval requested", description: "Someone asks for approval on a task. `data` is the request with its reviewers and task." },
  "approval.decided":   { label: "Approval decided",   description: "A reviewer approves or asks for changes, or the request is cancelled. `decision` says which; `status` is where the request now stands." },
};

export const WEBHOOK_HEADERS = {
  event: "Kanbo-Event",
  delivery: "Kanbo-Delivery",
  signature: "Kanbo-Signature",
} as const;
export const WEBHOOK_USER_AGENT = "Kanbo-Webhooks/1.0";

/** Minutes to wait after failed attempt 1, 2, 3, 4, 5; attempt 6 failing gives up (same as webhook_record_result). */
export const RETRY_SCHEDULE_MIN: readonly number[] = [1, 5, 30, 120, 360];
/** Failed attempts in a row that switch an endpoint off. */
export const MAX_CONSECUTIVE_FAILURES = 20;
/** Per request; no redirects are followed. */
export const DELIVERY_TIMEOUT_MS = 10_000;
/** Largest body sent; bigger events are trimmed (long descriptions first). */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
/** How old a signature's timestamp may be when verified. */
export const SIGNATURE_TOLERANCE_SEC = 300;
/** Test pings per endpoint per minute (send_test_webhook). */
export const TESTS_PER_MINUTE = 5;
/** "Send again" per endpoint per minute, the app and the API together (redeliver_webhook_delivery). */
export const REDELIVERIES_PER_MINUTE = 10;

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

/** The Kanbo-Signature header for this body ("t=<unix>,v1=<hex>"). */
export async function signatureHeader(secret: string, body: string, unixSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${unixSeconds},v1=${await hmacHex(secret, `${unixSeconds}.${body}`)}`;
}

/** Parse "t=…,v1=…[,v1=…]" (several v1 values are allowed, e.g. during a secret rotation). */
export function parseSignatureHeader(header: string | null | undefined): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t = NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && /^\d{1,12}$/.test(v ?? "")) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v ?? "")) v1.push(v);
  }
  return Number.isFinite(t) && v1.length ? { t, v1 } : null;
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** What a receiver does (also used by the docs' examples and tests). */
export async function verifySignature(secret: string, header: string | null | undefined, body: string,
  opts: { toleranceSec?: number; nowSec?: number } = {}): Promise<boolean> {
  const p = parseSignatureHeader(header);
  if (!p) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - p.t) > (opts.toleranceSec ?? SIGNATURE_TOLERANCE_SEC)) return false;
  const want = await hmacHex(secret, `${p.t}.${body}`);
  return p.v1.some((v) => safeEqual(v, want));
}

/**
 * The URL rule the database enforces (public.webhook_url_ok): https, a real
 * hostname (no IP literals, no user:password@, no internal names), ≤ 2000
 * characters. The dispatcher must ALSO resolve the host and refuse private,
 * loopback, link-local and other special addresses (isPublicAddress).
 */
export function isWebhookUrlShapeOk(url: string): boolean {
  if (typeof url !== "string" || url.length > 2000 || /[\s\\<>"]/.test(url)) return false;
  const m = /^https:\/\/([^/?#]+)([/?][^#]*)?$/.exec(url);
  if (!m || m[1].includes("@")) return false;
  const host = m[1].replace(/:[0-9]{1,5}$/, "").toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) return false;
  if (/^[0-9.]+$/.test(host) || host.startsWith("0x")) return false;
  if (/(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|onion|arpa)$/.test(host)) return false;
  return true;
}

/**
 * An endpoint's address as people who can't manage it see it: scheme and
 * host, then "…" and the path's last 4 characters
 * (https://hooks.zapier.com/…x2kd). Catch-hook URLs are often the only thing
 * a receiver checks, so the full address is only for the people who manage
 * the endpoint. Same rule as public.webhook_url_masked(); an address that's
 * already masked comes back as it is.
 */
export function maskWebhookUrl(url: string): string {
  const m = /^https:\/\/([^/?#]+)([/?][^#]*)?$/.exec(typeof url === "string" ? url : "");
  if (!m) return "https://…";
  const rest = (m[2] ?? "").replace(/\/+$/, "");
  if (!rest) return `https://${m[1]}/`;
  if (rest.startsWith("/…") && rest.length <= 6) return `https://${m[1]}${rest}`; // already masked
  return rest.length <= 8 ? `https://${m[1]}/…` : `https://${m[1]}/…${rest.slice(-4)}`;
}

/* ============================================================ SSRF guard   [a2]
   The dispatcher resolves an endpoint's host (A + AAAA) and sends only when
   EVERY address is public unicast; it then connects to one of those exact
   addresses (webhookDispatch.ts), so a second lookup can't swap in a
   private one. Anything this parser doesn't understand is refused. */

/** "a.b.c.d" → four octets; null for anything else (no leading zeros, no shorthand). */
export function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** An IPv6 address (compressed, or with a dotted IPv4 tail) → eight 16-bit groups; null for anything else (zone ids too). */
export function parseIPv6(input: string): number[] | null {
  let s = input;
  if (!s || s.length > 45 || s.includes("%") || !s.includes(":")) return null;
  if (s.includes(".")) {
    const cut = s.lastIndexOf(":");
    const v4 = parseIPv4(s.slice(cut + 1));
    if (!v4) return null;
    s = `${s.slice(0, cut + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...new Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  }
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function isPublicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;                 // this network, private, loopback
  if (a === 100 && (b & 0xc0) === 64) return false;                    // 100.64/10 carrier-grade NAT
  if (a === 169 && b === 254) return false;                            // link-local (cloud metadata)
  if (a === 172 && (b & 0xf0) === 16) return false;                    // 172.16/12
  if (a === 192 && b === 168) return false;                            // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;      // IETF assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false;                 // 6to4 relay anycast
  if (a === 198 && (b & 0xfe) === 18) return false;                    // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false;                // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;                 // TEST-NET-3
  if (a >= 224) return false;                                          // multicast, reserved, broadcast
  return true;
}

/**
 * SSRF guard: true only for a public unicast address (v4 or v6). Refuses
 * private (10/8, 172.16/12, 192.168/16), loopback, link-local (169.254/16,
 * fe80::/10), CGNAT (100.64/10), unique-local (fc00::/7), multicast,
 * reserved, benchmarking, documentation, 6to4 / Teredo / NAT64-local, and
 * IPv4-mapped / NAT64 forms of any refused IPv4 address. IPv6 must be in
 * 2000::/3 (global unicast). Malformed input → false (fail closed).
 */
export function isPublicAddress(ip: string): boolean {
  if (typeof ip !== "string") return false;
  const s = ip.trim().replace(/^\[(.*)\]$/, "$1");
  if (!s.includes(":")) {
    const v4 = parseIPv4(s);
    return !!v4 && isPublicV4(v4);
  }
  const g = parseIPv6(s);
  if (!g) return false;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const embedded = () => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  if (zeros(0, 5) && g[5] === 0xffff) return isPublicV4(embedded());             // ::ffff:a.b.c.d (mapped)
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return isPublicV4(embedded()); // ::ffff:0:a.b.c.d (translated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPublicV4(embedded()); // 64:ff9b::/96 NAT64
  if ((g[0] & 0xe000) !== 0x2000) return false;          // only 2000::/3: drops ::, ::1, fc00::/7, fe80::/10, ff00::/8…
  if (g[0] === 0x2001 && g[1] < 0x0200) return false;    // 2001::/23 IETF (Teredo, benchmarking, ORCHID)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;  // documentation
  if (g[0] === 0x2002) return false;                     // 6to4 (can wrap a private IPv4)
  if (g[0] === 0x3fff && g[1] < 0x1000) return false;    // 3fff::/20 documentation
  return true;
}

/* ============================================================ REST routes   [a2]
   Mounted by the api function after its own routes. Every handler runs the
   0046 definer functions inside ctx.db.withUser(scopeFor(...)) — as the
   key's user, so auth.uid() is theirs and each function applies its own
   rules (writers manage team endpoints; guests can't). Definer functions
   DON'T see the "api key scope", so a workspace key is held to its own
   workspace here: it may only list, create and touch that workspace's
   endpoints, never personal ones. Changes need a read & write key.

   The JSON is camelCase like the rest of the API (ApiWebhook /
   ApiWebhookDelivery below); the signing secret appears only in the answers
   to POST /webhooks and POST /webhooks/:id/rotate-secret. */

/** An endpoint as the API returns it. */
export interface ApiWebhook {
  object: "webhook";
  id: string;
  /** null = personal (your personal tasks and projects) */
  workspaceId: string | null;
  /** the full address only when canManage; otherwise masked (https://host/…x2kd) */
  url: string;
  description: string | null;
  events: WebhookEventType[];
  active: boolean;
  createdBy: string | null;
  createdByName: string | null;
  /** failed attempts in a row (20 switch it off) */
  failureCount: number;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveryAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** you may change, test, rotate or delete it */
  canManage: boolean;
}
/** POST /webhooks: the endpoint plus its signing secret (shown once). */
export interface ApiCreatedWebhook extends ApiWebhook { secret: string }

/** One delivery of one event to one endpoint (the same across its retries). */
export interface ApiWebhookDelivery {
  object: "webhook_delivery";
  /** = the Kanbo-Delivery header */
  id: string;
  webhookId: string;
  /** = the envelope's id ("evt_…") */
  eventId: string;
  event: WebhookEventType | "ping";
  state: "pending" | "delivered" | "failed";
  attempt: number;
  /** your endpoint's HTTP status; 0 = no answer (timeout, DNS, refused, blocked) */
  statusCode: number | null;
  error: string | null;
  durationMs: number | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

type Row = Record<string, unknown>;
const KNOWN_EVENTS = new Set<string>(WEBHOOK_EVENTS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const n = (v: unknown): number | null => {
  const x = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};
const asRow = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

/** webhook_json() → ApiWebhook (+ secret when present). The URL stays masked for anyone who can't manage it. */
export function serialiseWebhook(raw: unknown): ApiWebhook | ApiCreatedWebhook {
  const r = asRow(raw);
  const manage = r.can_manage === true;
  const out: ApiWebhook = {
    object: "webhook",
    id: String(r.id ?? ""),
    workspaceId: s(r.workspace_id),
    url: manage ? String(r.url ?? "") : maskWebhookUrl(String(r.url ?? "")),
    description: s(r.description),
    events: (Array.isArray(r.events) ? r.events : []).filter((e): e is WebhookEventType => typeof e === "string" && KNOWN_EVENTS.has(e)),
    active: r.active === true,
    createdBy: s(r.created_by),
    createdByName: s(r.created_by_name),
    failureCount: n(r.failure_count) ?? 0,
    lastStatus: n(r.last_status),
    lastError: s(r.last_error),
    lastDeliveryAt: isoTime(r.last_delivery_at),
    disabledAt: isoTime(r.disabled_at),
    disabledReason: s(r.disabled_reason),
    createdAt: isoTime(r.created_at),
    updatedAt: isoTime(r.updated_at),
    canManage: manage,
  };
  return typeof r.secret === "string" ? { ...out, secret: r.secret } : out;
}

/** list_webhook_deliveries() row → ApiWebhookDelivery. */
export function serialiseWebhookDelivery(raw: unknown): ApiWebhookDelivery {
  const r = asRow(raw);
  const ev = String(r.event ?? "");
  const st = r.state === "delivered" || r.state === "failed" ? r.state : "pending";
  return {
    object: "webhook_delivery",
    id: String(r.id ?? ""),
    webhookId: String(r.webhook_id ?? ""),
    eventId: `evt_${String(r.outbox_id ?? "")}`,
    event: (KNOWN_EVENTS.has(ev) ? ev : "ping") as WebhookEventType | "ping",
    state: st,
    attempt: n(r.attempt) ?? 0,
    statusCode: n(r.status_code),
    error: s(r.error),
    durationMs: n(r.duration_ms),
    nextAttemptAt: isoTime(r.next_attempt_at),
    deliveredAt: isoTime(r.delivered_at),
    createdAt: isoTime(r.created_at),
    updatedAt: isoTime(r.updated_at),
  };
}

/** The SQL each route runs inside withUser (replayed as-is in the PGlite harness). */
export const WEBHOOK_SQL = {
  /** every endpoint the key's user can see: personal + each workspace they can write in.
   *  $1 = the key's workspace (null = personal key: everything); $2 = one id, or null for all */
  visible:
    "select coalesce(jsonb_agg(e order by e->>'created_at', e->>'id'), '[]'::jsonb) as list " +
    "from (select public.list_webhooks(null) as l where $1::uuid is null " +
    "union all select public.list_webhooks(ws.id) from public.workspaces ws " +
    "where public.can_write(ws.id) and ($1::uuid is null or ws.id = $1::uuid)) s " +
    "cross join lateral jsonb_array_elements(s.l) e where ($2::text is null or e->>'id' = $2::text)",
  /** one scope: $1 null = your personal endpoints, else that workspace's (writers) */
  list: "select public.list_webhooks($1::uuid) as list",
  create: "select public.create_webhook($1::uuid, $2::text, array(select jsonb_array_elements_text($3::jsonb)), $4::text) as webhook",
  update:
    "select public.update_webhook($1::uuid, $2::text, " +
    "case when $3::jsonb is null then null else array(select jsonb_array_elements_text($3::jsonb)) end, $4::boolean, $5::text) as webhook",
  remove: "select public.delete_webhook($1::uuid) as ok",
  rotate: "select public.rotate_webhook_secret($1::uuid) as result",
  test: "select public.send_test_webhook($1::uuid) as result",
  deliveries: "select public.list_webhook_deliveries($1::uuid, $2::int) as list",
  redeliver: "select public.redeliver_webhook_delivery($1::uuid) as result",
} as const;

/** Most deliveries GET /webhooks/:id/deliveries returns (and the window redelivery looks in). */
export const DELIVERIES_MAX = 100;
const MAX_BODY_BYTES = 64 * 1024;

type Fields = Record<string, string>;

const fail = (ctx: RouteContext, status: number, code: ApiErrorCode, message: string, details?: Record<string, unknown>, headers?: Record<string, string>) =>
  apiError(status, code, message, { requestId: ctx.requestId, details, headers });
const invalid = (ctx: RouteContext, fields: Fields) =>
  fail(ctx, 422, "validation_failed", "Some fields aren't right. See details.fields.", { fields });
const notFound = (ctx: RouteContext) => fail(ctx, 404, "not_found", "There's no webhook with that id that this key can reach.");
const outsideScope = (ctx: RouteContext) =>
  fail(ctx, 403, "forbidden", "This key belongs to one workspace, so it can only manage that workspace's webhooks.");
const ok = (ctx: RouteContext, body: unknown, status = 200, headers: Record<string, string> = {}) => json(body, status, headers, ctx.requestId);
const listOf = <T>(data: T[]) => ({ object: "list" as const, data, nextCursor: null, hasMore: false });

/** A definer function's refusal (or a Postgres error) → the API's JSON error. */
export function webhookErrorResponse(e: unknown, ctx: Pick<RouteContext, "requestId">): Response {
  const msg = String((e as { message?: unknown })?.message ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  const r = (status: number, c: ApiErrorCode, m: string, details?: Record<string, unknown>, headers?: Record<string, string>) =>
    apiError(status, c, m, { requestId: ctx.requestId, details, headers });
  if (/webhook not found|delivery not found/i.test(msg)) return r(404, "not_found", "There's no webhook with that id that this key can reach.");
  if (/already delivered/i.test(msg)) return r(409, "conflict", "That delivery already arrived, so there's nothing to send again.");
  if (/not allowed/i.test(msg)) return r(403, "forbidden", "You can't manage webhooks there. Owners, admins and members can; guests can't.");
  if (/not authorized/i.test(msg)) return r(403, "forbidden", "This account can't make changes at the moment.");
  if (/invalid url/i.test(msg)) return r(422, "validation_failed", "Some fields aren't right. See details.fields.", { fields: { url: URL_RULE } });
  if (/invalid events/i.test(msg)) return r(422, "validation_failed", "Some fields aren't right. See details.fields.", { fields: { events: EVENTS_RULE } });
  if (/invalid description/i.test(msg)) return r(422, "validation_failed", "Some fields aren't right. See details.fields.", { fields: { description: DESCRIPTION_RULE } });
  if (/too many webhooks/i.test(msg)) return r(409, "conflict", "That's the limit: 20 endpoints a workspace and 10 personal ones. Delete one you no longer use first.");
  if (/too many tests/i.test(msg)) return r(429, "rate_limited", `That's ${TESTS_PER_MINUTE} test events in a minute for this endpoint. Try again shortly.`, undefined, { "Retry-After": "60" });
  if (/too many redeliveries/i.test(msg)) {
    const wait = Math.min(60, Math.max(1, Number(/retry after (\d+)/i.exec(msg)?.[1] ?? 60) || 60));
    return r(429, "rate_limited", `That's ${REDELIVERIES_PER_MINUTE} deliveries sent again in a minute for this endpoint. Try again shortly.`, undefined, { "Retry-After": String(wait) });
  }
  if (/test events can.t be sent again/i.test(msg)) return r(409, "conflict", TEST_NOT_AGAIN);
  if (code === "25006") return r(403, "forbidden", "This key is read-only.");
  if (code === "42501" || /permission denied|row-level security/i.test(msg)) return r(403, "forbidden", "This key can't do that.");
  console.error(`[api] webhooks ${ctx.requestId}: ${code || "error"} ${msg.slice(0, 200)}`);
  return r(500, "internal", "Something went wrong on Kanbo's side. Try again, and quote the request id if it keeps happening.");
}

const TEST_NOT_AGAIN = "A test event isn't sent again. Send a new one with POST /webhooks/:id/test.";
const URL_RULE = "Use a public https:// address with a hostname (no IP addresses, no user:password@, no internal names), up to 2000 characters.";
const EVENTS_RULE = `Choose 1 to ${WEBHOOK_EVENTS.length} of: ${WEBHOOK_EVENTS.join(", ")}.`;
const DESCRIPTION_RULE = "Up to 200 characters, or null.";

/** The request's JSON object: the api function may hand it over already parsed (ctx.body); otherwise it's read here. */
async function readBody(ctx: RouteContext): Promise<{ ok: true; body: Row } | { ok: false; res: Response }> {
  const given = (ctx as RouteContext & { body?: unknown }).body;
  let value: unknown = given;
  if (given === undefined) {
    const type = ctx.req.headers.get("content-type") ?? "";
    if (!/^application\/json\b/i.test(type.trim())) {
      return { ok: false, res: fail(ctx, 415, "unsupported_media_type", "Send the body as JSON with Content-Type: application/json.") };
    }
    let text: string;
    try { text = await ctx.req.text(); } catch { return { ok: false, res: fail(ctx, 400, "invalid_body", "The request body couldn't be read.") }; }
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return { ok: false, res: fail(ctx, 413, "payload_too_large", "The body is too large (64 KB at most).") };
    }
    if (!text.trim()) value = {};
    else {
      try { value = JSON.parse(text); } catch { return { ok: false, res: fail(ctx, 400, "invalid_body", "The body isn't valid JSON.") }; }
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, res: fail(ctx, 400, "invalid_body", "The body must be a JSON object.") };
  }
  return { ok: true, body: value as Row };
}

const unknownFields = (body: Row, allowed: readonly string[], fields: Fields) => {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) fields[k] = "Unknown field.";
};

function checkUrl(v: unknown, fields: Fields): string | null {
  if (typeof v !== "string" || !v.trim()) { fields.url = "Required: " + URL_RULE; return null; }
  const u = v.trim();
  if (!isWebhookUrlShapeOk(u)) { fields.url = URL_RULE; return null; }
  return u;
}
function checkEvents(v: unknown, fields: Fields): WebhookEventType[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 32 || v.some((e) => typeof e !== "string" || !KNOWN_EVENTS.has(e))) {
    fields.events = EVENTS_RULE;
    return null;
  }
  return [...new Set(v as WebhookEventType[])].sort();
}
/** undefined = not given; null = clear */
function checkDescription(v: unknown, fields: Fields): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string" || v.trim().length > 200) { fields.description = DESCRIPTION_RULE; return undefined; }
  return v.trim() || null;
}

/** The workspace a request may act on: the key's own, or (personal key) any. */
function targetWorkspace(ctx: RouteContext, given: unknown, fields: Fields): { ok: true; ws: string | null } | { ok: false; res?: Response } {
  const own = ctx.principal.workspaceId;
  if (given === undefined) return { ok: true, ws: own };
  if (given !== null && (typeof given !== "string" || !UUID_RE.test(given))) {
    fields.workspaceId = "A workspace id, or null for a personal endpoint.";
    return { ok: false };
  }
  const ws = given === null ? null : given.toLowerCase();
  if (own && ws !== own.toLowerCase()) return { ok: false, res: outsideScope(ctx) };
  return { ok: true, ws };
}

const readOnlyKey = (ctx: RouteContext) =>
  fail(ctx, 403, "forbidden", "This key is read-only. Use a read & write key (kanbo_sk_…) to change webhooks.");

/** Run fn as the key's user (RLS, the key's workspace scope; read-only for GETs and read keys). */
async function asKeyUser(ctx: RouteContext, fn: (tx: Tx) => Promise<Response>): Promise<Response> {
  try {
    return await ctx.db.withUser(scopeFor(ctx.principal, ctx.method), fn);
  } catch (e) {
    return webhookErrorResponse(e, ctx);
  }
}

/** The endpoint with this id, if the key can reach it (its workspace for a workspace key). */
async function findWebhook(tx: Tx, ctx: RouteContext, id: string): Promise<Row | null> {
  const rows = await tx.query<{ list: unknown }>(WEBHOOK_SQL.visible, [ctx.principal.workspaceId, id.toLowerCase()]);
  const list = rows[0]?.list;
  return Array.isArray(list) && list.length ? asRow(list[0]) : null;
}

const idParam = (ctx: RouteContext, name = "id"): string | null => {
  const v = ctx.params[name];
  return typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null;
};

/* ---- GET /webhooks?workspace=<uuid|personal> ---- */
async function listRoute(ctx: RouteContext): Promise<Response> {
  const q = ctx.url.searchParams.get("workspace");
  const own = ctx.principal.workspaceId;
  let scope: { all: true } | { all: false; ws: string | null };
  if (q === null || q === "") scope = own ? { all: false, ws: own } : { all: true };
  else if (q === "personal") {
    if (own) return outsideScope(ctx);
    scope = { all: false, ws: null };
  } else if (UUID_RE.test(q)) {
    if (own && q.toLowerCase() !== own.toLowerCase()) return outsideScope(ctx);
    scope = { all: false, ws: q.toLowerCase() };
  } else {
    return fail(ctx, 400, "bad_request", "workspace must be a workspace id or \"personal\".");
  }
  return asKeyUser(ctx, async (tx) => {
    const rows = scope.all
      ? await tx.query<{ list: unknown }>(WEBHOOK_SQL.visible, [null, null])
      : await tx.query<{ list: unknown }>(WEBHOOK_SQL.list, [scope.ws]);
    const list = rows[0]?.list;
    return ok(ctx, listOf((Array.isArray(list) ? list : []).map((w) => serialiseWebhook(w) as ApiWebhook)));
  });
}

/* ---- POST /webhooks ---- */
async function createRoute(ctx: RouteContext): Promise<Response> {
  if (ctx.principal.access !== "write") return readOnlyKey(ctx);
  const b = await readBody(ctx);
  if (!b.ok) return b.res;
  const fields: Fields = {};
  unknownFields(b.body, ["url", "events", "description", "workspaceId"], fields);
  const url = checkUrl(b.body.url, fields);
  const events = checkEvents(b.body.events, fields);
  const description = checkDescription(b.body.description, fields);
  const target = targetWorkspace(ctx, b.body.workspaceId, fields);
  if (!target.ok && target.res) return target.res;
  if (Object.keys(fields).length || !target.ok || !url || !events) return invalid(ctx, fields);
  const ws = target.ws;
  return asKeyUser(ctx, async (tx) => {
    const rows = await tx.query<{ webhook: unknown }>(WEBHOOK_SQL.create, [ws, url, JSON.stringify(events), description ?? null]);
    return ok(ctx, serialiseWebhook(rows[0]?.webhook), 201);
  });
}

/* ---- GET /webhooks/:id ---- */
async function getRoute(ctx: RouteContext): Promise<Response> {
  const id = idParam(ctx);
  if (!id) return notFound(ctx);
  return asKeyUser(ctx, async (tx) => {
    const w = await findWebhook(tx, ctx, id);
    return w ? ok(ctx, serialiseWebhook(w)) : notFound(ctx);
  });
}

/** Shared by the routes that change one endpoint: the key may reach it, and may manage it. */
async function manage(ctx: RouteContext, fn: (tx: Tx, id: string) => Promise<Response>): Promise<Response> {
  if (ctx.principal.access !== "write") return readOnlyKey(ctx);
  const id = idParam(ctx);
  if (!id) return notFound(ctx);
  return asKeyUser(ctx, async (tx) => {
    const w = await findWebhook(tx, ctx, id);
    if (!w) return notFound(ctx);
    if (w.can_manage !== true) {
      return fail(ctx, 403, "forbidden", "Only the person who added this endpoint, or a workspace owner or admin, can change it.");
    }
    return fn(tx, id);
  });
}

/* ---- PATCH /webhooks/:id ---- */
async function updateRoute(ctx: RouteContext): Promise<Response> {
  if (ctx.principal.access !== "write") return readOnlyKey(ctx);
  const b = await readBody(ctx);
  if (!b.ok) return b.res;
  const fields: Fields = {};
  unknownFields(b.body, ["url", "events", "description", "active"], fields);
  const has = (k: string) => b.body[k] !== undefined;
  const url = has("url") ? checkUrl(b.body.url, fields) : null;
  const events = has("events") ? checkEvents(b.body.events, fields) : null;
  const description = checkDescription(b.body.description, fields);
  if (has("active") && typeof b.body.active !== "boolean") fields.active = "true or false.";
  if (!Object.keys(fields).length && !["url", "events", "description", "active"].some(has)) {
    fields.body = "Send at least one of url, events, description or active.";
  }
  if (Object.keys(fields).length) return invalid(ctx, fields);
  const active = has("active") ? (b.body.active as boolean) : null;
  // update_webhook: null leaves a field alone; "" clears the description
  const desc = description === undefined ? null : description === null ? "" : description;
  return manage(ctx, async (tx, id) => {
    const rows = await tx.query<{ webhook: unknown }>(WEBHOOK_SQL.update, [id, url, events ? JSON.stringify(events) : null, active, desc]);
    return ok(ctx, serialiseWebhook(rows[0]?.webhook));
  });
}

/* ---- DELETE /webhooks/:id ---- */
const deleteRoute = (ctx: RouteContext) => manage(ctx, async (tx, id) => {
  await tx.query(WEBHOOK_SQL.remove, [id]);
  return ok(ctx, null, 204);
});

/* ---- POST /webhooks/:id/rotate-secret ---- */
const rotateRoute = (ctx: RouteContext) => manage(ctx, async (tx, id) => {
  const rows = await tx.query<{ result: unknown }>(WEBHOOK_SQL.rotate, [id]);
  const r = asRow(rows[0]?.result);
  return ok(ctx, { object: "webhook_secret", webhookId: id, secret: String(r.secret ?? "") });
});

/* ---- POST /webhooks/:id/test ---- */
const testRoute = (ctx: RouteContext) => manage(ctx, async (tx, id) => {
  const rows = await tx.query<{ result: unknown }>(WEBHOOK_SQL.test, [id]);
  const r = asRow(rows[0]?.result);
  return ok(ctx, { object: "webhook_test", webhookId: id, eventId: `evt_${String(r.outbox_id ?? "")}`, type: "ping", queued: true }, 202);
});

/* ---- GET /webhooks/:id/deliveries?limit= ---- */
async function deliveriesRoute(ctx: RouteContext): Promise<Response> {
  const id = idParam(ctx);
  if (!id) return notFound(ctx);
  const raw = ctx.url.searchParams.get("limit");
  let limit = 25;
  if (raw !== null) {
    if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > DELIVERIES_MAX) {
      return fail(ctx, 400, "bad_request", `limit must be a whole number from 1 to ${DELIVERIES_MAX}.`);
    }
    limit = Number(raw);
  }
  return asKeyUser(ctx, async (tx) => {
    if (!(await findWebhook(tx, ctx, id))) return notFound(ctx);
    const rows = await tx.query<{ list: unknown }>(WEBHOOK_SQL.deliveries, [id, limit]);
    const list = rows[0]?.list;
    return ok(ctx, listOf((Array.isArray(list) ? list : []).map(serialiseWebhookDelivery)));
  });
}

/* ---- POST /webhooks/:id/deliveries/:deliveryId/redeliver ---- */
async function redeliverRoute(ctx: RouteContext): Promise<Response> {
  const did = idParam(ctx, "deliveryId");
  return manage(ctx, async (tx, id) => {
    if (!did) return fail(ctx, 404, "not_found", "There's no delivery with that id among this endpoint's last 100.");
    const rows = await tx.query<{ list: unknown }>(WEBHOOK_SQL.deliveries, [id, DELIVERIES_MAX]);
    const list = Array.isArray(rows[0]?.list) ? (rows[0].list as unknown[]) : [];
    const found = list.map(asRow).find((d) => d.id === did);
    if (!found) return fail(ctx, 404, "not_found", "There's no delivery with that id among this endpoint's last 100.");
    if (found.event === "ping") return fail(ctx, 409, "conflict", TEST_NOT_AGAIN);
    await tx.query(WEBHOOK_SQL.redeliver, [did]);
    return ok(ctx, { object: "webhook_delivery", id: did, webhookId: id, state: "pending", queued: true }, 202);
  });
}

/**
 * REST routes for managing webhooks with an API key: mounted by the api
 * function's router after its own routes ([...coreRoutes, ...webhookRoutes]).
 * Changes need a read & write key; a workspace key reaches only its own
 * workspace's endpoints (never personal ones).
 */
export const webhookRoutes: Route[] = [
  { method: "GET", path: "/webhooks", handler: listRoute, summary: "List webhook endpoints" },
  { method: "POST", path: "/webhooks", handler: createRoute, summary: "Add a webhook endpoint (returns its signing secret once)" },
  { method: "GET", path: "/webhooks/:id", handler: getRoute, summary: "Get a webhook endpoint" },
  { method: "PATCH", path: "/webhooks/:id", handler: updateRoute, summary: "Change a webhook endpoint" },
  { method: "DELETE", path: "/webhooks/:id", handler: deleteRoute, summary: "Delete a webhook endpoint" },
  { method: "POST", path: "/webhooks/:id/rotate-secret", handler: rotateRoute, summary: "Replace an endpoint's signing secret" },
  { method: "POST", path: "/webhooks/:id/test", handler: testRoute, summary: "Send a test event" },
  { method: "GET", path: "/webhooks/:id/deliveries", handler: deliveriesRoute, summary: "Recent deliveries to an endpoint" },
  { method: "POST", path: "/webhooks/:id/deliveries/:deliveryId/redeliver", handler: redeliverRoute, summary: "Send a delivery again now" },
];

/* ============================================================ OpenAPI   [a2] */

const ERROR_SCHEMA = {
  type: "object", required: ["error"],
  properties: {
    error: {
      type: "object", required: ["code", "message", "status"],
      properties: { code: { type: "string" }, message: { type: "string" }, status: { type: "integer" }, requestId: { type: "string" }, details: { type: "object" } },
    },
  },
};
const errorRef = (description: string, code: ApiErrorCode, status: number, message: string) => ({
  description,
  content: { "application/json": { schema: ERROR_SCHEMA, example: { error: { code, message, status, requestId: "req_8f2c1a7d9e4b6c30" } } } },
});
const E = {
  400: errorRef("Bad query string", "bad_request", 400, "limit must be a whole number from 1 to 100."),
  401: errorRef("No key, or a key that isn't valid", "unauthorized", 401, "This API key isn't valid. It may have been revoked or have expired."),
  403: errorRef("Read-only key, outside the key's workspace, or not allowed", "forbidden", 403, "This key is read-only. Use a read & write key (kanbo_sk_…) to change webhooks."),
  404: errorRef("No such endpoint (or the key can't reach it)", "not_found", 404, "There's no webhook with that id that this key can reach."),
  409: errorRef("Limit reached", "conflict", 409, "That's the limit: 20 endpoints a workspace and 10 personal ones. Delete one you no longer use first."),
  422: { description: "Validation failed", content: { "application/json": { schema: ERROR_SCHEMA, example: { error: { code: "validation_failed", message: "Some fields aren't right. See details.fields.", status: 422, details: { fields: { url: URL_RULE } } } } } } },
  429: errorRef("Too many requests (or too many test events)", "rate_limited", 429, `That's ${TESTS_PER_MINUTE} test events in a minute for this endpoint. Try again shortly.`),
};

const WEBHOOK_EXAMPLE: ApiWebhook = {
  object: "webhook", id: "c924fcff-0938-4900-a8e7-9cbbb564a762", workspaceId: "11111111-0000-4000-8000-000000000001",
  url: "https://hooks.zapier.com/hooks/catch/1234567/bq9x2kd/", description: "New tasks into the ops sheet",
  events: ["task.completed", "task.created"], active: true, createdBy: "bbbbbbbb-0000-4000-8000-000000000002", createdByName: "Priya Shah",
  failureCount: 0, lastStatus: 200, lastError: null, lastDeliveryAt: "2026-10-05T09:41:12.000Z", disabledAt: null, disabledReason: null,
  createdAt: "2026-09-28T14:02:51.000Z", updatedAt: "2026-10-05T09:41:12.000Z", canManage: true,
};
const DELIVERY_EXAMPLE: ApiWebhookDelivery = {
  object: "webhook_delivery", id: "1aefcd04-d7e3-4f30-96e8-2a7008b6045c", webhookId: WEBHOOK_EXAMPLE.id, eventId: "evt_4812",
  event: "task.completed", state: "pending", attempt: 2, statusCode: 503, error: "HTTP 503 Service Unavailable", durationMs: 412,
  nextAttemptAt: "2026-10-05T09:47:12.000Z", deliveredAt: null, createdAt: "2026-10-05T09:41:10.000Z", updatedAt: "2026-10-05T09:42:12.000Z",
};
const WEBHOOK_SCHEMA = {
  type: "object",
  required: ["object", "id", "workspaceId", "url", "events", "active", "failureCount", "canManage"],
  properties: {
    object: { const: "webhook" }, id: { type: "string", format: "uuid" },
    workspaceId: { type: ["string", "null"], format: "uuid", description: "null = personal (your personal tasks and projects)" },
    url: {
      type: "string",
      description: "The endpoint's address. In full only when `canManage` is true; anyone else sees it masked, e.g. `https://hooks.zapier.com/…x2kd` (catch-hook addresses often work as a password).",
    },
    description: { type: ["string", "null"], maxLength: 200 },
    events: { type: "array", items: { enum: [...WEBHOOK_EVENTS] } }, active: { type: "boolean" },
    createdBy: { type: ["string", "null"] }, createdByName: { type: ["string", "null"] },
    failureCount: { type: "integer", description: `Failed attempts in a row; ${MAX_CONSECUTIVE_FAILURES} switch the endpoint off` },
    lastStatus: { type: ["integer", "null"] }, lastError: { type: ["string", "null"] }, lastDeliveryAt: { type: ["string", "null"], format: "date-time" },
    disabledAt: { type: ["string", "null"], format: "date-time" }, disabledReason: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" }, canManage: { type: "boolean" },
  },
};
const idParamSpec = { name: "id", in: "path" as const, required: true, description: "The endpoint's id", schema: { type: "string", format: "uuid" } };
const jsonBody = (schema: unknown, example: unknown) => ({ required: true, content: { "application/json": { schema, example } } });
const jsonOk = (description: string, schema: unknown, example: unknown) => ({ description, content: { "application/json": { schema, example } } });
const listSchema = (item: unknown) => ({
  type: "object", properties: { object: { const: "list" }, data: { type: "array", items: item }, nextCursor: { type: "null" }, hasMore: { const: false } },
});
const SECRET_EXAMPLE = "whsec_jdGsQXdTNkPSgmI33ZLnz23lIrUXcu9vDtOYAOWNaJQ";

/** The OpenAPI paths for webhookRoutes; buildOpenApi merges them in. */
export const webhookOpenApiPaths: OpenApiDoc["paths"] = {
  "/webhooks": {
    get: {
      operationId: "listWebhooks", summary: "List webhook endpoints", tags: ["Webhooks"], "x-kanbo-access": "read",
      description: "Without `workspace`: a personal key lists your personal endpoints and those of every workspace where you can edit; a workspace key lists its workspace's. Signing secrets are never listed, and an endpoint you can't manage (`canManage: false`) shows its `url` masked.",
      parameters: [{ name: "workspace", in: "query", description: "A workspace id, or `personal`", schema: { type: "string" }, example: "personal" }],
      responses: { 200: jsonOk("The endpoints", listSchema(WEBHOOK_SCHEMA), listOf([WEBHOOK_EXAMPLE])), 400: E[400], 401: E[401], 403: E[403], 429: E[429] },
    },
    post: {
      operationId: "createWebhook", summary: "Add a webhook endpoint", tags: ["Webhooks"], "x-kanbo-access": "write",
      description: "Returns the endpoint with its signing secret (`whsec_…`). **The secret is shown only here**: store it to verify the Kanbo-Signature header. Team endpoints: owners, admins and members (never guests). Personal endpoints: leave out `workspaceId` with a personal key, or send null. A workspace key can only add endpoints to its own workspace.",
      requestBody: jsonBody({
        type: "object", required: ["url", "events"], additionalProperties: false,
        properties: {
          url: { type: "string", maxLength: 2000, description: URL_RULE },
          events: { type: "array", minItems: 1, items: { enum: [...WEBHOOK_EVENTS] } },
          description: { type: ["string", "null"], maxLength: 200 },
          workspaceId: { type: ["string", "null"], format: "uuid" },
        },
      }, { url: WEBHOOK_EXAMPLE.url, events: ["task.created", "task.completed"], description: "New tasks into the ops sheet", workspaceId: WEBHOOK_EXAMPLE.workspaceId }),
      responses: {
        201: jsonOk("Added. Copy the secret now.", { allOf: [WEBHOOK_SCHEMA, { type: "object", required: ["secret"], properties: { secret: { type: "string", pattern: "^whsec_[A-Za-z0-9_-]{43}$" } } }] }, { ...WEBHOOK_EXAMPLE, lastStatus: null, lastDeliveryAt: null, secret: SECRET_EXAMPLE }),
        400: errorRef("Not JSON / not an object", "invalid_body", 400, "The body must be a JSON object."), 401: E[401], 403: E[403], 409: E[409], 422: E[422], 429: E[429],
      },
    },
  },
  "/webhooks/{id}": {
    get: {
      operationId: "getWebhook", summary: "Get a webhook endpoint", tags: ["Webhooks"], "x-kanbo-access": "read", parameters: [idParamSpec],
      responses: { 200: jsonOk("The endpoint", WEBHOOK_SCHEMA, WEBHOOK_EXAMPLE), 401: E[401], 404: E[404], 429: E[429] },
    },
    patch: {
      operationId: "updateWebhook", summary: "Change a webhook endpoint", tags: ["Webhooks"], "x-kanbo-access": "write", parameters: [idParamSpec],
      description: "Only the fields you send change. `description: null` clears it. `active: true` switches a switched-off endpoint back on and resets its failure count; `active: false` gives up on anything still waiting. The person who added it, or a workspace owner or admin, can change it.",
      requestBody: jsonBody({
        type: "object", minProperties: 1, additionalProperties: false,
        properties: { url: { type: "string" }, events: { type: "array", minItems: 1, items: { enum: [...WEBHOOK_EVENTS] } }, description: { type: ["string", "null"], maxLength: 200 }, active: { type: "boolean" } },
      }, { events: ["task.created", "task.completed", "comment.created"], active: true }),
      responses: { 200: jsonOk("Changed", WEBHOOK_SCHEMA, WEBHOOK_EXAMPLE), 401: E[401], 403: E[403], 404: E[404], 422: E[422], 429: E[429] },
    },
    delete: {
      operationId: "deleteWebhook", summary: "Delete a webhook endpoint", tags: ["Webhooks"], "x-kanbo-access": "write", parameters: [idParamSpec],
      responses: { 204: { description: "Deleted, with its delivery history" }, 401: E[401], 403: E[403], 404: E[404], 429: E[429] },
    },
  },
  "/webhooks/{id}/rotate-secret": {
    post: {
      operationId: "rotateWebhookSecret", summary: "Replace an endpoint's signing secret", tags: ["Webhooks"], "x-kanbo-access": "write", parameters: [idParamSpec],
      description: "The old secret stops verifying at once: update your receiver straight away. The new secret is shown only here.",
      responses: { 200: jsonOk("The new secret", { type: "object", properties: { object: { const: "webhook_secret" }, webhookId: { type: "string" }, secret: { type: "string" } } }, { object: "webhook_secret", webhookId: WEBHOOK_EXAMPLE.id, secret: SECRET_EXAMPLE }), 401: E[401], 403: E[403], 404: E[404], 429: E[429] },
    },
  },
  "/webhooks/{id}/test": {
    post: {
      operationId: "testWebhook", summary: "Send a test event", tags: ["Webhooks"], "x-kanbo-access": "write", parameters: [idParamSpec],
      description: `Queues a signed \`ping\` event to this endpoint only (also while it's switched off). It arrives within seconds. A failed ping isn't retried and doesn't count towards switching the endpoint off. At most ${TESTS_PER_MINUTE} a minute per endpoint.`,
      responses: { 202: jsonOk("Queued", { type: "object" }, { object: "webhook_test", webhookId: WEBHOOK_EXAMPLE.id, eventId: "evt_4813", type: "ping", queued: true }), 401: E[401], 403: E[403], 404: E[404], 429: E[429] },
    },
  },
  "/webhooks/{id}/deliveries": {
    get: {
      operationId: "listWebhookDeliveries", summary: "Recent deliveries to an endpoint", tags: ["Webhooks"], "x-kanbo-access": "read",
      description: "Newest first: what was sent, your endpoint's status code and response time, attempts and the next retry. Kept for 14 days.",
      parameters: [idParamSpec, { name: "limit", in: "query", description: `1–${DELIVERIES_MAX} (default 25)`, schema: { type: "integer", minimum: 1, maximum: DELIVERIES_MAX } }],
      responses: { 200: jsonOk("The deliveries", listSchema({ type: "object" }), listOf([DELIVERY_EXAMPLE])), 400: E[400], 401: E[401], 404: E[404], 429: E[429] },
    },
  },
  "/webhooks/{id}/deliveries/{deliveryId}/redeliver": {
    post: {
      operationId: "redeliverWebhookDelivery", summary: "Send a delivery again now", tags: ["Webhooks"], "x-kanbo-access": "write",
      description: `Puts a failed (or waiting) delivery back in the queue with a fresh set of retries. One of the endpoint's 100 most recent deliveries, and not a test \`ping\` (send a new test instead). At most ${REDELIVERIES_PER_MINUTE} a minute per endpoint, counted together with Settings' **Send again**; if it fails again it counts towards switching the endpoint off.`,
      parameters: [idParamSpec, { name: "deliveryId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      responses: {
        202: jsonOk("Queued", { type: "object" }, { object: "webhook_delivery", id: DELIVERY_EXAMPLE.id, webhookId: WEBHOOK_EXAMPLE.id, state: "pending", queued: true }), 401: E[401], 403: E[403], 404: E[404],
        409: errorRef("Already delivered, or a test event", "conflict", 409, "That delivery already arrived, so there's nothing to send again."),
        429: errorRef("Too many requests, or too many sent again for this endpoint (see Retry-After)", "rate_limited", 429, `That's ${REDELIVERIES_PER_MINUTE} deliveries sent again in a minute for this endpoint. Try again shortly.`),
      },
    },
  },
};

// ============================================================
// KANBO — signed webhooks: the shared contract (0046).           [architect]
//
// Package a2 owns the dispatcher (webhook-dispatch), the SSRF guard and the
// REST routes below; the pieces here are the contract everyone shares:
// event names, headers, the signature scheme, the retry schedule, limits.
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
// Pure module (Web Crypto only): webhooks.test.ts.
// ============================================================
import type { OpenApiDoc } from "./openapi.ts";
import type { Route } from "./router.ts";
import type { WebhookEventType } from "./serialise.ts";

export const WEBHOOK_EVENTS: readonly WebhookEventType[] = [
  "task.created", "task.updated", "task.completed", "task.deleted",
  "comment.created", "project.created", "project.updated", "member.joined",
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
 * SSRF guard — package a2 implements: true only for a public unicast
 * address (v4 or v6) that is not private (10/8, 172.16/12, 192.168/16),
 * loopback, link-local (169.254/16, fe80::/10), CGNAT (100.64/10),
 * unique-local (fc00::/7), multicast, reserved, documentation or an
 * IPv4-mapped form of any of those. Until then: refuse everything (fail closed).
 */
export function isPublicAddress(_ip: string): boolean {
  return false;
}

/**
 * REST routes for managing webhooks with an API key (package a2): mounted by
 * the api function's router after its own routes. They call the 0046
 * definer functions inside withUser — which do NOT see the api key scope —
 * so each handler must refuse a workspace other than principal.workspaceId
 * (and personal webhooks) for a workspace key, and require a write key.
 */
export const webhookRoutes: Route[] = [];

/** The OpenAPI paths for webhookRoutes (package a2); buildOpenApi merges them in. */
export const webhookOpenApiPaths: OpenApiDoc["paths"] = {};

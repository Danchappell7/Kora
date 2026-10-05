/* ============================================================
   KANBO — webhooks (Settings › Developers › Webhooks).  [0046 contract → a2]
   Endpoints, secrets and deliveries are server-only tables; everything
   goes through the 0046 definer functions (snake_case JSON, parsed here).

   Contract (database 0046):
     rpc create_webhook(p_workspace uuid|null, p_url, p_events text[], p_description?)
       → webhook JSON + { secret }   (writers of the workspace; anyone for personal)
     rpc list_webhooks(p_workspace uuid|null) → webhook JSON[]
     rpc update_webhook(p_id, p_url?, p_events?, p_active?, p_description?) → webhook JSON
     rpc delete_webhook(p_id) → true
     rpc rotate_webhook_secret(p_id) → { id, secret }
     rpc send_test_webhook(p_id) → { outbox_id }      (5 a minute)
     rpc list_webhook_deliveries(p_id, p_limit ≤ 100) → delivery JSON[]
     rpc redeliver_webhook_delivery(p_delivery) → { id, state: 'pending' }
       (not a ping; 10 a minute per endpoint, shared with the API)
     errors: 'not authorized' | 'not allowed' | 'invalid url' | 'invalid events' |
             'invalid description' | 'too many webhooks' (20 a workspace, 10 personal) |
             'too many tests' | 'too many redeliveries (retry after N s)' |
             'test events can't be sent again' | 'webhook not found' |
             'delivery not found' | 'already delivered'
     url: the full address only when can_manage; otherwise masked
          (https://hooks.zapier.com/…x2kd): catch-hook URLs work as passwords.

   Package a2: the async functions call those RPCs as the signed-in person
   (or, in demo mode, an in-memory fake with realistic endpoints and
   deliveries); parsers and constants are the architect's, final.
   ============================================================ */
import type { CreatedWebhook, NewWebhookInput, Webhook, WebhookDelivery, WebhookDeliveryEvent, WebhookDeliveryState, WebhookEvent, WebhookFailure, WebhookPatch } from "../data/types";
import {
  isWebhookUrlShapeOk, maskWebhookUrl, MAX_CONSECUTIVE_FAILURES, REDELIVERIES_PER_MINUTE, RETRY_SCHEDULE_MIN, TESTS_PER_MINUTE, WEBHOOK_EVENT_INFO, WEBHOOK_EVENTS,
} from "../../supabase/functions/_shared/api/webhooks.ts";
import { supabase } from "./supabase";

export { isWebhookUrlShapeOk, maskWebhookUrl, MAX_CONSECUTIVE_FAILURES, RETRY_SCHEDULE_MIN, WEBHOOK_EVENT_INFO, WEBHOOK_EVENTS };

export const WEBHOOK_LIMITS = {
  perWorkspace: 20, personal: 10, description: 200, url: 2000, testsPerMinute: TESTS_PER_MINUTE, redeliveriesPerMinute: REDELIVERIES_PER_MINUTE,
} as const;

const EVENTS = new Set<string>(WEBHOOK_EVENTS);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null);

/** A webhook JSON object (snake_case; camelCase also read) → Webhook; null if malformed. */
export function parseWebhook(raw: unknown): Webhook | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const g = (snake: string, camel: string) => (r[snake] !== undefined ? r[snake] : r[camel]);
  const id = str(r.id), url = str(r.url), createdBy = str(g("created_by", "createdBy"));
  if (!id || !url || !createdBy) return null;
  const events = (Array.isArray(r.events) ? r.events : []).filter((e): e is WebhookEvent => typeof e === "string" && EVENTS.has(e));
  const canManage = g("can_manage", "canManage") === true;
  return {
    id,
    workspaceId: str(g("workspace_id", "workspaceId")),
    // the server already masks it for people who can't manage it; never show more than that
    url: canManage ? url : maskWebhookUrl(url),
    description: str(r.description),
    events,
    active: r.active === true,
    createdBy,
    createdByName: str(g("created_by_name", "createdByName")),
    failureCount: int(g("failure_count", "failureCount")) ?? 0,
    lastStatus: int(g("last_status", "lastStatus")),
    lastError: str(g("last_error", "lastError")),
    lastDeliveryAt: str(g("last_delivery_at", "lastDeliveryAt")),
    disabledAt: str(g("disabled_at", "disabledAt")),
    disabledReason: str(g("disabled_reason", "disabledReason")),
    createdAt: str(g("created_at", "createdAt")) ?? "",
    updatedAt: str(g("updated_at", "updatedAt")) ?? "",
    canManage,
  };
}

/** create_webhook()'s answer → CreatedWebhook (null unless it carries a whsec_ secret). */
export function parseCreatedWebhook(raw: unknown): CreatedWebhook | null {
  const w = parseWebhook(raw);
  const secret = (raw as Record<string, unknown> | null)?.secret;
  return w && typeof secret === "string" && /^whsec_[A-Za-z0-9_-]{43}$/.test(secret) ? { ...w, secret } : null;
}

/** A delivery JSON object → WebhookDelivery; null if malformed. */
export function parseWebhookDelivery(raw: unknown): WebhookDelivery | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const g = (snake: string, camel: string) => (r[snake] !== undefined ? r[snake] : r[camel]);
  const id = str(r.id), webhookId = str(g("webhook_id", "webhookId")), event = r.event;
  const state = r.state;
  if (!id || !webhookId || typeof event !== "string" || !(EVENTS.has(event) || event === "ping")) return null;
  if (state !== "pending" && state !== "delivered" && state !== "failed") return null;
  return {
    id,
    webhookId,
    outboxId: int(g("outbox_id", "outboxId")) ?? 0,
    event: event as WebhookDeliveryEvent,
    state: state as WebhookDeliveryState,
    attempt: int(r.attempt) ?? 0,
    statusCode: int(g("status_code", "statusCode")),
    error: str(r.error),
    durationMs: int(g("duration_ms", "durationMs")),
    nextAttemptAt: str(g("next_attempt_at", "nextAttemptAt")),
    deliveredAt: str(g("delivered_at", "deliveredAt")),
    createdAt: str(g("created_at", "createdAt")) ?? "",
    updatedAt: str(g("updated_at", "updatedAt")) ?? "",
  };
}

/** A database / network error → why (the messages the 0046 functions raise). */
export function webhookFailure(e: unknown): WebhookFailure {
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  if (code === "42883" || code === "PGRST202" || /could not find the function|does not exist/i.test(msg)) return "unavailable";
  if (/failed to fetch|network|load failed/i.test(msg)) return "network";
  if (/not allowed|not authorized/i.test(msg)) return "not_allowed";
  if (/invalid url/i.test(msg)) return "invalid_url";
  if (/invalid events/i.test(msg)) return "invalid_events";
  if (/too many tests/i.test(msg)) return "too_many_tests";
  if (/too many webhooks/i.test(msg)) return "too_many";
  if (/not found/i.test(msg)) return "not_found";
  return "error";
}

/* ------------------------------------------------------------ copy   [a2] */

/** A refusal, in words people can act on (British English). */
export const WEBHOOK_COPY: Readonly<Record<WebhookFailure, string>> = {
  not_allowed: "You can't manage webhooks there. Owners, admins and members can; guests can't.",
  invalid_url: "Use a public https:// address with a hostname, like https://hooks.example.com/kanbo. IP addresses and internal names aren't allowed.",
  invalid_events: "Choose at least one event.",
  too_many: `That's the limit: ${WEBHOOK_LIMITS.perWorkspace} endpoints a workspace and ${WEBHOOK_LIMITS.personal} personal ones. Delete one you no longer use first.`,
  too_many_tests: `That's ${WEBHOOK_LIMITS.testsPerMinute} test events in a minute. Try again shortly.`,
  not_found: "That endpoint has already gone. It may have been deleted by someone else.",
  unavailable: "Webhooks aren't switched on for Kanbo yet.",
  network: "You're offline. Try again when you're back online.",
  error: "Something went wrong. Try again.",
};

/** The sentence for any error the calls below throw. */
export function webhookErrorText(e: unknown): string {
  const msg = String((e as { message?: unknown })?.message ?? "");
  if (/invalid description/i.test(msg)) return `Keep the description to ${WEBHOOK_LIMITS.description} characters.`;
  if (/already delivered/i.test(msg)) return "That delivery already arrived.";
  if (/too many redeliveries/i.test(msg)) return `That's ${WEBHOOK_LIMITS.redeliveriesPerMinute} sent again in a minute for this endpoint. Try again shortly.`;
  if (/test events can.t be sent again/i.test(msg)) return "Test events aren't sent again. Use Send test for a new one.";
  return WEBHOOK_COPY[webhookFailure(e)];
}

/* ------------------------------------------------------------ the calls   [a2]
   Real: the 0046 definer functions over PostgREST, as the signed-in person.
   They throw an Error carrying the database's message (and code), so
   webhookFailure / webhookErrorText read them. Demo (no Supabase): an
   in-memory fake with realistic endpoints and deliveries. */

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  if (!supabase) throw new Error("could not find the function (demo)");
  if (isOffline()) throw new TypeError("Failed to fetch");
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message || "error"), { code: (error as { code?: string }).code });
  return data;
}

const parseList = <T>(raw: unknown, parse: (x: unknown) => T | null): T[] =>
  (Array.isArray(raw) ? raw : []).map(parse).filter((x): x is T => x !== null);

/** null = your personal webhooks; a workspace id = that workspace's (writers). */
export async function listWebhooks(workspaceId: string | null): Promise<Webhook[]> {
  if (!supabase) return demoList(workspaceId);
  return parseList(await rpc("list_webhooks", { p_workspace: workspaceId }), parseWebhook);
}

export async function createWebhook(input: NewWebhookInput): Promise<CreatedWebhook> {
  const url = String(input.url ?? "").trim();
  if (!isWebhookUrlShapeOk(url)) throw new Error("invalid url");
  const events = [...new Set(input.events ?? [])].filter((e) => EVENTS.has(e));
  if (!events.length) throw new Error("invalid events");
  const description = (input.description ?? "").trim() || null;
  if (description && description.length > WEBHOOK_LIMITS.description) throw new Error("invalid description");
  if (!supabase) return demoCreate({ workspaceId: input.workspaceId ?? null, url, events, description });
  const w = parseCreatedWebhook(await rpc("create_webhook", { p_workspace: input.workspaceId ?? null, p_url: url, p_events: events, p_description: description }));
  if (!w) throw new Error("error");
  return w;
}

export async function updateWebhook(id: string, patch: WebhookPatch): Promise<Webhook> {
  const url = patch.url === undefined ? undefined : String(patch.url).trim();
  if (url !== undefined && !isWebhookUrlShapeOk(url)) throw new Error("invalid url");
  const events = patch.events === undefined ? undefined : [...new Set(patch.events)].filter((e) => EVENTS.has(e));
  if (events !== undefined && !events.length) throw new Error("invalid events");
  // update_webhook: null leaves a field alone; "" clears the description
  const description = patch.description === undefined ? undefined : (patch.description ?? "").trim();
  if (description && description.length > WEBHOOK_LIMITS.description) throw new Error("invalid description");
  if (!supabase) return demoUpdate(id, { url, events, active: patch.active, description });
  const w = parseWebhook(await rpc("update_webhook", {
    p_id: id, p_url: url ?? null, p_events: events ?? null, p_active: patch.active ?? null, p_description: description ?? null,
  }));
  if (!w) throw new Error("error");
  return w;
}

export async function deleteWebhook(id: string): Promise<void> {
  if (!supabase) return demoDelete(id);
  await rpc("delete_webhook", { p_id: id });
}

/** A new signing secret (shown once); the old one stops verifying at once. */
export async function rotateWebhookSecret(id: string): Promise<string> {
  if (!supabase) return demoRotate(id);
  const r = (await rpc("rotate_webhook_secret", { p_id: id })) as { secret?: unknown } | null;
  if (typeof r?.secret !== "string" || !SECRET_RE.test(r.secret)) throw new Error("error");
  return r.secret;
}

/** Queue a test ping to this endpoint. */
export async function sendTestWebhook(id: string): Promise<void> {
  if (!supabase) return demoTest(id);
  await rpc("send_test_webhook", { p_id: id });
}

export async function listWebhookDeliveries(id: string, limit = 25): Promise<WebhookDelivery[]> {
  const n = Math.max(1, Math.min(100, Math.floor(limit) || 25));
  if (!supabase) return demoDeliveries(id, n);
  return parseList(await rpc("list_webhook_deliveries", { p_id: id, p_limit: n }), parseWebhookDelivery);
}

export async function redeliverWebhookDelivery(deliveryId: string): Promise<void> {
  if (!supabase) return demoRedeliver(deliveryId);
  await rpc("redeliver_webhook_delivery", { p_delivery: deliveryId });
}

/* ------------------------------------------------------------ helpers for the panel */

const SECRET_RE = /^whsec_[A-Za-z0-9_-]{43}$/;

/** "hooks.zapier.com/hooks/catch/…/bq9x2kd" — short enough for a row, the host always whole. */
export function shortWebhookUrl(url: string, max = 52): string {
  if (url.includes("…")) return url.replace(/^https:\/\//, ""); // masked already ("hooks.zapier.com/…x2kd")
  let host = url, rest = "";
  try { const u = new URL(url); host = u.host; rest = (u.pathname === "/" ? "" : u.pathname) + u.search; } catch { /* show as given */ }
  const full = host + rest;
  if (full.length <= max) return full;
  const room = Math.max(8, max - host.length - 2);
  const tail = rest.slice(-Math.floor(room * 0.6));
  const head = rest.slice(0, room - tail.length);
  return `${host}${head}…${tail}`;
}

/** Where the endpoint stands, for its row: switched off / failing (retrying) / working / new. */
export type WebhookHealth = "off" | "failing" | "ok" | "new";
export function webhookHealth(w: Pick<Webhook, "active" | "failureCount" | "lastDeliveryAt" | "lastStatus">): WebhookHealth {
  if (!w.active) return "off";
  if (w.failureCount > 0) return "failing";
  return w.lastDeliveryAt ? "ok" : "new";
}

/** member.joined only happens in team workspaces, so personal endpoints never offer it. */
export const PERSONAL_WEBHOOK_EVENTS: readonly WebhookEvent[] = WEBHOOK_EVENTS.filter((e) => e !== "member.joined");

/* ---------- wording, in British English ---------- */
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** "just now" · "4 min ago" · "3 hours ago" · "yesterday" · "28 Sept" */
export function agoText(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const min = Math.round((now - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
  if (h < 48) return "yesterday";
  return dayFmt.format(t);
}

/** "in 26 min" · "at 14:05" · "any moment" (a retry that's due) */
export function soonText(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const min = Math.round((t - now) / 60_000);
  if (min <= 0) return "any moment";
  if (min < 60) return `in ${min} min`;
  return `at ${timeFmt.format(t)}`;
}

/** "Task created, Task completed" · "All events" · "5 events" */
export function eventsSummary(events: readonly WebhookEvent[], personal: boolean): string {
  const all = personal ? PERSONAL_WEBHOOK_EVENTS : WEBHOOK_EVENTS;
  if (all.every((e) => events.includes(e))) return "All events";
  if (events.length <= 2) return events.map((e) => WEBHOOK_EVENT_INFO[e]?.label ?? e).join(", ");
  return `${events.length} events`;
}

/* ------------------------------------------------------------ demo (no Supabase) */

interface DemoHook { hook: Webhook; secret: string; deliveries: WebhookDelivery[]; tests: number[]; resends: number[] }
const demoScopes = new Map<string, DemoHook[]>();
type DemoRole = "owner" | "admin" | "member" | "guest";
const demoRoles = new Map<string, DemoRole>();
let DEMO_DELAY_MS = 350;
let DEMO_ARRIVE_MS = 1200;
let demoOutbox = 4800;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const minutesAhead = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const demoId = () => {
  const b = new Uint8Array(16);
  (globalThis.crypto ?? { getRandomValues: (x: Uint8Array) => x.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const demoSecret = () => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const b = new Uint8Array(43);
  (globalThis.crypto ?? { getRandomValues: (x: Uint8Array) => x.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(b);
  return "whsec_" + Array.from(b, (x) => abc[x & 63]).join("");
};
const DEMO_ME = "00000000-0000-4000-8000-00000000d3e0";

function demoHook(scope: string | null, o: Partial<Webhook> & Pick<Webhook, "url" | "events">, createdMinAgo: number): Webhook {
  return {
    id: demoId(), workspaceId: scope, description: null, active: true, createdBy: DEMO_ME, createdByName: "you",
    failureCount: 0, lastStatus: null, lastError: null, lastDeliveryAt: null, disabledAt: null, disabledReason: null,
    createdAt: minutesAgo(createdMinAgo), updatedAt: minutesAgo(createdMinAgo), canManage: true, ...o,
  };
}
function demoDelivery(hook: Webhook, o: Partial<WebhookDelivery> & Pick<WebhookDelivery, "event" | "state">, minAgo: number): WebhookDelivery {
  const at = minutesAgo(minAgo);
  return {
    id: demoId(), webhookId: hook.id, outboxId: ++demoOutbox, attempt: 1, statusCode: 200, error: null, durationMs: 240,
    nextAttemptAt: null, deliveredAt: o.state === "delivered" ? at : null, createdAt: at, updatedAt: at, ...o,
  };
}

/** Realistic endpoints for a scope, made the first time it's opened. */
function demoSeed(scope: string | null): DemoHook[] {
  const key = scope ?? "personal";
  const have = demoScopes.get(key);
  if (have) return have;
  const out: DemoHook[] = [];
  const add = (hook: Webhook, deliveries: (h: Webhook) => WebhookDelivery[]) => out.push({ hook, secret: demoSecret(), deliveries: deliveries(hook), tests: [], resends: [] });
  if (!scope) {
    add(demoHook(null, { url: "https://hooks.zapier.com/hooks/catch/1234567/pr7k3nx/", description: "My finished tasks into Notion", events: ["task.completed"], lastStatus: 200, lastDeliveryAt: minutesAgo(52) }, 60 * 24 * 21), (h) => [
      demoDelivery(h, { event: "task.completed", state: "delivered", durationMs: 312 }, 52),
      demoDelivery(h, { event: "task.completed", state: "delivered", durationMs: 287 }, 60 * 5 + 14),
      demoDelivery(h, { event: "task.completed", state: "delivered", durationMs: 341 }, 60 * 26),
    ]);
  } else {
    add(demoHook(scope, {
      url: "https://hooks.zapier.com/hooks/catch/1234567/bq9x2kd/", description: "New tasks into the ops sheet",
      events: ["task.completed", "task.created"], createdByName: "Priya Shah", createdBy: "00000000-0000-4000-8000-0000000a11ce",
      lastStatus: 200, lastDeliveryAt: minutesAgo(4),
    }, 60 * 24 * 9), (h) => [
      demoDelivery(h, { event: "task.created", state: "delivered", durationMs: 198 }, 4),
      demoDelivery(h, { event: "task.completed", state: "delivered", durationMs: 236 }, 19),
      demoDelivery(h, { event: "task.created", state: "delivered", durationMs: 411, attempt: 2 }, 47),
      demoDelivery(h, { event: "task.completed", state: "delivered", durationMs: 205 }, 95),
      demoDelivery(h, { event: "ping", state: "delivered", durationMs: 182 }, 60 * 24 * 9 - 2),
    ]);
    add(demoHook(scope, {
      url: "https://api.northwind-studio.co.uk/kanbo/events?client=foundrise", description: "Client portal sync",
      events: ["comment.created", "task.created", "task.deleted", "task.updated"],
      failureCount: 3, lastStatus: 503, lastError: "HTTP 503 Service Unavailable", lastDeliveryAt: minutesAgo(4),
    }, 60 * 24 * 30), (h) => [
      demoDelivery(h, { event: "task.updated", state: "pending", attempt: 3, statusCode: 503, error: "HTTP 503 Service Unavailable", durationMs: 1840, nextAttemptAt: minutesAhead(26) }, 11),
      demoDelivery(h, { event: "comment.created", state: "pending", attempt: 2, statusCode: 503, error: "HTTP 503 Service Unavailable", durationMs: 2210, nextAttemptAt: minutesAhead(1) }, 8),
      demoDelivery(h, { event: "task.created", state: "delivered", durationMs: 356 }, 60 * 3),
      demoDelivery(h, { event: "task.deleted", state: "failed", attempt: 6, statusCode: 0, error: "No answer within 10 seconds.", durationMs: 10000 }, 60 * 14),
      demoDelivery(h, { event: "task.updated", state: "delivered", durationMs: 421 }, 60 * 20),
    ]);
    add(demoHook(scope, {
      url: "https://hook.eu1.make.com/7x4k2p9qv1m8hz3c", description: "Weekly digest (old scenario)",
      events: ["project.created", "project.updated"], createdByName: "Ana Lima", createdBy: "00000000-0000-4000-8000-0000000a7a11",
      active: false, failureCount: 20, lastStatus: 410, lastError: "HTTP 410 Gone", lastDeliveryAt: minutesAgo(60 * 50),
      disabledAt: minutesAgo(60 * 50), disabledReason: "Switched off after 20 failed deliveries in a row",
    }, 60 * 24 * 64), (h) => [
      demoDelivery(h, { event: "project.updated", state: "failed", attempt: 4, statusCode: 410, error: "Endpoint switched off", durationMs: 96 }, 60 * 50),
      demoDelivery(h, { event: "project.updated", state: "failed", attempt: 6, statusCode: 410, error: "HTTP 410 Gone", durationMs: 88 }, 60 * 51),
    ]);
  }
  demoScopes.set(key, out);
  return out;
}

/** The server's rule (webhook_can_manage): your own, or any in a workspace you own or administer. */
function demoCanManage(h: Webhook): boolean {
  if (h.workspaceId === null || h.createdBy === DEMO_ME) return true;
  const role = demoRoles.get(h.workspaceId) ?? "owner";
  return role === "owner" || role === "admin";
}
/** As webhook_json() shows it to you: masked URL unless you can manage it. */
const copyHook = (d: DemoHook): Webhook => {
  const canManage = demoCanManage(d.hook);
  return { ...d.hook, events: [...d.hook.events], canManage, url: canManage ? d.hook.url : maskWebhookUrl(d.hook.url) };
};
function demoFind(id: string, manage = true): DemoHook {
  for (const list of demoScopes.values()) {
    const d = list.find((x) => x.hook.id === id);
    if (d && (!manage || demoCanManage(d.hook))) return d;
  }
  throw new Error("webhook not found");
}
function demoArrive(d: DemoHook, del: WebhookDelivery) {
  setTimeout(() => {
    if (![...demoScopes.values()].some((list) => list.includes(d))) return; // deleted meanwhile
    const now = new Date().toISOString();
    Object.assign(del, { state: "delivered", attempt: del.attempt + 1, statusCode: 200, error: null, durationMs: 180 + Math.floor(Math.random() * 160), deliveredAt: now, updatedAt: now, nextAttemptAt: null });
    Object.assign(d.hook, { lastStatus: 200, lastError: null, lastDeliveryAt: now, failureCount: del.event === "ping" ? d.hook.failureCount : 0, updatedAt: now });
  }, DEMO_ARRIVE_MS);
}

async function demoList(scope: string | null): Promise<Webhook[]> {
  await wait(DEMO_DELAY_MS);
  return demoSeed(scope).map(copyHook);
}
async function demoCreate(input: { workspaceId: string | null; url: string; events: WebhookEvent[]; description: string | null }): Promise<CreatedWebhook> {
  await wait(DEMO_DELAY_MS);
  const list = demoSeed(input.workspaceId);
  if (list.length >= (input.workspaceId ? WEBHOOK_LIMITS.perWorkspace : WEBHOOK_LIMITS.personal)) throw new Error("too many webhooks");
  const hook = demoHook(input.workspaceId, { url: input.url, events: [...input.events].sort(), description: input.description }, 0);
  const d: DemoHook = { hook, secret: demoSecret(), deliveries: [], tests: [], resends: [] };
  list.push(d);
  return { ...copyHook(d), secret: d.secret };
}
async function demoUpdate(id: string, p: { url?: string; events?: WebhookEvent[]; active?: boolean; description?: string }): Promise<Webhook> {
  await wait(DEMO_DELAY_MS);
  const d = demoFind(id);
  const now = new Date().toISOString();
  const h = d.hook;
  if (p.url !== undefined) h.url = p.url;
  if (p.events !== undefined) h.events = [...p.events].sort();
  if (p.description !== undefined) h.description = p.description || null;
  if (p.active === true && !h.active) Object.assign(h, { failureCount: 0, disabledAt: null, disabledReason: null });
  if (p.active === false && h.active) {
    Object.assign(h, { disabledAt: now, disabledReason: "Switched off by hand" });
    for (const del of d.deliveries) if (del.state === "pending") Object.assign(del, { state: "failed", error: del.error ?? "Endpoint switched off", nextAttemptAt: null, updatedAt: now });
  }
  if (p.active !== undefined) h.active = p.active;
  h.updatedAt = now;
  return copyHook(d);
}
async function demoDelete(id: string): Promise<void> {
  await wait(DEMO_DELAY_MS);
  for (const list of demoScopes.values()) {
    const i = list.findIndex((x) => x.hook.id === id && demoCanManage(x.hook));
    if (i >= 0) { list.splice(i, 1); return; }
  }
  throw new Error("webhook not found");
}
async function demoRotate(id: string): Promise<string> {
  await wait(DEMO_DELAY_MS);
  const d = demoFind(id);
  d.secret = demoSecret();
  d.hook.updatedAt = new Date().toISOString();
  return d.secret;
}
async function demoTest(id: string): Promise<void> {
  await wait(DEMO_DELAY_MS);
  const d = demoFind(id);
  const now = Date.now();
  d.tests = d.tests.filter((t) => now - t < 60_000);
  if (d.tests.length >= WEBHOOK_LIMITS.testsPerMinute) throw new Error("too many tests");
  d.tests.push(now);
  const del = demoDelivery(d.hook, { event: "ping", state: "pending", attempt: 0, statusCode: null, durationMs: null }, 0);
  d.deliveries.unshift(del);
  demoArrive(d, del);
}
async function demoDeliveries(id: string, limit: number): Promise<WebhookDelivery[]> {
  await wait(DEMO_DELAY_MS / 2);
  const d = demoFind(id, false);
  return [...d.deliveries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((x) => ({ ...x }));
}
async function demoRedeliver(deliveryId: string): Promise<void> {
  await wait(DEMO_DELAY_MS);
  for (const list of demoScopes.values()) {
    for (const d of list) {
      const del = d.deliveries.find((x) => x.id === deliveryId);
      if (!del) continue;
      if (!demoCanManage(d.hook)) throw new Error("delivery not found");
      if (del.state === "delivered") throw new Error("already delivered");
      if (del.event === "ping") throw new Error("test events can't be sent again");
      const now = Date.now();
      d.resends = d.resends.filter((t) => now - t < 60_000);
      if (d.resends.length >= WEBHOOK_LIMITS.redeliveriesPerMinute) throw new Error("too many redeliveries (retry after 60 s)");
      d.resends.push(now);
      Object.assign(del, { state: "pending", attempt: 0, nextAttemptAt: new Date().toISOString(), error: null, updatedAt: new Date().toISOString() });
      demoArrive(d, del);
      return;
    }
  }
  throw new Error("delivery not found");
}

/**
 * Demo mode only: your role in each team workspace, so the fake follows the
 * server's rules (members manage only their own endpoints and see the
 * others' addresses masked). A workspace not given counts as yours to run.
 */
export function setWebhookDemoRoles(workspaces: readonly { id: string; role: string }[]): void {
  demoRoles.clear();
  for (const w of workspaces) {
    if (w.role === "owner" || w.role === "admin" || w.role === "member" || w.role === "guest") demoRoles.set(w.id, w.role);
  }
}

/** Tests only: forget the demo endpoints; optionally shorten the pretend network delay and arrival time. */
export function resetWebhookDemo(opts: { delayMs?: number; arriveMs?: number } = {}): void {
  demoScopes.clear();
  demoRoles.clear();
  DEMO_DELAY_MS = opts.delayMs ?? 350;
  DEMO_ARRIVE_MS = opts.arriveMs ?? 1200;
}

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
     errors: 'not authorized' | 'not allowed' | 'invalid url' | 'invalid events' |
             'invalid description' | 'too many webhooks' (20 a workspace, 10 personal) |
             'too many tests' | 'webhook not found' | 'delivery not found' | 'already delivered'

   Package a2 implements the async functions (real + demo fakes) and the
   panel; parsers and constants are final.
   ============================================================ */
import type { CreatedWebhook, NewWebhookInput, Webhook, WebhookDelivery, WebhookDeliveryEvent, WebhookDeliveryState, WebhookEvent, WebhookFailure, WebhookPatch } from "../data/types";
import {
  isWebhookUrlShapeOk, MAX_CONSECUTIVE_FAILURES, RETRY_SCHEDULE_MIN, WEBHOOK_EVENT_INFO, WEBHOOK_EVENTS,
} from "../../supabase/functions/_shared/api/webhooks.ts";

export { isWebhookUrlShapeOk, MAX_CONSECUTIVE_FAILURES, RETRY_SCHEDULE_MIN, WEBHOOK_EVENT_INFO, WEBHOOK_EVENTS };

export const WEBHOOK_LIMITS = { perWorkspace: 20, personal: 10, description: 200, url: 2000, testsPerMinute: 5 } as const;

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
  return {
    id,
    workspaceId: str(g("workspace_id", "workspaceId")),
    url,
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
    canManage: g("can_manage", "canManage") === true,
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

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package a2)`));

/** null = your personal webhooks; a workspace id = that workspace's (writers). */
export function listWebhooks(_workspaceId: string | null): Promise<Webhook[]> { return notBuilt("listWebhooks"); }
export function createWebhook(_input: NewWebhookInput): Promise<CreatedWebhook> { return notBuilt("createWebhook"); }
export function updateWebhook(_id: string, _patch: WebhookPatch): Promise<Webhook> { return notBuilt("updateWebhook"); }
export function deleteWebhook(_id: string): Promise<void> { return notBuilt("deleteWebhook"); }
/** A new signing secret (shown once); the old one stops verifying at once. */
export function rotateWebhookSecret(_id: string): Promise<string> { return notBuilt("rotateWebhookSecret"); }
/** Queue a test ping to this endpoint. */
export function sendTestWebhook(_id: string): Promise<void> { return notBuilt("sendTestWebhook"); }
export function listWebhookDeliveries(_id: string, _limit?: number): Promise<WebhookDelivery[]> { return notBuilt("listWebhookDeliveries"); }
export function redeliverWebhookDelivery(_deliveryId: string): Promise<void> { return notBuilt("redeliverWebhookDelivery"); }

/* ============================================================
   KANBO — API keys (Settings › Developers).            [0046 contract → a1]
   Keys are made in Postgres: create_api_key() returns the full key ONCE
   (only its SHA-256 is stored), list_api_keys() / revoke_api_key() manage
   them. All three answer snake_case JSON, parsed here.

   Contract (database 0046):
     rpc create_api_key(p_name, p_workspace uuid|null, p_access 'read'|'write',
                        p_expires_at timestamptz|null) → key JSON + { key }
       errors: 'not authorized' | 'invalid name' | 'invalid access' |
               'invalid expiry' | 'not allowed' (workspace key, not owner/admin) |
               'too many keys' (25 live per person, 50 per workspace)
     rpc list_api_keys(p_workspace uuid|null) → key JSON[] (null: yours;
       a workspace: all of its keys, owners/admins only — else 'not allowed')
     rpc revoke_api_key(p_id) → key JSON ('key not found' if gone / not yours)

   Package a1 implements the async functions (real + demo fakes) and the
   panel; parsers, copy and the base URL are final.
   ============================================================ */
import type { ApiKey, ApiKeyAccess, ApiKeyFailure, ApiKeyStatus, CreatedApiKey, NewApiKeyInput } from "../data/types";
import { API_KEY_RE, API_RATE } from "../../supabase/functions/_shared/api/auth.ts";

export { API_KEY_RE, API_RATE };

export const API_KEY_LIMITS = { name: 80, livePerPerson: 25, livePerWorkspace: 50, maxExpiryYears: 5 } as const;

export const API_KEY_COPY = {
  shownOnce: "Copy this key now. For your security, Kanbo can't show it again.",
  notAllowed: "Only workspace owners and admins can make or see team keys.",
  tooMany: "You've reached the limit for live keys. Revoke one you no longer use first.",
  invalidName: `Give the key a name (up to ${API_KEY_LIMITS.name} characters).`,
  invalidExpiry: "Choose an expiry at least an hour away and within five years.",
  notFound: "That key has already gone.",
  unavailable: "API keys aren't switched on for Kanbo yet.",
  offline: "You're offline. Try again when you're back online.",
  failed: "Couldn't save that. Try again.",
} as const;

/** The API's base address: https://<ref>.supabase.co/functions/v1/api/v1 (demo: a placeholder). */
export function apiBaseUrl(supabaseUrl: string | undefined = import.meta.env.VITE_SUPABASE_URL as string | undefined): string {
  const base = (supabaseUrl ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/\S+$/i.test(base) ? `${base}/functions/v1/api/v1` : "https://YOUR-PROJECT.supabase.co/functions/v1/api/v1";
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** An api_key JSON object (snake_case; camelCase also read) → ApiKey; null if malformed. */
export function parseApiKey(raw: unknown): ApiKey | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const g = (snake: string, camel: string) => (r[snake] !== undefined ? r[snake] : r[camel]);
  const id = str(r.id), name = str(r.name), prefix = str(r.prefix), userId = str(g("user_id", "userId"));
  const access = r.access;
  if (!id || !name || !prefix || !userId || (access !== "read" && access !== "write")) return null;
  const status = g("status", "status");
  return {
    id,
    name,
    prefix,
    access: access as ApiKeyAccess,
    workspaceId: str(g("workspace_id", "workspaceId")),
    workspaceName: str(g("workspace_name", "workspaceName")),
    userId,
    createdByName: str(g("created_by_name", "createdByName")),
    createdAt: str(g("created_at", "createdAt")) ?? "",
    lastUsedAt: str(g("last_used_at", "lastUsedAt")),
    expiresAt: str(g("expires_at", "expiresAt")),
    revokedAt: str(g("revoked_at", "revokedAt")),
    status: (status === "revoked" || status === "expired" ? status : "active") as ApiKeyStatus,
    canRevoke: g("can_revoke", "canRevoke") === true,
  };
}

/** create_api_key()'s answer → CreatedApiKey (null unless it carries a well-formed key). */
export function parseCreatedApiKey(raw: unknown): CreatedApiKey | null {
  const k = parseApiKey(raw);
  const key = (raw as Record<string, unknown> | null)?.key;
  return k && typeof key === "string" && API_KEY_RE.test(key) ? { ...k, key } : null;
}

/** A database / network error → why (the messages the 0046 functions raise). */
export function apiKeyFailure(e: unknown): ApiKeyFailure {
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  if (code === "42883" || code === "PGRST202" || /could not find the function|does not exist/i.test(msg)) return "unavailable";
  if (/failed to fetch|network|load failed/i.test(msg)) return "network";
  if (/not allowed|not authorized/i.test(msg)) return "not_allowed";
  if (/too many keys/i.test(msg)) return "too_many";
  if (/invalid (name|access|expiry)/i.test(msg)) return "invalid";
  if (/key not found/i.test(msg)) return "not_found";
  return "error";
}

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package a1)`));

/** Your keys; with a workspace id, all of that workspace's keys (owners/admins). */
export function listApiKeys(_workspaceId: string | null = null): Promise<ApiKey[]> {
  return notBuilt("listApiKeys");
}

/** Make a key. The answer carries the full key: show it once. */
export function createApiKey(_input: NewApiKeyInput): Promise<CreatedApiKey> {
  return notBuilt("createApiKey");
}

/** Revoke a key (it stops working at once). */
export function revokeApiKey(_id: string): Promise<ApiKey> {
  return notBuilt("revokeApiKey");
}

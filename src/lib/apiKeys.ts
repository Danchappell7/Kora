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

   Real: the three RPCs as the signed-in person (errors are thrown as they
   come, so apiKeyFailure() can say why). Demo mode (no Supabase): an
   in-memory set of realistic keys — "Zapier" (read-only, used 3 days
   ago), "Reporting script" (read & write, expiring soon), a revoked one —
   that create / revoke work against, so Settings › Developers can be
   tried end to end. resetDemoApiKeys() puts them back (tests).
   ============================================================ */
import type { ApiKey, ApiKeyAccess, ApiKeyFailure, ApiKeyStatus, CreatedApiKey, NewApiKeyInput } from "../data/types";
import { API_KEY_RE, API_RATE } from "../../supabase/functions/_shared/api/auth.ts";
import { supabase } from "./supabase";

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

/* ---------- the real thing (0046 RPCs) ---------- */

const asArray = (data: unknown): unknown[] => {
  let v = data;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v : [];
};
const asObject = (data: unknown): unknown => {
  if (typeof data === "string") { try { return JSON.parse(data); } catch { return null; } }
  return Array.isArray(data) ? data[0] : data;
};
const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** Your keys; with a workspace id, all of that workspace's keys (owners/admins). */
export async function listApiKeys(workspaceId: string | null = null): Promise<ApiKey[]> {
  if (!supabase) return demoList(workspaceId);
  if (offline()) throw new TypeError("Failed to fetch");
  const { data, error } = await supabase.rpc("list_api_keys", { p_workspace: workspaceId });
  if (error) throw error;
  return asArray(data).map(parseApiKey).filter((k): k is ApiKey => k !== null);
}

/** Make a key. The answer carries the full key: show it once. */
export async function createApiKey(input: NewApiKeyInput): Promise<CreatedApiKey> {
  if (!supabase) return demoCreate(input);
  if (offline()) throw new TypeError("Failed to fetch");
  const { data, error } = await supabase.rpc("create_api_key", {
    p_name: input.name.trim(), p_workspace: input.workspaceId, p_access: input.access, p_expires_at: input.expiresAt,
  });
  if (error) throw error;
  const made = parseCreatedApiKey(asObject(data));
  if (!made) throw new Error("create_api_key returned something unexpected");
  return made;
}

/** Revoke a key (it stops working at once). */
export async function revokeApiKey(id: string): Promise<ApiKey> {
  if (!supabase) return demoRevoke(id);
  if (offline()) throw new TypeError("Failed to fetch");
  const { data, error } = await supabase.rpc("revoke_api_key", { p_id: id });
  if (error) throw error;
  const k = parseApiKey(asObject(data));
  if (!k) throw new Error("key not found");
  return k;
}

/** The sentence to show for a failure. */
export function apiKeyMessage(e: unknown): string {
  switch (apiKeyFailure(e)) {
    case "not_allowed": return API_KEY_COPY.notAllowed;
    case "too_many": return API_KEY_COPY.tooMany;
    case "invalid": return /expiry/i.test(String((e as { message?: unknown })?.message ?? "")) ? API_KEY_COPY.invalidExpiry : API_KEY_COPY.invalidName;
    case "not_found": return API_KEY_COPY.notFound;
    case "unavailable": return API_KEY_COPY.unavailable;
    case "network": return API_KEY_COPY.offline;
    default: return API_KEY_COPY.failed;
  }
}

/* ---------- demo mode: realistic keys in memory ---------- */

const DEMO_ME = "demo-user";
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
let demoKeys: ApiKey[] = [];
let demoSeq = 0;

function demoSeed(): ApiKey[] {
  const base = { userId: DEMO_ME, createdByName: "You", workspaceId: null, workspaceName: null, revokedAt: null, canRevoke: true } as const;
  return [
    { ...base, id: "demo-key-reporting", name: "Reporting script", prefix: "kanbo_sk_Tm2c", access: "write",
      createdAt: ago(62 * DAY), lastUsedAt: ago(2 * 3_600_000), expiresAt: ahead(12 * DAY), status: "active" },
    { ...base, id: "demo-key-zapier", name: "Zapier", prefix: "kanbo_pk_8fQz", access: "read",
      createdAt: ago(21 * DAY), lastUsedAt: ago(3 * DAY), expiresAt: null, status: "active" },
    { ...base, id: "demo-key-old-ci", name: "Old CI token", prefix: "kanbo_sk_Lw0e", access: "write",
      createdAt: ago(140 * DAY), lastUsedAt: ago(9 * DAY), expiresAt: null, revokedAt: ago(5 * DAY), status: "revoked", canRevoke: false },
  ];
}

/** Put the demo keys back as they started (tests; a fresh demo session). */
export function resetDemoApiKeys(): void {
  demoKeys = demoSeed();
  demoSeq = 0;
}
resetDemoApiKeys();

const demoStatus = (k: ApiKey): ApiKey => (k.status === "active" && k.expiresAt && Date.parse(k.expiresAt) <= Date.now() ? { ...k, status: "expired" } : k);
const demoLive = (k: ApiKey) => demoStatus(k).status === "active";
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function demoList(workspaceId: string | null): Promise<ApiKey[]> {
  await tick();
  if (workspaceId && !demoKeys.some((k) => k.workspaceId === workspaceId)) {
    // a teammate's key, so an owner/admin's team view has something to manage
    demoKeys.push({
      id: `demo-key-team-${workspaceId}`, name: "Warehouse export", prefix: "kanbo_pk_Qa7d", access: "read", workspaceId,
      workspaceName: null, userId: "demo-teammate", createdByName: "Priya Shah", createdAt: ago(34 * DAY), lastUsedAt: ago(20 * 60_000),
      expiresAt: ahead(300 * DAY), revokedAt: null, status: "active", canRevoke: true,
    });
  }
  return demoKeys
    .filter((k) => (workspaceId ? k.workspaceId === workspaceId : k.userId === DEMO_ME))
    .map(demoStatus)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function randomKeyBody(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function demoCreate(input: NewApiKeyInput): Promise<CreatedApiKey> {
  await tick();
  const name = (input.name ?? "").trim();
  if (!name || name.length > API_KEY_LIMITS.name) throw new Error("invalid name");
  if (input.access !== "read" && input.access !== "write") throw new Error("invalid access");
  if (input.expiresAt) {
    const t = Date.parse(input.expiresAt);
    if (!Number.isFinite(t) || t < Date.now() + 3_600_000 || t > Date.now() + API_KEY_LIMITS.maxExpiryYears * 365.25 * DAY) throw new Error("invalid expiry");
  }
  if (demoKeys.filter((k) => k.userId === DEMO_ME && demoLive(k)).length >= API_KEY_LIMITS.livePerPerson) throw new Error("too many keys");
  const key = `${input.access === "write" ? "kanbo_sk_" : "kanbo_pk_"}${randomKeyBody()}`;
  const made: ApiKey = {
    id: `demo-key-${++demoSeq}-${Date.now().toString(36)}`, name, prefix: key.slice(0, 13), access: input.access,
    workspaceId: input.workspaceId, workspaceName: null, userId: DEMO_ME, createdByName: "You", createdAt: new Date().toISOString(),
    lastUsedAt: null, expiresAt: input.expiresAt, revokedAt: null, status: "active", canRevoke: true,
  };
  demoKeys.push(made);
  return { ...made, key };
}

async function demoRevoke(id: string): Promise<ApiKey> {
  await tick();
  const i = demoKeys.findIndex((k) => k.id === id);
  if (i < 0 || !demoKeys[i].canRevoke) throw new Error("key not found");
  demoKeys[i] = { ...demoKeys[i], revokedAt: demoKeys[i].revokedAt ?? new Date().toISOString(), status: "revoked", canRevoke: false };
  return demoKeys[i];
}

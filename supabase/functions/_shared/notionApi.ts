// ============================================================
// KANBO — Notion: the API client (0046).                             [a3]
//
// Pure (fetch, sleep and the clock are passed in): the notion edge function
// uses the real ones, vitest and the PGlite replay a fake Notion.
//
//   • Notion-Version 2022-06-28, bearer = the workspace's integration token.
//     The token is only ever put in the Authorization header: never in a
//     URL, a log line or an error message.
//   • Pacing: Notion allows about 3 requests a second per integration, so
//     requests with the same token are spaced ≥ 340 ms apart (per isolate),
//     and a 429 waits for Retry-After (then gives up if the run's deadline
//     would pass). 409 / 5xx / network errors are retried twice.
//   • Errors become NotionApiError with a kind the function maps to a
//     sentence: invalid_token (401), not_shared (403 / 404: not shared
//     with the integration, or gone), rate_limited, archived, validation,
//     conflict, unavailable, network, timeout (the run's time is up).
// ============================================================
import { NOTION_API, NOTION_RATE_PER_SEC, NOTION_VERSION } from "./notion.ts";
import type { NDatabase, NPage, NUser } from "./notionMap.ts";

export type NotionErrorKind =
  | "invalid_token" | "not_shared" | "rate_limited" | "archived" | "validation" | "conflict" | "unavailable" | "network" | "timeout";

export class NotionApiError extends Error {
  readonly kind: NotionErrorKind;
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  constructor(kind: NotionErrorKind, status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.name = "NotionApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}
export const isNotionError = (e: unknown): e is NotionApiError => e instanceof NotionApiError;

export interface NotionHttp {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** epoch ms after which no new request starts (the run's time budget) */
  deadline?: number;
  /** per request (default 20 s) */
  timeoutMs?: number;
}

export interface NotionList<T> { results: T[]; next_cursor: string | null; has_more: boolean }
export interface NotionBot extends NUser { bot?: { workspace_name?: string | null; owner?: Record<string, unknown> } | null }

export interface NotionApi {
  me(): Promise<NotionBot>;
  searchDatabases(query?: string, cursor?: string | null): Promise<NotionList<NDatabase>>;
  database(id: string): Promise<NDatabase>;
  query(databaseId: string, body: Record<string, unknown>): Promise<NotionList<NPage>>;
  page(id: string): Promise<NPage>;
  updatePage(id: string, properties: Record<string, unknown>): Promise<NPage>;
  users(cursor?: string | null): Promise<NotionList<NUser>>;
  /** requests made so far (retries included) */
  readonly calls: number;
}

const GAP_MS = Math.ceil(1000 / NOTION_RATE_PER_SEC) + 6;    // 340 ms
const MAX_RETRY_AFTER_S = 30;
/** next free slot per token (in this isolate) */
const slots = new Map<string, number>();
const ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function classify(status: number, message: string): NotionErrorKind {
  if (status === 401) return "invalid_token";
  if (status === 403 || status === 404) return "not_shared";
  if (status === 429) return "rate_limited";
  if (status === 409) return "conflict";
  if (status === 400 && /archived|in trash/i.test(message)) return "archived";
  if (status >= 400 && status < 500) return "validation";
  return "unavailable";
}

/** Seconds from a Retry-After header (seconds or an HTTP date); default 1. */
export function retryAfterSeconds(h: string | null, now = Date.now()): number {
  if (!h) return 1;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return Math.max(1, Math.ceil(n));
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(1, Math.ceil((t - now) / 1000)) : 1;
}

export function notionApi(token: string, http: NotionHttp): NotionApi {
  const sleep = http.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = http.now ?? (() => Date.now());
  const timeoutMs = http.timeoutMs ?? 20_000;
  let calls = 0;

  const turn = async () => {
    const t = now();
    const slot = Math.max(t, slots.get(token) ?? 0);
    slots.set(token, slot + GAP_MS);
    if (slots.size > 500) for (const [k, v] of slots) if (v < t) slots.delete(k);
    if (slot > t) await sleep(slot - t);
  };
  const outOfTime = (extraMs = 0) => http.deadline != null && now() + extraMs > http.deadline;

  async function request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (outOfTime()) throw new NotionApiError("timeout", 0, "timeout", "Out of time for this run.");
      await turn();
      calls++;
      let res: Response;
      try {
        const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined;
        res = await http.fetch(NOTION_API + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          ...(signal ? { signal } : {}),
        });
      } catch {
        if (attempt < 2 && !outOfTime(1000)) { await sleep(500 * (attempt + 1)); continue; }
        throw new NotionApiError("network", 0, "network", "Couldn't reach Notion.");
      }
      if (res.ok) {
        try { return (await res.json()) as T; } catch { throw new NotionApiError("unavailable", res.status, "bad_json", "Notion sent something Kanbo couldn't read."); }
      }
      let code = "", message = "";
      try {
        const e = (await res.json()) as { code?: unknown; message?: unknown };
        code = typeof e?.code === "string" ? e.code.slice(0, 60) : "";
        message = typeof e?.message === "string" ? e.message.slice(0, 300) : "";
      } catch { /* not JSON */ }
      const kind = classify(res.status, message);
      if (kind === "rate_limited") {
        const wait = Math.min(retryAfterSeconds(res.headers.get("retry-after"), now()), MAX_RETRY_AFTER_S);
        // everyone using this token waits too
        slots.set(token, Math.max(slots.get(token) ?? 0, now() + wait * 1000));
        if (attempt < 3 && !outOfTime(wait * 1000 + 1000)) { await sleep(wait * 1000); continue; }
        throw new NotionApiError("rate_limited", 429, code || "rate_limited", "Notion asked Kanbo to slow down.", wait);
      }
      if ((kind === "conflict" || kind === "unavailable") && attempt < 2 && !outOfTime(2000)) { await sleep(750 * (attempt + 1)); continue; }
      throw new NotionApiError(kind, res.status, code || String(res.status), message || `Notion answered ${res.status}.`);
    }
  }

  const id = (s: string) => {
    if (!ID_RE.test(s)) throw new NotionApiError("validation", 400, "bad_id", "That isn't a Notion id.");
    return encodeURIComponent(s);
  };
  const cursorOf = (c?: string | null) => (c && /^[A-Za-z0-9-]{1,120}$/.test(c) ? c : undefined);

  return {
    get calls() { return calls; },
    me: () => request<NotionBot>("GET", "/users/me"),
    searchDatabases: (query, cursor) => request<NotionList<NDatabase>>("POST", "/search", {
      ...(query?.trim() ? { query: query.trim().slice(0, 100) } : {}),
      filter: { property: "object", value: "database" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 100,
      ...(cursorOf(cursor) ? { start_cursor: cursorOf(cursor) } : {}),
    }),
    database: async (dbId) => request<NDatabase>("GET", `/databases/${id(dbId)}`),
    query: async (dbId, body) => request<NotionList<NPage>>("POST", `/databases/${id(dbId)}/query`, body),
    page: async (pageId) => request<NPage>("GET", `/pages/${id(pageId)}`),
    updatePage: async (pageId, properties) => request<NPage>("PATCH", `/pages/${id(pageId)}`, { properties }),
    users: (cursor) => request<NotionList<NUser>>("GET", `/users?page_size=100${cursorOf(cursor) ? `&start_cursor=${encodeURIComponent(cursorOf(cursor)!)}` : ""}`),
  };
}

/** Forget the pacing state (tests). */
export function resetNotionPacing() { slots.clear(); }

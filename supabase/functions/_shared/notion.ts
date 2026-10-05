// ============================================================
// KANBO — Notion: the shared contract (0046).                    [architect → a3]
//
// Shared by the notion edge function and the app (src/lib/notion.ts).
// Package a3 adds the Notion API client, property readers / writers and the
// sync engine (pure parts here or in their own _shared module, with tests).
//
// Notion API: https://api.notion.com/v1, header Notion-Version: 2022-06-28,
// bearer = the workspace's internal integration token (service role only:
// workspace_integrations.notion_token). Average 3 requests a second per
// integration: pace requests and back off on 429 (Retry-After).
//
// Pure module (no Deno globals): notion.test.ts.
// ============================================================

export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2022-06-28";
/** Where an owner creates the internal integration. */
export const NOTION_INTEGRATIONS_URL = "https://www.notion.so/profile/integrations";
/** Requests per second Notion allows on average. */
export const NOTION_RATE_PER_SEC = 3;
/** The shape the database accepts (workspace_integrations_notion check). */
export const NOTION_TOKEN_RE = /^(secret_|ntn_)[A-Za-z0-9]{20,180}$/;

/** Which Notion property feeds each Kanbo field (notion_syncs.mapping). */
export interface NotionFieldMapping {
  /** the title property's name (required) */
  title: string;
  /** a status or select property, and how its options map to Kanbo statuses */
  status?: { property: string; values: Record<string, "todo" | "progress" | "review" | "blocked" | "done"> } | null;
  /** a date property: start → due date (or start date when it has an end), end → due date */
  due?: { property: string } | null;
  /** a people property, matched to workspace members by email */
  assignee?: { property: string } | null;
  /** a multi-select property → tags */
  tags?: { property: string } | null;
  /** a rich-text property (its first paragraph) → description */
  description?: { property: string } | null;
}

/**
 * A Notion page / database id from a pasted URL or id: 32 hex digits,
 * dashed or not → the dashed lower-case form (the same as the database's
 * notion_norm_id). Null when there's no id in it.
 *   https://www.notion.so/acme/Launch-brief-89abcdef0123456789abcdef01234567?pvs=4
 *   https://acme.notion.site/89abcdef0123456789abcdef01234567
 *   89abcdef-0123-4567-89ab-cdef01234567
 */
export function parseNotionId(input: string): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s || s.length > 2000) return null;
  let candidate = s;
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    const host = u.hostname.toLowerCase();
    if (!(host === "notion.so" || host.endsWith(".notion.so") || host === "notion.site" || host.endsWith(".notion.site"))) return null;
    // a page opened as a peek in a database view: ?p=<id>
    const peek = u.searchParams.get("p");
    candidate = peek && /[0-9a-f]{32}/i.test(peek.replace(/-/g, "")) ? peek : (u.pathname.split("/").filter(Boolean).pop() ?? "");
  }
  const hexOnly = candidate.replace(/-/g, "");
  const m = /([0-9a-f]{32})$/i.exec(hexOnly);
  if (!m) return null;
  const x = m[1].toLowerCase();
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** A Notion page's address from its id (for a chip whose page isn't cached yet). */
export function notionPageUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

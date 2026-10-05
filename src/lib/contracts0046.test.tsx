/* The 0046 contract pieces the architect wrote as final (parsers, error
   mapping, addresses, component props). The JSON below is exactly what the
   0046 definer functions return (captured from the PGlite replay), so a
   change on either side shows up here. Kept in its own file so no package
   edits it. */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { apiBaseUrl, apiKeyFailure, listApiKeys, parseApiKey, parseCreatedApiKey } from "./apiKeys";
import { parseCreatedWebhook, parseWebhook, parseWebhookDelivery, webhookFailure, WEBHOOK_EVENTS, isWebhookUrlShapeOk } from "./webhooks";
import { notionFailure, parseNotionId, parseNotionLink, parseNotionStatus, parseNotionSync } from "./notion";
import { buildOpenApi } from "../../supabase/functions/_shared/api/openapi.ts";
import { ApiDocs, DevelopersPanel, NotionPanel, WebhooksPanel } from "../components/settings";
import { NotionLinkChip } from "../components/NotionLinkChip";

const CREATED_KEY = {
  id: "9c78f0f3-412c-4a1f-b393-3124631da302", key: "kanbo_pk_G6V69SndWErk4HgPZh10jg2WURvdp-MjLekw7j-G-hs", name: "Zapier",
  access: "read", prefix: "kanbo_pk_G6V6", status: "active", user_id: "bbbbbbbb-0000-4000-8000-000000000002", can_revoke: true,
  created_at: "2026-10-05T18:04:26.19+00:00", expires_at: null, revoked_at: null, last_used_at: null, workspace_id: null,
  workspace_name: null, created_by_name: "Bob",
};
const CREATED_HOOK = {
  id: "c924fcff-0938-4900-a8e7-9cbbb564a762", url: "https://hooks.example.com/kanbo?team=w", active: true,
  events: ["comment.created", "member.joined", "task.completed", "task.created", "task.deleted", "task.updated"],
  secret: "whsec_jdGsQXdTNkPSgmI33ZLnz23lIrUXcu9vDtOYAOWNaJQ", can_manage: true, created_at: "2026-10-05T18:04:26.295+00:00",
  created_by: "bbbbbbbb-0000-4000-8000-000000000002", last_error: null, updated_at: "2026-10-05T18:04:26.295+00:00",
  description: null, disabled_at: null, last_status: null, workspace_id: "11111111-0000-4000-8000-000000000001",
  failure_count: 0, created_by_name: "Bob", disabled_reason: null, last_delivery_at: null,
};
const DELIVERY = {
  id: "1aefcd04-d7e3-4f30-96e8-2a7008b6045c", error: "timeout", event: "comment.created", state: "failed", attempt: 6,
  outbox_id: 4, created_at: "2026-10-05T18:04:26.351+00:00", updated_at: "2026-10-05T18:04:26.368+00:00",
  webhook_id: "c924fcff-0938-4900-a8e7-9cbbb564a762", duration_ms: 10000, status_code: 0, delivered_at: null, next_attempt_at: null,
};
const NOTION_STATUS = {
  bot_id: "bot-1", can_link: true, connected: true, can_manage: true, sync_count: 0, token_hint: "…C3d4",
  connected_at: "2026-10-05T18:04:38.386+00:00", workspace_name: "Acme Notion", connected_by_name: "Adm",
};
const SYNC = {
  id: "b2dde350-6e75-4316-b810-dee367b46e36", stats: {}, enabled: true,
  mapping: { due: { property: "Date" }, title: "Name", status: { values: { Done: "done", "Not started": "todo" }, property: "Status" } },
  direction: "two_way", created_at: "2026-10-05T18:04:38.397+00:00", created_by: "ffffffff-0000-4000-8000-000000000006", last_error: null,
  project_id: "66666666-0000-4000-8000-000000000001", updated_at: "2026-10-05T18:04:38.397+00:00",
  database_id: "01234567-89ab-cdef-0123-456789abcdef", last_cursor: null, last_run_at: null,
  workspace_id: "11111111-0000-4000-8000-000000000001", last_error_at: null, database_title: "Content calendar",
  created_by_name: "Adm", last_success_at: null,
};
const LINK = {
  id: "7ab76f4b-0054-47f8-8cfc-a21aeb0b7b95", kind: "reference",
  page: { url: "https://www.notion.so/acme/Launch-brief-89abcdef0123456789abcdef01234567", icon: "🚀", title: "Launch brief", archived: false, fetched_at: "2026-10-05T18:04:38.407+00:00", last_edited_time: null },
  sync_id: null, task_id: "33333333-0000-4000-8000-000000000001", created_at: "2026-10-05T18:04:38.405+00:00",
  created_by: "bbbbbbbb-0000-4000-8000-000000000002", workspace_id: "11111111-0000-4000-8000-000000000001", last_synced_at: null,
  notion_page_id: "89abcdef-0123-4567-89ab-cdef01234567", notion_database_id: null, notion_last_edited: null,
};

describe("API keys", () => {
  it("parses create_api_key's answer, the full key included once", () => {
    const k = parseCreatedApiKey(CREATED_KEY)!;
    expect(k).toMatchObject({ id: CREATED_KEY.id, name: "Zapier", prefix: "kanbo_pk_G6V6", access: "read", workspaceId: null, status: "active", canRevoke: true, createdByName: "Bob" });
    expect(k.key).toBe(CREATED_KEY.key);
    const { key: _drop, ...listed } = CREATED_KEY;
    expect(parseApiKey(listed)).not.toHaveProperty("key");
    expect(parseCreatedApiKey(listed)).toBeNull();
    expect(parseApiKey({ ...listed, access: "admin" })).toBeNull();
    expect(parseApiKey({ ...listed, status: "revoked" })?.status).toBe("revoked");
  });
  it("maps the database's errors", () => {
    expect(apiKeyFailure(new Error("not allowed"))).toBe("not_allowed");
    expect(apiKeyFailure(new Error("too many keys"))).toBe("too_many");
    expect(apiKeyFailure(new Error("invalid expiry"))).toBe("invalid");
    expect(apiKeyFailure(new Error("key not found"))).toBe("not_found");
    expect(apiKeyFailure({ code: "PGRST202", message: "Could not find the function public.create_api_key" })).toBe("unavailable");
    expect(apiKeyFailure(new TypeError("Failed to fetch"))).toBe("network");
  });
  it("the API's address", () => {
    expect(apiBaseUrl("https://htnchiljplrnjkwimgla.supabase.co/")).toBe("https://htnchiljplrnjkwimgla.supabase.co/functions/v1/api/v1");
    expect(apiBaseUrl("")).toContain("YOUR-PROJECT");
  });
  it("the async calls are built (demo mode here: realistic fake keys)", async () => {
    await expect(listApiKeys()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: "Zapier", access: "read" })]));
  });
});

describe("webhooks", () => {
  it("parses create_webhook's answer (secret once) and list rows (never a secret)", () => {
    const w = parseCreatedWebhook(CREATED_HOOK)!;
    expect(w).toMatchObject({ id: CREATED_HOOK.id, workspaceId: CREATED_HOOK.workspace_id, active: true, failureCount: 0, canManage: true, events: CREATED_HOOK.events });
    expect(w.secret).toMatch(/^whsec_/);
    const { secret: _s, ...listed } = CREATED_HOOK;
    expect(parseWebhook(listed)).not.toHaveProperty("secret");
    expect(parseWebhook({ ...listed, events: ["task.created", "user.deleted"] })?.events).toEqual(["task.created"]);
  });
  it("parses a delivery", () => {
    expect(parseWebhookDelivery(DELIVERY)).toEqual({
      id: DELIVERY.id, webhookId: DELIVERY.webhook_id, outboxId: 4, event: "comment.created", state: "failed", attempt: 6,
      statusCode: 0, error: "timeout", durationMs: 10000, nextAttemptAt: null, deliveredAt: null,
      createdAt: DELIVERY.created_at, updatedAt: DELIVERY.updated_at,
    });
    expect(parseWebhookDelivery({ ...DELIVERY, event: "ping" })?.event).toBe("ping");
    expect(parseWebhookDelivery({ ...DELIVERY, state: "lost" })).toBeNull();
  });
  it("maps the database's errors; shares the event list and URL rule", () => {
    expect(webhookFailure(new Error("invalid url"))).toBe("invalid_url");
    expect(webhookFailure(new Error("too many tests"))).toBe("too_many_tests");
    expect(webhookFailure(new Error("too many webhooks"))).toBe("too_many");
    expect(webhookFailure(new Error("webhook not found"))).toBe("not_found");
    expect(WEBHOOK_EVENTS).toHaveLength(8);
    expect(isWebhookUrlShapeOk("https://10.0.0.1/x")).toBe(false);
  });
});

describe("Notion", () => {
  it("parses status, sync and link", () => {
    expect(parseNotionStatus(NOTION_STATUS)).toEqual({
      connected: true, workspaceName: "Acme Notion", botId: "bot-1", tokenHint: "…C3d4", connectedAt: NOTION_STATUS.connected_at,
      connectedByName: "Adm", canManage: true, canLink: true, syncCount: 0,
    });
    expect(parseNotionStatus(null)).toBeNull();
    const s = parseNotionSync(SYNC)!;
    expect(s).toMatchObject({ databaseId: SYNC.database_id, databaseTitle: "Content calendar", direction: "two_way", enabled: true, createdByName: "Adm" });
    expect(s.mapping.title).toBe("Name");
    expect(s.mapping.status?.values.Done).toBe("done");
    expect(parseNotionSync({ ...SYNC, mapping: {} })).toBeNull();
    const l = parseNotionLink(LINK)!;
    expect(l).toMatchObject({ pageId: LINK.notion_page_id, kind: "reference", taskId: LINK.task_id, page: { title: "Launch brief", icon: "🚀" } });
    expect(parseNotionLink({ ...LINK, page: null })?.page).toBeNull();
  });
  it("maps errors; reads pasted page links", () => {
    expect(notionFailure(new Error("notion not connected"))).toBe("not_connected");
    expect(notionFailure(new Error("invalid token"))).toBe("invalid_token");
    expect(notionFailure(new Error("notion links need a team task"))).toBe("invalid");
    expect(parseNotionId("https://www.notion.so/acme/Launch-brief-89abcdef0123456789abcdef01234567")).toBe(LINK.notion_page_id);
  });
});

describe("OpenAPI skeleton and stub components", () => {
  it("buildOpenApi is a valid 3.1 document with bearer auth", () => {
    const doc = buildOpenApi("https://x.supabase.co/functions/v1/api/v1/");
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://x.supabase.co/functions/v1/api/v1");
    expect(doc.components?.securitySchemes).toHaveProperty("bearerAuth");
  });
  it("the panels and chip mount with their final props", () => {
    const ws = [{ id: "w", name: "Acme", role: "owner" as const }];
    const { container } = render(<>
      <DevelopersPanel workspaces={ws} currentWorkspaceId="w" onOpenDocs={() => {}} />
      <ApiDocs baseUrl={apiBaseUrl("https://x.supabase.co")} keyHint="kanbo_sk_Ab3x" />
      <WebhooksPanel workspaces={ws} currentWorkspaceId={null} />
      <NotionPanel workspaceId="w" workspaceName="Acme" role="owner" projects={[{ id: "p", name: "Launch", emoji: "🚀", color: "oklch(0.7 0.1 30)" }]} />
      <NotionLinkChip taskId="t" workspaceId="w" canEdit />
    </>);
    expect(container).toBeTruthy();
  });
});

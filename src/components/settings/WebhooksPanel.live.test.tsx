/* Settings › Developers › Webhooks against a database that's signed in: one before 0054 (its
   webhook_event_names() is 0048's eleven, so create_webhook / update_webhook refuse
   status_update.posted) and one after. A newer event is only offered once the database takes it. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) }, isSupabaseConfigured: true }));

import { WebhooksPanel } from "./WebhooksPanel";
import { eventsSummary, forgetAcceptedWebhookEvents, PERSONAL_WEBHOOK_EVENTS } from "../../lib/webhooks";
import type { WebhookEvent } from "../../data/types";

const OLD: WebhookEvent[] = ["task.created", "task.updated", "task.completed", "task.deleted", "comment.created", "project.created", "project.updated",
  "member.joined", "approval.requested", "approval.decided", "kudos.given"];
const NEW: WebhookEvent[] = [...OLD, "status_update.posted"];
const OLD_PERSONAL = PERSONAL_WEBHOOK_EVENTS.filter((e) => e !== "status_update.posted");
const hookRow = (events: string[]) => ({ id: "wh-1", workspace_id: null, created_by: "me", url: "https://hooks.example.com/old", events, active: true,
  failure_count: 0, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", can_manage: true });

/** The database: what webhook_event_names() lists, and the endpoints it has. */
function database(names: readonly string[] | "missing", existing: unknown[] = []) {
  const taken = new Set(names === "missing" ? OLD : names);
  rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "webhook_event_names") return names === "missing" ? { data: null, error: { code: "PGRST202", message: "Could not find the function" } } : { data: [...names], error: null };
    if (fn === "list_webhooks") return { data: existing, error: null };
    if (fn === "list_webhook_deliveries") return { data: [], error: null };
    if (fn === "create_webhook" || fn === "update_webhook") {
      const evs = args.p_events as string[] | null;
      if (evs && !evs.every((e) => taken.has(e))) return { data: null, error: { code: "P0001", message: "invalid events" } };
      return { data: { ...hookRow(evs ?? OLD_PERSONAL), id: fn === "create_webhook" ? "wh-new" : "wh-1", url: args.p_url ?? "https://hooks.example.com/old", secret: "whsec_" + "a".repeat(43) }, error: null };
    }
    return { data: null, error: null };
  });
}
const sent = (fn: string) => rpc.mock.calls.filter((c) => c[0] === fn).map((c) => (c[1] as { p_events: string[] }).p_events);

beforeEach(() => { rpc.mockReset(); forgetAcceptedWebhookEvents(); });

describe("webhooks on a database before 0054", () => {
  it("Choose all picks the events it takes (no status_update.posted), and the endpoint is added", async () => {
    database(OLD);
    render(<WebhooksPanel workspaces={[]} currentWorkspaceId={null} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add endpoint/ }));
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "https://hooks.example.com/kanbo" } });
    const form = screen.getByRole("form", { name: "Add a webhook endpoint" });
    expect(within(form).queryByRole("group", { name: "Project updates" })).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Choose all" }));
    expect(within(form).getByRole("button", { name: "Clear all" })).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: /Add endpoint/ }));
    await waitFor(() => expect(sent("create_webhook")).toHaveLength(1));
    expect(sent("create_webhook")[0]).toEqual(OLD_PERSONAL);
    expect(await screen.findByText(/Endpoint added/)).toBeInTheDocument();
    expect(screen.queryByText("Choose at least one event.")).toBeNull();
  });

  it("an endpoint with every event it takes reads 'All events', and editing it keeps them (Choose all is already all)", async () => {
    database(OLD, [hookRow(OLD_PERSONAL)]);
    render(<WebhooksPanel workspaces={[]} currentWorkspaceId={null} />);
    expect(await screen.findByText("All events")).toBeInTheDocument();
    expect(eventsSummary(OLD_PERSONAL, true, OLD)).toBe("All events");
  });

  it("a team endpoint: Choose all sends the eleven, and the database takes them", async () => {
    database(OLD);
    const ws = [{ id: "11111111-0000-4000-8000-000000000001", name: "Foundrise", role: "admin" as const }];
    render(<WebhooksPanel workspaces={ws} currentWorkspaceId={ws[0].id} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add endpoint/ }));
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "https://hooks.example.com/kanbo" } });
    const form = screen.getByRole("form", { name: "Add a webhook endpoint" });
    fireEvent.click(within(form).getByRole("button", { name: "Choose all" }));
    fireEvent.click(within(form).getByRole("button", { name: /Add endpoint/ }));
    await waitFor(() => expect(sent("create_webhook")).toHaveLength(1));
    expect([...sent("create_webhook")[0]].sort()).toEqual([...OLD].sort());
  });

  it("when the database can't say which it takes, only the ones every database since 0048 takes are offered", async () => {
    database("missing");
    render(<WebhooksPanel workspaces={[]} currentWorkspaceId={null} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add endpoint/ }));
    const form = screen.getByRole("form", { name: "Add a webhook endpoint" });
    expect(within(form).queryByText("status_update.posted")).toBeNull();
  });

  it("a refusal of events someone did choose says so, not 'Choose at least one event.'", async () => {
    // (the list said 0054's event was there; the endpoint's database disagrees)
    database(NEW);
    rpc.mockImplementation(async (fn: string) => {
      if (fn === "webhook_event_names") return { data: NEW, error: null };
      if (fn === "list_webhooks") return { data: [], error: null };
      if (fn === "create_webhook") return { data: null, error: { code: "P0001", message: "invalid events" } };
      return { data: null, error: null };
    });
    render(<WebhooksPanel workspaces={[]} currentWorkspaceId={null} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add endpoint/ }));
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "https://hooks.example.com/kanbo" } });
    const form = screen.getByRole("form", { name: "Add a webhook endpoint" });
    fireEvent.click(within(form).getByRole("button", { name: /Add endpoint/ }));
    expect(await within(form).findByText(/can't send one of those events yet/)).toBeInTheDocument();
    expect(within(form).queryByText("Choose at least one event.")).toBeNull();
  });
});

describe("webhooks once 0054 is in", () => {
  it("project updates get a checkbox of their own, and Choose all includes them", async () => {
    database(NEW);
    render(<WebhooksPanel workspaces={[]} currentWorkspaceId={null} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add endpoint/ }));
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "https://hooks.example.com/kanbo" } });
    const form = screen.getByRole("form", { name: "Add a webhook endpoint" });
    const updates = within(form).getByRole("group", { name: "Project updates" });
    const box = within(updates).getByRole("checkbox", { name: /Project update posted/ });
    expect(box).not.toBeChecked();
    fireEvent.click(within(form).getByRole("button", { name: "Choose all" }));
    expect(box).toBeChecked();
    fireEvent.click(box);   // and it can be left out on its own
    fireEvent.click(within(form).getByRole("button", { name: /Add endpoint/ }));
    await waitFor(() => expect(sent("create_webhook")).toHaveLength(1));
    expect(sent("create_webhook")[0]).toEqual(OLD_PERSONAL);
  });
});

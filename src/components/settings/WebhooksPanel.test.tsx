/* Settings › Developers › Webhooks, in demo mode (lib/webhooks' in-memory fake). */
import { StrictMode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WebhooksPanel } from "./WebhooksPanel";
import { agoText, eventsSummary, listWebhooks, resetWebhookDemo, soonText } from "../../lib/webhooks";
import type { DevWorkspace } from "./DevelopersPanel";

const WS: DevWorkspace[] = [
  { id: "11111111-0000-4000-8000-000000000001", name: "Foundrise", role: "admin" },
  { id: "22222222-0000-4000-8000-000000000002", name: "Client: Northwind", role: "guest" },
];
const group = () => screen.getByRole("region", { name: "Webhooks" });

beforeEach(() => resetWebhookDemo({ delayMs: 0, arriveMs: 5 }));

describe("WebhooksPanel", () => {
  it("opens on the current workspace with its endpoints; guests' workspaces aren't offered", async () => {
    render(<StrictMode><WebhooksPanel workspaces={WS} currentWorkspaceId={WS[0].id} /></StrictMode>);
    const select = screen.getByLabelText("Endpoints for") as HTMLSelectElement;
    expect(select.value).toBe(WS[0].id);
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Personal (your own tasks and projects)", "Foundrise"]);
    expect(screen.getByText(/You're a guest in Client: Northwind/)).toBeInTheDocument();
    expect(await within(group()).findByText("hooks.zapier.com/hooks/catch/1234567/bq9x2kd/")).toBeInTheDocument();
    expect(within(group()).getByText("Working")).toBeInTheDocument();
    expect(within(group()).getByText("Retrying")).toBeInTheDocument();
    expect(within(group()).getByText("Switched off")).toBeInTheDocument();
    expect(within(group()).getByText(/Switched off after 20 failed deliveries in a row/)).toBeInTheDocument();
    // each switch is named for its endpoint and says whether it's on
    expect(screen.getByRole("switch", { name: "Send events to hook.eu1.make.com" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "Send events to hooks.zapier.com" })).toHaveAttribute("aria-checked", "true");
  });

  it("a member sees teammates' endpoints with the address masked and nothing to change", async () => {
    const asMember: DevWorkspace[] = [{ ...WS[0], role: "member" }];
    render(<WebhooksPanel workspaces={asMember} currentWorkspaceId={WS[0].id} />);
    const masked = await within(group()).findByText("hooks.zapier.com/…x2kd");
    expect(masked).not.toHaveAttribute("title");
    expect(within(group()).queryByText(/bq9x2kd/)).toBeNull();
    expect(within(group()).getByText("hook.eu1.make.com/…hz3c")).toBeInTheDocument();
    // their own endpoint: full address (also on hover), and a switch
    expect(within(group()).getByText(/^api\.northwind-studio\.co\.uk\//)).toHaveAttribute("title", "https://api.northwind-studio.co.uk/kanbo/events?client=foundrise");
    expect(screen.queryByRole("switch", { name: "Send events to hooks.zapier.com" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Send events to api.northwind-studio.co.uk" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show details for hooks.zapier.com" }));
    expect(await screen.findByText(/Only they, or a workspace owner or admin, can change it or see its full address/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send test" })).toBeNull();
    const list = await screen.findByRole("list", { name: "Recent deliveries" });
    expect(within(list).queryByRole("button", { name: /again/ })).toBeNull();
  });

  it("a guest-only current workspace falls back to Personal", async () => {
    render(<WebhooksPanel workspaces={WS} currentWorkspaceId={WS[1].id} />);
    expect((screen.getByLabelText("Endpoints for") as HTMLSelectElement).value).toBe("personal");
    expect(await within(group()).findByText(/hooks.zapier.com\/hooks\/catch\/1234567\/pr7k3nx/)).toBeInTheDocument();
  });

  it("adds an endpoint: checks the URL on the field, shows the secret once, then never again", async () => {
    const { container } = render(<WebhooksPanel workspaces={WS} currentWorkspaceId={WS[0].id} />);
    fireEvent.click(await within(group()).findByRole("button", { name: "Add endpoint" }));
    const url = screen.getByLabelText("Endpoint URL");
    await waitFor(() => expect(url).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    expect(await screen.findByText("Paste your endpoint's address.")).toBeInTheDocument();
    expect(url).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(url, { target: { value: "http://hooks.example.com/k" } });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    expect(await screen.findByText(/Use an https:\/\/ address/)).toBeInTheDocument();
    fireEvent.change(url, { target: { value: "https://192.168.1.20/hook" } });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    expect(await screen.findByText(/IP addresses and internal names aren't allowed/)).toBeInTheDocument();

    // events: grouped checkboxes with their descriptions; none chosen is refused
    const events = screen.getByRole("group", { name: "Events to send" });
    expect(within(events).getByRole("checkbox", { name: /Member joined/ })).toBeInTheDocument();
    fireEvent.click(within(events).getByRole("checkbox", { name: /Task created/ }));
    fireEvent.click(within(events).getByRole("checkbox", { name: /Task completed/ }));
    fireEvent.change(url, { target: { value: "https://hooks.example.com/kanbo" } });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    expect(await screen.findByText("Choose at least one event.")).toBeInTheDocument();
    fireEvent.click(within(events).getByRole("checkbox", { name: /Comment added/ }));
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "Support inbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));

    const secretBox = await screen.findByRole("textbox", { name: "Signing secret" }) as HTMLInputElement;
    const secret = secretBox.value;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(screen.getByText(/Kanbo can't show it again/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy signing secret" })).toHaveFocus());
    expect(screen.getByText(/Endpoint added\. Copy its signing secret now/)).toBeInTheDocument();
    expect(within(group()).getByText("hooks.example.com/kanbo")).toBeInTheDocument();
    expect(within(group()).getByText(/Support inbox · Comment added/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "I've saved it" }));
    expect(screen.queryByRole("textbox", { name: "Signing secret" })).toBeNull();
    expect(container.innerHTML).not.toContain(secret);
    expect((await listWebhooks(WS[0].id)).some((h) => h.url === "https://hooks.example.com/kanbo")).toBe(true);
  });

  it("Personal endpoints don't offer member.joined", async () => {
    render(<WebhooksPanel workspaces={[]} currentWorkspaceId={null} />);
    fireEvent.click(await within(group()).findByRole("button", { name: "Add endpoint" }));
    const events = screen.getByRole("group", { name: "Events to send" });
    expect(within(events).queryByRole("checkbox", { name: /Member joined/ })).toBeNull();
    expect(within(events).getAllByRole("checkbox")).toHaveLength(7);
    fireEvent.click(within(events).getByRole("button", { name: "Choose all" }));
    expect(within(events).getAllByRole("checkbox").every((c) => (c as HTMLInputElement).checked)).toBe(true);
    // no scope picker when there are no team workspaces
    expect(screen.queryByLabelText("Endpoints for")).toBeNull();
  });

  it("switches an endpoint off and on", async () => {
    render(<WebhooksPanel workspaces={WS} currentWorkspaceId={WS[0].id} />);
    const sw = await screen.findByRole("switch", { name: "Send events to hooks.zapier.com" });
    fireEvent.click(sw);
    expect(await screen.findByText(/Switched off\. Nothing more goes to hooks\.zapier\.com/)).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect((await listWebhooks(WS[0].id))[0].active).toBe(false);
    fireEvent.click(sw);
    expect(await screen.findByText("Sending to hooks.zapier.com again.")).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("details: recent deliveries with status, timing and retries; send a test; redeliver a failed one", async () => {
    render(<WebhooksPanel workspaces={WS} currentWorkspaceId={WS[0].id} />);
    const details = await screen.findByRole("button", { name: "Show details for api.northwind-studio.co.uk" });
    fireEvent.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    const list = await screen.findByRole("list", { name: "Recent deliveries" });
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBe(5);
    expect(within(list).getAllByText(/Retrying · 503/).length).toBe(2);
    expect(within(list).getByText(/next try in 26 min/)).toBeInTheDocument();
    expect(within(list).getByText(/attempt 3/)).toBeInTheDocument();
    expect(within(list).getByText("No answer within 10 seconds.")).toBeInTheDocument();
    expect(within(list).getAllByText(/\d+ ms/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    expect(await screen.findByText(/Test event queued for api\.northwind-studio\.co\.uk/)).toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: "Send this task deleted again" }));
    expect(await screen.findByText("Sending that task deleted again now.")).toBeInTheDocument();
  });

  it("rotating the secret asks first, then shows the new one once", async () => {
    render(<WebhooksPanel workspaces={WS} currentWorkspaceId={WS[0].id} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show details for hooks.zapier.com" }));
    fireEvent.click(await screen.findByRole("button", { name: "Rotate secret" }));
    expect(screen.getByText("Replace the signing secret?")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Replace secret" }));
    const box = await screen.findByRole("textbox", { name: "Signing secret" }) as HTMLInputElement;
    expect(box.value).toMatch(/^whsec_/);
    expect(screen.getByText(/The old secret has already stopped working/)).toBeInTheDocument();
  });

  it("edits events and deletes after confirming", async () => {
    render(<WebhooksPanel workspaces={WS} currentWorkspaceId={WS[0].id} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show details for hooks.zapier.com" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Change this endpoint" });
    fireEvent.click(within(form).getByRole("checkbox", { name: /Project created/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Endpoint for hooks.zapier.com saved.")).toBeInTheDocument();
    expect((await listWebhooks(WS[0].id))[0].events).toContain("project.created");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete the endpoint for hooks.zapier.com?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete endpoint" }));
    expect(await screen.findByText("Endpoint for hooks.zapier.com deleted.")).toBeInTheDocument();
    expect(screen.queryByText("hooks.zapier.com/hooks/catch/1234567/bq9x2kd/")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add endpoint" })).toHaveFocus());
  });

  it("explains how to verify a signature", async () => {
    render(<WebhooksPanel workspaces={[]} currentWorkspaceId={null} />);
    expect(await screen.findByText("How to check a delivery came from Kanbo")).toBeInTheDocument();
    expect(screen.getByLabelText("Node.js example").textContent).toContain("timingSafeEqual");
  });
});

describe("wording", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  it("times read naturally", () => {
    expect(agoText("2026-10-05T11:59:40Z", now)).toBe("just now");
    expect(agoText("2026-10-05T11:56:00Z", now)).toBe("4 min ago");
    expect(agoText("2026-10-05T09:00:00Z", now)).toBe("3 hours ago");
    expect(agoText("2026-10-04T09:00:00Z", now)).toBe("yesterday");
    expect(agoText("2026-09-28T09:00:00Z", now)).toBe("28 Sept");
    expect(agoText(null, now)).toBe("never");
    expect(soonText("2026-10-05T12:26:00Z", now)).toBe("in 26 min");
    expect(soonText("2026-10-05T11:00:00Z", now)).toBe("any moment");
  });
  it("events read as a summary", () => {
    expect(eventsSummary(["task.created", "task.completed"], false)).toBe("Task created, Task completed");
    expect(eventsSummary(["task.created", "task.updated", "task.deleted"], false)).toBe("3 events");
    expect(eventsSummary(["task.created", "task.updated", "task.completed", "task.deleted", "comment.created", "project.created", "project.updated"], true)).toBe("All events");
  });
});

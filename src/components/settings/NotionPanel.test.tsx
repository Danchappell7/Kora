/* Settings › Notion, in demo mode (lib/notion's in-memory Notion workspace). */
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NotionPanel } from "./NotionPanel";
import { NOTION_COPY, NOTION_INTEGRATIONS_URL, loadNotionStatus, listNotionSyncs, resetNotionDemo } from "../../lib/notion";

const TOKEN = "ntn_" + "Ab12Cd34".repeat(5);
const PROJECTS = [
  { id: "p-launch", name: "Q3 Product Launch", emoji: "🚀", color: "oklch(0.62 0.15 240)" },
  { id: "p-brand", name: "Brand Refresh", emoji: "🎨", color: "oklch(0.62 0.16 318)" },
  { id: "p-infra", name: "Platform Infra", emoji: "⚙️", color: "oklch(0.62 0.12 160)" },
  { id: "p-old", name: "Old project", emoji: "📁", color: "oklch(0.62 0.12 30)", archivedAt: "2026-01-01" },
];
const group = (name: string) => screen.getByRole("region", { name });

beforeEach(() => resetNotionDemo({ demoDelayMs: 0 }));

describe("NotionPanel", () => {
  it("explains that Notion is per team workspace in Personal", () => {
    render(<NotionPanel workspaceId={null} role={null} projects={[]} />);
    expect(within(group("Notion")).getByText("Notion is for team workspaces")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("an owner connects: the steps link to Notion, the secret is checked, then never shown again", async () => {
    const { container } = render(<StrictMode><NotionPanel workspaceId="ws-reco" workspaceName="Reco HQ" role="owner" projects={PROJECTS} /></StrictMode>);
    await screen.findByText("Not connected");
    const link = screen.getByRole("link", { name: /Notion's integrations page/ });
    expect(link).toHaveAttribute("href", NOTION_INTEGRATIONS_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const field = screen.getByLabelText("Internal Integration Secret");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Paste the secret from your Notion integration.")).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(field, { target: { value: "Bearer abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(NOTION_COPY.invalidToken)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show the secret" }));
    expect(field).toHaveAttribute("type", "text");
    fireEvent.change(field, { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/Connected to Foundrise\./)).toBeInTheDocument();
    expect(within(group("Notion")).getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByLabelText("Internal Integration Secret")).toBeNull();
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(container.innerHTML).toContain("…" + TOKEN.slice(-4));
    await waitFor(() => expect(screen.getByRole("button", { name: "Test" })).toHaveFocus());
    expect((await loadNotionStatus("ws-reco"))?.connected).toBe(true);
  });

  it("members see the connection and the syncs, nothing to change", async () => {
    render(<NotionPanel workspaceId="ws-foundrise" workspaceName="Foundrise" role="member" projects={PROJECTS} />);
    await screen.findByText("Foundrise");
    expect(within(group("Notion")).getByText("Foundrise")).toBeInTheDocument();
    const syncs = await screen.findByRole("region", { name: "Synced databases" });
    expect(await within(syncs).findByText("Product roadmap")).toBeInTheDocument();
    expect(within(syncs).getByText("Q3 Product Launch")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sync now|Remove|Pause|Import a database|Test|Disconnect/ })).toBeNull();
    expect(screen.queryByText(/secret …/)).toBeNull();
  });

  it("owners run, pause and remove syncs; a failing sync says why", async () => {
    render(<NotionPanel workspaceId="ws-foundrise" workspaceName="Foundrise" role="owner" projects={PROJECTS} />);
    const syncs = await screen.findByRole("region", { name: "Synced databases" });
    const roadmap = await within(syncs).findByRole("group", { name: /Product roadmap/ });
    const bugs = within(syncs).getByRole("group", { name: /Bug tracker/ });
    expect(within(bugs).getByText(/can't see this Notion database any more/)).toBeInTheDocument();
    expect(within(roadmap).getByText("Both ways")).toBeInTheDocument();
    expect(within(bugs).getByText("From Notion")).toBeInTheDocument();
    fireEvent.click(within(roadmap).getByRole("button", { name: "Sync now" }));
    expect(await within(roadmap).findByText("Synced: 1 updated, 1 sent to Notion.")).toBeInTheDocument();
    fireEvent.click(within(roadmap).getByRole("button", { name: /Pause the sync of Product roadmap/ }));
    expect(await within(roadmap).findByText("Paused")).toBeInTheDocument();
    expect(within(roadmap).getByRole("button", { name: /Resume the sync/ })).toBeInTheDocument();
    fireEvent.click(within(bugs).getByRole("button", { name: /Remove the sync of Bug tracker/ }));
    expect(within(bugs).getByText("Remove this sync?")).toBeInTheDocument();
    await waitFor(() => expect(within(bugs).getByRole("button", { name: "Cancel" })).toHaveFocus());
    fireEvent.click(within(bugs).getByRole("button", { name: "Remove sync" }));
    await waitFor(() => expect(within(syncs).queryByText("Bug tracker")).toBeNull());
    expect((await listNotionSyncs("ws-foundrise")).map((s) => s.databaseTitle)).toEqual(["Product roadmap"]);
  });

  it("imports a database: pick → preview and map → project → done", async () => {
    const open = vi.fn();
    render(<NotionPanel workspaceId="ws-foundrise" workspaceName="Foundrise" role="admin" projects={PROJECTS} onOpenProject={open} />);
    fireEvent.click(await screen.findByRole("button", { name: "Import a database" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a Notion database" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /Content calendar/ }));

    // step 2: the first five pages, and the suggested mapping
    expect(await within(dialog).findByRole("table")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("row")).toHaveLength(6);
    expect(within(dialog).getByText("Autumn newsletter")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Status/)).toHaveValue("Status");
    expect(within(dialog).getByLabelText(/^Due date/)).toHaveValue("Publish date");
    expect(within(dialog).getByLabelText(/^Assignee/)).toHaveValue("Owner");
    expect(within(dialog).getByRole("combobox", { name: "Scheduled" })).toHaveValue("review");
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Scheduled" }), { target: { value: "progress" } });
    fireEvent.change(within(dialog).getByLabelText(/^Description/), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));

    // step 3: archived projects aren't offered; keep in sync, both ways
    const select = await within(dialog).findByRole("combobox", { name: "Project" });
    expect(within(select).queryByText(/Old project/)).toBeNull();
    fireEvent.change(select, { target: { value: "p-brand" } });
    expect(within(dialog).getByRole("switch", { name: "Keep it in sync" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "From Notion only" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));

    expect(await within(dialog).findByText("14 tasks imported")).toBeInTheDocument();
    expect(within(dialog).getByText(/Content calendar is in Brand Refresh, and keeps taking changes from Notion\./)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open project" }));
    expect(open).toHaveBeenCalledWith("p-brand");
    const sync = (await listNotionSyncs("ws-foundrise")).find((s) => s.databaseTitle === "Content calendar")!;
    expect(sync).toMatchObject({ projectId: "p-brand", direction: "from_notion" });
    expect(sync.mapping.status?.values.Scheduled).toBe("progress");
    expect(sync.mapping.description).toBeUndefined();
  });

  it("a new project gets its name from the database and an identity", async () => {
    render(<NotionPanel workspaceId="ws-foundrise" workspaceName="Foundrise" role="owner" projects={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Import a database" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a Notion database" });
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Search databases" }), { target: { value: "hiring" } });
    fireEvent.click(await within(dialog).findByRole("button", { name: /Hiring pipeline/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Next" }));
    expect(within(dialog).getByRole("radio", { name: "A new project" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "An existing project" })).toBeDisabled();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Hiring pipeline");
    fireEvent.click(within(dialog).getByRole("button", { name: "👥" }));
    fireEvent.click(within(dialog).getByRole("switch", { name: "Keep it in sync" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(await within(dialog).findByText("9 tasks imported")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Open project" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a big one-off import: 1,000 first, then Import the rest carries on into the same project", async () => {
    const open = vi.fn();
    render(<NotionPanel workspaceId="ws-foundrise" workspaceName="Foundrise" role="owner" projects={PROJECTS} onOpenProject={open} />);
    fireEvent.click(await screen.findByRole("button", { name: "Import a database" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a Notion database" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /Support tickets/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Next" }));
    fireEvent.change(await within(dialog).findByRole("combobox", { name: "Project" }), { target: { value: "p-infra" } });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Keep it in sync" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(await within(dialog).findByText("1000 tasks imported")).toBeInTheDocument();
    expect(within(dialog).getByText(/Choose Import the rest to carry on/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Import the rest" }));
    expect(await within(dialog).findByText("1240 tasks imported")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Import the rest" })).toBeNull();
    expect(within(dialog).queryByText(/Choose Import the rest/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open project" }));
    expect(open).toHaveBeenCalledWith("p-infra");
  });

  it("an import that's running finishes before the wizard closes", async () => {
    resetNotionDemo({ demoDelayMs: 40 });
    render(<NotionPanel workspaceId="ws-foundrise" workspaceName="Foundrise" role="owner" projects={PROJECTS} />);
    fireEvent.click(await screen.findByRole("button", { name: "Import a database" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a Notion database" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /Hiring pipeline/ }, { timeout: 2000 }));
    const next = await within(dialog).findByRole("button", { name: "Next" });
    await waitFor(() => expect(next).toBeEnabled(), { timeout: 2000 });
    fireEvent.click(next);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Import" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Kanbo is still importing. This closes once it's done.");
    expect(screen.getByRole("dialog", { name: "Import a Notion database" })).toBeInTheDocument();
    expect(await within(dialog).findByText("9 tasks imported", undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(within(dialog).queryByText(/still importing/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("disconnecting asks first, then pauses the syncs", async () => {
    render(<NotionPanel workspaceId="ws-foundrise" workspaceName="Foundrise" role="owner" projects={PROJECTS} />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(screen.getByText("Disconnect Notion?")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Disconnect Notion?" })).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    const syncs = await screen.findByRole("region", { name: "Synced databases" });
    await waitFor(() => expect(within(syncs).getAllByText("Paused")).toHaveLength(2));
  });
});

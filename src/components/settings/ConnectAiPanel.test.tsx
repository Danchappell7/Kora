/* Settings › Developers › Connect your AI, in demo mode. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConnectAiPanel } from "./ConnectAiPanel";
import * as lib from "../../lib/mcpOAuth";

beforeEach(() => {
  lib.resetDemoConnectedApps();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
});
afterEach(() => vi.restoreAllMocks());

describe("ConnectAiPanel", () => {
  it("shows the one address, and copies it", async () => {
    render(<ConnectAiPanel />);
    expect(screen.getByRole("heading", { name: "Connect your AI" })).toBeInTheDocument();
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("https://www.kanbo.co.uk/mcp");
    expect(input).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://www.kanbo.co.uk/mcp"));
    expect(await screen.findByRole("button", { name: "Address copied" })).toBeInTheDocument();
    expect(screen.getByText(/with the www/)).toBeInTheDocument();
  });

  it("has a tab for each app, written from what they say", async () => {
    render(<ConnectAiPanel />);
    await screen.findByRole("list", { name: "Connected AI apps" });
    const tabs = within(screen.getByRole("tablist", { name: "Which AI app" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Claude", "ChatGPT", "Cursor", "Claude Code", "Your own code"]);
    const panel = () => screen.getByRole("tabpanel");
    expect(panel()).toHaveTextContent("Customize › Connectors");
    expect(panel()).toHaveTextContent("Add custom connector");
    expect(panel()).toHaveTextContent(/Free plan allows one custom connector/);
    fireEvent.click(tabs[1]);
    expect(panel()).toHaveTextContent("Add custom MCP server");
    expect(panel()).toHaveTextContent(/Business, Enterprise or Edu/);
    expect(panel()).toHaveTextContent(/Pro can read but not change/);
    expect(panel()).toHaveTextContent(/only be added on the website/);
    fireEvent.click(tabs[2]);
    expect(within(panel()).getByRole("link", { name: "Add Kanbo to Cursor" })).toHaveAttribute("href", lib.cursorInstallLink());
    expect(panel()).toHaveTextContent("~/.cursor/mcp.json");
    fireEvent.click(tabs[3]);
    expect(panel()).toHaveTextContent("claude mcp add --transport http kanbo https://www.kanbo.co.uk/mcp");
    expect(panel()).toHaveTextContent("claude mcp logout kanbo");
    fireEvent.click(tabs[4]);
    expect(panel()).toHaveTextContent("kanbo_sk_");
    expect(panel()).toHaveTextContent("tools/call");
    expect(within(panel()).getByRole("link", { name: "OpenAPI document" }).getAttribute("href")).toMatch(/openapi\.json$/);
  });

  it("copying a command", async () => {
    render(<ConnectAiPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Claude Code command" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("claude mcp add --transport http kanbo https://www.kanbo.co.uk/mcp"));
  });

  it("tabs work from the keyboard", async () => {
    render(<ConnectAiPanel />);
    await screen.findByRole("list", { name: "Connected AI apps" });
    const tablist = screen.getByRole("tablist");
    const first = screen.getByRole("tab", { name: "Claude" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "ChatGPT" })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "ChatGPT" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "ChatGPT" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tablist, { key: "End" });
    expect(screen.getByRole("tab", { name: "Your own code" })).toHaveFocus();
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Claude" })).toHaveFocus();
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Your own code" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", screen.getByRole("tab", { name: "Your own code" }).id);
  });

  it("lists connected apps: name, access, workspace, last used", async () => {
    render(<ConnectAiPanel />);
    const list = await screen.findByRole("list", { name: "Connected AI apps" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Claude");
    expect(rows[0]).toHaveTextContent("claude.ai");
    expect(rows[0]).toHaveTextContent("Read and change");
    expect(rows[0]).toHaveTextContent("All my workspaces");
    expect(rows[0]).toHaveTextContent("Connected 28 Oct 2026");
    expect(rows[1]).toHaveTextContent("Read only");
    expect(rows[1]).toHaveTextContent("Foundrise");
    expect(rows[1]).toHaveTextContent(/never/i);
    expect(screen.getByText(/this is the demo/i)).toBeInTheDocument();
  });

  it("revoke asks first, then the app goes", async () => {
    render(<ConnectAiPanel />);
    await screen.findByRole("list", { name: "Connected AI apps" });
    fireEvent.click(screen.getByRole("button", { name: "Revoke Claude" }));
    const confirm = screen.getByRole("group", { name: "Revoke Claude?" });
    expect(confirm).toHaveTextContent(/stops working on its next request/);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Revoke Claude?" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke Claude" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Revoke Claude?" })).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText(/Disconnected “Claude”/)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Connected AI apps" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("a failed revoke says so and keeps the app", async () => {
    vi.spyOn(lib, "revokeConnectedApp").mockRejectedValue(new Error("nope"));
    render(<ConnectAiPanel />);
    await screen.findByRole("list", { name: "Connected AI apps" });
    fireEvent.click(screen.getByRole("button", { name: "Revoke Claude" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Revoke Claude?" })).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText(lib.MCP_COPY.failed)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Connected AI apps" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("before 0050 is live it says plainly it isn't switched on", async () => {
    vi.spyOn(lib, "listConnectedApps").mockRejectedValue(new lib.McpNotReady());
    render(<ConnectAiPanel />);
    expect(await screen.findByText("Not switched on yet")).toBeInTheDocument();
    expect(screen.getByText(/This isn't switched on yet/)).toBeInTheDocument();
    // the address and the steps are still there to read
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("https://www.kanbo.co.uk/mcp");
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  it("a failure to load can be tried again", async () => {
    const list = vi.spyOn(lib, "listConnectedApps").mockRejectedValue(new Error("boom"));
    render(<ConnectAiPanel />);
    expect(await screen.findByText("Couldn't load them")).toBeInTheDocument();
    list.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("None yet")).toBeInTheDocument();
  });
});

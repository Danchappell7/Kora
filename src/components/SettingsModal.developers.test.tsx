/* Settings › Developers and Settings › Calendar & integrations › Notion, as the
   integrator mounts them (demo mode: lib/apiKeys, lib/webhooks and lib/notion fakes). */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";
import { AuthProvider } from "../auth/AuthProvider";
import { resetDemoApiKeys } from "../lib/apiKeys";
import { resetWebhookDemo } from "../lib/webhooks";
import { resetNotionDemo } from "../lib/notion";
import type { DevWorkspace } from "./settings";

type Props = Parameters<typeof SettingsModal>[0];
const WS: DevWorkspace[] = [
  { id: "11111111-0000-4000-8000-000000000001", name: "Foundrise", role: "owner" },
  { id: "22222222-0000-4000-8000-000000000002", name: "Client: Northwind", role: "guest" },
];
const baseProps = (): Props => ({
  open: true,
  onClose: vi.fn(),
  initial: { firstName: "Ada", lastName: "Lovelace", pronouns: "", avatarUrl: null },
  email: "ada@acme.co.uk",
  color: "oklch(0.6 0.2 264)",
  onUpload: vi.fn(async () => "blob:demo"),
  onSave: vi.fn(async () => {}),
  onExport: vi.fn(),
  onDeleteAccount: vi.fn(async () => {}),
});
function renderSettings(overrides: Partial<Props> = {}) {
  const props: Props = { ...baseProps(), ...overrides };
  const utils = render(<AuthProvider><SettingsModal {...props} /></AuthProvider>);
  return { ...utils, props };
}
const tab = (name: string) => screen.queryByRole("tab", { name: new RegExp(`^${name}`, "i") });
const goTo = (name: string) => fireEvent.click(tab(name)!);
const developers = { workspaces: WS, currentWorkspaceId: WS[0].id };

beforeEach(() => {
  resetDemoApiKeys();
  resetWebhookDemo({ delayMs: 0, arriveMs: 5 });
  resetNotionDemo({ demoDelayMs: 0 });
});

describe("Settings › Developers", () => {
  it("is offered only when the host passes it, right after Calendar & integrations, and never to guests", () => {
    const { unmount } = renderSettings();
    expect(tab("Developers")).toBeNull();
    unmount();
    const second = renderSettings({ developers });
    const names = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(names.indexOf("Developers")).toBe(names.indexOf("Calendar & integrations") + 1);
    second.unmount();
    renderSettings({ developers, isGuest: true });
    expect(tab("Developers")).toBeNull();
  });

  it("shows API keys and webhooks together, with the demo's example data", async () => {
    renderSettings({ developers });
    goTo("Developers");
    expect(screen.getByRole("heading", { name: "Developers" })).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Your API keys" })).toBeInTheDocument();
    const hooks = screen.getByRole("region", { name: "Webhooks" });
    expect(await within(hooks).findByText("hooks.zapier.com/hooks/catch/1234567/bq9x2kd/")).toBeInTheDocument();
    // the guest workspace isn't offered for endpoints, and says why
    expect(screen.getByText(/You're a guest in Client: Northwind/)).toBeInTheDocument();
  });

  it("the API reference opens in place (focus on its heading) and Back returns to the link, keeping the panels' state", async () => {
    renderSettings({ developers });
    goTo("Developers");
    await screen.findByRole("list", { name: "Your API keys" });
    const create = screen.getByRole("button", { name: "Create key" });
    fireEvent.click(create);
    const name = await screen.findByLabelText(/name/i, { selector: "input" });
    fireEvent.change(name, { target: { value: "Reporting script" } });
    fireEvent.click(screen.getByRole("button", { name: "API reference" }));
    const heading = await screen.findByRole("heading", { name: "API reference" });
    await waitFor(() => expect(heading).toHaveFocus());
    // the panels are hidden, not unmounted: the half-made key survives a look at the docs
    expect(screen.queryByRole("list", { name: "Your API keys" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("heading", { name: "API reference" })).toBeNull();
    expect(screen.getByLabelText(/name/i, { selector: "input" })).toHaveValue("Reporting script");
    await waitFor(() => expect(screen.getByRole("button", { name: "API reference" })).toHaveFocus());
  });

  it("leaving the section closes the reference", async () => {
    renderSettings({ developers });
    goTo("Developers");
    fireEvent.click(await screen.findByRole("button", { name: "API reference" }));
    expect(await screen.findByRole("heading", { name: "API reference" })).toBeInTheDocument();
    goTo("Appearance");
    goTo("Developers");
    expect(screen.queryByRole("heading", { name: "API reference" })).toBeNull();
    expect(await screen.findByRole("list", { name: "Your API keys" })).toBeInTheDocument();
  });
});

describe("Settings › Calendar & integrations › Notion", () => {
  it("sits under Slack for the same workspace (loaded when first shown), and explains itself in Personal", async () => {
    renderSettings({ slack: { workspaceId: null }, notion: { projects: [] } });
    goTo("Calendar");
    expect(within(await screen.findByRole("region", { name: "Notion" })).getByText("Notion is for team workspaces")).toBeInTheDocument();
  });

  it("owners see how to connect; members see the status only", async () => {
    const { unmount } = renderSettings({ slack: { workspaceId: "ws-reco", workspaceName: "Reco HQ", role: "owner" }, notion: { projects: [] } });
    goTo("Calendar");
    expect(await screen.findByLabelText("Internal Integration Secret")).toBeInTheDocument();
    unmount();
    renderSettings({ slack: { workspaceId: "ws-reco", workspaceName: "Reco HQ", role: "member" }, notion: { projects: [] } });
    goTo("Calendar");
    await screen.findByText("Not connected");
    expect(screen.queryByLabelText("Internal Integration Secret")).toBeNull();
  });
});

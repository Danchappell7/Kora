import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, act, within, cleanup } from "@testing-library/react";
import { SettingsModal, type SettingsSection } from "./SettingsModal";
import { WorkspaceSettingsPanel } from "./views/TeamView";
import { AuthProvider } from "../auth/AuthProvider";
import type { Workspace } from "../data/types";

type Props = Parameters<typeof SettingsModal>[0];
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
  render(<AuthProvider><SettingsModal {...props} /></AuthProvider>);
  return props;
}

/** open a section from the list on the left */
const goTo = (name: string) => fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name}`, "i") }));

describe("Settings → Password & sign-in", () => {
  it("checks length and confirmation before changing the password", async () => {
    renderSettings();
    goTo("Account");
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));
    const pw = await screen.findByLabelText("New password");
    await waitFor(() => expect(pw).toHaveFocus());
    const confirm = screen.getByLabelText("Confirm new password");

    fireEvent.change(pw, { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    expect(pw).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText(/password updated/i)).not.toBeInTheDocument();

    fireEvent.change(pw, { target: { value: "correct horse battery" } });
    fireEvent.change(confirm, { target: { value: "correct horse battery!" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    expect(screen.getByText("The two passwords don't match.")).toBeInTheDocument();

    fireEvent.change(confirm, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    await waitFor(() => expect(screen.getByText(/password updated/i)).toBeInTheDocument());
  });

  it("says so when the confirmation is left empty", async () => {
    renderSettings();
    goTo("Account");
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));
    const pw = await screen.findByLabelText("New password");
    const confirm = screen.getByLabelText("Confirm new password");
    fireEvent.change(pw, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    expect(screen.getByText("Type your new password again to confirm it.")).toBeInTheDocument();
    expect(confirm).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(confirm).toHaveFocus());
    // …and stays there: the panel's own opening focus (30 ms) mustn't land afterwards
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    expect(confirm).toHaveFocus();
    expect(screen.queryByText(/password updated/i)).not.toBeInTheDocument();
  });

  it("doesn't offer signing out of every device in demo mode (there are no sessions)", () => {
    renderSettings();
    goTo("Account");
    expect(screen.queryByRole("button", { name: /sign out everywhere/i })).not.toBeInTheDocument();
  });
});

describe("Settings → Delete account", () => {
  it("explains what happens to personal and team work, and needs DELETE typed", async () => {
    const props = renderSettings();
    goTo("Account");
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    expect(screen.getByText(/your profile, your profile photo, and your personal tasks and projects/i)).toBeInTheDocument();
    expect(screen.getByText(/stay where they are/i)).toBeInTheDocument();
    expect(screen.getByText(/still showing your name/i)).toBeInTheDocument();
    expect(screen.getByText(/pass to their next admin/i)).toBeInTheDocument();

    const forever = screen.getByRole("button", { name: /delete forever/i });
    expect(forever).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/type delete to confirm/i), { target: { value: "delete" } });
    expect(forever).toBeEnabled();
    fireEvent.click(forever);
    await waitFor(() => expect(props.onDeleteAccount).toHaveBeenCalledTimes(1));
  });

  it("shows a failed deletion inside the confirmation panel", async () => {
    renderSettings({ onDeleteAccount: vi.fn(async () => { throw new Error("Couldn't delete account (500)"); }) });
    goTo("Account");
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    fireEvent.change(screen.getByLabelText(/type delete to confirm/i), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByRole("button", { name: /delete forever/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't delete account (500)");
  });
});

describe("Settings → profile photo", () => {
  it("offers only the allowed image types and refuses an SVG with a clear reason", async () => {
    const props = renderSettings();
    goTo("Profile");
    const input = screen.getByLabelText("Upload profile photo") as HTMLInputElement;
    expect(input.accept).toBe("image/png,image/jpeg,image/gif,image/webp");
    fireEvent.change(input, { target: { files: [new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/SVG images can't be used/);
    expect(props.onUpload).not.toHaveBeenCalled();
  });

  it("uploads a GIF under an extension taken from its type", async () => {
    const props = renderSettings();
    goTo("Profile");
    const input = screen.getByLabelText("Upload profile photo");
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(64)], "funny.php", { type: "image/gif" })] } });
    await waitFor(() => expect(props.onUpload).toHaveBeenCalledTimes(1));
    const sent = (props.onUpload as ReturnType<typeof vi.fn>).mock.calls[0][0] as File;
    expect(sent.name).toBe("avatar.gif");
    expect(sent.type).toBe("image/gif");
  });
});

describe("Settings → Appearance", () => {
  const appearance = { accent: "violet", textSize: "normal", ambient: true } as unknown as NonNullable<Parameters<typeof SettingsModal>[0]["appearance"]>;

  it("offers Light, Dark and System when the app can follow the device", () => {
    const onChangeTheme = vi.fn();
    renderSettings({ appearance, onChangeAppearance: vi.fn(), theme: "dark", onChangeTheme });
    goTo("Appearance");
    const group = screen.getByRole("group", { name: "Theme" });
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(group).toHaveTextContent("System follows your device's light or dark setting.");
    fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(onChangeTheme).toHaveBeenCalledWith("system");
  });

  it("leaves the theme choice out until the app passes it", () => {
    renderSettings({ appearance, onChangeAppearance: vi.fn() });
    goTo("Appearance");
    expect(screen.queryByRole("group", { name: "Theme" })).toBeNull();
  });

  it("applies density straight away, with no Save", () => {
    const onChangeAppearance = vi.fn();
    renderSettings({ appearance, onChangeAppearance });
    goTo("Appearance");
    const density = screen.getByRole("group", { name: "Density" });
    expect(within(density).getByRole("button", { name: "Comfortable" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(density).getByRole("button", { name: "Compact" }));
    expect(onChangeAppearance).toHaveBeenCalledWith(expect.objectContaining({ density: "compact", accent: "violet" }));
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("switches Kanbo AI and Today's suggestions off", () => {
    const onChangeAppearance = vi.fn();
    renderSettings({ appearance, onChangeAppearance });
    goTo("Appearance");
    const ai = screen.getByRole("switch", { name: "Use Kanbo AI" });
    expect(ai).toHaveAttribute("aria-checked", "true");
    expect(ai).toHaveAccessibleDescription("When off, Kanbo uses on-device rules only and sends nothing to the AI service.");
    fireEvent.click(ai);
    expect(onChangeAppearance).toHaveBeenLastCalledWith(expect.objectContaining({ ai: false }));
    fireEvent.click(screen.getByRole("switch", { name: "Show Kanbo suggestions on Today" }));
    expect(onChangeAppearance).toHaveBeenLastCalledWith(expect.objectContaining({ suggestions: false }));
  });

  it("picks an accent from a radio group, arrows included", () => {
    const onChangeAppearance = vi.fn();
    renderSettings({ appearance, onChangeAppearance });
    goTo("Appearance");
    const violet = screen.getByRole("radio", { name: "Violet" });
    expect(violet).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(violet, { key: "ArrowRight" });
    expect(onChangeAppearance).toHaveBeenLastCalledWith(expect.objectContaining({ accent: "blue" }));
    fireEvent.click(screen.getByRole("radio", { name: "Rose" }));
    expect(onChangeAppearance).toHaveBeenLastCalledWith(expect.objectContaining({ accent: "rose" }));
  });

  it("no longer offers Ambient motion (the aurora is gone)", () => {
    renderSettings({ appearance, onChangeAppearance: vi.fn() });
    goTo("Appearance");
    expect(screen.queryByText(/ambient motion/i)).toBeNull();
  });
});

describe("Settings sheet", () => {
  it("is one dialog with a list of sections; arrows move through them", () => {
    renderSettings();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    const list = screen.getByRole("tablist", { name: "Settings sections" });
    const names = within(list).getAllByRole("tab").map((t) => t.textContent);
    expect(names).toEqual(["Profile", "Appearance", "Notifications", "Calendar & integrations", "Billing", "Tags", "Shortcuts", "Data", "Account"]);
    // opens on Appearance
    const appearanceTab = screen.getByRole("tab", { name: "Appearance" });
    expect(appearanceTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Appearance" })).toBeInTheDocument();
    fireEvent.keyDown(appearanceTab, { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: "Notifications" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Notifications" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Notifications" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Account" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Account" }), { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
  });

  it("follows the section it's given and asks before changing it", () => {
    const onSection = vi.fn();
    const props = renderSettings({ section: "shortcuts", onSection });
    expect(screen.getByRole("tab", { name: "Shortcuts" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Data" }));
    expect(onSection).toHaveBeenCalledWith("data");
    expect(screen.getByRole("tab", { name: "Shortcuts" })).toHaveAttribute("aria-selected", "true");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("renders the real workspace panel for owners, with Close workspace last", () => {
    const acme: Workspace = { id: "ws-1", name: "Acme", kind: "team", ownerId: "u-1" };
    const renderWorkspace = () => (
      <WorkspaceSettingsPanel workspace="ws-1" workspaces={[acme]} myRole="owner"
        onUpdateWorkspace={vi.fn()} onUploadLogo={vi.fn()} onDeleteWorkspace={vi.fn()} onNewWorkspace={vi.fn()} />
    );
    renderSettings({ isAdmin: true, renderWorkspace, onGoPeople: vi.fn() });
    goTo("Workspace");
    const panel = screen.getByRole("tabpanel", { name: "Workspace" });
    const buttons = within(panel).getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("Members & roles");
    expect(buttons[buttons.length - 1]).toHaveTextContent(/close workspace/i);
  });

  it("shows Workspace to admins only, with the workspace panel and Close workspace inside", () => {
    const renderWorkspace = () => <button type="button">Close workspace</button>;
    const onGoPeople = vi.fn();
    const props = renderSettings({ isAdmin: true, renderWorkspace, onGoPeople });
    goTo("Workspace");
    const panel = screen.getByRole("tabpanel", { name: "Workspace" });
    const buttons = within(panel).getAllByRole("button").map((b) => b.textContent);
    expect(buttons[buttons.length - 1]).toBe("Close workspace");
    fireEvent.click(within(panel).getByRole("button", { name: /members & roles/i }));
    expect(props.onClose).toHaveBeenCalled();
    expect(onGoPeople).toHaveBeenCalled();
  });

  it("hides Workspace from members and guests", () => {
    const renderWorkspace = vi.fn(() => <button type="button">Close workspace</button>);
    renderSettings({ isAdmin: false, renderWorkspace });
    expect(screen.queryByRole("tab", { name: "Workspace" })).toBeNull();
    expect(renderWorkspace).not.toHaveBeenCalled();
    cleanup();
    renderSettings({ isAdmin: true, isGuest: true, renderWorkspace, section: "workspace" });
    expect(screen.queryByRole("tab", { name: "Workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close workspace" })).toBeNull();
  });

  it("lists every shortcut, with / as Search or ask", () => {
    renderSettings();
    goTo("Shortcuts");
    const panel = screen.getByRole("tabpanel", { name: "Shortcuts" });
    const row = within(panel).getByText("Search or ask Kanbo").closest("li")!;
    expect(row).toHaveTextContent(/slash/);
    expect(within(panel).getByRole("heading", { name: "Go to" })).toBeInTheDocument();
    expect(within(panel).getByText("My tasks").closest("li")).toHaveTextContent(/G then T/);
  });

  it("shows Save only while the profile has changed, and stays open after saving", async () => {
    const props = renderSettings();
    goTo("Profile");
    expect(screen.getByLabelText("First name")).toHaveAttribute("placeholder", "First name");
    expect(screen.getByLabelText("Last name")).toHaveAttribute("placeholder", "Last name");
    expect(screen.queryByRole("button", { name: /save profile/i })).toBeNull();
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Augusta" } });
    expect(screen.getByRole("tab", { name: /^Profile/ })).toHaveTextContent(/unsaved changes/);
    fireEvent.click(screen.getByRole("button", { name: /save profile/i }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith({ firstName: "Augusta", lastName: "Lovelace", pronouns: "", avatarUrl: null }));
    expect(await screen.findByText("Profile saved", { selector: ".kset-foot-note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save profile/i })).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("Discard puts the saved profile back", () => {
    renderSettings();
    goTo("Profile");
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Byron" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Last name")).toHaveValue("Lovelace");
    expect(screen.queryByRole("button", { name: /save profile/i })).toBeNull();
  });

  it("connected calendars: several accounts, one disconnected at a time, more of either kind can be added", async () => {
    const onConnect = vi.fn(), onDisconnect = vi.fn();
    const loadCalendars = vi.fn(async () => [
      { id: "ada@acme.co.uk", name: "Work", color: "#3f7fe0", primary: true, selected: true },
      { id: "team@g", name: "Launch team", color: "#2e9d6a", primary: false, selected: false },
    ]);
    const onSelect = vi.fn(async () => {});
    renderSettings({ calendar: { connections: [
      { id: "c-work", provider: "google", accountEmail: "ada@acme.co.uk", selectedCalendars: null, canChoose: true },
      { id: "c-home", provider: "google", accountEmail: "ada@gmail.com", canChoose: true, selectedCalendars: [
        { id: "ada@gmail.com", name: "Ada", color: "#e0663a", primary: true }, { id: "fam@g", name: "Family", color: "#a35bc4", primary: false }] },
      { id: "c-ms", provider: "microsoft", accountEmail: "ada@outlook.com", selectedCalendars: [], canChoose: true },
    ], onConnect, onDisconnect, syncing: true, loadCalendars, onSelect } });
    goTo("Calendar");
    const panel = screen.getByRole("tabpanel", { name: /Calendar/ });
    expect(within(panel).getByRole("heading", { name: "Connected calendars" })).toBeInTheDocument();
    expect(within(panel).getAllByRole("status").some((el) => /Syncing/.test(el.textContent ?? ""))).toBe(true);
    expect(within(panel).getByText("Google · Main calendar shown")).toBeInTheDocument();
    expect(within(panel).getByText("Google · 2 calendars shown")).toBeInTheDocument();
    expect(within(panel).getByText("Outlook · No calendars shown")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Disconnect ada@gmail.com" }));
    expect(onDisconnect).toHaveBeenCalledWith("c-home");
    fireEvent.click(within(panel).getByRole("button", { name: "Add Google account" }));
    expect(onConnect).toHaveBeenCalledWith("google");
    fireEvent.click(within(panel).getByRole("button", { name: "Add Outlook account" }));
    expect(onConnect).toHaveBeenCalledWith("microsoft");
    // choose calendars inside one account
    fireEvent.click(within(panel).getByRole("button", { name: "Choose calendars from ada@acme.co.uk" }));
    expect(loadCalendars).toHaveBeenCalledWith("c-work");
    const team = await within(panel).findByRole("checkbox", { name: /Launch team/ });
    expect(within(panel).getByRole("checkbox", { name: /Work/ })).toBeChecked();
    fireEvent.click(team);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("c-work", ["ada@acme.co.uk", "team@g"]));
    expect(await within(panel).findByText(/Saved\./)).toBeInTheDocument();
  });

  it("Calendar & integrations: the calendar feed always, and Slack for the active workspace", async () => {
    renderSettings({ slack: { workspaceId: null, workspaceName: "Personal", role: null } });
    goTo("Calendar");
    const panel = screen.getByRole("tabpanel", { name: /Calendar/ });
    // no calendar connections prop: the Month hint, and the feed is still offered
    expect(within(panel).getByText("Connect a calendar from Month")).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "Add Kanbo to your calendar" })).toBeInTheDocument();
    // Personal: Slack explains it's for team workspaces
    expect(within(panel).getByText("Slack is for team workspaces")).toBeInTheDocument();
    cleanup();
    renderSettings({ calendar: { connections: [], onConnect: vi.fn(), onDisconnect: vi.fn(), syncing: false } });
    goTo("Calendar");
    const again = screen.getByRole("tabpanel", { name: /Calendar/ });
    expect(within(again).getByRole("heading", { name: "Connected calendars" })).toBeInTheDocument();
    expect(within(again).getByText("No calendars connected yet")).toBeInTheDocument();
    expect(within(again).getByRole("heading", { name: "Add Kanbo to your calendar" })).toBeInTheDocument();
    // no slack prop (an older host): no Slack group at all
    expect(within(again).queryByRole("heading", { name: "Slack" })).toBeNull();
  });

  it("Notifications: push (a demo stand-in here) and the Kanbo app group under the table", () => {
    renderSettings({ notifyPrefs: {}, onSaveNotifyPrefs: vi.fn() });
    goTo("Notifications");
    const panel = screen.getByRole("tabpanel", { name: /Notifications/ });
    expect(within(panel).getByRole("heading", { name: "Push notifications" })).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "Kanbo app" })).toBeInTheDocument();
    // push can be offered, so the morning reminder isn't "email only" any more
    expect(within(panel).getByText("Your morning summary of what's due.")).toBeInTheDocument();
  });

  it("says Kanbo is free while billing is off, and sends guests to their admin", () => {
    renderSettings({ billing: { enabled: false, subscription: null, onUpgrade: vi.fn(), onManageBilling: vi.fn() } });
    goTo("Billing");
    expect(screen.getByText("Kanbo is free during early access.")).toBeInTheDocument();
    cleanup();
    renderSettings({ isGuest: true, billing: { enabled: true, subscription: null, onUpgrade: vi.fn(), onManageBilling: vi.fn() } });
    goTo("Billing");
    expect(screen.getByText("Your workspace admin manages billing.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage billing/i })).toBeNull();
  });

  it("manages tags in place", () => {
    const onUpdate = vi.fn();
    renderSettings({ tagsPanel: { tags: { "tag-ops": { label: "Ops", color: "oklch(0.74 0.14 230)" } }, taskCounts: { "tag-ops": 2 }, onUpdate, onDelete: vi.fn(), onMerge: vi.fn() } });
    goTo("Tags");
    const input = screen.getByRole("textbox", { name: "Rename tag Ops" });
    fireEvent.change(input, { target: { value: "Operations" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onUpdate).toHaveBeenCalledWith("tag-ops", { label: "Operations" });
  });

  it("Data › Import closes Settings first, then opens the import", () => {
    const order: string[] = [];
    renderSettings({ onClose: vi.fn(() => order.push("close")), onImport: vi.fn(() => order.push("import")) });
    goTo("Data");
    fireEvent.click(screen.getByRole("button", { name: /import tasks/i }));
    expect(order).toEqual(["close", "import"]);
  });
});

describe("Settings on a phone", () => {
  const phoneMedia = (query: string) => ({
    matches: /max-width:\s*859px/.test(query), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  });
  let real: typeof window.matchMedia;
  beforeEach(() => { real = window.matchMedia; window.matchMedia = vi.fn(phoneMedia) as unknown as typeof window.matchMedia; });
  afterEach(() => { window.matchMedia = real; });

  it("lists the sections, pushes one with a Back button, and goes back to the row you came from", async () => {
    renderSettings({ theme: "dark", onChangeTheme: vi.fn() });
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("button", { name: /Ada Lovelace/ })).toHaveFocus();
    expect(within(nav).getByRole("button", { name: /Appearance/ })).toHaveTextContent("Dark");
    fireEvent.click(within(nav).getByRole("button", { name: /Notifications/ }));
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "All settings" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "All settings" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Notifications/ })).toHaveFocus());
  });

  it("opens straight into a section it's asked for", () => {
    renderSettings({ section: "account" });
    expect(screen.getByRole("heading", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All settings" })).toBeInTheDocument();
  });

  it("opens on the list when the app keeps the section as state, and still follows a deep link", () => {
    // the shape P02 wires: `section` is lasting state, handed back via onSection
    function Host() {
      const [open, setOpen] = useState(false);
      const [section, setSection] = useState<SettingsSection>("appearance");
      return (
        <AuthProvider>
          <button type="button" onClick={() => setOpen(true)}>Open settings</button>
          <button type="button" onClick={() => { setSection("tags"); setOpen(true); }}>Manage tags</button>
          <SettingsModal {...baseProps()} open={open} onClose={() => setOpen(false)} section={section} onSection={setSection} />
        </AuthProvider>
      );
    }
    render(<Host />);
    const list = () => screen.queryByRole("navigation", { name: "Settings sections" });

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(list()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All settings" })).toBeNull();
    fireEvent.click(within(list()!).getByRole("button", { name: /Account/ }));
    expect(screen.getByRole("heading", { name: "Account" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    // the app still holds "account": a plain reopen shows the list again
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(list()).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Account" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    // a section the app changes on the way in is a deep link
    fireEvent.click(screen.getByRole("button", { name: "Manage tags" }));
    expect(screen.getByRole("heading", { name: "Tags" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All settings" })).toBeInTheDocument();
  });

  it("keeps the Save bar on the list while the profile has unsaved changes", () => {
    renderSettings();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: /Ada Lovelace/ }));
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Augusta" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All settings" }));
    expect(screen.getByText("Unsaved profile changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeInTheDocument();
  });
});

describe("Settings › closing", () => {
  it("Escape closes the sheet", () => {
    const props = renderSettings();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Appearance" }), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Settings › unsaved profile changes", () => {
  const editName = (value = "Augusta") => {
    goTo("Profile");
    fireEvent.change(screen.getByLabelText("First name"), { target: { value } });
  };
  const question = () => screen.queryByRole("group", { name: "Save profile changes before closing?" });

  it("keeps the Save bar in every section, and saves from there", async () => {
    const props = renderSettings();
    editName();
    goTo("Shortcuts");
    expect(screen.getByText("Unsaved profile changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith({ firstName: "Augusta", lastName: "Lovelace", pronouns: "", avatarUrl: null }));
    expect(await screen.findByText("Profile saved", { selector: ".kset-foot-note" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Shortcuts" })).toHaveAttribute("aria-selected", "true");
  });

  it("asks before closing; Escape keeps editing, Discard closes without saving", async () => {
    const props = renderSettings();
    editName();
    goTo("Appearance");
    const x = screen.getByRole("button", { name: "Close settings" });
    x.focus();
    fireEvent.click(x);
    expect(props.onClose).not.toHaveBeenCalled();
    const saveAndClose = within(question()!).getByRole("button", { name: "Save and close" });
    await waitFor(() => expect(saveAndClose).toHaveFocus());

    fireEvent.keyDown(saveAndClose, { key: "Escape" });
    expect(question()).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(x).toHaveFocus());
    expect(screen.getByText("Unsaved profile changes")).toBeInTheDocument();

    fireEvent.keyDown(x, { key: "Escape" });
    fireEvent.click(within(question()!).getByRole("button", { name: "Discard" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("Save and close saves, closes, then carries on to what the close was for", async () => {
    const order: string[] = [];
    const props = renderSettings({
      onClose: vi.fn(() => order.push("close")), onImport: vi.fn(() => order.push("import")),
      onSave: vi.fn(async () => { order.push("save"); }),
    });
    editName();
    goTo("Data");
    fireEvent.click(screen.getByRole("button", { name: /import tasks/i }));
    expect(order).toEqual([]);
    fireEvent.click(within(question()!).getByRole("button", { name: "Save and close" }));
    await waitFor(() => expect(order).toEqual(["save", "close", "import"]));
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ firstName: "Augusta" }));
  });

  it("a failed save keeps the sheet open and says why in the bar", async () => {
    const props = renderSettings({ onSave: vi.fn(async () => { throw new Error("You're offline. Your profile wasn't saved."); }) });
    editName();
    goTo("Notifications");
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Settings" }).parentElement!);
    fireEvent.click(screen.getByRole("dialog", { name: "Settings" }).parentElement!);
    fireEvent.click(within(question()!).getByRole("button", { name: "Save and close" }));
    expect(await within(question()!).findByRole("alert")).toHaveTextContent("You're offline. Your profile wasn't saved.");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("closes without asking once the changes are saved or discarded", () => {
    const props = renderSettings();
    editName();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(question()).toBeNull();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

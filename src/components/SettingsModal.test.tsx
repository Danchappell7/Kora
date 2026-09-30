import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within, cleanup } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";
import { AuthProvider } from "../auth/AuthProvider";

function renderSettings(overrides: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  const props: Parameters<typeof SettingsModal>[0] = {
    open: true,
    onClose: vi.fn(),
    initial: { firstName: "Ada", lastName: "Lovelace", pronouns: "", avatarUrl: null },
    email: "ada@acme.co.uk",
    color: "oklch(0.6 0.2 264)",
    onUpload: vi.fn(async () => "blob:demo"),
    onSave: vi.fn(async () => {}),
    onExport: vi.fn(),
    onDeleteAccount: vi.fn(async () => {}),
    ...overrides,
  };
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

  it("connects and disconnects calendars", () => {
    const onConnect = vi.fn(), onDisconnect = vi.fn();
    renderSettings({ calendar: { connections: [{ provider: "google", accountEmail: "ada@acme.co.uk" }], onConnect, onDisconnect, syncing: true } });
    goTo("Calendar");
    const panel = screen.getByRole("tabpanel", { name: /Calendar/ });
    expect(within(panel).getByRole("status")).toHaveTextContent("Syncing");
    expect(within(panel).getByText(/ada@acme\.co\.uk/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Disconnect Google Calendar" }));
    expect(onDisconnect).toHaveBeenCalledWith("google");
    fireEvent.click(within(panel).getByRole("button", { name: "Connect Microsoft Outlook" }));
    expect(onConnect).toHaveBeenCalledWith("microsoft");
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

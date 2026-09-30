/* Settings with a (fake) Supabase backend: storage clean-up ordering around
   sign-out and account deletion, stale-tab photo saves, Google passwords. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";

const h = vi.hoisted(() => {
  const UID = "6f1c0d2e-1111-4a4a-9b9b-222233334444";
  const BASE = "https://abcd.supabase.co/storage/v1/object/public/avatars";
  const calls: string[] = [];
  const state = {
    storedAvatar: null as string | null,
    appMeta: { provider: "email", providers: ["email"] } as Record<string, unknown>,
    userMeta: {} as Record<string, unknown>,
  };
  const remove = vi.fn(async (paths: string[]) => { calls.push(`remove:${[...paths].sort().join(",")}`); return { data: [], error: null }; });
  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { user: { id: UID, app_metadata: state.appMeta, user_metadata: state.userMeta } } }, error: null })),
      signOut: vi.fn(async (o?: { scope?: string }) => { calls.push(`signOut:${o?.scope ?? "default"}`); return { error: null }; }),
      updateUser: vi.fn(async () => ({ data: {}, error: null })),
    },
    storage: { from: vi.fn(() => ({ remove })) },
    from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { avatar_url: state.storedAvatar }, error: null }) }) }) })),
  };
  const auth = {
    configured: true,
    loading: false,
    recovery: false,
    user: { id: UID, email: "ada@acme.co.uk" },
    updatePassword: vi.fn(async () => ({})),
    signOut: vi.fn(async () => { calls.push("auth.signOut"); }),
  };
  return { UID, BASE, calls, state, remove, client, auth };
});

vi.mock("../lib/supabase", () => ({ supabase: h.client, isSupabaseConfigured: true }));
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => h.auth }));

const photo = (name: string) => `${h.BASE}/${h.UID}/${name}`;
const path = (name: string) => `${h.UID}/${name}`;
const gif = () => new File([new Uint8Array(64)], "me.gif", { type: "image/gif" });

function renderSettings(overrides: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  const props: Parameters<typeof SettingsModal>[0] = {
    open: true,
    onClose: vi.fn(),
    initial: { firstName: "Ada", lastName: "Lovelace", pronouns: "", avatarUrl: photo("avatar-1.jpg") },
    email: "ada@acme.co.uk",
    color: "oklch(0.6 0.2 264)",
    onUpload: vi.fn(async () => photo("avatar-2.gif")),
    onSave: vi.fn(async () => { h.calls.push("save"); }),
    onExport: vi.fn(),
    onDeleteAccount: vi.fn(async () => { h.calls.push("delete"); }),
    ...overrides,
  };
  render(<SettingsModal {...props} />);
  return props;
}

async function uploadGif() {
  fireEvent.change(screen.getByLabelText("Upload profile photo"), { target: { files: [gif()] } });
  await screen.findByRole("button", { name: /change photo/i });
  await waitFor(() => expect(screen.getByRole("button", { name: /change photo/i })).toBeEnabled());
}

beforeEach(() => {
  h.calls.length = 0;
  h.state.storedAvatar = photo("avatar-1.jpg");
  h.state.appMeta = { provider: "email", providers: ["email"] };
  h.state.userMeta = {};
  vi.clearAllMocks();
});

describe("Sign out of all devices", () => {
  it("asks first, with focus on Cancel", async () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: /sign out everywhere/i }));
    const panel = screen.getByRole("group", { name: /confirm signing out of all devices/i });
    expect(within(panel).getByText(/every browser and device, including this one/i)).toBeInTheDocument();
    await waitFor(() => expect(within(panel).getByRole("button", { name: /cancel/i })).toHaveFocus());
    expect(h.client.auth.signOut).not.toHaveBeenCalled();
  });

  it("removes a photo uploaded but never saved before the session ends, and keeps the saved one", async () => {
    renderSettings();
    await uploadGif();
    fireEvent.click(screen.getByRole("button", { name: /sign out everywhere/i }));
    fireEvent.click(screen.getByRole("button", { name: /sign out everywhere/i }));
    await waitFor(() => expect(h.auth.signOut).toHaveBeenCalledTimes(1));
    expect(h.calls).toEqual([`remove:${path("avatar-2.gif")}`, "signOut:global", "auth.signOut"]);
  });

  it("puts the saved photo back in the preview if signing out fails", async () => {
    h.client.auth.signOut.mockImplementationOnce(async () => ({ error: new Error("Failed to fetch") as unknown as null }));
    renderSettings();
    await uploadGif();
    fireEvent.click(screen.getByRole("button", { name: /sign out everywhere/i }));
    fireEvent.click(screen.getByRole("button", { name: /sign out everywhere/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/nothing was signed out/i);
    expect(document.querySelector("img")?.getAttribute("src")).toBe(photo("avatar-1.jpg"));
    expect(screen.getByRole("button", { name: /sign out everywhere/i })).toBeEnabled();
  });
});

describe("Delete account", () => {
  const confirmDelete = () => {
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    fireEvent.change(screen.getByLabelText(/type delete to confirm/i), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByRole("button", { name: /delete forever/i }));
  };

  it("says comments keep the person's name", async () => {
    renderSettings();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // session lookup
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    expect(screen.getByText(/still showing your name/i)).toBeInTheDocument();
    expect(screen.queryByText(/without your name/i)).not.toBeInTheDocument();
  });

  it("removes the profile photo from the public bucket before the account goes", async () => {
    const props = renderSettings();
    await uploadGif();
    confirmDelete();
    await waitFor(() => expect(props.onDeleteAccount).toHaveBeenCalledTimes(1));
    expect(h.calls).toEqual([`remove:${[path("avatar-1.jpg"), path("avatar-2.gif")].sort().join(",")}`, "delete"]);
  });

  it("doesn't leave the profile pointing at a removed photo when deletion fails", async () => {
    const props = renderSettings({ onDeleteAccount: vi.fn(async () => { throw new Error("Couldn't delete account (500)."); }) });
    confirmDelete();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't delete account \(500\)\. Your profile photo was already removed/);
    expect(props.onSave).toHaveBeenCalledWith({ firstName: "Ada", lastName: "Lovelace", pronouns: "", avatarUrl: null });
  });
});

describe("Saving with a photo changed in another tab", () => {
  it("keeps the newer photo when this dialog didn't touch it", async () => {
    h.state.storedAvatar = photo("avatar-9.jpg"); // set elsewhere; avatar-1 was removed there
    const props = renderSettings();
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Augusta" } });
    fireEvent.click(screen.getByRole("button", { name: /save profile/i }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
    expect(props.onSave).toHaveBeenCalledWith({ firstName: "Augusta", lastName: "Lovelace", pronouns: "", avatarUrl: photo("avatar-9.jpg") });
    expect(h.calls.join()).not.toContain("avatar-9");
  });

  it("replacing the photo here also tidies away the newer one from the other tab", async () => {
    h.state.storedAvatar = photo("avatar-9.jpg");
    const props = renderSettings();
    await uploadGif();
    fireEvent.click(screen.getByRole("button", { name: /save profile/i }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: photo("avatar-2.gif") }));
    expect(h.calls).toContain(`remove:${[path("avatar-1.jpg"), path("avatar-9.jpg")].sort().join(",")}`);
  });
});

describe("Google accounts", () => {
  it("offers to set a password, then remembers one was set", async () => {
    h.state.appMeta = { provider: "google", providers: ["google"] };
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: /set a password/i }));
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: "correct horse battery" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: /^set password$/i }));
    await waitFor(() => expect(screen.getByText(/password updated/i)).toBeInTheDocument());
    expect(h.client.auth.updateUser).toHaveBeenCalledWith({ data: { kanbo_password_set: true } });
  });

  it("says Change password once a Google account has set one", async () => {
    h.state.appMeta = { provider: "google", providers: ["google"] };
    h.state.userMeta = { kanbo_password_set: true };
    renderSettings();
    await waitFor(() => expect(h.client.auth.getSession).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // let the session lookup land
    expect(screen.getByRole("button", { name: /change password/i })).toBeInTheDocument();
    expect(screen.queryByText(/add a password/i)).not.toBeInTheDocument();
  });
});

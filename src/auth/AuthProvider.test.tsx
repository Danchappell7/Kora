/* AuthProvider in Supabase mode, against a fake client. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const h = vi.hoisted(() => {
  const listeners = new Set<(event: string, session: unknown) => void>();
  const state = { session: null as null | { user: { id: string; email: string; user_metadata: Record<string, unknown> } } };
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: state.session } })),
    onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
      listeners.add(cb);
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
    }),
    verifyOtp: vi.fn(),
    signOut: vi.fn(async () => ({ error: null })),
    updateUser: vi.fn(async () => ({ data: {}, error: null })),
  };
  return { auth, listeners, state };
});
vi.mock("../lib/supabase", () => ({ isSupabaseConfigured: true, supabase: { auth: h.auth, functions: { invoke: vi.fn() } } }));

type Mod = typeof import("./AuthProvider");
async function boot(url: string) {
  window.history.replaceState(null, "", url);
  vi.resetModules();
  const mod: Mod = await import("./AuthProvider");
  const { offlineQueue } = await import("../lib/offlineQueue");
  function Probe() {
    const a = mod.useAuth();
    return (
      <div>
        <span data-testid="recovery">{String(a.recovery)}</span>
        <span data-testid="reason">{a.passwordReason ?? "none"}</span>
        <span data-testid="link-error">{a.linkError?.kind ?? "none"}</span>
        <span data-testid="user">{a.user?.id ?? "none"}</span>
        <button onClick={() => { a.verifyLink(); }}>verify</button>
        <button onClick={a.signOut}>sign out</button>
      </div>
    );
  }
  // let the stored-session read settle inside act()
  await act(async () => { render(<mod.AuthProvider><Probe /></mod.AuthProvider>); });
  return { offlineQueue };
}
const text = (id: string) => screen.getByTestId(id).textContent;

beforeEach(() => {
  h.state.session = null;
  h.listeners.clear();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("scanner-safe email links", () => {
  it("holds the invite screen without spending the token, then verifies on click and asks for a password", async () => {
    h.auth.verifyOtp.mockImplementation(async () => {
      h.state.session = { user: { id: "u-new", email: "new@company.com", user_metadata: {} } };
      return { data: { session: h.state.session, user: h.state.session.user }, error: null };
    });
    await boot("/?token_hash=th1&type=invite");
    expect(text("recovery")).toBe("true");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.auth.verifyOtp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("verify"));
    await waitFor(() => expect(text("reason")).toBe("invite"));
    expect(h.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "th1", type: "invite" });
    expect(text("recovery")).toBe("true");
    expect(text("user")).toBe("u-new");
    // survives a reload, and the spent token is gone from the address bar
    expect(sessionStorage.getItem("kanbo-needs-password")).toBe("invite");
    expect(window.location.search).toBe("");
  });

  it("sends an expired link to the 'send a new one' path", async () => {
    h.auth.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { name: "AuthApiError", status: 403, code: "otp_expired", message: "Email link is invalid or has expired" } });
    await boot("/?token_hash=old&type=recovery");
    fireEvent.click(screen.getByText("verify"));
    await waitFor(() => expect(text("link-error")).toBe("expired"));
    expect(text("recovery")).toBe("false");
  });

  it("explains an expired implicit link from the URL hash and tidies the address bar", async () => {
    await boot("/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
    expect(text("link-error")).toBe("expired");
    await waitFor(() => expect(window.location.hash).toBe(""));
  });

  it("keeps the set-password screen across a reload while signed in", async () => {
    sessionStorage.setItem("kanbo-needs-password", "recovery");
    h.state.session = { user: { id: "u1", email: "sam@company.com", user_metadata: {} } };
    await boot("/");
    await waitFor(() => expect(text("user")).toBe("u1"));
    expect(text("recovery")).toBe("true");
    expect(text("reason")).toBe("recovery");
  });
});

describe("sign-out on a shared device", () => {
  it("asks before discarding unsynced edits, and clears them when confirmed", async () => {
    h.state.session = { user: { id: "u1", email: "sam@company.com", user_metadata: {} } };
    const { offlineQueue } = await boot("/");
    await waitFor(() => expect(text("user")).toBe("u1"));
    offlineQueue.enqueueUpdate("t1", { title: "offline edit" });
    localStorage.setItem("kanbo-offline-snapshot", JSON.stringify({ uid: "u1" }));

    fireEvent.click(screen.getByText("sign out"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/unsynced|Syncing/);
    fireEvent.click(screen.getByRole("button", { name: "Stay signed in" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(h.auth.signOut).not.toHaveBeenCalled();
    expect(offlineQueue.size()).toBe(1);

    const quiet = vi.spyOn(console, "error").mockImplementation(() => {}); // jsdom can't navigate
    fireEvent.click(screen.getByText("sign out"));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out and discard" }));
    await waitFor(() => expect(h.auth.signOut).toHaveBeenCalled());
    await waitFor(() => expect(offlineQueue.size()).toBe(0));
    expect(localStorage.getItem("kanbo-offline-snapshot")).toBeNull();
    quiet.mockRestore();
  });

  it("signs straight out when nothing is waiting to sync", async () => {
    h.state.session = { user: { id: "u1", email: "sam@company.com", user_metadata: {} } };
    await boot("/");
    await waitFor(() => expect(text("user")).toBe("u1"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    fireEvent.click(screen.getByText("sign out"));
    await waitFor(() => expect(h.auth.signOut).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    quiet.mockRestore();
  });
});

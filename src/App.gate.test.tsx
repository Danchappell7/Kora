import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Profile } from "./data/types";

// a signed-in (configured) session, so the early-access gate applies; the data
// itself still comes from the demo store
const auth = vi.hoisted(() => ({
  configured: true, loading: false, recovery: false, pendingLink: null, passwordReason: null, linkError: null,
  user: { id: "u-pending", email: "new.person@acme.io" },
  clearLinkError: () => {}, verifyLink: async () => ({}), signIn: async () => ({}), signUp: async () => ({}),
  resendConfirmation: async () => ({}), signInWithGoogle: async () => ({}), resetPassword: async () => ({}), updatePassword: async () => ({}),
  signOut: async () => {},
}));
vi.mock("./auth/AuthProvider", () => ({ useAuth: () => auth, AuthProvider: ({ children }: { children: React.ReactNode }) => children }));

import App from "./App";
import { ToastProvider } from "./components/Toast";
import { store } from "./data/store";

const spies: { mockRestore: () => void }[] = [];
afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); localStorage.clear(); });

const withProfile = (p: Partial<Profile>) => {
  const real = store.bootstrap.bind(store);
  spies.push(vi.spyOn(store, "bootstrap").mockImplementation(async (u) => ({
    ...(await real(u)),
    profile: { id: "u-pending", firstName: "New", lastName: "Person", pronouns: "", email: "new.person@acme.io", avatarUrl: null, ...p },
  })));
};
const isAdmin = (v: boolean) => { const s = vi.spyOn(store, "amIAdmin").mockResolvedValue(v); spies.push(s); return s; };
const renderApp = () => render(<ToastProvider><App /></ToastProvider>);

describe("early-access gate", () => {
  it("keeps an unapproved account in the waiting room", async () => {
    withProfile({ approved: false });
    isAdmin(false);
    renderApp();
    expect(await screen.findByText("You’re on the early-access list")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
  });

  it("lets a platform admin in by the server's is_admin() (no hard-coded address)", async () => {
    withProfile({ approved: false });
    const check = isAdmin(true);
    renderApp();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
    expect(check).toHaveBeenCalled();
  });

  it("lets an admin in straight away by the profile flag", async () => {
    withProfile({ approved: false, isAdmin: true });
    const check = isAdmin(false);
    renderApp();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
    expect(check).not.toHaveBeenCalled();
  });

  it("a suspended admin is stopped unless the server still counts them as an admin", async () => {
    withProfile({ suspended: true, isAdmin: true });
    isAdmin(false);
    renderApp();
    expect(await screen.findByText("Your account is suspended")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
  });

  it("never asks the server when nobody is gated", async () => {
    withProfile({ approved: true });
    const check = isAdmin(false);
    renderApp();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
    expect(check).not.toHaveBeenCalled();
  });
});

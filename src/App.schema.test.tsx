import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// production before a migration has run: a save had to drop a column the database lacks
let stripped: string[] = [];
vi.mock("./data/store", async (orig) => {
  const real = await orig<typeof import("./data/store")>();
  return { ...real, getStrippedColumns: () => stripped };
});

import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { store } from "./data/store";

const boot = async () => {
  render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
  await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
};
const NOTICE = /the database is behind this version — workspace_id isn't being saved yet/;

const spies: { mockRestore: () => void }[] = [];
const track = <T extends { mockRestore: () => void }>(s: T): T => { spies.push(s); return s; };
const wasConfigured = store.configured;
beforeEach(() => {
  stripped = ["workspace_id"];
  (store as { configured: boolean }).configured = true; // only the notice's guard reads it at boot
});
afterEach(() => {
  spies.splice(0).forEach((s) => s.mockRestore());
  (store as { configured: boolean }).configured = wasConfigured;
  localStorage.clear();
});

describe("App: the schema-behind notice", () => {
  it("is not shown to an ordinary member (monitoring still has it)", async () => {
    const admin = track(vi.spyOn(store, "amIAdmin")).mockResolvedValue(false);
    await boot();
    await waitFor(() => expect(admin).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it("is shown once to a platform admin, naming what isn't being saved", async () => {
    track(vi.spyOn(store, "amIAdmin")).mockResolvedValue(true);
    await boot();
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(screen.getAllByText(NOTICE)).toHaveLength(1);
  });

  it("trusts the profile's admin flag without asking the server", async () => {
    const real = store.bootstrap.bind(store);
    track(vi.spyOn(store, "bootstrap").mockImplementation(async (u) => {
      const b = await real(u);
      const base = b.profile ?? { id: "m-self", firstName: "Sam", lastName: "Rivera", pronouns: "", email: "sam@example.com", avatarUrl: null };
      return { ...b, profile: { ...base, isAdmin: true } };
    }));
    const admin = track(vi.spyOn(store, "amIAdmin")).mockResolvedValue(false);
    await boot();
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(admin).not.toHaveBeenCalled();
  });

  it("says nothing when no column was dropped", async () => {
    stripped = [];
    const admin = track(vi.spyOn(store, "amIAdmin")).mockResolvedValue(true);
    await boot();
    await new Promise((r) => setTimeout(r, 50));
    expect(admin).not.toHaveBeenCalled();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});

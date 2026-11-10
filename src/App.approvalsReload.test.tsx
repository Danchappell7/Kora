/* A reload of everything (the realtime resync, or project access changing: 0058 touches the workspace)
   reads "Approvals for you" again: being taken off a project, or it being made private, writes no
   approval rows, so nothing else would drop a request for a task you can't see any more. */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

const calls = { mine: 0, summaries: 0 };
vi.mock("./lib/approvals", async (orig) => {
  const real = await orig<typeof import("./lib/approvals")>();
  return {
    ...real,
    listMyApprovals: (...a: Parameters<typeof real.listMyApprovals>) => { calls.mine++; return real.listMyApprovals(...a); },
    listApprovalSummaries: (...a: Parameters<typeof real.listApprovalSummaries>) => { calls.summaries++; return real.listApprovalSummaries(...a); },
  };
});

import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { store } from "./data/store";
import type { RealtimeChange } from "./data/store";

beforeAll(loadAllChunks, 60_000);
const wasConfigured = store.configured;
afterEach(() => {
  vi.restoreAllMocks();
  (store as { configured: boolean }).configured = wasConfigured;
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("App: a reload reads approvals again", () => {
  it("after a resync, 'Approvals for you' and the chips are asked for afresh", async () => {
    let onChange: ((c?: RealtimeChange) => void) | null = null;
    vi.spyOn(store, "subscribeToChanges").mockImplementation((fn: (c?: RealtimeChange) => void) => { onChange = fn; return () => {}; });
    (store as { configured: boolean }).configured = true;   // (the reload's subscription runs only against a real database)
    localStorage.setItem("kanbo-onboarded", "1"); localStorage.setItem("kanbo-onboarded:m-self", "1"); localStorage.setItem("kanbo-tour-done", "1");
    localStorage.setItem("kanbo-last-ws:m-self", "ws-foundrise");
    window.history.replaceState(null, "", "/today");
    render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
    await waitFor(() => expect(calls.mine).toBeGreaterThan(0));
    await waitFor(() => expect(onChange).not.toBeNull());
    const before = { ...calls };
    await act(async () => { onChange!({ kind: "resync" } as RealtimeChange); await new Promise((r) => setTimeout(r, 100)); });
    await waitFor(() => expect(calls.mine).toBeGreaterThan(before.mine));
    expect(calls.summaries).toBeGreaterThan(before.summaries);
  });
});

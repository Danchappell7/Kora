import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";

const h = vi.hoisted(() => ({ configured: false }));
vi.mock("../../lib/supabase", () => ({
  get isSupabaseConfigured() { return h.configured; },
  supabase: null,
}));

import { SystemStatus } from "./SystemStatus";

const OK = {
  ok: true,
  db: { ok: true, ms: 31, error: null }, auth: { ok: true, ms: 48, error: null },
  storage: { ok: true, ms: 1450, error: null }, functions: { ok: true, ms: 77, error: null },
  time: "2026-10-09T09:00:00.000Z", schema: "0047",
};

describe("SystemStatus (demo)", () => {
  beforeEach(() => { h.configured = false; });

  it("checks, then shows four working checks, the build and the links", async () => {
    render(<SystemStatus release={null} builtAt={null} />);
    expect(screen.getByRole("heading", { name: "System status" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Checking…");
    expect(await screen.findByText("All systems working")).toBeInTheDocument();
    expect(screen.getByText(/Demo data/)).toBeInTheDocument();
    const checks = within(screen.getByRole("list", { name: "Health check" })).getAllByRole("listitem");
    expect(checks).toHaveLength(4);
    expect(checks[0]).toHaveTextContent(/Database: working/);
    expect(checks[0]).toHaveTextContent(/\d+ ms/);
    expect(screen.getByText("Local build")).toBeInTheDocument();
    expect(screen.getByText(/Database schema/)).toHaveTextContent("0047");
    const nav = screen.getByRole("navigation", { name: "Operations links" });
    const hrefs = within(nav).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "https://supabase.com/dashboard/project/htnchiljplrnjkwimgla",
      "https://supabase.com/dashboard/project/htnchiljplrnjkwimgla/functions",
      "https://vercel.com/danchappell7-gmailcoms-projects/kora/deployments",
      "https://github.com/Danchappell7/Kora/actions/workflows/uptime.yml",
      "https://sentry.io/",
    ]);
    for (const a of within(nav).getAllByRole("link")) expect(a).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/Off/)).toHaveTextContent("Off");
  });

  it("links the running commit and says when it was built", async () => {
    render(<SystemStatus release="a5d8cd6f00112233445566778899aabbccddeeff" builtAt="2026-10-09T08:05:00.000Z" />);
    const commit = screen.getByRole("link", { name: /a5d8cd6/ });
    expect(commit).toHaveAttribute("href", "https://github.com/Danchappell7/Kora/commit/a5d8cd6f00112233445566778899aabbccddeeff");
    expect(screen.getByText(/9 Oct 2026, 09:05/)).toBeInTheDocument();
    await screen.findByText("All systems working");
  });
});

describe("SystemStatus (live)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    h.configured = true;
    vi.stubEnv("VITE_SUPABASE_URL", "https://htnchiljplrnjkwimgla.supabase.co");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("calls the health function and shows a slow check and a failing one", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...OK, ok: false, db: { ok: false, ms: 3002, error: "timeout" } }), { status: 503 }));
    render(<SystemStatus release={null} builtAt={null} />);
    expect(await screen.findByText("Database is failing")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("https://htnchiljplrnjkwimgla.supabase.co/functions/v1/health", expect.objectContaining({ method: "GET" }));
    expect(screen.getByText("Didn’t answer within 3 seconds")).toBeInTheDocument();
    expect(screen.getByText("Working, but slow")).toBeInTheDocument();
    expect(screen.queryByText(/Demo data/)).not.toBeInTheDocument();
  });

  it("explains a function that isn't deployed, with a copyable command", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 }));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SystemStatus release={null} builtAt={null} />);
    expect(await screen.findByText("The health check isn’t deployed yet")).toBeInTheDocument();
    expect(screen.getByLabelText("Deploy command")).toHaveTextContent("supabase functions deploy health --project-ref htnchiljplrnjkwimgla --no-verify-jwt");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy the deploy command" })); });
    expect(writeText).toHaveBeenCalledWith("supabase functions deploy health --project-ref htnchiljplrnjkwimgla --no-verify-jwt");
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("says when it can't reach the function, and checks again on demand", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<SystemStatus release={null} builtAt={null} />);
    expect(await screen.findByText("Couldn’t reach the health check", { selector: ".ksys-banner-title" })).toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OK), { status: 200 }));
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(await screen.findByText("All systems working")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Couldn’t reach the health check", { selector: ".ksys-banner-title" })).not.toBeInTheDocument();
  });
});

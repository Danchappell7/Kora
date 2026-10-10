import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { ToastProvider, ACTION_TOAST_MIN_MS } from "../Toast";
import { SavedViewEditor, SaveViewButton, sameViewQuery } from "./SavedViewEditor";
import { getSavedView, resetSavedViewsForTests, createSavedView, listSavedViews, warmSavedViews, DEMO_SAVED_VIEWS } from "../../lib/views";

beforeAll(async () => { await warmSavedViews(); });
import type { SavedView, SavedViewQuery } from "../../data/types";

const flush = async () => { await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); }); };
const wrap = (ui: React.ReactElement) => render(<ToastProvider>{ui}</ToastProvider>);
const QUERY: SavedViewQuery = { v: 1, projectId: "p-launch", viewType: "board", filters: { status: "blocked" }, groupBy: "assignee" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  resetSavedViewsForTests();
});
afterEach(() => { vi.useRealTimers(); });

describe("SaveViewButton", () => {
  it("shows only while something is filtered", () => {
    const { rerender } = wrap(<SaveViewButton kind="project" query={QUERY} active={false} workspaceId="ws-foundrise" canShare />);
    expect(screen.queryByRole("button", { name: "Save view" })).not.toBeInTheDocument();
    rerender(<ToastProvider><SaveViewButton kind="project" query={QUERY} active workspaceId="ws-foundrise" canShare /></ToastProvider>);
    expect(screen.getByRole("button", { name: "Save view" })).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("opens the sheet prefilled; Save pins it, shares it when asked, and says so", async () => {
    const onSaved = vi.fn();
    wrap(<SaveViewButton kind="project" query={QUERY} active workspaceId="ws-foundrise" workspaceName="Foundrise" canShare suggestedName="Blocked in Q3 Product Launch" onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    const dialog = screen.getByRole("dialog", { name: "Save view" });
    expect(within(dialog).getByRole("textbox", { name: "View name" })).toHaveValue("Blocked in Q3 Product Launch");
    expect(within(dialog).getByText("Q3 Product Launch · Board")).toBeInTheDocument();
    expect(within(dialog).getByRole("list", { name: "Filters, grouping and sort" })).toHaveTextContent("Status: Blocked");
    expect(within(dialog).getByRole("switch", { name: "Pin to sidebar" })).toHaveAttribute("aria-checked", "true");
    const share = within(dialog).getByRole("switch", { name: "Share with Foundrise" });
    expect(share).toHaveAttribute("aria-checked", "false");
    fireEvent.click(share);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "View name" }), { target: { value: "Launch blockers" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));
    await flush();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: "Launch blockers", shared: true, pinned: true, kind: "project", workspaceId: "ws-foundrise", query: QUERY }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved “Launch blockers” to your sidebar");
    expect(getSavedView(onSaved.mock.calls[0][0].id)).toBeTruthy();
  });

  it("Enter in the name saves; an empty name can't", async () => {
    const onSaved = vi.fn();
    wrap(<SaveViewButton kind="my_tasks" query={{ v: 1, filters: { priority: "urgent" } }} active workspaceId={null} canShare={false} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    const name = screen.getByRole("textbox", { name: "View name" });
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Save view" })).toBeDisabled();
    fireEvent.change(name, { target: { value: "Urgent" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await flush();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: "Urgent", shared: false }));
  });

  it("with the page's own view applied and changed filters, offers Update or Save as new", async () => {
    const applied = await createSavedView({ workspaceId: "ws-foundrise", name: "Blockers", kind: "project", query: QUERY });
    const next: SavedViewQuery = { ...QUERY, filters: { status: "review" } };
    wrap(<SaveViewButton kind="project" query={next} active workspaceId="ws-foundrise" canShare appliedView={applied} canEditApplied />);
    const btn = screen.getByRole("button", { name: "Save view" });
    expect(btn).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("menuitem", { name: /Update “Blockers”/ }));
    await flush();
    expect(getSavedView(applied.id)!.query.filters).toEqual({ status: "review" });
    expect(screen.getByRole("status")).toHaveTextContent("Updated “Blockers”");
  });

  it("compares queries whatever their key order", () => {
    expect(sameViewQuery({ v: 1, filters: { a: "1", b: "2" } }, { filters: { b: "2", a: "1" }, v: 1 })).toBe(true);
    expect(sameViewQuery({ v: 1, filters: { a: "1" } }, { v: 1, filters: { a: "2" } })).toBe(false);
  });
});

describe("SavedViewEditor", () => {
  const sanas = (): SavedView => ({ ...DEMO_SAVED_VIEWS.find((v) => v.id === "sv-demo-blocked")! });

  it("explains scope: personal views are only yours; a guest's are private", () => {
    const { unmount } = wrap(<SavedViewEditor open draft={{ kind: "search", query: { v: 1, filters: { tag: "design" } } }} workspaceId={null} canShare={false} onClose={() => undefined} />);
    expect(screen.getByText("Personal views are only for you.")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Share/ })).not.toBeInTheDocument();
    unmount();
    wrap(<SavedViewEditor open draft={{ kind: "my_tasks", query: { v: 1 } }} workspaceId="ws-foundrise" workspaceName="Foundrise" canShare={false} onClose={() => undefined} />);
    expect(screen.getByText("Only you will see this view.")).toBeInTheDocument();
    expect(screen.getByText("No filters: everything in this list.")).toBeInTheDocument();
  });

  it("an admin editing a teammate's shared view is told it changes for everyone", async () => {
    const onClose = vi.fn();
    wrap(<SavedViewEditor open view={sanas()} workspaceId="ws-foundrise" workspaceName="Foundrise" canShare canEdit currentUserId="m-self" onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Edit view" })).toBeInTheDocument();
    expect(screen.getByText(/Made by Sana Rao\. Your changes apply for everyone in Foundrise\./)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), { target: { value: "Launch blockers" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await flush();
    expect(getSavedView("sv-demo-blocked")!.name).toBe("Launch blockers");
    expect(onClose).toHaveBeenCalled();
  });

  it("delete asks first, then hides it with Undo; it goes for real when the Undo window closes", async () => {
    await createSavedView({ workspaceId: "ws-foundrise", name: "Mine", kind: "my_tasks", query: { v: 1 } });
    const view = { ...getSavedView("sv-demo-urgent")! };
    const onDeleted = vi.fn();
    wrap(<SavedViewEditor open view={view} workspaceId="ws-foundrise" workspaceName="Foundrise" canShare currentUserId="m-self" onClose={() => undefined} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("group", { name: "Confirm delete" });
    expect(confirm).toHaveTextContent("Delete this view?");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(onDeleted).toHaveBeenCalledWith("sv-demo-urgent");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(getSavedView("sv-demo-urgent")).toBeTruthy();
  });

  it("an expired Undo deletes the view", async () => {
    await listSavedViews("ws-foundrise");
    const view = { ...getSavedView("sv-demo-urgent")! };
    wrap(<SavedViewEditor open view={view} workspaceId="ws-foundrise" canShare currentUserId="m-self" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm delete" })).getByRole("button", { name: "Delete" }));
    await act(async () => { vi.advanceTimersByTime(ACTION_TOAST_MIN_MS + 100); await Promise.resolve(); await Promise.resolve(); });
    expect(getSavedView("sv-demo-urgent")).toBeUndefined();
  });

  it("someone who can't change it sees it read-only", () => {
    wrap(<SavedViewEditor open view={sanas()} workspaceId="ws-foundrise" workspaceName="Foundrise" canShare={false} canEdit={false} currentUserId="m-4" onClose={() => undefined} />);
    expect(screen.getByRole("dialog", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveAttribute("readonly");
    expect(screen.getByRole("switch", { name: "Pin to sidebar" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.getByText(/Made by Sana Rao\. Shared with Foundrise\./)).toBeInTheDocument();
  });

  it("picks an icon (or none) from the emoji picker", async () => {
    const onSaved = vi.fn();
    wrap(<SavedViewEditor open draft={{ kind: "my_tasks", query: { v: 1 }, name: "Focus" }} workspaceId={null} canShare={false} onClose={() => undefined} onSaved={onSaved} />);
    const btn = screen.getByRole("button", { name: "Choose an icon" });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    const picker = screen.getByRole("dialog", { name: "Choose an icon" });
    fireEvent.click(within(picker).getAllByRole("button").find((b) => b.textContent === "🚀")!);
    expect(screen.getByRole("button", { name: "Icon 🚀. Change the icon" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await flush();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ emoji: "🚀" }));
  });

  it("a name that's too long is caught before saving, with a count", async () => {
    wrap(<SavedViewEditor open draft={{ kind: "my_tasks", query: { v: 1 } }} workspaceId={null} canShare={false} onClose={() => undefined} />);
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), { target: { value: "x".repeat(81) } });
    expect(screen.getByText("81 / 80")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Keep the name under 81 characters.");
  });
});

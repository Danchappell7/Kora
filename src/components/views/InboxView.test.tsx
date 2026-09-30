import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { InboxView } from "./InboxView";
import type { Activity, Task } from "../../data/types";

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const act_ = (p: Partial<Activity> & { id: string }): Activity => ({
  taskId: "t1", taskTitle: "Q3 budget", kind: "comment", detail: "", createdAt: iso(60_000), readAt: iso(), ...p,
});
const task = { id: "t1", title: "Q3 budget", projectId: "p-launch", status: "todo", assigneeId: "m-1", aiScore: 1 } as unknown as Task;

function inbox(activity: Activity[], extra: Partial<Parameters<typeof InboxView>[0]> = {}) {
  const props = { activity, tasks: [task], onOpen: vi.fn(), onArchive: vi.fn(), onClearAll: vi.fn(), ...extra };
  const utils = render(<InboxView {...props} />);
  return { ...utils, props };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe("InboxView — who did what", () => {
  it("renders a teammate's comment as '<name> commented on <task>', not 'You commented'", () => {
    inbox([act_({ id: "a1", kind: "comment", detail: "Maya Lin" })]);   // Maya Lin is a known member
    const row = screen.getByRole("button", { name: /Maya Lin commented on Q3 budget/ });
    expect(row).toBeInTheDocument();
    expect(screen.queryByText(/You commented/)).toBeNull();
    expect(screen.queryByText("“Maya Lin”")).toBeNull();
  });

  it("treats an email or a departed teammate's full name as the commenter too", () => {
    inbox([
      act_({ id: "a1", detail: "sam@partner.io" }),
      act_({ id: "a2", detail: "Priya Natarajan" }),
    ]);
    expect(screen.getByRole("button", { name: /sam@partner\.io commented on/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Priya Natarajan commented on/ })).toBeInTheDocument();
  });

  it("keeps legacy self-logged comment rows as 'You commented on' with the excerpt", () => {
    inbox([act_({ id: "a1", detail: "Looks great, ship it!" })]);
    expect(screen.getByRole("button", { name: /You commented on Q3 budget/ })).toBeInTheDocument();
    expect(screen.getByText("“Looks great, ship it!”")).toBeInTheDocument();
  });

  // rows from before the release that stops self-logged comment rows are a mix;
  // from it on, every comment row is a teammate's
  const OLD = "2026-09-20T10:00:00.000Z", NEW = "2026-10-13T10:00:00.000Z";

  it("older rows: a single-word name is the commenter, a stock reply in Title Case is your own comment", () => {
    inbox([
      act_({ id: "a1", detail: "Priya", createdAt: OLD }),
      act_({ id: "a2", detail: "Great Work", createdAt: OLD, taskTitle: "Brief" }),
      act_({ id: "a3", detail: "Sounds Good.", createdAt: OLD, taskTitle: "Roadmap" }),
    ]);
    expect(screen.getByRole("button", { name: /Priya commented on Q3 budget/ })).toBeInTheDocument();
    expect(screen.queryByText("“Priya”")).toBeNull();
    expect(screen.getByRole("button", { name: /You commented on Brief/ })).toBeInTheDocument();
    expect(screen.getByText("“Great Work”")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /You commented on Roadmap/ })).toBeInTheDocument();
  });

  it("newer rows: any name shape is the commenter, but a sentence still reads as your own", () => {
    inbox([
      act_({ id: "a1", detail: "priya", createdAt: NEW }),
      act_({ id: "a2", detail: "Looks great, ship it!", createdAt: NEW, taskTitle: "Brief" }),
    ]);
    expect(screen.getByRole("button", { name: /priya commented on Q3 budget/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /You commented on Brief/ })).toBeInTheDocument();
  });

  it("labels row actions with the item name", () => {
    inbox([act_({ id: "a1", kind: "assigned", detail: "Theo Vance" })]);
    expect(screen.getByRole("button", { name: "Archive “Q3 budget”" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Snooze “Q3 budget”" })).toBeInTheDocument();
  });
});

describe("InboxView — unread snapshot", () => {
  it("keeps the unread marker for items that were unread on arrival, even after they're marked read", () => {
    const rows = [act_({ id: "u1", kind: "mention", detail: "Theo Vance", readAt: undefined }), act_({ id: "r1", kind: "assigned", detail: "Sana Rao" })];
    const { rerender, props } = inbox(rows);
    expect(screen.getByRole("button", { name: /^Unread: Theo Vance mentioned you in/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Sana Rao assigned you/ })).toBeInTheDocument();
    // App marks everything read right after the inbox opens
    rerender(<InboxView {...props} activity={rows.map((a) => ({ ...a, readAt: iso() }))} />);
    expect(screen.getByRole("button", { name: /^Unread: Theo Vance mentioned you in/ })).toBeInTheDocument();
  });

  it("flags items that arrive while the inbox is open, and clears the flag when opened", () => {
    const { rerender, props } = inbox([act_({ id: "r1", kind: "assigned", detail: "Sana Rao" })]);
    const next = [act_({ id: "n1", kind: "mention", detail: "Theo Vance", readAt: undefined, createdAt: iso() }), ...props.activity];
    rerender(<InboxView {...props} activity={next} />);
    const row = screen.getByRole("button", { name: /^Unread: Theo Vance mentioned you in/ });
    fireEvent.click(row);
    expect(props.onOpen).toHaveBeenCalledWith("t1");
    expect(screen.getByRole("button", { name: /^Theo Vance mentioned you in/ })).toBeInTheDocument();
  });
});

describe("InboxView — archive all", () => {
  it("confirms, then archives only what's shown (active filter, minus snoozed)", () => {
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ c2: Date.now() + 3_600_000 }));
    const { props } = inbox([
      act_({ id: "c1", detail: "Maya Lin" }),
      act_({ id: "c2", detail: "Theo Vance" }),              // snoozed
      act_({ id: "m1", kind: "mention", detail: "Sana Rao" }), // other filter
    ]);
    fireEvent.click(screen.getByRole("button", { name: /^Comments/ }));
    fireEvent.click(screen.getByRole("button", { name: /Archive all/ }));
    expect(props.onClearAll).not.toHaveBeenCalled();
    expect(screen.getByText(/Archive 1 comment\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Archive$/ }));
    expect(props.onClearAll).toHaveBeenCalledWith(["c1"]);
  });

  it("can be cancelled with Escape", () => {
    const { props } = inbox([act_({ id: "c1", detail: "Maya Lin" })]);
    fireEvent.click(screen.getByRole("button", { name: /Archive all/ }));
    fireEvent.keyDown(screen.getByRole("button", { name: /^Archive$/ }), { key: "Escape" });
    expect(screen.getByRole("button", { name: /Archive all/ })).toBeInTheDocument();
    expect(props.onClearAll).not.toHaveBeenCalled();
  });
});

describe("InboxView — snooze", () => {
  it("opens the snooze menu in a portal (outside the clipping card) and hides the snoozed row", () => {
    const { container } = inbox([act_({ id: "a1", detail: "Maya Lin" }), act_({ id: "a2", kind: "assigned", detail: "Sana Rao", taskTitle: "Brief" })]);
    fireEvent.click(screen.getByRole("button", { name: "Snooze “Q3 budget”" }));
    const menu = screen.getByRole("menu", { name: /Snooze “Q3 budget”/ });
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Tomorrow, 9am/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button", { name: /commented on Q3 budget/ })).toBeNull();
    expect(screen.getByText(/1 snoozed/)).toBeInTheDocument();
    const saved = JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}");
    expect(saved.a1).toBeGreaterThan(Date.now());
  });

  it("opens upward when the trigger sits near the bottom of the viewport", () => {
    const h = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(130);
    const w = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(208);
    try {
      inbox([act_({ id: "a1", detail: "Maya Lin" })]);
      const trigger = screen.getByRole("button", { name: "Snooze “Q3 budget”" });
      trigger.getBoundingClientRect = () => ({ top: window.innerHeight - 40, bottom: window.innerHeight - 10, left: 500, right: 530, width: 30, height: 30, x: 500, y: window.innerHeight - 40, toJSON: () => ({}) });
      fireEvent.click(trigger);
      const menu = screen.getByRole("menu");
      expect(menu.style.top).toBe(`${window.innerHeight - 40 - 6 - 130}px`);
      expect(menu.style.transformOrigin).toBe("100% 100%");
    } finally { h.mockRestore(); w.mockRestore(); }
  });

  it("closes the menu on Escape and returns focus to the trigger", () => {
    inbox([act_({ id: "a1", detail: "Maya Lin" })]);
    const trigger = screen.getByRole("button", { name: "Snooze “Q3 budget”" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("brings expired snoozes back at the top, flagged, and only once", () => {
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ old: Date.now() - 1000 }));
    inbox([act_({ id: "new", kind: "assigned", detail: "Sana Rao", taskTitle: "Fresh" }), act_({ id: "old", detail: "Maya Lin", createdAt: iso(3 * 86400000) })]);
    const back = screen.getByRole("region", { name: "Back from snooze" });
    expect(within(back).getByRole("button", { name: /^Unread: Maya Lin commented on/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}")).toEqual({});
  });

  it("'Bring back now' only unsnoozes this inbox's items, and brings them back at the top", () => {
    const later = Date.now() + 3_600_000;
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ a1: later, otherWsItem: later }));
    inbox([act_({ id: "a1", detail: "Maya Lin" }), act_({ id: "a2", kind: "assigned", detail: "Theo Vance", taskTitle: "Brief" })]);
    expect(screen.getByText(/1 snoozed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bring back now" }));
    const back = screen.getByRole("region", { name: "Back from snooze" });
    expect(within(back).getByRole("button", { name: /Maya Lin commented on Q3 budget/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}")).toEqual({ otherWsItem: later });
  });

  it("keeps an ended snooze for another workspace's item until that inbox shows it", () => {
    const ended = Date.now() - 1000;
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ x9: ended }));
    const first = inbox([act_({ id: "a1", detail: "Maya Lin" })]);
    expect(screen.queryByRole("region", { name: "Back from snooze" })).toBeNull();
    first.unmount();
    expect(JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}")).toEqual({ x9: ended });
    inbox([act_({ id: "x9", kind: "assigned", detail: "Theo Vance", taskTitle: "Other" })]);
    const back = screen.getByRole("region", { name: "Back from snooze" });
    expect(within(back).getByRole("button", { name: /^Unread: Theo Vance assigned you Other/ })).toBeInTheDocument();
  });

  it("drops snoozes that ended long ago without flagging them", () => {
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ a1: Date.now() - 20 * 86400000, gone: Date.now() - 20 * 86400000 }));
    inbox([act_({ id: "a1", detail: "Maya Lin" })]);
    expect(screen.queryByRole("region", { name: "Back from snooze" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Maya Lin commented on/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}")).toEqual({});
  });

  it("snoozing again keeps other inboxes' ended snoozes", () => {
    const ended = Date.now() - 1000;
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ x9: ended }));
    inbox([act_({ id: "a1", detail: "Maya Lin" })]);
    fireEvent.click(screen.getByRole("button", { name: "Snooze “Q3 budget”" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /In 3 hours/ }));
    const saved = JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}");
    expect(saved.x9).toBe(ended);
    expect(saved.a1).toBeGreaterThan(Date.now());
  });

  it("wakes a snooze while the inbox stays open", () => {
    vi.useFakeTimers();
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ a1: Date.now() + 5000 }));
    inbox([act_({ id: "a1", detail: "Maya Lin" })]);
    expect(screen.queryByRole("button", { name: /commented on Q3 budget/ })).toBeNull();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.getByRole("region", { name: "Back from snooze" })).toBeInTheDocument();
  });
});

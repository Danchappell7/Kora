import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import { InboxView } from "./InboxView";
import type { Activity, Task } from "../../data/types";
import { presetDate, todayISO } from "../../data/data";

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
  it("confirms, then archives only what's shown (minus snoozed)", () => {
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ c2: Date.now() + 3_600_000 }));
    const { props } = inbox([
      act_({ id: "c1", detail: "Maya Lin" }),
      act_({ id: "c2", detail: "Theo Vance" }),              // snoozed
      act_({ id: "m1", kind: "mention", detail: "Sana Rao" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Archive all/ }));
    expect(props.onClearAll).not.toHaveBeenCalled();
    expect(screen.getByText(/Archive 2 items\? The snoozed item stays\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Archive$/ }));
    expect(props.onClearAll).toHaveBeenCalledWith(["c1", "m1"]);
  });

  it("'Archive FYI' confirms, then archives only the FYI group", () => {
    const { props } = inbox([
      act_({ id: "c1", detail: "Maya Lin" }),
      act_({ id: "m1", kind: "mention", detail: "Sana Rao" }),   // needs your reply: stays
      act_({ id: "c3", detail: "Theo Vance", taskTitle: "Brief" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Archive FYI items" }));
    expect(screen.getByText(/Archive 2 FYI items\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Archive$/ }));
    expect(props.onClearAll).toHaveBeenCalledWith(["c1", "c3"]);
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

/* ---------- the triage queue ---------- */

const key = (k: string, extra: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...extra });

describe("InboxView — triage groups", () => {
  it("sorts the queue into Needs your reply, New to you and FYI", () => {
    inbox([
      act_({ id: "c1", detail: "Maya Lin" }),
      act_({ id: "m1", kind: "mention", detail: "Sana Rao" }),
      act_({ id: "a1", kind: "assigned", detail: "Theo Vance" }),
    ], { currentUserId: "m-self" });
    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(regions).toEqual(["Needs your reply", "New to you", "FYI"]);
    expect(within(screen.getByRole("region", { name: "Needs your reply" })).getByRole("button", { name: /Sana Rao mentioned you in Q3 budget/ })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "New to you" })).getByRole("button", { name: /Theo Vance assigned you Q3 budget/ })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "FYI" })).getByRole("button", { name: /Maya Lin commented on Q3 budget/ })).toBeInTheDocument();
  });

  it("hides empty groups", () => {
    inbox([act_({ id: "c1", detail: "Maya Lin" })]);
    expect(screen.queryByRole("region", { name: "Needs your reply" })).toBeNull();
    expect(screen.queryByRole("region", { name: "New to you" })).toBeNull();
    expect(screen.getByRole("region", { name: "FYI" })).toBeInTheDocument();
  });

  it("a request assigned to you reads as a new request, not as someone's name", () => {
    const req = { ...task, id: "t9", title: "Update pricing FAQ", assigneeId: "m-self", description: "Request via Launch requests" } as Task;
    inbox([act_({ id: "r1", taskId: "t9", taskTitle: "Update pricing FAQ", kind: "created", detail: "Task created" })],
      { tasks: [task, req], currentUserId: "m-self" });
    const group = screen.getByRole("region", { name: "New to you" });
    expect(within(group).getByRole("button", { name: /New request: Update pricing FAQ/ })).toBeInTheDocument();
    expect(within(group).getByText("via Launch requests")).toBeInTheDocument();
  });
});

describe("InboxView — one-key actions", () => {
  it("J/K move the cursor and Enter opens the task", () => {
    const t2 = { ...task, id: "t2", title: "Brief" } as Task;
    const { props } = inbox([
      act_({ id: "m1", kind: "mention", detail: "Sana Rao" }),
      act_({ id: "c1", taskId: "t2", taskTitle: "Brief", detail: "Maya Lin" }),
    ], { tasks: [task, t2] });
    key("j");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Sana Rao mentioned you in Q3 budget/ }));
    key("j");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Maya Lin commented on Brief/ }));
    key("k");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Sana Rao mentioned you in/ }));
    // Enter on the focused row is the row's own click
    fireEvent.click(document.activeElement!);
    expect(props.onOpen).toHaveBeenCalledWith("t1");
  });

  it("the second key of a g-sequence is left to the app", () => {
    const onSchedule = vi.fn();
    inbox([act_({ id: "a1", kind: "assigned", detail: "Theo Vance" })], { onSchedule });
    key("j");
    key("g"); key("d");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("R opens an inline reply; ⌘↵ sends it to the task with the person mentioned", async () => {
    const onReply = vi.fn().mockResolvedValue({ id: "c-9" });
    inbox([act_({ id: "m1", kind: "mention", detail: "Sana Rao" })], { onReply, currentUserId: "m-self" });
    key("j");
    key("r");
    const box = screen.getByRole("textbox", { name: "Reply to Sana" });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "On it, sending tonight" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onReply).toHaveBeenCalledWith("t1", "On it, sending tonight", ["m-3"]));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(screen.getByText("Replied")).toBeInTheDocument();
  });

  it("a reply that fails keeps the draft and says so", async () => {
    const onReply = vi.fn().mockResolvedValue(null);   // App's addComment resolves null on failure
    inbox([act_({ id: "m1", kind: "mention", detail: "Sana Rao" })], { onReply });
    fireEvent.click(screen.getByRole("button", { name: "Reply to “Q3 budget”" }));
    const box = screen.getByRole("textbox", { name: "Reply to Sana" });
    fireEvent.change(box, { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't send your reply");
    expect(screen.getByRole("textbox", { name: "Reply to Sana" })).toHaveValue("Draft");
  });

  it("Escape puts the reply away without sending", () => {
    const onReply = vi.fn();
    inbox([act_({ id: "m1", kind: "mention", detail: "Sana Rao" })], { onReply });
    fireEvent.click(screen.getByRole("button", { name: "Reply to “Q3 budget”" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onReply).not.toHaveBeenCalled();
  });

  it("A adds the task to Today (by key and by mouse)", () => {
    const onAcceptToday = vi.fn();
    const t2 = { ...task, id: "t2", title: "Brief" } as Task;
    inbox([
      act_({ id: "a1", kind: "assigned", detail: "Theo Vance" }),
      act_({ id: "a2", taskId: "t2", taskTitle: "Brief", kind: "assigned", detail: "Maya Lin" }),
    ], { tasks: [task, t2], onAcceptToday });
    key("j");
    key("a");
    expect(onAcceptToday).toHaveBeenCalledWith("t1");
    expect(screen.getByText("On Today")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add “Brief” to Today" }));
    expect(onAcceptToday).toHaveBeenLastCalledWith("t2");
  });

  it("D opens the date picker for the row and schedules the task", () => {
    const onSchedule = vi.fn();
    inbox([act_({ id: "a1", kind: "assigned", detail: "Theo Vance" })], { onSchedule });
    key("j");
    key("d");
    const picker = screen.getByRole("dialog", { name: "Due date for “Q3 budget”" });
    fireEvent.click(within(picker).getByRole("button", { name: "Tomorrow" }));
    expect(onSchedule).toHaveBeenCalledWith("t1", presetDate("tomorrow"));
  });

  it("H opens the snooze menu and E archives the row", () => {
    const { props } = inbox([act_({ id: "a1", kind: "assigned", detail: "Theo Vance" })]);
    key("j");
    key("h");
    expect(screen.getByRole("menu", { name: /Snooze “Q3 budget”/ })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    key("e");
    expect(props.onArchive).toHaveBeenCalledWith("a1");
  });

  it("guests can reply but can't plan or schedule", () => {
    inbox([act_({ id: "a1", kind: "assigned", detail: "Theo Vance" })],
      { readOnly: true, onReply: vi.fn(), onAcceptToday: vi.fn(), onSchedule: vi.fn() });
    expect(screen.getByRole("button", { name: "Reply to “Q3 budget”" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add “Q3 budget” to Today" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Schedule “Q3 budget”" })).toBeNull();
  });

  it("the ⋯ menu offers the same actions", () => {
    const onComplete = vi.fn();
    inbox([act_({ id: "a1", kind: "assigned", detail: "Theo Vance" })], { onComplete, onAcceptToday: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "More actions for “Q3 budget”" }));
    const menu = screen.getByRole("menu", { name: "Actions for “Q3 budget”" });
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Open task/), expect.stringMatching(/^Add to Today/), expect.stringMatching(/^Snooze…/), "Mark task done", expect.stringMatching(/^Archive/)]),
    );
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Mark task done" }));
    expect(onComplete).toHaveBeenCalledWith("t1");
  });
});

describe("InboxView — Snoozed and Archived", () => {
  it("Snoozed lists what's coming back, and brings one back now", () => {
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ a1: Date.now() + 3_600_000 }));
    inbox([act_({ id: "a1", kind: "assigned", detail: "Theo Vance" }), act_({ id: "c1", detail: "Maya Lin", taskTitle: "Brief" })]);
    fireEvent.click(screen.getByRole("button", { name: /^Snoozed/ }));
    const list = screen.getByRole("region", { name: "Snoozed" });
    expect(within(list).getByText(/^Back /)).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "Bring back “Q3 budget”" }));
    fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
    expect(within(screen.getByRole("region", { name: "Back from snooze" })).getByRole("button", { name: /Theo Vance assigned you/ })).toBeInTheDocument();
  });

  it("Archived shows what was archived on this visit and can move it back", () => {
    const onUnarchive = vi.fn();
    const { props, rerender } = inbox([act_({ id: "a1", kind: "assigned", detail: "Theo Vance" })], { onUnarchive });
    fireEvent.click(screen.getByRole("button", { name: "Archive “Q3 budget”" }));
    expect(props.onArchive).toHaveBeenCalledWith("a1");
    rerender(<InboxView {...props} activity={[]} />);   // App drops it from the feed
    fireEvent.click(screen.getByRole("button", { name: /^Archived/ }));
    const list = screen.getByRole("region", { name: "Archived" });
    fireEvent.click(within(list).getByRole("button", { name: "Move “Q3 budget” back to Inbox" }));
    expect(onUnarchive).toHaveBeenCalledWith(["a1"]);
  });
});

describe("InboxView — Inbox zero", () => {
  it("says so plainly, and sweeps the bar once a day", () => {
    const first = inbox([]);
    expect(screen.getByRole("heading", { name: "Inbox zero. Nothing needs you." })).toBeInTheDocument();
    expect(screen.getByText("New mentions, assignments and requests land here.")).toBeInTheDocument();
    expect(first.container.querySelector('.kinbox-sweep[data-play="true"]')).not.toBeNull();
    expect(localStorage.getItem("kanbo-inbox-zero-day")).toBe(todayISO());
    first.unmount();
    const again = inbox([]);
    expect(again.container.querySelector('.kinbox-sweep[data-play="true"]')).toBeNull();
  });

  it("is what's left when everything is snoozed, with the way back", () => {
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ a1: Date.now() + 3_600_000 }));
    inbox([act_({ id: "a1", kind: "assigned", detail: "Theo Vance" })]);
    expect(screen.getByRole("heading", { name: /Inbox zero/ })).toBeInTheDocument();
    expect(screen.getByText(/1 snoozed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bring back now" })).toBeInTheDocument();
  });

  it("never sweeps under reduced motion", () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ ...mm(q), matches: q.includes("reduce") })) as typeof window.matchMedia;
    try {
      const { container } = inbox([]);
      expect(container.querySelector('.kinbox-sweep[data-play="true"]')).toBeNull();
    } finally { window.matchMedia = mm; }
  });
});

/* The Inbox's calmer notifications (0048, u4): bundles you can open, thread
   snoozes (every device; a custom time; back when they end; the old
   per-device ones moved across), kudos rows, the quiet-hours line, and
   rows that can be dragged to Today. Demo mode: snoozes live in memory.
   The clock is pinned. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const dragCalls = vi.hoisted(() => [] as unknown[]);
vi.mock("../../lib/dnd", async (orig) => {
  const real = await orig<typeof import("../../lib/dnd")>();
  return { ...real, useTaskDragSource: (opts: unknown) => { dragCalls.push(opts); return real.useTaskDragSource(opts as never); } };
});

import { InboxView, type InboxViewProps } from "./InboxView";
import type { Activity, Task } from "../../data/types";
import { demoSnoozesNow, resetDemoSnoozes } from "../../lib/notifyPrefs";
import { forgetSnoozeCache } from "../inbox/useThreadSnoozes";

const NOW = new Date("2026-10-09T10:00:00+01:00");   // Fri 10:00 BST
const iso = (msAgo = 0) => new Date(NOW.getTime() - msAgo).toISOString();
const act_ = (p: Partial<Activity> & { id: string }): Activity => ({
  taskId: "t1", taskTitle: "Launch deck", kind: "comment", detail: "", createdAt: iso(60_000), ...p,
});
const t1 = { id: "t1", title: "Launch deck", projectId: "p-launch", status: "todo", assigneeId: "m-self", aiScore: 1 } as unknown as Task;
const t2 = { id: "t2", title: "Q3 budget", projectId: "p-launch", status: "todo", assigneeId: "m-self", aiScore: 1 } as unknown as Task;

function inbox(activity: Activity[], extra: Partial<InboxViewProps> = {}) {
  const props = { activity, tasks: [t1, t2], onOpen: vi.fn(), onArchive: vi.fn(), onClearAll: vi.fn(), currentUserId: "m-self", ...extra };
  const utils = render(<InboxView {...props} />);
  return { ...utils, props };
}
const key = (k: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k });
const comments = () => [
  act_({ id: "c1", detail: "Sana Rao", createdAt: iso(60_000) }),
  act_({ id: "c2", detail: "Theo Vance", createdAt: iso(120_000) }),
  act_({ id: "c3", detail: "Sana Rao", createdAt: iso(180_000) }),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  resetDemoSnoozes();
  forgetSnoozeCache();
  dragCalls.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe("bundles", () => {
  it("folds related comments into one row you can open, and back", () => {
    inbox([...comments(), act_({ id: "m1", kind: "mention", detail: "Maya Lin" })]);
    const fyi = screen.getByRole("region", { name: "FYI" });
    const items = within(fyi).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    const head = within(fyi).getByRole("button", { name: /^Unread: 3 comments on Launch deck from Sana and Theo$/ });
    expect(head).toBeInTheDocument();
    // a mention on the same task stays its own row
    expect(within(screen.getByRole("region", { name: "Needs your reply" })).getByRole("button", { name: /Maya Lin mentioned you in Launch deck/ })).toBeInTheDocument();

    const toggle = within(fyi).getByRole("button", { name: "Show all 3 comments on “Launch deck”" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const kids = within(fyi).getByRole("list", { name: "3 comments on Launch deck from Sana and Theo" });
    expect(toggle.getAttribute("aria-controls")).toBe(kids.id);
    expect(within(kids).getAllByRole("listitem")).toHaveLength(3);
    expect(within(kids).getByRole("button", { name: /Theo Vance commented on Launch deck/ })).toBeInTheDocument();
    fireEvent.click(within(fyi).getByRole("button", { name: "Hide the 3 comments on “Launch deck”" }));
    expect(within(fyi).queryByRole("list", { name: /3 comments/ })).toBeNull();
  });

  it("→ opens a bundle, J walks into its items, ← goes back to the bundle and closes it", () => {
    inbox(comments());
    key("j");
    const head = screen.getByRole("button", { name: /^Unread: 3 comments on Launch deck/ });
    expect(document.activeElement).toBe(head);
    key("ArrowRight");
    expect(screen.getByRole("button", { name: /^Hide the 3 comments/ })).toBeInTheDocument();
    key("j");
    expect(document.activeElement).toBe(screen.getAllByRole("button", { name: /^Unread: Sana Rao commented on Launch deck/ })[0]);
    key("ArrowLeft");
    expect(document.activeElement).toBe(head);
    key("ArrowLeft");
    expect(screen.getByRole("button", { name: /^Show all 3/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("archiving a bundle archives everything in it (one Undo); opening it opens the task", () => {
    const { props } = inbox(comments());
    fireEvent.click(screen.getByRole("button", { name: "Archive 3 updates on “Launch deck”" }));
    expect(props.onClearAll).toHaveBeenCalledWith(["c1", "c2", "c3"]);
    expect(props.onArchive).not.toHaveBeenCalled();
  });

  it("opening a bundle opens its task; one of its items archives just that item", () => {
    const { props } = inbox(comments());
    fireEvent.click(screen.getByRole("button", { name: /^Unread: 3 comments on Launch deck/ }));
    expect(props.onOpen).toHaveBeenCalledWith("t1");
    fireEvent.click(screen.getByRole("button", { name: /^Show all 3/ }));
    const kids = screen.getByRole("list", { name: /3 comments/ });
    fireEvent.click(within(kids).getAllByRole("button", { name: "Archive “Launch deck”" })[1]);
    expect(props.onArchive).toHaveBeenCalledWith("c2");
  });

  it("the person's 'bundle' pref off shows every item on its own", () => {
    inbox(comments(), { notifyPrefs: { bundle: false } });
    expect(within(screen.getByRole("region", { name: "FYI" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("a reply to a bundle is a plain comment on its task", async () => {
    vi.useRealTimers();
    const onReply = vi.fn().mockResolvedValue({ id: "c9" });
    inbox(comments(), { onReply });
    fireEvent.click(screen.getByRole("button", { name: "Reply to “Launch deck”" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), { target: { value: "Thanks both" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Send/ })); });
    expect(onReply).toHaveBeenCalledWith("t1", "Thanks both", undefined);
  });
});

describe("thread snoozes", () => {
  it("snoozes the whole thread — later items on it stay quiet too — and brings it back when it ends", async () => {
    const { rerender, props } = inbox([act_({ id: "c1", detail: "Sana Rao" }), act_({ id: "a1", kind: "assigned", detail: "Maya Lin", taskId: "t2", taskTitle: "Q3 budget" })]);
    fireEvent.click(screen.getByRole("button", { name: "Snooze “Launch deck”" }));
    const menu = screen.getByRole("menu", { name: "Snooze “Launch deck” until" });
    expect(within(menu).getByText("Snooze this thread until")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^1 hour/ }));
    await act(async () => {});
    expect(demoSnoozesNow()).toEqual([expect.objectContaining({ taskId: "t1", until: "2026-10-09T10:00:00.000Z" })]);
    expect(screen.queryByRole("button", { name: /Sana Rao commented/ })).toBeNull();

    // a new comment on the snoozed thread arrives: it waits with the thread
    rerender(<InboxView {...props} activity={[act_({ id: "c2", detail: "Theo Vance", createdAt: iso(0) }), ...props.activity]} />);
    expect(screen.queryByRole("button", { name: /Theo Vance commented/ })).toBeNull();
    expect(screen.getByText(/2 snoozed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Snoozed/ }));
    const snoozed = screen.getByRole("region", { name: "Snoozed" });
    expect(within(snoozed).getByRole("button", { name: /^Unread: 2 comments on Launch deck from Theo and Sana/ })).toBeInTheDocument();
    expect(within(snoozed).getByText("Back 11:00")).toBeInTheDocument();
    expect(within(snoozed).getByText(/sends no push or email/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));

    // an hour later it's back at the top
    await act(async () => { vi.advanceTimersByTime(3_600_100); });
    const back = screen.getByRole("region", { name: "Back from snooze" });
    expect(within(back).getByRole("button", { name: /2 comments on Launch deck/ })).toBeInTheDocument();
    // dealt with (opened): the thread's snooze is settled, so it stops coming back on every device
    fireEvent.click(within(back).getByRole("button", { name: /2 comments on Launch deck/ }));
    await act(async () => {});
    expect(demoSnoozesNow()).toEqual([]);
    expect(screen.queryByRole("region", { name: "Back from snooze" })).toBeNull();
  });

  it("Undo puts the thread back as it was", async () => {
    const { ToastProvider } = await import("../Toast");
    render(
      <ToastProvider>
        <InboxView activity={[act_({ id: "c1", detail: "Sana Rao" })]} tasks={[t1]} onOpen={vi.fn()} onArchive={vi.fn()} onClearAll={vi.fn()} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Snooze “Launch deck”" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Tomorrow 09:00/ }));
    await act(async () => {});
    expect(screen.getByText("Snoozed until Tomorrow 09:00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await act(async () => {});
    expect(demoSnoozesNow()).toEqual([]);
    expect(screen.getByRole("button", { name: /Sana Rao commented on Launch deck/ })).toBeInTheDocument();
  });

  it("a custom date and time: a small dialog, checked, then snoozed", async () => {
    inbox([act_({ id: "c1", detail: "Sana Rao" })]);
    fireEvent.click(screen.getByRole("button", { name: "Snooze “Launch deck”" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pick a date and time…" }));
    const dialog = screen.getByRole("dialog", { name: "Snooze “Launch deck” until" });
    const date = within(dialog).getByLabelText("Date") as HTMLInputElement;
    const time = within(dialog).getByLabelText("Time") as HTMLInputElement;
    expect([date.value, time.value]).toEqual(["2026-10-10", "09:00"]);
    expect(document.activeElement).toBe(date);
    fireEvent.change(date, { target: { value: "2026-10-09" } });
    fireEvent.change(time, { target: { value: "08:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Snooze" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Pick a time later than now.");
    expect(date).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(date, { target: { value: "2026-10-14" } });
    fireEvent.change(time, { target: { value: "14:30" } });
    fireEvent.keyDown(time, { key: "Enter" });
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(demoSnoozesNow()?.[0].until).toBe(new Date(2026, 9, 14, 14, 30).toISOString());
  });

  it("the custom dialog keeps Tab inside, Back returns to the menu, Escape closes it", () => {
    inbox([act_({ id: "c1", detail: "Sana Rao" })]);
    const trigger = screen.getByRole("button", { name: "Snooze “Launch deck”" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pick a date and time…" }));
    const dialog = screen.getByRole("dialog");
    const snoozeBtn = within(dialog).getByRole("button", { name: "Snooze" });
    snoozeBtn.focus();
    fireEvent.keyDown(snoozeBtn, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Date"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Pick a date and time…" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("moves the old per-device snoozes to their threads; task-less ones stay on the device", async () => {
    const later = NOW.getTime() + 2 * 3_600_000;
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ c1: later, d1: later }));
    inbox([
      act_({ id: "c1", detail: "Sana Rao" }),
      act_({ id: "d1", kind: "doc_mention", taskId: null, taskTitle: "Launch brief", detail: "Sana Rao", meta: { docId: "doc-1", projectId: "p-launch" } }),
    ]);
    await act(async () => {});
    expect(demoSnoozesNow()).toEqual([expect.objectContaining({ taskId: "t1", until: new Date(later).toISOString() })]);
    expect(JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}")).toEqual({ d1: later });
    expect(screen.getByText(/2 snoozed/)).toBeInTheDocument();
  });

  it("uses App's snoozes when it passes them", () => {
    const onSnooze = vi.fn();
    inbox([act_({ id: "c1", detail: "Sana Rao" }), act_({ id: "c2", detail: "Maya Lin", taskId: "t2", taskTitle: "Q3 budget" })], {
      snoozes: [{ taskId: "t2", until: new Date(NOW.getTime() + 60_000).toISOString(), createdAt: iso() }], onSnooze,
    });
    expect(screen.queryByRole("button", { name: /Maya Lin commented/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Snooze “Launch deck”" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Next week/ }));
    expect(onSnooze).toHaveBeenCalledWith("t1", new Date("2026-10-12T08:00:00.000Z"));
  });
});

describe("kudos, quiet hours, dragging", () => {
  it("renders a kudos row: who, the emoji, the task, their note", () => {
    inbox([act_({ id: "k1", kind: "kudos", detail: "Theo Vance", meta: { kudosId: "kd-1", emoji: "👏", note: "Great work" } })]);
    const row = screen.getByRole("button", { name: /^Unread: Theo Vance sent you 👏 for Launch deck$/ });
    expect(row).toBeInTheDocument();
    expect(screen.getByText("“Great work”")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "FYI" })).toContainElement(row);
  });

  it("several kudos on one task fold together", () => {
    inbox([
      act_({ id: "k1", kind: "kudos", detail: "Theo Vance", meta: { emoji: "👏" } }),
      act_({ id: "k2", kind: "kudos", detail: "Sana Rao", meta: { emoji: "🎉" } }),
    ]);
    expect(screen.getByRole("button", { name: /2 kudos for Launch deck from Theo and Sana/ })).toBeInTheDocument();
  });

  it("says when quiet hours are holding push and email (and when they end)", async () => {
    const onOpenNotificationSettings = vi.fn();
    vi.setSystemTime(new Date("2026-10-09T22:30:00Z"));   // 23:30 BST
    inbox([act_({ id: "c1", detail: "Sana Rao", createdAt: new Date("2026-10-09T22:00:00Z").toISOString() })],
      { notifyPrefs: { quiet_hours: { start: "22:00", end: "07:00" }, timezone: "Europe/London" }, onOpenNotificationSettings });
    expect(screen.getByText(/Quiet hours until 07:00/)).toHaveTextContent("Push and email wait; your Inbox still updates.");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(onOpenNotificationSettings).toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(7.6 * 3_600_000); });
    expect(screen.queryByText(/Quiet hours until/)).toBeNull();
  });

  it("rows with a task can be dragged to Today (source 'inbox'); never for guests or finished tasks", () => {
    const done = { ...t2, status: "done" } as Task;
    inbox([act_({ id: "c1", detail: "Sana Rao" }), act_({ id: "a1", kind: "assigned", detail: "Maya Lin", taskId: "t2", taskTitle: "Q3 budget" })], { tasks: [t1, done] });
    const opts = dragCalls as { taskIds: string[]; source: string; meta: { activityId: string }; disabled: boolean }[];
    expect(opts.find((o) => o.meta.activityId === "c1")).toMatchObject({ taskIds: ["t1"], source: "inbox", disabled: false });
    expect(opts.find((o) => o.meta.activityId === "a1")).toMatchObject({ disabled: true });
    dragCalls.length = 0;
    inbox([act_({ id: "c9", detail: "Sana Rao" })], { readOnly: true });
    expect((dragCalls as { disabled: boolean }[]).every((o) => o.disabled)).toBe(true);
  });
});

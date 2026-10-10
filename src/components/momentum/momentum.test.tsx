/* The momentum components: the streak chip (and its popover), kudos (tap, take back, the
   picker by keyboard and by long-press, failures), the wins recap (windows, what's shared,
   hide), the ready-to-mount wrappers and the Settings rows. The clock is pinned. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Kudos, Member, Project, Task } from "../../data/types";
import { KudosButton, KudosTally, MomentumSettings, StreakChip, TaskKudos, TodayStreak, TodayWins, WinsRecap } from ".";
import { listKudos, readPlannedDays, resetKudosDemo } from "../../lib/momentum";

const FRI_AFTERNOON = new Date("2026-10-09T15:00:00+01:00");
const WED = new Date("2026-10-07T10:00:00+01:00");

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "t" + (++n), title: "Task " + n, description: "", status: "done", priority: "medium", projectId: "p-launch", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, workspaceId: "ws-foundrise", ...o,
});
const kudo = (o: Partial<Kudos>): Kudos => ({
  id: "k" + (++n), taskId: "x", workspaceId: "ws-foundrise", fromUser: "m-1", toUser: "m-self", emoji: "🎉", note: null, createdAt: "2026-10-07T10:00:00Z", ...o,
});
const MEMBERS: Member[] = [
  { id: "m-self", name: "Daniel Okai", email: "d@k.app", type: "self", color: "#88f" },
  { id: "m-1", name: "Maya Lin", email: "m@k.app", type: "team", color: "#4af" },
  { id: "m-2", name: "Theo Vance", email: "t@k.app", type: "team", color: "#fa4" },
  { id: "m-3", name: "Sana Rao", email: "s@k.app", type: "team", color: "#a4f" },
];
const PROJECTS: Project[] = [
  { id: "p-launch", name: "Q3 Product Launch", emoji: "🚀", color: "#38f", workspaceId: "ws-foundrise" },
  { id: "p-personal", name: "Personal", emoji: "📌", color: "#88f", workspaceId: null },
];
// jsdom has no PointerEvent: without one, pointerType never reaches the handlers
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}
const flush = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  localStorage.clear();
  resetKudosDemo({ demoDelayMs: 0 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("StreakChip", () => {
  const streak = { days: 4, today: "pending" as const, since: "2026-10-05" };
  it("nothing at 0 days, or when hidden", () => {
    const { container, rerender } = render(<StreakChip streak={{ days: 0, today: "pending", since: null }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<StreakChip streak={streak} prefs={{ streakHidden: true }} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("says the streak and today's state; the popover explains it, with this week", () => {
    render(<StreakChip streak={streak} now={WED} />);
    const chip = screen.getByRole("button", { name: "4-day streak, today still open" });
    expect(chip).toHaveTextContent("4-day streak");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chip);
    const dlg = screen.getByRole("dialog", { name: "Your streak" });
    expect(within(dlg).getByRole("heading", { name: "4 working days in a row" })).toBeInTheDocument();
    const week = within(dlg).getByRole("list", { name: "This week" });
    expect(within(week).getAllByRole("listitem").map((li) => li.textContent?.replace(/^[MTWF]/, ""))).toEqual([
      "Monday 5 Oct: counted", "Tuesday 6 Oct: counted", "Wednesday 7 Oct: today, still open", "Thursday 8 Oct: still to come", "Friday 9 Oct: still to come",
    ]);
    expect(dlg).toHaveTextContent("never break it");
    // informational only without onChangePrefs
    expect(within(dlg).queryByRole("button", { name: "Hide the streak" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("take today off, add another day off, hide the streak", () => {
    const onChangePrefs = vi.fn();
    render(<StreakChip streak={streak} now={WED} prefs={{ daysOff: ["2026-10-30"] }} onChangePrefs={onChangePrefs} />);
    fireEvent.click(screen.getByRole("button", { name: /4-day streak/ }));
    const dlg = screen.getByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Take today off" }));
    expect(onChangePrefs).toHaveBeenLastCalledWith({ daysOff: ["2026-10-07", "2026-10-30"] });
    fireEvent.change(within(dlg).getByLabelText("Add a day off"), { target: { value: "2026-10-16" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add" }));
    expect(onChangePrefs).toHaveBeenLastCalledWith({ daysOff: ["2026-10-16", "2026-10-30"] });
    // a weekend is refused kindly
    fireEvent.change(within(dlg).getByLabelText("Add a day off"), { target: { value: "2026-10-10" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add" }));
    expect(within(dlg).getByRole("alert")).toHaveTextContent("That's a weekend");
    fireEvent.click(within(dlg).getByRole("button", { name: "Remove Fri 30 Oct from your days off" }));
    expect(onChangePrefs).toHaveBeenLastCalledWith({ daysOff: [] });
    fireEvent.click(within(dlg).getByRole("button", { name: "Hide the streak" }));
    expect(onChangePrefs).toHaveBeenLastCalledWith({ daysOff: ["2026-10-30"], streakHidden: true });
  });
  it("a day you've taken off can be counted again", () => {
    const onChangePrefs = vi.fn();
    render(<StreakChip streak={{ days: 2, today: "off", since: "2026-10-05" }} now={WED} prefs={{ daysOff: ["2026-10-07"] }} onChangePrefs={onChangePrefs} />);
    fireEvent.click(screen.getByRole("button", { name: "2-day streak, today's a day off" }));
    fireEvent.click(screen.getByRole("button", { name: "Count today after all" }));
    expect(onChangePrefs).toHaveBeenLastCalledWith({ daysOff: [] });
  });
});

describe("KudosButton", () => {
  const theirs = { id: "t-24", title: "Record product demo video", status: "done" as const, assigneeId: "m-2", workspaceId: "ws-foundrise" };
  it("hidden for your own, unfinished, Personal and unowned tasks", () => {
    const { container, rerender } = render(<KudosButton task={{ ...theirs, assigneeId: "m-self" }} currentUserId="m-self" recipientName="You" kudos={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<KudosButton task={{ ...theirs, status: "review" }} currentUserId="m-self" recipientName="Theo" kudos={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<KudosButton task={{ ...theirs, workspaceId: null }} currentUserId="m-self" recipientName="Theo" kudos={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<KudosButton task={{ ...theirs, assigneeId: "" }} currentUserId="m-self" recipientName="Theo" kudos={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("one tap sends 🎉 (optimistically), a second takes it back", async () => {
    const onChange = vi.fn();
    const others = [kudo({ taskId: "t-24", fromUser: "m-1", toUser: "m-2", emoji: "🔥" })];
    render(<KudosButton task={theirs} currentUserId="m-self" recipientName="Theo Vance" kudos={others} onChange={onChange} people={MEMBERS} />);
    const btn = screen.getByRole("button", { name: "Kudos for Theo, 1 so far" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveAccessibleDescription("From Maya");
    fireEvent.click(btn);
    // at once: pressed, two
    expect(screen.getByRole("button", { name: "Kudos for Theo, 2 so far" })).toHaveAttribute("aria-pressed", "true");
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Kudos[];
    expect(next.map((k) => [k.fromUser, k.emoji])).toEqual([["m-1", "🔥"], ["m-self", "🎉"]]);
    expect(screen.getByRole("status")).toHaveTextContent("Kudos sent to Theo");
    expect((await listKudos("ws-foundrise", { taskIds: ["t-24"] })).some((k) => k.fromUser === "m-self")).toBe(true);
    // tap again: taken back
    fireEvent.click(screen.getByRole("button", { name: "Kudos for Theo, 2 so far" }));
    await flush();
    expect(screen.getByRole("button", { name: "Kudos for Theo, 1 so far" })).toHaveAttribute("aria-pressed", "false");
    expect(onChange).toHaveBeenLastCalledWith(others);
    expect(screen.getByRole("status")).toHaveTextContent("Kudos taken back");
  });
  it("the caret opens the picker: arrows choose an emoji, a note, Send", async () => {
    const onChange = vi.fn();
    render(<KudosButton task={theirs} currentUserId="m-self" recipientName="Theo Vance" kudos={[]} onChange={onChange} />);
    const caret = screen.getByRole("button", { name: "Choose an emoji and add a note for Theo" });
    fireEvent.click(caret);
    const dlg = screen.getByRole("dialog", { name: "Kudos for Theo" });
    const group = within(dlg).getByRole("radiogroup", { name: "Emoji" });
    expect(within(group).getByRole("radio", { name: "Party popper" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(group, { key: "ArrowRight" });
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(within(group).getByRole("radio", { name: "Heart" })).toHaveAttribute("aria-checked", "true");
    expect(within(group).getByRole("radio", { name: "Heart" })).toHaveFocus();
    fireEvent.change(within(dlg).getByLabelText(/Note \(optional\)/), { target: { value: "Brilliant demo" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Send kudos" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ emoji: "❤️", note: "Brilliant demo", fromUser: "m-self", toUser: "m-2" })]);
    // open again: Update stays off until something changes; Take back is there
    fireEvent.click(screen.getByRole("button", { name: "Change or take back your kudos for Theo" }));
    const again = screen.getByRole("dialog");
    expect(within(again).getByRole("button", { name: "Update" })).toBeDisabled();
    fireEvent.click(within(again).getByRole("radio", { name: "Trophy" }));
    fireEvent.click(within(again).getByRole("button", { name: "Update" }));
    await flush();
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ emoji: "🏆", note: "Brilliant demo" })]);
    expect(screen.getByRole("status")).toHaveTextContent("Kudos updated for Theo");
  });
  it("a long press opens the picker (touch) and doesn't also send", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
    const onChange = vi.fn();
    render(<KudosButton task={theirs} currentUserId="m-self" recipientName="Theo" kudos={[]} onChange={onChange} />);
    const btn = screen.getByRole("button", { name: "Kudos for Theo" });
    fireEvent.pointerDown(btn, { pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(btn, { pointerType: "touch" });
    fireEvent.click(btn);
    expect(screen.getByRole("dialog", { name: "Kudos for Theo" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("a refusal puts the count back and says why", async () => {
    const onChange = vi.fn();
    // the demo's signed-in person is m-self, so this one is "for yourself" to the fakes: refused
    render(<KudosButton task={{ ...theirs, id: "t-12", assigneeId: "m-self" }} currentUserId="m-1" recipientName="Daniel" kudos={[]} onChange={onChange} />);
    const btn = screen.getByRole("button", { name: "Kudos for Daniel" });
    fireEvent.click(btn);
    expect(screen.getByRole("button", { name: "Kudos for Daniel, 1 so far" })).toHaveAttribute("aria-pressed", "true");
    await flush();
    expect(screen.getByRole("button", { name: "Kudos for Daniel" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent("Kudos are for your teammates.");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("disabled: shows the count, gives nothing", () => {
    render(<KudosButton task={theirs} currentUserId="m-self" recipientName="Theo" kudos={[kudo({ taskId: "t-24", toUser: "m-2" })]} disabled />);
    expect(screen.getByRole("button", { name: "Kudos for Theo, 1 so far" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Choose an emoji/ })).toBeDisabled();
  });
  it("your own task: a read-only tally", () => {
    const { container, rerender } = render(<KudosTally taskId="t-12" kudos={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<KudosTally taskId="t-12" people={MEMBERS} kudos={[kudo({ taskId: "t-12", fromUser: "m-1", emoji: "👏" }), kudo({ taskId: "t-12", fromUser: "m-3" })]} />);
    expect(container).toHaveTextContent("2 kudos, from Maya and Sana");
  });
});

describe("WinsRecap", () => {
  const tasks = () => {
    n = 0;
    return [
      task({ id: "deck", title: "Finalise launch deck", completedAt: "2026-10-08T16:00:00Z" }),
      task({ id: "budget", title: "Approve launch budget", completedAt: "2026-10-06" }),
      task({ id: "passport", title: "Renew passport", projectId: "p-personal", workspaceId: null, completedAt: "2026-10-07" }),
      task({ id: "onb", title: "Ship onboarding", status: "blocked", assigneeId: "m-1", dependencies: ["deck"] }),
    ];
  };
  const kudos = [kudo({ taskId: "budget", fromUser: "m-1", emoji: "👏", note: "So quick", createdAt: "2026-10-06T15:00:00Z" })];
  const props = (o: Partial<Parameters<typeof WinsRecap>[0]> = {}) => ({
    now: FRI_AFTERNOON, currentUserId: "m-self", tasks: tasks(), projects: PROJECTS, members: MEMBERS, kudos, plannedDays: ["2026-10-09"],
    workspaceId: "ws-foundrise", ...o,
  });

  it("Friday afternoon: the week's wins by project, numbers and moments", () => {
    const onOpenTask = vi.fn();
    render(<WinsRecap {...props({ onOpenTask })} />);
    const card = screen.getByRole("region", { name: "Your week's wins" });
    expect(card).toHaveTextContent("5–9 Oct");
    expect(card).toHaveTextContent("This week you finished 3 things across Q3 Product Launch and Personal.");
    const facts = within(card).getByRole("list", { name: "In numbers" });
    expect(facts).toHaveTextContent("3 done");
    expect(facts).toHaveTextContent("1h 30m of focused work");
    expect(facts).toHaveTextContent("4 day streak");
    expect(facts).toHaveTextContent("1 kudos");
    const byProject = within(card).getByRole("list", { name: "Finished, by project" });
    fireEvent.click(within(byProject).getByRole("button", { name: "Finalise launch deck" }));
    expect(onOpenTask).toHaveBeenCalledWith("deck");
    const moments = within(card).getByRole("list", { name: "With your team" });
    expect(moments).toHaveTextContent("Maya sent you 👏 for “Approve launch budget” — “So quick”");
    expect(moments).toHaveTextContent("You unblocked Maya");
    // there's Personal work in it, so the card says what sharing includes
    expect(card).toHaveTextContent("Share and Copy include this workspace's work only.");
  });
  it("Copy shares this workspace's work only", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<WinsRecap {...props({ userName: "Daniel Okai" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy as text" }));
    await flush();
    const text = writeText.mock.calls[0]?.[0] as unknown as string;
    expect(text.split("\n")[0]).toBe("*Daniel's week · 5–9 Oct*");
    expect(text).toContain("✅ 2 done across Q3 Product Launch (2)");
    expect(text).not.toContain("passport");
    expect(text).not.toContain("So quick");
  });
  it("not shown midweek (unless previewing), when hidden, or with nothing to say", () => {
    const { container, rerender } = render(<WinsRecap {...props({ now: WED })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<WinsRecap {...props({ prefs: { recapHidden: true } })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<WinsRecap {...props({ tasks: [], kudos: [] })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<WinsRecap {...props({ now: WED, preview: true })} />);
    expect(screen.getByRole("region", { name: "Your week so far" })).toHaveTextContent("5–7 Oct");
  });
  it("Monday morning: last week's", () => {
    render(<WinsRecap {...props({ now: new Date("2026-10-12T09:00:00+01:00") })} />);
    expect(screen.getByRole("region", { name: "Last week's wins" })).toHaveTextContent("5–11 Oct");
  });
  it("Hide: gone at once, and the host saves it", () => {
    const onHide = vi.fn();
    render(<WinsRecap {...props({ onHide })} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide your week's wins" }));
    expect(onHide).toHaveBeenCalled();
    expect(screen.queryByRole("region")).toBeNull();
  });
  it("Personal (no workspace): no Slack, no sharing note", () => {
    render(<WinsRecap {...props({ workspaceId: null })} />);
    const card = screen.getByRole("region", { name: "Your week's wins" });
    expect(within(card).queryByRole("button", { name: /Slack/ })).toBeNull();
    expect(card).not.toHaveTextContent("this workspace's work only");
  });
  it("Share to Slack shows once the workspace has Slack connected (the demo connection)", async () => {
    const slack = await import("../../lib/slack");
    slack.resetSlackState({ demoDelayMs: 0 });
    await slack.connectSlack("ws-foundrise", "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX", "#team");
    render(<WinsRecap {...props()} />);
    await flush();
    expect(screen.getByRole("button", { name: "Share to Slack" })).toBeInTheDocument();
    slack.resetSlackState();
  });
});

describe("the wrappers", () => {
  it("TodayStreak records today once a task is planned, and shows the run", () => {
    vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
    const now = new Date("2026-10-09T10:00:00+01:00");
    const tasks = [task({ id: "a", status: "todo", planToday: true, assigneeId: "u-1" }), task({ id: "b", completedAt: "2026-10-08", assigneeId: "u-1" })];
    render(<TodayStreak currentUserId="u-1" tasks={tasks} now={now} />);
    expect(readPlannedDays("u-1")).toEqual(["2026-10-09"]);
    expect(screen.getByRole("button", { name: "2-day streak, today counts" })).toBeInTheDocument();
  });
  it("TodayStreak in the demo: a believable run", () => {
    render(<TodayStreak currentUserId="m-self" tasks={[]} now={new Date("2026-10-09T10:00:00+01:00")} />);
    expect(screen.getByRole("button", { name: "6-day streak, today still open" })).toBeInTheDocument();
  });
  it("TodayWins in the demo: the week so far with the demo's kudos", async () => {
    vi.setSystemTime(WED);
    resetKudosDemo({ demoDelayMs: 0 });   // (the fakes' "22 hours ago" read the clock)
    const tasks = [task({ id: "t-12", title: "Approve Q3 launch budget", completedAt: "2026-10-06" }), task({ id: "t-13", title: "Pick launch date with leadership", completedAt: "2026-10-05" })];
    render(<TodayWins currentUserId="m-self" workspaceId="ws-foundrise" tasks={tasks} projects={PROJECTS} members={MEMBERS} now={WED} />);
    await flush();
    const card = screen.getByRole("region", { name: "Your week so far" });
    expect(card).toHaveTextContent("Maya sent you 👏 for “Approve Q3 launch budget”");
    expect(card).toHaveTextContent("Sana sent you 🎉 for “Pick launch date with leadership”");
    expect(card).toHaveTextContent("This week you finished 2 things in Q3 Product Launch.");
  });
  it("TodayWins: nothing when hidden", () => {
    const { container } = render(<TodayWins currentUserId="m-self" workspaceId="ws-foundrise" tasks={[]} projects={PROJECTS} members={MEMBERS} now={FRI_AFTERNOON} prefs={{ recapHidden: true }} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("TaskKudos: a button on a teammate's finished task, a tally on yours", async () => {
    const { rerender } = render(<TaskKudos task={{ id: "t-16", title: "Refresh brand colour palette", status: "done", assigneeId: "m-3", workspaceId: "ws-foundrise" }}
      currentUserId="m-self" recipientName="Sana Rao" people={MEMBERS} />);
    await flush();
    // the demo: you and Maya have thanked Sana already
    expect(screen.getByRole("button", { name: "Kudos for Sana, 2 so far" })).toHaveAttribute("aria-pressed", "true");
    rerender(<TaskKudos task={{ id: "t-12", title: "Approve Q3 launch budget", status: "done", assigneeId: "m-self", workspaceId: "ws-foundrise" }}
      currentUserId="m-self" recipientName="You" people={MEMBERS} />);
    await flush();
    expect(screen.getByText("1 kudos, from Maya")).toBeInTheDocument();
  });
});

describe("MomentumSettings", () => {
  it("two switches and days off", () => {
    const onChange = vi.fn();
    render(<MomentumSettings prefs={{ recapHidden: true }} onChange={onChange} now={WED} />);
    const streak = screen.getByRole("switch", { name: "Show my streak on Today" });
    const wins = screen.getByRole("switch", { name: "Show my week's wins" });
    expect(streak).toHaveAttribute("aria-checked", "true");
    expect(wins).toHaveAttribute("aria-checked", "false");
    fireEvent.click(streak);
    expect(onChange).toHaveBeenLastCalledWith({ recapHidden: true, streakHidden: true });
    fireEvent.click(wins);
    expect(onChange).toHaveBeenLastCalledWith({ recapHidden: false });
    expect(screen.getByText(/No days off marked/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Days off"), { target: { value: "2026-12-24" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onChange).toHaveBeenLastCalledWith({ recapHidden: true, daysOff: ["2026-12-24"] });
  });
});

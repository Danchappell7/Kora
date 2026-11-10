/* The goal panel: everything about one goal, and the only place it's edited. Owners and quarters,
   who may change what (the same rules as 0052), the pace line and the status it suggests (never set
   by itself), check-ins (a one-tap check-in opens on the composer), key results, linked work and
   "No work behind this", its icon and colour, archive and delete (in its menu), and the panel as it
   is before 0052 is run. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Goal, GoalCheckin, GoalExtras, GoalLink, Project, Task, WorkspaceMember } from "../../data/types";
import { GoalPanel } from "./GoalPanel";

const TODAY = new Date(2026, 10, 10);   // 10 Nov 2026: day 40 of Q4's 91, 44% of the way
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 10, 12)); });
afterEach(() => { vi.useRealTimers(); });   // (not restoreAllMocks: it would wipe the global matchMedia mock)

const Q4 = { period: "2026-Q4", periodStart: "2026-10-01", periodEnd: "2026-12-31" };
const goal = (o: Partial<Goal> & { id: string; name: string }): Goal => ({ status: "on_track", workspaceId: "ws", ownerId: "m-self", contributors: [], kind: "objective", direction: "higher", visibility: "everyone", pace: "linear", ...Q4, ...o });
const member = (userId: string, name: string, role: WorkspaceMember["role"]): WorkspaceMember => ({ id: `wm-${userId}`, workspaceId: "ws", userId, email: `${userId}@x.org`, name, role, status: "active" });
const MEMBERS = [member("m-self", "Daniel Okai", "owner"), member("m-1", "Maya Lin", "member"), member("m-2", "Theo Vance", "member"), member("m-4", "Idris Bell", "guest")];
const PROJECTS: Project[] = [{ id: "p1", name: "Launch", emoji: "🚀", color: "red", workspaceId: "ws" }, { id: "p2", name: "Brand", emoji: "🎨", color: "blue", workspaceId: "ws" }];
const TASKS: Task[] = [{ id: "t1", title: "Write the plan", description: "", status: "todo", priority: "medium", projectId: "p1", assigneeId: "m-self", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0 }];
const NO_EXTRAS: GoalExtras = { checkins: [], links: [] };

function renderPanel(g: Goal, o: Partial<Parameters<typeof GoalPanel>[0]> = {}) {
  const props = {
    goal: g, goals: [g], projects: PROJECTS, tasks: TASKS, extras: NO_EXTRAS, me: "m-self", role: "owner" as const, members: MEMBERS, today: TODAY,
    onClose: vi.fn(), onOpenGoal: vi.fn(), onOpenTask: vi.fn(), onOpenProject: vi.fn(), onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(),
    onCheckin: vi.fn(), onDeleteCheckin: vi.fn(), onLink: vi.fn(), onUnlink: vi.fn(), ...o,
  };
  return { ...render(<GoalPanel {...props} />), props };
}
const panel = (name: string) => screen.getByRole("dialog", { name: `Goal: ${name}` });

describe("the goal panel: who may change what", () => {
  it("an owner picks the goal's owner from the members (never a guest) and its quarter", () => {
    const { props } = renderPanel(goal({ id: "g", name: "Grow", target: 100, current: 40 }));
    const owner = screen.getByLabelText("Owner of Grow") as HTMLSelectElement;
    expect([...owner.options].map((o) => o.text)).toEqual(["No owner", "Daniel Okai", "Maya Lin", "Theo Vance"]);
    fireEvent.change(owner, { target: { value: "m-1" } });
    expect(props.onUpdate).toHaveBeenLastCalledWith("g", { ownerId: "m-1" });
    fireEvent.change(screen.getByLabelText("Period of Grow"), { target: { value: "2027-Q1" } });
    expect(props.onUpdate).toHaveBeenLastCalledWith("g", { period: "2027-Q1", periodStart: "2027-01-01", periodEnd: "2027-03-31" });
  });

  it("a member reads a goal that isn't theirs: no fields, no menu, no Delete", () => {
    renderPanel(goal({ id: "a", name: "Theirs", ownerId: "m-2", target: 10, current: 4, unit: "deals" }), { me: "m-1", role: "member" });
    const p = panel("Theirs");
    expect(within(p).queryAllByRole("combobox")).toHaveLength(0);
    expect(within(p).queryByRole("textbox")).toBeNull();
    expect(within(p).queryByRole("button", { name: "Goal actions" })).toBeNull();
    expect(within(p).getByRole("heading", { name: "Theirs" })).toBeInTheDocument();
    expect(within(p).getByText("4 of 10 deals")).toBeInTheDocument();
    expect(within(p).getByText("Theo Vance")).toBeInTheDocument();
  });

  it("a helper edits it but doesn't hand it over; the goal's owner does", () => {
    const { unmount } = renderPanel(goal({ id: "c", name: "Helping", ownerId: "m-2", contributors: ["m-1"], target: 10, current: 3 }), { me: "m-1", role: "member" });
    expect(screen.getByLabelText("Status of Helping")).toBeInTheDocument();
    expect(screen.getByLabelText("Goal name: Helping")).toBeInTheDocument();
    expect(screen.queryByLabelText("Owner of Helping")).toBeNull();
    unmount();
    renderPanel(goal({ id: "b", name: "Mine", ownerId: "m-1", target: 10, current: 2 }), { me: "m-1", role: "member" });
    expect(screen.getByLabelText("Owner of Mine")).toBeInTheDocument();
  });

  it("adds a key result under a goal you may edit: yours, in its quarter and its workspace", () => {
    const { props } = renderPanel(goal({ id: "b", name: "Mine", ownerId: "m-1", target: 10, current: 2 }), { me: "m-1", role: "member" });
    fireEvent.click(screen.getByRole("button", { name: "Add a key result" }));
    fireEvent.change(screen.getByLabelText("New key result under Mine"), { target: { value: "Ten demos booked" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(props.onCreate).toHaveBeenCalledWith("Ten demos booked", { parentId: "b", kind: "key_result", ownerId: "m-1", ...Q4 });
  });

  it("lists its key results, each opening its own panel", () => {
    const top = goal({ id: "top", name: "Grow", target: 100, current: 40 });
    const kr = goal({ id: "kr", name: "Cut churn", parentId: "top", kind: "key_result", target: 5, current: 7, startValue: 8, direction: "lower" });
    const { props } = renderPanel(top, { goals: [top, kr] });
    const list = within(screen.getByRole("region", { name: "Key results" }));
    fireEvent.click(list.getByRole("button", { name: "Cut churn" }));
    expect(props.onOpenGoal).toHaveBeenCalledWith("kr");
    expect(list.getByRole("progressbar", { name: "Cut churn progress" })).toHaveAttribute("aria-valuenow", "33");
  });
});

describe("the goal panel: where it stands", () => {
  it("cut churn from 8% to 5% reads 0% on day one, in the goal's own words", () => {
    renderPanel(goal({ id: "c", name: "Cut churn", direction: "lower", startValue: 8, target: 5, current: 8, unit: "%" }));
    expect(screen.getByRole("progressbar", { name: "Cut churn progress" })).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("down to 5% · from 8%")).toBeInTheDocument();
  });

  it("says how far behind pace it is and suggests a status the owner takes in one tap; it never sets one itself", () => {
    const { props } = renderPanel(goal({ id: "g", name: "Grow", target: 100, current: 32, status: "on_track" }));
    expect(screen.getByText("Behind pace by 12%")).toBeInTheDocument();
    expect(screen.getByText("Kanbo suggests At risk.")).toBeInTheDocument();
    expect(props.onUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Mark At risk" }));
    expect(props.onUpdate).toHaveBeenCalledWith("g", { status: "at_risk" });
  });

  it("draws its check-ins against the pace line, with today and where it should be by now", () => {
    const checkins: GoalCheckin[] = [
      { id: "c2", goalId: "g", workspaceId: "ws", authorId: "m-1", value: 30, createdAt: "2026-11-08T17:00:00Z" },
      { id: "c1", goalId: "g", workspaceId: "ws", authorId: "m-1", value: 12, createdAt: "2026-10-20T17:00:00Z" },
    ];
    renderPanel(goal({ id: "g", name: "Grow", target: 100, current: 30 }), { extras: { checkins, links: [] } });
    const chart = screen.getByRole("img", { name: "Grow: 30% now, 44% expected by today on the pace line, from 2 check-ins." });
    expect(chart.querySelectorAll(".kgs-dot")).toHaveLength(3);   // two check-ins and today
    expect(chart.querySelector(".kgs-pace")).not.toBeNull();
    expect(screen.getByText("Steady pace: 44% by today")).toBeInTheDocument();
  });

  it("a goal past its date unfinished suggests Off track; no pace line when the pace is off (its chart keeps the check-ins only)", () => {
    const { unmount } = renderPanel(goal({ id: "late", name: "Late", target: 100, current: 60, due: "2026-11-01" }));
    expect(screen.getByText("Past due at 60%")).toBeInTheDocument();
    expect(screen.getByText("Kanbo suggests Off track.")).toBeInTheDocument();
    unmount();
    renderPanel(goal({ id: "none", name: "No pace", target: 100, current: 1, pace: "off" }));
    expect(document.querySelector(".kgl-pace")).toBeNull();
    expect(screen.queryByRole("img", { name: /expected by today/ })).toBeNull();
    expect(screen.getByRole("img", { name: "No pace: 1% now, from 0 check-ins." }).querySelector(".kgs-pace")).toBeNull();
  });
});

describe("the goal panel: check-ins", () => {
  const checkins: GoalCheckin[] = [
    { id: "c2", goalId: "g", workspaceId: "ws", authorId: "m-1", value: 3760, confidence: 3, note: "Onboarding fix is in", createdAt: "2026-11-08T17:00:00Z" },
    { id: "c1", goalId: "g", workspaceId: "ws", authorId: null, value: 3550, confidence: null, createdAt: "2026-10-25T17:00:00Z" },
  ];
  it("lists every check-in, a departed author as Former member, and takes one back", () => {
    const { props } = renderPanel(goal({ id: "g", name: "Grow", startValue: 3200, target: 5000, current: 3760, unit: "users" }), { extras: { checkins, links: [] } });
    const history = screen.getByRole("list", { name: "Check-ins on Grow" });
    expect(within(history).getByText("Maya")).toBeInTheDocument();
    expect(within(history).getByText("Onboarding fix is in")).toBeInTheDocument();
    expect(within(history).getByText("Former member")).toBeInTheDocument();
    expect(screen.getByText("Confidence medium at the last check-in")).toBeInTheDocument();
    fireEvent.click(within(history).getByRole("button", { name: "Take back the check-in of 3,550 users" }));
    expect(props.onDeleteCheckin).toHaveBeenCalledWith("c1", expect.objectContaining({ id: "g" }));
  });

  it("posts one: a number, how sure you are and a note", () => {
    const { props } = renderPanel(goal({ id: "g", name: "Grow", target: 5000, current: 3760 }));
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));
    const box = screen.getByRole("group", { name: "Check in on Grow" });
    fireEvent.change(within(box).getByLabelText("Where it stands"), { target: { value: "3900" } });
    fireEvent.change(within(box).getByLabelText("Confidence"), { target: { value: "4" } });
    fireEvent.change(within(box).getByLabelText("Note"), { target: { value: "Referral pilot live" } });
    fireEvent.click(within(box).getByRole("button", { name: "Post check-in" }));
    expect(props.onCheckin).toHaveBeenCalledWith(expect.objectContaining({ id: "g" }), 3900, 4, "Referral pilot live");
    expect(screen.queryByRole("group", { name: "Check in on Grow" })).toBeNull();
  });

  it("a one-tap check-in opens on the composer, ready for the number", () => {
    renderPanel(goal({ id: "g", name: "Grow", target: 5000, current: 3760 }), { composeFirst: true });
    const box = screen.getByRole("group", { name: "Check in on Grow" });
    expect(within(box).getByLabelText("Where it stands")).toHaveValue(3760);
    expect(document.activeElement).toBe(within(box).getByLabelText("Where it stands"));
  });

  it("only goals that track their own number take check-ins, and only from people who may edit them", () => {
    const { unmount } = renderPanel(goal({ id: "p", name: "From a project", projectId: "p1" }));
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
    unmount();
    renderPanel(goal({ id: "t", name: "Theirs", ownerId: "m-2", target: 10, current: 2 }), { me: "m-1", role: "member" });
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
  });
});

describe("the goal panel: linked work", () => {
  const links: GoalLink[] = [
    { id: "l1", goalId: "g", workspaceId: "ws", kind: "project", targetId: "p1" },
    { id: "l2", goalId: "g", workspaceId: "ws", kind: "task", targetId: "t1" },
  ];
  it("lists its projects (with their health), tasks and views; each opens; editors link more and unlink", () => {
    const { props } = renderPanel(goal({ id: "g", name: "Grow", target: 10, current: 1 }), {
      extras: { checkins: [], links: [...links, { id: "l3", goalId: "g", workspaceId: "ws", kind: "view", targetId: "v1" }] },
      views: [{ id: "v1", name: "Launch blockers", emoji: "🚧" }, { id: "v2", name: "Due this week" }],
    });
    const box = screen.getByLabelText("Work linked to Grow");
    expect(within(box).getByRole("img", { name: "Launch: 0% done" })).toBeInTheDocument();
    fireEvent.click(within(box).getByRole("button", { name: "Open Write the plan" }));
    expect(props.onOpenTask).toHaveBeenCalledWith("t1");
    fireEvent.click(within(box).getByRole("button", { name: "Open Launch" }));
    expect(props.onOpenProject).toHaveBeenCalledWith("p1");
    fireEvent.click(within(box).getByRole("button", { name: "Unlink Write the plan" }));
    expect(props.onUnlink).toHaveBeenCalledWith(links[1]);
    const pick = within(box).getByLabelText("Link work to Grow") as HTMLSelectElement;
    expect([...pick.options].map((o) => o.value)).toEqual(["", "project:p2", "view:v2"]);
    fireEvent.change(pick, { target: { value: "view:v2" } });
    expect(props.onLink).toHaveBeenCalledWith(expect.objectContaining({ id: "g" }), "view", "v2");
  });

  it("says when there's no work behind a team goal (or its key results), never for a personal one", () => {
    const { unmount } = renderPanel(goal({ id: "g", name: "Grow", target: 10, current: 1 }));
    expect(screen.getByText(/^No work behind this\./)).toBeInTheDocument();
    unmount();
    renderPanel(goal({ id: "g", name: "Grow", target: 10, current: 1 }), { extras: { checkins: [], links } });
    expect(screen.queryByText(/No work behind this/)).toBeNull();
    const mine = goal({ id: "m", name: "Read more", workspaceId: null, target: 24, current: 3 });
    renderPanel(mine, { role: null });
    expect(screen.queryAllByText(/No work behind this/)).toHaveLength(0);
  });
});

describe("the goal panel: its menu", () => {
  it("archives and restores, sets its icon and colour, and deletes (asked first), then closes", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { props, unmount } = renderPanel(goal({ id: "g", name: "Grow", target: 10, current: 1 }), { goals: [goal({ id: "g", name: "Grow" }), goal({ id: "k", name: "KR", parentId: "g" })] });
    fireEvent.click(screen.getByRole("button", { name: "Goal actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive goal" }));
    expect(props.onUpdate).toHaveBeenLastCalledWith("g", { archivedAt: expect.any(String) });
    fireEvent.click(screen.getByRole("button", { name: "Goal actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Icon and colour/ }));
    fireEvent.click(screen.getByRole("button", { name: "📦" }));
    fireEvent.click(screen.getByRole("radio", { name: "Jade" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onUpdate).toHaveBeenLastCalledWith("g", { icon: "📦", color: expect.stringMatching(/^oklch\(.* 158\)$/) });
    fireEvent.click(screen.getByRole("button", { name: "Goal actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete goal/ }));
    expect(window.confirm).toHaveBeenCalledWith("Delete goal “Grow”? Its key result will move up a level. This can't be undone.");
    expect(props.onDelete).toHaveBeenCalledWith("g");
    expect(props.onClose).toHaveBeenCalled();
    unmount();
    const restored = renderPanel(goal({ id: "old", name: "Old", archivedAt: "2026-10-01T09:00:00Z" }));
    fireEvent.click(screen.getByRole("button", { name: "Goal actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore goal" }));
    expect(restored.props.onUpdate).toHaveBeenCalledWith("old", { archivedAt: null });
    confirm.mockRestore();
  });

  it("closes on Escape when docked, and from its close button", () => {
    const { props } = renderPanel(goal({ id: "g", name: "Grow" }), { docked: true });
    fireEvent.keyDown(panel("Grow"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close goal" }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});

describe("before 0052 is run", () => {
  it("edits what goals always had (anyone who writes), with the pace line from when the goal was made; no owners, quarters or check-ins", () => {
    renderPanel({ id: "g", name: "Grow", status: "on_track", workspaceId: "ws", target: 100, current: 10, createdAt: "2026-10-01T09:00:00Z", due: "2026-12-31" },
      { extras: null, me: "m-1", role: "member" });
    expect(screen.getByLabelText("Goal name: Grow")).toBeInTheDocument();
    expect(screen.queryByLabelText("Owner of Grow")).toBeNull();
    expect(screen.queryByLabelText("Period of Grow")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
    expect(screen.getByText("Behind pace by 34%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Goal actions" }));
    expect(screen.queryByRole("menuitem", { name: "Archive goal" })).toBeNull();   // archive and identity come with 0052
    expect(screen.getByRole("menuitem", { name: /Delete goal/ })).toBeInTheDocument();
  });
});

/* Goals outside the Goals page: the "Serves" chips (project header, directory, task panel), the Team
   place's goals card, the goal panel opened from anywhere (its own workspace's people and rules), and
   the hook the rest of the app reads goals through. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import type { Goal, GoalExtras, Project, Role, Task, WorkspaceMember } from "../../data/types";
import { readGoals } from "../../lib/goalFlow";
import { GoalServes, GoalServesRow } from "./GoalServes";
import { TeamGoals } from "./TeamGoals";
import { GoalPanelHost } from "./GoalPanelHost";
import { useGoalFlow } from "./useGoalFlow";

const TODAY = new Date(2026, 10, 10);
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 10, 12)); });
afterEach(() => { vi.useRealTimers(); });

const Q4 = { period: "2026-Q4", periodStart: "2026-10-01", periodEnd: "2026-12-31" };
const goal = (o: Partial<Goal> & { id: string; name: string }): Goal => ({ status: "on_track", workspaceId: "ws", ownerId: "me", contributors: [], kind: "objective", pace: "linear", ...Q4, ...o });
const task = (o: Partial<Task> & { id: string }): Task => ({ title: o.id, description: "", status: "todo", priority: "medium", projectId: "p1", assigneeId: "me", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, workspaceId: "ws", ...o });
const behind = goal({ id: "ret", name: "Studio retention 85%", icon: "🔁", target: 100, current: 10, startValue: 0 });
const onPace = goal({ id: "act", name: "Grow actives", target: 100, current: 50, startValue: 0 });
const reads = readGoals([behind, onPace], [], TODAY);

describe("Serves: a goal chip", () => {
  it("names the goal with its quarter, says how it's doing, opens it, and doesn't open the card or row under it", () => {
    const onOpen = vi.fn(), onRow = vi.fn();
    render(<div onClick={onRow}><GoalServes goals={[behind, onPace]} reads={reads} today={TODAY} onOpen={onOpen} /></div>);
    expect(screen.getByText("Serves")).toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "Serves Q4 · Studio retention 85%, behind pace by 34%. Open the goal" });
    expect(chip).toHaveAttribute("data-state", "behind");
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith("ret");
    expect(onRow).not.toHaveBeenCalled();
    // "+1" is a button: by tap or key it lists the rest, each of which opens (and not the card)
    const more = screen.getByRole("button", { name: "1 more goal: Grow actives" });
    expect(more).toHaveTextContent("+1");
    fireEvent.click(more);
    expect(onRow).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("menu", { name: "More goals it serves" })).getByRole("menuitem", { name: /Q4 · Grow actives/ }));
    expect(onOpen).toHaveBeenLastCalledWith("act");
    expect(onRow).not.toHaveBeenCalled();
  });

  it("on a phone's header, just the goal's tile and pip; nothing at all when a project serves no goal", () => {
    const { container, rerender } = render(<GoalServes goals={[behind]} reads={reads} today={TODAY} onOpen={vi.fn()} compact />);
    expect(screen.queryByText("Serves")).toBeNull();
    expect(container.querySelector(".kgf-chip-text")).toBeNull();
    expect(screen.getByRole("button", { name: /^Serves Q4 · Studio retention 85%/ })).toBeInTheDocument();
    rerender(<GoalServes goals={[]} reads={reads} today={TODAY} onOpen={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("the task panel lists every goal a task serves as its own property row", () => {
    render(<dl><GoalServesRow goals={[behind, onPace]} reads={reads} today={TODAY} onOpen={vi.fn()} /></dl>);
    expect(screen.getByText("Serves").tagName).toBe("DT");
    expect(screen.getAllByRole("button", { name: /^Serves Q4/ })).toHaveLength(2);
  });
});

describe("the Team place: goals this quarter", () => {
  it("sums up the quarter and lists the business's goals, the ones behind first; each opens, All goals goes to the page", () => {
    const onOpenGoal = vi.fn(), onOpenGoals = vi.fn();
    const kr = goal({ id: "kr", name: "A key result", parentId: "act", target: 100, current: 50, startValue: 0 });
    render(<TeamGoals goals={[onPace, behind, kr, goal({ id: "next", name: "Next year", period: "2027-Q1", periodStart: "2027-01-01", periodEnd: "2027-03-31" })]}
      reads={readGoals([onPace, behind, kr], [], TODAY)} today={TODAY} onOpenGoal={onOpenGoal} onOpenGoals={onOpenGoals} />);
    const card = screen.getByRole("region", { name: "Goals this quarter" });
    // the sentence counts what the card lists (the business's goals, not their key results too)
    expect(within(card).getByText("1 of 2 goals on pace; Studio retention 85% is behind.")).toBeInTheDocument();
    expect(within(card).getAllByRole("listitem").map((li) => li.querySelector("button")!.textContent)).toEqual(["Studio retention 85%", "Grow actives"]);
    fireEvent.click(within(card).getByRole("button", { name: "Studio retention 85%" }));
    expect(onOpenGoal).toHaveBeenCalledWith("ret");
    fireEvent.click(within(card).getByRole("link", { name: "All goals" }), { button: 0 });
    expect(onOpenGoals).toHaveBeenCalled();
  });

  it("keeps a goal that's past its date and still open in view (carried over), not only this quarter's", () => {
    const late = goal({ id: "late", name: "Ship the old thing", period: null, periodStart: null, periodEnd: null, createdAt: "2026-07-01T09:00:00Z", due: "2026-09-15", target: 100, current: 10, startValue: 0 });
    render(<TeamGoals goals={[late, onPace]} reads={readGoals([late, onPace], [], TODAY)} today={TODAY} onOpenGoal={vi.fn()} onOpenGoals={vi.fn()} />);
    const card = screen.getByRole("region", { name: "Goals this quarter" });
    expect(within(card).getByText("1 of 2 goals on pace; Ship the old thing is behind.")).toBeInTheDocument();
    expect(within(card).getByText("Past due at 10%")).toBeInTheDocument();
  });

  it("isn't there when nothing runs this quarter", () => {
    const { container } = render(<TeamGoals goals={[]} reads={reads} today={TODAY} onOpenGoal={vi.fn()} onOpenGoals={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("the goal panel, opened from anywhere", () => {
  const member = (userId: string, ws: string, role: Role): WorkspaceMember => ({ id: `${ws}-${userId}`, workspaceId: ws, userId, email: `${userId}@x.org`, name: userId, role, status: "active" });
  const projects: Project[] = [{ id: "p1", name: "Launch", emoji: "🚀", color: "red", workspaceId: "ws" }, { id: "p9", name: "Elsewhere", emoji: "", color: "", workspaceId: "other" }];
  const host = (open: string, o: Partial<Parameters<typeof GoalPanelHost>[0]> = {}) => {
    const props = {
      open: { id: open }, goals: [behind, onPace, goal({ id: "theirs", name: "In the other business", workspaceId: "other" })], extras: { checkins: [], links: [] } as GoalExtras,
      projects, tasks: [task({ id: "t1" }), task({ id: "t9", projectId: "p9", workspaceId: "other" })],
      members: [member("me", "ws", "member"), member("maya", "ws", "member"), member("me", "other", "guest")], statusUpdates: [], me: "me",
      roleIn: (ws: string | null | undefined) => (ws === "other" ? "guest" : ws === "ws" ? "member" : null) as Role | null, docked: true, today: TODAY,
      onClose: vi.fn(), onOpenGoal: vi.fn(), onOpenGoals: vi.fn(), onOpenTask: vi.fn(), onOpenProject: vi.fn(), onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(),
      writes: { checkin: vi.fn(), removeCheckin: vi.fn(), link: vi.fn(), unlink: vi.fn() }, ...o,
    };
    return { ...render(<GoalPanelHost {...props} />), props };
  };

  it("reads the goal's own workspace: its projects to link, your role there, and key results go in that workspace", () => {
    const { props } = host("ret");
    const pick = screen.getByLabelText("Link work to Studio retention 85%") as HTMLSelectElement;
    expect([...pick.options].map((o) => o.value)).toEqual(["", "project:p1", "task:t1"]);   // never another business's
    fireEvent.click(screen.getByRole("button", { name: "Add a key result" }));
    fireEvent.change(screen.getByLabelText("New key result under Studio retention 85%"), { target: { value: "Call 40 lapsed members" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(props.onCreate).toHaveBeenCalledWith("Call 40 lapsed members", expect.objectContaining({ parentId: "ret" }), "ws");
    fireEvent.click(screen.getByRole("button", { name: "Goals" }));
    expect(props.onOpenGoals).toHaveBeenCalledWith("ws");
  });

  it("closes when the goal is gone, or out of your sight (a guest's team goal)", () => {
    const gone = host("deleted");
    expect(gone.props.onClose).toHaveBeenCalled();
    gone.unmount();
    const guest = host("theirs");
    expect(guest.props.onClose).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("useGoalFlow: goals for the rest of the app", () => {
  it("what a project and a task serve, the brief's goal, your goals behind pace, and what Ask is told, from the goals you can see", () => {
    const lead = goal({ id: "lead", name: "Sell", visibility: "leadership", ownerId: "alice" });
    const g = goal({ id: "g", name: "Launch", projectId: "p1", contributors: ["me"], ownerId: "maya", target: 0 });
    const kr = goal({ id: "kr", name: "Win back 120", parentId: "g", kind: "key_result", target: 120, current: 10, startValue: 0 });
    const extras: GoalExtras = { checkins: [], links: [{ id: "l", goalId: "kr", workspaceId: "ws", kind: "task", targetId: "t2" }] };
    const tasks = [task({ id: "t1" }), task({ id: "t2", projectId: "p2" })];
    const { result } = renderHook(() => useGoalFlow({ goals: [lead, g, kr], extras, tasks, me: "me", roleIn: () => "member", members: [], today: TODAY }));
    expect(result.current.goals.map((x) => x.id)).toEqual(["g", "kr"]);
    expect(result.current.forProject("p1").map((x) => x.id)).toEqual(["g"]);
    expect(result.current.forTask(tasks[1]).map((x) => x.id)).toEqual(["kr"]);
    expect(result.current.briefGoal(tasks[1])).toEqual({ goalId: "kr", name: "Win back 120", behind: true, icon: null, color: null });
    expect(result.current.behind().map((b) => b.goalId)).toEqual(["kr"]);
    expect(result.current.behind("other")).toEqual([]);
    expect(result.current.behind("ws")).toBe(result.current.behind("ws"));   // the same array while nothing's changed
    expect(result.current.ask("ws").map((a) => a.id)).toEqual(expect.arrayContaining(["g", "kr"]));
  });
});

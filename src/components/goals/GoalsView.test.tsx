/* The Goals page in Quiet Precision: the one-sentence summary, the quarter switcher, the Company /
   Team / Mine groups, compact rows (identity, owner, pace bar, last check-in, the health of the work
   behind each goal, or "No work behind this"), rows that open the goal panel, the phone's one-tap
   check-in, new goals, archived ones, guests, and the page before 0052 is run. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Goal, GoalCheckin, GoalLink, Project, Task, WorkspaceMember } from "../../data/types";
import { GoalsView } from "./GoalsView";

const TODAY = new Date(2026, 10, 10);   // 10 Nov 2026: day 40 of Q4's 91, 44% of the way
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 10, 12)); });
afterEach(() => { vi.useRealTimers(); });

const Q4 = { period: "2026-Q4", periodStart: "2026-10-01", periodEnd: "2026-12-31" };
const goal = (o: Partial<Goal> & { id: string; name: string }): Goal => ({ status: "on_track", workspaceId: "ws", ownerId: "m-self", contributors: [], kind: "objective", direction: "higher", visibility: "everyone", pace: "linear", ...Q4, ...o });
const member = (userId: string, name: string, role: WorkspaceMember["role"]): WorkspaceMember => ({ id: `wm-${userId}`, workspaceId: "ws", userId, email: `${userId}@x.org`, name, role, status: "active" });
const MEMBERS = [member("m-self", "Daniel Okai", "owner"), member("m-1", "Maya Lin", "member"), member("m-2", "Theo Vance", "member")];
const PROJECTS: Project[] = [{ id: "p1", name: "Launch", emoji: "🚀", color: "red", workspaceId: "ws" }, { id: "p2", name: "Brand", emoji: "🎨", color: "blue", workspaceId: "ws" }];
const TASKS: Task[] = [{ id: "t1", title: "Write the plan", description: "", status: "todo", priority: "medium", projectId: "p1", assigneeId: "m-self", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, dueDate: "2026-11-01" }];


// Grow (company, on pace), Launch (company, read from p1: 0% two thirds through, behind), a key
// result of Maya's (Team) and one of mine (Mine, behind)
const grow = goal({ id: "grow", name: "Grow weekly actives to 5,000", target: 100, current: 45, startValue: 0 });
const launch = goal({ id: "launch", name: "Launch on 30 Nov", projectId: "p1", period: null, periodStart: null, periodEnd: null, due: "2026-11-30", createdAt: "2026-10-01T09:00:00Z" });
const mayas = goal({ id: "act", name: "Lift activation to 45%", parentId: "grow", kind: "key_result", ownerId: "m-1", target: 100, current: 44, startValue: 0 });
const mine = goal({ id: "win", name: "Win back 120 lapsed accounts", parentId: "grow", kind: "key_result", ownerId: "m-self", target: 120, current: 12, startValue: 0, unit: "accounts" });
const ALL = [grow, launch, mayas, mine];
const LINKS: GoalLink[] = [{ id: "l1", goalId: "launch", workspaceId: "ws", kind: "project", targetId: "p1" }, { id: "l2", goalId: "win", workspaceId: "ws", kind: "task", targetId: "t1" }];
const CHECKINS: GoalCheckin[] = [{ id: "c1", goalId: "win", workspaceId: "ws", authorId: "m-self", value: 12, createdAt: "2026-11-01T17:00:00Z" }];

function renderGoals(goals: Goal[], o: Partial<Parameters<typeof GoalsView>[0]> = {}) {
  const props = {
    goals, projects: PROJECTS, tasks: TASKS, onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(),
    extras: { checkins: CHECKINS, links: LINKS }, workspaceId: "ws", me: "m-self", role: "owner" as const, members: MEMBERS, today: TODAY,
    onCheckin: vi.fn(), onDeleteCheckin: vi.fn(), onLink: vi.fn(), onUnlink: vi.fn(), onOpenGoal: vi.fn(), ...o,
  };
  return { ...render(<GoalsView {...props} />), props };
}
/** a goal's row button (the summary names goals too) */
const open = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".kgp-open")].find((b) => b.textContent === name)!;
const row = (name: string) => open(name).closest("li") as HTMLElement;
const group = (label: string) => screen.getByRole("region", { name: `${label} goals` });

describe("the Goals page: the summary and the quarter", () => {
  it("opens with one sentence: how many goals are on pace and which are behind (each opens)", () => {
    const { props } = renderGoals(ALL);
    const lede = document.querySelector(".kgp-summary")!;
    expect(lede.textContent).toBe("2 of 4 goals on pace; Launch on 30 Nov and Win back 120 lapsed accounts are behind.");
    fireEvent.click(within(lede as HTMLElement).getByRole("button", { name: "Win back 120 lapsed accounts" }));
    expect(props.onOpenGoal).toHaveBeenCalledWith("win");
  });

  it("switches quarter: this one first, the next shows its own, All shows every goal", () => {
    renderGoals([...ALL, goal({ id: "next", name: "Open in Leeds", period: "2027-Q1", periodStart: "2027-01-01", periodEnd: "2027-03-31" })]);
    const q = within(screen.getByRole("group", { name: "Quarter" }));
    expect(q.getAllByRole("button").map((b) => b.textContent)).toEqual(["Q3", "Q4", "Q1 2027", "All"]);
    expect(q.getByRole("button", { name: "Q4" })).toHaveAttribute("aria-pressed", "true");
    expect(open("Open in Leeds")).toBeUndefined();
    fireEvent.click(q.getByRole("button", { name: "Q1 2027" }));
    expect(open("Open in Leeds")).toBeDefined();
    expect(open("Launch on 30 Nov")).toBeUndefined();
    fireEvent.click(q.getByRole("button", { name: "Q3" }));
    // said once (no summary sentence over an empty quarter)
    expect(screen.getByText(/Nothing planned for Q3 yet\./)).toBeInTheDocument();
    expect(document.querySelector(".kgp-summary")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show every goal" }));
    expect([open("Open in Leeds"), open("Launch on 30 Nov")].every(Boolean)).toBe(true);
  });
});

describe("the Goals page: planning another quarter", () => {
  it("a new goal goes in the quarter on show (and says so), so planning next quarter keeps it in view", () => {
    const { props } = renderGoals(ALL);
    fireEvent.click(within(screen.getByRole("group", { name: "Quarter" })).getByRole("button", { name: "Q1 2027" }));
    fireEvent.click(screen.getByRole("button", { name: "New goal for Q1 2027" }));
    fireEvent.change(screen.getByLabelText("New goal for Q1 2027"), { target: { value: "Hire a head of sales" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(props.onCreate).toHaveBeenCalledWith("Hire a head of sales", { kind: "objective", ownerId: "m-self", period: "2027-Q1", periodStart: "2027-01-01", periodEnd: "2027-03-31" });
  });

  it("the quarter you're in keeps an open goal whose time ran out (carried over); a long name stays inside the sentence", () => {
    const late = goal({ id: "late", name: "Move every customer to the new billing system before the auditors arrive", period: null, periodStart: null, periodEnd: null,
      createdAt: "2026-07-01T09:00:00Z", due: "2026-09-15", target: 100, current: 10, startValue: 0 });
    renderGoals([grow, late]);
    expect(within(row(late.name)).getByText("Carried over")).toBeInTheDocument();
    expect(within(row(late.name)).getAllByText(/Past due at 10%/).length).toBeGreaterThan(0);
    const named = within(document.querySelector(".kgp-summary") as HTMLElement).getByRole("button", { name: /^Move every customer/ });
    expect(named.textContent!.length).toBeLessThanOrEqual(40);
    expect(named).toHaveAttribute("title", late.name);
  });
});

describe("the Goals page: groups and rows", () => {
  it("puts the business's goals in Company, Maya's key result in Team and mine in Mine", () => {
    renderGoals(ALL);
    expect(within(group("Company")).getAllByRole("listitem").map((li) => li.querySelector(".kgp-open")!.textContent)).toEqual(["Grow weekly actives to 5,000", "Launch on 30 Nov"]);
    expect(group("Team").contains(open("Lift activation to 45%"))).toBe(true);
    expect(group("Mine").contains(open("Win back 120 lapsed accounts"))).toBe(true);
    expect(within(row("Win back 120 lapsed accounts")).getByText("Key result · Grow weekly actives to 5,000")).toBeInTheDocument();
    expect(within(row("Grow weekly actives to 5,000")).getByText("2 key results")).toBeInTheDocument();
  });

  it("each row: its owner, a pace bar with where it should be, the pace in words, the last check-in, the work's health", () => {
    renderGoals(ALL);
    const win = within(row("Win back 120 lapsed accounts"));
    expect(win.getByRole("img", { name: "Owner: Daniel Okai" })).toBeInTheDocument();
    expect(win.getByRole("progressbar", { name: "Win back 120 lapsed accounts progress" })).toHaveAttribute("aria-valuenow", "10");
    expect(row("Win back 120 lapsed accounts").querySelector(".kmeter-marker")).not.toBeNull();
    expect(win.getAllByText(/Behind pace by 34%/).length).toBeGreaterThan(0);
    // the owner's call shows beside the pace, and where they differ the row says so on hover
    expect(win.getAllByText("On track").length).toBeGreaterThan(0);
    expect(win.getAllByTitle("Marked on track; the pace says behind pace by 34%").length).toBeGreaterThan(0);
    // its own number in words, so the % by the bar reads as how far along it is
    expect(win.getByText("12 of 120 accounts")).toBeInTheDocument();
    expect(win.getByTitle("10% of the way")).toHaveTextContent("10%");
    expect(win.getByTitle("Last check-in 9 days ago")).toHaveTextContent("9d");
    // Launch reads its % from p1, whose task is overdue: an amber dot, named
    expect(within(row("Launch on 30 Nov")).getByRole("img", { name: "Launch: 0% done, work overdue" })).toBeInTheDocument();
    // Maya's key result has nothing linked: it says so
    expect(within(row("Lift activation to 45%")).getAllByText(/no work behind this/i).length).toBeGreaterThan(0);
    // Grow has work through its key results
    expect(within(row("Grow weekly actives to 5,000")).queryAllByText(/no work behind this/i)).toHaveLength(0);
  });

  it("a row opens the goal panel; ↓ and ↑ move between rows", () => {
    const { props } = renderGoals(ALL, { openGoalId: "grow" });
    expect(row("Grow weekly actives to 5,000")).toHaveAttribute("data-open", "true");
    fireEvent.click(open("Launch on 30 Nov"));
    expect(props.onOpenGoal).toHaveBeenCalledWith("launch");
    const first = open("Grow weekly actives to 5,000");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(open("Launch on 30 Nov"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
  });

  it("a phone's one-tap check-in: on goals that track their own number, for whoever may edit them", () => {
    const { props } = renderGoals(ALL, { me: "m-1", role: "member" });
    // Maya edits her key result (and Grow, which she doesn't own, she only reads)
    fireEvent.click(screen.getByRole("button", { name: "Check in on Lift activation to 45%" }));
    expect(props.onOpenGoal).toHaveBeenCalledWith("act", { checkin: true });
    expect(screen.queryByRole("button", { name: "Check in on Grow weekly actives to 5,000" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check in on Launch on 30 Nov" })).toBeNull();   // read from a project
  });

  it("without a host's panel, the page opens its own", () => {
    renderGoals(ALL, { onOpenGoal: undefined });
    fireEvent.click(open("Win back 120 lapsed accounts"));
    expect(screen.getByRole("dialog", { name: "Goal: Win back 120 lapsed accounts" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close goal" }));
    expect(screen.queryByRole("dialog", { name: /^Goal:/ })).toBeNull();
  });
});

describe("the Goals page: who sees and makes what", () => {
  it("an owner's new goal is a company goal, theirs, this quarter", () => {
    const { props } = renderGoals([grow]);
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));
    fireEvent.change(screen.getByLabelText("New goal for Q4"), { target: { value: "Hire two engineers" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(props.onCreate).toHaveBeenCalledWith("Hire two engineers", { kind: "objective", ownerId: "m-self", ...Q4 });
  });

  it("a member makes no company goals (the page says who does) and never sees a leadership-only one", () => {
    renderGoals([...ALL, goal({ id: "l", name: "Sell the company", visibility: "leadership", target: 1, current: 0 })], { me: "m-1", role: "member" });
    expect(screen.queryByRole("button", { name: "New goal" })).toBeNull();
    expect(screen.getByText(/Owners and admins set the business's goals/)).toBeInTheDocument();
    expect(open("Sell the company")).toBeUndefined();
  });

  it("archived goals are out of the way until asked for", () => {
    renderGoals([grow, goal({ id: "old", name: "Last quarter's", archivedAt: "2026-10-01T09:00:00Z" })]);
    expect(open("Last quarter's")).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Show archived (1)" }));
    expect(within(row("Last quarter's")).getByText("Archived")).toBeInTheDocument();
  });

  it("a guest reads the goals calmly (before 0051's lock), or learns that goals are for members", () => {
    const { unmount } = renderGoals(ALL, { readOnly: true, role: "guest", extras: null });
    expect(screen.getByText(/as a guest you can read them/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New goal" })).toBeNull();
    expect(screen.getByRole("article", { name: "Goal Grow weekly actives to 5,000" })).toBeInTheDocument();
    unmount();
    renderGoals(ALL, { readOnly: true, role: "guest" });   // with 0052 the team's goals never reach a guest
    expect(screen.getByText("Goals are for members")).toBeInTheDocument();
  });

  it("with no goals yet, owners start one", () => {
    renderGoals([]);
    expect(screen.getByText("No goals yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New goal" })).toBeInTheDocument();
  });
});

describe("before 0052 is run", () => {
  it("reads the goals as they were: rows and pace from when they were made, no owners or check-ins, anyone who writes adds one", () => {
    const { props } = renderGoals([{ id: "g", name: "Grow", status: "on_track", workspaceId: "ws", target: 100, current: 10, createdAt: "2026-10-01T09:00:00Z", due: "2026-12-31" }],
      { extras: null, me: "m-1", role: "member" });
    const r = within(row("Grow"));
    expect(r.getAllByText(/Behind pace by 34%/).length).toBeGreaterThan(0);
    expect(r.queryByRole("img", { name: /^Owner/ })).toBeNull();
    expect(r.queryByRole("img", { name: "No owner" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Check in on/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New goal" }));
    fireEvent.change(screen.getByLabelText("New goal name"), { target: { value: "Ship it" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(props.onCreate).toHaveBeenCalledWith("Ship it");
  });
});


/* The rollout's screens (0058): the first run's fork and the team's one sheet (through OnboardingModal),
   "Welcome to <workspace>", and Team › People › Workspace health with its fixes and the rollout plan. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Profile, Project, Task, WorkspaceMember } from "../../data/types";
import { OnboardingModal } from "../OnboardingModal";
import type { TeamStartHost } from "./TeamStart";
import { WelcomeCard } from "./WelcomeCard";
import { WorkspaceHealthCard, type WorkspaceHealthProps } from "./WorkspaceHealth";
import { workspaceHealth, welcomeContent } from "../../lib/rollout";

const NOW = new Date(2026, 10, 10, 9, 0);
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

const profile = (first: string): Profile => ({ id: "m-self", firstName: first, lastName: "", pronouns: "", email: "sam@acme.co", avatarUrl: null } as Profile);
const host = (extra: Partial<TeamStartHost> = {}): TeamStartHost => ({
  create: vi.fn(async () => "ws-new"), pickPack: vi.fn(), importWork: vi.fn(), invite: vi.fn(async (_ws: string, emails: string[]) => ({ invited: emails.length, failed: [] })), ...extra,
});
const base = { open: true, workspaceId: null, onSaveProfile: vi.fn(async () => {}), onCreateProject: vi.fn(), onFinish: vi.fn() };

describe("the first run's fork (0058)", () => {
  it("asks who Kanbo is for after the name; Just me goes on exactly as before", () => {
    const onCreateProject = vi.fn();
    render(<OnboardingModal {...base} onCreateProject={onCreateProject} profile={profile("Sam")} team={host()} />);
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    expect(screen.getByRole("heading", { name: "Who's Kanbo for?" })).toBeInTheDocument();
    const choices = within(screen.getByRole("group", { name: "Who's Kanbo for?" })).getAllByRole("button");
    expect(choices.map((b) => b.querySelector(".kfork-choice-title")?.textContent)).toEqual(["Just me", "My team", "A whole business"]);
    expect(choices[0]).toHaveFocus();
    fireEvent.click(choices[0]);
    expect(screen.getByRole("heading", { name: "Create your first project" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Website" } });
    fireEvent.click(screen.getByRole("button", { name: /Create project/ }));
    expect(onCreateProject).toHaveBeenCalledWith(expect.objectContaining({ name: "Website", workspaceId: null }));
    expect(screen.getByRole("heading", { name: "Your five places" })).toBeInTheDocument();
  });
  it("without a name yet: the name, then the fork", () => {
    render(<OnboardingModal {...base} profile={profile("")} team={host()} />);
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByRole("heading", { name: "Who's Kanbo for?" })).toBeInTheDocument();
  });
  it("A whole business: names and makes the workspace, then one sheet offers a pack, an import and a pilot group", async () => {
    const h = host();
    const onStartTour = vi.fn(), onFinish = vi.fn();
    const { rerender } = render(<OnboardingModal {...base} onFinish={onFinish} tourAvailable onStartTour={onStartTour} profile={profile("Sam")} team={h} />);
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    fireEvent.click(screen.getByRole("button", { name: /A whole business/ }));
    expect(screen.getByRole("heading", { name: "What's the business called?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Business name"), { target: { value: "Harbour Fitness" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create workspace" })); });
    expect(h.create).toHaveBeenCalledWith("Harbour Fitness", "business");
    expect(screen.getByRole("heading", { name: "Set up Harbour Fitness" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Set up Harbour Fitness");
    // the pack and the import open their own sheets, for the new workspace
    fireEvent.click(screen.getByRole("button", { name: "Pick a pack" }));
    expect(h.pickPack).toHaveBeenCalledWith("ws-new");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(h.importWork).toHaveBeenCalledWith("ws-new");
    // the pilot group, invited from here (one bad address is pointed out, the good ones go)
    const box = screen.getByLabelText("Pilot group emails");
    fireEvent.change(box, { target: { value: "sam@harbourfit.co.uk, alex@harbourfit.co.uk, nope" } });
    expect(screen.getByText("“nope” doesn't look like an email address.")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Invite 2" })); });
    expect(h.invite).toHaveBeenCalledWith("ws-new", ["sam@harbourfit.co.uk", "alex@harbourfit.co.uk"]);
    // the host keeps what's been done (the step is shown again after the pack's and the import's sheets)
    rerender(<OnboardingModal {...base} onFinish={onFinish} tourAvailable onStartTour={onStartTour} profile={profile("Sam")}
      team={{ ...h, progress: { pack: "Boutique fitness group", imported: 12, invited: 2 } }} />);
    expect(screen.getByText("Boutique fitness group is set up")).toBeInTheDocument();
    expect(screen.getByText("12 tasks brought in")).toBeInTheDocument();
    expect(screen.getByText("Invited 2 people to your pilot group")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pick a pack" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    // the hand-over to the tour, which shows the team's rhythm too
    expect(screen.getByRole("heading", { name: "You're all set, Sam" })).toBeInTheDocument();
    expect(screen.getByText(/Pulse, goals, project updates and what you're waiting on/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show me around/ }));
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onStartTour).toHaveBeenCalledTimes(1);
  });
  it("My team: Back returns to the fork; a workspace that couldn't be made says so and stays", async () => {
    const h = host({ create: vi.fn(async () => null) });
    render(<OnboardingModal {...base} profile={profile("Sam")} team={h} />);
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    fireEvent.click(screen.getByRole("button", { name: /My team/ }));
    expect(screen.getByRole("heading", { name: "What's your team called?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: /My team/ }));
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Studio Ops" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create workspace" })); });
    expect(h.create).toHaveBeenCalledWith("Studio Ops", "team");
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't set it up just now");
    expect(screen.getByRole("heading", { name: "What's your team called?" })).toBeInTheDocument();
  });
});

/* ---------------- Welcome to <workspace> ---------------- */

const m = (id: string, role: WorkspaceMember["role"], extra: Partial<WorkspaceMember> = {}): WorkspaceMember =>
  ({ id: `wm-${id}`, workspaceId: "ws", userId: id, email: `${id}@acme.co`, name: id, role, status: "active", ...extra });

describe("Welcome to <workspace>", () => {
  it("shows your projects, your people, the goal, who to ask and where to start; Got it puts it away", () => {
    const projects: Project[] = [{ id: "p1", name: "Northwind Review", emoji: "🧭", color: "#36f", workspaceId: "ws", contributorIds: ["m-1"] }];
    const tasks = [{ id: "t1", title: "Read the board pack", status: "todo", projectId: "p1", assigneeId: "m-1", dueDate: "2026-11-11", workspaceId: "ws", aiScore: 1 } as unknown as Task];
    const content = welcomeContent({ me: "m-1", workspace: { id: "ws", ownerId: "m-3" }, role: "member", members: [m("m-1", "member"), m("m-3", "owner")], projects, tasks,
      goals: [{ id: "g1", name: "Sign 6 new retainer clients", status: "on_track", workspaceId: "ws" }], nameOf: (x) => (x.userId === "m-3" ? "Sana Rao" : x.name) });
    const onDismiss = vi.fn(), onOpenProject = vi.fn(), onOpenTask = vi.fn(), onOpenGoal = vi.fn(), onOpenPeople = vi.fn();
    render(<WelcomeCard workspaceName="Harbour Advisory" content={content} goalRead={{ pct: 50, line: "Ahead of pace" }}
      onOpenProject={onOpenProject} onOpenTask={onOpenTask} onOpenGoal={onOpenGoal} onOpenPeople={onOpenPeople} onDismiss={onDismiss} />);
    const card = screen.getByRole("region", { name: "Welcome to Harbour Advisory" });
    expect(within(card).getByRole("heading", { name: "Your project" })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /Northwind Review/ }));
    expect(onOpenProject).toHaveBeenCalledWith("p1");
    expect(within(card).getByText("Sana Rao")).toBeInTheDocument();
    expect(within(card).getByText("Owner")).toBeInTheDocument();
    expect(within(card).getByText("50% · Ahead of pace")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /Sign 6 new retainer clients/ }));
    expect(onOpenGoal).toHaveBeenCalledWith("g1");
    // the one person here is who to ask: said once, under them, by name
    expect(within(card).getByText("Ask Sana, who runs Harbour Advisory, anything about how things run here.")).toBeInTheDocument();
    expect(within(card).queryByRole("heading", { name: "Who to ask" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: /Read the board pack/ }));
    expect(onOpenTask).toHaveBeenCalledWith("t1");
    expect(within(card).getByText("Due 11 Nov")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "See everyone in People" }));
    expect(onOpenPeople).toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Got it" }));
    fireEvent.click(within(card).getByRole("button", { name: "Put away “Welcome to Harbour Advisory”" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
  it("with nothing of yours yet: a first step, not an empty list", () => {
    const content = welcomeContent({ me: "m-1", workspace: { id: "ws", ownerId: "m-3" }, role: "guest", members: [m("m-1", "guest")], projects: [], tasks: [], nameOf: (x) => x.name });
    render(<WelcomeCard workspaceName="Northlight" content={content} onOpenProject={vi.fn()} onOpenTask={vi.fn()} onOpenPeople={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText("No projects here yet.")).toBeInTheDocument();
    expect(screen.getByText("It's just you here so far.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "A good first step" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "The team's goal" })).toBeNull();
  });
});

/* ---------------- Workspace health ---------------- */

const members = [m("dan", "owner"), m("maya", "member", { name: "Maya Lin" }), m("theo", "member", { name: "Theo Vance" }), m("gus", "guest", { name: "Gus" }),
  { ...m("x", "member"), userId: null, status: "invited" as const, email: "priya@acme.co", name: "Priya Shah", invitedAt: new Date(NOW.getTime() - 5 * 86_400_000).toISOString() }];
const projects: Project[] = [{ id: "p1", name: "Ops", emoji: "⚙️", color: "#36f", workspaceId: "ws", ownerId: "maya" }];
const looseTasks = [
  { id: "t1", title: "Order springs", status: "todo", projectId: "p1", assigneeId: "", dueDate: "2026-11-20", workspaceId: "ws" },
  { id: "t2", title: "Book photographer", status: "todo", projectId: "p1", assigneeId: "theo", workspaceId: "ws" },
] as unknown as Task[];
function healthProps(extra: Partial<WorkspaceHealthProps> = {}): WorkspaceHealthProps {
  const health = workspaceHealth({ workspaceId: "ws", members, tasks: looseTasks, projects, statusUpdates: [], workspaces: [{ id: "ws", name: "Acme", kind: "team" }], today: NOW,
    activity: { today: "2026-11-10", members: [{ userId: "dan", days: 5, lastDay: "2026-11-10" }, { userId: "maya", days: 2, lastDay: "2026-11-09" }, { userId: "theo", days: 0, lastDay: "2026-10-28" }],
      days: ["04", "05", "06", "07", "08", "09", "10"].map((d, i) => ({ day: `2026-11-${d}`, people: i % 3 })) } });
  return {
    workspaceName: "Acme", health, activity: "ok", members: members.filter((x) => x.status === "active"), nameOf: (x) => x.name || x.email, projects,
    rollout: { champion: "maya" }, rolloutOn: true, onSaveRollout: vi.fn(), onResendAll: vi.fn(async () => ({ sent: 1, failed: 0 })),
    onAskUpdates: vi.fn(async () => ({ asked: 1 })), onOpenGoals: vi.fn(), onPatchTask: vi.fn(), onGiveToOwners: vi.fn(() => 1), ...extra,
  };
}

describe("Workspace health", () => {
  it("one line each, with its fix; activity by day only", async () => {
    const p = healthProps();
    render(<WorkspaceHealthCard {...p} />);
    const card = screen.getByRole("region", { name: "Workspace health" });
    expect(within(card).getByText("3 things to look at")).toBeInTheDocument();
    expect(within(card).getByText("1 person invited but not joined")).toBeInTheDocument();
    expect(within(card).getByText("Priya Shah hasn't signed in yet.")).toBeInTheDocument();
    expect(within(card).getByText("2 of 4 people active in the last 7 days")).toBeInTheDocument();
    expect(within(card).getByText(/Quiet this week: Gus \(not in the last month\) and Theo \(over a week ago\)\. Counted by day from opening Kanbo or working here, never by the hour\./)).toBeInTheDocument();
    expect(within(card).getByRole("img", { name: /^People active each day: Wed 0, Thu 1, Fri 2/ })).toBeInTheDocument();
    expect(within(card).getByText("2 open tasks with no owner or date")).toBeInTheDocument();
    expect(within(card).getByText("1 with no owner · 1 with no date")).toBeInTheDocument();
    // Ops has work and no update: due on the team's update day (weekly, Friday), missing since
    expect(within(card).getByText("1 project missing an update")).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Resend invite" })); });
    expect(p.onResendAll).toHaveBeenCalled();
    expect(within(card).getByText("Sent 1 fresh invite.")).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Ask for it" })); });
    expect(p.onAskUpdates).toHaveBeenCalled();
    expect(within(card).getByText("Asked 1 owner. They'll find Kanbo's draft waiting.")).toBeInTheDocument();
    // goals 2.0 isn't in: no goal line
    expect(within(card).queryByText(/check-in/)).toBeNull();
  });
  it("Sort them out: an owner and a date for each, or every unowned one to its project's owner", () => {
    const p = healthProps();
    render(<WorkspaceHealthCard {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort them out" }));
    const sheet = screen.getByRole("dialog", { name: "Tasks with no owner or date" });
    // owners are people who can work here (never a guest)
    const owner = within(sheet).getByRole("combobox", { name: "Owner for Order springs" });
    expect(within(owner).getAllByRole("option").map((o) => o.textContent)).toEqual(["No owner", "dan", "Maya Lin", "Theo Vance"]);
    fireEvent.change(owner, { target: { value: "theo" } });
    expect(p.onPatchTask).toHaveBeenCalledWith("t1", { assigneeId: "theo" });
    fireEvent.change(within(sheet).getByLabelText("Due date for Book photographer"), { target: { value: "2026-11-28" } });
    expect(p.onPatchTask).toHaveBeenCalledWith("t2", { dueDate: "2026-11-28" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Give to project owners" }));
    expect(p.onGiveToOwners).toHaveBeenCalledWith(["t1"]);
  });
  it("opened from Kanbo noticed's Assign now: the sheet's already open", () => {
    render(<WorkspaceHealthCard {...healthProps({ focus: { fix: "assign", at: 1 } })} />);
    expect(screen.getByRole("dialog", { name: "Tasks with no owner or date" })).toBeInTheDocument();
  });
  it("the rollout plan: a champion, a pilot group and a go-live date, from the team's members", () => {
    const p = healthProps();
    render(<WorkspaceHealthCard {...p} />);
    expect(screen.getByText("Maya Lin is your champion")).toBeInTheDocument();
    expect(screen.getByText("1 of 3 decided")).toBeInTheDocument();
    const champ = screen.getByRole("combobox", { name: "Champion" });
    expect(within(champ).getAllByRole("option").map((o) => o.textContent)).toEqual(["No one yet", "dan", "Maya Lin", "Theo Vance"]);
    fireEvent.change(champ, { target: { value: "theo" } });
    expect(p.onSaveRollout).toHaveBeenLastCalledWith({ champion: "theo" });
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    fireEvent.click(screen.getByRole("button", { name: /Theo Vance/ }));
    expect(p.onSaveRollout).toHaveBeenLastCalledWith({ champion: "maya", pilot: ["theo"] });
    fireEvent.change(screen.getByLabelText("Go-live date"), { target: { value: "2026-12-01" } });
    expect(p.onSaveRollout).toHaveBeenLastCalledWith({ champion: "maya", goLive: "2026-12-01" });
    fireEvent.change(champ, { target: { value: "" } });
    expect(p.onSaveRollout).toHaveBeenLastCalledWith(null);
  });
  it("before 0058: the plan and the activity say they aren't switched on yet, the rest still works", () => {
    const h = healthProps();
    render(<WorkspaceHealthCard {...h} health={{ ...h.health, active: null }} activity="off" rolloutOn={false} />);
    expect(screen.getAllByText("Not switched on yet.")).toHaveLength(2);
    expect(screen.getByRole("combobox", { name: "Champion" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resend invite" })).toBeEnabled();
  });
  it("a workspace that's only just started is never \"All good\": each empty line says what's not there yet", () => {
    try { localStorage.removeItem("kanbo-health-folded"); } catch { /* none */ }
    const solo = [m("dan", "owner")];
    const health = workspaceHealth({ workspaceId: "ws", members: solo, tasks: [], projects: [], statusUpdates: [], workspaces: [{ id: "ws", name: "Studio Ops", kind: "team" }], today: NOW,
      goals: [], checkins: [],
      activity: { today: "2026-11-10", since: "2026-11-10", members: [{ userId: "dan", days: 1, lastDay: "2026-11-10" }],
        days: ["04", "05", "06", "07", "08", "09", "10"].map((d) => ({ day: `2026-11-${d}`, people: d === "10" ? 1 : 0 })) } });
    const onInvite = vi.fn();
    render(<WorkspaceHealthCard {...healthProps({ health, members: solo, projects: [], rollout: null, workspaceName: "Studio Ops", onInvite })} />);
    const card = screen.getByRole("region", { name: "Workspace health" });
    expect(within(card).getByText("Just getting started")).toBeInTheDocument();
    expect(within(card).queryByText("All good")).toBeNull();
    expect(within(card).getByText("Nobody invited yet")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Invite people" }));
    expect(onInvite).toHaveBeenCalled();
    expect(within(card).getByText("Only you so far")).toBeInTheDocument();
    expect(within(card).queryByRole("img", { name: /People active each day/ })).toBeNull();
    expect(within(card).getByText("No open tasks yet")).toBeInTheDocument();
    expect(within(card).getByText("No projects yet")).toBeInTheDocument();
    expect(within(card).getByText("No goals yet")).toBeInTheDocument();
    // none of the "fine" ticks for what isn't there
    for (const ok of ["Everyone you invited has joined", "Every open task has an owner and a date", "No project updates missing", "Every goal has a recent check-in"]) {
      expect(within(card).queryByText(ok)).toBeNull();
    }
  });
  it("the day strip starts on the workspace's first day; the card folds to its heading, and remembers", () => {
    try { localStorage.removeItem("kanbo-health-folded"); } catch { /* none */ }
    const p = healthProps();
    const health = { ...p.health, active: { ...p.health.active!, since: "2026-11-08" } };
    const { unmount } = render(<WorkspaceHealthCard {...p} health={health} />);
    expect(screen.getByRole("img", { name: /^People active each day: Wed before Acme started, Thu before Acme started, Fri before Acme started, Sat before Acme started, Sun 1, Mon 2, Tue 0$/ })).toBeInTheDocument();
    const fold = screen.getByRole("button", { name: "Workspace health" });
    expect(fold).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("2 open tasks with no owner or date")).not.toBeVisible();
    unmount();
    render(<WorkspaceHealthCard {...p} health={health} />);
    expect(screen.getByRole("button", { name: "Workspace health" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Workspace health" }));
    expect(screen.getByText("2 open tasks with no owner or date")).toBeVisible();
  });
  it("the rollout plan saves as it's shown: a champion who's left and a pilot who's gone drop out, so the save still goes through", () => {
    try { localStorage.removeItem("kanbo-health-folded"); } catch { /* none */ }
    const p = healthProps({ rollout: { champion: "gone", pilot: ["maya", "left", "gus"], goLive: "2026-12-01" } });
    render(<WorkspaceHealthCard {...p} />);
    expect(screen.getByText("Pick a champion")).toBeInTheDocument();
    expect(screen.getByText("Pilot group: Maya")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Go-live date"), { target: { value: "2026-12-08" } });
    // (gus is a guest: never in the pilot group)
    expect(p.onSaveRollout).toHaveBeenLastCalledWith({ pilot: ["maya"], goLive: "2026-12-08" });
    fireEvent.change(screen.getByRole("combobox", { name: "Champion" }), { target: { value: "theo" } });
    expect(p.onSaveRollout).toHaveBeenLastCalledWith({ champion: "theo", pilot: ["maya"], goLive: "2026-12-01" });
  });
});

describe("the first run, more", () => {
  it("Just me can go back to the fork; the dots never grow on the way", () => {
    render(<OnboardingModal {...base} profile={profile("Sam")} team={host()} />);
    expect(screen.getByText("A couple of quick questions to set Kanbo up for you.")).toBeInTheDocument();
    const dots = () => document.querySelectorAll(".konb-dot").length;
    const before = dots();
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    expect(dots()).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: /Just me/ }));
    expect(dots()).toBeLessThanOrEqual(before);
    expect(screen.getByRole("heading", { name: "Create your first project" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Who's Kanbo for?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /A whole business/ }));
    expect(dots()).toBe(before);
  });
  it("the pilot invite keeps what it couldn't read in the box, and says so", async () => {
    const h = host();
    render(<OnboardingModal {...base} profile={profile("Sam")} team={h} />);
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    fireEvent.click(screen.getByRole("button", { name: /A whole business/ }));
    fireEvent.change(screen.getByLabelText("Business name"), { target: { value: "Northside" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create workspace" })); });
    const box = screen.getByLabelText(/pilot/i) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "sam@northside.co.uk, alex, jo@northside.co.uk" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Invite 2/ })); });
    expect(h.invite).toHaveBeenCalledWith("ws-new", ["sam@northside.co.uk", "jo@northside.co.uk"]);
    expect(box.value).toBe("alex");
    expect(screen.getByText(/Couldn't read “alex”: add the full address\./)).toBeInTheDocument();
  });
});


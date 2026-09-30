import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within, cleanup } from "@testing-library/react";
import { TeamPulse } from "./TeamPulse";
import { dayOffset } from "../../data/data";
import type { Task, WorkspaceMember, WorkspaceEvent } from "../../data/types";

const WS = "ws-foundrise";
let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "p" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-1",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, workspaceId: WS, createdAt: new Date().toISOString(), ...o,
});
const member = (userId: string, role: WorkspaceMember["role"] = "member", title?: string): WorkspaceMember =>
  ({ id: "w-" + userId, workspaceId: WS, userId, email: `${userId}@kanbo.app`, name: "", role, status: "active", title });

const MEMBERS = [member("m-self", "owner", "Founder"), member("m-1", "member", "Engineering"), member("m-2"), member("m-3", "member", "Design lead")];

/** A small Foundrise: Maya over capacity and blocked on Sana's tokens, Theo finished something yesterday. */
function demoTasks(): Task[] {
  return [
    task({ id: "tokens", title: "Define design tokens v2", status: "review", assigneeId: "m-3", dueDate: dayOffset(0) }),
    task({ id: "onb", title: "Ship onboarding redesign", status: "blocked", assigneeId: "m-1", dueDate: dayOffset(1), dependencies: ["tokens"], effortHours: 12 }),
    task({ id: "edge", title: "Migrate auth to edge sessions", status: "progress", assigneeId: "m-1", dueDate: dayOffset(0), effortHours: 30 }),
    task({ id: "audit", title: "Audit landing-page performance", status: "done", assigneeId: "m-2", completedAt: dayOffset(-1) }),
    task({ id: "deck", title: "Finalise launch deck", status: "progress", assigneeId: "m-self", dueDate: dayOffset(0) }),
  ];
}

function pulse(extra: Partial<Parameters<typeof TeamPulse>[0]> = {}) {
  const props = {
    tasks: demoTasks(), members: MEMBERS, currentUserId: "m-self", workspaceName: "Foundrise", readOnly: false,
    loadEvents: vi.fn(async (): Promise<WorkspaceEvent[]> => []),
    onOpen: vi.fn(), onNudge: vi.fn(async () => {}), onPatch: vi.fn(), onOpenWorkload: vi.fn(),
    ...extra,
  };
  const utils = render(<TeamPulse {...props} />);
  return { ...utils, props };
}
const ready = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

describe("TeamPulse", () => {
  it("renders the lede, a row per person and the Radar from the team's work", async () => {
    const { props } = pulse();
    await ready();
    expect(props.loadEvents).toHaveBeenCalledTimes(1);
    const lede = screen.getByText((_, el) => el?.classList.contains("kpulse-lede") ?? false);
    expect(lede.textContent).toMatch(/the team finished 1 task\. 3 are in flight, 1 is blocked and Maya is over capacity\.$/);
    const table = screen.getByRole("table");
    const maya = within(table).getByRole("row", { name: /Maya Lin/ });
    expect(maya).toHaveTextContent("Blocked · waiting on Sana");
    expect(maya).toHaveTextContent("42h / 40h");
    expect(within(table).getByRole("row", { name: /Daniel Okai/ })).toHaveTextContent("Founder · you");
    expect(within(table).getByRole("row", { name: /Theo Vance/ })).toHaveTextContent("Audit landing-page performance");
    const radar = screen.getByRole("complementary", { name: "Radar" });
    expect(within(radar).getByText("Ship onboarding redesign is blocked")).toBeInTheDocument();
    expect(within(radar).getByText("Maya is over capacity")).toBeInTheDocument();
  });

  it("shows placeholders while the change history loads", async () => {
    let resolve: (v: WorkspaceEvent[]) => void = () => {};
    pulse({ loadEvents: () => new Promise((r) => { resolve = r; }) });
    expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Write it up" })).toBeDisabled();
    await act(async () => { resolve([]); });
    expect(screen.getByRole("table")).not.toHaveAttribute("aria-busy");
  });

  it("says so when the history can't load, and carries on from task dates — without guessing at stale work", async () => {
    const quiet = task({ id: "hero", title: "Hero illustration", status: "progress", assigneeId: "m-3", createdAt: new Date(Date.now() - 40 * 86400000).toISOString() });
    pulse({ tasks: [...demoTasks(), quiet], loadEvents: vi.fn(async () => { throw new Error("offline"); }) });
    await ready();
    expect(screen.getByText("Couldn't load today's changes — showing what Kanbo knows from task dates.", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Theo Vance/ })).toHaveTextContent("Audit landing-page performance");
    // no history is not "no changes": Radar leaves stale work out rather than calling it untouched for a month
    const radar = screen.getByRole("complementary", { name: "Radar" });
    expect(within(radar).queryByText(/hasn't moved/)).toBeNull();
    expect(within(radar).getByText("Ship onboarding redesign is blocked")).toBeInTheDocument();
    // and Write it up doesn't claim "0 changes"
    const onWriteUp = vi.fn(async () => ({ data: "Kanbo's words.", source: "ai" as const }));
    cleanup();
    pulse({ onWriteUp, loadEvents: vi.fn(async () => { throw new Error("offline"); }) });
    await ready();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Write it up" })); });
    expect(screen.getByText(/How I got here · from \d+ tasks since yesterday/)).toBeInTheDocument();
    expect(screen.queryByText(/changes since/)).toBeNull();
  });

  it("with the history loaded, quiet work shows; a history cut short at the page limit only vouches for what it holds", async () => {
    const quiet = task({ id: "hero", title: "Hero illustration", status: "progress", assigneeId: "m-3", createdAt: new Date(Date.now() - 40 * 86400000).toISOString() });
    pulse({ tasks: [...demoTasks(), quiet] });
    await ready();
    expect(within(screen.getByRole("complementary", { name: "Radar" })).getByText("Hero illustration hasn't moved in over 30 days")).toBeInTheDocument();
    cleanup();
    // a full page (the store's newest 500) going back only 5 days: the hero task may well have changed before that
    const busy: WorkspaceEvent[] = Array.from({ length: 500 }, (_, i) => ({
      id: "e" + i, taskId: "edge", actorId: "m-1", actorName: "Maya Lin", field: "title", oldValue: "a", newValue: "b",
      createdAt: new Date(Date.now() - (i % 5) * 86400000).toISOString(),
    }));
    pulse({ tasks: [...demoTasks(), quiet], loadEvents: vi.fn(async () => busy) });
    await ready();
    expect(within(screen.getByRole("complementary", { name: "Radar" })).queryByText(/Hero illustration hasn't moved/)).toBeNull();
  });

  it("Write it up falls back to the template when Kanbo AI is off", async () => {
    pulse();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Write it up" }));
    const sheet = screen.getByRole("dialog", { name: "Write it up" });
    const text = within(sheet).getByLabelText("Standup text") as HTMLTextAreaElement;
    expect(text.value.split("\n")[0]).toMatch(/^\*Pulse — \w{3} \d{1,2} \w{3}\*$/);
    expect(text.value).toContain("• *Maya* — today: Migrate auth to edge sessions; blocked: Ship onboarding redesign");
    expect(within(sheet).getByText("Written from your team's tasks (Kanbo AI is off)")).toBeInTheDocument();
    expect(within(sheet).queryByText(/How I got here/)).toBeNull();
  });

  it("Write it up uses Kanbo's words when AI answers, with where they came from", async () => {
    const onWriteUp = vi.fn(async (_facts: unknown) => ({ data: "Done: the audit.\nToday: auth and the deck.", source: "ai" as const }));
    pulse({ onWriteUp });
    await ready();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Write it up" })); });
    const facts = onWriteUp.mock.calls[0][0] as { people: { name: string }[]; risks: unknown[] };
    expect(facts.people.map((p) => p.name)).toContain("Maya Lin");
    expect(JSON.stringify(facts)).not.toContain('"id"');
    const sheet = screen.getByRole("dialog", { name: "Write it up" });
    expect(within(sheet).getByLabelText("Standup text")).toHaveValue("Done: the audit.\nToday: auth and the deck.");
    expect(within(sheet).getByText(/How I got here · from \d+ tasks since yesterday/)).toBeInTheDocument();
  });

  it("Write it up still writes the template when Kanbo AI isn't available or is at its limit", async () => {
    const onWriteUp = vi.fn(async (_facts: unknown) => ({ data: null, source: "limit" as const }));
    pulse({ onWriteUp });
    await ready();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Write it up" })); });
    expect((screen.getByLabelText("Standup text") as HTMLTextAreaElement).value).toContain("*Pulse — ");
    expect(screen.getByText("Written from your team's tasks (you've reached today's Kanbo AI limit)")).toBeInTheDocument();
  });

  it("Nudge posts the edited text as a comment on the blocker, mentioning its owner", async () => {
    const onNudge = vi.fn(async () => {});
    pulse({ onNudge });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Nudge Sana" }));
    const pop = screen.getByRole("dialog", { name: "Nudge Sana" });
    const field = within(pop).getByRole("textbox");
    expect(field).toHaveValue('@Sana — is anything blocking "Define design tokens v2"?');
    fireEvent.change(field, { target: { value: "@Sana — can we land the tokens today?" } });
    await act(async () => { fireEvent.click(within(pop).getByRole("button", { name: "Send" })); });
    expect(onNudge).toHaveBeenCalledWith("tokens", "m-3", "@Sana — can we land the tokens today?");
    expect(screen.queryByRole("dialog", { name: "Nudge Sana" })).toBeNull();
    expect(screen.getByText("Nudged Sana")).toBeInTheDocument();
  });

  it("a nudge that fails says so and keeps the text", async () => {
    pulse({ onNudge: vi.fn(async () => { throw new Error("offline"); }) });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Nudge Sana" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't send the nudge");
    expect(screen.getByRole("dialog", { name: "Nudge Sana" })).toBeInTheDocument();
  });

  it("a nudge the host couldn't post (it resolves null, like the App's addComment) is a failure too, and the edit survives reopening", async () => {
    const onNudge = vi.fn(async () => null);
    pulse({ onNudge });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Nudge Sana" }));
    fireEvent.change(within(screen.getByRole("dialog", { name: "Nudge Sana" })).getByRole("textbox"), { target: { value: "@Sana — tokens today?" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't send the nudge");
    expect(screen.queryByText("Nudged Sana")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Nudge Sana" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Nudge Sana" }));
    expect(within(screen.getByRole("dialog", { name: "Nudge Sana" })).getByRole("textbox")).toHaveValue("@Sana — tokens today?");
  });

  it("Set a firm date patches the blocker, says so only while the task shows it, and gives focus back to the button", async () => {
    const tasks = [
      task({ id: "deck", title: "Launch deck", status: "progress", assigneeId: "m-2", dueDate: dayOffset(7) }),
      task({ id: "kit", title: "Press kit review", assigneeId: "m-3", dueDate: dayOffset(2), dependencies: ["deck"] }),
    ];
    const onPatch = vi.fn();
    const { rerender, props } = pulse({ tasks, onPatch });
    await ready();
    const button = screen.getByRole("button", { name: "Set a firm date" });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "Tomorrow" }));
    const date = dayOffset(1);
    expect(onPatch).toHaveBeenCalledWith("deck", { dueDate: date });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Set a firm date" }));
    // the App's optimistic save shows the new date: the line stays…
    const saved = tasks.map((t) => (t.id === "deck" ? { ...t, dueDate: date } : t));
    rerender(<TeamPulse {...props} tasks={saved} />);
    // (the new date clears the risk: focus moves on rather than falling to the page)
    expect(document.activeElement).not.toBe(document.body);
    // …and a save that failed and rolled back takes it away again
    rerender(<TeamPulse {...props} tasks={tasks} />);
    expect(screen.queryByText(/^Due \w{3} \d/)).toBeNull();
  });

  it("Escape out of Set a firm date puts the button back, with focus on it", async () => {
    const tasks = [
      task({ id: "deck", title: "Launch deck", status: "progress", assigneeId: "m-2", dueDate: dayOffset(7) }),
      task({ id: "kit", title: "Press kit review", assigneeId: "m-3", dueDate: dayOffset(2), dependencies: ["deck"] }),
    ];
    const { props } = pulse({ tasks });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Set a firm date" }));
    await screen.findByRole("button", { name: "Tomorrow" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Set a firm date" }));
    expect(props.onPatch).not.toHaveBeenCalled();
  });

  it("an unowned blocker is assigned rather than nudged, and focus moves on when the fix clears the risk", async () => {
    const tasks = [
      task({ id: "tokens", title: "Define design tokens v2", status: "todo", assigneeId: "" }),
      task({ id: "onb", title: "Ship onboarding redesign", status: "blocked", assigneeId: "m-1", dependencies: ["tokens"] }),
      task({ id: "notes", title: "Release notes", assigneeId: "", dueDate: dayOffset(1) }),
    ];
    const onPatch = vi.fn();
    const { rerender, props } = pulse({ tasks, onPatch });
    await ready();
    const radar = screen.getByRole("complementary", { name: "Radar" });
    expect(within(radar).queryByRole("button", { name: /Nudge/ })).toBeNull();
    const assign = within(radar).getAllByRole("button", { name: "Assign" });
    fireEvent.click(assign[1]);   // "Release notes is due tomorrow with no owner"
    fireEvent.click(screen.getByRole("menuitem", { name: /Theo Vance/ }));
    expect(onPatch).toHaveBeenCalledWith("notes", { assigneeId: "m-2" });
    rerender(<TeamPulse {...props} tasks={tasks.map((t) => (t.id === "notes" ? { ...t, assigneeId: "m-2" } : t))} />);
    expect(within(radar).queryByText(/Release notes/)).toBeNull();
    expect(document.activeElement?.tagName).toBe("H3");
  });

  it("Rebalance opens Workload with that person's row ready", async () => {
    const { props } = pulse();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Rebalance" }));
    expect(props.onOpenWorkload).toHaveBeenCalled();
    expect(sessionStorage.getItem("kanbo-workload-focus")).toBe("m-1");
  });

  it("guests see the risks, but only the Open fixes", async () => {
    const { props } = pulse({ readOnly: true });
    await ready();
    const radar = screen.getByRole("complementary", { name: "Radar" });
    expect(within(radar).queryByRole("button", { name: /Nudge|Rebalance|Assign|firm date|Check in/ })).toBeNull();
    fireEvent.click(within(radar).getAllByRole("button", { name: "Open chain" })[0]);
    expect(props.onOpen).toHaveBeenCalledWith("onb");
  });

  it("switching to This week relabels the table, announces the new lede once, and keeps one read of the history", async () => {
    const { props, rerender } = pulse();
    await ready();
    const lede = screen.getByText((_, el) => el?.classList.contains("kpulse-lede") ?? false);
    expect(lede).not.toHaveAttribute("aria-live");
    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    expect(screen.getByRole("columnheader", { name: "Done this week" })).toBeInTheDocument();
    expect(props.loadEvents).toHaveBeenCalledTimes(1);
    const status = screen.getAllByRole("status").find((el) => el.classList.contains("sr-only"))!;
    expect(status).toHaveTextContent(/^This week the team has finished 1 task\./);
    // a realtime change to the tasks re-renders the lede without re-announcing it
    rerender(<TeamPulse {...props} tasks={[...demoTasks(), task({ title: "New in flight", status: "progress", assigneeId: "m-2" })]} />);
    expect(status).toHaveTextContent(/^This week the team has finished 1 task\. 3 are in flight/);
  });

  it("a guest's row says Guest once, with where they're from, and carries no load", async () => {
    pulse({ members: [...MEMBERS, { ...member("m-4", "guest"), email: "idris@partner.io" }], tasks: [...demoTasks(), task({ title: "Brand review", status: "progress", assigneeId: "m-4" })] });
    await ready();
    const idris = screen.getByRole("row", { name: /Idris Bell/ });
    expect(idris).toHaveTextContent("partner.io");
    expect(idris.textContent?.match(/Guest/g)).toHaveLength(1);
    expect(within(idris).queryByRole("progressbar")).toBeNull();
    // everyone else's load reads as words, not a percentage of 125% of capacity
    expect(screen.getByRole("row", { name: /Maya Lin/ })).toHaveTextContent("42 of 40 hours this week, over capacity");
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
  });

  it("your own quiet work still has a fix: you can't check in with yourself, so it opens", async () => {
    const mine = task({ id: "mine", title: "My old draft", status: "progress", assigneeId: "m-self", createdAt: new Date(Date.now() - 20 * 86400000).toISOString() });
    const { props } = pulse({ tasks: [mine] });
    await ready();
    const radar = screen.getByRole("complementary", { name: "Radar" });
    expect(within(radar).getByText("My old draft hasn't moved in 20 days")).toBeInTheDocument();
    expect(within(radar).queryByRole("button", { name: "Check in" })).toBeNull();
    fireEvent.click(within(radar).getByRole("button", { name: "Open task" }));
    expect(props.onOpen).toHaveBeenCalledWith("mine");
  });

  it("an empty team gets an empty state with the way to invite people", async () => {
    const onOpenPeople = vi.fn();
    pulse({ members: [], tasks: [], onOpenPeople });
    await ready();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Nobody here yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Invite people" }));
    expect(onOpenPeople).toHaveBeenCalled();
  });

  it("in Personal, explains that Pulse is for teams", () => {
    const onNewWorkspace = vi.fn();
    const { props } = pulse({ personal: true, members: [], onNewWorkspace });
    expect(screen.getByText("Pulse is for teams")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    expect(onNewWorkspace).toHaveBeenCalled();
    expect(props.loadEvents).not.toHaveBeenCalled();
  });

  it("with no member rows yet (the demo), the people doing the work fill the table", async () => {
    pulse({ members: [] });
    await ready();
    expect(screen.getByRole("row", { name: /Maya Lin/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Sana Rao/ })).toBeInTheDocument();
  });
});

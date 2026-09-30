import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
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

  it("says so when the history can't load, and carries on from task dates", async () => {
    pulse({ loadEvents: vi.fn(async () => { throw new Error("offline"); }) });
    await ready();
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't load today's changes — showing what Kanbo knows from task dates.");
    expect(screen.getByRole("row", { name: /Theo Vance/ })).toHaveTextContent("Audit landing-page performance");
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
    expect(within(sheet).getByText(/How I got here · from \d+ tasks and 0 changes since/)).toBeInTheDocument();
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

  it("switching to This week relabels the table and keeps one read of the history", async () => {
    const { props } = pulse();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    expect(screen.getByRole("columnheader", { name: "Done this week" })).toBeInTheDocument();
    expect(props.loadEvents).toHaveBeenCalledTimes(1);
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

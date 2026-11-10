/* Meetings (0056) in the demo: Run meeting (or Join when one's live), the start sheet (what Kanbo found, the
   kind, who's coming, where the notes go and who reads them there), the room (the presenter's keys move everyone;
   a viewer follows, steps away and comes back; notes, decisions and actions; an action's Make task in one click
   with Undo, a decision's follow-up through Extract tasks; last meeting's loose actions made into tasks or
   carried over; leaving says it's still live; End and the recap, a leadership meeting's notes never saved into a
   doc by themselves), an ended meeting's recap with each action's state now, and where the buttons show (never
   for a guest; the other kind of meeting beside Run meeting; nothing left live over 12 hours). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToastProvider } from "../Toast";
import { PROJECTS, TASKS, WORKSPACES, MEMBERS as PEOPLE, dayOffset } from "../../data/data";
import type { Task, WorkspaceEvent, WorkspaceMember } from "../../data/types";
import { getMeeting, listItems, memAct, resetMeetings, startMeeting } from "../../lib/meetings/sync";
import { DEMO_TEAM_MEETING } from "../../lib/meetings/demo";
import type { AgendaItem } from "../../lib/meetings/types";
import { RunMeetingButton } from "./RunMeetingButton";
import { StartMeetingSheet } from "./StartMeetingSheet";
import { MeetingRoom } from "./MeetingRoom";
import { resetMeetingBus, useMeetingRequest, type MeetingScope } from "./meetingBus";
import type { MeetingData } from "./MeetingsHost";
import { TeamPulse } from "../views/TeamPulse";

const WS = "ws-foundrise";
const member = (userId: string, role: WorkspaceMember["role"], workspaceId = WS): WorkspaceMember =>
  ({ id: `${workspaceId}-${userId}`, workspaceId, userId, email: `${userId}@kanbo.app`, name: PEOPLE.find((p) => p.id === userId)?.name ?? userId, role, status: "active" });
const MEMBERS = [member("m-self", "owner"), member("m-1", "member"), member("m-2", "member"), member("m-3", "member"), member("m-4", "guest"),
  member("m-2", "owner", "ws-courtside"), member("m-self", "admin", "ws-courtside")];
const live = TASKS.filter((t) => !t.archivedAt).map((t) => ({ ...t, workspaceId: PROJECTS.find((p) => p.id === t.projectId)?.workspaceId ?? null })) as Task[];
const data = (me = "m-self"): MeetingData => ({ me, workspaces: WORKSPACES, members: MEMBERS, tasks: live, projects: PROJECTS, goals: [], statusUpdates: [] });
const AGENDA: AgendaItem[] = [
  { key: "overview", kind: "overview", title: "Where things stand", lede: [{ text: "Kanbo's read." }] },
  { key: "person:m-1", kind: "person", title: "Maya Lin", personId: "m-1", done: [], today: [{ taskId: "t-6", title: "Migrate auth to edge sessions", status: "progress" }], blocked: [], more: { done: 0, today: 0, blocked: 0 } },
  { key: "risks", kind: "risks", title: "Radar risks", risks: [{ id: "r1", title: "Maya is over capacity", reason: "45h / 32h this week", severity: "signal", taskIds: [] }] },
  { key: "wrap", kind: "wrap", title: "Wrap up" },
];
const startOne = async (presenter = "m-self", o: { preset?: "team" | "leadership" } = {}) => {
  const r = await startMeeting({ workspaceId: WS, workspaceIds: [WS], preset: o.preset ?? "team", title: "Foundrise team meeting", agenda: AGENDA,
    attendees: ["m-self", "m-1", "m-2"], docProjectId: "p-launch", previousId: null, me: presenter });
  if (!r.ok) throw new Error(r.message);
  return r.data;
};
function Request() { const r = useMeetingRequest(); return <output data-testid="req">{r ? JSON.stringify(r) : ""}</output>; }
const room = (id: string, me = "m-self", extra: Partial<Parameters<typeof MeetingRoom>[0]> = {}) => {
  const createTasks = vi.fn((rows: unknown[]): string[] => rows.map(() => "t-new"));
  const deleteTask = vi.fn();
  const props = { meetingId: id, data: data(me), onClose: vi.fn(), onOpenTask: vi.fn(), onOpenDoc: vi.fn(), createTasks, deleteTask, ...extra };
  return { ...render(<ToastProvider><MeetingRoom {...props} /></ToastProvider>), props: { ...props, createTasks, deleteTask } };
};
const people = (dialog: HTMLElement) => dialog.querySelector<HTMLElement>(".kmtg-people")!;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 200)); });

beforeEach(() => { resetMeetings(); resetMeetingBus(); localStorage.clear(); });
afterEach(() => { cleanup(); resetMeetings(); resetMeetingBus(); });

describe("Run meeting", () => {
  it("asks for the start sheet with its scope; Join opens one that's already live", async () => {
    const scope: MeetingScope = { workspaceId: WS, preset: "team", canLead: true };
    render(<><RunMeetingButton scope={scope} /><Request /></>);
    fireEvent.click(screen.getByRole("button", { name: "Run meeting" }));
    expect(JSON.parse(screen.getByTestId("req").textContent!)).toEqual({ kind: "start", scope });
    cleanup(); resetMeetingBus();
    const m = await startOne();
    render(<><RunMeetingButton scope={scope} /><Request /></>);
    const join = await screen.findByRole("button", { name: "Join Foundrise team meeting, live now" });
    fireEvent.click(join);
    expect(JSON.parse(screen.getByTestId("req").textContent!)).toEqual({ kind: "open", id: m.id });
  });
  it("a live meeting of the other kind sits beside Run meeting, never in its way", async () => {
    const scope: MeetingScope = { workspaceId: WS, preset: "team", canLead: true };
    await startOne("m-self", { preset: "leadership" });
    render(<RunMeetingButton scope={scope} />);
    expect(await screen.findByRole("button", { name: /^Join Foundrise team meeting, live now/ })).toHaveTextContent("Leadership · Live");
    expect(screen.getByRole("button", { name: "Run meeting" })).toBeInTheDocument();
  });
  it("never offers to join a meeting left live over 12 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 10, 9, 18));
      await startOne();
      vi.setSystemTime(new Date(2026, 10, 10, 9));
      render(<RunMeetingButton scope={{ workspaceId: WS, preset: "team", canLead: true }} />);
      await settle();
      expect(screen.getByRole("button", { name: "Run meeting" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /live now/ })).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("Pulse offers it to the team, never to a guest", () => {
    const props = { tasks: live.filter((t) => t.workspaceId === WS), members: MEMBERS.filter((m) => m.workspaceId === WS), currentUserId: "m-self", workspaceName: "Foundrise",
      workspaceId: WS, loadEvents: async (): Promise<WorkspaceEvent[]> => [], onOpen: vi.fn(), onNudge: vi.fn(async () => {}), onPatch: vi.fn(), onOpenWorkload: vi.fn(),
      kudos: [], meeting: { workspaceId: WS, preset: "team" as const, canLead: true } };
    const { unmount } = render(<TeamPulse {...props} readOnly={false} />);
    expect(screen.getByRole("button", { name: "Run meeting" })).toBeInTheDocument();
    unmount();
    render(<TeamPulse {...props} readOnly />);
    expect(screen.queryByRole("button", { name: "Run meeting" })).toBeNull();
  });
});

describe("the start sheet", () => {
  const sheet = (scope: Partial<MeetingScope> = {}) => {
    const props = { scope: { workspaceId: WS, preset: "team" as const, canLead: true, ...scope }, data: data(), loadEvents: vi.fn(async (): Promise<WorkspaceEvent[]> => []),
      onClose: vi.fn(), onStarted: vi.fn(), onCreateProject: vi.fn() };
    return { ...render(<StartMeetingSheet {...props} />), props };
  };
  it("shows what Kanbo found and how it would open; starts the team meeting with last week's actions on it", async () => {
    const { props } = sheet();
    const dialog = screen.getByRole("dialog", { name: "Run a meeting" });
    await waitFor(() => expect(within(dialog).getByText(/^5 from /)).toBeInTheDocument());   // last meeting's 5 actions
    expect(within(dialog).getByRole("checkbox", { name: /Each person/ })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /Projects to look at/ })).not.toBeChecked();
    expect(within(dialog).getByText(/^4 people/)).toBeInTheDocument();   // never the guest
    expect(within(dialog).getByText("Kanbo opens with")).toBeInTheDocument();
    expect((within(dialog).getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toMatch(/^Foundrise team meeting, /);
    // who's coming: the team (you can't leave yourself out)
    expect(within(people(dialog)).getAllByRole("button", { pressed: true })).toHaveLength(4);
    for (const name of ["You", "Maya", "Sana", "Theo"]) expect(within(people(dialog)).getByRole("button", { name, pressed: true })).toBeInTheDocument();
    fireEvent.click(within(people(dialog)).getByRole("button", { name: "Theo" }));
    expect(within(people(dialog)).getByRole("button", { name: "Theo" })).toHaveAttribute("aria-pressed", "false");
    // the notes stay in the recap unless a project's chosen, and then it says who reads docs there
    const notesGo = within(dialog).getByRole("combobox", { name: "Notes go" });
    expect(notesGo).toHaveValue("");
    expect(within(dialog).getByText("Only the people this meeting is for can read the recap.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "New Meetings project" })).toBeInTheDocument();
    fireEvent.change(notesGo, { target: { value: "p-launch" } });
    expect(within(dialog).getByText("Everyone at Foundrise, guests too, can read docs in its projects.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start meeting" }));
    await waitFor(() => expect(props.onStarted).toHaveBeenCalled());
    const m = props.onStarted.mock.calls[0][0];
    expect(m).toMatchObject({ preset: "team", previousId: DEMO_TEAM_MEETING, presenterId: "m-self", docProjectId: "p-launch" });
    expect(m.agenda[0].kind).toBe("overview");
    expect(m.agenda[m.agenda.length - 1].kind).toBe("wrap");
    expect(m.agenda.filter((a: AgendaItem) => a.kind === "person").map((a: AgendaItem & { personId: string }) => a.personId).sort()).toEqual(["m-1", "m-2", "m-3", "m-self"]);
    expect(m.agenda.some((a: AgendaItem) => a.kind === "actions")).toBe(true);
  });
  it("a leadership meeting is for owners and admins; its notes stay in the recap unless someone chooses a doc, and says who'd read it", async () => {
    const { props } = sheet({ preset: "leadership" });
    const dialog = screen.getByRole("dialog", { name: "Run a meeting" });
    expect(within(dialog).getByRole("button", { name: "Leadership meeting" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(within(dialog).getByText("No meeting here yet")).toBeInTheDocument());
    expect(within(people(dialog)).getAllByRole("button")).toHaveLength(1);
    expect(within(people(dialog)).getByRole("button", { name: "You" })).toBeDisabled();
    expect(within(dialog).getByText(/Guests never see them/)).toBeInTheDocument();
    const notesGo = within(dialog).getByRole("combobox", { name: "Notes go" });
    expect(notesGo).toHaveValue("");
    // (no "Leadership" project is offered: everyone at the business would read it)
    expect(within(dialog).queryByRole("button", { name: /New .* project/ })).toBeNull();
    fireEvent.change(notesGo, { target: { value: "p-launch" } });
    expect(within(dialog).getByText("Saved there only when you choose, at the end. Everyone at Foundrise, guests too, can read docs in its projects.")).toBeInTheDocument();
    expect(props.onCreateProject).not.toHaveBeenCalled();
  });
  it("a Group meeting is leadership only, and never goes round one business's people", async () => {
    sheet({ preset: "leadership", workspaceIds: [WS, "ws-courtside"] });
    const dialog = screen.getByRole("dialog", { name: "Run a meeting" });
    expect(within(dialog).queryByRole("button", { name: "Team meeting" })).toBeNull();
    expect(within(dialog).getByRole("checkbox", { name: /Each person/ })).toBeDisabled();
    expect((within(dialog).getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toMatch(/^Group leadership, /);
    await waitFor(() => expect(within(dialog).getByText(/Foundrise, Courtside Padel/)).toBeInTheDocument());
  });
});

describe("the room", () => {
  it("the presenter's keys move the agenda for everyone; Esc leaves without ending it, and says it's still live", async () => {
    const m = await startOne();
    const { props } = room(m.id);
    await screen.findByRole("heading", { name: "Foundrise team meeting" });
    expect(screen.getByText("Kanbo's read.")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "Maya Lin" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByRole("heading", { name: "Radar risks" })).toBeInTheDocument();
    await settle();
    expect((await getMeeting(m.id))?.place).toBe(2);     // one write once the keys settle
    fireEvent.keyDown(window, { key: "Home" });
    await settle();
    expect((await getMeeting(m.id))?.placeKey).toBe("overview");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
    expect((await getMeeting(m.id))?.status).toBe("live");
    expect(await screen.findByText("The meeting is still live, and you're presenting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });
  it("Esc in an empty note goes back to the stage; only the next Esc leaves", async () => {
    const m = await startOne();
    const { props } = room(m.id);
    await screen.findByRole("heading", { name: "Foundrise team meeting" });
    const notes = screen.getByRole("complementary", { name: "Notes" });
    const composer = within(notes).getByRole("textbox");
    composer.focus();
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("main"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });
  it("on a phone, Previous, Next and Notes still have names, and the presenter can hand over", async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({ ...real(q), matches: q.includes("759px") })) as typeof window.matchMedia;
    try {
      const m = await startOne();
      room(m.id);
      await screen.findByRole("heading", { name: "Foundrise team meeting" });
      expect(screen.getByRole("button", { name: "Previous" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Notes" })).toBeInTheDocument();
      // the demo's teammates join a moment later: then Hand over shows
      expect(await screen.findByRole("button", { name: "Hand over" }, { timeout: 4000 })).toBeInTheDocument();
    } finally { window.matchMedia = real; }
  });
  it("watching, you follow the presenter; step away and come back to their place", async () => {
    const m = await startOne("m-1");
    room(m.id);
    await screen.findByText(/Maya is presenting/);
    expect(screen.getByRole("button", { name: "Present" })).toBeInTheDocument();
    act(() => { memAct(m.id, "m-1", { place: 2 }); });
    expect(await screen.findByRole("heading", { name: "Radar risks" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "Maya Lin" })).toBeInTheDocument();
    const back = screen.getByRole("button", { name: /Back to Maya's place · 3 of 4/ });
    act(() => { memAct(m.id, "m-1", { place: 3 }); });
    await settle();
    expect(screen.getByRole("heading", { name: "Maya Lin" })).toBeInTheDocument();   // looking round on your own
    fireEvent.click(back);
    expect(screen.getByRole("heading", { name: "Wrap up" })).toBeInTheDocument();
    // Present: you take over from where you are, and everyone comes to you
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "Radar risks" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    await waitFor(async () => expect(await getMeeting(m.id)).toMatchObject({ presenterId: "m-self", place: 2, placeKey: "risks" }));
    expect(screen.getByRole("heading", { name: "Radar risks" })).toBeInTheDocument();
  });
  it("logs a decision and an action with an owner on this item; an action's Make task is one click (with Undo), a decision's follow-up goes through Extract tasks", async () => {
    const m = await startOne();
    const { props } = room(m.id);
    await screen.findByRole("heading", { name: "Foundrise team meeting" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    const notes = screen.getByRole("complementary", { name: "Notes" });
    fireEvent.click(within(notes).getByRole("radio", { name: "Decision" }));
    fireEvent.change(within(notes).getByRole("textbox", { name: "Decision on Maya Lin" }), { target: { value: "Edge sessions ship Friday" } });
    fireEvent.click(within(notes).getByRole("button", { name: "Add decision" }));
    await within(notes).findByText("Edge sessions ship Friday");
    fireEvent.click(within(notes).getByRole("radio", { name: "Action" }));
    fireEvent.change(within(notes).getByRole("textbox", { name: "Action on Maya Lin" }), { target: { value: "Book the load test" } });
    fireEvent.change(within(notes).getByRole("combobox", { name: "Owner" }), { target: { value: "m-2" } });
    fireEvent.click(within(notes).getByRole("button", { name: "Add action" }));
    await within(notes).findByText("Book the load test");
    expect(within(notes).getByText("Theo")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Agenda" })).toHaveTextContent(/Maya Lin\s*2/);
    // the action becomes a task in one click: its owner, in the notes project, linked; Undo takes it back
    const line = within(notes).getByText("Book the load test").closest("li")!;
    expect(within(line as HTMLElement).queryByRole("button", { name: "Follow-up task" })).toBeNull();
    fireEvent.click(within(line as HTMLElement).getByRole("button", { name: "Make task" }));
    expect(props.createTasks).toHaveBeenCalledWith([{ title: "Book the load test", projectId: "p-launch", assigneeId: "m-2" }]);
    expect(screen.queryByRole("dialog", { name: /tasks/i })).toBeNull();
    await waitFor(async () => expect((await listItems(m.id)).find((i) => i.kind === "action")?.taskId).toBe("t-new"));
    expect(await screen.findByText("Task made for Theo in Q3 Product Launch")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(props.deleteTask).toHaveBeenCalledWith("t-new");
    await waitFor(async () => expect((await listItems(m.id)).find((i) => i.kind === "action")?.taskId).toBeNull());
    // a decision's follow-up: Extract tasks reads the line
    const decision = within(notes).getByText("Edge sessions ship Friday").closest("li")!;
    fireEvent.click(within(decision as HTMLElement).getByRole("button", { name: "Follow-up task" }));
    const extract = await screen.findByRole("dialog", { name: /tasks/i });
    expect(within(extract).getByRole("textbox")).toHaveValue("Actions\n- Edge sessions ship Friday");
    await act(async () => {
      const go = within(extract).getAllByRole("button").find((b) => /^Find|^Read|^Next|^Review/.test(b.textContent ?? ""));
      fireEvent.click(go!);
      await new Promise((r) => setTimeout(r, 50));
    });
    fireEvent.click(await within(extract).findByRole("button", { name: /^Create 1 task/ }));
    expect(props.createTasks).toHaveBeenLastCalledWith([expect.objectContaining({ title: expect.stringMatching(/^Edge sessions ship/i) })]);
    await waitFor(async () => expect((await listItems(m.id)).filter((i) => i.kind === "action" && i.taskId === "t-new")).toHaveLength(1));
  });
  it("last meeting's actions that never became tasks: Make task or Carry over, right there", async () => {
    const r = await startMeeting({ workspaceId: WS, workspaceIds: [WS], preset: "team", title: "Foundrise team meeting", previousId: DEMO_TEAM_MEETING, me: "m-self",
      attendees: ["m-1"], docProjectId: "p-launch", agenda: [AGENDA[0], { key: "actions", kind: "actions", title: "Last meeting's actions",
        from: { id: DEMO_TEAM_MEETING, title: "Last week", endedAt: null }, actions: [
          { itemId: "mi-demo-8", body: "Chase legal on the pricing page copy", ownerId: "m-3", taskId: null, due: dayOffset(-2) },
          { itemId: "mi-x", body: "Print the launch one-pager", ownerId: "m-1", taskId: null, due: null },
        ] }, AGENDA[3]] });
    if (!r.ok) throw new Error(r.message);
    const { props } = room(r.data.id);
    await screen.findByRole("heading", { name: "Foundrise team meeting" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "Last meeting's actions" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Carry over: Print the launch one-pager" }));
    await waitFor(async () => expect((await listItems(r.data.id)).map((i) => [i.body, i.ownerId, i.agendaKey, i.taskId]))
      .toEqual([["Print the launch one-pager", "m-1", "actions", null]]));
    expect(await screen.findByText("Carried over")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Make a task: Chase legal on the pricing page copy" }));
    expect(props.createTasks).toHaveBeenCalledWith([{ title: "Chase legal on the pricing page copy", projectId: "p-launch", assigneeId: "m-3" }]);
    await waitFor(async () => expect((await listItems(r.data.id)).find((i) => i.body.startsWith("Chase legal"))?.taskId).toBe("t-new"));
    expect(screen.queryByRole("button", { name: /Carry over: Chase legal/ })).toBeNull();
  });
  it("the wrap-up ends it: the recap goes to everyone asked, and the room becomes the recap", async () => {
    const m = await startOne();
    room(m.id);
    await screen.findByRole("heading", { name: "Foundrise team meeting" });
    fireEvent.click(screen.getByRole("button", { name: "End meeting" }));
    expect(screen.getByRole("heading", { name: "Wrap up" })).toBeInTheDocument();
    expect(screen.getByText(/The recap goes to Maya and Theo's Inboxes, and the notes into a doc in Q3 Product Launch\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "End and send recap" }));
    expect(await screen.findByText("Recap", { selector: ".kmtg-eyebrow" })).toBeInTheDocument();
    const ended = await getMeeting(m.id);
    expect(ended).toMatchObject({ status: "ended", endedBy: "m-self", docProjectId: "p-launch" });
    expect(ended?.docId).toBeTruthy();   // the notes doc was saved
    expect(screen.getByRole("button", { name: "Open notes doc" })).toBeInTheDocument();
  });
  it("a leadership meeting's notes never go into a project doc by themselves: only Save notes, which says who'd read it", async () => {
    const m = await startOne("m-self", { preset: "leadership" });
    room(m.id);
    await screen.findByRole("heading", { name: "Foundrise team meeting" });
    fireEvent.click(screen.getByRole("button", { name: "End meeting" }));
    expect(screen.getByText("Everyone at Foundrise, guests too, can read docs in Q3 Product Launch.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save notes to Q3 Product Launch" })).toBeInTheDocument();
    expect(screen.getByText(/^The recap goes to /)).not.toHaveTextContent(/doc/);
    fireEvent.click(screen.getByRole("button", { name: /^End/ }));
    expect(await screen.findByText("Recap", { selector: ".kmtg-eyebrow" })).toBeInTheDocument();
    expect((await getMeeting(m.id))?.docId).toBeNull();
  });
  it("an ended meeting opens as its recap: each action and where it stands now", async () => {
    room(DEMO_TEAM_MEETING);
    expect(await screen.findByText(/run by Maya Lin/)).toBeInTheDocument();
    const actions = screen.getByRole("heading", { name: /^Actions/ }).closest("section")!;
    const rows = within(actions as HTMLElement).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows.find((r) => r?.startsWith("ActionRecord the product demo video"))).toMatch(/Done/);
    expect(rows.find((r) => r?.startsWith("ActionShip onboarding"))).toMatch(/Blocked/);
    expect(rows.find((r) => r?.startsWith("ActionChase legal"))).toMatch(/Make task/);
    expect(screen.queryByRole("button", { name: "End meeting" })).toBeNull();
    expect(dayOffset(0)).toBeTruthy();
  });
});

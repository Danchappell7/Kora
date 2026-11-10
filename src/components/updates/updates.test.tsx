/* The project-update pieces (0053): Today's update line and the hook behind it, the merged status pill,
   Ask for an update, Settings › Workspace › Project updates, and a project's update day in About. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, within, renderHook, act, waitFor } from "@testing-library/react";
import type { Project, StatusUpdate, Task, UpdateAsk, Workspace } from "../../data/types";
import { refreshClock, setReferenceData, WORKSPACES } from "../../data/data";
import { mergedStatus } from "../../lib/honestStatus";
import { noteRhythmSchema, resetRhythmSchema } from "../../lib/updateRhythm";
import { resetUpdateAsks, type AskForUpdate } from "../../lib/updateAsks";
import type { DueUpdate } from "../../lib/updateDue";
import { UpdateLine, useTodayUpdates } from "./TodayUpdates";
import { UpdateSheet } from "./UpdateSheet";
import { clearStatusDrafts } from "../project/StatusComposer";
import { MergedStatusPill } from "./MergedStatusPill";
import { AskForUpdateButton } from "./AskForUpdate";
import { UpdateRhythmPanel } from "./UpdateRhythmPanel";
import { UpdateDayField, UpdatePlanNote } from "./UpdateDay";

// (each wears its emoji tile in the line: the line's text reads "🚀Q3 launch")
const proj = (id: string, o: Partial<Project> = {}): Project => ({ id, name: id === "p1" ? "Q3 launch" : id, emoji: "🚀", color: "", workspaceId: "w", ownerId: "me", ...o });
const task = (id: string, projectId: string, o: Partial<Task> = {}): Task => ({
  id, title: id, description: "", status: "todo", priority: "medium", projectId, assigneeId: "me", tags: [], dependencies: [], subtasks: [],
  focusMin: 30, comments: 0, aiScore: 0, createdAt: "2026-09-01T09:00:00", ...o,
});
const due = (o: Partial<DueUpdate> = {}): DueUpdate => ({ project: proj("p1"), reason: "due", state: { kind: "due", due: "2026-11-13", followUp: 0, lapsed: false }, changes: 7, ...o });
const WS: Workspace[] = [{ id: null, name: "Personal", kind: "personal" }, { id: "w", name: "Foundry", kind: "team" }];
let savedWs: Workspace[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 13, 10));       // Friday 13 Nov 2026, 10:00
  refreshClock();
  savedWs = WORKSPACES;
  setReferenceData({ workspaces: WS });
});
afterEach(() => {
  setReferenceData({ workspaces: savedWs });
  vi.useRealTimers();
  refreshClock();
  resetRhythmSchema();
  resetUpdateAsks();
});

describe("Today's update line", () => {
  it("one due: says it's due today and what Kanbo drafted it from; the project and the button open it", () => {
    const onOpen = vi.fn();
    render(<UpdateLine items={[due()]} onOpen={onOpen} />);
    const line = screen.getByRole("note", { name: "Your project updates" });
    expect(line).toHaveTextContent("Your update on 🚀Q3 launch is due today. Kanbo has drafted it from this week's 7 changes.");
    fireEvent.click(within(line).getByRole("button", { name: "Review and post" }));
    fireEvent.click(within(line).getByTitle("Open the update on Q3 launch"));
    expect(onOpen.mock.calls).toEqual([["p1"], ["p1"]]);
  });
  it("a follow-up day says when it was due; an ask names who asked; several are listed", () => {
    const { rerender } = render(<UpdateLine items={[due({ state: { kind: "due", due: "2026-11-12", followUp: 1, lapsed: false }, changes: 0 })]} onOpen={vi.fn()} />);
    expect(screen.getByRole("note")).toHaveTextContent("Your update on 🚀Q3 launch was due yesterday. Kanbo has a draft ready.");
    const ask: UpdateAsk = { id: "a", projectId: "p2", workspaceId: "w", askedBy: "m-2", ownerId: "me", createdAt: "2026-11-13T08:00:00Z" };
    rerender(<UpdateLine items={[due({ project: proj("p2", { name: "Winter League" }), reason: "asked", state: null, ask })]} onOpen={vi.fn()} />);
    expect(screen.getByRole("note")).toHaveTextContent("Theo asked for an update on 🚀Winter League. Kanbo has drafted it from this week's 7 changes.");
    rerender(<UpdateLine items={[due(), due({ project: proj("p2", { name: "Winter League" }), reason: "asked", state: null, ask })]} onOpen={vi.fn()} />);
    expect(screen.getByRole("note")).toHaveTextContent("Your updates on 🚀Q3 launch and 🚀Winter League are waiting. Theo asked for the one on Winter League. Kanbo has drafts ready.");
    expect(screen.getByRole("button", { name: "Start with Q3 launch" })).toBeInTheDocument();
  });
  it("the hook: only the owner's due update, nothing for a guest or without a way to post, and the sheet opens on it", async () => {
    const projects = [proj("p1"), proj("p2", { ownerId: "sana" })];
    const tasks = [task("t1", "p1"), task("t2", "p2")];
    const statusUpdates: StatusUpdate[] = [];
    type Props = { readOnly?: boolean; onPost?: () => Promise<boolean> };
    const first: Props = { onPost: vi.fn(async () => true) };
    const { result, rerender } = renderHook((p: Props) =>
      useTodayUpdates({ me: "me", projects, tasks, statusUpdates, onPost: p.onPost, readOnly: p.readOnly }), { initialProps: first });
    expect(result.current.items.map((d) => d.project.id)).toEqual(["p1"]);
    expect(result.current.noticed[0]).toMatchObject({ title: "Your Q3 launch update is due today", actions: [{ kind: "update", projectId: "p1" }] });
    expect(result.current.sheet).toBeNull();
    act(() => result.current.open("p1"));
    expect(result.current.sheet).not.toBeNull();
    rerender({ onPost: vi.fn(async () => true), readOnly: true });
    expect(result.current.items).toEqual([]);
    expect(result.current.line).toBeNull();
    rerender({ onPost: undefined });
    expect(result.current.noticed).toEqual([]);
  });
});

describe("the update sheet Today opens", () => {
  it("opens on Kanbo's draft; when its AI simply isn't there, the on-device one says so calmly (the brief already said Kanbo drafted it)", async () => {
    clearStatusDrafts();
    const aiStatus = vi.fn(async () => ({ data: null, source: "unavailable" as const }));
    render(<UpdateSheet project={proj("p1")} tasks={[task("t1", "p1")]} statusUpdates={[]} onPost={vi.fn(async () => true)} aiStatus={aiStatus} open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Update" })).not.toHaveValue(""));
    expect(aiStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^Drafted on this device from this week's/)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't draft/)).toBeNull();
    // asking for a redraft by hand still says when it couldn't
    fireEvent.click(screen.getByRole("button", { name: "Redraft" }));
    await waitFor(() => expect(screen.getByText(/couldn't draft this one just now/)).toBeInTheDocument());
  });
  it("an Ask written there can name who it's for, so it reaches their Needs your reply", async () => {
    clearStatusDrafts();
    const onPost = vi.fn(async () => true);
    render(<UpdateSheet project={proj("p1")} tasks={[task("t1", "p1")]} statusUpdates={[]} onPost={onPost} open onClose={vi.fn()}
      people={[{ id: "sana", name: "Sana Rao" }, { id: "theo", name: "Theo Vance" }]} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Update" })).not.toHaveValue(""));
    fireEvent.click(screen.getByRole("button", { name: /Highlights, risks, asks and next/ }));
    fireEvent.change(screen.getByPlaceholderText("What you need, and from whom"), { target: { value: "Sana, sign off the hero copy by Thursday?" } });
    const who = screen.getByRole("group", { name: "Who the asks are for" });
    fireEvent.click(within(who).getByRole("button", { name: "Sana" }));
    expect(within(who).getByRole("button", { name: "Sana" })).toHaveAttribute("aria-pressed", "true");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Post update/ })); });
    expect(onPost).toHaveBeenCalledWith("p1", expect.any(String), expect.any(String), expect.objectContaining({ askUserIds: ["sana"] }));
  });
});

describe("one merged pill", () => {
  it("names both calls to a screen reader, on hover and on focus, and marks a rosier call", () => {
    const m = mergedStatus({}, { status: "on_track" }, { health: "off_track", overdue: 4, blocked: 2 });
    render(<MergedStatusPill m={m} extra="Latest update (Fri 13 Nov, Maya Lin): All good" />);
    const pill = screen.getByRole("img", { name: /^On track\. Lead says On track · Kanbo sees 4 overdue and 2 blocked/ });
    expect(pill).toHaveAttribute("tabindex", "0");
    expect(pill).toHaveAttribute("data-tip", "Lead says On track · Kanbo sees 4 overdue and 2 blocked · Latest update (Fri 13 Nov, Maya Lin): All good");
    expect(pill).toHaveAttribute("data-mismatch", "true");
    expect(pill.querySelector(".kup-pair-mark")).toHaveAttribute("data-tone", "signal");
  });
  it("agreeing calls carry no mark", () => {
    render(<MergedStatusPill m={mergedStatus({}, { status: "at_risk" }, { health: "at_risk", overdue: 1, blocked: 0 })} />);
    expect(screen.getByRole("img").querySelector(".kup-pair-mark")).toBeNull();
  });
});

describe("Ask for an update", () => {
  const p = proj("p1", { ownerId: "m-2", name: "Clubhouse" });
  const asks = (o: Partial<AskForUpdate> = {}): AskForUpdate => ({ canAsk: () => true, asked: () => undefined, ask: vi.fn(async () => ({ id: "a" } as UpdateAsk)), ...o });
  it("isn't offered where you can't ask", () => {
    const { container } = render(<AskForUpdateButton project={p} asks={asks({ canAsk: () => false })} />);
    expect(container).toBeEmptyDOMElement();
    const { container: none } = render(<AskForUpdateButton project={p} />);
    expect(none).toBeEmptyDOMElement();
  });
  it("asks the owner by name, once", async () => {
    const a = asks();
    render(<AskForUpdateButton project={p} asks={a} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Theo for an update on Clubhouse" }));
    await waitFor(() => expect(a.ask).toHaveBeenCalledWith(p));
  });
  it("reads Asked once someone has", () => {
    render(<AskForUpdateButton project={p} asks={asks({ asked: () => ({ id: "a", projectId: "p1", workspaceId: "w", askedBy: "m-1", ownerId: "m-2", createdAt: "" }) })} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Asked").closest("[title]")).toHaveAttribute("title", "Maya asked Theo for an update");
  });
});

describe("Settings › Workspace › Project updates", () => {
  const ws: Workspace = { id: "w", name: "Foundry", kind: "team" };
  it("weekly on Friday until chosen; picking a cadence or a day saves it", () => {
    const onChange = vi.fn();
    const { rerender } = render(<UpdateRhythmPanel workspace={ws} onChange={onChange} />);
    expect(screen.getByText("Every Friday. Each project's owner finds a drafted update on Today that day.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "How often updates are due" }), { target: { value: "fortnightly" } });
    // fortnightly counts from the next Friday (today)
    expect(onChange).toHaveBeenLastCalledWith("w", { cadence: "fortnightly", weekday: 5, anchor: "2026-11-13" });
    rerender(<UpdateRhythmPanel workspace={{ ...ws, updateRhythm: { cadence: "monthly", weekday: 5 } }} onChange={onChange} />);
    expect(screen.getByRole("option", { name: "Last Thursday" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Day of the week" }), { target: { value: "4" } });
    expect(onChange).toHaveBeenLastCalledWith("w", { cadence: "monthly", weekday: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onChange).toHaveBeenLastCalledWith("w", null);
    rerender(<UpdateRhythmPanel workspace={{ ...ws, updateRhythm: { cadence: "never", weekday: 5 } }} onChange={onChange} />);
    expect(screen.queryByRole("combobox", { name: "Day of the week" })).toBeNull();
  });
  it("before 0053 it says it isn't switched on yet; Personal has none", () => {
    noteRhythmSchema(false);
    const { rerender, container } = render(<UpdateRhythmPanel workspace={ws} onChange={vi.fn()} />);
    expect(screen.getByText("Not switched on yet")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    rerender(<UpdateRhythmPanel workspace={{ id: null, name: "Personal", kind: "personal" }} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("About › Update day", () => {
  const dl = (ui: React.ReactNode) => render(<dl>{ui}</dl>);
  it("whoever runs it follows the team's day or picks its own (Never included), and sees where this round stands", () => {
    const onUpdate = vi.fn();
    const { rerender } = dl(<UpdateDayField project={proj("p1")} tasks={[task("t1", "p1")]} canManage onUpdate={onUpdate} />);
    expect(screen.getByRole("combobox", { name: "Update day" })).toHaveDisplayValue("The team's day: every Friday");
    expect(screen.getByText("Update due today")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Update day" }), { target: { value: "never" } });
    expect(onUpdate).toHaveBeenLastCalledWith("p1", { updateRhythm: { cadence: "never", weekday: 5 } });
    rerender(<dl><UpdateDayField project={proj("p1", { updateRhythm: { cadence: "weekly", weekday: 2 } })} tasks={[task("t1", "p1")]} canManage onUpdate={onUpdate} /></dl>);
    fireEvent.change(screen.getByRole("combobox", { name: "Day of the week" }), { target: { value: "3" } });
    expect(onUpdate).toHaveBeenLastCalledWith("p1", { updateRhythm: { cadence: "weekly", weekday: 3 } });
    fireEvent.change(screen.getByRole("combobox", { name: "Update day" }), { target: { value: "team" } });
    expect(onUpdate).toHaveBeenLastCalledWith("p1", { updateRhythm: null });
  });
  it("everyone else reads it; it says when the update's missing; Personal and before 0053 show nothing", () => {
    const missing = [{ id: "u", projectId: "p1", summary: "", status: "on_track", createdAt: "2026-10-20T10:00:00" }] as StatusUpdate[];
    const { rerender, container } = dl(<UpdateDayField project={proj("p1", { updateRhythm: { cadence: "weekly", weekday: 2 } })} tasks={[task("t1", "p1")]}
      latest={missing[0]} canManage={false} onUpdate={vi.fn()} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Every Tuesday")).toBeInTheDocument();
    expect(screen.getByText("Update missing: one was due Tue 10 Nov")).toHaveClass("kpj-warn");
    rerender(<dl><UpdateDayField project={proj("p1", { workspaceId: null })} tasks={[]} canManage onUpdate={vi.fn()} /></dl>);
    expect(container.querySelector("dt")).toBeNull();
    noteRhythmSchema(false);
    rerender(<dl><UpdateDayField project={proj("p1")} tasks={[task("t1", "p1")]} canManage onUpdate={vi.fn()} /></dl>);
    expect(container.querySelector("dt")).toBeNull();
  });
  it("a plan to recover and a new date read under the update", () => {
    render(<UpdatePlanNote update={{ recoveryPlan: "Maya takes the deck", targetDate: "2026-11-27" }} />);
    expect(screen.getByText(/Maya takes the deck/).closest("p")).toHaveTextContent("Plan to recover: Maya takes the deck");
    expect(screen.getByText("New target date:", { exact: false })).toHaveTextContent("New target date: Fri 27 Nov");
  });
});

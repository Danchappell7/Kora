/* The conversation on a project update (0054): who may edit or delete it, the "edited" mark, its sections and who an
   Ask is for, reactions, "Seen by", replies (yours to edit and delete, a lead's to remove), a guest who reads and
   replies but never edits; and the composer's sections and Asks, filled by Kanbo's draft and posted with the update. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import type { Project, StatusUpdate, Task } from "../../data/types";
import { UpdateCard } from "./UpdateCard";
import { ProjectPanels } from "../project/ProjectHeader";
import { clearStatusDrafts } from "../project/StatusComposer";
import { resetUpdateConversation, type UpdateThread } from "../../lib/updateConversation";
import { resetRhythmSchema } from "../../lib/updateRhythm";

const U: StatusUpdate = {
  id: "su-1", projectId: "p-a", workspaceId: "ws", status: "at_risk", summary: "Hero waits on copy.", createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
  authorId: "m-3", editedAt: new Date(Date.now() - 86400000).toISOString(),
  sections: { highlights: "Palette shipped.", asks: "Daniel, approve the hero by Thursday?" }, askUserIds: ["m-self"],
};
const thread = (o: Partial<UpdateThread> = {}): UpdateThread => ({ comments: [], reactions: {}, seenBy: [], ...o });
const card = (o: Partial<React.ComponentProps<typeof UpdateCard>> = {}) => render(
  <ul><li><UpdateCard update={U} me="m-self" canWrite lead={false} thread={thread()} conversation people={[{ id: "m-1", name: "Maya Lin" }, { id: "m-3", name: "Sana Rao" }]}
    onEdit={vi.fn(async () => true)} onDelete={vi.fn()} {...o} /></li></ul>,
);

beforeEach(() => { resetUpdateConversation(); clearStatusDrafts(); localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); resetRhythmSchema(); });

describe("an update and its conversation", () => {
  it("says who posted it, that it was edited, its sections, and that its Ask is for you", () => {
    card();
    expect(screen.getByText("Sana Rao")).toBeInTheDocument();
    expect(screen.getByText("· edited")).toBeInTheDocument();
    expect(screen.getByText("Highlights")).toBeInTheDocument();
    expect(screen.getByText("Daniel, approve the hero by Thursday?")).toBeInTheDocument();
    expect(screen.getByLabelText("For Daniel Okai")).toHaveTextContent("You");
  });

  it("only its author edits it; a lead deletes any; a member who didn't write it does neither", async () => {
    const onEdit = vi.fn(async () => true);
    const { unmount } = card({ me: "m-3", onEdit });
    fireEvent.click(screen.getByRole("button", { name: "Update actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit update" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Update" }), { target: { value: "Hero copy is in." } });
    fireEvent.click(screen.getByRole("button", { name: "On track" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(onEdit).toHaveBeenCalledWith(U, { summary: "Hero copy is in.", status: "on_track", sections: U.sections });
    unmount();

    const member = card();
    expect(screen.queryByRole("button", { name: "Update actions" })).toBeNull();
    member.unmount();

    const onDelete = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    card({ lead: true, onDelete });
    fireEvent.click(screen.getByRole("button", { name: "Update actions" }));
    expect(screen.queryByRole("menuitem", { name: "Edit update" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete update" }));
    expect(onDelete).toHaveBeenCalledWith(U);
  });

  it("a guest reacts and replies, but never edits or deletes, even their own", () => {
    card({ me: "m-3", canWrite: false });
    expect(screen.queryByRole("button", { name: "Update actions" })).toBeNull();
    expect(screen.getByRole("button", { name: "React" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument();
  });

  it("reactions are toggled as you, and Seen by never counts the author", async () => {
    resetUpdateConversation({ "su-1": { reactions: { "👍": ["m-1"] } } });
    card({ thread: thread({ reactions: { "👍": ["m-1"] }, seenBy: ["m-1", "m-3", "m-self"] }) });
    expect(screen.getByLabelText("Seen by Maya and Daniel")).toHaveTextContent("Seen by 2");
    fireEvent.click(screen.getByRole("button", { name: "React" }));
    await act(async () => { fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "🎉" })); });
    // (the card reads its thread from props: the store has it)
    const { threadOf, useUpdateConversation } = await import("../../lib/updateConversation");
    expect(threadOf((await import("@testing-library/react")).renderHook(() => useUpdateConversation(["su-1"])).result.current.threads, "su-1").reactions["🎉"]).toEqual(["m-self"]);
  });

  it("replies: yours to send (mentions resolved), edit and delete; a lead removes anyone's", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const own = { id: "c1", updateId: "su-1", authorId: "m-self", authorName: "Daniel Okai", body: "On it.", createdAt: new Date().toISOString(), editedAt: null };
    const theirs = { id: "c2", updateId: "su-1", authorId: "m-1", authorName: "Maya Lin", body: "Copy is in the doc.", createdAt: new Date().toISOString(), editedAt: new Date().toISOString() };
    resetUpdateConversation({ "su-1": { comments: [own, theirs] } });
    card({ thread: thread({ comments: [own, theirs] }), lead: false });
    fireEvent.click(screen.getByRole("button", { name: "2 replies" }));
    const replies = within(screen.getByRole("list", { name: "Replies" })).getAllByRole("listitem");
    expect(replies[0]).toHaveTextContent("You");
    expect(within(replies[0]).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(replies[1]).queryByRole("button", { name: /Remove/ })).toBeNull();   // not a lead
    expect(replies[1]).toHaveTextContent("· edited");
    fireEvent.change(screen.getByRole("textbox", { name: "Reply to Sana Rao" }), { target: { value: "@Maya Lin can you check the hero?" } });
    expect(screen.getByText("Sana hears about it.")).toBeInTheDocument();
    const lib = await import("../../lib/updateConversation");
    const add = vi.spyOn(lib, "addUpdateComment");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reply" })); });
    expect(add).toHaveBeenCalledWith("su-1", "@Maya Lin can you check the hero?", ["m-1"], "m-self");
  });

  it("a lead can remove someone else's reply", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const theirs = { id: "c2", updateId: "su-1", authorId: "m-1", authorName: "Maya Lin", body: "Off-topic.", createdAt: new Date().toISOString(), editedAt: null };
    card({ thread: thread({ comments: [theirs] }), lead: true, defaultOpen: true });
    expect(screen.getByRole("button", { name: "Remove Maya Lin's reply" })).toBeInTheDocument();
  });

  it("before 0054 (no conversation): no reactions, seen by or replies", () => {
    card({ conversation: false });
    expect(screen.queryByRole("button", { name: "React" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });
});

describe("the Updates tab, with its conversation", () => {
  const P: Project = { id: "p-a", name: "Alpha", emoji: "🚀", color: "oklch(0.74 0.14 230)", workspaceId: "ws", ownerId: "m-self", contributorIds: ["m-1"] };
  const iso = (d: number) => { const x = new Date(); x.setDate(x.getDate() + d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
  const task = (id: string, o: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, description: "", status: "todo", priority: "medium", projectId: P.id, assigneeId: "m-self",
    tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o });
  const TASKS = [task("t1", { title: "Finalise the deck", status: "progress", dueDate: iso(0) }), task("t3", { title: "Approve budget", status: "done", completedAt: iso(-1) })];
  const props = (o: Partial<React.ComponentProps<typeof ProjectPanels>> = {}): React.ComponentProps<typeof ProjectPanels> => ({
    tab: "updates", project: P, tasks: TASKS, statusUpdates: [{ ...U, projectId: P.id }], members: [{ id: "m-self", name: "Daniel Okai" }, { id: "m-1", name: "Maya Lin" }],
    canManage: true, readOnly: false, onUpdate: vi.fn(), onPostStatus: vi.fn(),
    rules: { rules: [], projects: [P], members: [], sections: [], onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn() },
    forms: { forms: [], projects: [P], members: [], onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onSubmit: vi.fn() },
    conversation: { me: "m-self", lead: false }, ...o,
  });

  it("Kanbo's draft fills the sections; an Ask is for the people you pick, and posts with the update", async () => {
    const onPostStatus = vi.fn(async () => true);
    render(<ProjectPanels {...props({ onPostStatus })} />);
    // the on-device draft wrote Highlights (what finished) and Next
    expect(screen.getByRole("textbox", { name: "Highlights" })).toHaveValue("Done this week: Approve budget.");
    fireEvent.change(screen.getByRole("textbox", { name: "Asks" }), { target: { value: "Maya, can you take the deck review?" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Who the asks are for" })).getByRole("button", { name: "Maya" }));
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Post update" })[0]); });
    expect(onPostStatus).toHaveBeenCalledWith("p-a", expect.stringMatching(/^Finished 1 task this week/), expect.any(String),
      expect.objectContaining({ sections: expect.objectContaining({ highlights: "Done this week: Approve budget.", asks: "Maya, can you take the deck review?" }), askUserIds: ["m-1"] }));
  });

  it("you can take the sections off; an update without them posts without them", async () => {
    const onPostStatus = vi.fn(async () => true);
    render(<ProjectPanels {...props({ onPostStatus })} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove the sections" }));
    expect(screen.queryByRole("textbox", { name: "Highlights" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Post update" })[0]); });
    expect(onPostStatus.mock.calls[0]).toHaveLength(3);
  });

  it("reading the tab counts you as having seen the updates you didn't write; an Inbox item opens its replies", async () => {
    render(<ProjectPanels {...props({ conversation: { me: "m-self", lead: false, focusUpdateId: "su-1" } })} />);
    await waitFor(() => expect(screen.getByText(/^Seen by/)).toHaveTextContent("Seen by 1"));
    expect(screen.getByRole("textbox", { name: "Reply to Sana Rao" })).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import type { Project, StatusKind, StatusUpdate, Task, FormDef } from "../../data/types";
import type { Risk } from "../../lib/radar";
import { getUserProjectTemplates } from "../../lib/templates";
import { ProjectActions, ProjectNotice, ProjectPanels, ProjectTitleAddon } from "./ProjectHeader";

const P: Project = { id: "p-a", name: "Alpha", emoji: "🚀", color: "oklch(0.74 0.14 230)", workspaceId: "ws", ownerId: "m-self", contributorIds: ["m-1"] };
const ago = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
const iso = (d: number) => { const x = new Date(); x.setDate(x.getDate() + d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const task = (id: string, o: Partial<Task> = {}): Task => ({
  id, title: `Task ${id}`, description: "", status: "todo", priority: "medium", projectId: P.id, assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});
const TASKS = [
  task("t1", { title: "Finalise the deck", status: "progress", dueDate: iso(0) }),
  task("t2", { title: "Ship onboarding", status: "blocked", dependencies: ["t1"], dueDate: iso(1) }),
  task("t3", { title: "Approve budget", status: "done", completedAt: iso(-1) }),
];
const UPDATES: StatusUpdate[] = [
  { id: "u1", projectId: P.id, status: "on_track", summary: "Kick-off went well", createdAt: ago(20) },
  { id: "u2", projectId: P.id, status: "at_risk", summary: "Deck is the critical path", createdAt: ago(3) },
];
const actionProps = (o: Partial<React.ComponentProps<typeof ProjectActions>> = {}): React.ComponentProps<typeof ProjectActions> => ({
  project: P, tasks: TASKS, statusUpdates: UPDATES, canManage: true, readOnly: false, onTab: vi.fn(), ...o,
});
const lastPost = () => { const all = screen.getAllByRole("button", { name: "Post update" }); return all[all.length - 1]; };
const box = () => screen.getByPlaceholderText(/What's the latest/) as HTMLTextAreaElement;

beforeEach(() => localStorage.clear());

describe("ProjectActions — posting an update", () => {
  it("posts what you wrote, with the status you chose, and closes", async () => {
    const onPostStatus = vi.fn((_: string, __: string, ___: StatusKind) => Promise.resolve(true));
    render(<ProjectActions {...actionProps({ onPostStatus })} />);
    fireEvent.click(screen.getByRole("button", { name: "Post update" }));
    fireEvent.change(box(), { target: { value: "Logo round two is with the client" } });
    fireEvent.click(screen.getByRole("button", { name: "Off track" }));
    await act(async () => { fireEvent.click(lastPost()); });
    expect(onPostStatus).toHaveBeenCalledWith("p-a", "Logo round two is with the client", "off_track");
    await waitFor(() => expect(screen.queryByPlaceholderText(/What's the latest/)).not.toBeInTheDocument());
  });

  it("keeps your words when the post fails, so you can try again", async () => {
    const onPostStatus = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<ProjectActions {...actionProps({ onPostStatus })} />);
    fireEvent.click(screen.getByRole("button", { name: "Post update" }));
    fireEvent.change(box(), { target: { value: "Still going" } });
    await act(async () => { fireEvent.click(lastPost()); });
    expect(box()).toHaveValue("Still going");
    await act(async () => { fireEvent.click(lastPost()); });
    expect(onPostStatus).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByPlaceholderText(/What's the latest/)).not.toBeInTheDocument());
  });

  it("keeps a draft when the composer is closed and opened again", () => {
    render(<ProjectActions {...actionProps({ onPostStatus: vi.fn() })} />);
    fireEvent.click(screen.getByRole("button", { name: "Post update" }));
    fireEvent.change(box(), { target: { value: "Half a thought" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText(/What's the latest/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Post update" }));
    expect(box()).toHaveValue("Half a thought");
  });

  it("Draft update asks Kanbo's AI when it's on, and marks its words", async () => {
    const aiStatus = vi.fn().mockResolvedValue({ source: "ai", data: { summary: "Kanbo's words", status: "off_track" } });
    render(<ProjectActions {...actionProps({ onPostStatus: vi.fn(), aiStatus })} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft update" }));
    await waitFor(() => expect(box()).toHaveValue("Kanbo's words"));
    expect(aiStatus).toHaveBeenCalledWith(expect.objectContaining({ project: "Alpha", blocked: [expect.objectContaining({ title: "Ship onboarding", waitingOn: ["Finalise the deck"] })] }));
    expect(screen.getByRole("button", { name: "Off track" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/How I got here · from this week's/)).toBeInTheDocument();
  });

  it("Draft update writes the on-device draft without the AI", () => {
    render(<ProjectActions {...actionProps({ onPostStatus: vi.fn() })} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft update" }));
    expect(box().value).toMatch(/^Finished 1 task this week; 33% done overall\. Finalise the deck is the critical path/);
    expect(screen.getByRole("button", { name: "At risk" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Drafted on this device/)).toBeInTheDocument();
    expect(screen.queryByText(/How I got here/)).not.toBeInTheDocument();
  });

  it("falls back to the on-device draft when the AI can't answer", async () => {
    const aiStatus = vi.fn().mockResolvedValue({ source: "limit", data: null });
    render(<ProjectActions {...actionProps({ onPostStatus: vi.fn(), aiStatus })} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft update" }));
    await waitFor(() => expect(box().value).toMatch(/^Finished 1 task this week/));
    expect(screen.getByText(/today's Kanbo AI allowance/)).toBeInTheDocument();
  });

  it("never overwrites what you typed while Kanbo was drafting", async () => {
    let answer!: (v: unknown) => void;
    const aiStatus = vi.fn(() => new Promise((r) => { answer = r; }));
    render(<ProjectActions {...actionProps({ onPostStatus: vi.fn(), aiStatus: aiStatus as never })} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft update" }));
    const field = screen.getByRole("textbox", { name: "Update" });
    expect(field).toHaveAttribute("placeholder", "Kanbo is drafting…");
    fireEvent.change(field, { target: { value: "My own words" } });
    await act(async () => { answer({ source: "ai", data: { summary: "Late AI words", status: "on_track" } }); });
    expect(box()).toHaveValue("My own words");
  });
});

describe("ProjectActions — the ⋯ menu", () => {
  it("offers details, rules, requests and the archive / delete flows to members", () => {
    const onTab = vi.fn(), onArchive = vi.fn(), onDelete = vi.fn(), onDuplicate = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ProjectActions {...actionProps({ onTab, onArchive, onDelete, onDuplicate, onPostStatus: vi.fn() })} />);
    const open = () => fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    open();
    const menu = screen.getByRole("menu", { name: "Actions for Alpha" });
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(
      ["Details", "Rules", "Requests", "Print report", "Duplicate", "Save as template", "Archive project", "Delete project"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Details" }));
    expect(onTab).toHaveBeenCalledWith("about");
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive project" }));
    expect(confirm).toHaveBeenCalled();
    expect(onArchive).toHaveBeenCalledWith("p-a");
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete project" }));
    expect(onDelete).toHaveBeenCalledWith("p-a");
    confirm.mockRestore();
  });

  it("gives guests no update buttons and a read-only menu", () => {
    render(<ProjectActions {...actionProps({ readOnly: true, onPostStatus: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn() })} />);
    expect(screen.queryByRole("button", { name: "Post update" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Draft update" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Details", "Requests", "Print report"]);
  });

  it("saves the project as a template on this device when the shell doesn't", () => {
    render(<ProjectActions {...actionProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as template" }));
    expect(screen.getByRole("menuitem", { name: "Saved as a template" })).toBeInTheDocument();
    const [tpl] = getUserProjectTemplates();
    expect(tpl).toMatchObject({ name: "Alpha", emoji: "🚀" });
    expect(tpl.tasks?.map((t) => t.title)).toEqual(["Finalise the deck", "Ship onboarding", "Approve budget"]);
  });

  it("hands Save as template to the shell when it offers it", () => {
    const onSaveTemplate = vi.fn();
    render(<ProjectActions {...actionProps({ onSaveTemplate })} />);
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as template" }));
    expect(onSaveTemplate).toHaveBeenCalledWith("p-a");
    expect(getUserProjectTemplates()).toEqual([]);
  });
});

describe("ProjectTitleAddon", () => {
  it("shows the latest call as a pill that opens Updates, the progress and the people", () => {
    const onOpenUpdates = vi.fn();
    render(<ProjectTitleAddon project={P} tasks={TASKS} statusUpdates={UPDATES} onOpenUpdates={onOpenUpdates} />);
    fireEvent.click(screen.getByRole("button", { name: "At risk" }));
    expect(onOpenUpdates).toHaveBeenCalled();
    expect(screen.getByRole("progressbar", { name: "Alpha progress" })).toHaveAttribute("aria-valuenow", "33");
    expect(screen.getByRole("img", { name: /^People: Daniel Okai, Maya Lin$/ })).toBeInTheDocument();
  });

  it("says No update when nobody has posted one", () => {
    render(<ProjectTitleAddon project={P} tasks={TASKS} statusUpdates={[]} onOpenUpdates={() => {}} />);
    expect(screen.getByRole("button", { name: "No update" })).toBeInTheDocument();
  });
});

describe("ProjectNotice", () => {
  const risk = (id: string, title: string, severity: Risk["severity"] = "warn"): Risk => ({ id, kind: "stale", severity, title, reason: "", taskIds: [], projectId: P.id, fixes: [] });

  it("shows the latest update, and opens Updates", () => {
    const onOpenUpdates = vi.fn();
    render(<ProjectNotice project={P} statusUpdates={UPDATES} risks={[]} onOpenUpdates={onOpenUpdates} onOpenRisks={() => {}} />);
    expect(screen.getByText("Deck is the critical path")).toBeInTheDocument();
    expect(screen.getByText("3 days ago")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Update/ }));
    expect(onOpenUpdates).toHaveBeenCalled();
  });

  it("shows risks, and nothing at all when the update is stale and nothing's at risk", () => {
    const onOpenRisks = vi.fn();
    const stale = [{ ...UPDATES[0] }];
    const { container, rerender } = render(<ProjectNotice project={P} statusUpdates={stale} risks={[]} onOpenUpdates={() => {}} onOpenRisks={onOpenRisks} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ProjectNotice project={P} statusUpdates={stale} risks={[risk("r1", "Onboarding is blocked", "signal"), risk("r2", "Deck slipped twice"), risk("r3", "Other project", "warn")].map((r, i) => (i === 2 ? { ...r, projectId: "p-z" } : r))} onOpenUpdates={() => {}} onOpenRisks={onOpenRisks} />);
    const btn = screen.getByRole("button", { name: /2 risks/ });
    expect(btn).toHaveTextContent("Onboarding is blocked");
    expect(btn).toHaveTextContent("Deck slipped twice");
    expect(btn).toHaveAttribute("data-tone", "signal");
    fireEvent.click(btn);
    expect(onOpenRisks).toHaveBeenCalled();
  });
});

describe("ProjectPanels", () => {
  const forms: FormDef[] = [
    { id: "f1", projectId: P.id, name: "Launch requests", fields: ["description"] },
    { id: "f2", projectId: "p-other", name: "Someone else's", fields: [] },
  ];
  const base = (o: Partial<React.ComponentProps<typeof ProjectPanels>> = {}): React.ComponentProps<typeof ProjectPanels> => ({
    tab: "updates", project: P, tasks: TASKS, statusUpdates: UPDATES, members: [{ id: "m-self", name: "Daniel Okai" }, { id: "m-1", name: "Maya Lin" }],
    canManage: true, readOnly: false, onUpdate: vi.fn(), onPostStatus: vi.fn(),
    rules: { rules: [{ id: "r1", projectId: P.id, name: "Mine", trigger: "task_created", actions: [], enabled: true }, { id: "r2", projectId: "p-other", name: "Theirs", trigger: "task_created", actions: [], enabled: true }], projects: [P, { ...P, id: "p-other", name: "Other" }], members: [], sections: [], onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn() },
    forms: { forms, projects: [P, { ...P, id: "p-other", name: "Other" }], members: [], onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onSubmit: vi.fn() },
    ...o,
  });

  it("Updates: the history newest first, under a composer that starts from Kanbo's draft", () => {
    render(<ProjectPanels {...base()} />);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Deck is the critical path");
    expect(items[1]).toHaveTextContent("Kick-off went well");
    expect(box().value).toMatch(/^Finished 1 task this week/);
  });

  it("Updates: guests read the history without a composer", () => {
    render(<ProjectPanels {...base({ readOnly: true })} />);
    expect(screen.queryByPlaceholderText(/What's the latest/)).not.toBeInTheDocument();
    expect(screen.getByText("Kick-off went well")).toBeInTheDocument();
  });

  it("Requests: this project's forms only, with the project chosen", () => {
    render(<ProjectPanels {...base({ tab: "requests" })} />);
    expect(screen.getByText("Teammates fill these in to file work into this project.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Launch requests")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Someone else's")).not.toBeInTheDocument();
  });

  it("Rules: this project's rules for members, and nothing to change for guests", () => {
    const { unmount } = render(<ProjectPanels {...base({ tab: "rules" })} />);
    expect(screen.getByDisplayValue("Mine")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Theirs")).not.toBeInTheDocument();
    unmount();
    render(<ProjectPanels {...base({ tab: "rules", readOnly: true })} />);
    expect(screen.getByText("Rules are for members")).toBeInTheDocument();
  });

  it("About: edits the description, owner and contributors", () => {
    const onUpdate = vi.fn();
    render(<ProjectPanels {...base({ tab: "about", onUpdate })} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a description…" }));
    const desc = screen.getByRole("textbox", { name: "Project description" });
    fireEvent.change(desc, { target: { value: "Ship the Q3 launch" } });
    fireEvent.blur(desc);
    expect(onUpdate).toHaveBeenCalledWith("p-a", { description: "Ship the Q3 launch" });
    fireEvent.change(screen.getByRole("combobox", { name: "Project owner" }), { target: { value: "m-1" } });
    expect(onUpdate).toHaveBeenCalledWith("p-a", { ownerId: "m-1" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Maya Lin/ }));
    expect(onUpdate).toHaveBeenCalledWith("p-a", { contributorIds: [] });
  });

  it("About: guests read it without controls", () => {
    render(<ProjectPanels {...base({ tab: "about", readOnly: true, canManage: false })} />);
    expect(screen.queryByRole("combobox", { name: "Project owner" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a description…" })).not.toBeInTheDocument();
    expect(screen.getByText("No description.")).toBeInTheDocument();
  });
});

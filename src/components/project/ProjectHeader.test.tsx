import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import type { Project, StatusKind, StatusUpdate, Task, FormDef } from "../../data/types";
import type { Risk } from "../../lib/radar";
import { getUserProjectTemplates } from "../../lib/templates";
import { refreshClock, toLocalISO } from "../../data/data";
import { ProjectActions, ProjectNotice, ProjectPanels, ProjectTitleAddon } from "./ProjectHeader";
import { clearStatusDrafts } from "./StatusComposer";

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
const FORMS: FormDef[] = [
  { id: "f1", projectId: P.id, name: "Launch requests", fields: ["description"] },
  { id: "f2", projectId: "p-other", name: "Someone else's", fields: [] },
];
const panelProps = (o: Partial<React.ComponentProps<typeof ProjectPanels>> = {}): React.ComponentProps<typeof ProjectPanels> => ({
  tab: "updates", project: P, tasks: TASKS, statusUpdates: UPDATES, members: [{ id: "m-self", name: "Daniel Okai" }, { id: "m-1", name: "Maya Lin" }],
  canManage: true, readOnly: false, onUpdate: vi.fn(), onPostStatus: vi.fn(),
  rules: { rules: [{ id: "r1", projectId: P.id, name: "Mine", trigger: "task_created", actions: [], enabled: true }, { id: "r2", projectId: "p-other", name: "Theirs", trigger: "task_created", actions: [], enabled: true }], projects: [P, { ...P, id: "p-other", name: "Other" }], members: [], sections: [], onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn() },
  forms: { forms: FORMS, projects: [P, { ...P, id: "p-other", name: "Other" }], members: [], onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onSubmit: vi.fn() },
  ...o,
});
const actionProps = (o: Partial<React.ComponentProps<typeof ProjectActions>> = {}): React.ComponentProps<typeof ProjectActions> => ({
  project: P, tasks: TASKS, statusUpdates: UPDATES, canManage: true, readOnly: false, onTab: vi.fn(), ...o,
});
const lastPost = () => { const all = screen.getAllByRole("button", { name: "Post update" }); return all[all.length - 1]; };
const box = () => screen.getByPlaceholderText(/What's the latest/) as HTMLTextAreaElement;

beforeEach(() => { localStorage.clear(); clearStatusDrafts(); });
/** move Kanbo's clock on `days`, as the live clock does at midnight in a tab left open */
const afterDays = (days: number, fn: () => void) => {
  try { refreshClock(new Date(Date.now() + days * 86400000)); fn(); } finally { refreshClock(new Date()); }
};

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
    expect(box()).toHaveFocus();                                        // the words arrive without stealing focus
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

  it.each([
    ["limit", /You've used today's Kanbo drafts, so this one was written on this device\./],
    ["off", /Kanbo's drafting is turned off, so this one was written on this device\./],
    ["unavailable", /Kanbo couldn't draft this one just now, so it was written on this device\./],
  ])("falls back to the on-device draft when Kanbo can't answer (%s), and says why without saying AI", async (source, note) => {
    const aiStatus = vi.fn().mockResolvedValue({ source, data: null });
    render(<ProjectActions {...actionProps({ onPostStatus: vi.fn(), aiStatus })} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft update" }));
    await waitFor(() => expect(box().value).toMatch(/^Finished 1 task this week/));
    expect(screen.getByText(note)).toBeInTheDocument();
    expect(screen.queryByText(/\bAI\b/)).not.toBeInTheDocument();
  });

  it("shows focus on Kanbo's words as one ring round the vellum card", async () => {
    const aiStatus = vi.fn().mockResolvedValue({ source: "ai", data: { summary: "Kanbo's words", status: "on_track" } });
    render(<ProjectActions {...actionProps({ onPostStatus: vi.fn(), aiStatus })} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft update" }));
    await waitFor(() => expect(box()).toHaveValue("Kanbo's words"));
    expect(box()).toHaveAttribute("data-focus-ring", "none");
    expect(box().parentElement).toHaveClass("kvellum");
    fireEvent.change(box(), { target: { value: "" } });                 // your own words: an ordinary field again
    expect(box()).not.toHaveAttribute("data-focus-ring");
  });

  it("Post update opens an empty field after Kanbo drafted one, but keeps words you wrote", () => {
    render(<ProjectActions {...actionProps({ onPostStatus: vi.fn() })} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft update" }));
    expect(box().value).toMatch(/^Finished 1 task this week/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Post update" }));
    expect(box()).toHaveValue("");
    fireEvent.change(box(), { target: { value: "My own words" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Draft update" }));
    expect(box()).toHaveValue("My own words");                          // Draft update never writes over yours
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Post update" }));
    expect(box()).toHaveValue("My own words");
  });

  it("Draft update asks the AI in place of an untouched on-device draft", async () => {
    const aiStatus = vi.fn().mockResolvedValue({ source: "ai", data: { summary: "Kanbo's words", status: "at_risk" } });
    render(<><ProjectPanels {...panelProps()} /><ProjectActions {...actionProps({ onPostStatus: vi.fn(), aiStatus })} /></>);
    expect((screen.getByRole("textbox", { name: "Update" }) as HTMLTextAreaElement).value).toMatch(/^Finished 1 task/); // the Updates tab's draft
    fireEvent.click(screen.getByRole("button", { name: "Draft update" }));
    await waitFor(() => screen.getAllByRole("textbox", { name: "Update" }).forEach((t) => expect(t).toHaveValue("Kanbo's words")));
    expect(aiStatus).toHaveBeenCalledTimes(1);
  });

  it("on the Updates tab, Draft and Post update fill and focus the page's composer: one editor, one filled Post update", async () => {
    const aiStatus = vi.fn().mockResolvedValue({ source: "ai", data: { summary: "Kanbo's words", status: "at_risk" } });
    render(<><ProjectPanels {...panelProps()} /><ProjectActions {...actionProps({ onPostStatus: vi.fn(), aiStatus })} /></>);
    const draft = screen.getByRole("button", { name: "Draft update" });
    expect(draft).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(draft);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();                   // no popover over the page's composer
    const fields = screen.getAllByRole("textbox", { name: "Update" });
    expect(fields).toHaveLength(1);
    expect(fields[0]).toHaveFocus();
    await waitFor(() => expect(fields[0]).toHaveValue("Kanbo's words"));
    // the header's Post update is the quiet one; the page's is the only filled one
    const posts = screen.getAllByRole("button", { name: /^Post update/ });
    expect(posts.filter((b) => b.getAttribute("data-variant") === "primary")).toHaveLength(1);
    fireEvent.click(posts.find((b) => b.getAttribute("data-variant") === "secondary")!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: "Update" })[0]).toHaveFocus();
  });

  it("drafts from today's facts after the day rolls over in a tab left open", () => {
    const aiStatus = vi.fn(() => new Promise<never>(() => {}));
    const { rerender } = render(<ProjectActions {...actionProps({ onPostStatus: vi.fn(), aiStatus: aiStatus as never })} />);
    afterDays(5, () => {
      rerender(<ProjectActions {...actionProps({ onPostStatus: vi.fn(), aiStatus: aiStatus as never })} />);
      fireEvent.click(screen.getByRole("button", { name: "Draft update" }));
      expect(aiStatus).toHaveBeenCalledWith(expect.objectContaining({
        today: toLocalISO(new Date(Date.now() + 5 * 86400000)),
        overdue: expect.arrayContaining([expect.objectContaining({ title: "Finalise the deck" })]),
      }));
    });
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

  it("offers Delete project only to someone who can manage the project", () => {
    render(<ProjectActions {...actionProps({ canManage: false, onArchive: vi.fn(), onDelete: vi.fn() })} />);
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.getByRole("menuitem", { name: "Archive project" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete project" })).not.toBeInTheDocument();
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

  it("says so in the menu when this device won't store the template", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    try {
      render(<ProjectActions {...actionProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Save as template" }));
      expect(screen.getByRole("menuitem", { name: "Couldn't save: try again" })).toHaveAttribute("data-tone", "warn");
    } finally { setItem.mockRestore(); }
    fireEvent.click(screen.getByRole("menuitem", { name: "Couldn't save: try again" }));
    expect(screen.getByRole("menuitem", { name: "Saved as a template" })).toBeInTheDocument();
    expect(getUserProjectTemplates()).toHaveLength(1);
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

describe("ProjectActions: Edit identity", () => {
  it("opens from ⋯, previews the choice live, and saves icon and colour together", async () => {
    const onEditIdentity = vi.fn();
    render(<ProjectActions project={P} tasks={TASKS} statusUpdates={UPDATES} canManage readOnly={false} onTab={() => {}} onEditIdentity={onEditIdentity} />);
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit identity" }));
    const sheet = await screen.findByRole("dialog", { name: "Edit identity of Alpha" });
    const save = within(sheet).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();                                                      // nothing changed yet
    expect(within(sheet).getByRole("radio", { name: "Sky" })).toHaveAttribute("aria-checked", "true");  // its stored colour, read as the spectrum
    fireEvent.click(within(sheet).getByRole("radio", { name: "Jade" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "🌱" }));
    expect(sheet.querySelector(".kptile")?.textContent).toBe("🌱");
    fireEvent.click(save);
    expect(onEditIdentity).toHaveBeenCalledWith({ emoji: "🌱", color: "oklch(0.62 0.144 158)" });
  });

  it("isn't offered to a guest", () => {
    render(<ProjectActions project={P} tasks={TASKS} statusUpdates={UPDATES} canManage={false} readOnly onTab={() => {}} onEditIdentity={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.queryByRole("menuitem", { name: "Edit identity" })).not.toBeInTheDocument();
  });
});

describe("ProjectTitleAddon", () => {
  it("shows the latest call as a pill that opens Updates, the progress and the people", () => {
    const onOpenUpdates = vi.fn();
    render(<ProjectTitleAddon project={P} tasks={TASKS} statusUpdates={UPDATES} onOpenUpdates={onOpenUpdates} />);
    fireEvent.click(screen.getByRole("button", { name: "At risk" }));
    expect(onOpenUpdates).toHaveBeenCalled();
    const ring = screen.getByRole("progressbar", { name: "Alpha progress" });
    expect(ring).toHaveAttribute("aria-valuenow", "33");
    expect(ring).toHaveClass("kring");                                               // a ring, not a bar
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^People: Daniel Okai, Maya Lin$/ })).toBeInTheDocument();
  });

  it("names the next milestone and when it lands", () => {
    const ms = task("m1", { title: "Launch day", isMilestone: true, dueDate: iso(3) });
    render(<ProjectTitleAddon project={P} tasks={[...TASKS, ms]} statusUpdates={UPDATES} onOpenUpdates={() => {}} />);
    const chip = screen.getByTitle("Next milestone: Launch day");
    expect(chip).toHaveTextContent("Launch day");
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
  const base = panelProps;

  it("Updates: the history newest first, under a composer that starts from Kanbo's draft", () => {
    render(<ProjectPanels {...base()} />);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Deck is the critical path");
    expect(items[1]).toHaveTextContent("Kick-off went well");
    expect(box().value).toMatch(/^Finished 1 task this week/);
  });

  it("Updates: a half-written update survives a tab switch, and is the header's draft too", () => {
    const { rerender } = render(<ProjectPanels {...base()} />);
    fireEvent.change(box(), { target: { value: "My careful update about the launch" } });
    rerender(<ProjectPanels {...base({ tab: "about" })} />);
    expect(screen.queryByRole("textbox", { name: "Update" })).not.toBeInTheDocument();
    rerender(<ProjectPanels {...base({ tab: "updates" })} />);
    expect(box()).toHaveValue("My careful update about the launch");
    // away from the Updates tab, the header's composer holds the same words
    rerender(<ProjectPanels {...base({ tab: "about" })} />);
    const header = render(<ProjectActions {...actionProps({ onPostStatus: vi.fn() })} />);
    fireEvent.click(within(header.container).getByRole("button", { name: "Post update" }));
    const fields = screen.getAllByRole("textbox", { name: "Update" });
    expect(fields).toHaveLength(1);                                     // the header popover's
    expect(fields[0]).toHaveValue("My careful update about the launch");
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
    expect(screen.queryByText(/file a request/)).not.toBeInTheDocument();          // guests can't
  });

  it("Requests: guests see the forms and what they ask for, with nothing to fill in", () => {
    render(<ProjectPanels {...base({ tab: "requests", readOnly: true })} />);
    expect(screen.getByText("Launch requests")).toBeInTheDocument();
    expect(screen.getByText("Asks for a title, description.")).toBeInTheDocument();
    expect(screen.getByText(/Only members can file requests/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open form/ })).not.toBeInTheDocument();
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

  it("About: counts open work with its sub-tasks, as overdue and blocked do, so they always add up", () => {
    const tasks = [...TASKS, task("t4", { title: "Book the venue", parentId: "t1", dueDate: iso(-2) }), task("t5", { title: "Print badges", parentId: "t1", dueDate: iso(-1) })];
    render(<ProjectPanels {...base({ tab: "about", tasks })} />);
    expect(screen.getByText("4 open")).toBeInTheDocument();
    expect(screen.getByText("· 2 overdue")).toBeInTheDocument();
    expect(screen.getByText("· 1 blocked")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Alpha progress" }).closest(".kpj-progress")).toHaveAttribute("title", "1 of 3 tasks done");
  });

  it("About: flags a stale update once the day rolls over in a tab left open", () => {
    const { rerender } = render(<ProjectPanels {...base({ tab: "about" })} />);
    expect(screen.queryByText(/No update in/)).not.toBeInTheDocument();
    afterDays(12, () => {
      rerender(<ProjectPanels {...base({ tab: "about" })} />);
      expect(screen.getByText("No update in 15 days")).toBeInTheDocument();
    });
  });

  it("About: guests read it without controls", () => {
    render(<ProjectPanels {...base({ tab: "about", readOnly: true, canManage: false })} />);
    expect(screen.queryByRole("combobox", { name: "Project owner" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a description…" })).not.toBeInTheDocument();
    expect(screen.getByText("No description.")).toBeInTheDocument();
  });
});

/* The app with project access (0058), in demo mode. Foundrise has it on (Payroll & contracts is
   private, Seed round members only), Reco HQ has it off (its guest, Leah, is on one project), Harbour
   has it on with Daniel a viewer on Fee review, and Daniel is a guest at Northlight. Locks, People &
   access, New project's "Who can see this?", view-only pages, the owner's switch with its preview,
   and the guest's view. Everywhere it's off, nothing of it shows. */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { store } from "./data/store";
import { DEMO_RULES, TASKS } from "./data/data";
import { KANBO_TODAY, toLocalISO } from "./data/data";

beforeAll(loadAllChunks, 60_000);

const renderApp = () => render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()); };
const at = (url: string) => window.history.replaceState(null, "", url);
const inWs = (ws: string, url: string) => { localStorage.setItem("kanbo-onboarded", "1"); localStorage.setItem("kanbo-onboarded:m-self", "1"); localStorage.setItem("kanbo-tour-done", "1"); localStorage.setItem("kanbo-last-ws:m-self", ws); at(url); };
const sidebarProjects = () => document.querySelector<HTMLElement>(".kproj-list")!;
const openWorkspaceSettings = async () => {
  fireEvent.keyDown(document.body, { key: ",", metaKey: true });
  const dialog = await screen.findByRole("dialog", { name: /settings/i });
  fireEvent.click(await within(dialog).findByRole("tab", { name: /^Workspace/ }));
  return dialog;
};

const spies: { mockRestore: () => void }[] = [];
const spy = <T extends { mockRestore: () => void }>(s: T): T => { spies.push(s); return s; };
afterEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/"); spies.splice(0).forEach((s) => s.mockRestore()); });

describe("App · project access on (Foundrise)", () => {
  it("locks Members only and Private projects in the sidebar, and nothing else", async () => {
    inWs("ws-foundrise", "/today");
    await boot();
    await waitFor(() => expect(sidebarProjects()).toBeTruthy());
    const list = sidebarProjects();
    expect(within(list).getByRole("button", { name: /Payroll & contracts\s*, private/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /Seed round\s*, members only/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /^Q3 Product Launch/ }).textContent).not.toMatch(/private|members only/);
  });

  it("About › People & access: who can see it, its people, and narrowing asks first", async () => {
    inWs("ws-foundrise", "/p/p-seed/about");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    const panel = await screen.findByRole("region", { name: "People & access" });
    expect(within(panel).getByRole("radio", { name: /Members only/ })).toBeChecked();
    expect(within(panel).getByText("Sana Rao")).toBeInTheDocument();
    expect(within(panel).getByText("Owner")).toBeInTheDocument();
    // (Sana is on it and Daniel owns the workspace: nobody loses it)
    fireEvent.click(within(panel).getByRole("radio", { name: /^Private/ }));
    const ask = await within(panel).findByRole("alertdialog");
    expect(ask.querySelector("p")?.textContent).toBe("Make Seed round private?");
    fireEvent.click(within(ask).getByRole("button", { name: "Make it private" }));
    await waitFor(() => expect(within(panel).getByRole("radio", { name: /^Private/ })).toBeChecked());
    await waitFor(() => expect(within(sidebarProjects()).getByRole("button", { name: /Seed round\s*, private/ })).toBeInTheDocument());
    // adding someone, as an editor (guests as commenters)
    fireEvent.change(within(panel).getByRole("combobox", { name: "Add someone to this project" }), { target: { value: "m-2" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(within(panel).getByRole("combobox", { name: "Theo Vance's role" })).toHaveValue("editor"));
  });

  it("making a Whole workspace project private names who'd lose it", async () => {
    inWs("ws-foundrise", "/p/p-brand/about");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    const panel = await screen.findByRole("region", { name: "People & access" });
    fireEvent.click(within(panel).getByRole("radio", { name: /^Private/ }));
    const ask = await within(panel).findByRole("alertdialog");
    expect(ask.querySelector("p")?.textContent).toMatch(/^Make Brand Refresh private\? Theo Vance will lose access\./);
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(within(panel).getByRole("radio", { name: /Whole workspace/ })).toBeChecked();
  });

  it("copying someone else's project keeps its owner on the copy (an owner has no row of their own)", async () => {
    // (the copy itself isn't made: only what it would be made with matters, and the demo's state carries over)
    const create = spy(vi.spyOn(store, "createProject").mockRejectedValue(new Error("offline")));
    inWs("ws-foundrise", "/p/p-brand");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Project actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Duplicate/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].memberIds).toEqual(expect.arrayContaining(["m-3"]));   // Sana, Brand Refresh's owner
  });

  it("switched off (the rollback), a private project's copy still says private, so switching back on doesn't open it", async () => {
    await store.setProjectAccess("ws-foundrise", { on: false });
    try {
      const create = spy(vi.spyOn(store, "createProject").mockRejectedValue(new Error("offline")));
      inWs("ws-foundrise", "/p/p-payroll");
      await boot();
      fireEvent.click(await screen.findByRole("button", { name: "Project actions" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: /Duplicate/ }));
      await waitFor(() => expect(create).toHaveBeenCalled());
      expect(create.mock.calls[0][0]).toMatchObject({ name: "Payroll & contracts (copy)", visibility: "private" });
    } finally {
      await store.setProjectAccess("ws-foundrise", { on: true });
    }
  });

  it("a copy keeps each person's role: a viewer on the project is a viewer on the copy, not an editor", async () => {
    await store.setProjectMember("p-payroll", "m-1", "viewer");
    try {
      const create = spy(vi.spyOn(store, "createProject").mockRejectedValue(new Error("offline")));
      inWs("ws-foundrise", "/p/p-payroll");
      await boot();
      fireEvent.click(await screen.findByRole("button", { name: "Project actions" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: /Duplicate/ }));
      await waitFor(() => expect(create).toHaveBeenCalled());
      expect(create.mock.calls[0][0].memberIds).toEqual(expect.arrayContaining(["m-1"]));
      expect(create.mock.calls[0][0].memberRoles?.["m-1"]).toBe("viewer");
    } finally {
      await store.setProjectMember("p-payroll", "m-1", "editor");
    }
  });

  it("a private project's copy is private too, with its people", async () => {
    inWs("ws-foundrise", "/p/p-payroll");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Project actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Duplicate/ }));
    await waitFor(() => expect(within(sidebarProjects()).getByRole("button", { name: /Payroll & contracts \(copy\)\s*, private/ })).toBeInTheDocument());
  });

  it("a Members only project's assignee picker offers only the people who can see it", async () => {
    inWs("ws-foundrise", "/p/p-seed/list");
    await boot();
    const btns = await screen.findAllByRole("button", { name: /Change assignee for|Unassigned\. Assign/ }, { timeout: 8000 });
    fireEvent.click(btns[0]);
    const pop = (await screen.findByRole("dialog", { name: /Assignee for/ }).catch(() => null)) ?? document.body;
    const offered = within(pop as HTMLElement).getAllByRole("menuitemradio").map((x) => x.textContent?.trim() ?? "");
    expect(offered.some((x) => /Sana Rao/.test(x))).toBe(true);
    // (Maya and Ana aren't on it; Theo may be, added by the test above)
    expect(offered.some((x) => /Maya Lin|Ana Ruiz/.test(x))).toBe(false);
  }, 30_000);

  it("moving a task into a project its assignee can't see gives it to you, and says why", async () => {
    inWs("ws-foundrise", "/p/p-launch/list");
    await boot();
    fireEvent.click(await screen.findByText("Ship onboarding redesign to staging", {}, { timeout: 8000 }));
    const panel = await screen.findByRole("dialog", { name: /Ship onboarding redesign to staging/ });
    fireEvent.change(within(panel).getByLabelText("Project"), { target: { value: "p-seed" } });
    expect(await screen.findByText("Maya Lin can't see Seed round, so “Ship onboarding redesign to staging” is now assigned to you.")).toBeInTheDocument();
  }, 30_000);

  it("0058: a sub-task moved to another project on its own becomes a task of its own there (the server would keep it with its parent)", async () => {
    const base = TASKS.find((x) => x.title === "Ship onboarding redesign to staging")!;
    TASKS.push({ ...base, id: "t-solo-sub", title: "Write the staging checklist", parentId: base.id, assigneeId: "m-self", status: "todo", dependencies: [],
      collaborators: [], subtasks: [], recurrence: "none" });
    const upd = spy(vi.spyOn(store, "updateTask"));
    try {
      inWs("ws-foundrise", "/p/p-launch/list?task=t-solo-sub");
      await boot();
      const panel = await screen.findByRole("dialog", { name: /Write the staging checklist/ }, { timeout: 8000 });
      fireEvent.change(within(panel).getByLabelText("Project"), { target: { value: "p-seed" } });
      await waitFor(() => expect(upd.mock.calls.some((c) => c[0] === "t-solo-sub" && c[1].projectId === "p-seed")).toBe(true));
      const sent = upd.mock.calls.find((c) => c[0] === "t-solo-sub" && c[1].projectId === "p-seed")![1];
      expect("parentId" in sent && sent.parentId === undefined).toBe(true);
      // (its parent stays where it was)
      expect(upd.mock.calls.some((c) => c[0] === base.id && c[1].projectId !== undefined)).toBe(false);
    } finally { TASKS.splice(TASKS.findIndex((t) => t.id === "t-solo-sub"), 1); }
  }, 60_000);

  it("0058: making someone a guest (or an admin a member) asks first, naming what they'd lose; cancelled, nothing changes", async () => {
    const set = spy(vi.spyOn(store, "setMemberRole").mockResolvedValue(undefined));
    const confirm = spy(vi.spyOn(window, "confirm").mockReturnValue(false));
    inWs("ws-foundrise", "/team/people");
    await boot();
    fireEvent.click((await screen.findAllByRole("button", { name: /Maya Lin/ }, { timeout: 8000 }))[0]);
    const dlg = await screen.findByRole("dialog", { name: "Maya Lin profile" }, { timeout: 8000 });
    fireEvent.change(within(dlg).getByRole("combobox", { name: "Role for Maya Lin" }), { target: { value: "guest" } });
    expect(confirm).toHaveBeenCalledTimes(1);
    const q = String(confirm.mock.calls[0][0]);
    expect(q).toMatch(/^Make Maya Lin a guest\?/);
    expect(q).toMatch(/Payroll & contracts/);
    expect(q).toMatch(/becomes Can comment, and stays that way/);
    expect(set).not.toHaveBeenCalled();
    // asked again and confirmed: it goes
    confirm.mockReturnValue(true);
    fireEvent.change(within(dlg).getByRole("combobox", { name: "Role for Maya Lin" }), { target: { value: "guest" } });
    await waitFor(() => expect(set).toHaveBeenCalledWith(expect.any(String), "guest"));
  }, 60_000);

  it("a project's rule never hands a task to someone who can't see the project (a status change still saves), and its Rules offer only its people", async () => {
    // a rule made while Seed round was still Whole workspace (or before the switch went on)
    DEMO_RULES.push({ id: "rule-review", projectId: "p-seed", workspaceId: "ws-foundrise", name: "Review goes to Maya",
      trigger: "status_changed", actions: [{ type: "set_assignee", value: "m-1" }], enabled: true });
    const upd = spy(vi.spyOn(store, "updateTask"));
    try {
      inWs("ws-foundrise", "/p/p-seed/list");
      await boot();
      fireEvent.click(await screen.findByText("Draft the investor update", {}, { timeout: 8000 }));
      const panel = await screen.findByRole("dialog", { name: /Draft the investor update/ });
      fireEvent.change(within(panel).getByLabelText("Status"), { target: { value: "review" } });
      await waitFor(() => expect(upd.mock.calls.some((c) => c[1].status === "review")).toBe(true));
      // (live, pa_trg_tasks refuses a client UPDATE giving it to Maya: 42501, and the status change is undone)
      expect(upd.mock.calls.some((c) => c[1].assigneeId === "m-1")).toBe(false);
      expect(await screen.findByText("Maya Lin can't see Seed round, so the rule “Review goes to Maya” didn't assign “Draft the investor update” to them.")).toBeInTheDocument();
      cleanup();
      inWs("ws-foundrise", "/p/p-seed/rules");
      await boot();
      const who = await screen.findByRole("combobox", { name: "Person assigned by Review goes to Maya" }, { timeout: 8000 });
      const offered = within(who).getAllByRole("option").map((o) => o.textContent ?? "");
      expect(offered.filter((o) => /Maya Lin/.test(o))).toEqual(["Maya Lin (can't see Seed round: not assigned)"]);
      expect(offered.some((o) => /Sana Rao/.test(o))).toBe(true);
      expect(offered.some((o) => /Ana Ruiz/.test(o))).toBe(false);
    } finally { DEMO_RULES.splice(DEMO_RULES.findIndex((r) => r.id === "rule-review"), 1); }
  }, 60_000);

  // (r2) Idris isn't in Foundrise (he left, say): remove_member leaves his tasks with him, and the server never
  // gives him a new one (a repeat, a copy) nor lets a rule hand him one; a move keeps him on what he had
  it("0058: a repeat of a task whose assignee has left the workspace is yours, never refused as theirs", async () => {
    const base = TASKS.find((x) => x.title === "Ship onboarding redesign to staging")!;
    TASKS.push({ ...base, id: "t-gone-1", title: "Weekly churn report", assigneeId: "m-4", recurrence: "weekly", status: "todo", dependencies: [],
      dueDate: toLocalISO(KANBO_TODAY), collaborators: [], subtasks: [] });
    const create = spy(vi.spyOn(store, "createTask"));
    try {
      inWs("ws-foundrise", "/p/p-launch/list");
      await boot();
      fireEvent.click(await screen.findByText("Weekly churn report", {}, { timeout: 8000 }));
      const panel = await screen.findByRole("dialog", { name: /Weekly churn report/ });
      fireEvent.change(within(panel).getByLabelText("Status"), { target: { value: "done" } });
      await waitFor(() => expect(create.mock.calls.some((c) => c[0].title === "Weekly churn report")).toBe(true), { timeout: 8000 });
      const next = create.mock.calls.find((c) => c[0].title === "Weekly churn report")![0];
      expect(next.assigneeId).toBe("m-self");
      expect(await screen.findByText("Idris Bell isn't in Foundrise any more, so “Weekly churn report” is yours.")).toBeInTheDocument();
    } finally { TASKS.splice(TASKS.findIndex((t) => t.id === "t-gone-1"), 1); }
  }, 60_000);

  it("0058: a rule that assigns to someone who has left the workspace skips that step (the status change still saves)", async () => {
    DEMO_RULES.push({ id: "rule-gone", projectId: "p-launch", workspaceId: "ws-foundrise", name: "Review goes to Idris",
      trigger: "status_changed", actions: [{ type: "set_assignee", value: "m-4" }], enabled: true });
    const upd = spy(vi.spyOn(store, "updateTask"));
    try {
      inWs("ws-foundrise", "/p/p-launch/list");
      await boot();
      fireEvent.click(await screen.findByText("Ship onboarding redesign to staging", {}, { timeout: 8000 }));
      const panel = await screen.findByRole("dialog", { name: /Ship onboarding redesign to staging/ });
      fireEvent.change(within(panel).getByLabelText("Status"), { target: { value: "review" } });
      await waitFor(() => expect(upd.mock.calls.some((c) => c[1].status === "review")).toBe(true));
      expect(upd.mock.calls.some((c) => c[1].assigneeId === "m-4")).toBe(false);
      expect(await screen.findByText("Idris Bell isn't in Foundrise any more, so the rule “Review goes to Idris” didn't assign “Ship onboarding redesign to staging” to them.")).toBeInTheDocument();
    } finally { DEMO_RULES.splice(DEMO_RULES.findIndex((r) => r.id === "rule-gone"), 1); }
  }, 60_000);

  it("0058: Delete project › Move its tasks into a Members only project gives you those whose people can't see it, as every move does", async () => {
    const upd = spy(vi.spyOn(store, "updateTask"));
    inWs("ws-foundrise", "/p/p-infra");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Project actions" }, { timeout: 8000 }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete project/ }));
    const sheet = await screen.findByRole("dialog", { name: "Delete project" });
    fireEvent.change(within(sheet).getByRole("combobox", { name: /Move tasks from Platform Infra to/ }), { target: { value: "p-seed" } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Move tasks & delete/ }));
    await waitFor(() => expect(upd.mock.calls.some((c) => c[1].projectId === "p-seed")).toBe(true));
    const sent = upd.mock.calls.filter((c) => c[1].projectId === "p-seed").map((c) => c[1]);
    // (Maya and Theo, on Platform Infra's tasks, aren't on Seed round: live, the server refused every such move)
    expect(sent.every((p) => p.assigneeId === undefined || p.assigneeId === "m-self")).toBe(true);
    expect(sent.some((p) => p.assigneeId === "m-self")).toBe(true);
    expect(await screen.findByText(/now assigned to you/)).toBeInTheDocument();
  }, 60_000);

  it("Paste notes → tasks: a task for someone who can't see the project is flagged and comes to you (never sent as theirs)", async () => {
    const create = spy(vi.spyOn(store, "createTask"));
    inWs("ws-foundrise", "/p/p-seed/list");
    await boot();
    expect(await screen.findByRole("heading", { name: "Seed round" }, { timeout: 8000 })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "More ways to create" })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Paste notes/ }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Notes" }), { target: { value: "Maya to send the investor deck by Friday" } });
    fireEvent.click(screen.getByRole("button", { name: /Find tasks/ }));
    const who = await screen.findByRole("combobox", { name: /^Assignee for/ }, { timeout: 8000 });
    expect(screen.getByText("Maya Lin can't see Seed round · It'll be yours")).toBeInTheDocument();
    const offered = within(who).getAllByRole("option").map((o) => o.textContent ?? "");
    // (Ana isn't on it; Theo may be, added by a test above)
    expect(offered.some((o) => /Ana Ruiz/.test(o))).toBe(false);
    expect(offered.filter((o) => /Maya Lin/.test(o))).toEqual(["Maya Lin"]);
    fireEvent.click(screen.getByRole("button", { name: /^Create 1 task/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const sent = create.mock.calls[0][0];
    expect([sent.projectId, sent.assigneeId === "m-1"]).toEqual(["p-seed", false]);
    expect(await screen.findByText(/Maya Lin can't see Seed round, so “Maya to send the investor deck|Maya Lin can't see Seed round, so “Send the investor deck/)).toBeInTheDocument();
  }, 60_000);

  it("re-inviting a pending guest from a project's People & access adds that project to what the invite brings", async () => {
    // live invite_member upserts on (workspace_id, email) while it's still invited: the same row, the same id
    const real = store.inviteMember.bind(store);
    let first: Awaited<ReturnType<typeof store.inviteMember>> | null = null;
    spy(vi.spyOn(store, "inviteMember").mockImplementation(async (ws, email, role) => {
      if (first && first.email === email) return { ...first, role: role ?? first.role };
      first = await real(ws, email, role);
      return first;
    }));
    const send = async (sheet: HTMLElement) => {
      fireEvent.change(within(sheet).getByRole("textbox", { name: "Emails" }), { target: { value: "jo@studio.co" } });
      fireEvent.change(within(sheet).getByRole("combobox", { name: "Invite as role" }), { target: { value: "guest" } });
      return sheet;
    };
    inWs("ws-foundrise", "/team/people");
    await boot();
    fireEvent.click((await screen.findAllByRole("button", { name: "Invite people" }, { timeout: 8000 }))[0]);
    const sheet = await send(await screen.findByRole("dialog", { name: /Invite people/ }));
    const box = await within(sheet).findByRole("checkbox", { name: /Brand Refresh/ });
    if (!(box as HTMLInputElement).checked) fireEvent.click(box);
    fireEvent.click(within(sheet).getByRole("button", { name: /^Send/ }));
    await within(sheet).findByText(/They'll see/, {}, { timeout: 8000 });
    cleanup();
    inWs("ws-foundrise", "/p/p-seed/about");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }, { timeout: 8000 }));
    fireEvent.click(within(await screen.findByRole("region", { name: "People & access" })).getByRole("button", { name: "Invite a guest" }));
    const again = await send(await screen.findByRole("dialog", { name: /Invite people/ }, { timeout: 8000 }));
    fireEvent.click(within(again).getByRole("button", { name: /^Send/ }));
    expect(await within(again).findByText(/They'll see Brand Refresh and Seed round once they join\./, {}, { timeout: 8000 })).toBeInTheDocument();
    const now = (await store.listInviteGrants())!.filter((g) => g.memberId === first!.id).map((g) => g.projectId).sort();
    expect(now).toEqual(["p-brand", "p-seed"]);
  }, 60_000);

  it("Plan it with Kanbo where new projects start as Members only: the people the plan gives work to are on the project it makes", async () => {
    await store.setProjectAccess("ws-foundrise", { defaultVisibility: "members" });
    const mkProject = spy(vi.spyOn(store, "createProject"));
    const batch = spy(vi.spyOn(store, "createTasksBatch"));
    try {
      inWs("ws-foundrise", "/projects");
      await boot();
      fireEvent.click((await screen.findAllByRole("button", { name: /New project/ }, { timeout: 8000 }))[0]);
      const np = await screen.findByRole("dialog", { name: "New project" });
      fireEvent.click(within(np).getByRole("button", { name: /Plan it with Kanbo/ }));
      const pl = await screen.findByRole("dialog", { name: "Plan a project with Kanbo" }, { timeout: 8000 });
      fireEvent.click(within(within(pl).getByRole("group", { name: "Examples to start from" })).getAllByRole("button")[0]);
      fireEvent.click(within(pl).getByRole("button", { name: /Draft the plan/ }));
      await within(pl).findByText(/Drafted on this device/, {}, { timeout: 8000 });
      fireEvent.click(within(pl.querySelector(".ksheet-foot") as HTMLElement).getByRole("button", { name: /Create project/ }));
      await waitFor(() => expect(batch).toHaveBeenCalled(), { timeout: 8000 });
      const made = await mkProject.mock.results[0].value;
      const given = [...new Set(batch.mock.calls[0][0].map((t) => t.assigneeId).filter((u): u is string => !!u && u !== "m-self"))];
      expect(made.visibility).toBe("members");
      expect(given.length).toBeGreaterThan(0);
      // (live, a member who isn't on a Members only project has rank 0: pa_trg_tasks would refuse every such task)
      expect(given.filter((u) => !(made.contributorIds ?? []).includes(u))).toEqual([]);
    } finally { await store.setProjectAccess("ws-foundrise", { defaultVisibility: "workspace" }); }
  }, 60_000);

  it("Add tasks with Kanbo on a Members only project plans only for the people who can see it", async () => {
    inWs("ws-foundrise", "/p/p-seed/list");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Project actions" }, { timeout: 8000 }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Add tasks with Kanbo/ }));
    const pl = await screen.findByRole("dialog", { name: "Add tasks with Kanbo" }, { timeout: 8000 });
    const text = pl.textContent ?? "";
    expect(text).toMatch(/Sana Rao/);
    expect(text).not.toMatch(/Maya Lin|Ana Ruiz/);
  }, 60_000);

  it("a guest's profile on Team says which projects they see", async () => {
    inWs("ws-foundrise", "/team/people");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: /Ana Ruiz/ }, { timeout: 8000 }));
    const sec = await screen.findByRole("region", { name: "Projects" });
    expect(within(sec).getByText("Brand Refresh")).toBeInTheDocument();
    expect(within(sec).getByText(/Ana sees only this project here\./)).toBeInTheDocument();
  }, 30_000);

  it("New project asks who can see it", async () => {
    inWs("ws-foundrise", "/projects");
    await boot();
    fireEvent.click((await screen.findAllByRole("button", { name: /New project/ }))[0]);
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    expect(within(dialog).getByRole("radiogroup", { name: "Who can see this?" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Whole workspace/ })).toBeChecked();
  });

  it("the owner's Settings › Workspace has the switch on, with the counts", async () => {
    inWs("ws-foundrise", "/today");
    await boot();
    const dialog = await openWorkspaceSettings();
    expect(await within(dialog).findByRole("switch", { name: "Turn on project access" })).toBeChecked();
    // (the demo's state carries between these tests: Seed round went private above)
    expect(within(dialog).getByText(/^\d private · \d members only · \d whole workspace$/)).toBeInTheDocument();
  });
});

describe("App · Ask Kanbo counts only what it changed", () => {
  it("a completion you don't confirm (it's blocked) isn't 'Applied', and has no Undo", async () => {
    const upd = spy(vi.spyOn(store, "updateTask"));
    const confirm = spy(vi.spyOn(window, "confirm").mockReturnValue(false));
    inWs("ws-foundrise", "/p/p-launch");
    await boot();
    expect(await screen.findByRole("heading", { name: "Q3 Product Launch" }, { timeout: 8000 })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox", { name: "Search or ask Kanbo" });
    fireEvent.change(box, { target: { value: "mark prep launch-day comms plan done" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: /Apply 1 change/ }, { timeout: 8000 }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText(/^Applied 1 change/)).toBeNull();
    expect(upd).not.toHaveBeenCalled();
  }, 60_000);
});

describe("App · project access off (Reco HQ)", () => {
  // (first: the next test turns it on, and the demo keeps that)
  it("no locks, and New project doesn't ask", async () => {
    inWs("ws-reco", "/projects");
    await boot();
    await waitFor(() => expect(sidebarProjects()).toBeTruthy());
    expect(sidebarProjects().textContent).not.toMatch(/private|members only/);
    fireEvent.click((await screen.findAllByRole("button", { name: /New project/ }))[0]);
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    expect(within(dialog).queryByRole("radiogroup", { name: "Who can see this?" })).toBeNull();
  });

  it("Settings says what turning it on does, and asks before it does", async () => {
    inWs("ws-reco", "/today");
    await boot();
    const dialog = await openWorkspaceSettings();
    const sw = await within(dialog).findByRole("switch", { name: "Turn on project access" });
    expect(sw).not.toBeChecked();
    expect(within(dialog).getByText(/Leah Price · Customer Onboarding/)).toBeInTheDocument();
    fireEvent.click(sw);
    const ask = await within(dialog).findByRole("alertdialog");
    expect(ask.textContent).toMatch(/^Turn on project access for Reco HQ\?/);
    fireEvent.click(within(ask).getByRole("button", { name: "Turn it on" }));
    await waitFor(() => expect(within(dialog).getByRole("switch", { name: "Turn on project access" })).toBeChecked());
  });
});

describe("App · a project you can only view (Harbour's Fee review)", () => {
  it("has no Rules tab, and its task panel reads View only with no comment box", async () => {
    inWs("ws-harbour", "/p/p-hb-fees");
    await boot();
    expect(await screen.findByRole("heading", { name: "Fee review" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Rules/ })).toBeNull();
    fireEvent.click(await screen.findByText("Compare partner fee bands"));
    const panel = await screen.findByRole("dialog", { name: /Compare partner fee bands/ });
    expect(within(panel).getByText("View only")).toBeInTheDocument();
    expect(within(panel).queryByRole("textbox", { name: "Add a comment" })).toBeNull();
  });
  it("0058: a commenter's comment saves without a task-row write the server would refuse (the count catches up on reload)", async () => {
    // (Daniel a commenter on Fee review for this test: the store's demo copy is made once, so the load is changed)
    const boot0 = store.bootstrap.bind(store);
    spy(vi.spyOn(store, "bootstrap").mockImplementation(async (...a: Parameters<typeof store.bootstrap>) => {
      const b = await boot0(...a);
      return { ...b, projectMembers: b.projectMembers?.map((m) => (m.projectId === "p-hb-fees" && m.userId === "m-self" ? { ...m, role: "commenter" as const } : m)) };
    }));
    const upd = spy(vi.spyOn(store, "updateTask"));
    const add = spy(vi.spyOn(store, "addComment"));
    {
      inWs("ws-harbour", "/p/p-hb-fees");
      await boot();
      fireEvent.click(await screen.findByText("Compare partner fee bands", {}, { timeout: 8000 }));
      const panel = await screen.findByRole("dialog", { name: /Compare partner fee bands/ });
      const box = await within(panel).findByRole("textbox", { name: "Add a comment" }, { timeout: 8000 });
      fireEvent.change(box, { target: { value: "The bands look right to me" } });
      fireEvent.keyDown(box, { key: "Enter", metaKey: true });
      await waitFor(() => expect(add).toHaveBeenCalled(), { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 300));
      expect(upd.mock.calls.filter((c) => "comments" in c[1])).toEqual([]);
    }
  }, 60_000);
  it("0058: a task's Project picker offers only projects you can edit (and its own): never Fee review", async () => {
    inWs("ws-harbour", "/p/p-northwind/list");
    await boot();
    fireEvent.click(await screen.findByText("Read the Northwind board pack", {}, { timeout: 8000 }));
    const panel = await screen.findByRole("dialog", { name: /Read the Northwind board pack/ }, { timeout: 8000 });
    const opts = [...(within(panel).getByLabelText("Project") as HTMLSelectElement).querySelectorAll("option")].map((o) => o.textContent ?? "");
    expect(opts.some((o) => /Northwind Review/.test(o))).toBe(true);
    expect(opts.some((o) => /Fee review/.test(o))).toBe(false);
  }, 60_000);
  it("a project's member manager (not an admin) sees a pending invite that brings it, and takes it off", async () => {
    // (Daniel is a member of Harbour and an editor of Northwind Review; an admin's invite brings it to Kit)
    await store.bootstrap({ id: "m-self" } as never);
    const kit = await store.inviteMember("ws-harbour", "kit@harbour.example", "guest");
    await store.setInviteProjects(kit.id, [{ projectId: "p-northwind", role: "commenter" }]);
    const rm = spy(vi.spyOn(store, "removeInviteProject"));
    inWs("ws-harbour", "/p/p-northwind/about");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }, { timeout: 8000 }));
    const panel = await screen.findByRole("region", { name: "People & access" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Take kit@harbour.example's invite off Northwind Review" }, { timeout: 8000 }));
    await waitFor(() => expect(rm).toHaveBeenCalledWith(kit.id, "p-northwind"));
    await waitFor(() => expect(within(panel).queryByText("kit@harbour.example")).toBeNull());
    expect((await store.listInviteGrants())!.filter((g) => g.memberId === kit.id)).toEqual([]);
  }, 60_000);
  it("quick capture on its page files into a project you can change, not this one", async () => {
    const create = spy(vi.spyOn(store, "createTask"));
    inWs("ws-harbour", "/p/p-hb-fees");
    await boot();
    expect(await screen.findByRole("heading", { name: "Fee review" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "q" });
    const input = await screen.findByLabelText("Quick capture a task");
    fireEvent.change(input, { target: { value: "Ask Sana about the fee bands" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ title: "Ask Sana about the fee bands", projectId: "p-northwind" });
  });
  it("0058: New task on its page files into a project you can change, and the picker shows the one it saves to", async () => {
    const create = spy(vi.spyOn(store, "createTask"));
    inWs("ws-harbour", "/p/p-hb-fees");
    await boot();
    expect(await screen.findByRole("heading", { name: "Fee review" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "c" });
    const dialog = await screen.findByRole("dialog", { name: /New task/i }, { timeout: 8000 });
    fireEvent.change(within(dialog).getAllByRole("textbox")[0], { target: { value: "Write up the partner fee comparison" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Create( task)?$/i }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ title: "Write up the partner fee comparison", projectId: "p-northwind" });
    expect(screen.queryByText("You can view Fee review, but not change it.")).toBeNull();
  }, 60_000);
  it("0058: Paste notes → tasks and Import tasks on its page never offer it (they'd be refused and lose what was pasted)", async () => {
    inWs("ws-harbour", "/p/p-hb-fees");
    await boot();
    expect(await screen.findByRole("heading", { name: "Fee review" })).toBeInTheDocument();
    const palette = async (label: string) => {
      fireEvent.keyDown(document.body, { key: "k", metaKey: true });
      const dlg = await screen.findByRole("dialog", { name: "Command palette" }, { timeout: 8000 });
      const input = within(dlg).queryAllByRole("combobox")[0] ?? within(dlg).getAllByRole("textbox")[0];
      fireEvent.change(input, { target: { value: label } });
      const opts = await within(dlg).findAllByRole("option", { name: new RegExp(label) }, { timeout: 8000 });
      fireEvent.click(opts.find((o) => o.getAttribute("data-kind") !== "ask" && !/Search/i.test(o.textContent ?? "")) ?? opts[opts.length - 1]);
    };
    await palette("Paste notes");
    const sheet = await screen.findByRole("dialog", { name: /Notes → tasks/ }, { timeout: 8000 });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Notes" }), { target: { value: "- Sana to send the fee bands by Friday\n- Draft the partner letter\n- Book the review call" } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Find tasks/ }));
    const sel = await within(sheet).findByRole("combobox", { name: "Project for these tasks" }, { timeout: 8000 }) as HTMLSelectElement;
    expect(sel.value).not.toBe("p-hb-fees");
    expect([...sel.querySelectorAll("option")].map((o) => o.textContent ?? "").some((t) => /Fee review/.test(t))).toBe(false);
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Notes → tasks/ })).toBeNull());
    await palette("Import tasks");
    const imp = await screen.findByRole("dialog", { name: /Import/ }, { timeout: 8000 });
    expect(/Fee review/.test(imp.textContent ?? "")).toBe(false);
  }, 60_000);
  it("0058: Ask Kanbo never offers to change a task you can only view (it says why), so it never claims a refused change", async () => {
    const upd = spy(vi.spyOn(store, "updateTask"));
    inWs("ws-harbour", "/p/p-hb-fees");
    await boot();
    expect(await screen.findByRole("heading", { name: "Fee review" }, { timeout: 8000 })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const box = await screen.findByRole("combobox", { name: "Search or ask Kanbo" });
    fireEvent.change(box, { target: { value: "push compare partner fee bands back a week" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText(/Kanbo left out 1 change: You can view Fee review, but not change it\./, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
    expect(screen.queryByText(/^Applied/)).toBeNull();
    expect(upd.mock.calls.filter(([id]) => id === "t-pa-5")).toEqual([]);
  }, 60_000);
  it("0058: deleting a tag takes it off the tasks you can change, never off Fee review's (the server would refuse the row)", async () => {
    const upd = spy(vi.spyOn(store, "updateTask"));
    spy(vi.spyOn(window, "confirm").mockReturnValue(true));
    inWs("ws-harbour", "/today");
    await boot();
    fireEvent.keyDown(document.body, { key: ",", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: /settings/i });
    fireEvent.click(await within(dialog).findByRole("tab", { name: /^Tags/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Delete tag Research" }));
    // (Northwind Review's board-pack task, which Daniel can edit, loses it)
    await waitFor(() => expect(upd.mock.calls.some(([, p]) => "tags" in p)).toBe(true), { timeout: 8000 });
    expect(upd.mock.calls.filter(([id]) => id === "t-pa-5")).toEqual([]);
    expect(screen.queryByText(/Couldn't save/)).toBeNull();
  }, 60_000);
  it("0058: Prioritise my tasks ranks your own Fee review task on screen without writing its row (the server would refuse it)", async () => {
    // (Fee review's task is Daniel's for this test: the store's demo copy is made once, so the load is changed)
    const boot0 = store.bootstrap.bind(store);
    spy(vi.spyOn(store, "bootstrap").mockImplementation(async (...a: Parameters<typeof store.bootstrap>) => {
      const b = await boot0(...a);
      return { ...b, tasks: b.tasks.map((t) => (t.id === "t-pa-5" ? { ...t, assigneeId: "m-self" } : t)) };
    }));
    const rank = spy(vi.spyOn(store, "aiPrioritize").mockImplementation(async (tasks: { id: string }[]) => ({
      items: tasks.map((t, i) => ({ id: t.id, score: 90 - i, reason: "Ranked for the test" })), summary: "Ranked", source: "ai" as const,
    }) as unknown as Awaited<ReturnType<typeof store.aiPrioritize>>));
    const upd = spy(vi.spyOn(store, "updateTask"));
    inWs("ws-harbour", "/today");
    await boot();
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    const dlg = await screen.findByRole("dialog", { name: "Command palette" }, { timeout: 8000 });
    fireEvent.change(within(dlg).getAllByRole("combobox")[0], { target: { value: "Prioritise my tasks" } });
    const opts = await within(dlg).findAllByRole("option", { name: /Prioritise my tasks/ }, { timeout: 8000 });
    fireEvent.click(opts.find((o) => /^Prioritise my tasks/.test(o.textContent ?? ""))!);
    await waitFor(() => expect(rank).toHaveBeenCalled(), { timeout: 8000 });
    expect((rank.mock.calls[0][0] as { id: string }[]).map((t) => t.id)).toContain("t-pa-5");
    // (the Northwind task Daniel can change is written as before)
    await waitFor(() => expect(upd.mock.calls.some(([, p]) => "aiScore" in p)).toBe(true), { timeout: 8000 });
    expect(upd.mock.calls.filter(([id]) => id === "t-pa-5")).toEqual([]);
  }, 60_000);
  it("Projects › Requests shows its form, but it can't be filled in, changed or deleted there", async () => {
    inWs("ws-harbour", "/projects/requests");
    await boot();
    const card = await screen.findByRole("article", { name: "Request form Fee questions" });
    expect(within(card).getByText(/You can view Fee review, but not file into it\./)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Open form Fee questions" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Delete form Fee questions" })).toBeNull();
    expect(within(card).queryByRole("textbox", { name: /Form name/ })).toBeNull();
  });
});

describe("App · Daniel the guest (Northlight Studio)", () => {
  it("is told they see the projects they're added to", async () => {
    inWs("ws-northlight", "/projects");
    await boot();
    expect(await screen.findByText(/you see the projects you're added to, and read or comment on each as it allows/)).toBeInTheDocument();
  });
  it("Goals and Portfolios don't promise a guest every project", async () => {
    inWs("ws-northlight", "/projects/goals");
    await boot();
    // (never a promise to comment: a guest may be on a project only to view it)
    expect(await screen.findByText(/set its goals and track them here\. As a guest you can still open the projects you're added to\./)).toBeInTheDocument();
    window.history.pushState(null, "", "/projects/portfolios");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByText(/to see how they're going together\. As a guest you can still open the projects you're added to\./)).toBeInTheDocument();
  });
});

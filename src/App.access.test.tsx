/* The app with project access (0058), in demo mode. Foundrise has it on (Payroll & contracts is
   private, Seed round members only), Reco HQ has it off (its guest, Leah, is on one project), Harbour
   has it on with Daniel a viewer on Fee review, and Daniel is a guest at Northlight. Locks, People &
   access, New project's "Who can see this?", view-only pages, the owner's switch with its preview,
   and the guest's view. Everywhere it's off, nothing of it shows. */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { store } from "./data/store";

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
    expect(await screen.findByText(/you see the projects you're added to, and you can comment/)).toBeInTheDocument();
  });
  it("Goals and Portfolios don't promise a guest every project", async () => {
    inWs("ws-northlight", "/projects/goals");
    await boot();
    expect(await screen.findByText(/As a guest you can still open the projects you're added to and comment on their tasks\./)).toBeInTheDocument();
    window.history.pushState(null, "", "/projects/portfolios");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByText(/As a guest you can still open the projects you're added to\./)).toBeInTheDocument();
  });
});

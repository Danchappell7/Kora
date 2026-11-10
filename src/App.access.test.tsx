/* The app with project access (0058), in demo mode. Foundrise has it on (Payroll & contracts is
   private, Seed round members only), Reco HQ has it off (its guest, Leah, is on one project), Harbour
   has it on with Daniel a viewer on Fee review, and Daniel is a guest at Northlight. Locks, People &
   access, New project's "Who can see this?", view-only pages, the owner's switch with its preview,
   and the guest's view. Everywhere it's off, nothing of it shows. */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";

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

afterEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/"); });

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

  it("a private project's copy is private too, with its people", async () => {
    inWs("ws-foundrise", "/p/p-payroll");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Project actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Duplicate/ }));
    await waitFor(() => expect(within(sidebarProjects()).getByRole("button", { name: /Payroll & contracts \(copy\)\s*, private/ })).toBeInTheDocument());
  });

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
});

describe("App · Daniel the guest (Northlight Studio)", () => {
  it("is told they see the projects they're added to", async () => {
    inWs("ws-northlight", "/projects");
    await boot();
    expect(await screen.findByText(/you see the projects you're added to, and you can comment/)).toBeInTheDocument();
  });
});

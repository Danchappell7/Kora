/* The 0047 wave, wired through the whole app in demo mode: the recycle bin's
   place (sidebar, its address, its header), a project's Docs tab, approval chips
   on rows, "Approvals for you" and doc mentions in the Inbox, Waiting on
   approval, Settings › Workspace › History, and the planner's openers. */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { resetTrashDemo } from "./lib/trash";
import { resetApprovalsDemo } from "./lib/approvals";
import { resetDemoDocs } from "./lib/docs";

const renderApp = () => render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()); };
const key = (k: string, opts: Record<string, unknown> = {}) => fireEvent.keyDown(document.body, { key: k, ...opts });
const at = (url: string) => window.history.replaceState(null, "", url);
const address = () => window.location.pathname + window.location.search;

beforeEach(() => { resetTrashDemo({ demoDelayMs: 0 }); resetApprovalsDemo({ demoDelayMs: 0 }); resetDemoDocs(); });
afterEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });

describe("App · recycle bin (0047)", () => {
  it("the sidebar's Recycle bin opens /projects/bin under Projects, with its own header and the workspace's deleted work", async () => {
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "Recycle bin" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Recycle bin" })).toBeInTheDocument();
    await waitFor(() => expect(address()).toBe("/projects/bin"));
    expect(screen.getByRole("button", { name: "Recycle bin" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("Draft press release")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "All projects" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
  });

  it("a refresh at /projects/bin lands back in the bin", async () => {
    at("/projects/bin");
    await boot();
    expect(await screen.findByRole("heading", { level: 1, name: "Recycle bin" })).toBeInTheDocument();
  });
});

describe("App · project docs (0047)", () => {
  it("every project has a Docs tab at /p/:id/docs, and a doc opens at its own address", async () => {
    at("/p/p-launch/docs");
    await boot();
    expect(await screen.findByRole("heading", { level: 2, name: /^Docs/ })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Q3 Product Launch: docs" });
    expect(within(list).getByText("Launch brief")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Docs" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("App · approvals (0047)", () => {
  it("rows carry their approval chip, and Waiting on lists your open requests with who you're waiting on", async () => {
    at("/p/p-launch");
    await boot();
    // the launch deck: you asked, everyone must approve, Maya has
    expect(await screen.findByText("Pending 1/2")).toBeInTheDocument();
    at("/tasks?tab=waiting");
    key("g"); key("t");
    await screen.findByRole("heading", { level: 1, name: "My tasks" });
    fireEvent.click(screen.getByRole("tab", { name: /^Waiting on/ }));
    expect(await screen.findByText("1 of 2 approved · waiting on Sana")).toBeInTheDocument();
    const only = screen.getByRole("button", { name: /^Waiting on approval: 1 task$/ });
    fireEvent.click(only);
    expect(only).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Finalise Q3 launch narrative deck")).toBeInTheDocument();
  });

  it("the Inbox leads with Approvals for you, and Sana's doc mention opens the doc", async () => {
    await boot();
    key("g"); key("i");
    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    expect(await screen.findByText("Approvals for you")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve “Define design tokens v2”" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Sana Rao mentioned you in Launch brief/ }));
    await waitFor(() => expect(address()).toBe("/p/p-launch/docs/doc-launch-brief"));
  });
});

describe("App · Settings › Workspace › History (0047)", () => {
  it("owners and admins find the workspace's history under Workspace", async () => {
    await boot();
    key(",", { metaKey: true });
    const settings = await screen.findByRole("dialog", { name: /settings/i });
    fireEvent.click(within(settings).getByRole("tab", { name: /^Workspace/ }));
    expect(await within(settings).findByRole("heading", { level: 3, name: "History" })).toBeInTheDocument();
  });
});

describe("App · plan a project with Kanbo (0047)", () => {
  it("⌘K › Plan a project… opens the planner", async () => {
    await boot();
    key("k", { metaKey: true });
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "Plan a project" } });
    fireEvent.click(await screen.findByRole("option", { name: /Plan a project…/ }));
    expect(await screen.findByRole("dialog", { name: "Plan a project with Kanbo" })).toBeInTheDocument();
  });

  it("New project › Plan it with Kanbo hands over with the name typed so far", async () => {
    at("/projects");
    await boot();
    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "New project" }));
    const sheet = await screen.findByRole("dialog", { name: "New project" });
    fireEvent.change(within(sheet).getByLabelText("Project name"), { target: { value: "Spring open day" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Plan it with Kanbo" }));
    const planner = await screen.findByRole("dialog", { name: "Plan a project with Kanbo" });
    await waitFor(() => expect((within(planner).getAllByRole("textbox")[0] as HTMLTextAreaElement).value).toContain("Spring open day"));
  });

  it("a project's ⋯ menu offers Add tasks with Kanbo", async () => {
    at("/p/p-launch");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Project actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add tasks with Kanbo" }));
    expect(await screen.findByRole("dialog", { name: "Add tasks with Kanbo" })).toBeInTheDocument();
  });
});

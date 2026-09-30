/* The identity-and-voice polish, through the whole app in demo mode: the
   project page's cover header, the directory's gallery, the Inbox's count
   during a visit, and Settings › Profile showing the demo person. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { store } from "./data/store";

const renderApp = () => render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()); };
const key = (k: string, opts: Record<string, unknown> = {}) => fireEvent.keyDown(document.body, { key: k, ...opts });
const at = (url: string) => window.history.replaceState(null, "", url);
const address = () => window.location.pathname + window.location.search;
const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  spies.splice(0).forEach((s) => s.mockRestore());
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("App: every project has its own identity", () => {
  it("a project page opens on its cover, its tile over the edge, its name once, and a way back to Projects", async () => {
    at("/p/p-launch");
    await boot();
    const h1 = await screen.findByRole("heading", { level: 1, name: "Q3 Product Launch" });
    const hero = h1.closest(".kph-hero") as HTMLElement;
    expect(hero).not.toBeNull();
    expect(hero.querySelector(".kpcover")).not.toBeNull();
    expect(hero.querySelector(".kptile[data-size='64']")?.textContent).toBe("🚀");
    expect(h1.textContent).toBe("Q3 Product Launch");                                 // no emoji or square beside it
    expect(within(hero).getByRole("button", { name: "Post update" })).toBeInTheDocument();
    fireEvent.click(within(hero).getByRole("link", { name: "Projects" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    await waitFor(() => expect(address()).toBe("/projects"));
  });

  it("the directory opens as a gallery of covers, with owners on the demo projects, and New project is secondary", async () => {
    at("/projects");
    await boot();
    const gallery = await within(screen.getByRole("main")).findByRole("list", { name: "Projects" });
    const launch = within(gallery).getByRole("link", { name: "Q3 Product Launch" }).closest("li")!;
    expect(launch.querySelector(".kpcover")).not.toBeNull();
    expect(within(launch as HTMLElement).getByRole("img", { name: /^People: Daniel Okai, / })).toBeInTheDocument();
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("button", { name: "New project" })).toHaveAttribute("data-variant", "secondary");
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    const table = await screen.findByRole("table", { name: "Projects" });
    expect(within(table).queryAllByText("No owner")).toHaveLength(0);                 // every demo project has one
  });

  it("the sidebar's project rows carry their tiles", async () => {
    await boot();
    const row = screen.getAllByText("Brand Refresh", { selector: ".kproj *" })[0].closest("button")!;
    expect(row.querySelector(".kptile")?.textContent).toBe("🎨");
  });
});

describe("App: the details the owner noticed", () => {
  it("Inbox's header counts what's new this visit, even as it's marked read", async () => {
    const now = new Date().toISOString();
    spies.push(vi.spyOn(store, "listActivity").mockResolvedValue([
      { id: "a-1", taskId: "t-1", taskTitle: "Deck", kind: "mention", detail: "Sana Rao", createdAt: now },
      { id: "a-2", taskId: "t-1", taskTitle: "Deck", kind: "assigned", detail: "Maya Lin", createdAt: now },
      { id: "a-3", taskId: "t-1", taskTitle: "Deck", kind: "comment", detail: "Theo Vance", createdAt: now, readAt: now },
    ]));
    spies.push(vi.spyOn(store, "markActivityRead").mockResolvedValue());
    await boot();
    key("g"); key("i");
    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("2 new")).toBeInTheDocument());
    expect(screen.queryByText("Nothing new")).not.toBeInTheDocument();
    key("g"); key("t");
    await screen.findByRole("heading", { level: 1, name: "My tasks" });
    key("g"); key("i");
    await screen.findByRole("heading", { level: 1, name: "Inbox" });
    await waitFor(() => expect(screen.getByText("Nothing new")).toBeInTheDocument());      // read on the last visit
  });

  it("Settings › Profile shows the demo person's name, in the sidebar's initials", async () => {
    await boot();
    key(",", { metaKey: true });
    const settings = await screen.findByRole("dialog", { name: /settings/i });
    fireEvent.click(within(settings).getByRole("tab", { name: /^Profile/ }));
    expect(await within(settings).findByLabelText("First name")).toHaveValue("Daniel");
    expect(within(settings).getByLabelText("Last name")).toHaveValue("Okai");
    expect(settings.querySelector(".kset-avatar")?.textContent).toBe("DO");
  });
});

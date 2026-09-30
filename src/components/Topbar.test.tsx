import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { Topbar, PageHeader } from "./Topbar";

const makeCreate = () => ({ onNewTask: vi.fn(), onQuickCapture: vi.fn(), onPasteNotes: vi.fn(), onImport: vi.fn(), onNewProject: vi.fn() });
const openCreateMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "More ways to create" }));
  return screen.getByRole("menu", { name: "Create" });
};

describe("PageHeader: a project's identity", () => {
  const project = { id: "p-launch", name: "Q3 Product Launch", emoji: "🚀", color: "oklch(0.62 0.116 225)" };

  it("runs the cover behind the header row, overlaps the 64px tile on its edge, and sets the name in 28px under it", () => {
    const onClick = vi.fn();
    const { container } = render(
      <PageHeader title="Q3 Product Launch" onSearch={vi.fn()} create={makeCreate()} titleAddon={<span>At risk</span>}
        actions={<button type="button">Post update</button>}
        identity={{ project, crumb: { label: "Projects", href: "/projects", onClick } }} />,
    );
    const header = container.querySelector(".kph")!;
    expect(header).toHaveAttribute("data-hero");
    const hero = container.querySelector(".kph-hero")!;
    expect(hero).toHaveClass("kp");
    expect((hero as HTMLElement).style.getPropertyValue("--p-h")).toBe("225");
    const cover = hero.querySelector(".kpcover-wrap")!;
    expect(cover).toHaveAttribute("data-size", "page");
    expect(cover.querySelector(".kptile[data-size='64'][data-ring='true']")?.textContent).toBe("🚀");
    // the name is the page's heading, once, with no emoji beside it
    const h1 = screen.getByRole("heading", { level: 1, name: "Q3 Product Launch" });
    expect(h1.closest(".kph-hero-body")).not.toBeNull();
    expect(h1.textContent).toBe("Q3 Product Launch");
    expect(screen.getByText("At risk").closest(".kph-hero-meta")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Post update" }).closest(".kph-hero-line")).not.toBeNull();
    // the way back, as a real link
    const crumb = screen.getByRole("link", { name: "Projects" });
    expect(crumb).toHaveAttribute("href", "/projects");
    fireEvent.click(crumb);
    expect(onClick).toHaveBeenCalledTimes(1);
    crumb.addEventListener("click", (e) => e.preventDefault());    // (jsdom can't open the new tab)
    fireEvent.click(crumb, { metaKey: true });
    expect(onClick).toHaveBeenCalledTimes(1);                       // a new tab, not a route change
    expect(screen.getByRole("button", { name: "Search or ask Kanbo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New task" })).toBeInTheDocument();
  });

  it("on a phone, the band scrolls away above the sticky row, which carries a 20px tile once stuck", () => {
    const { container } = render(<PageHeader title="Q3 Product Launch" onSearch={vi.fn()} create={makeCreate()} isMobile identity={{ project }} />);
    const band = container.querySelector(".kph-mcover")!;
    expect(band.querySelector(".kpcover-wrap")).not.toBeNull();
    expect(band.nextElementSibling).toHaveClass("kph-sentinel");                 // outside the sticky header
    expect(container.querySelector(".kph[data-mobile][data-hero] .kph-leading .kptile[data-size='20']")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Q3 Product Launch" })).toBeInTheDocument();
  });
});

describe("PageHeader", () => {
  it("draws the title as the page's heading, with its meta", () => {
    render(<PageHeader title="Today" meta="Wed 30 Sep" onSearch={vi.fn()} create={makeCreate()} />);
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    expect(screen.getByText("Wed 30 Sep")).toBeInTheDocument();
  });

  it("opens the palette from “Search or ask Kanbo”, which names its ⌘K shortcut", () => {
    const onSearch = vi.fn();
    render(<PageHeader title="Inbox" onSearch={onSearch} create={makeCreate()} />);
    const search = screen.getByRole("button", { name: "Search or ask Kanbo" });
    expect(search).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K");
    fireEvent.click(search);
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("creates a task from the New task button", () => {
    const create = makeCreate();
    render(<PageHeader title="Inbox" onSearch={vi.fn()} create={create} />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(create.onNewTask).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("lists every way to create behind the chevron, and each one runs and closes the menu", () => {
    const create = makeCreate();
    render(<PageHeader title="Inbox" onSearch={vi.fn()} create={create} />);
    const chevron = screen.getByRole("button", { name: "More ways to create" });
    expect(chevron).toHaveAttribute("aria-haspopup", "menu");
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    const menu = openCreateMenu();
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    const items = within(menu).getAllByRole("menuitem").map((m) => m.textContent);
    expect(items).toEqual(["New taskC", "Quick captureQ", "Paste notes → tasks", "Import tasks…", "New project"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Quick capture" }));
    expect(create.onQuickCapture).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(within(openCreateMenu()).getByRole("menuitem", { name: /Paste notes/ }));
    expect(create.onPasteNotes).toHaveBeenCalledTimes(1);
  });

  it("follows the menu-button keyboard pattern: focus moves in, arrows move, Escape closes back to the chevron", () => {
    render(<PageHeader title="Inbox" onSearch={vi.fn()} create={makeCreate()} />);
    const chevron = screen.getByRole("button", { name: "More ways to create" });
    chevron.focus();
    const menu = openCreateMenu();
    const [first, second] = within(menu).getAllByRole("menuitem");
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(chevron).toHaveFocus();
  });

  it("leaves New project out when it isn't offered", () => {
    const { onNewProject: _omit, ...create } = makeCreate();
    render(<PageHeader title="Inbox" onSearch={vi.fn()} create={create} />);
    const menu = openCreateMenu();
    expect(within(menu).getByRole("menuitem", { name: /Quick capture/ })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /New project/ })).not.toBeInTheDocument();
  });

  it("has neither New task nor the create menu for guests (create = null)", () => {
    render(<PageHeader title="Today" onSearch={vi.fn()} create={null} />);
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More ways to create" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search or ask Kanbo" })).toBeInTheDocument();
  });

  it("renders tabs as a nav with the current tab marked, and reports the tab picked", () => {
    const onTab = vi.fn();
    render(<PageHeader title="Projects" meta="Foundrise" onSearch={vi.fn()} create={makeCreate()} tabsLabel="Projects views" tabValue="projects" onTab={onTab}
      tabs={[{ id: "projects", label: "All" }, { id: "goals", label: "Goals" }, { id: "automations", label: "Rules", count: 3, secondary: true }]} />);
    const nav = screen.getByRole("navigation", { name: "Projects views" });
    expect(within(nav).getByRole("button", { name: "All" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: "Goals" })).not.toHaveAttribute("aria-current");
    fireEvent.click(within(nav).getByRole("button", { name: /Rules/ }));
    expect(onTab).toHaveBeenCalledWith("automations");
  });

  it("draws the switcher as a labelled group", () => {
    const onChange = vi.fn();
    render(<PageHeader title="Today" onSearch={vi.fn()} create={makeCreate()}
      switcher={{ label: "Today view", value: "plan", onChange, items: [{ id: "plan", label: "Day" }, { id: "myweek", label: "Week" }, { id: "calendar", label: "Month" }] }} />);
    const group = screen.getByRole("group", { name: "Today view" });
    expect(within(group).getByRole("button", { name: "Day" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(group).getByRole("button", { name: "Week" }));
    expect(onChange).toHaveBeenCalledWith("myweek");
  });

  it("shows momentum as a labelled progress bar, and nothing when it's null", () => {
    const { rerender } = render(<PageHeader title="Today" onSearch={vi.fn()} create={null} momentum={0.29} momentumLabel="Today's work done, 2 of 7" />);
    const bar = screen.getByRole("progressbar", { name: "Today's work done, 2 of 7" });
    expect(bar).toHaveAttribute("aria-valuenow", "29");
    rerender(<PageHeader title="Today" onSearch={vi.fn()} create={null} momentum={null} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("on a phone: search and the account button, and no New task (the bottom bar's + captures)", () => {
    const onSearch = vi.fn(), onOpenSettings = vi.fn();
    render(<PageHeader title="Today" meta="Wed 30 Sep" onSearch={onSearch} create={makeCreate()} isMobile onOpenSettings={onOpenSettings} userId="nobody" />);
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search or ask Kanbo" }));
    expect(onSearch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
  });
});

describe("PageHeader layout", () => {
  const headerCss = () => Array.from(document.querySelectorAll("style")).map((el) => el.textContent ?? "").find((t) => t.includes(".kph-row"))!;
  afterEach(() => { vi.unstubAllGlobals(); });

  it("gives way by its own width (the docked task panel narrows it, not the window)", () => {
    render(<PageHeader title="Today" onSearch={vi.fn()} create={makeCreate()} />);
    const css = headerCss();
    expect(css).toMatch(/\.kph:not\(\[data-mobile\]\) \{[^}]*container: kph \/ inline-size/);
    expect(css).toMatch(/@container kph \(max-width: \d+px\) \{[^}]*\.kph-search \{ display: none; \}/);
    // (window-width folding only where container queries aren't supported)
    const outside = css.replace(/@supports not \(container-type: inline-size\) \{[\s\S]*?\n\}/, "");
    expect(outside).not.toMatch(/@media \(max-width: 1[02]\d\dpx\)/);
  });

  it("keeps New task named when a narrow header draws it as a bare +", () => {
    render(<PageHeader title="Today" onSearch={vi.fn()} create={makeCreate()} />);
    const btn = screen.getByRole("button", { name: "New task" });
    expect(btn).toHaveAttribute("aria-keyshortcuts", "C");
    expect(btn).toHaveAttribute("data-tip", "New task");
  });

  it("puts the title add-on after the title block, which outranks it: the add-on has only the room the title leaves", () => {
    render(<PageHeader title="Q4 Launch" titleAddon={<span>On track</span>} actions={<button type="button">Post update</button>}
      onSearch={vi.fn()} create={makeCreate()} />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Q4 Launch" });
    const addon = screen.getByText("On track").closest(".kph-addon")!;
    expect(addon).not.toBeNull();
    expect(h1.closest(".kph-lead")!.contains(addon)).toBe(false);
    expect(h1.compareDocumentPosition(addon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const css = headerCss();
    expect(css).toMatch(/\.kph\[data-addon\] \.kph-lead \{ flex: 0 0 auto; max-width: 100%; \}/);
    expect(css).toMatch(/\.kph-addon \{[^}]*flex: 0 1 auto; min-width: 0;[^}]*overflow: hidden/);
  });

  it("hides the add-on while it can't be drawn whole, rather than cutting it", () => {
    let report: () => void = () => {};
    vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { report = cb; } observe() {} disconnect() {} });
    render(<PageHeader title="Q4 Launch" titleAddon={<span>On track</span>} onSearch={vi.fn()} create={null} />);
    const addon = screen.getByText("On track").closest(".kph-addon") as HTMLElement;
    Object.defineProperty(addon, "clientWidth", { configurable: true, value: 80 });
    Object.defineProperty(addon, "scrollWidth", { configurable: true, value: 200 });
    act(() => report());
    expect(addon).toHaveAttribute("data-clipped");
    expect(headerCss()).toMatch(/\.kph-addon\[data-clipped\] \{ visibility: hidden; \}/);
    Object.defineProperty(addon, "scrollWidth", { configurable: true, value: 80 });
    act(() => report());
    expect(addon).not.toHaveAttribute("data-clipped");
  });

  it("on a phone: opaque from the first pixel of scroll, 44px from the eighth, without changing the page's height", () => {
    let report: (e: Partial<IntersectionObserverEntry>) => void = () => {};
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: (entries: Partial<IntersectionObserverEntry>[]) => void) { report = (e) => cb([e]); }
      observe() {} disconnect() {}
    });
    const { container } = render(<PageHeader title="Today" onSearch={vi.fn()} create={null} isMobile />);
    const header = container.querySelector("header.kph")!;
    act(() => report({ isIntersecting: true, intersectionRatio: 1 }));
    expect(header).not.toHaveAttribute("data-scrolled");
    expect(header).not.toHaveAttribute("data-stuck");
    act(() => report({ isIntersecting: true, intersectionRatio: 0.5 }));
    expect(header).toHaveAttribute("data-scrolled");
    expect(header).not.toHaveAttribute("data-stuck");
    act(() => report({ isIntersecting: false, intersectionRatio: 0 }));
    expect(header).toHaveAttribute("data-stuck", "true");
    act(() => report({ isIntersecting: true, intersectionRatio: 1 }));
    expect(header).not.toHaveAttribute("data-scrolled");
    // the 8px the row gives up becomes margin, so the layout below never moves
    const css = headerCss();
    expect(css).toMatch(/\.kph\[data-mobile\]\[data-stuck="true"\] \{ margin-bottom: 8px; \}/);
    expect(css).toMatch(/\.kph\[data-mobile\]\[data-stuck="true"\] > \.kph-row \{ height: 44px; \}/);
  });
});

describe("Topbar (legacy alias)", () => {
  it("draws the old props as a PageHeader: title, search, New task and New project", () => {
    const onCommand = vi.fn(), onNewTask = vi.fn(), onNewProject = vi.fn();
    render(<Topbar title="My tasks" subtitle="Foundrise" onCommand={onCommand} onNewTask={onNewTask} onNewProject={onNewProject} onBell={vi.fn()} theme="light" toggleTheme={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "My tasks" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search or ask Kanbo" }));
    expect(onCommand).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(onNewTask).toHaveBeenCalled();
    fireEvent.click(within(openCreateMenu()).getByRole("menuitem", { name: "New project" }));
    expect(onNewProject).toHaveBeenCalled();
    // the bell and the theme button moved out of the header
    expect(screen.queryByRole("button", { name: /^Notifications/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Switch to/ })).not.toBeInTheDocument();
  });

  it("offers New project only to people who can create projects, and nothing to create for guests", () => {
    const { unmount } = render(<Topbar title="Inbox" onCommand={vi.fn()} onNewTask={vi.fn()} onNewProject={vi.fn()} canCreateProject={false} />);
    expect(within(openCreateMenu()).queryByRole("menuitem", { name: "New project" })).not.toBeInTheDocument();
    unmount();
    render(<Topbar title="Inbox" onCommand={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import { CommandPalette, looksLikeAsk } from "./CommandPalette";
import { SETTLE_MS } from "./AskKanbo";
import { NewProjectModal } from "./NewProjectModal";
import { GO_TARGETS } from "../lib/nav";
import * as nlp from "../lib/nlp";
import type { AiOutcome, AskContext, AskResult } from "../lib/askTypes";
import type { ViewId } from "../app-types";
import type { Project, Task } from "../data/types";

vi.mock("../lib/nlp", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/nlp")>();
  return { ...real, parseTask: vi.fn(real.parseTask) };
});

const projects: Project[] = [
  { id: "p-q4", name: "Q4 Launch", emoji: "🚀", color: "blue", workspaceId: "ws-1" },
  { id: "p-arch", name: "Q4 Archive", emoji: "📦", color: "grey", workspaceId: "ws-1", archivedAt: "2026-01-01" },
];
const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
  id, title, description: "", status: "todo", priority: "medium", projectId: "p-q4", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...extra,
});

const open = (props: Partial<React.ComponentProps<typeof CommandPalette>> = {}) =>
  render(<CommandPalette open onClose={() => {}} onAction={() => {}} demoCorpus={false} {...props} />);
const input = () => screen.getByRole("combobox", { name: "Search or ask Kanbo" });
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const selected = () => screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");
const live = (c: HTMLElement) => c.querySelector('.kcmd [aria-live="polite"]');
/** Enter acts on an answer only once it has been on screen a moment: step the clock past that. */
const settle = () => { const later = Date.now() + SETTLE_MS + 1; vi.spyOn(Date, "now").mockReturnValue(later); };
/** A phone: touch first, no hover (until the test ends). */
let phone: { mockRestore: () => void } | null = null;
const asPhone = () => { phone = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
  matches: query.includes("pointer: coarse"), media: query, onchange: null,
  addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
}) as MediaQueryList); };

// Wednesday 30 Sep 2026: the week runs Mon 28 Sep – Sun 4 Oct
const ctx: AskContext = {
  today: "2026-09-30", me: "m-self",
  members: [{ id: "m-self", name: "Daniel Okai" }, { id: "m-1", name: "Maya Lin" }, { id: "m-3", name: "Sana Rao" }],
  projects: [{ id: "p-q4", name: "Q4 Launch" }],
};
const week: Task[] = [
  task("t1", "Send Idris the interview brief", { dueDate: "2026-09-28" }),
  task("t2", "Approve token naming", { dueDate: "2026-09-30" }),
  task("t3", "Draft investor update", { dueDate: "2026-10-02" }),
  task("t4", "Finalise launch deck", { status: "progress", dueDate: "2026-09-30" }),
  task("t5", "Ship onboarding redesign", { assigneeId: "m-1", status: "blocked", dueDate: "2026-10-01", dependencies: ["t2"] }),
];

afterEach(() => {
  vi.mocked(nlp.parseTask).mockRestore?.();
  vi.mocked(Date.now).mockRestore?.();
  phone?.mockRestore();
  phone = null;
});

describe("CommandPalette", () => {
  it("is an ARIA combobox driving a listbox", () => {
    open();
    const list = screen.getByRole("listbox");
    expect(input()).toHaveAttribute("aria-controls", list.id);
    expect(input()).toHaveAttribute("aria-expanded", "true");
    const first = within(list).getAllByRole("option")[0];
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(input()).toHaveAttribute("aria-activedescendant", first.id);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    const second = within(list).getAllByRole("option")[1];
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(input()).toHaveAttribute("aria-activedescendant", second.id);
  });

  it("closes on one Escape from the search box, and marks it handled so nothing underneath closes too", () => {
    const onClose = vi.fn();
    open({ onClose });
    type("rep");
    expect(fireEvent.keyDown(input(), { key: "Escape" })).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("jumps to a project (never an archived one) when onOpenProject is given", () => {
    const onOpenProject = vi.fn(); const onClose = vi.fn();
    open({ projects, onOpenProject, onClose });
    type("q4");
    const group = screen.getByRole("group", { name: "Projects" });
    expect(within(group).getAllByRole("option")).toHaveLength(1);
    expect(within(group).getByRole("option")).toHaveTextContent("Q4 Launch");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onOpenProject).toHaveBeenCalledWith("p-q4");
    expect(onClose).toHaveBeenCalled();
  });

  it("finds tasks, speaks their status and skips archived ones", () => {
    const onOpenTask = vi.fn();
    open({ tasks: [task("t1", "Invoice Acme", { status: "progress" }), task("t2", "Invoice old", { archivedAt: "2026-01-01" })], onOpenTask, projects });
    type("invoice");
    const group = screen.getByRole("group", { name: "Tasks" });
    const rows = within(group).getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("In progress");
    expect(rows[0]).toHaveTextContent("Q4 Launch");
    fireEvent.click(rows[0]);
    expect(onOpenTask).toHaveBeenCalledWith("t1");
  });

  it("can hand the query to Search", () => {
    const onSearchAll = vi.fn();
    open({ onSearchAll });
    type("budget");
    fireEvent.click(screen.getByRole("option", { name: /See all results for “budget” in Search/ }));
    expect(onSearchAll).toHaveBeenCalledWith("budget");
  });

  it("reaches every main view: Go to covers every page, and the old names still find them", () => {
    const views = new Set(GO_TARGETS.map((g) => g.route.view));
    const all: ViewId[] = ["plan", "home", "inbox", "tasks", "calendar", "team", "analytics", "reports", "search", "goals", "portfolios", "workload", "automations", "forms", "myweek", "projects", "pulse"];
    for (const v of all) expect(views, v).toContain(v);   // (a project is reached from the Projects group)

    const onGo = vi.fn();
    open({ onGo });
    const legacy: [string, ViewId][] = [
      ["home", "home"], ["plan my day", "plan"], ["analytics", "analytics"], ["reports", "reports"], ["automations", "automations"],
      ["forms", "forms"], ["calendar", "calendar"], ["portfolios", "portfolios"], ["goals", "goals"], ["okrs", "goals"],
      ["workload", "workload"], ["capacity", "workload"], ["search", "search"], ["smart lists", "search"], ["assigned to me", "search"],
      ["due today", "tasks"], ["overdue", "tasks"], ["my week", "myweek"], ["people", "team"], ["standup", "pulse"],
    ];
    for (const [q, view] of legacy) {
      type(q);
      fireEvent.click(within(screen.getByRole("group", { name: "Go to" })).getAllByRole("option")[0]);
      expect(onGo, q).toHaveBeenLastCalledWith(expect.objectContaining({ view }));
    }
    // tabs and lists survive the jump
    type("waiting on");
    fireEvent.click(within(screen.getByRole("group", { name: "Go to" })).getAllByRole("option")[0]);
    expect(onGo).toHaveBeenLastCalledWith({ view: "tasks", tab: "waiting" });
  });

  it("falls back to onNavigate(view) when onGo isn't given", () => {
    const onNavigate = vi.fn();
    open({ onNavigate });
    type("workload");
    fireEvent.click(within(screen.getByRole("group", { name: "Go to" })).getAllByRole("option")[0]);
    expect(onNavigate).toHaveBeenLastCalledWith("workload");
  });

  it("hides New project from people who can't create projects (guests)", () => {
    const { unmount } = open();
    type("new project");
    expect(screen.getByRole("option", { name: /New project/ })).toBeInTheDocument();
    unmount();
    open({ canCreateProject: false });
    type("new project");
    expect(screen.queryByRole("option", { name: /New project/ })).not.toBeInTheDocument();
  });

  it("offers the new actions with their keys, and never a sparkle", () => {
    const onAction = vi.fn();
    const { container } = open({ onAction });
    for (const label of ["New task", "Quick capture", "Paste notes → tasks", "Plan my day", "Prioritise my tasks", "Start focus", "Shut down my day", "Toggle theme", "Open settings", "Manage tags", "Keyboard shortcuts", "Import tasks"]) {
      expect(within(screen.getByRole("group", { name: "Actions" })).getByRole("option", { name: new RegExp(label) })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("option", { name: /Shut down my day/ }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: "shutdown" }));
    // the sparkles icon path never appears: Kanbo's own mark stands for AI
    expect(container.querySelector('path[d^="M12 3l1.6 4.4"]')).toBeNull();
  });

  it("guests don't get actions that create or change work", () => {
    open({ canAct: false });
    const actions = within(screen.getByRole("group", { name: "Actions" }));
    expect(actions.queryByRole("option", { name: /New task/ })).not.toBeInTheDocument();
    expect(actions.queryByRole("option", { name: /Import tasks/ })).not.toBeInTheDocument();
    expect(actions.getByRole("option", { name: /Open settings/ })).toBeInTheDocument();
  });

  it("shows recent places and tasks when nothing is typed", () => {
    const onGo = vi.fn(); const onOpenTask = vi.fn();
    open({ onGo, onOpenTask, tasks: week, recent: [{ view: "tasks", tab: "waiting" }, { view: "project", projectId: "p-q4" }], recentTaskIds: ["t3"], projects });
    const recent = within(screen.getByRole("group", { name: "Recent" }));
    const rows = recent.getAllByRole("option");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Waiting on"), expect.stringContaining("Q4 Launch"), expect.stringContaining("Draft investor update")]);
    fireEvent.click(rows[0]);
    expect(onGo).toHaveBeenCalledWith({ view: "tasks", tab: "waiting" });
  });

  it("goes to the five places when nothing is typed (Insights stands in for Team in Personal)", () => {
    const { unmount } = open();
    const go = () => within(screen.getByRole("group", { name: "Go to" })).getAllByRole("option").map((o) => o.textContent);
    expect(go()).toEqual([
      expect.stringContaining("Today"), expect.stringContaining("Inbox"), expect.stringContaining("My tasks"),
      expect.stringContaining("Projects"), expect.stringMatching(/^Team/),
    ]);
    unmount();
    open({ personal: true });
    expect(go()[4]).toMatch(/^Insights/);
  });

  // Picking an action closes the palette in the same update that opens the
  // next dialog; closing that dialog must still hand focus back to where you
  // were before the palette, not drop it onto the page.
  it("hands focus back to where you started after the dialog an action opened closes", async () => {
    function Page() {
      const [cmd, setCmd] = useState(false);
      const [np, setNp] = useState(false);
      return (
        <>
          <button onClick={() => setCmd(true)}>Board card</button>
          <CommandPalette open={cmd} onClose={() => setCmd(false)} onAction={(s) => { if (s.id === "new-project") setNp(true); }} demoCorpus={false} />
          <NewProjectModal open={np} onClose={() => setNp(false)} onCreate={() => {}} workspaceId={null} />
        </>
      );
    }
    render(<Page />);
    const card = screen.getByText("Board card");
    act(() => card.focus());
    fireEvent.click(card);
    type("new project");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "Project name" })).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });   // the modal's delayed focus
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(card).toHaveFocus();
  });
});

describe("Ask Kanbo", () => {
  it("knows what reads like a question or an instruction", () => {
    for (const q of ["what's overdue", "deck?", "Move the deck to Friday", "who is on it", "summarise the launch", "plan my day"]) expect(looksLikeAsk(q), q).toBe(true);
    for (const q of ["deck", "planning doc", "q4", "new project", ""]) expect(looksLikeAsk(q), q).toBe(false);
  });

  it("puts Ask first and picks it for a question; a plain search picks the first result", () => {
    open({ tasks: week });
    type("deck");
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Ask Kanbo: “deck”");
    expect(selected()).toHaveTextContent("Finalise launch deck");
    type("what's due today?");
    expect(selected()).toHaveTextContent("Ask Kanbo: “what's due today?”");
    type("move the deck to friday");
    expect(selected()).toHaveTextContent("Ask Kanbo: “move the deck to friday”");
  });

  it("Tab swaps between the Ask row and the first result", () => {
    open({ tasks: week });
    type("deck");
    expect(selected()).toHaveTextContent("Finalise launch deck");
    expect(fireEvent.keyDown(input(), { key: "Tab" })).toBe(false);
    expect(selected()).toHaveTextContent("Ask Kanbo");
    fireEvent.keyDown(input(), { key: "Tab" });
    expect(selected()).toHaveTextContent("Finalise launch deck");
  });

  it("asks when nothing else matches", () => {
    open({ tasks: week, askContext: ctx });
    type("zzqx");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText(/No tasks, projects or pages match/)).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Enter" });
    const region = screen.getByRole("region", { name: "Kanbo's answer" });
    expect(region).toHaveTextContent(/I can find, move, assign and mark tasks on-device/);
    // the help isn't drawn from the tasks, so it makes no "How I got here" claim
    expect(region).not.toHaveTextContent("How I got here");
  });

  it("with Search on offer (as the app has it), nothing matching still goes to Kanbo", () => {
    const onSearchAll = vi.fn();
    const { container, unmount } = open({ tasks: week, askContext: ctx, onSearchAll });
    type("zzqx");
    expect(selected()).toHaveTextContent("Ask Kanbo: “zzqx”");
    expect(screen.getByText("No tasks, projects or pages match “zzqx”. Press Enter to ask Kanbo.")).toBeInTheDocument();
    expect(live(container)).toHaveTextContent("No results. Press Enter to ask Kanbo.");
    // "See all results" is still there, one Tab away
    fireEvent.keyDown(input(), { key: "Tab" });
    expect(selected()).toHaveTextContent("See all results for “zzqx” in Search");
    fireEvent.keyDown(input(), { key: "Tab" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByRole("region", { name: "Kanbo's answer" })).toBeInTheDocument();
    expect(onSearchAll).not.toHaveBeenCalled();
    unmount();
    // a query that only names a project picks the project, not "See all results"
    open({ projects, onOpenProject: vi.fn(), onSearchAll });
    type("launch");
    expect(selected()).toHaveTextContent("Q4 Launch");
    expect(screen.queryByText(/No tasks, projects or pages match/)).not.toBeInTheDocument();
  });

  it("opened to ask: the examples lead, and whatever is typed goes to Kanbo", () => {
    open({ tasks: week, askContext: ctx, askFirst: true });
    expect(input()).toHaveAttribute("placeholder", "Ask Kanbo about your work…");
    expect(screen.getAllByRole("group")[0]).toHaveAccessibleName("Ask Kanbo");
    expect(selected()).toHaveTextContent("What's overdue?");
    type("deck");
    expect(selected()).toHaveTextContent("Ask Kanbo: “deck”");
    fireEvent.keyDown(input(), { key: "Tab" });
    expect(selected()).toHaveTextContent("Finalise launch deck");
  });

  it("renders the model's diff: old struck through, new, on vellum, with usage in the footer", async () => {
    const ai = vi.fn(async (): Promise<AiOutcome<AskResult>> => ({
      source: "ai", usage: { used: 3, limit: 200 },
      data: {
        source: "ai", answer: "Two of your tasks due this week haven't been started. I'll move them to Monday 5 Oct.",
        cites: ["t1", "t2"],
        actions: [
          { op: "update", id: "t1", patch: { dueDate: "2026-10-05" } },
          { op: "update", id: "t2", patch: { dueDate: "2026-10-05" } },
          { op: "delete", id: "t3" } as never,
        ],
      },
    }));
    const { container } = open({ tasks: week, ai, askContext: ctx, onApplyAsk: vi.fn() });
    type("move my unstarted tasks this week to monday");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByText("Kanbo is reading 5 tasks…")).toBeInTheDocument();
    const answer = await screen.findByText(/I'll move them to Monday 5 Oct/, { selector: ".kask-answer" });
    expect(ai).toHaveBeenCalledWith("move my unstarted tasks this week to monday", week, ctx);
    expect(answer.closest(".kvellum")).not.toBeNull();
    const diff = screen.getByRole("list", { name: "Proposed changes" });
    const rows = within(diff).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Send Idris the interview brief");
    expect(within(rows[0]).getByText("Mon 28 Sep", { exact: false }).closest(".kask-old")).not.toBeNull();
    expect(rows[1]).toHaveTextContent(/Due\s*from Wed 30 Sep\s*to Mon 5 Oct/);
    // the delete never reaches the diff, and the person is told
    expect(screen.getByText(/Kanbo left out 1 change: Kanbo never deletes tasks/)).toBeInTheDocument();
    // a moved blocker warns about the task waiting on it
    expect(screen.getByText(/unblocks Maya's “Ship onboarding redesign”/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Apply 2 changes/ })).toBeInTheDocument();
    expect(screen.getByText("Kanbo AI · 3 of 200 today")).toBeInTheDocument();
    expect(container.querySelector('path[d^="M12 3l1.6 4.4"]')).toBeNull();
  });

  it("Apply sends only the rows still checked, then closes", async () => {
    const onApplyAsk = vi.fn(); const onClose = vi.fn();
    const ai = vi.fn(async (): Promise<AiOutcome<AskResult>> => ({
      source: "ai",
      data: { source: "ai", answer: "Moving three.", actions: [
        { op: "update", id: "t1", patch: { dueDate: "2026-10-05" } },
        { op: "update", id: "t2", patch: { dueDate: "2026-10-05" } },
        { op: "update", id: "t3", patch: { priority: "high" } },
      ] },
    }));
    open({ tasks: week, ai, askContext: ctx, onApplyAsk, onClose });
    type("move them");
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByText("Moving three.");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include “Approve token naming”" }));
    expect(screen.getByRole("button", { name: /Apply 2 changes/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Apply 2 changes/ }));
    expect(onApplyAsk).toHaveBeenCalledWith([
      { op: "update", id: "t1", patch: { dueDate: "2026-10-05" } },
      { op: "update", id: "t3", patch: { priority: "high" } },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("“Keep it” drops the change a heads-up is about", () => {
    const onApplyAsk = vi.fn();
    open({ tasks: week, askContext: ctx, onApplyAsk });
    type("move my unstarted tasks this week to monday");
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Keep it: Approve token naming" }), { detail: 1 });
    expect(within(screen.getByRole("list", { name: "Proposed changes" })).getAllByRole("listitem")).toHaveLength(2);
    expect(input()).toHaveFocus();   // after a click, back to the field
    settle();
    fireEvent.keyDown(input(), { key: "Enter" });   // Enter applies
    expect(onApplyAsk).toHaveBeenCalledWith([
      { op: "update", id: "t1", patch: { dueDate: "2026-10-05" } },
      { op: "update", id: "t3", patch: { dueDate: "2026-10-05" } },
    ]);
  });

  it("works on-device in demo: moves the unstarted tasks, leaves work under way alone", () => {
    const onApplyAsk = vi.fn();
    open({ tasks: week, askContext: ctx, onApplyAsk });
    type("move my unstarted tasks this week to monday");
    fireEvent.keyDown(input(), { key: "Enter" });
    const region = screen.getByRole("region", { name: "Kanbo's answer" });
    expect(region).toHaveTextContent("Three of your tasks due this week haven't been started. I'll move them to Monday 5 Oct. “Finalise launch deck” is already under way, so I've left it alone.");
    expect(region.querySelector(".kvellum")).toBeNull();   // vellum is only for the model's words
    expect(region).toHaveTextContent("Answered on-device — Kanbo AI is off.");
    expect(within(region).getAllByText("Mon 5 Oct", { exact: false })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /Apply 3 changes/ }));
    expect(onApplyAsk).toHaveBeenCalledWith([
      { op: "update", id: "t1", patch: { dueDate: "2026-10-05" } },
      { op: "update", id: "t2", patch: { dueDate: "2026-10-05" } },
      { op: "update", id: "t3", patch: { dueDate: "2026-10-05" } },
    ]);
  });

  it("falls back on-device when the model is unavailable or at the daily limit", async () => {
    const ai = vi.fn(async (): Promise<AiOutcome<AskResult>> => ({ data: null, source: "unavailable" }));
    const { unmount } = open({ tasks: week, ai, askContext: ctx, onApplyAsk: vi.fn() });
    type("what's overdue?");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByText("Answered on-device — Kanbo AI is unavailable.")).toBeInTheDocument();
    expect(screen.getByText("One of your tasks is overdue: “Send Idris the interview brief”.", { selector: ".kask-answer" })).toBeInTheDocument();
    unmount();
    const limited = vi.fn(async (): Promise<AiOutcome<AskResult>> => ({ data: null, source: "limit", detail: "daily_limit 200" }));
    open({ tasks: week, ai: limited, askContext: ctx });
    type("what's overdue?");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByText("You've used today's 200 AI requests — on-device answers until midnight.")).toBeInTheDocument();
  });

  it("treats a malformed model answer as unavailable", async () => {
    const ai = vi.fn(async () => ({ source: "ai", data: { answer: "", actions: "nope" } }) as unknown as AiOutcome<AskResult>);
    open({ tasks: week, ai, askContext: ctx });
    type("what's overdue?");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByText("Answered on-device — Kanbo AI is unavailable.")).toBeInTheDocument();
  });

  it("an answer without changes lists its tasks to open", () => {
    const onOpenTask = vi.fn(); const onClose = vi.fn();
    open({ tasks: week, askContext: ctx, onOpenTask, onClose, onApplyAsk: vi.fn() });
    type("what's due today?");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.queryByRole("button", { name: /Apply/ })).not.toBeInTheDocument();
    const cites = within(screen.getByRole("list", { name: "Tasks in this answer" })).getAllByRole("button");
    expect(cites.map((b) => b.textContent)).toEqual([expect.stringContaining("Approve token naming"), expect.stringContaining("Finalise launch deck")]);
    fireEvent.click(cites[1]);
    expect(onOpenTask).toHaveBeenCalledWith("t4");
    expect(onClose).toHaveBeenCalled();
  });

  it("“plan my day” offers to go to Today, and Enter follows it", () => {
    const onGo = vi.fn();
    open({ tasks: week, askContext: ctx, onGo, onApplyAsk: vi.fn() });
    type("plan my day");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByRole("button", { name: /Go to Today/ })).toBeInTheDocument();
    settle();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onGo).toHaveBeenCalledWith({ view: "plan" });
  });

  it("Enter applies only once the answer has been on screen a moment, and never on a held key", () => {
    const onApplyAsk = vi.fn();
    open({ tasks: week, askContext: ctx, onApplyAsk });
    type("move my unstarted tasks this week to monday");
    fireEvent.keyDown(input(), { key: "Enter" });   // asks: the on-device answer is there at once
    fireEvent.keyDown(input(), { key: "Enter" });   // a double press
    expect(onApplyAsk).not.toHaveBeenCalled();
    settle();
    fireEvent.keyDown(input(), { key: "Enter", repeat: true });   // the key still held down
    expect(onApplyAsk).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onApplyAsk).toHaveBeenCalledTimes(1);
  });

  it("on a phone, asking puts the keyboard away, and the return key never applies", () => {
    asPhone();
    const onApplyAsk = vi.fn();
    const { container } = open({ tasks: week, askContext: ctx, onApplyAsk });
    expect(input()).toHaveAttribute("enterkeyhint", "go");
    type("move my unstarted tasks this week to monday");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByRole("region", { name: "Kanbo's answer" })).toHaveFocus();
    expect(input()).not.toHaveAttribute("enterkeyhint");
    expect(live(container)).toHaveTextContent(/3 changes to review\.$/);   // no "Press Enter" on a phone
    settle();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onApplyAsk).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Apply 3 changes/ }));
    expect(onApplyAsk).toHaveBeenCalledTimes(1);
  });

  it("applies what was on screen, even when the workspace changes while the answer is open", async () => {
    const onApplyAsk = vi.fn();
    const withBrand: AskContext = { ...ctx, projects: [...ctx.projects, { id: "p-brand", name: "Brand Refresh" }] };
    const ai = vi.fn(async (): Promise<AiOutcome<AskResult>> => ({
      source: "ai",
      data: { source: "ai", answer: "Shuffling.", actions: [
        { op: "update", id: "t1", patch: { projectId: "p-brand" } },
        { op: "update", id: "t2", patch: { priority: "high" } },
        { op: "update", id: "t3", patch: { priority: "urgent" } },
      ] },
    }));
    const props = { open: true, onClose: () => {}, onAction: () => {}, tasks: week, ai, onApplyAsk };
    const { rerender } = render(<CommandPalette {...props} demoCorpus={false} askContext={withBrand} />);
    type("shuffle them?");
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByText("Shuffling.");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include “Approve token naming”" }));
    // Brand Refresh is archived by someone else meanwhile: nothing on screen shifts, and what was left out stays out
    rerender(<CommandPalette {...props} demoCorpus={false} askContext={{ ...ctx }} />);
    expect(within(screen.getByRole("list", { name: "Proposed changes" })).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /Apply 2 changes/ }));
    expect(onApplyAsk).toHaveBeenCalledWith([
      { op: "update", id: "t1", patch: { projectId: "p-brand" } },
      { op: "update", id: "t3", patch: { priority: "urgent" } },
    ]);
  });

  it("without a way to apply, it doesn't promise a change, and still goes places", () => {
    const onGo = vi.fn();
    open({ tasks: week, askContext: ctx, onGo });
    type("move my unstarted tasks this week to monday");
    fireEvent.keyDown(input(), { key: "Enter" });
    const region = screen.getByRole("region", { name: "Kanbo's answer" });
    expect(region.querySelector(".kask-answer")).toHaveTextContent(/Moving them to Monday 5 Oct needs edit access\./);
    expect(within(region).queryByRole("button", { name: /Apply/ })).not.toBeInTheDocument();
    type("plan my day");
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /Go to Today/ }));
    expect(onGo).toHaveBeenCalledWith({ view: "plan" });
  });

  it("tells screen readers (and the footer) only what can really be applied", async () => {
    const answer = (text: string, actions: unknown[]) => vi.fn(async (): Promise<AiOutcome<AskResult>> => ({
      source: "ai", data: { source: "ai", answer: text, actions: actions as AskResult["actions"] },
    }));
    // one change a task it wasn't asked about, one that changes nothing: neither can be applied
    const none = answer("Moving two.", [
      { op: "update", id: "not-sent", patch: { dueDate: "2026-10-05" } },
      { op: "update", id: "t1", patch: { dueDate: "2026-09-28" } },
    ]);
    const first = open({ tasks: week, ai: none, askContext: ctx, onApplyAsk: vi.fn() });
    type("move them?");
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByText("Moving two.", { selector: ".kask-answer" });
    expect(live(first.container)).toHaveTextContent(/^Moving two\. Kanbo left out 1 change\.$/);
    expect(first.container.querySelector(".kcmd-foot")).not.toHaveTextContent("apply");
    first.unmount();
    // 30 proposed, 25 allowed: the count is the one on the button
    const many = Array.from({ length: 30 }, (_, i) => task(`x${i}`, `Task ${i}`, { dueDate: "2026-10-01" }));
    const lots = answer("Moving thirty.", many.map((t) => ({ op: "update", id: t.id, patch: { dueDate: "2026-10-05" } })));
    const second = open({ tasks: many, ai: lots, askContext: ctx, onApplyAsk: vi.fn() });
    type("move them?");
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByText("Moving thirty.", { selector: ".kask-answer" });
    expect(live(second.container)).toHaveTextContent(/^Moving thirty\. 25 changes to review\. Press Enter to apply\. Kanbo left out 5 changes\.$/);
    expect(screen.getByRole("button", { name: /Apply 25 changes/ })).toBeInTheDocument();
    expect(second.container.querySelector(".kcmd-foot")).toHaveTextContent("apply");
    // leave every change out: the footer stops offering Enter
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    for (const box of screen.getAllByRole("checkbox", { name: /^Include/ })) fireEvent.click(box);
    expect(screen.getByRole("button", { name: "Nothing to apply" })).toBeDisabled();
    expect(second.container.querySelector(".kcmd-foot")).not.toHaveTextContent("apply");
  });

  it("“Keep it” from the keyboard moves on to the next heads-up, then to Apply", async () => {
    const ai = vi.fn(async (): Promise<AiOutcome<AskResult>> => ({
      source: "ai",
      data: { source: "ai", answer: "Three changes.", actions: [
        { op: "update", id: "t2", patch: { dueDate: "2026-10-05" } },   // blocks Maya's work
        { op: "update", id: "t5", patch: { priority: "high" } },        // Maya's task
        { op: "update", id: "t3", patch: { priority: "high" } },
      ] },
    }));
    open({ tasks: week, ai, askContext: ctx, onApplyAsk: vi.fn() });
    type("tidy up?");
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByText("Three changes.", { selector: ".kask-answer" });
    const keep = screen.getByRole("button", { name: "Keep it: Approve token naming" });
    act(() => keep.focus());
    fireEvent.click(keep);   // Enter or Space on the button
    expect(screen.getByRole("button", { name: "Leave it: Ship onboarding redesign" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Leave it: Ship onboarding redesign" }));
    expect(screen.getByRole("button", { name: /Apply 1 change/ })).toHaveFocus();
  });

  it("says so when every change has been kept as it was, with Edit to bring them back", () => {
    open({ tasks: week, askContext: ctx, onApplyAsk: vi.fn() });
    type("assign “Ship onboarding redesign” to Daniel");
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Leave it: Ship onboarding redesign" }));
    expect(screen.queryByRole("list", { name: "Proposed changes" })).not.toBeInTheDocument();
    expect(screen.getByText("Every change is left out. Edit brings them back.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nothing to apply" })).toBeDisabled();
    expect(input()).toHaveFocus();   // nothing left in the card to move on to
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include “Ship onboarding redesign”" }));
    expect(screen.getByRole("button", { name: "Apply 1 change" })).toBeEnabled();
  });

  it("a new task keeps its “New task” pill however long its title", async () => {
    const long = "Write the onboarding checklist for the new cohort of design contractors starting in October";
    const ai = vi.fn(async (): Promise<AiOutcome<AskResult>> => ({
      source: "ai", data: { source: "ai", answer: "Adding one.", actions: [{ op: "create", task: { title: long, dueDate: "2026-10-05" } }] },
    }));
    open({ tasks: week, ai, askContext: ctx, onApplyAsk: vi.fn() });
    type("add it?");
    fireEvent.keyDown(input(), { key: "Enter" });
    const pill = await screen.findByText("New task");
    // the title truncates on its own; the pill sits beside it and never shrinks away
    expect(pill.closest(".kask-title")).toBeNull();
    expect(pill.parentElement).toHaveClass("kask-titlewrap");
    expect(pill.parentElement!.querySelector(".kask-title")).toHaveTextContent(long);
  });

  it("a guest can ask but never sees Apply", async () => {
    const onApplyAsk = vi.fn();
    const { unmount } = open({ tasks: week, askContext: ctx, onApplyAsk, canAct: false });
    type("move my unstarted tasks this week to monday");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByText(/Moving them to Monday 5 Oct needs edit access/, { selector: ".kask-answer" })).toBeInTheDocument();
    expect(screen.getByText("Guests can ask, not change.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Apply/ })).not.toBeInTheDocument();
    settle();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onApplyAsk).not.toHaveBeenCalled();
    // a guest can still be taken to Today, without being asked to firm up a plan
    type("plan my day");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByText(/Your day is laid out on Today\.$/, { selector: ".kask-answer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Go to Today/ })).toBeInTheDocument();
    unmount();
    // the model may still propose changes: they're never shown, and the guest is told why
    const ai = vi.fn(async (): Promise<AiOutcome<AskResult>> => ({
      source: "ai", data: { source: "ai", answer: "I'll move them to Monday.", actions: [{ op: "update", id: "t1", patch: { dueDate: "2026-10-05" } }] },
    }));
    open({ tasks: week, askContext: ctx, onApplyAsk, canAct: false, ai });
    type("move my unstarted tasks this week to monday");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(await screen.findByText("Guests can ask, not change.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Proposed changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Apply/ })).not.toBeInTheDocument();
  });

  it("Escape while Kanbo is reading cancels and ignores the late answer", async () => {
    let answer!: (v: AiOutcome<AskResult>) => void;
    const ai = vi.fn(() => new Promise<AiOutcome<AskResult>>((r) => { answer = r; }));
    const onClose = vi.fn();
    open({ tasks: week, ai, askContext: ctx, onClose });
    type("what's overdue?");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByText(/Kanbo is reading 5 tasks…/)).toBeInTheDocument();
    expect(fireEvent.keyDown(input(), { key: "Escape" })).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(input()).toHaveValue("what's overdue?");
    await act(async () => { answer({ source: "ai", data: { source: "ai", answer: "Too late.", actions: [] } }); });
    expect(screen.queryByText("Too late.", { selector: ".kask-answer" })).not.toBeInTheDocument();
    // a second Escape closes
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("typing again goes back to the results", () => {
    open({ tasks: week, askContext: ctx });
    type("what's overdue?");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByRole("region", { name: "Kanbo's answer" })).toBeInTheDocument();
    type("what's overdue? and blocked");
    expect(screen.queryByRole("region", { name: "Kanbo's answer" })).not.toBeInTheDocument();
    expect(selected()).toHaveTextContent("Ask Kanbo");
  });

  it("the example questions ask straight away", async () => {
    open({ tasks: week, askContext: ctx });
    fireEvent.click(within(screen.getByRole("group", { name: "Ask Kanbo" })).getByRole("option", { name: /What's overdue/ }));
    expect(input()).toHaveValue("What's overdue?");
    await waitFor(() => expect(screen.getByRole("region", { name: "Kanbo's answer" })).toHaveTextContent("One of your tasks is overdue"));
  });

  it("highlights the tokens the grammar recognises", () => {
    vi.mocked(nlp.parseTask).mockImplementation((text: string) => ({
      title: text, spans: text.includes("friday") ? [{ start: text.indexOf("friday"), end: text.indexOf("friday") + 6, kind: "date", label: "Fri 2 Oct" }] : [],
    }));
    const { container } = open();
    type("move the deck to friday");
    const marks = container.querySelectorAll("mark.kcmd-tok");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("friday");
    expect(marks[0].parentElement).toHaveTextContent("move the deck to friday");
  });
});

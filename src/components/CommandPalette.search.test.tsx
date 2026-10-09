import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor, act } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import { setReferenceData } from "../data/data";
import { SEARCH_MARK_START as S, SEARCH_MARK_END as E } from "../lib/searchRows";
import { resetSearchServerMemory } from "../lib/search/useUniversalSearch";
import type { AskContext } from "../lib/askTypes";
import type { Comment, Member, Project, SearchHit, Task } from "../data/types";

const api = vi.hoisted(() => ({ searchAll: vi.fn() }));
vi.mock("../lib/searchApi", async (orig) => ({ ...(await orig<typeof import("../lib/searchApi")>()), searchAll: api.searchAll }));

const MEMBERS: Member[] = [
  { id: "m-self", name: "Daniel Okai", email: "daniel@kanbo.app", type: "self", color: "#888" },
  { id: "m-1", name: "Maya Lin", email: "maya@kanbo.app", type: "team", color: "#888" },
  { id: "m-3", name: "Sana Rao", email: "sana@kanbo.app", type: "team", color: "#888" },
];
const projects: Project[] = [
  { id: "p-q4", name: "Q4 Launch", emoji: "🚀", color: "blue", workspaceId: "ws-1", description: "The pricing page and the launch" },
];
const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
  id, title, description: "", status: "todo", priority: "medium", projectId: "p-q4", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, workspaceId: "ws-1", ...extra,
});
const ctx: AskContext = {
  today: "2026-10-09", me: "m-self",
  members: MEMBERS.map((m) => ({ id: m.id, name: m.name })),
  projects: [{ id: "p-q4", name: "Q4 Launch" }],
};
const tasks = [
  task("t1", "Pricing deck", { assigneeId: "m-1", status: "blocked" }),
  task("t2", "Pricing page copy"),
  task("t3", "Hiring plan", { assigneeId: "m-1" }),
];
const comments: Comment[] = [{ id: "c1", taskId: "t3", authorId: "m-3", authorName: "Sana Rao", body: "Check the pricing before we hire", createdAt: "2026-10-08T09:00:00Z" }];
const docs = [{ id: "d1", projectId: "p-q4", title: "Pricing brief", workspaceId: "ws-1", text: "Three tiers", icon: "🧭" }];

const open = (props: Partial<React.ComponentProps<typeof CommandPalette>> = {}) =>
  render(<CommandPalette open onClose={() => {}} onAction={() => {}} tasks={tasks} projects={projects} askContext={ctx} demoCorpus={false} {...props} />);
const input = () => screen.getByRole("combobox", { name: "Search or ask Kanbo" });
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const selected = () => screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");
const hit = (o: Partial<SearchHit>): SearchHit => ({ kind: "task", id: "x", title: "x", snippet: null, rank: 0.5, taskId: null, projectId: null, workspaceId: "ws-1", updatedAt: null, source: "server", ...o });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  setReferenceData({ members: MEMBERS, projects });
  api.searchAll.mockReset();
  api.searchAll.mockResolvedValue([]);
  resetSearchServerMemory();
});
afterEach(() => { vi.useRealTimers(); });

describe("⌘K search", () => {
  it("reads the words like Search does: names and statuses narrow the tasks", () => {
    open();
    type("Maya's blocked");
    const group = screen.getByRole("group", { name: "Tasks" });
    expect(within(group).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Pricing deck")]);
  });

  it("finds comments, docs and people too, marks the words, and opens each in its place", () => {
    const onGo = vi.fn(), onOpenTask = vi.fn(), onClose = vi.fn();
    open({ comments, docs, onGo, onOpenTask, onClose });
    type("pric");
    const headed = screen.getAllByRole("group").map((g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent);
    expect(headed.slice(0, 3)).toEqual(["Tasks", "Docs", "Comments"]);
    const docRow = within(screen.getByRole("group", { name: "Docs" })).getByRole("option");
    expect(docRow).toHaveTextContent("Pricing brief");
    expect(within(docRow).getByText("Pric", { selector: "mark" })).toBeInTheDocument();
    const commentRow = within(screen.getByRole("group", { name: "Comments" })).getByRole("option");
    expect(commentRow).toHaveAccessibleName("“Check the pricing before we hire”, comment by Sana Rao on Hiring plan");
    fireEvent.click(docRow);
    expect(onGo).toHaveBeenCalledWith({ view: "project", projectId: "p-q4", tab: "docs", docId: "d1" });
    fireEvent.click(commentRow);
    expect(onOpenTask).toHaveBeenCalledWith("t3");
  });

  it("people: by name or the start of an email", () => {
    const onOpenPerson = vi.fn();
    open({ onOpenPerson });
    type("sana");
    const row = within(screen.getByRole("group", { name: "People" })).getByRole("option");
    expect(row).toHaveTextContent("Sana Rao");
    expect(row).toHaveTextContent("sana@kanbo.app");
    fireEvent.click(row);
    expect(onOpenPerson).toHaveBeenCalledWith("m-3");
  });

  it("only offers what can be opened", () => {
    open({ comments, docs });
    type("pricing");
    expect(screen.queryByRole("group", { name: "Docs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "People" })).not.toBeInTheDocument();
  });

  it("asks the server once typing pauses (a newer keystroke cancels the older), then adds its rows below the device's", async () => {
    api.searchAll.mockImplementation(async (text: string) => (text === "pricing" ? [
      hit({ kind: "doc", id: "d9", title: "Packaging and prices", projectId: "p-q4", snippet: `new ${S}prices${E}`, doc: { icon: null, projectName: "Q4 Launch", updatedBy: null, archived: false } }),
      hit({ id: "t2", title: "Pricing page copy" }),
    ] : []));
    open({ serverSearch: true, onGo: vi.fn() });
    type("pri"); type("pric"); type("pricing");
    // the device answers at once
    expect(within(screen.getByRole("group", { name: "Tasks" })).getAllByRole("option")).toHaveLength(2);
    expect(selected()).toHaveTextContent("Pricing deck");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(selected()).toHaveTextContent("Pricing page copy");
    await waitFor(() => expect(screen.getByRole("group", { name: "Docs" })).toBeInTheDocument());
    expect(api.searchAll).toHaveBeenCalledTimes(1);
    expect(api.searchAll.mock.calls[0][0]).toBe("pricing");
    expect(api.searchAll.mock.calls[0][2]).toMatchObject({ limit: 5 });
    // no duplicate of a task both found; the highlight stayed on its row
    expect(within(screen.getByRole("group", { name: "Tasks" })).getAllByRole("option")).toHaveLength(2);
    expect(selected()).toHaveTextContent("Pricing page copy");
    expect(within(screen.getByRole("group", { name: "Docs" })).getByRole("option")).toHaveTextContent("Packaging and prices");
  });

  it("before 0048 the device's answer stands, and the server isn't asked again this session", async () => {
    api.searchAll.mockRejectedValue(new Error("Could not find the function public.search_all in the schema cache"));
    open({ serverSearch: true });
    type("pricing");
    await waitFor(() => expect(api.searchAll).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    type("deck");
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(api.searchAll).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole("group", { name: "Tasks" })).getAllByRole("option")).toHaveLength(1);
  });

  it("in demo mode it searches the demo docs' text", async () => {
    setReferenceData({ members: MEMBERS });
    open({ demoCorpus: true, onGo: vi.fn(), projects: [{ id: "p-launch", name: "Q3 Product Launch", emoji: "🚀", color: "blue", workspaceId: "ws-foundrise" }] });
    type("seat");
    await waitFor(() => expect(screen.getByRole("group", { name: "Docs" })).toHaveTextContent("Decision log"));
  });
});

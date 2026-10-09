/* Projects › Recycle bin in demo mode (lib/trash's in-memory fakes). */
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RecycleBin, agoWords, binBucket, binContents, daysLeftLabel, listWords } from "./RecycleBin";
import { ToastProvider } from "../Toast";
import { MEMBERS, PROJECTS } from "../../data/data";
import { resetTrashDemo } from "../../lib/trash";
import type { Role } from "../../data/types";

const WS = "ws-foundrise";
const projects = PROJECTS.filter((p) => p.workspaceId === WS);
const status = () => screen.getByRole("status");
const rows = () => screen.queryAllByRole("listitem");
const row = (title: RegExp | string) => rows().find((r) => within(r).queryByText(title))!;

function renderBin(role: Role | null = "owner", over: Partial<Parameters<typeof RecycleBin>[0]> = {}) {
  const onRestored = vi.fn();
  const onOpenProject = vi.fn();
  const utils = render(
    <StrictMode>
      <RecycleBin workspaceId={role === null ? null : WS} workspaceName={role === null ? "Personal" : "Foundrise"} role={role} currentUserId="m-self"
        members={MEMBERS} projects={role === null ? PROJECTS.filter((p) => p.workspaceId === null) : projects}
        onRestored={onRestored} onOpenProject={onOpenProject} {...over} />
    </StrictMode>,
  );
  return { ...utils, onRestored, onOpenProject };
}

beforeEach(() => resetTrashDemo({ demoDelayMs: 0 }));

describe("words", () => {
  it("contents, lists, days left and ages", () => {
    const c = { tasks: 3, subtasks: 2, comments: 1, attachments: 4, checklist: 0, sections: 2, docs: 1 };
    expect(binContents(c, "task")).toEqual(["2 sub-tasks", "1 comment", "4 files"]);
    expect(binContents(c, "project")).toEqual(["3 tasks", "2 sections", "1 doc", "1 comment", "4 files"]);
    expect(listWords(["a", "b", "c"])).toBe("a, b and c");
    expect(listWords(["a"])).toBe("a");
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(daysLeftLabel("2026-11-08T12:00:00Z", now)).toEqual({ text: "30 days left", tone: null });
    expect(daysLeftLabel("2026-10-12T11:00:00Z", now)).toEqual({ text: "3 days left", tone: "warn" });
    expect(daysLeftLabel("2026-10-10T11:00:00Z", now)).toEqual({ text: "1 day left", tone: "signal" });
    expect(daysLeftLabel("2026-10-09T11:00:00Z", now)).toEqual({ text: "Going today", tone: "signal" });
    expect(agoWords("2026-10-09T11:35:00Z", now)).toBe("25 min ago");
    expect(agoWords("2026-10-08T10:00:00Z", now)).toBe("yesterday");
    expect(agoWords("2026-10-01T10:00:00Z", now)).toBe("8 days ago");
    const today = new Date(2026, 9, 9, 12);
    expect(binBucket(new Date(2026, 9, 9, 1).toISOString(), today)).toBe("today");
    expect(binBucket(new Date(2026, 9, 8, 23).toISOString(), today)).toBe("yesterday");
    expect(binBucket(new Date(2026, 9, 4).toISOString(), today)).toBe("week");
    expect(binBucket(new Date(2026, 8, 1).toISOString(), today)).toBe("older");
  });
});

describe("RecycleBin", () => {
  it("lists the workspace's deleted tasks and projects with what they hold, who deleted them and the days left", async () => {
    renderBin("owner");
    expect(screen.getByText(/wait here for 30 days/)).toBeInTheDocument();
    const press = await screen.findByText("Draft press release");
    const r = press.closest("li")!;
    expect(within(r).getByText("Task:")).toBeInTheDocument();
    expect(within(r).getByText("Q3 Product Launch")).toBeInTheDocument();
    expect(within(r).getByText(/2 sub-tasks · 4 comments/)).toBeInTheDocument();
    expect(within(r).getByText(/Deleted by Maya Lin/)).toBeInTheDocument();
    expect(within(r).getByText("30 days left")).toBeInTheDocument();
    expect(within(r).getByRole("button", { name: "Restore “Draft press release”" })).toBeInTheDocument();
    expect(within(r).getByRole("button", { name: "Delete “Draft press release” forever" })).toBeInTheDocument();
    // a project, a sub-task, one deleted by you, one by Kanbo, one whose project has gone, one nearly due
    expect(within(row("Webinar series")).getByText("Project:")).toBeInTheDocument();
    expect(within(row("Webinar series")).getByText(/9 tasks · 2 sections · 1 doc/)).toBeInTheDocument();
    expect(within(row("Book venue")).getByText("Sub-task of “Launch event”")).toBeInTheDocument();
    expect(within(row("Book venue")).getByText(/Deleted by you/)).toBeInTheDocument();
    expect(within(row(/Pricing FAQ/)).getByText(/Deleted by Kanbo/)).toBeInTheDocument();
    expect(within(row("Migrate blog posts")).getByText("Its project was deleted")).toBeInTheDocument();
    expect(within(row(/Pricing FAQ/)).getByText("1 day left")).toBeInTheDocument();
    expect(screen.getByText(/2 items are deleted for good within 3 days/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Today/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Older/ })).toBeInTheDocument();
    expect(screen.getByText("7 items")).toBeInTheDocument();
  });

  it("search and the Tasks / Projects filter", async () => {
    renderBin("owner");
    await screen.findByText("Draft press release");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the recycle bin" }), { target: { value: "theo" } });
    expect(rows().map((r) => r.querySelector(".kbin-title")?.textContent)).toEqual(["Task: Fix flaky checkout test"]);
    expect(screen.getByText("1 of 7")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(screen.getByText("Nothing in the bin matches")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show everything" }));
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(rows()).toHaveLength(1);
    expect(screen.getByText("Webinar series")).toBeInTheDocument();
  });

  it("Restore puts it back, says where (with the server's note) and tells the host", async () => {
    const { onRestored } = renderBin("member");
    const btn = await screen.findByRole("button", { name: "Restore “Migrate blog posts”" });
    btn.focus();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByText("Migrate blog posts")).toBeNull());
    expect(status()).toHaveTextContent("Restored “Migrate blog posts”. Its project was deleted, so it's back in “Q3 Product Launch”.");
    expect(onRestored).toHaveBeenCalledWith([expect.objectContaining({ status: "restored", projectId: "p-launch" })]);
    // focus moves on to the next row's Restore, not to the top of the page
    expect(document.activeElement).toHaveAttribute("data-row-focus");
    expect(screen.getByText("6 items")).toBeInTheDocument();
  });

  it("in a toast, with Open project", async () => {
    const onOpenProject = vi.fn();
    render(<ToastProvider><RecycleBin workspaceId={WS} workspaceName="Foundrise" role="owner" currentUserId="m-self" members={MEMBERS} projects={projects} onOpenProject={onOpenProject} /></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Restore “Webinar series”" }));
    expect(await screen.findByText("Restored “Webinar series”.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    expect(onOpenProject).toHaveBeenCalledWith(expect.stringMatching(/^p-bin-/));
  });

  it("members restore but can't delete for good; guests only look", async () => {
    const { unmount } = renderBin("member");
    await screen.findByText("Draft press release");
    expect(screen.getByText(/Only owners and admins can delete things for good/)).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /forever$/ })).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: /^Restore “/ }).length).toBe(7);
    unmount();
    renderBin("guest");
    await screen.findByText("Draft press release");
    expect(screen.getByText(/You're a guest here, so you can look but not restore anything/)).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /^Restore/ })).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("Delete forever asks first, says what goes with it, and can be cancelled", async () => {
    renderBin("admin");
    fireEvent.click(await screen.findByRole("button", { name: "Delete “Webinar series” forever" }));
    const dialog = screen.getByRole("dialog", { name: "Delete forever" });
    expect(dialog).toHaveTextContent("“Webinar series” and its 9 tasks, 2 sections, 1 doc, 12 comments and 3 files will be deleted for good. This can't be undone.");
    expect(document.activeElement).toHaveTextContent("Cancel");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Webinar series")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete “Webinar series” forever" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete forever" }));
    await waitFor(() => expect(screen.queryByText("Webinar series")).toBeNull());
    expect(status()).toHaveTextContent("Deleted “Webinar series” for good.");
  });

  it("select all, then restore them together; Escape clears a selection", async () => {
    const { onRestored } = renderBin("owner");
    await screen.findByText("Draft press release");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select “Draft press release”" }));
    expect(screen.getByRole("checkbox", { name: "Select everything in the bin" })).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByText("1 item selected")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("checkbox", { name: "Select “Draft press release”" }), { key: "Escape" });
    expect(screen.queryByText(/selected/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select everything in the bin" }));
    expect(screen.getByText("7 items selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore 7" }));
    expect(await screen.findByText("The recycle bin is empty")).toBeInTheDocument();
    // the toolbar went with the last row: focus lands on the page's intro, not lost to the body
    await waitFor(() => expect(document.activeElement).toHaveClass("kbin-intro"));
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onRestored.mock.calls[0][0]).toHaveLength(7);
    expect(status()).toHaveTextContent(/^Restored 7 items\./);
  });

  it("selecting only what the search shows", async () => {
    renderBin("owner");
    await screen.findByText("Draft press release");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "sana" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all shown" }));
    expect(screen.getByText("2 items selected")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(screen.getByRole("checkbox", { name: "Select everything in the bin" })).toHaveAttribute("aria-checked", "mixed");
  });

  it("your Personal bin: you restore and delete everything there", async () => {
    renderBin(null);
    expect(screen.getByText(/Your deleted tasks and projects wait here/)).toBeInTheDocument();
    expect(await screen.findByText("Renew passport")).toBeInTheDocument();
    expect(within(row("Renew passport")).getByText("Personal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete “Home move” forever" })).toBeInTheDocument();
  });
});

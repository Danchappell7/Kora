/* The Docs tab and a doc's page in demo mode: the list, new docs from templates, reorder, archive,
   delete, the empty / guest / gone states, Export as Markdown. */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../data/types";
import { MEMBERS, PROJECTS, TASKS } from "../../data/data";
import { getProjectDoc, listProjectDocs, resetDemoDocs, saveProjectDoc, setProjectDocProps } from "../../lib/docs";
import { DocsTab, newDocId, reorderPositions } from "./DocsTab";
import { DocPage, editedLine } from "./DocPage";

const LAUNCH = PROJECTS.find((p) => p.id === "p-launch")!;
const BRAND = PROJECTS.find((p) => p.id === "p-brand")!;

function tab(project: Project = LAUNCH, opts: { readOnly?: boolean; docId?: string | null } = {}) {
  const onOpenDoc = vi.fn();
  const onMakeTask = vi.fn(async () => "t-x");
  const onOpenTask = vi.fn();
  const utils = render(
    <DocsTab project={project} members={MEMBERS} tasks={TASKS} currentUserId="m-self" readOnly={!!opts.readOnly} docId={opts.docId ?? null}
      onOpenDoc={onOpenDoc} onMakeTask={onMakeTask} onOpenTask={onOpenTask} />,
  );
  return { ...utils, onOpenDoc, onMakeTask, onOpenTask };
}

beforeEach(() => resetDemoDocs());

describe("pure helpers", () => {
  it("reorder: between neighbours, before the first, after the last; renumbers when there's no room", () => {
    const L = [{ id: "a", position: 1 }, { id: "b", position: 2 }, { id: "c", position: 3 }];
    expect(reorderPositions(L, "c", 0)).toEqual([{ id: "c", position: 0 }]);
    expect(reorderPositions(L, "a", 2)).toEqual([{ id: "a", position: 4 }]);
    expect(reorderPositions(L, "a", 1)).toEqual([{ id: "a", position: 2.5 }]);
    expect(reorderPositions(L, "x", 1)).toEqual([]);
    const tight = [{ id: "a", position: 1 }, { id: "b", position: 1 }, { id: "c", position: null }];
    expect(reorderPositions(tight, "c", 1)).toEqual([{ id: "c", position: 2 }, { id: "b", position: 3 }]);
  });
  it("uuids", () => {
    expect(newDocId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("who edited it last, and when", () => {
    const now = new Date("2026-10-09T12:00:00Z").getTime();
    const names = (id: string) => (id === "m-3" ? "Sana Rao" : undefined);
    expect(editedLine({ updatedAt: "2026-10-09T10:00:00Z", updatedBy: "m-3", updatedByName: null }, "m-self", names, now)).toBe("Edited 2 hours ago by Sana Rao");
    expect(editedLine({ updatedAt: "2026-10-09T11:59:50Z", updatedBy: "m-self", updatedByName: "Daniel" }, "m-self", names, now)).toBe("Edited just now by you");
    expect(editedLine({ updatedAt: "2026-10-09T11:00:00Z", updatedBy: null, updatedByName: null }, "m-self", names, now)).toBe("Edited an hour ago");
  });
});

describe("the list", () => {
  it("shows each doc with its icon, title (a real link) and who edited it", async () => {
    tab();
    const list = await screen.findByRole("list", { name: "Q3 Product Launch: docs" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const brief = within(items[0]).getByRole("link", { name: "Launch brief" });
    expect(brief).toHaveAttribute("href", "/p/p-launch/docs/doc-launch-brief");
    expect(items[0]).toHaveTextContent(/Edited .* by Sana Rao/);
    expect(items[0]).toHaveTextContent("🧭");
    expect(screen.getByRole("heading", { name: /Docs\s*3/ })).toBeInTheDocument();
  });

  it("opens a doc in place (a modified click is left to the browser)", async () => {
    const { onOpenDoc } = tab();
    const link = await screen.findByRole("link", { name: "Decision log" });
    // (jsdom can't navigate: note whether the app let the browser have it, then stop it)
    const prevented: boolean[] = [];
    const stop = (e: Event) => { prevented.push(e.defaultPrevented); e.preventDefault(); };
    window.addEventListener("click", stop);
    fireEvent.click(link, { metaKey: true });
    expect(onOpenDoc).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onOpenDoc).toHaveBeenCalledWith("doc-decision-log");
    window.removeEventListener("click", stop);
    expect(prevented).toEqual([false, true]);
  });

  it("New doc: pick a template, it's saved with the template's title, then opens", async () => {
    const { onOpenDoc } = tab();
    await screen.findByRole("link", { name: "Launch brief" });
    fireEvent.click(screen.getByRole("button", { name: "New doc" }));
    const menu = await screen.findByRole("menu", { name: "New doc from a template" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Meeting notes/ }));
    await waitFor(() => expect(onOpenDoc).toHaveBeenCalled());
    const id = onOpenDoc.mock.calls[0][0] as string;
    const d = (await getProjectDoc(id))!;
    expect(d.title).toMatch(/^Meeting notes, \d{1,2} \w+ \d{4}$/);
    expect(d.icon).toBe("🗒️");
    expect((await listProjectDocs("p-launch")).map((x) => x.id)).toContain(id);
  });

  it("archive folds a doc away under Archived; unarchive brings it back", async () => {
    tab();
    await screen.findByRole("link", { name: "Decision log" });
    fireEvent.click(screen.getByRole("button", { name: "More for “Decision log”" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Archive/ }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: /docs$/ })).getAllByRole("listitem")).toHaveLength(2));
    const archived = screen.getByRole("region", { name: "Archived docs" });
    fireEvent.click(within(archived).getByRole("button", { name: /Archived/ }));
    expect(within(archived).getByRole("link", { name: "Decision log" })).toBeInTheDocument();
    expect((await getProjectDoc("doc-decision-log"))!.archivedAt).toBeTruthy();
    fireEvent.click(within(archived).getByRole("button", { name: "More for “Decision log”" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Unarchive/ }));
    await waitFor(async () => expect((await getProjectDoc("doc-decision-log"))!.archivedAt).toBeNull());
  });

  it("delete asks first, then the doc is gone for everyone", async () => {
    tab();
    await screen.findByRole("link", { name: "Decision log" });
    fireEvent.click(screen.getByRole("button", { name: "More for “Decision log”" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this doc" });
    expect(dialog).toHaveTextContent("“Decision log” and its version history will be deleted for everyone");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete doc" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Decision log" })).toBeNull());
    expect(await getProjectDoc("doc-decision-log")).toBeNull();
  });

  it("reorder from the keyboard with the grip (and the server keeps the order)", async () => {
    tab();
    await screen.findByRole("link", { name: "Launch brief" });
    const grip = screen.getByRole("button", { name: /Reorder “Launch brief”/ });
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    await waitFor(() => expect(within(screen.getByRole("list", { name: /docs$/ })).getAllByRole("link").map((a) => a.textContent)[1]).toBe("Launch brief"));
    await waitFor(async () => expect((await listProjectDocs("p-launch"))[1].id).toBe("doc-launch-brief"));
    expect(screen.getByRole("status")).toHaveTextContent("Moved to position 2 of 3.");
  });

  it("someone else's new doc shows up without a reload", async () => {
    tab();
    await screen.findByRole("link", { name: "Launch brief" });
    await act(async () => { await saveProjectDoc({ id: "elsewhere", projectId: "p-launch", title: "Written elsewhere", body: [], baseUpdatedAt: null }); });
    expect(await screen.findByRole("link", { name: "Written elsewhere" }, { timeout: 2000 })).toBeInTheDocument();
  });
});

describe("empty, guest and unavailable states", () => {
  it("a project without docs offers the templates", async () => {
    const { onOpenDoc } = tab(BRAND);
    expect(await screen.findByText("No docs yet")).toBeInTheDocument();
    const brief = screen.getByRole("button", { name: /Project brief/ });
    fireEvent.click(brief);
    await waitFor(() => expect(onOpenDoc).toHaveBeenCalled());
    expect((await getProjectDoc(onOpenDoc.mock.calls[0][0] as string))!.title).toBe("Brand Refresh: project brief");
  });

  it("guests read: no New doc, no row actions, no grips; an empty project says the team writes them", async () => {
    tab(LAUNCH, { readOnly: true });
    await screen.findByRole("link", { name: "Launch brief" });
    expect(screen.queryByRole("button", { name: "New doc" })).toBeNull();
    expect(screen.queryByRole("button", { name: /More for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reorder/ })).toBeNull();
    resetDemoDocs();
  });

  it("guest empty state", async () => {
    tab(BRAND, { readOnly: true });
    expect(await screen.findByText("When the team writes docs for this project, they'll be here.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Project brief/ })).toBeNull();
  });
});

describe("a doc's page", () => {
  it("opens from the address: who edited it, the editor, and the way back", async () => {
    const { onOpenDoc } = tab(LAUNCH, { docId: "doc-launch-brief" });
    expect(await screen.findByText(/Edited .* by Sana Rao/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Launch brief");
    fireEvent.click(screen.getByRole("button", { name: /Back to Q3 Product Launch's docs/ }));
    expect(onOpenDoc).toHaveBeenCalledWith(null);
  });

  it("a doc that's gone (or in another project) says so", async () => {
    const onBack = vi.fn();
    render(<DocPage project={LAUNCH} docId="no-such-doc" members={MEMBERS} tasks={TASKS} currentUserId="m-self" readOnly={false} onBack={onBack} onMakeTask={vi.fn()} onOpenTask={vi.fn()} />);
    expect(await screen.findByText("This doc isn't here any more")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to Docs" }));
    expect(onBack).toHaveBeenCalled();
    render(<DocPage project={BRAND} docId="doc-launch-brief" members={MEMBERS} tasks={TASKS} currentUserId="m-self" readOnly={false} onBack={onBack} onMakeTask={vi.fn()} onOpenTask={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText("This doc isn't here any more")).toHaveLength(2));
  });

  it("Export as Markdown downloads a .md named after the doc", async () => {
    const created: Blob[] = [];
    const spy = vi.spyOn(URL, "createObjectURL").mockImplementation((b: Blob | MediaSource) => { created.push(b as Blob); return "blob:x"; });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    tab(LAUNCH, { docId: "doc-launch-brief" });
    await screen.findByRole("textbox", { name: "Title" });
    fireEvent.click(screen.getByRole("button", { name: "More for this doc" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Export as Markdown/ }));
    expect(click).toHaveBeenCalled();
    const md = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(created[0]); });
    expect(md.startsWith("# Launch brief\n")).toBe(true);
    expect(md).toContain("- [x] Pick the launch date with leadership"); // its task is done
    expect(md).toContain("@Sana Rao");
    spy.mockRestore(); click.mockRestore();
  });

  it("an archived doc reads only until it's unarchived", async () => {
    await setProjectDocProps("doc-decision-log", { archived: true });
    tab(LAUNCH, { docId: "doc-decision-log" });
    expect(await screen.findByText(/This doc is archived/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    expect(await screen.findByRole("textbox", { name: "Title" })).toBeInTheDocument();
  });

  it("delete from the page, after a confirm, goes back to the list", async () => {
    const { onOpenDoc } = tab(LAUNCH, { docId: "doc-launch-sync" });
    await screen.findByRole("textbox", { name: "Title" });
    fireEvent.click(screen.getByRole("button", { name: "More for this doc" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Delete/ }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Delete this doc" })).getByRole("button", { name: "Delete doc" }));
    await waitFor(() => expect(onOpenDoc).toHaveBeenCalledWith(null));
    expect(await getProjectDoc("doc-launch-sync")).toBeNull();
  });

  it("guests get the read-only page: no edit actions in the menu", async () => {
    tab(LAUNCH, { docId: "doc-launch-brief", readOnly: true });
    expect(await screen.findByRole("heading", { level: 2, name: "Launch brief" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More for this doc" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: /Delete|Archive/ })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /Export as Markdown/ })).toBeInTheDocument();
  });
});

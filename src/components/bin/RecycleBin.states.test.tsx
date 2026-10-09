/* Projects › Recycle bin: the states demo mode never reaches — before 0047,
   a failed load, a restore the database refuses, and an item someone else
   restored first. lib/trash's calls are mocked; its parsers are real. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TrashItem } from "../../data/types";

const { listTrash, restoreFromTrash, purgeTrash, restoreTrashItems } = vi.hoisted(() => ({
  listTrash: vi.fn(), restoreFromTrash: vi.fn(), purgeTrash: vi.fn(), restoreTrashItems: vi.fn(),
}));
vi.mock("../../lib/trash", async (orig) => ({ ...(await orig<typeof import("../../lib/trash")>()), listTrash, restoreFromTrash, purgeTrash, restoreTrashItems }));

import { RecycleBin } from "./RecycleBin";
import { parseTrashItem } from "../../lib/trash";

const WS = "851dadfe-dfce-497d-bf03-4e4a1394ad30";
const PROJ = "046b1461-13eb-44bd-9341-dea2491479a1";
const item = (n: number, title: string, extra: Record<string, unknown> = {}): TrashItem => parseTrashItem({
  id: `00000000-0000-4000-8000-00000000000${n}`, kind: "task", item_id: `10000000-0000-4000-8000-00000000000${n}`, workspace_id: WS, user_id: "u", project_id: PROJ,
  title, summary: { counts: { tasks: 1 }, project: { id: PROJ, name: "Website", emoji: "🌐", color: "oklch(0.7 0.12 160)" }, parent: null, status: "todo", archived: false },
  deleted_by: "u", deleted_by_name: "Sana Malik", deleted_at: new Date(Date.now() - n * 3600_000).toISOString(),
  purge_after: new Date(Date.now() + 20 * 864e5).toISOString(), restored_at: null, restored_by: null, ...extra,
})!;
const err = (message: string, code = "P0001") => Object.assign(new Error(message), { code });
const bin = (role: "owner" | "member" = "owner") => render(
  <RecycleBin workspaceId={WS} workspaceName="Acme" role={role} currentUserId="me" members={[]} projects={[{ id: PROJ, name: "Website", emoji: "🌐", color: "oklch(0.7 0.12 160)", workspaceId: WS }]} />,
);

beforeEach(() => { listTrash.mockReset(); restoreFromTrash.mockReset(); purgeTrash.mockReset(); restoreTrashItems.mockReset(); });

describe("RecycleBin states", () => {
  it("before 0047: not switched on yet (and nothing to retry)", async () => {
    listTrash.mockRejectedValue(err("Could not find the table 'public.trash' in the schema cache", "42P01"));
    bin();
    expect(await screen.findByText("The recycle bin isn't switched on yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("a failed load says so and tries again", async () => {
    listTrash.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce([item(1, "Homepage copy")]);
    bin();
    expect(await screen.findByText("Couldn't load the recycle bin")).toBeInTheDocument();
    expect(screen.getByText(/Check your connection/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Homepage copy")).toBeInTheDocument();
  });

  it("loading has the list's shape and a status for screen readers", async () => {
    listTrash.mockReturnValue(new Promise(() => {}));
    bin();
    expect(screen.getByText("Loading the recycle bin")).toHaveAttribute("role", "status");
  });

  it("a refused restore stays, with the reason under it", async () => {
    listTrash.mockResolvedValue([item(1, "Homepage copy"), item(2, "Pricing table")]);
    restoreFromTrash.mockRejectedValueOnce(err("restore conflict")).mockRejectedValueOnce(err("no project to restore into"));
    bin();
    fireEvent.click(await screen.findByRole("button", { name: "Restore “Homepage copy”" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Part of this task is already back in Kanbo, so it can't be restored over it.");
    expect(screen.getByText("Homepage copy")).toBeInTheDocument();
    // the Restore button now points at the reason too
    expect(screen.getByRole("button", { name: "Restore “Homepage copy”" }).getAttribute("aria-describedby")).toMatch(/-err$/);
    fireEvent.click(screen.getByRole("button", { name: "Restore “Pricing table”" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.getAllByRole("alert")[1]).toHaveTextContent(/Make a project first/);
  });

  it("restored or purged by someone else first: the row goes, and it says why", async () => {
    listTrash.mockResolvedValue([item(1, "Homepage copy")]);
    restoreFromTrash.mockRejectedValue(err("not found"));
    bin();
    fireEvent.click(await screen.findByRole("button", { name: "Restore “Homepage copy”" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Restore “Homepage copy”" })).toBeNull());
    expect(screen.getByText(/is no longer in the bin: someone restored it or deleted it for good/)).toBeInTheDocument();
  });

  it("a team item an admin can't purge any more says so in the dialog", async () => {
    listTrash.mockResolvedValue([item(1, "Homepage copy")]);
    purgeTrash.mockRejectedValue(err("not authorized"));
    bin("owner");
    fireEvent.click(await screen.findByRole("button", { name: "Delete “Homepage copy” forever" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete forever" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Only owners and admins can delete team items for good.");
  });

  it("bulk restore: the ones that fail stay selected with their reasons; the rest go", async () => {
    const a = item(1, "Homepage copy"), b = item(2, "Pricing table"), c = item(3, "Hero image");
    listTrash.mockResolvedValue([a, b, c]);
    restoreTrashItems.mockResolvedValue([
      { id: a.id, ok: true, result: { id: a.id, kind: "task", itemId: a.itemId, status: "restored", projectId: PROJ, note: null, counts: null } },
      { id: b.id, ok: false, error: "conflict", message: "restore conflict" },
      { id: c.id, ok: true, result: { id: c.id, kind: "task", itemId: c.itemId, status: "restored", projectId: PROJ, note: null, counts: null } },
    ]);
    bin();
    await screen.findByText("Homepage copy");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select everything in the bin" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore 3" }));
    await waitFor(() => expect(screen.queryByText("Homepage copy")).toBeNull());
    // newest delete first
    expect(restoreTrashItems).toHaveBeenCalledWith([a.id, b.id, c.id]);
    expect(screen.getByText("Pricing table")).toBeInTheDocument();
    expect(screen.queryByText("Hero image")).toBeNull();
    expect(screen.getByText("1 item selected")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName("Restore “Pricing table”"));
    expect(screen.getByText("1 item couldn't be restored. Each one says why.")).toBeInTheDocument();
    expect(screen.getAllByRole("status").slice(-1)[0]).toHaveTextContent("Restored 2 items. 1 item couldn't be restored.");
  });
});

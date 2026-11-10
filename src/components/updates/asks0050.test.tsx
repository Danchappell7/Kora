/* Who an Ask is for, before 0054: an update can't name them then (status_updates has no ask_user_ids), so nobody
   would hear. The composer and the editor offer the people (and promise "Needs your reply") only once 0054 is
   known to be in; the Ask's words still post. lib/updateSchema says which (the store's tests cover how it learns). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project, StatusUpdate } from "../../data/types";

const flag = vi.hoisted(() => ({ on: false }));
vi.mock("../../lib/updateSchema", async (orig) => ({
  ...(await orig<typeof import("../../lib/updateSchema")>()),
  updateAsksOn: () => flag.on,
  useUpdateAsksOn: () => flag.on,
}));

import { UpdateSheet } from "./UpdateSheet";
import { UpdateCard } from "./UpdateCard";
import { clearStatusDrafts } from "../project/StatusComposer";
import { resetUpdateConversation } from "../../lib/updateConversation";

const proj: Project = { id: "p1", name: "Launch", emoji: "🚀", color: "#5B5BD6", workspaceId: "ws", ownerId: "m-self" } as Project;
const people = [{ id: "sana", name: "Sana Rao" }, { id: "theo", name: "Theo Vance" }];

beforeEach(() => { clearStatusDrafts(); resetUpdateConversation(); });
afterEach(() => { flag.on = false; vi.restoreAllMocks(); });

type PostFn = (...a: unknown[]) => Promise<boolean>;
async function writeAnAsk(onPost: PostFn) {
  render(<UpdateSheet project={proj} tasks={[]} statusUpdates={[]} onPost={onPost} open onClose={vi.fn()} people={people} />);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Update" })).not.toHaveValue(""));
  fireEvent.click(screen.getByRole("button", { name: /Highlights, risks, asks and next/ }));
  fireEvent.change(screen.getByPlaceholderText("What you need, and from whom"), { target: { value: "Sana, sign off the hero copy by Thursday?" } });
}

describe("the composer's Ask people", () => {
  it("before 0054: no people to pick and no promise; the Ask's words still post", async () => {
    const onPost = vi.fn<PostFn>(async () => true);
    await writeAnAsk(onPost);
    expect(screen.queryByRole("group", { name: "Who the asks are for" })).toBeNull();
    expect(screen.queryByText(/Needs your reply/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Post update/ })); });
    expect(onPost).toHaveBeenCalledTimes(1);
    const extras = onPost.mock.calls[0][3] as Record<string, unknown>;
    expect(extras.sections).toMatchObject({ asks: "Sana, sign off the hero copy by Thursday?" });
    expect(extras).not.toHaveProperty("askUserIds");
  });

  it("once 0054 is in: pick who it's for, and they hear", async () => {
    flag.on = true;
    const onPost = vi.fn<PostFn>(async () => true);
    await writeAnAsk(onPost);
    fireEvent.click(screen.getByRole("button", { name: "Sana" }));
    expect(screen.getByText(/They'll see it under Needs your reply/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Post update/ })); });
    expect(onPost.mock.calls[0][3]).toMatchObject({ askUserIds: ["sana"] });
  });
});

describe("the editor's Ask people", () => {
  const U: StatusUpdate = { id: "su-1", projectId: "p1", workspaceId: "ws", status: "on_track", summary: "Hero waits on copy.", createdAt: "2026-11-09T10:00:00Z",
    authorId: "m-self", sections: { asks: "Sana, approve the hero?" } };
  const edit = async (onEdit: (...a: unknown[]) => Promise<boolean>) => {
    render(<ul><li><UpdateCard update={U} me="m-self" canWrite lead={false} thread={{ comments: [], reactions: {}, seenBy: [] }} conversation={false}
      people={people} onEdit={onEdit} onDelete={vi.fn()} /></li></ul>);
    fireEvent.click(screen.getByRole("button", { name: "Update actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Edit update/ }));
  };

  it("before 0054: no people to pick, and the save doesn't send any", async () => {
    const onEdit = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
    await edit(onEdit);
    expect(screen.queryByRole("group", { name: "Who the asks are for" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0][1]).not.toHaveProperty("askUserIds");
  });

  it("once 0054 is in: the people are there", async () => {
    flag.on = true;
    await edit(vi.fn(async () => true));
    expect(screen.getByRole("group", { name: "Who the asks are for" })).toBeInTheDocument();
  });
});

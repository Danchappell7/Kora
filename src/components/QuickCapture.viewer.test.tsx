/* Quick capture when the host doesn't say who "you" are (App mounts it without
   currentUserId): the library says — the account it was listed for — so your own
   templates read as yours and the "me" role is you, not someone's placeholder.
   Pinned to Friday 9 October 2026. */
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-09T10:00:00+01:00") }); });

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QuickCapture } from "./QuickCapture";
import type { AppliedTemplatePlan } from "../lib/templates";
import type { LibraryTemplate } from "../data/types";

const ME = "4f1c2a52-9a43-4a8e-8f3e-5d2a0c7b1e01";
const tpl = (id: string, userId: string, name: string, shared: boolean): LibraryTemplate => ({
  id, userId, name, shared, workspaceId: "ws-1", emoji: null, createdAt: "", updatedAt: "2026-10-08T09:00:00Z",
  body: { title: name, subtasks: [{ title: "First step", assigneeRole: "me" }] },
});
vi.mock("../lib/templates", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/templates")>();
  return {
    ...real,
    libraryViewerId: async () => ME,
    listLibraryTemplates: async () => [tpl("a", ME, "My standup", true), tpl("b", "u-sana", "Sana's checklist", true)],
  };
});

describe("Quick capture: who “you” are, from the library", () => {
  it("your own templates aren't labelled Shared, and “me” sub-tasks are yours", async () => {
    const onApplyTemplate = vi.fn();
    render(<QuickCapture open onClose={vi.fn()} members={[]} onCreate={vi.fn()} onApplyTemplate={onApplyTemplate}
      projects={[{ id: "p-1", name: "Ops", workspaceId: "ws-1", ownerId: "u-sana" }]} />);
    const field = screen.getByRole("textbox", { name: "Quick capture a task" });
    fireEvent.change(field, { target: { value: "/" } });
    const list = await screen.findByRole("listbox", { name: "Templates" });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(2));
    const [mine, theirs] = within(list).getAllByRole("option");
    expect(mine).toHaveTextContent("My standup");
    expect(mine).not.toHaveTextContent("Shared");
    expect(theirs).toHaveTextContent("Shared");
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "Enter" });
    const plan = onApplyTemplate.mock.calls[0][0] as AppliedTemplatePlan;
    expect(plan.task.assigneeId).toBe(ME);
    expect(plan.subtasks.map((s) => s.assigneeId)).toEqual([ME]);
  });
});

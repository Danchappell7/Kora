/* Project updates in the Inbox (0054): an Ask for you is "Needs your reply", a posted update or a reply on yours is
   FYI, each reads as a sentence and opens the project's Updates tab; "Updates" shows just them. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { InboxView } from "./InboxView";
import type { Activity, Task } from "../../data/types";

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const task = { id: "t1", title: "Q3 budget", projectId: "p-launch", status: "todo", assigneeId: "m-1", aiScore: 1 } as unknown as Task;
const upd = (p: Partial<Activity> & { id: string }): Activity => ({ taskId: null, taskTitle: "Brand Refresh", kind: "update", detail: "Sana Rao", createdAt: iso(60_000), ...p });
const comment: Activity = { id: "c1", taskId: "t1", taskTitle: "Q3 budget", kind: "comment", detail: "Theo Vance", createdAt: iso(120_000) };

function inbox(activity: Activity[], extra: Partial<Parameters<typeof InboxView>[0]> = {}) {
  const props = { activity, tasks: [task], onOpen: vi.fn(), onArchive: vi.fn(), onClearAll: vi.fn(), currentUserId: "m-self", onOpenUpdate: vi.fn(), ...extra };
  return { ...render(<InboxView {...props} />), props };
}
beforeEach(() => { localStorage.clear(); });

describe("Inbox › project updates (0054)", () => {
  it("an Ask that names you needs your reply; a posted update and a reply on yours are FYI", () => {
    inbox([
      upd({ id: "u1", meta: { statusUpdateId: "su-brand", projectId: "p-brand", updateEvent: "posted", ask: true } }),
      upd({ id: "u2", taskTitle: "Q3 Product Launch", detail: "Maya Lin", meta: { statusUpdateId: "su-launch", projectId: "p-launch", updateEvent: "comment", ask: false } }),
      upd({ id: "u3", detail: "Theo Vance", meta: { statusUpdateId: "su-x", projectId: "p-brand", updateEvent: "posted", ask: false } }),
    ]);
    const reply = screen.getByRole("region", { name: "Needs your reply" });
    expect(within(reply).getByRole("button", { name: /Sana Rao asked you something in the update on Brand Refresh/ })).toBeInTheDocument();
    const fyi = screen.getByRole("region", { name: "FYI" });
    expect(within(fyi).getByRole("button", { name: /Maya Lin replied to your update on Q3 Product Launch/ })).toBeInTheDocument();
    expect(within(fyi).getByRole("button", { name: /Theo Vance posted an update on Brand Refresh/ })).toBeInTheDocument();
    // where it's from: the project's Updates
    expect(within(reply).getByText("Brand Refresh · Updates")).toBeInTheDocument();
  });

  it("opens where it lives", () => {
    const { props } = inbox([upd({ id: "u1", meta: { statusUpdateId: "su-brand", projectId: "p-brand", updateEvent: "posted", ask: true } })]);
    fireEvent.click(screen.getByRole("button", { name: /asked you something/ }));
    expect(props.onOpenUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }));
  });

  it("an item it can't open (no project) reads as gone", () => {
    const { container } = inbox([upd({ id: "u1", meta: { updateEvent: "posted" } })]);
    expect(container.querySelector(".kinbox-row")).toHaveAttribute("data-gone", "true");
  });

  it("Updates shows just the updates, offered only once there are some", () => {
    const { unmount } = inbox([comment]);
    expect(screen.queryByRole("button", { name: /^Updates/ })).toBeNull();
    unmount();
    inbox([comment, upd({ id: "u1", meta: { statusUpdateId: "su-brand", projectId: "p-brand", updateEvent: "posted", ask: true } })]);
    fireEvent.click(screen.getByRole("button", { name: /^Updates/ }));
    const list = screen.getByRole("region", { name: "Updates" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText(/Theo Vance commented on/)).toBeNull();
  });
});

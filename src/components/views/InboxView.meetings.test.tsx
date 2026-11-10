/* A meeting's recap in the Inbox (0056): "Maya Lin shared the recap of …" with what it left, FYI, in Updates too,
   and it opens the recap. One whose meeting can't be found reads as gone. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { InboxView } from "./InboxView";
import type { Activity } from "../../data/types";

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const recap = (p: Partial<Activity> & { id: string }): Activity => ({
  taskId: null, taskTitle: "Foundrise team meeting, Fri 6 Nov", kind: "meeting", detail: "Maya Lin", createdAt: iso(60_000),
  meta: { meetingId: "m1", workspaceId: "ws-foundrise", meetingPreset: "team", decisions: 2, actions: 5 }, ...p,
});

function inbox(activity: Activity[], extra: Partial<Parameters<typeof InboxView>[0]> = {}) {
  const props = { activity, tasks: [], onOpen: vi.fn(), onArchive: vi.fn(), onClearAll: vi.fn(), currentUserId: "m-self", onOpenMeeting: vi.fn(), ...extra };
  return { ...render(<InboxView {...props} />), props };
}
beforeEach(() => { localStorage.clear(); });

describe("Inbox › meeting recaps (0056)", () => {
  it("reads as a sentence, with what the meeting left, under FYI; it opens the recap", () => {
    const { props } = inbox([recap({ id: "r1" })]);
    const fyi = screen.getByRole("region", { name: "FYI" });
    const row = within(fyi).getByRole("button", { name: /Maya Lin shared the recap of Foundrise team meeting, Fri 6 Nov/ });
    expect(within(fyi).getByText("Meeting · 2 decisions · 5 actions")).toBeInTheDocument();
    fireEvent.click(row);
    expect(props.onOpenMeeting).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }));
  });
  it("a leadership recap says so, and one with nothing logged says that", () => {
    inbox([recap({ id: "r2", meta: { meetingId: "m2", workspaceId: "ws-courtside", meetingPreset: "leadership", decisions: 0, actions: 0 } })]);
    expect(screen.getByText("Leadership · No decisions or actions")).toBeInTheDocument();
  });
  it("Updates holds the recaps too", () => {
    inbox([recap({ id: "r1" })]);
    fireEvent.click(screen.getByRole("button", { name: /^Updates/ }));
    const list = screen.getByRole("region", { name: "Updates" });
    expect(within(list).getByText("Meeting recaps")).toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  });
  it("one it can't open reads as gone", () => {
    const { container } = inbox([recap({ id: "r3", meta: { workspaceId: "ws-foundrise" } })]);
    expect(container.querySelector(".kinbox-row")).toHaveAttribute("data-gone", "true");
  });
});

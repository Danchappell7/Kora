/* KudosButton's "Update" when it can't be done in place (a database without update_kudos
   falls back to take back + give): if the give then fails, the button shows the kudos gone
   and says the earlier one was taken back — never just "couldn't send". A refusal of the
   in-place change puts the old emoji back. The clock is pinned. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Kudos } from "../../data/types";

const { updateKudos } = vi.hoisted(() => ({ updateKudos: vi.fn() }));
vi.mock("../../lib/momentum", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/momentum")>()), updateKudos }));

import { KudosButton } from "./KudosButton";
import { resetKudosDemo } from "../../lib/momentum";

const theirs = { id: "t-24", title: "Record product demo video", status: "done" as const, assigneeId: "m-2", workspaceId: "ws-foundrise" };
const mine: Kudos = { id: "k-mine", taskId: "t-24", workspaceId: "ws-foundrise", fromUser: "m-self", toUser: "m-2", emoji: "🎉", note: null, createdAt: "2026-10-09T08:00:00Z" };
const maya: Kudos = { ...mine, id: "k-maya", fromUser: "m-1", emoji: "🔥" };
const flush = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  resetKudosDemo({ demoDelayMs: 0 });
  updateKudos.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function update(emojiName: string) {
  fireEvent.click(screen.getByRole("button", { name: "Change or take back your kudos for Theo" }));
  const dlg = screen.getByRole("dialog", { name: "Kudos for Theo" });
  fireEvent.click(within(dlg).getByRole("radio", { name: emojiName }));
  fireEvent.click(within(dlg).getByRole("button", { name: "Update" }));
}

describe("KudosButton › changing your kudos", () => {
  it("the old way failing half-way: the kudos shows gone, and it says the earlier one was taken back", async () => {
    updateKudos.mockRejectedValue(Object.assign(new Error("task not done"), { tookBack: true }));
    const onChange = vi.fn();
    render(<KudosButton task={theirs} currentUserId="m-self" recipientName="Theo Vance" kudos={[maya, mine]} onChange={onChange} />);
    update("Trophy");
    await flush();
    expect(updateKudos).toHaveBeenCalledWith("t-24", "🏆", null);
    expect(onChange).toHaveBeenLastCalledWith([maya]);
    expect(screen.getByRole("button", { name: "Kudos for Theo, 1 so far" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent("Your earlier kudos for Theo was taken back, and the new one wasn't sent. Kudos are for finished tasks.");
  });
  it("a refusal of the change itself: the old emoji comes back, and it says why", async () => {
    updateKudos.mockRejectedValue(new Error("Failed to fetch"));
    const onChange = vi.fn();
    render(<KudosButton task={theirs} currentUserId="m-self" recipientName="Theo Vance" kudos={[maya, mine]} onChange={onChange} />);
    update("Rocket");
    expect(screen.getByRole("button", { name: "Kudos for Theo, 2 so far" })).toHaveTextContent("🚀");   // at once
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Kudos for Theo, 2 so far" })).toHaveTextContent("🎉");
    expect(screen.getByRole("status")).toHaveTextContent("You're offline. Try again when you're back online.");
  });
});

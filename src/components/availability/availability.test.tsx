import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { refreshClock } from "../../data/data";
import { EMPTY_AVAILABILITY, getAvailability, resetAvailability, updateAvailability, type AvailabilityState } from "../../lib/availability";
import { resetDemoAvailability } from "../../lib/availabilitySync";
import { ToastProvider } from "../Toast";
import { OffChip, OffNote, OffTag } from "./OffChip";
import { AvailabilityPanel } from "./AvailabilityPanel";

// Tuesday 10 November 2026, mid-morning
const NOW = new Date(2026, 10, 10, 10);
const real = new Date();
const team = (o: Partial<AvailabilityState> = {}): Partial<AvailabilityState> => ({
  ...EMPTY_AVAILABILITY, status: "on", me: "me", activeWs: "ws",
  roles: { ws: { me: "owner", sana: "member", theo: "member", gus: "guest" } },
  timeOff: [
    { id: "o1", userId: "sana", startsOn: "2026-11-11", endsOn: "2026-11-13", halfDay: null, reason: "Family wedding" },
    { id: "o2", userId: "theo", startsOn: "2026-11-10", endsOn: "2026-11-10", halfDay: null },
  ],
  ...o,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  refreshClock(NOW);
  localStorage.clear();
  resetDemoAvailability();
});
afterEach(() => {
  act(() => resetAvailability());
  vi.useRealTimers();
  refreshClock(real);
});

describe("Off today", () => {
  it("says who's off now and who's off soon, with the dates (and the reason, where it reached you) on hover", () => {
    updateAvailability(team());
    render(<><OffChip userId="theo" workspaceId="ws" /><OffChip userId="sana" workspaceId="ws" /><OffChip userId="me" workspaceId="ws" /></>);
    expect(screen.getByText("Off today")).toBeInTheDocument();
    const sana = screen.getByText("Off from tomorrow").closest(".kav-chip")!;
    expect(sana).toHaveAttribute("title", "Off 11–13 Nov · Family wedding");
    expect(document.querySelectorAll(".kav-chip")).toHaveLength(2);
  });
  it("shows a guest nothing, and nothing before 0055 is run", () => {
    updateAvailability(team({ roles: { ws: { me: "guest", sana: "member" } } }));
    const { rerender } = render(<OffChip userId="sana" workspaceId="ws" />);
    expect(document.querySelector(".kav-chip")).toBeNull();
    act(() => updateAvailability(team({ status: "off" })));
    rerender(<OffChip userId="sana" workspaceId="ws" />);
    expect(document.querySelector(".kav-chip")).toBeNull();
  });
  it("the assignee picker and New task warn when someone's off the day it's due", () => {
    updateAvailability(team());
    render(<><OffTag userId="sana" workspaceId="ws" due="2026-11-12" /><OffTag userId="theo" workspaceId="ws" due="2026-11-12" />
      <OffNote userId="sana" name="Sana Rao" workspaceId="ws" due="2026-11-12" /><OffNote userId="theo" name="You" workspaceId="ws" due={null} /></>);
    expect(screen.getByText("Off Thu")).toHaveAttribute("title", "Off Thu, the day it's due");
    expect(screen.getByText("Sana is off Thu, the day it's due.")).toBeInTheDocument();
    expect(screen.getByText("You're off today.")).toBeInTheDocument();
    expect(screen.getAllByText(/Off/)).toHaveLength(1);
  });
});

describe("a person's week and time off, in their profile", () => {
  const panel = (props: Partial<Parameters<typeof AvailabilityPanel>[0]> = {}) =>
    render(<ToastProvider><AvailabilityPanel workspaceId="ws" userId="sana" name="Sana Rao" isSelf={false} myRole="owner" {...props} /></ToastProvider>);

  it("an owner changes a teammate's week and reads why they're off", async () => {
    updateAvailability(team());
    panel();
    expect(screen.getByText("Family wedding")).toBeInTheDocument();
    const hours = screen.getByLabelText("Hours a week") as HTMLInputElement;
    expect(hours.value).toBe("40");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(hours, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Friday" }));
    fireEvent.click(save);
    await waitFor(() => expect(getAvailability().weeks).toEqual([{ workspaceId: "ws", userId: "sana", weeklyHours: 30, workDays: [1, 2, 3, 4], dayStart: 480, dayEnd: 1080 }]));
    expect(await screen.findByText("Sana's working week is saved")).toBeInTheDocument();
  });
  it("a member reads a teammate's week and sees only “Off”; they can't change either", () => {
    // (RLS keeps the reason from them: it never arrives)
    updateAvailability(team({ me: "theo", roles: { ws: { me: "owner", sana: "member", theo: "member" } },
      timeOff: [{ id: "o1", userId: "sana", startsOn: "2026-11-11", endsOn: "2026-11-13", halfDay: null }],
      weeks: [{ workspaceId: "ws", userId: "sana", weeklyHours: 35, workDays: [1, 2, 3, 4, 5], dayStart: 570, dayEnd: 1050 }] }));
    panel({ myRole: "member" });
    expect(screen.getByText("35h a week · Mon–Fri · 09:30–17:30")).toBeInTheDocument();
    expect(screen.getByText("Sana or an owner or admin can change it.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Hours a week")).toBeNull();
    const row = screen.getByText("11–13 Nov").closest("li")!;
    expect(row).toHaveTextContent("Off");
    expect(row).not.toHaveTextContent("Family");
    expect(screen.queryByRole("button", { name: /Add time off|Remove time off/ })).toBeNull();
  });
  it("you add your own time off, with a private note", async () => {
    updateAvailability(team());
    panel({ userId: "me", name: "Daniel Okai", isSelf: true });
    expect(screen.getByText("Nothing booked. Add your holidays so the team plans around them.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add time off" }));
    const form = screen.getByRole("group", { name: "Add your time off" });
    fireEvent.change(within(form).getByLabelText("From"), { target: { value: "2026-12-21" } });
    fireEvent.change(within(form).getByLabelText("To"), { target: { value: "2026-12-24" } });
    expect(within(form).queryByLabelText("Part")).toBeNull();   // half days are for a single day
    fireEvent.change(within(form).getByLabelText("Note (optional)"), { target: { value: "Christmas" } });
    expect(within(form).getByText("Only you and the owners and admins see the note. Everyone else sees “Off”.")).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByText("21–24 Dec")).toBeInTheDocument());
    expect(screen.getByText("Christmas")).toBeInTheDocument();
    expect(getAvailability().timeOff.find((t) => t.userId === "me")).toMatchObject({ startsOn: "2026-12-21", endsOn: "2026-12-24", halfDay: null, reason: "Christmas" });
    fireEvent.click(screen.getByRole("button", { name: "Remove time off 21–24 Dec" }));
    await waitFor(() => expect(screen.queryByText("21–24 Dec")).toBeNull());
  });
  it("a guest carries no week; before 0055 owners are told it isn't on, and nobody else sees anything", () => {
    updateAvailability(team());
    panel({ userId: "gus", name: "Gus" });
    expect(screen.queryByText("Working week")).toBeNull();
    act(() => resetAvailability());
    act(() => updateAvailability({ status: "off" }));
    const { unmount } = panel();
    expect(screen.getAllByText("Shared hours and time off aren't switched on yet. They need the 0055 database update.").length).toBeGreaterThan(0);
    unmount();
  });
});

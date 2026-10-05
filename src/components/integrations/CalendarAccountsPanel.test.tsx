/* Settings › Connected calendars: several accounts, choosing calendars in each. */
import { StrictMode } from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CalendarAccountsPanel, MAX_CALENDARS, type CalendarAccountsPanelProps } from "./CalendarAccountsPanel";
import type { CalendarConnection, ExtCalendar } from "../../data/types";

const WORK: CalendarConnection = { id: "c-work", provider: "google", accountEmail: "ada@acme.co.uk", selectedCalendars: null, canChoose: true };
const HOME: CalendarConnection = { id: "c-home", provider: "microsoft", accountEmail: "ada@outlook.com", canChoose: true,
  selectedCalendars: [{ id: "cal", name: "Calendar", color: "#c98a1b", primary: true }, { id: "fam", name: "Family", color: "#a35bc4", primary: false }] };
const LIST: ExtCalendar[] = [
  { id: "ada@acme.co.uk", name: "Work", color: "#3f7fe0", primary: true, selected: true, accessRole: "owner" },
  { id: "hol", name: "Holidays in the United Kingdom", color: "#8a8f98", primary: false, selected: false, accessRole: "reader" },
  { id: "team", name: "Launch team", color: "#2e9d6a", primary: false, selected: false, accessRole: "writer" },
];

function setup(over: Partial<CalendarAccountsPanelProps> = {}) {
  const props: CalendarAccountsPanelProps = {
    connections: [WORK, HOME], onConnect: vi.fn(), onDisconnect: vi.fn(),
    loadCalendars: vi.fn(async () => LIST.map((c) => ({ ...c }))), onSelect: vi.fn(async () => {}), ...over,
  };
  render(<StrictMode><CalendarAccountsPanel {...props} /></StrictMode>);
  return props;
}
const group = () => screen.getByRole("region", { name: "Connected calendars" });

describe("CalendarAccountsPanel", () => {
  it("one row per account: email, provider, how many calendars are shown, with their colours", () => {
    setup();
    const g = group();
    expect(within(g).getByText("ada@acme.co.uk")).toBeInTheDocument();
    expect(within(g).getByText("Google · Main calendar shown")).toBeInTheDocument();
    expect(within(g).getByText("Outlook · 2 calendars shown")).toBeInTheDocument();
    expect(g.querySelectorAll(".kacct-dot")).toHaveLength(2);
    // tokens never exist here; nothing secret-looking is rendered
    expect(g.textContent).not.toMatch(/token|secret/i);
  });

  it("Add Google account / Add Outlook account are always offered", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add Google account" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Outlook account" }));
    expect(p.onConnect).toHaveBeenNthCalledWith(1, "google");
    expect(p.onConnect).toHaveBeenNthCalledWith(2, "microsoft");
  });

  it("with nothing connected it says what to do, and Google is the primary action", () => {
    setup({ connections: [] });
    expect(screen.getByText("No calendars connected yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Google account" })).toHaveAttribute("data-variant", "primary");
  });

  it("Disconnect removes that account only", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect ada@outlook.com" }));
    expect(p.onDisconnect).toHaveBeenCalledWith("c-home");
    expect(p.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("Choose calendars lists the account's calendars to tick: swatch, name, Primary; each tick saves straight away", async () => {
    const p = setup();
    const toggle = screen.getByRole("button", { name: "Choose calendars from ada@acme.co.uk" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = await screen.findByRole("group", { name: "Calendars to show from ada@acme.co.uk" });
    const boxes = within(list).getAllByRole("checkbox");
    expect(boxes.map((b) => (b.closest("label")?.textContent ?? "").trim())).toEqual([
      "WorkPrimary (primary calendar)", "Holidays in the United Kingdom", "Launch team",
    ]);
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false, false]);
    expect(list.querySelectorAll(".kacct-swatch")).toHaveLength(3);
    expect(screen.getByText("1 of 3 shown. Changes save straight away.")).toBeInTheDocument();

    fireEvent.click(within(list).getByRole("checkbox", { name: /Launch team/ }));
    // in the account's own order, the whole choice at once
    await waitFor(() => expect(p.onSelect).toHaveBeenCalledWith("c-work", ["ada@acme.co.uk", "team"]));
    expect(await screen.findByText("Saved. Today and Month now show these calendars.")).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("checkbox", { name: /Work/ }));
    await waitFor(() => expect(p.onSelect).toHaveBeenLastCalledWith("c-work", ["team"]));
  });

  it("a save that fails puts the tick back and says why", async () => {
    setup({ onSelect: vi.fn(async () => { throw new Error("Couldn't reach ada@acme.co.uk just now. Try again in a moment."); }) });
    fireEvent.click(screen.getByRole("button", { name: "Choose calendars from ada@acme.co.uk" }));
    const team = await screen.findByRole("checkbox", { name: /Launch team/ });
    fireEvent.click(team);
    expect(await screen.findByText("Couldn't reach ada@acme.co.uk just now. Try again in a moment.")).toBeInTheDocument();
    expect(team).not.toBeChecked();
  });

  it("while a save is in flight every box stays usable (focus never drops off the one pressed), and a tick made meanwhile is saved straight after", async () => {
    let release!: () => void;
    const calls: string[][] = [];
    const onSelect = vi.fn((_id: string, ids: string[]) => {
      calls.push(ids);
      return calls.length === 1 ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
    });
    setup({ onSelect });
    fireEvent.click(screen.getByRole("button", { name: "Choose calendars from ada@acme.co.uk" }));
    const list = await screen.findByRole("group", { name: "Calendars to show from ada@acme.co.uk" });
    const team = within(list).getByRole("checkbox", { name: /Launch team/ });
    team.focus();
    fireEvent.click(team);
    expect(onSelect).toHaveBeenCalledTimes(1);
    // saving: no box is disabled (a disabled box loses focus), the group says it's busy
    for (const box of within(list).getAllByRole("checkbox")) expect(box).toBeEnabled();
    expect(team).toBeChecked();
    expect(document.activeElement).toBe(team);
    expect(list).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    // a second tick meanwhile is kept, and waits for the first save
    const hol = within(list).getByRole("checkbox", { name: /Holidays/ });
    fireEvent.click(hol);
    expect(hol).toBeChecked();
    expect(onSelect).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(2));
    expect(calls).toEqual([["ada@acme.co.uk", "team"], ["ada@acme.co.uk", "hol", "team"]]);
    expect(await screen.findByText("Saved. Today and Month now show these calendars.")).toBeInTheDocument();
    expect(list).not.toHaveAttribute("aria-busy");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("if a later save fails, the ticks go back to what was last saved, and it says why", async () => {
    let release!: () => void;
    let n = 0;
    const onSelect = vi.fn(() => {
      n += 1;
      return n === 1 ? new Promise<void>((r) => { release = r; }) : Promise.reject(new Error("Couldn't reach ada@acme.co.uk just now. Try again in a moment."));
    });
    setup({ onSelect });
    fireEvent.click(screen.getByRole("button", { name: "Choose calendars from ada@acme.co.uk" }));
    const team = await screen.findByRole("checkbox", { name: /Launch team/ });
    fireEvent.click(team);
    const hol = screen.getByRole("checkbox", { name: /Holidays/ });
    fireEvent.click(hol);
    release();
    expect(await screen.findByText("Couldn't reach ada@acme.co.uk just now. Try again in a moment.")).toBeInTheDocument();
    expect(team).toBeChecked();      // the first save went through
    expect(hol).not.toBeChecked();   // the second didn't
    expect(screen.getByRole("checkbox", { name: /Work/ })).toBeChecked();
  });

  it("a list that won't load says why and can be tried again", async () => {
    let fail = true;
    const loadCalendars = vi.fn(async () => { if (fail) throw new Error("Kanbo can't read ada@acme.co.uk any more. Disconnect it and add it again."); return LIST; });
    setup({ loadCalendars });
    fireEvent.click(screen.getByRole("button", { name: "Choose calendars from ada@acme.co.uk" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disconnect it and add it again.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("checkbox", { name: /Launch team/ })).toBeInTheDocument();
  });

  it(`at ${MAX_CALENDARS} calendars the rest can't be ticked (and it says so)`, async () => {
    const many: ExtCalendar[] = Array.from({ length: 27 }, (_, i) => ({ id: `c${i}`, name: `Calendar ${i}`, color: "#3f7fe0", primary: i === 0, selected: i < MAX_CALENDARS }));
    setup({ loadCalendars: vi.fn(async () => many) });
    fireEvent.click(screen.getByRole("button", { name: "Choose calendars from ada@acme.co.uk" }));
    const extra = await screen.findByRole("checkbox", { name: "Calendar 26" });
    expect(extra).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Calendar 3" })).toBeEnabled();
    expect(screen.getByText(`Up to ${MAX_CALENDARS} calendars per account.`)).toBeInTheDocument();
    // unticking one frees a place
    fireEvent.click(screen.getByRole("checkbox", { name: "Calendar 3" }));
    expect(extra).toBeEnabled();
    expect(await screen.findByText("Saved. Today and Month now show these calendars.")).toBeInTheDocument();
  });

  it("says when an account needs reconnecting, or a calendar couldn't load", () => {
    setup({ warnings: [
      { connectionId: "c-work", provider: "google", accountEmail: "ada@acme.co.uk", reason: "reconnect" },
      { connectionId: "c-home", provider: "microsoft", accountEmail: "ada@outlook.com", calendarId: "fam", calendarName: "Family", reason: "unavailable" },
    ] });
    expect(screen.getByText("Kanbo can no longer read this account. Disconnect it and add it again.")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load “Family” just now. Kanbo will try again.")).toBeInTheDocument();
  });

  it("before the calendar update: each account's main calendar, no chooser, and a note", () => {
    setup({ connections: [{ id: "google", provider: "google", accountEmail: "ada@acme.co.uk", selectedCalendars: null, canChoose: false }] });
    expect(screen.queryByRole("button", { name: /Choose calendars/ })).toBeNull();
    expect(screen.getByText(/adding a second account of the same kind replaces the first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Google account" })).toBeInTheDocument();
  });
});

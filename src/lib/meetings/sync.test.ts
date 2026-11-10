/* lib/meetings/sync in the demo (no Supabase): the same rules as the database's functions, on this browser's
   copy. The demo's last meetings are there from the first read; its teammates join a team meeting, and present
   when handed the agenda, a step at a time. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addItem, deleteItem, endMeeting, getMeeting, handMeeting, joinMeeting, lastMeeting, listAttendees, listItems, liveMeetings, meetingErrorText,
  meetingsMode, moveMeeting, presentMeeting, resetMeetings, setMeetingDoc, startMeeting, subscribeMeeting, updateItem, type MeetingChange, type StartInput,
} from "./sync";
import { DEMO_JOIN_MS, DEMO_LEAD_MEETING, DEMO_STEP_MS, DEMO_TEAM_MEETING, demoMeetingActivity } from "./demo";
import type { AgendaItem } from "./types";

const AGENDA: AgendaItem[] = [
  { key: "overview", kind: "overview", title: "Where things stand", lede: [] },
  { key: "risks", kind: "risks", title: "Radar risks", risks: [] },
  { key: "goals", kind: "goals", title: "Goals behind pace", goals: [] },
  { key: "wrap", kind: "wrap", title: "Wrap up" },
];
const start = (o: Partial<StartInput> = {}) => startMeeting({
  workspaceId: "ws-foundrise", workspaceIds: ["ws-foundrise"], preset: "team", title: "Foundrise team meeting", agenda: AGENDA,
  attendees: ["m-1", "m-2"], docProjectId: "p-launch", previousId: null, me: "m-self", ...o,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetMeetings());
afterEach(() => { vi.useRealTimers(); resetMeetings(); });

describe("the demo's copy", () => {
  it("has last week's meetings from the first read, and their recaps for the Inbox", async () => {
    expect(meetingsMode()).toBe("local");
    const team = await lastMeeting("ws-foundrise", "team", ["ws-foundrise"]);
    expect(team?.meeting.id).toBe(DEMO_TEAM_MEETING);
    expect(team?.items.filter((i) => i.kind === "action")).toHaveLength(5);
    expect((await lastMeeting("ws-courtside", "leadership", ["ws-courtside"]))?.meeting.id).toBe(DEMO_LEAD_MEETING);
    // a Group meeting's last one is only one over the same businesses
    expect(await lastMeeting("ws-foundrise", "leadership", ["ws-foundrise", "ws-reco"])).toBeNull();
    const recaps = demoMeetingActivity();
    expect(recaps.map((a) => [a.kind, a.meta?.meetingId])).toEqual([["meeting", DEMO_TEAM_MEETING], ["meeting", DEMO_LEAD_MEETING]]);
    expect(new Date(recaps[0].createdAt).getDay()).not.toBe(0);   // never a Sunday
  });
  it("starts one (one live meeting of a kind at a time), with you presenting at the top", async () => {
    const r = await start();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ status: "live", place: 0, presenterId: "m-self", startedBy: "m-self", docProjectId: "p-launch" });
    expect((await listAttendees(r.data.id)).map((a) => [a.userId, !!a.joinedAt])).toEqual([["m-self", true], ["m-1", false], ["m-2", false]]);
    expect((await liveMeetings(["ws-foundrise"])).map((m) => m.id)).toEqual([r.data.id]);
    const again = await start();
    expect(again).toEqual({ ok: false, message: "A meeting like this is already running here. Join it instead." });
    // a leadership meeting alongside is fine
    expect((await start({ preset: "leadership" })).ok).toBe(true);
  });
  it("only the presenter moves the agenda; anyone in it takes over; the presenter hands over to someone there", async () => {
    const r = await start();
    if (!r.ok) throw new Error("no meeting");
    const id = r.data.id;
    expect((await moveMeeting(id, 2, "goals", "m-self")).ok).toBe(true);
    expect(await moveMeeting(id, 1, "risks", "m-1")).toEqual({ ok: false, message: "Only the presenter moves the agenda. Present from here to take over." });
    expect((await moveMeeting(id, 9, null, "m-self")).ok).toBe(false);
    expect(await handMeeting(id, "m-1", "m-self")).toEqual({ ok: false, message: "They need to have joined the meeting first." });
    await joinMeeting(id, "m-1");
    const handed = await handMeeting(id, "m-1", "m-self");
    expect(handed.ok && handed.data.presenterId).toBe("m-1");
    const took = await presentMeeting(id, "m-self");
    expect(took.ok && took.data.presenterId).toBe("m-self");
    expect((await getMeeting(id))?.place).toBe(2);
  });
  it("logs notes, decisions and actions, changes and takes them out, and tells whoever's watching", async () => {
    const r = await start();
    if (!r.ok) throw new Error("no meeting");
    const seen: MeetingChange[] = [];
    const off = subscribeMeeting(r.data.id, (c) => seen.push(c));
    const a = await addItem(r.data.id, { kind: "action", body: "  Book   the review ", agendaKey: "risks", ownerId: "m-1", due: "2026-11-13", taskId: null }, "m-self");
    expect(a.ok && a.data).toMatchObject({ kind: "action", body: "Book the review", ownerId: "m-1", agendaKey: "risks", createdBy: "m-self" });
    expect((await addItem(r.data.id, { kind: "note", body: "   ", agendaKey: null, ownerId: null, due: null, taskId: null }, "m-self")).ok).toBe(false);
    if (!a.ok) return;
    await updateItem({ ...a.data, taskId: "t-21" });
    expect((await listItems(r.data.id))[0].taskId).toBe("t-21");
    await deleteItem(a.data);
    expect(await listItems(r.data.id)).toEqual([]);
    await flush();
    expect(seen.filter((c) => c.items).map((c) => c.items!.length)).toEqual([1, 1, 0]);
    off();
  });
  it("ends it once, with its notes doc; it's then the last meeting the next one carries", async () => {
    const r = await start({ previousId: DEMO_TEAM_MEETING });
    if (!r.ok) throw new Error("no meeting");
    await setMeetingDoc(r.data.id, "doc-1", "p-launch", "m-self");
    const e = await endMeeting(r.data.id, "m-self");
    expect(e.ok && e.data).toMatchObject({ status: "ended", endedBy: "m-self", docId: "doc-1", docProjectId: "p-launch", previousId: DEMO_TEAM_MEETING });
    const e2 = await endMeeting(r.data.id, "m-1");
    expect(e2.ok && e2.data.endedBy).toBe("m-self");
    expect((await moveMeeting(r.data.id, 1, null, "m-self")).ok).toBe(false);
    expect((await lastMeeting("ws-foundrise", "team", ["ws-foundrise"]))?.meeting.id).toBe(r.data.id);
    expect(await liveMeetings(["ws-foundrise"])).toEqual([]);
  });
  it("its teammates join a moment after it starts, and present when handed the agenda", async () => {
    vi.useFakeTimers();
    const r = await start();
    if (!r.ok) throw new Error("no meeting");
    await vi.advanceTimersByTimeAsync(DEMO_JOIN_MS[1] + 50);
    expect((await listAttendees(r.data.id)).filter((a) => a.joinedAt).map((a) => a.userId).sort()).toEqual(["m-1", "m-2", "m-self"]);
    await handMeeting(r.data.id, "m-1", "m-self");
    await vi.advanceTimersByTimeAsync(DEMO_STEP_MS + 50);
    expect((await getMeeting(r.data.id))?.place).toBe(1);
    await vi.advanceTimersByTimeAsync(DEMO_STEP_MS * 5);
    expect((await getMeeting(r.data.id))?.place).toBe(AGENDA.length - 1);   // up to the wrap-up, no further
    // take it back: she stops
    await presentMeeting(r.data.id, "m-self");
    await moveMeeting(r.data.id, 0, "overview", "m-self");
    await vi.advanceTimersByTimeAsync(DEMO_STEP_MS * 2);
    expect((await getMeeting(r.data.id))?.place).toBe(0);
  });
});

describe("words for a refusal", () => {
  it("says what happened, in the app's words", () => {
    expect(meetingErrorText({ code: "PGRST202", message: "Could not find the function public.start_meeting" })).toMatch(/0056/);
    expect(meetingErrorText(new Error("not allowed: an action's owner must be on the team"))).toBe("An action's owner has to be on the team (not a guest).");
    expect(meetingErrorText(new Error("meeting closed"))).toBe("This meeting has ended.");
    expect(meetingErrorText(new Error("not authorized"))).toBe("You can't do that here.");
    expect(meetingErrorText(new TypeError("Failed to fetch"))).toBe("Couldn't save that. Check your connection and try again.");
  });
});

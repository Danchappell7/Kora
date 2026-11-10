/* lib/meetings/sync signed in: once 0056 answers, every change goes through its functions (the arguments as the
   database names them, rows read back as the app's shapes); before it's run, the first read says so and meetings
   run in this browser alone; a refusal comes back in the app's words. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();
const rpc = vi.fn();
/** each realtime listener the code asked for: its filter and its callback */
const heard: { filter: Record<string, unknown>; cb: (p: unknown) => void }[] = [];
vi.mock("../supabase", () => ({ supabase: { from: (t: string) => from(t), rpc: (...a: unknown[]) => rpc(...a),
  channel: () => { const ch = { on(_e: string, filter: Record<string, unknown>, cb: (p: unknown) => void) { heard.push({ filter, cb }); return ch; }, subscribe() { return ch; } }; return ch; },
  removeChannel: async () => "ok" }, isSupabaseConfigured: true }));

import { addItem, endMeeting, getMeeting, isDemoMeetings, lastMeeting, liveMeetings, meetingsMode, moveMeeting, probeMeetings, resetMeetings, startMeeting, subscribeLiveMeetings, subscribeMeeting,
  type MeetingChange, type StartInput } from "./sync";

/** a query builder that resolves to `result` however it's chained (and remembers how) */
const calls: string[] = [];
const query = (result: unknown) => {
  const q: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "gt", "order", "limit", "maybeSingle"]) q[k] = (...a: unknown[]) => { calls.push(`${k}(${a.map((x) => JSON.stringify(x)).join(",")})`); return q; };
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad);
  return q;
};
const ROW = {
  id: "m1", workspace_id: "w1", workspace_ids: ["w1"], preset: "team", title: "Alpha team meeting", status: "live",
  agenda: [{ key: "overview", kind: "overview", title: "Where things stand", lede: [] }, { key: "wrap", kind: "wrap", title: "Wrap up" }, { kind: "evil" }],
  place: 0, place_key: "overview", moved_at: "2026-11-10T10:00:00Z", presenter_id: "u1", started_by: "u1", started_at: "2026-11-10T10:00:00Z",
  ended_at: null, ended_by: null, previous_id: null, doc_id: null, doc_project_id: "p1",
};
const input: StartInput = {
  workspaceId: "w1", workspaceIds: ["w1"], preset: "team", title: "  Alpha team meeting ", agenda: [], attendees: ["u2"], docProjectId: "p1", previousId: null, me: "u1",
};

// (the clock is pinned: a live meeting over 12 hours old isn't offered)
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T11:00:00Z"));
  from.mockReset(); rpc.mockReset(); calls.length = 0; heard.length = 0; resetMeetings();
});
afterEach(() => { vi.useRealTimers(); });

describe("before 0056 is run", () => {
  it("the first read says so, and meetings run in this browser (nobody else sees them)", async () => {
    from.mockImplementation(() => query({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.meetings' in the schema cache" } }));
    expect(isDemoMeetings()).toBe(false);
    expect(await probeMeetings()).toBe("local");
    const r = await startMeeting(input);
    expect(r.ok && r.data).toMatchObject({ title: "Alpha team meeting", presenterId: "u1", status: "live" });
    expect(rpc).not.toHaveBeenCalled();
    expect(await liveMeetings(["w1"])).toHaveLength(1);
  });
  it("a function that isn't there yet mid-way: carried on here", async () => {
    from.mockImplementation(() => query({ data: [], error: null }));
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.start_meeting" } });
    const r = await startMeeting(input);
    expect(r.ok).toBe(true);
    expect(meetingsMode()).toBe("local");
  });
});

describe("opened straight from the Inbox", () => {
  it("asks where meetings live first, then reads the meeting from the database", async () => {
    from.mockImplementation(() => query({ data: { ...ROW, status: "ended", ended_at: "2026-11-10T10:30:00Z" }, error: null }));
    const m = await getMeeting("m1");
    expect(meetingsMode()).toBe("shared");
    expect(m).toMatchObject({ id: "m1", status: "ended", title: "Alpha team meeting" });
    expect(calls).toContain('eq("id","m1")');
  });
});

describe("once it's on", () => {
  beforeEach(() => { from.mockImplementation(() => query({ data: [], error: null })); });
  it("starts one through start_meeting, and reads the row back (an agenda item it doesn't know is left out)", async () => {
    rpc.mockResolvedValue({ data: ROW, error: null });
    const r = await startMeeting(input);
    expect(rpc).toHaveBeenCalledWith("start_meeting", {
      p_ws: "w1", p_preset: "team", p_title: "Alpha team meeting", p_workspace_ids: ["w1"], p_agenda: [], p_attendees: ["u2"], p_doc_project: "p1", p_previous: null,
    });
    expect(meetingsMode()).toBe("shared");
    expect(r.ok && r.data).toMatchObject({ id: "m1", workspaceIds: ["w1"], preset: "team", place: 0, presenterId: "u1", docProjectId: "p1" });
    expect(r.ok && r.data.agenda.map((a) => a.kind)).toEqual(["overview", "wrap"]);
  });
  it("moves, logs and ends through their functions", async () => {
    await probeMeetings();
    rpc.mockResolvedValue({ data: { ...ROW, place: 1 }, error: null });
    expect((await moveMeeting("m1", 1, "wrap", "u1")).ok).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith("move_meeting", { p_meeting: "m1", p_place: 1, p_key: "wrap" });
    rpc.mockResolvedValue({ data: { id: "i1", meeting_id: "m1", kind: "action", body: "Book it", agenda_key: "wrap", owner_id: "u2", due_on: "2026-11-13", task_id: null, created_by: "u1", created_at: "x" }, error: null });
    const a = await addItem("m1", { kind: "action", body: " Book   it ", agendaKey: "wrap", ownerId: "u2", due: "2026-11-13", taskId: null }, "u1");
    expect(rpc).toHaveBeenLastCalledWith("add_meeting_item", { p_meeting: "m1", p_kind: "action", p_body: "Book it", p_agenda_key: "wrap", p_owner: "u2", p_due: "2026-11-13", p_task: null });
    expect(a.ok && a.data).toMatchObject({ id: "i1", kind: "action", due: "2026-11-13", ownerId: "u2" });
    rpc.mockResolvedValue({ data: { ...ROW, status: "ended", ended_at: "y", ended_by: "u1", doc_id: "d1" }, error: null });
    const e = await endMeeting("m1", "u1", { docId: "d1", projectId: "p1" });
    expect(rpc).toHaveBeenLastCalledWith("end_meeting", { p_meeting: "m1", p_doc: "d1", p_project: "p1" });
    expect(e.ok && e.data).toMatchObject({ status: "ended", docId: "d1" });
  });
  it("a refusal comes back in the app's words", async () => {
    await probeMeetings();
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "already running" } });
    expect(await startMeeting(input)).toEqual({ ok: false, message: "A meeting like this is already running here. Join it instead." });
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "not the presenter" } });
    expect((await moveMeeting("m1", 1, null, "u2")).ok).toBe(false);
    expect(meetingsMode()).toBe("shared");
  });
  it("reads the live ones in these businesses, and the last one over the same businesses", async () => {
    from.mockImplementation(() => query({ data: [ROW], error: null }));
    await probeMeetings();
    calls.length = 0;
    expect((await liveMeetings(["w1", "w2"])).map((m) => m.id)).toEqual(["m1"]);
    expect(calls).toEqual(expect.arrayContaining(['eq("status","live")', 'in("workspace_id",["w1","w2"])']));
    from.mockImplementation((t: string) => query(t === "meetings"
      ? { data: [{ ...ROW, id: "g", workspace_ids: ["w1", "w2"], status: "ended" }, { ...ROW, id: "m0", status: "ended" }], error: null }
      : { data: [{ id: "i", meeting_id: "m0", kind: "decision", body: "Yes", agenda_key: null, owner_id: null, due_on: null, task_id: null, created_by: "u1", created_at: "x" }], error: null }));
    const last = await lastMeeting("w1", "team", ["w1"]);
    expect(last?.meeting.id).toBe("m0");
    expect(last?.items.map((i) => i.kind)).toEqual(["decision"]);
    // a Group meeting is found by its businesses, whichever of them hosted it
    calls.length = 0;
    from.mockImplementation((t: string) => query(t === "meetings"
      ? { data: [{ ...ROW, id: "g2", workspace_id: "w2", workspace_ids: ["w1", "w2"], preset: "leadership", status: "ended" }], error: null } : { data: [], error: null }));
    expect((await lastMeeting("w1", "leadership", ["w2", "w1"]))?.meeting.id).toBe("g2");
    expect(calls).toContain('in("workspace_id",["w1","w2"])');
  });
  it("leaves out a meeting left live over 12 hours", async () => {
    from.mockImplementation(() => query({ data: [ROW, { ...ROW, id: "old", started_at: "2026-11-09T20:00:00Z" }], error: null }));
    await probeMeetings();
    calls.length = 0;
    expect((await liveMeetings(["w1"])).map((m) => m.id)).toEqual(["m1"]);
    expect(calls).toContain('gt("started_at","2026-11-09T23:00:00.000Z")');
  });
});

describe("live", () => {
  beforeEach(() => { from.mockImplementation(() => query({ data: [], error: null })); });
  it("a presenter's move that comes without the (unchanged, stored apart) agenda keeps the agenda: read once, then kept", async () => {
    await probeMeetings();
    const got: MeetingChange[] = [];
    subscribeMeeting("m1", (c) => got.push(c));
    const row = heard.find((h) => h.filter.table === "meetings")!;
    // nothing known yet: the row is read again, agenda and all
    from.mockImplementation(() => query({ data: { ...ROW, place: 1 }, error: null }));
    const { agenda: _a, ...noAgenda } = ROW;
    row.cb({ new: { ...noAgenda, place: 1 } });
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0].meeting?.agenda.map((a) => a.kind)).toEqual(["overview", "wrap"]);
    // then a move keeps the agenda it has, with no read
    from.mockClear();
    row.cb({ new: { ...noAgenda, place: 0, place_key: "overview" } });
    expect(got[1].meeting).toMatchObject({ place: 0, placeKey: "overview" });
    expect(got[1].meeting?.agenda).toHaveLength(2);
    expect(from).not.toHaveBeenCalled();
  });
  it("“Live now” asks again for a start or an end, never for a presenter's move", async () => {
    await probeMeetings();
    const onChange = vi.fn();
    subscribeLiveMeetings(onChange, () => new Map([["m1", "live"]]));
    const update = heard.find((h) => h.filter.event === "UPDATE")!;
    update.cb({ new: { ...ROW, place: 3 } });
    expect(onChange).not.toHaveBeenCalled();
    update.cb({ new: { ...ROW, status: "ended" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    // one elsewhere asks once, then its moves don't
    update.cb({ new: { ...ROW, id: "m9" } });
    update.cb({ new: { ...ROW, id: "m9", place: 2 } });
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("Live now, when the first button mounts before anyone has asked whether 0056 is on", () => {
  it("listens where meetings live once the answer's in (a teammate's meeting shows without leaving the page)", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { resetMeetingBus, useLiveMeetings } = await import("../../components/meetings/meetingBus");
    resetMeetingBus();
    from.mockImplementation(() => query({ data: [], error: null }));
    expect(meetingsMode()).toBe("unknown");
    const { unmount } = renderHook(() => useLiveMeetings(["w1"]));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(meetingsMode()).toBe("shared");
    const inserts = heard.filter((h) => h.filter.table === "meetings" && h.filter.event === "INSERT");
    expect(inserts).toHaveLength(1);
    // a meeting started elsewhere: the buttons look again
    from.mockClear();
    await act(async () => { inserts[0].cb({ new: { id: "m9", status: "live" } }); await new Promise((r) => setTimeout(r, 0)); });
    expect(from).toHaveBeenCalledWith("meetings");
    unmount();
    resetMeetingBus();
  });
});

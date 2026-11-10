import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();
const rpc = vi.fn();
vi.mock("./supabase", () => ({ supabase: { from: (t: string) => from(t), rpc: (...a: unknown[]) => rpc(...a), channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: async () => "ok" }, isSupabaseConfigured: true }));

import { getAvailability, resetAvailability, updateAvailability } from "./availability";
import { changeMatters, loadAvailability, refreshAvailability, saveTimeOff, saveWeek } from "./availabilitySync";

/** a query builder that resolves to `result` however it's chained */
const query = (result: unknown) => {
  const q: Record<string, unknown> = {};
  for (const k of ["select", "gte", "eq", "order"]) q[k] = () => q;
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad);
  return q;
};

beforeEach(() => { from.mockReset(); rpc.mockReset(); resetAvailability(); });
afterEach(() => resetAvailability());

describe("signed in", () => {
  it("before 0055 is run, says it's off (and nothing else is read)", async () => {
    from.mockImplementation(() => query({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.member_availability' in the schema cache" } }));
    expect(await loadAvailability("2026-11-10")).toEqual({ status: "off", weeks: [], timeOff: [], rates: [] });
    expect(from).toHaveBeenCalledTimes(1);
  });
  it("a passing failure keeps what the app has", async () => {
    updateAvailability({ status: "on", weeks: [{ workspaceId: "w", userId: "u", weeklyHours: 20, workDays: [1], dayStart: 480, dayEnd: 1080 }] });
    from.mockImplementation(() => query({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }));
    expect(await refreshAvailability("2026-11-10")).toBe("on");
    expect(getAvailability().weeks).toHaveLength(1);
  });
  it("reads weeks, time off (with the reasons RLS lets through) and rates", async () => {
    from.mockImplementation((t: string) => query(t === "member_availability"
      ? { data: [{ workspace_id: "w", user_id: "u", weekly_hours: "32.0", work_days: [4, 1, 2, 3], day_start: 540, day_end: 1050 }], error: null }
      : t === "time_off" ? { data: [{ id: "o1", user_id: "u", workspace_id: "w", starts_on: "2026-11-11", ends_on: "2026-11-12", half_day: null }, { id: "o2", user_id: "v", starts_on: "2026-11-20", ends_on: "2026-11-20", half_day: "pm" }], error: null }
      : t === "time_off_notes" ? { data: [{ time_off_id: "o1", reason: "Wedding" }], error: null }
      : { data: [{ workspace_id: "w", project_id: null, hourly_rate: "85.00" }], error: null }));
    const got = await loadAvailability("2026-11-10");
    expect(got).toEqual({
      status: "on",
      weeks: [{ workspaceId: "w", userId: "u", weeklyHours: 32, workDays: [1, 2, 3, 4], dayStart: 540, dayEnd: 1050 }],
      timeOff: [{ id: "o1", userId: "u", workspaceId: "w", startsOn: "2026-11-11", endsOn: "2026-11-12", halfDay: null, reason: "Wedding" },
        { id: "o2", userId: "v", workspaceId: null, startsOn: "2026-11-20", endsOn: "2026-11-20", halfDay: "pm" }],
      rates: [{ workspaceId: "w", projectId: null, rate: 85 }],
    });
  });
  it("saves through the functions, and puts the store back when the server says no", async () => {
    updateAvailability({ status: "on", weeks: [], timeOff: [] });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "not authorized" } });
    const r = await saveWeek({ workspaceId: "w", userId: "u", weeklyHours: 10, workDays: [1], dayStart: 480, dayEnd: 1080 });
    expect(r).toEqual({ ok: false, message: "You can't change that. Owners and admins can, or the person themselves." });
    expect(rpc).toHaveBeenCalledWith("set_member_availability", { p_ws: "w", p_user: "u", p_weekly_hours: 10, p_work_days: [1], p_day_start: 480, p_day_end: 1080 });
    expect(getAvailability().weeks).toEqual([]);
    rpc.mockResolvedValueOnce({ data: { id: "srv-1", user_id: "u", workspace_id: "ws", starts_on: "2026-12-01", ends_on: "2026-12-01", half_day: "am" }, error: null });
    const t = await saveTimeOff({ userId: "u", workspaceId: "ws", startsOn: "2026-12-01", endsOn: "2026-12-01", halfDay: "am", reason: "Dentist" });
    expect(t).toEqual({ ok: true, id: "srv-1" });
    expect(rpc).toHaveBeenLastCalledWith("save_time_off", { p_id: null, p_ws: "ws", p_user: "u", p_starts: "2026-12-01", p_ends: "2026-12-01", p_half: "am", p_reason: "Dentist" });
    expect(getAvailability().timeOff).toEqual([{ id: "srv-1", userId: "u", workspaceId: "ws", startsOn: "2026-12-01", endsOn: "2026-12-01", halfDay: "am", reason: "Dentist" }]);
  });
  it("a deleted row reloads only when it's a day off on screen (a delete reaches everyone, with just its id)", () => {
    const s = { ...getAvailability(), timeOff: [{ id: "o1", userId: "u", startsOn: "2026-11-11", endsOn: "2026-11-12", halfDay: null }] };
    expect(changeMatters("time_off", { eventType: "INSERT", old: {} }, s)).toBe(true);
    expect(changeMatters("member_availability", { eventType: "UPDATE", old: {} }, s)).toBe(true);
    expect(changeMatters("time_off", { eventType: "DELETE", old: { id: "o1" } }, s)).toBe(true);
    expect(changeMatters("time_off", { eventType: "DELETE", old: { id: "someone-elses" } }, s)).toBe(false);
    expect(changeMatters("member_availability", { eventType: "DELETE", old: {} }, s)).toBe(false);
  });
});

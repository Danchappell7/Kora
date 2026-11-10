import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAvailability, resetAvailability, updateAvailability } from "./availability";
import {
  deleteTimeOff, isMissingSchema, loadAvailability, refreshAvailability, resetDemoAvailability, rowToTimeOff, saveErrorText, saveRate, saveTimeOff, saveWeek, uploadLocalCapacities,
} from "./availabilitySync";

// (no Supabase in tests: the demo's in-memory copy)
beforeEach(() => { resetAvailability(); resetDemoAvailability(); localStorage.clear(); });
afterEach(() => { resetAvailability(); resetDemoAvailability(); localStorage.clear(); });

describe("the demo's shared availability", () => {
  it("loads Theo off today, Sana away from tomorrow, Maya's four-day week and Foundrise's rates", async () => {
    const got = await loadAvailability("2026-11-10");
    expect(got?.status).toBe("on");
    expect(got?.timeOff.map((t) => [t.userId, t.reason])).toEqual([["m-2", "Moving house"], ["m-3", "Family wedding"], ["m-1", "Dentist"]]);
    expect(got?.weeks.find((w) => w.userId === "m-1" && w.workspaceId === "ws-foundrise")).toMatchObject({ weeklyHours: 32, workDays: [1, 2, 3, 4] });
    expect(got?.rates.filter((r) => r.workspaceId === "ws-foundrise").map((r) => r.rate)).toEqual([85, 95, 110]);
  });
  it("saves a week, time off and a rate into the store, and refuses days already off", async () => {
    await refreshAvailability("2026-11-10");
    expect((await saveWeek({ workspaceId: "ws-foundrise", userId: "m-self", weeklyHours: 36, workDays: [5, 1, 2], dayStart: 510, dayEnd: 1050 })).ok).toBe(true);
    expect(getAvailability().weeks.find((w) => w.userId === "m-self")).toMatchObject({ weeklyHours: 36, workDays: [1, 2, 5] });
    const r = await saveTimeOff({ userId: "m-self", startsOn: "2027-01-04", endsOn: "2027-01-08", halfDay: null, reason: "  Skiing " });
    expect(r.ok).toBe(true);
    expect(getAvailability().timeOff.find((t) => t.id === r.id)).toMatchObject({ reason: "Skiing" });
    const clash = await saveTimeOff({ userId: "m-self", startsOn: "2027-01-06", endsOn: "2027-01-06", halfDay: null, reason: null });
    expect(clash).toEqual({ ok: false, message: "They're already off on one of those days." });
    expect(getAvailability().timeOff.filter((t) => t.userId === "m-self")).toHaveLength(1);
    expect((await deleteTimeOff(r.id!)).ok).toBe(true);
    expect(getAvailability().timeOff.some((t) => t.id === r.id)).toBe(false);
    await saveRate("ws-foundrise", "p-launch", null);
    expect(getAvailability().rates.some((x) => x.projectId === "p-launch")).toBe(false);
    // a reload keeps what was saved
    await refreshAvailability("2026-11-10");
    expect(getAvailability().weeks.find((w) => w.userId === "m-self")?.weeklyHours).toBe(36);
  });
  it("hands this device's capacities over once, then never again", async () => {
    localStorage.setItem("kanbo-capacity", JSON.stringify({ "m-2": 30, "m-1": 20 }));
    updateAvailability({ me: "m-self", activeWs: "ws-foundrise", roles: { "ws-foundrise": { "m-self": "owner", "m-1": "member", "m-2": "member" } } });
    await refreshAvailability("2026-11-10");
    // Maya's week already has hours (32h): only Theo's goes up
    expect(await uploadLocalCapacities()).toBe(1);
    expect(getAvailability().weeks.find((w) => w.userId === "m-2" && w.workspaceId === "ws-foundrise")?.weeklyHours).toBe(30);
    expect(getAvailability().weeks.find((w) => w.userId === "m-1" && w.workspaceId === "ws-foundrise")?.weeklyHours).toBe(32);
    expect(localStorage.getItem("kanbo-capacity-shared:m-self")).toBe("1");
    expect(await uploadLocalCapacities()).toBe(0);
  });
});

describe("errors", () => {
  it("knows a database without 0055", () => {
    for (const code of ["42P01", "PGRST205", "42883", "PGRST202", "42703", "PGRST204"]) expect(isMissingSchema({ code })).toBe(true);
    expect(isMissingSchema({ message: 'relation "public.time_off" does not exist' })).toBe(true);
    expect(isMissingSchema({ code: "42501", message: "permission denied" })).toBe(false);
  });
  it("says what went wrong in the app's words", () => {
    expect(saveErrorText({ message: "not authorized" })).toMatch(/^You can't change that/);
    expect(saveErrorText({ message: "invalid availability" })).toMatch(/^That doesn't look right/);
    expect(saveErrorText({ message: "not allowed: only the team's owners, admins and members carry capacity" })).toBe("Guests don't carry team capacity.");
    expect(saveErrorText({ code: "PGRST202" })).toMatch(/aren't switched on yet/);
  });
});

describe("a time off row", () => {
  it("keeps who recorded it (0055's created_by: the agenda carries only what the host's team reads)", () => {
    const row = { id: "t1", user_id: "maya", workspace_id: "w2", starts_on: "2026-11-10", ends_on: "2026-11-10", half_day: null };
    expect(rowToTimeOff({ ...row, created_by: "lead" })).toMatchObject({ userId: "maya", workspaceId: "w2", createdBy: "lead" });
    expect(rowToTimeOff(row).createdBy).toBeUndefined();
  });
});

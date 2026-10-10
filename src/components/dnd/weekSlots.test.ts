import { describe, it, expect } from "vitest";
import { stripMinute, stripY, hhmm, minuteOf, weekPatch, undoPatch, slotLabel, WEEK_SLOT_FROM, WEEK_SLOT_TO } from "./weekSlots";

describe("My week's drop maths", () => {
  it("the strip: top 07:00, bottom 21:00 less a step, on the quarter hour", () => {
    expect(stripMinute(0)).toBe(WEEK_SLOT_FROM);
    expect(stripMinute(1)).toBe(WEEK_SLOT_TO - 15);
    expect(stripMinute(0.5)).toBe(14 * 60);
    expect(stripMinute(0.601)).toBe(15 * 60 + 30);
    expect(stripMinute(-3)).toBe(WEEK_SLOT_FROM);
    expect(stripMinute(Number.NaN)).toBe(WEEK_SLOT_FROM);
    expect(stripY(14 * 60)).toBe(0.5);
    expect(stripY(0)).toBe(0);
  });

  it("times read and write as HH:MM", () => {
    expect(hhmm(570)).toBe("09:30");
    expect(minuteOf("9:05")).toBe(545);
    expect(minuteOf("15:30:00")).toBe(930);
    expect(minuteOf("noon")).toBeNull();
    expect(minuteOf(undefined)).toBeNull();
    expect(slotLabel("Fri 9 Oct", 630)).toBe("Fri 9 Oct, 10:30");
    expect(slotLabel("Today", null)).toBe("Today");
  });

  it("a move keeps the time; a slot sets it; Any time clears it; No date clears both; no change → null", () => {
    const t = { dueDate: "2026-10-09", dueTime: "15:00" };
    expect(weekPatch(t, "2026-10-12")).toEqual({ dueDate: "2026-10-12" });
    expect(weekPatch(t, "2026-10-09")).toBeNull();
    expect(weekPatch(t, "2026-10-09", 600)).toEqual({ dueTime: "10:00" });
    expect(weekPatch(t, "2026-10-10", 900)).toEqual({ dueDate: "2026-10-10" });
    expect(weekPatch(t, "2026-10-09", null)).toEqual({ dueTime: undefined });
    expect(weekPatch(t, null)).toEqual({ dueDate: undefined, dueTime: undefined });
    expect(weekPatch({}, null)).toBeNull();
    expect(weekPatch({ dueDate: "2026-10-09T00:00:00Z" }, "2026-10-09")).toBeNull();
    expect(undoPatch(t, { dueDate: "2026-10-12" })).toEqual({ dueDate: "2026-10-09" });
    expect(undoPatch({}, { dueDate: "2026-10-12", dueTime: "10:00" })).toEqual({ dueDate: undefined, dueTime: undefined });
  });
});

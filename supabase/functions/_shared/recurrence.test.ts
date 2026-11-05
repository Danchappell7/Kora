// @vitest-environment node
import { describe, expect, it } from "vitest";
import { nextOccurrence, seriesAnchorDay } from "../../../src/data/data.ts";
import { daysBetweenISO, nextDueDateFrom, nextOccurrenceDates, parseLocalDay, shiftISO } from "./recurrence.ts";
import type { Task } from "../../../src/data/types.ts";

const JAN = new Date(2026, 0, 15);
const mid = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe("the next date", () => {
  it("keeps a month's day, clamping short months and finding its way back", () => {
    const today = mid(2026, 1, 1);
    expect(nextDueDateFrom("2026-01-31", "monthly", today, 31)).toBe("2026-02-28");
    expect(nextDueDateFrom("2026-02-28", "monthly", today, 31)).toBe("2026-03-31");
    expect(nextDueDateFrom("2026-08-31", "monthly", today, 31)).toBe("2026-09-30");
  });
  it("steps by a day, a working day, a week or a fortnight", () => {
    const today = mid(2026, 1, 1);
    expect(nextDueDateFrom("2026-11-06", "daily", today)).toBe("2026-11-07");
    expect(nextDueDateFrom("2026-11-06", "weekdays", today)).toBe("2026-11-09");
    expect(nextDueDateFrom("2026-11-06", "weekly", today)).toBe("2026-11-13");
    expect(nextDueDateFrom("2026-11-06", "biweekly", today)).toBe("2026-11-20");
  });
  it("rolls forward past today, and starts from today with no date", () => {
    expect(nextDueDateFrom("2020-01-06", "weekly", mid(2026, 11, 5))).toBe("2026-11-09");
    expect(nextDueDateFrom(null, "daily", mid(2026, 11, 5))).toBe("2026-11-06");
  });
});

describe("the next occurrence's dates", () => {
  it("moves a start date with the due date", () => {
    expect(nextOccurrenceDates({ recurrence: "weekly", dueDate: "2026-11-06", startDate: "2026-11-02" }, mid(2026, 11, 1)))
      .toEqual({ dueDate: "2026-11-13", startDate: "2026-11-09", originalDueDate: null, shiftDays: 7 });
  });
  it("a monthly series remembers its day", () => {
    const first = nextOccurrenceDates({ recurrence: "monthly", dueDate: "2026-01-31" }, mid(2026, 1, 1));
    expect(first).toMatchObject({ dueDate: "2026-02-28", originalDueDate: "2026-01-31" });
    const second = nextOccurrenceDates({ recurrence: "monthly", dueDate: first.dueDate, originalDueDate: first.originalDueDate }, mid(2026, 2, 1));
    expect(second).toMatchObject({ dueDate: "2026-03-31", originalDueDate: "2026-01-31" });
  });
  it("agrees with the app's nextOccurrence on every step of a year", () => {
    const task = (o: Partial<Task>) => ({ id: "t", title: "x", subtasks: [], ...o }) as unknown as Task;
    const today = new Date(2020, 0, 1);
    for (const recurrence of ["daily", "weekdays", "weekly", "biweekly", "monthly"] as const) {
      let due = "2030-01-31";
      let original: string | undefined;
      for (let i = 0; i < 14; i++) {
        const app = nextOccurrence(task({ recurrence, dueDate: due, startDate: "2030-01-20", originalDueDate: original }), "n");
        const ours = nextOccurrenceDates({ recurrence, dueDate: due, startDate: "2030-01-20", originalDueDate: original }, today);
        expect(ours.dueDate, `${recurrence} ${due}`).toBe(app.dueDate);
        expect(ours.startDate).toBe(app.startDate);
        expect(ours.originalDueDate ?? undefined).toBe(app.originalDueDate);
        due = ours.dueDate;
        original = ours.originalDueDate ?? undefined;
      }
    }
    expect(seriesAnchorDay({ dueDate: "2026-02-28", originalDueDate: "2026-01-31" })).toBe(31);
  });
  it("small helpers", () => {
    expect(parseLocalDay("nope")).toBeNull();
    expect(daysBetweenISO("2026-10-24", "2026-10-26")).toBe(2);
    expect(shiftISO("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftISO("2026-11-30", 0)).toBe("2026-11-30");
    expect(JAN.getDate()).toBe(15);
  });
});

import { describe, expect, it } from "vitest";
import { retargetSummary, stayedCount } from "./retargetNotes";

describe("retargetSummary: what's said when a change to several tasks met the backstop", () => {
  const stay = (t: string) => `Sana Rao can't see Payroll, so “${t}” stays with its assignee.`;
  const mine = (t: string) => `Maya Lin isn't in Harbour, so “${t}” is now assigned to you.`;
  it("one note is said as it is; none says nothing", () => {
    expect(retargetSummary([stay("Renew")])).toBe(stay("Renew"));
    expect(retargetSummary([])).toBeNull();
  });
  it("several are counted by what happened (never 'reassigned to you' when they stayed)", () => {
    expect(retargetSummary([stay("A"), stay("B")])).toBe("2 tasks stayed with their assignees: the person picked can't see their projects.");
    expect(retargetSummary([mine("A"), mine("B"), stay("C")]))
      .toBe("1 task stayed with its assignee: the person picked can't see its project. 2 tasks are now assigned to you: their assignees can't see where they went.");
    expect(stayedCount([stay("A"), mine("B")])).toBe(1);
  });
});

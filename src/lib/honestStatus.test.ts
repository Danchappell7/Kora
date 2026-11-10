/* lib/honestStatus: the lead's call and Kanbo's read as one pill, and the composer's one question. */
import { describe, it, expect } from "vitest";
import { honestQuestion, kanboCounts, kanboSees, leadCall, mergedStatus, rosier } from "./honestStatus";

describe("Kanbo's read in words", () => {
  it("says what it counts, and nothing when there's nothing", () => {
    expect(kanboCounts({ overdue: 4, blocked: 2 })).toBe("4 overdue and 2 blocked");
    expect(kanboCounts({ overdue: 1, blocked: 0 })).toBe("1 overdue");
    expect(kanboCounts({ overdue: 0, blocked: 0 })).toBe("");
    expect(kanboSees({ health: "off_track", overdue: 4, blocked: 2 })).toBe("Kanbo sees 4 overdue and 2 blocked");
    expect(kanboSees({ health: "on_track", overdue: 0, blocked: 0 })).toBe("Kanbo sees nothing overdue or blocked");
    expect(kanboSees({ health: "complete", overdue: 0, blocked: 0 })).toBe("Kanbo sees every task done");
    expect(kanboSees({ health: null, overdue: 0, blocked: 0 })).toBe("Kanbo sees no tasks yet");
  });
});

describe("the composer's question", () => {
  it("asks once, calmly, when On track meets overdue or blocked work", () => {
    expect(honestQuestion("on_track", { health: "off_track", overdue: 4, blocked: 2 })).toBe("Kanbo sees 4 overdue and 2 blocked. Keep On track, or add a plan to recover?");
    expect(honestQuestion("on_track", { health: "at_risk", overdue: 0, blocked: 1 })).toBe("Kanbo sees 1 blocked. Keep On track, or add a plan to recover?");
  });
  it("doesn't ask when the call already says so, or the work agrees", () => {
    expect(honestQuestion("at_risk", { health: "off_track", overdue: 4, blocked: 2 })).toBeNull();
    expect(honestQuestion("on_hold", { health: "off_track", overdue: 4, blocked: 2 })).toBeNull();
    expect(honestQuestion("on_track", { health: "on_track", overdue: 0, blocked: 0 })).toBeNull();
    expect(honestQuestion("on_track", { health: null, overdue: 0, blocked: 0 })).toBeNull();
  });
});

describe("one merged pill", () => {
  it("wears the lead's call; a rosier call than the work is a mismatch, sorted first", () => {
    const m = mergedStatus({}, { status: "on_track" }, { health: "off_track", overdue: 4, blocked: 2 });
    expect(m).toMatchObject({ label: "On track", tone: "ok", lead: "on_track", kanbo: "off_track", mismatch: true, kanboTone: "signal",
      says: "Lead says On track", sees: "Kanbo sees 4 overdue and 2 blocked", rank: 0 });
    const agrees = mergedStatus({}, { status: "off_track" }, { health: "off_track", overdue: 4, blocked: 2 });
    expect(agrees.mismatch).toBe(false);
    expect(m.rank).toBeLessThan(agrees.rank);
    // worse off sorts ahead among the rest
    expect(agrees.rank).toBeLessThan(mergedStatus({}, { status: "on_track" }, { health: "on_track", overdue: 0, blocked: 0 }).rank);
  });
  it("a gloomier call than the work isn't a mismatch (the lead knows something Kanbo doesn't)", () => {
    expect(rosier("off_track", "on_track")).toBe(false);
    expect(mergedStatus({}, { status: "at_risk" }, { health: "on_track", overdue: 0, blocked: 0 }).mismatch).toBe(false);
  });
  it("no update: Kanbo's read is the pill, and it says nobody's posted", () => {
    expect(mergedStatus({}, undefined, { health: "at_risk", overdue: 1, blocked: 0 })).toMatchObject({ label: "At risk", tone: "warn", lead: null, says: "No update yet", mismatch: false });
    expect(mergedStatus({}, undefined, { health: null, overdue: 0, blocked: 0 })).toMatchObject({ label: "No update", tone: "neutral" });
  });
  it("set by hand before the first update says so; On hold set by hand stays, whatever's posted", () => {
    expect(mergedStatus({ status: "at_risk" }, undefined, { health: "on_track", overdue: 0, blocked: 0 })).toMatchObject({ label: "At risk", says: "Set by hand: At risk" });
    expect(leadCall({ status: "on_hold" }, { status: "on_track" })).toBe("on_hold");
    const held = mergedStatus({ status: "on_hold" }, { status: "on_track" }, { health: "off_track", overdue: 5, blocked: 0 });
    expect(held).toMatchObject({ label: "On hold", tone: "neutral", mismatch: false, says: "Set by hand: On hold" });
    // an On hold update is the lead's call too
    expect(mergedStatus({}, { status: "on_hold" }, { health: "off_track", overdue: 5, blocked: 0 })).toMatchObject({ label: "On hold", mismatch: false, says: "Lead says On hold" });
  });
});

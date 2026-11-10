/* lib/updateSections (0054): an update's four optional parts, read from anything, said in words, and drafted on this
   device from the same facts as the update (Asks stay the person's own). */
import { describe, it, expect } from "vitest";
import { askPeopleIn, draftSectionsLocal, draftUpdateLocal, hasSections, parseSections, sectionsAsText } from "./updateSections";
import type { WorkspaceMember } from "../data/types";
import type { StatusFacts } from "./statusDraft";
import type { Task } from "../data/types";

const task = (id: string, title: string, over: Partial<Task> = {}): Task => ({
  id, title, description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "", tags: [], dependencies: [], subtasks: [],
  focusMin: 0, comments: 0, aiScore: 0, ...over,
} as Task);
const facts = (over: Partial<StatusFacts> = {}): StatusFacts => ({
  project: { id: "p", name: "Launch" }, today: "2026-11-10", total: 6, open: 4, openAll: 4, pct: 33, done7: [], created7: [], slipped: [], blocked: [], overdue: [],
  waitingOn: {}, health: "on_track", healthDetail: "", lastUpdateDays: 3, changes: 0, ...over,
});

describe("sections", () => {
  it("keeps the four parts, trimmed, and drops everything else", () => {
    expect(parseSections({ highlights: " Shipped ", risks: "", asks: 4, next: "Review", gossip: "no" })).toEqual({ highlights: "Shipped", next: "Review" });
    expect(parseSections(null)).toBeUndefined();
    expect(parseSections(["highlights"])).toBeUndefined();
    expect(parseSections({ risks: "  " })).toBeUndefined();
    expect(hasSections({ risks: " " })).toBe(false);
    expect(hasSections({ next: "Ship" })).toBe(true);
  });
  it("says them in words, in order, one per line", () => {
    expect(sectionsAsText({ next: "Review Wednesday", highlights: "Palette shipped", asks: "Approve the hero" }))
      .toBe("Highlights: Palette shipped\nAsks: Approve the hero\nNext: Review Wednesday");
    expect(sectionsAsText(undefined)).toBe("");
  });
  it("drafts Highlights, Risks and Next from the facts, never Asks", () => {
    const deck = task("t1", "Finalise launch narrative deck.", { dueDate: "2026-11-12" });
    const blocked = task("t2", "Ship onboarding", { status: "blocked" });
    const tokens = task("t3", "Define tokens v2");
    const s = draftSectionsLocal(facts({
      done7: [task("d1", "Approve budget", { status: "done" }), task("d2", "Pick launch date", { status: "done" })],
      blocked: [blocked], waitingOn: { t2: [tokens] }, overdue: [task("o1", "Record demo video", { dueDate: "2026-11-01" })],
      nextMilestone: task("m1", "Launch day", { isMilestone: true, dueDate: "2026-11-18" }), criticalPath: deck,
    }));
    expect(s.highlights).toBe("Done this week: Approve budget and Pick launch date.");
    expect(s.risks).toBe("Ship onboarding is blocked on Define tokens v2. Overdue: Record demo video.");
    expect(s.next).toBe("Launch day, Wed 18 Nov. Unblock the critical path: Finalise launch narrative deck.");
    expect(s.asks).toBeUndefined();
    expect(draftSectionsLocal(facts())).toEqual({});
  });
  it("Kanbo's whole draft says each thing once: a headline in the words, the details in the sections", () => {
    const deck = task("t1", "Finalise launch narrative deck.", { dueDate: "2026-11-12" });
    const blocked = task("t2", "Ship onboarding", { status: "blocked" });
    const d = draftUpdateLocal(facts({
      blocked: [blocked], waitingOn: { t2: [task("t3", "Define tokens v2")] }, overdue: [task("o1", "Record demo video", { dueDate: "2026-11-01" })],
      nextMilestone: task("m1", "Launch day", { isMilestone: true, dueDate: "2026-11-18" }), criticalPath: deck, health: "at_risk",
    }));
    expect(d.summary).toBe("Nothing finished this week; 33% done overall. Finalise launch narrative deck is the critical path, due Thu 12 Nov.");
    expect(d.sections).toEqual({ risks: "Ship onboarding is blocked on Define tokens v2. Overdue: Record demo video.", next: "Launch day, Wed 18 Nov." });
    // nothing a section could say twice is in the words
    for (const line of Object.values(d.sections)) expect(d.summary).not.toContain(line!.replace(/\.$/, ""));
    expect(d.status).toBe("at_risk");
    // nothing for the sections: the words say it all
    expect(draftUpdateLocal(facts())).toEqual({ summary: "Nothing finished this week; 33% done overall.", status: "on_track", sections: {} });
  });
  it("an Ask can be for anyone active in the project's workspace (a guest too), never you; nobody in Personal", () => {
    const m = (userId: string, workspaceId: string, role: WorkspaceMember["role"], status: WorkspaceMember["status"] = "active"): WorkspaceMember =>
      ({ id: `${userId}-${workspaceId}`, workspaceId, userId, email: `${userId}@x.org`, name: userId, role, status });
    const members = [m("me", "w1", "owner"), m("ana", "w1", "member"), m("gus", "w1", "guest"), m("left", "w1", "member", "invited"), m("other", "w2", "member")];
    expect(askPeopleIn(members, "w1", "me").map((p) => p.id)).toEqual(["ana", "gus"]);
    expect(askPeopleIn(members, null, "me")).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BUSINESS_PACKS, findPack } from "../packs";
import {
  buildPackPlan, cleanBusinesses, defaultAnchorDay, defaultPick, expandPack, isPartOn, packCounts, packCountsLine, packHasParts, packPart, packQuarter,
  packQuarterChoices, packStats, tasksBehind, type PackContext, type PackPick,
} from "./packPlan";
import { anchoredDay, monthDay } from "./templates";
import { SPECTRUM } from "./projectIdentity";
import { blockText } from "./docBlocks";
import { periodRange } from "./goalPeriods";
import type { WorkspaceTemplate } from "../data/types";

const SPECTRUM_KEYS = new Set(SPECTRUM.map((s) => s.key));
const FIELD_KEYS = new Set(["description", "priority", "dueDate"]);
/** Tue 10 Nov 2026 */
const TODAY = new Date(2026, 10, 10);
const ctx = (over: Partial<PackContext> = {}): PackContext => ({ today: TODAY, goalsV2: true, canSetGoals: true, canSetUpdateDay: true, businesses: [], ...over });
const pick = (pack: WorkspaceTemplate, over: Partial<PackPick> = {}): PackPick => ({ ...defaultPick(pack, { today: TODAY }), ...over });
const fitness = findPack("pack-fitness")!;

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 10, 9, 0)); });
afterEach(() => { vi.useRealTimers(); });

describe("business packs: the content", () => {
  it("has the six packs, in gallery order, with unique ids", () => {
    expect(BUSINESS_PACKS.map((p) => p.name)).toEqual(["Boutique fitness group", "Padel or sports venue", "Advisory firm", "Agency", "Startup", "Holding company"]);
    expect(new Set(BUSINESS_PACKS.map((p) => p.id)).size).toBe(6);
    for (const p of BUSINESS_PACKS) expect(findPack(p.id)).toBe(p);
    expect(findPack("nope")).toBeUndefined();
  });

  it.each(BUSINESS_PACKS.map((p) => [p.name, p] as const))("%s is complete and every reference in it resolves", (_n, pack) => {
    expect(SPECTRUM_KEYS.has(pack.hue)).toBe(true);
    expect(pack.audience).toBeTruthy();
    expect(pack.summary.length).toBeGreaterThan(40);
    expect(pack.summary.length).toBeLessThanOrEqual(170);
    expect(pack.updateRhythm).toBeTruthy();
    expect(pack.projects.length).toBeGreaterThanOrEqual(3);
    expect(pack.projects.length).toBeLessThanOrEqual(5);
    const keys = new Set(pack.projects.map((p) => p.key));
    expect(keys.size).toBe(pack.projects.length);
    expect(new Set(pack.projects.map((p) => p.name)).size).toBe(pack.projects.length);
    for (const p of pack.projects) {
      expect(SPECTRUM_KEYS.has(p.hue), p.name).toBe(true);
      expect(p.description, p.name).toBeTruthy();
      expect(p.tasks.length, p.name).toBeGreaterThanOrEqual(2);
      expect(p.tasks.length, p.name).toBeLessThanOrEqual(13);
      for (const t of p.tasks) {
        expect(p.sections, `${p.name}: ${t.title}`).toContain(t.section);
        expect(t.title, p.name).not.toMatch(/^\s|\s$/);
        // a countdown task needs its project's anchor day; every task has a day
        if (typeof t.fromAnchor === "number") expect(p.anchor, `${p.name}: ${t.title}`).toBeTruthy();
        else if (typeof t.dayOfMonth === "number") expect(t.dayOfMonth, `${p.name}: ${t.title}`).toBeLessThanOrEqual(28);
        else expect(typeof t.dueInDays, `${p.name}: ${t.title}`).toBe("number");
        // a title that names its day of the month is due on it
        const named = /by the (\d+)(st|nd|rd|th)\b/.exec(t.title)?.[1];
        if (named) expect(t.dayOfMonth, `${p.name}: ${t.title}`).toBe(Number(named));
        if (!t.milestone) expect(t.effortHours, t.title).toBeGreaterThan(0);
      }
      for (const a of p.rule?.actions ?? []) if (a.type === "set_section") expect(p.sections).toContain(a.value);
      for (const f of p.form?.fields ?? []) expect(FIELD_KEYS.has(f), `${p.name}: ${f}`).toBe(true);
      for (const d of p.docs ?? []) expect(d.markdown || d.from, d.title).toBeTruthy();
    }
    expect(pack.goals?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(pack.goals?.length ?? 0).toBeLessThanOrEqual(3);
    for (const g of pack.goals ?? []) {
      if (g.project) expect(keys.has(g.project), `${g.name} → ${g.project}`).toBe(true);
      for (const k of g.links ?? []) expect(keys.has(k), `${g.name} → ${k}`).toBe(true);
      expect(g.keyResults?.length ?? 0, g.name).toBeGreaterThanOrEqual(1);
      expect(g.keyResults?.length ?? 0, g.name).toBeLessThanOrEqual(3);
      for (const k of [g, ...(g.keyResults ?? [])]) {
        expect(k.icon, k.name).toBeTruthy();
        // a % target is a share, never more than all of it
        if (k.unit === "%" && typeof k.target === "number") expect(k.target).toBeLessThanOrEqual(100);
      }
    }
    for (const pf of pack.portfolios ?? []) for (const k of pf.projects) expect(keys.has(k), `${pf.name} → ${k}`).toBe(true);
    const s = packStats(pack);
    expect(s.docs).toBeGreaterThanOrEqual(2);
    expect(s.forms).toBeGreaterThanOrEqual(pack.id === "pack-holding" ? 0 : 1);
  });

  it("the fitness and venue packs come with a QR poster form; the fitness pack's opening counts back 90 days", () => {
    expect(packStats(fitness).posters).toBe(1);
    expect(packStats(findPack("pack-venue")!).posters).toBe(1);
    const opening = fitness.projects.find((p) => p.key === "opening")!;
    expect(opening.anchor).toEqual({ label: "Opening day", defaultInDays: 90 });
    expect(Math.min(...opening.tasks.map((t) => t.fromAnchor ?? 0))).toBe(-90);
    expect(opening.tasks.filter((t) => t.milestone).map((t) => t.title)).toEqual(["Opening day"]);
  });

  it("every doc reads as a doc: a title, an icon and some blocks", () => {
    for (const pack of BUSINESS_PACKS) {
      const plan = buildPackPlan(pack, pick(pack, { businesses: ["North Gym"] }), ctx());
      for (const d of plan.docs) {
        expect(d.title, pack.name).toBeTruthy();
        expect(d.icon, d.title).toBeTruthy();
        expect(d.body.length, d.title).toBeGreaterThan(3);
        expect(new Set(d.body.map((b) => b.id)).size).toBe(d.body.length);
      }
    }
  });
});

describe("counting back from an anchor day", () => {
  it("a countdown task is due that many days before; a weekend before the anchor moves to the Friday before", () => {
    const anchor = new Date(2027, 1, 8); // Mon 8 Feb 2027
    expect(anchoredDay(anchor, -3, TODAY)).toBe("2027-02-05");     // Fri
    expect(anchoredDay(anchor, -1, TODAY)).toBe("2027-02-05");     // Sun 7 → the Friday before (Monday is the day itself)
    expect(anchoredDay(anchor, -9, TODAY)).toBe("2027-02-01");     // Sat 30 Jan → Mon 1 Feb, still before the day
    expect(anchoredDay(anchor, 14, TODAY)).toBe("2027-02-22");
    expect(anchoredDay(anchor, 5, TODAY)).toBe("2027-02-15");      // Sat 13 → the Monday after
  });

  it("the day itself keeps its own date, a Saturday included; nothing is ever before today", () => {
    const saturday = new Date(2027, 1, 6);
    expect(anchoredDay(saturday, 0, TODAY, true)).toBe("2027-02-06");
    expect(anchoredDay(new Date(2026, 10, 20), -30, TODAY)).toBe("2026-11-10");
    expect(anchoredDay(new Date(2026, 9, 1), 0, TODAY, true)).toBe("2026-11-10");
  });

  it("work isn't due over the Christmas break (24 Dec to 1 Jan): after it, or before the day when the day's just after it", () => {
    expect(anchoredDay(new Date(2026, 11, 20), 5, TODAY)).toBe("2027-01-04");     // Fri 25 Dec → Mon 4 Jan
    expect(anchoredDay(new Date(2027, 0, 12), -14, TODAY)).toBe("2027-01-04");    // Tue 29 Dec → Mon 4 Jan, still before the day
    expect(anchoredDay(new Date(2027, 0, 4), -3, TODAY)).toBe("2026-12-23");      // Fri 1 Jan, and the day's Mon 4 Jan: Wed 23 Dec
    expect(anchoredDay(new Date(2026, 11, 25), 0, TODAY, true)).toBe("2026-12-25"); // a key date keeps its own day
  });

  it("\"by the 10th\": the next 10th of a month, a day off moving to the working day before", () => {
    expect(monthDay(TODAY, 10)).toBe("2026-11-10");                  // today is the 10th
    expect(monthDay(new Date(2026, 10, 11), 10)).toBe("2026-12-10");  // past it: next month's
    expect(monthDay(TODAY, 14)).toBe("2026-11-13");                  // Sat 14 → Fri 13
    expect(monthDay(new Date(2027, 0, 9), 10)).toBe("2027-01-11");   // Sun 10, and Sat 9 is today: Mon 11
    expect(monthDay(new Date(2026, 11, 2), 31)).toBe("2026-12-23");   // (at most the 28th) Mon 28 Dec is in the break: the working day before it
  });

  it("a countdown's day starts out of the Christmas break", () => {
    expect(defaultAnchorDay(TODAY, 42)).toBe("2027-01-04");          // Tue 22 Dec → Mon 4 Jan
    expect(defaultAnchorDay(new Date(2026, 11, 1), 31)).toBe("2027-01-04");   // Sat 1 Jan
    expect(defaultAnchorDay(TODAY, 90)).toBe("2027-02-08");
    const startup = findPack("pack-startup")!;
    expect(defaultPick(startup, { today: TODAY }).anchors.launch).toBe("2027-01-04");
  });

  it("the plan dates the opening from the day picked, and says how many tasks start out behind", () => {
    const plan = buildPackPlan(fitness, pick(fitness, { anchors: { opening: "2027-02-08", timetable: "2027-01-05" } }), ctx());
    const opening = plan.projects.find((p) => p.key === "opening")!;
    const due = (title: string) => opening.tasks.find((t) => t.title.startsWith(title))!.dueDate;
    expect(due("Agree the fit-out plan")).toBe("2026-11-10");   // 90 days before: today
    expect(due("Opening day")).toBe("2027-02-08");
    expect(opening.tasks.find((t) => t.title === "Opening day")!.milestone).toBe(true);
    expect(due("Opening review")).toBe("2027-02-22");
    expect(tasksBehind(fitness.projects[0], "2027-02-08", TODAY)).toBe(0);
    // opening in six weeks: the 90-, 84-, 80-, 60-, 56- and 50-day jobs are already behind
    expect(tasksBehind(fitness.projects[0], "2026-12-22", TODAY)).toBe(6);
    const soon = buildPackPlan(fitness, pick(fitness, { anchors: { opening: "2026-12-22" } }), ctx()).projects[0];
    expect(soon.tasks.filter((t) => t.dueDate === "2026-11-10").length).toBe(6);
  });

  it("a day that can't be read falls back to the anchor's default", () => {
    const plan = buildPackPlan(fitness, pick(fitness, { anchors: { opening: "" } }), ctx());
    expect(plan.projects[0].tasks.find((t) => t.title === "Opening day")!.dueDate).toBe("2027-02-08");
  });
});

describe("what's ticked", () => {
  it("starts with everything, every countdown on its default day and the goals for next quarter (this one's nearly over)", () => {
    const p = defaultPick(fitness, { today: TODAY });
    expect(p.off).toEqual([]);
    expect(p.anchors).toEqual({ opening: "2027-02-08", timetable: "2027-01-05" });
    expect(p.quarter).toBe("2027-Q1");
    // adding it to a workspace that has an update day already: that's left as it is unless ticked
    expect(defaultPick(fitness, { today: TODAY, mode: "project" }).off).toEqual([packPart.updates]);
  });

  it("goals are for this quarter until less than two months of it are left", () => {
    expect(packQuarter(new Date(2026, 6, 15))).toBe("2026-Q3");
    expect(packQuarter(new Date(2026, 7, 5))).toBe("2026-Q4");
    expect(packQuarter(new Date(2026, 9, 1))).toBe("2026-Q4");
    expect(packQuarterChoices(TODAY).map((q) => q.value)).toEqual(["2026-Q4", "2027-Q1"]);
  });

  it("unticking a project takes its docs, form, poster and portfolio place with it", () => {
    const all = buildPackPlan(fitness, pick(fitness), ctx());
    expect(packCounts(all)).toEqual({ projects: 5, tasks: 34, goals: 3, keyResults: 6, portfolios: 1, docs: 4, forms: 1, posters: 1, updateDay: true });
    const off = buildPackPlan(fitness, pick(fitness, { off: [packPart.project("maintenance"), packPart.project("instructors")] }), ctx());
    expect(off.projects.map((p) => p.key)).toEqual(["opening", "timetable", "routines"]);
    expect(off.docs.map((d) => d.title)).toEqual(["Studio opening checklist", "Opening and closing checklist", "Weekly studio meeting"]);
    expect(off.posters).toEqual([]);
    expect(off.portfolios[0].projectKeys).toEqual(["opening", "timetable"]);
    // goals don't link to work that isn't there
    expect(off.goals.find((g) => g.key === "retention")!.linkKeys).toEqual(["routines"]);
  });

  it("a doc, a form or a portfolio can be unticked on its own; a portfolio with none of its projects goes", () => {
    const plan = buildPackPlan(fitness, pick(fitness, { off: [packPart.doc("routines", 1), packPart.form("maintenance"), packPart.portfolio("growth")] }), ctx());
    expect(plan.docs.map((d) => d.title)).not.toContain("Weekly studio meeting");
    expect(plan.projects.find((p) => p.key === "maintenance")!.form).toBeUndefined();
    expect(plan.projects.find((p) => p.key === "maintenance")!.rule).toBeTruthy();   // the rule stays with its project
    expect(plan.posters).toEqual([]);
    expect(plan.portfolios).toEqual([]);
    const none = buildPackPlan(fitness, pick(fitness, { off: ["opening", "timetable", "instructors"].map(packPart.project) }), ctx());
    expect(none.portfolios).toEqual([]);
  });

  it("nothing ticked is nothing to set up", () => {
    const off = [...fitness.projects.map((p) => packPart.project(p.key)), ...fitness.goals!.map((g) => packPart.goal(g.key)), packPart.updates];
    const c = packCounts(buildPackPlan(fitness, pick(fitness, { off }), ctx()));
    expect(packHasParts(c)).toBe(false);
    expect(isPartOn({ off }, packPart.updates)).toBe(false);
  });

  it("counts read as a line, leaving out what's not there", () => {
    expect(packCountsLine({ projects: 5, tasks: 34, goals: 3, keyResults: 6, portfolios: 1, docs: 4, forms: 1, posters: 1, updateDay: true }))
      .toBe("5 projects · 34 tasks · 3 goals · 1 portfolio · 4 docs · 1 form");
    expect(packCountsLine({ projects: 1, tasks: 1, goals: 0, keyResults: 0, portfolios: 0, docs: 0, forms: 0, posters: 0, updateDay: false })).toBe("1 project · 1 task");
  });
});

describe("goals", () => {
  it("Goals 2.0: an owner-less plan with the quarter, its icon, links to the work behind it, and key results that follow it", () => {
    const plan = buildPackPlan(fitness, pick(fitness), ctx());
    expect(plan.goalPeriod).toBe("Q1 2027");
    const fill = plan.goals.find((g) => g.key === "fill")!;
    expect(fill).toMatchObject({ name: "Full classes, every week", icon: "🔥", period: "2027-Q1", periodStart: "2027-01-01", periodEnd: "2027-03-31", due: "2027-03-31", linkKeys: ["timetable", "routines"] });
    expect(fill.keyResults.map((k) => [k.name, k.target, k.unit])).toEqual([
      ["Average class fill", 75, "%"], ["Peak-time classes with a waitlist", 50, "%"], ["Off-peak class fill", 55, "%"],
    ]);
    expect(fill.keyResults[0].linkKeys).toEqual(["timetable", "routines"]);
    // the opening goal reads its % from the opening project; its key result is served by it too
    const open = plan.goals.find((g) => g.key === "opening")!;
    expect(open.projectKey).toBe("opening");
    expect(open.linkKeys).toEqual([]);
    expect(open.keyResults[0].linkKeys).toEqual(["opening"]);
  });

  it("a year goal is for the whole year the quarter's in; a number nobody can know starts empty", () => {
    const holding = findPack("pack-holding")!;
    const plan = buildPackPlan(holding, pick(holding), ctx());
    const grow = plan.goals.find((g) => g.key === "growth")!;
    expect(grow).toMatchObject({ period: "2027-FY", periodStart: "2027-01-01", periodEnd: "2027-12-31" });
    expect(grow.keyResults[0]).toMatchObject({ name: "Group revenue", unit: "£" });
    expect(grow.keyResults[0].target).toBeUndefined();
  });

  it("before Goals 2.0: a due date at the end of the quarter, no owner, quarter, icon or links", () => {
    const plan = buildPackPlan(fitness, pick(fitness, { quarter: "2026-Q4" }), ctx({ goalsV2: false }));
    const fill = plan.goals[0];
    expect(fill.due).toBe(periodRange("2026-Q4")!.end);
    expect(fill.period).toBeUndefined();
    expect(fill.icon).toBeUndefined();
    expect(fill.linkKeys).toEqual([]);
    expect(fill.keyResults.every((k) => k.linkKeys.length === 0)).toBe(true);
  });

  it("before Goals 2.0, a lower-is-better goal is left out (it would read the wrong way round)", () => {
    const pack: WorkspaceTemplate = { ...fitness, goals: [{ key: "churn", name: "Fewer cancellations", direction: "lower", target: 4, keyResults: [{ name: "Cancellations", direction: "lower", target: 4 }] }, { key: "x", name: "More", keyResults: [{ name: "Up", target: 5 }, { name: "Down", direction: "lower", target: 1 }] }] };
    expect(buildPackPlan(pack, pick(pack), ctx({ goalsV2: false })).goals.map((g) => [g.name, g.keyResults.map((k) => k.name)])).toEqual([["More", ["Up"]]]);
    expect(buildPackPlan(pack, pick(pack), ctx()).goals.find((g) => g.key === "churn")).toMatchObject({ direction: "lower", target: 4 });
  });

  it("no goals for someone who can't set the business's goals", () => {
    const plan = buildPackPlan(fitness, pick(fitness), ctx({ canSetGoals: false }));
    expect(plan.goals).toEqual([]);
    expect(plan.goalPeriod).toBe("");
  });
});

describe("the update day", () => {
  it("is the pack's when you may set it and it's ticked", () => {
    expect(buildPackPlan(fitness, pick(fitness), ctx()).updateRhythm).toEqual({ cadence: "weekly", weekday: 1 });
    expect(buildPackPlan(fitness, pick(fitness, { off: [packPart.updates] }), ctx()).updateRhythm).toBeNull();
    expect(buildPackPlan(fitness, pick(fitness), ctx({ canSetUpdateDay: false })).updateRhythm).toBeNull();
    const holding = findPack("pack-holding")!;
    expect(buildPackPlan(holding, pick(holding), ctx()).updateRhythm).toEqual({ cadence: "monthly", weekday: 5 });
  });
});

describe("a holding company's businesses", () => {
  const holding = findPack("pack-holding")!;

  it("cleans the names: trimmed, no blanks or repeats, at most eight", () => {
    expect(cleanBusinesses(["  North  Gym ", "", "north gym", "Harbour Cafe"])).toEqual(["North Gym", "Harbour Cafe"]);
    expect(cleanBusinesses(Array.from({ length: 12 }, (_, i) => `B${i}`))).toHaveLength(8);
  });

  it("starts with the other businesses you run", () => {
    expect(defaultPick(holding, { today: TODAY, businesses: ["Courtside Padel", "Reco HQ"] }).businesses).toEqual(["Courtside Padel", "Reco HQ"]);
    expect(defaultPick(fitness, { today: TODAY, businesses: ["Courtside Padel"] }).businesses).toEqual([]);
  });

  it("each business gets its own project and portfolio, in its name, in a hue of its own", () => {
    const full = expandPack(holding, ["North Gym", "Harbour Cafe"]);
    expect(full.projects.map((p) => p.name)).toEqual(["Group board", "Group finance", "Deals and new ventures", "North Gym", "Harbour Cafe"]);
    const gym = full.projects[3];
    expect(gym.key).toBe("business-1");
    expect(gym.tasks.map((t) => t.title)).toContain("North Gym: monthly numbers in by the 10th");
    expect(gym.description).toBe("North Gym as the group sees it: its numbers, its plan and its reviews.");
    expect(full.projects[3].hue).not.toBe(full.projects[4].hue);
    expect(full.portfolios!.map((pf) => [pf.name, pf.projects])).toEqual([["North Gym", ["business-1"]], ["Harbour Cafe", ["business-2"]]]);
    const plan = buildPackPlan(holding, pick(holding, { businesses: ["North Gym", " ", "Harbour Cafe"] }), ctx());
    expect(plan.portfolios.map((pf) => pf.projectKeys)).toEqual([["business-1"], ["business-2"]]);
    expect(packCounts(plan).projects).toBe(5);
    // the template itself is untouched
    expect(holding.projects).toHaveLength(3);
    expect(expandPack(fitness, ["X"])).toBe(fitness);
  });

  it("a business already in Kanbo gets its portfolio in Personal, with its own projects beside the group's one for it", () => {
    const projectsOf = (b: string) => (b.toLowerCase() === "reco hq" ? ["p-reco-1", "p-reco-2"] : null);
    const plan = buildPackPlan(holding, pick(holding, { businesses: ["Reco HQ", "North Gym"] }), ctx({ projectsOf }));
    expect(plan.portfolios.map((pf) => [pf.name, pf.personal ?? false, pf.projectKeys, pf.projectIds ?? []])).toEqual([
      ["Reco HQ", true, ["business-1"], ["p-reco-1", "p-reco-2"]],
      ["North Gym", false, ["business-2"], []],
    ]);
  });

  it("the board's month: numbers by the 10th, the pack by the 14th, the meeting on the 21st (working days), each monthly", () => {
    const plan = buildPackPlan(holding, pick(holding, { businesses: ["North Gym"] }), ctx());
    const due = (title: string) => plan.projects.flatMap((p) => p.tasks).find((t) => t.title === title)!;
    expect(due("Collect each business's monthly numbers by the 10th")).toMatchObject({ dueDate: "2026-11-10", recurrence: "monthly" });
    expect(due("North Gym: monthly numbers in by the 10th")).toMatchObject({ dueDate: "2026-11-10", recurrence: "monthly" });
    expect(due("Put the board pack together and send it out").dueDate).toBe("2026-11-13");   // Sat 14 → Fri 13
    expect(due("Board meeting").dueDate).toBe("2026-11-20");                                 // Sat 21 → Fri 20
    // and nothing lands on Christmas Day
    expect(due("Plan the year end and the audit").dueDate).toBe("2027-01-04");
    expect(plan.projects.flatMap((p) => p.tasks).some((t) => t.dueDate && t.dueDate >= "2026-12-24" && t.dueDate <= "2027-01-01")).toBe(false);
  });
});

describe("routines for the team", () => {
  it("daily opening and closing checks are the team's: marked in the plan, and only those", () => {
    for (const id of ["pack-fitness", "pack-venue"]) {
      const pack = findPack(id)!;
      const tasks = buildPackPlan(pack, pick(pack), ctx()).projects.flatMap((p) => p.tasks);
      expect(tasks.filter((t) => t.forTeam).every((t) => t.recurrence === "daily")).toBe(true);
      expect(tasks.filter((t) => t.forTeam).map((t) => t.title).sort()).toEqual(id === "pack-fitness" ? ["Closing checklist", "Opening checklist"] : ["Closing checks", "Opening checks"]);
    }
  });
  it("the venue's league runs after the draw, and the court's daily check is the opening checks' (once)", () => {
    const venue = findPack("pack-venue")!;
    const plan = buildPackPlan(venue, pick(venue), ctx());
    const league = plan.projects.find((p) => p.key === "tournament")!;
    const due = (t: string) => league.tasks.find((x) => x.title.startsWith(t))!.dueDate!;
    expect(due("Update the league table") > due("Close entries and make the draw")).toBe(true);
    expect(due("Publish the league fixtures") > due("Close entries and make the draw")).toBe(true);
    expect(due("Finals day") > due("Update the league table")).toBe(true);
    expect(plan.projects.flatMap((p) => p.tasks).filter((t) => /brush the courts|check the nets/i.test(t.title))).toEqual([]);
  });
  it("the advisory firm checks for conflicts before it writes the proposal", () => {
    const advisory = findPack("pack-advisory")!;
    const tasks = advisory.projects.find((p) => p.key === "engagement")!.tasks;
    const at = (t: string) => tasks.findIndex((x) => x.title.startsWith(t));
    expect(at("Check for conflicts")).toBeGreaterThan(-1);
    expect(at("Check for conflicts")).toBeLessThan(at("Write the proposal"));
    expect(tasks[at("Check for conflicts")].section).toBe("Proposal");
  });
});

describe("a pack from New project in a workspace that's only just been made", () => {
  it("ticks the update day, as New workspace would", () => {
    expect(defaultPick(fitness, { today: TODAY, mode: "project" }).off).toEqual([packPart.updates]);
    expect(defaultPick(fitness, { today: TODAY, mode: "project", newWorkspace: true }).off).toEqual([]);
    expect(defaultPick(fitness, { today: TODAY, mode: "workspace" }).off).toEqual([]);
  });
});

describe("docs", () => {
  it("a meeting doc is the meeting notes template with the pack's agenda", () => {
    const plan = buildPackPlan(fitness, pick(fitness), ctx());
    const meeting = plan.docs.find((d) => d.title === "Weekly studio meeting")!;
    expect(meeting.icon).toBe("🗒️");
    const agenda = meeting.body.filter((b) => b.type === "numbered").map(blockText);
    expect(agenda).toEqual(["Last week's class fill and waitlists", "Members: new, at risk and cancelled", "Anything broken or unsafe", "This week's priorities"]);
    expect(meeting.body.some((b) => b.type === "h2" && blockText(b) === "Decisions")).toBe(true);
  });

  it("a written doc becomes blocks: a callout, headings and a checklist", () => {
    const plan = buildPackPlan(fitness, pick(fitness), ctx());
    const sop = plan.docs.find((d) => d.title === "Opening and closing checklist")!;
    expect(sop.body[0]).toMatchObject({ type: "callout", icon: "🔑" });
    expect(sop.body.filter((b) => b.type === "h2").map(blockText)).toEqual(["Opening (30 minutes before the first class)", "Closing"]);
    expect(sop.body.filter((b) => b.type === "todo").length).toBeGreaterThanOrEqual(8);
  });
});

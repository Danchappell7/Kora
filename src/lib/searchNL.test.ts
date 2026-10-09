import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseSearchNL, chipsToFilters, removeSearchChip, removeChipFromInput, protectLiteral, effectiveKinds, hasTaskOnlyFilters,
  todayIn, dayLabel, type SearchNLContext,
} from "./searchNL";

// Friday 9 October 2026: the week runs Mon 5 – Sun 11 Oct; next week Mon 12 – Sun 18 Oct
const CTX: SearchNLContext = {
  members: [
    { id: "m-self", name: "Daniel Okai" }, { id: "m-1", name: "Maya Lin" }, { id: "m-2", name: "Theo Vance" },
    { id: "m-3", name: "Sana Rao" }, { id: "m-4", name: "Idris Bell" }, { id: "m-5", name: "Zoë Brontë" },
  ],
  projects: [
    { id: "p-personal", name: "Personal" }, { id: "p-launch", name: "Q3 Product Launch" }, { id: "p-brand", name: "Brand Refresh" },
    { id: "p-infra", name: "Platform Infra" }, { id: "p-growth", name: "Growth Experiments" },
  ],
  currentUserId: "m-self",
  today: "2026-10-09",
};
const p = (input: string, ctx: Partial<SearchNLContext> = {}) => parseSearchNL(input, { ...CTX, ...ctx });
const labels = (input: string) => p(input).chips.map((c) => c.label);
const due = (input: string) => { const f = p(input).filters; return [f.dueFrom, f.dueTo]; };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00")); });
afterEach(() => { vi.useRealTimers(); });

describe("parseSearchNL — the examples", () => {
  it("Maya's overdue tasks in Launch", () => {
    const r = p("Maya's overdue tasks in Launch");
    expect(r.filters).toEqual({ assigneeId: "m-1", dueTo: "2026-10-08", excludeDone: true, projectId: "p-launch" });
    expect(r.chips.map((c) => [c.kind, c.label])).toEqual([["assignee", "Maya Lin"], ["due", "Overdue"], ["project", "In Q3 Product Launch"]]);
    expect(r.text).toBe("");
  });
  it("Maya’s (curly apostrophe) reads the same", () => {
    expect(p("Maya’s overdue tasks in Launch").filters).toEqual(p("Maya's overdue tasks in Launch").filters);
  });
  it("docs mentioning pricing", () => {
    const r = p("docs mentioning pricing");
    expect(r.filters).toEqual({ kinds: ["doc"] });
    expect(r.text).toBe("pricing");
    expect(r.chips[0]).toMatchObject({ kind: "kind", label: "Docs", source: "docs mentioning" });
  });
  it("blocked this week", () => {
    const r = p("blocked this week");
    expect(r.filters).toEqual({ statuses: ["blocked"], dueFrom: "2026-10-05", dueTo: "2026-10-11" });
    expect(labels("blocked this week")).toEqual(["Blocked", "Due this week"]);
    expect(r.text).toBe("");
  });
  it("assigned to me due friday (today is Friday: the next one, inclusive)", () => {
    const r = p("assigned to me due friday");
    expect(r.filters).toEqual({ assigneeId: "m-self", dueFrom: "2026-10-09", dueTo: "2026-10-09" });
    expect(labels("assigned to me due friday")).toEqual(["Assigned to me", "Due Fri 9 Oct"]);
  });
  it("comments by Theo about the deck", () => {
    const r = p("comments by Theo about the deck");
    expect(r.filters).toEqual({ kinds: ["comment"], authorId: "m-2" });
    expect(r.text).toBe("deck");
    expect(labels("comments by Theo about the deck")).toEqual(["Comments", "By Theo Vance"]);
  });
});

describe("parseSearchNL — people", () => {
  it("full names, first names, accents and case", () => {
    expect(p("tasks assigned to maya lin").filters).toEqual({ assigneeId: "m-1" });
    expect(p("assigned to SANA").filters).toEqual({ assigneeId: "m-3" });
    expect(p("zoe's tasks").filters).toEqual({ assigneeId: "m-5" });
    expect(p("Zoë Brontë's tasks").filters).toEqual({ assigneeId: "m-5" });
  });
  it("by / for / with / from someone are the assignee (tasks)", () => {
    expect(p("launch deck by Theo").filters).toEqual({ assigneeId: "m-2" });
    expect(p("launch deck by Theo").text).toBe("launch deck");
    expect(p("for Idris").filters).toEqual({ assigneeId: "m-4" });
    expect(p("with sana").filters).toEqual({ assigneeId: "m-3" });
  });
  it("my / mine / for me are you", () => {
    expect(p("my overdue tasks").filters).toEqual({ assigneeId: "m-self", dueTo: "2026-10-08", excludeDone: true });
    expect(p("mine").filters).toEqual({ assigneeId: "m-self" });
    expect(p("pricing for me").filters).toEqual({ assigneeId: "m-self" });
    expect(p("my comments about pricing").filters).toEqual({ authorId: "m-self", kinds: ["comment"] });
  });
  it("Theo's comments: the author, not the assignee", () => {
    const r = p("Theo's comments about the launch");
    expect(r.filters).toEqual({ authorId: "m-2", kinds: ["comment"] });
    expect(r.text).toBe("launch");
  });
  it("a 4-letter start is enough when it's unique; short or common words never name anyone", () => {
    expect(p("assigned to Idri").filters).toEqual({ assigneeId: "m-4" });
    expect(p("by the weekend").filters.assigneeId).toBeUndefined();     // "the" ≠ Theo
    expect(p("notes by the team").filters).toEqual({});
  });
  it("unknown names stay as text", () => {
    const r = p("Bob's launch notes");
    expect(r.filters).toEqual({});
    expect(r.text).toBe("Bob's launch notes");
  });
});

describe("parseSearchNL — statuses", () => {
  it("blocked, in review, in progress, to do, done", () => {
    expect(p("in review").filters).toEqual({ statuses: ["review"] });
    expect(p("tasks in progress").filters).toEqual({ statuses: ["progress"] });
    expect(p("to do in Brand Refresh").filters).toEqual({ statuses: ["todo"], projectId: "p-brand" });
    expect(p("done last week").filters).toEqual({ statuses: ["done"], dueFrom: "2026-09-28", dueTo: "2026-10-04" });
    expect(p("stuck").filters).toEqual({ statuses: ["blocked"] });
  });
  it("several statuses make one chip", () => {
    const r = p("blocked or in review");
    expect(r.filters).toEqual({ statuses: ["blocked", "review"] });
    expect(r.chips).toHaveLength(1);
    expect(r.chips[0].label).toBe("Blocked or in review");
    expect(r.text).toBe("");
  });
  it("open / not done / outstanding — but 'open' at the start of a title is text", () => {
    expect(p("open tasks in Launch").filters).toEqual({ excludeDone: true, projectId: "p-launch" });
    expect(p("not done").filters).toEqual({ excludeDone: true });
    expect(p("outstanding tasks").filters).toEqual({ excludeDone: true });
    expect(p("Maya's outstanding work").filters).toEqual({ assigneeId: "m-1", excludeDone: true });
    // next to a plain word it's that word: "outstanding invoices" is a title
    expect(p("outstanding invoices").filters).toEqual({});
    expect(p("outstanding invoices").text).toBe("outstanding invoices");
    expect(p("open bank account").filters).toEqual({});
    expect(p("open bank account").text).toBe("open bank account");
  });
  it("'review' on its own is a word in titles, not a status", () => {
    expect(p("pricing review").filters).toEqual({});
    expect(p("pricing review").text).toBe("pricing review");
  });
});

describe("parseSearchNL — dates (Friday 9 Oct 2026, Europe/London)", () => {
  it("today, tomorrow, yesterday, overdue", () => {
    expect(due("due today")).toEqual(["2026-10-09", "2026-10-09"]);
    expect(due("today's tasks")).toEqual(["2026-10-09", "2026-10-09"]);
    expect(due("tomorrow")).toEqual(["2026-10-10", "2026-10-10"]);
    expect(due("due yesterday")).toEqual(["2026-10-08", "2026-10-08"]);
    expect(p("overdue").filters).toEqual({ dueTo: "2026-10-08", excludeDone: true });
    expect(p("past due").filters).toEqual({ dueTo: "2026-10-08", excludeDone: true });
  });
  it("weeks, months and weekends", () => {
    expect(due("this week")).toEqual(["2026-10-05", "2026-10-11"]);
    expect(due("next week")).toEqual(["2026-10-12", "2026-10-18"]);
    expect(due("due this month")).toEqual(["2026-10-01", "2026-10-31"]);
    expect(due("next month")).toEqual(["2026-11-01", "2026-11-30"]);
    expect(due("this weekend")).toEqual(["2026-10-10", "2026-10-11"]);
    expect(due("due soon")).toEqual(["2026-10-09", "2026-10-16"]);
    expect(due("in the next 3 days")).toEqual(["2026-10-09", "2026-10-12"]);
  });
  it("weekday names: the next one (today included); next tue = next week's; last fri", () => {
    expect(due("friday")).toEqual(["2026-10-09", "2026-10-09"]);
    expect(due("due fri")).toEqual(["2026-10-09", "2026-10-09"]);
    expect(due("monday")).toEqual(["2026-10-12", "2026-10-12"]);
    expect(due("thursday")).toEqual(["2026-10-15", "2026-10-15"]);
    expect(due("next tuesday")).toEqual(["2026-10-13", "2026-10-13"]);
    expect(due("next friday")).toEqual(["2026-10-16", "2026-10-16"]);
    expect(due("last friday")).toEqual(["2026-10-02", "2026-10-02"]);
    expect(labels("due wednesday")).toEqual(["Due Wed 14 Oct"]);
  });
  it("calendar dates, UK order", () => {
    expect(due("due 16 oct")).toEqual(["2026-10-16", "2026-10-16"]);
    expect(due("on 3rd of November")).toEqual(["2026-11-03", "2026-11-03"]);
    expect(due("oct 20")).toEqual(["2026-10-20", "2026-10-20"]);
    expect(due("12/10")).toEqual(["2026-10-12", "2026-10-12"]);
    expect(due("2027-01-04")).toEqual(["2027-01-04", "2027-01-04"]);
    expect(labels("2027-01-04")).toEqual(["Due Mon 4 Jan 2027"]);
  });
  it("by / before / after", () => {
    expect(due("by friday")).toEqual([undefined, "2026-10-09"]);
    expect(due("before next monday")).toEqual([undefined, "2026-10-11"]);
    expect(due("due after 16 oct")).toEqual(["2026-10-17", undefined]);
    expect(labels("by friday")).toEqual(["Due by Fri 9 Oct"]);
  });
  it("two date phrases side by side narrow each other", () => {
    expect(p("overdue this week").filters).toEqual({ dueFrom: "2026-10-05", dueTo: "2026-10-08", excludeDone: true });
    expect(labels("overdue this week")).toEqual(["Overdue, due this week"]);
    expect(p("next week by wednesday").filters).toEqual({ dueFrom: "2026-10-12", dueTo: "2026-10-14" });
  });
  it("joined by 'or', 'and' or a comma they're either-or: the span covering both", () => {
    expect(p("due today or tomorrow").filters).toEqual({ dueFrom: "2026-10-09", dueTo: "2026-10-10" });
    expect(labels("due today or tomorrow")).toEqual(["Due today or tomorrow"]);
    expect(p("monday or tuesday").filters).toEqual({ dueFrom: "2026-10-12", dueTo: "2026-10-13" });
    expect(labels("monday or tuesday")).toEqual(["Due Mon 12 Oct or Tue 13 Oct"]);
    expect(p("this week or next week").filters).toEqual({ dueFrom: "2026-10-05", dueTo: "2026-10-18" });
    expect(p("due today and tomorrow").filters).toEqual({ dueFrom: "2026-10-09", dueTo: "2026-10-10" });
    expect(p("today, tomorrow").filters).toEqual({ dueFrom: "2026-10-09", dueTo: "2026-10-10" });
    // overdue keeps it to open work (or every finished task in history would join in)
    expect(p("overdue or due today").filters).toEqual({ dueTo: "2026-10-09", excludeDone: true });
    expect(labels("overdue or due today")).toEqual(["Overdue or due today"]);
    // the "or" goes with the chip, and the rest is still searched for
    const r = p("pricing due today or tomorrow");
    expect(r.text).toBe("pricing");
    expect(removeChipFromInput(r, "due")).toBe("pricing");
  });
  it("side by side but with nothing in common, they're either-or too", () => {
    expect(p("today tomorrow").filters).toEqual({ dueFrom: "2026-10-09", dueTo: "2026-10-10" });
  });
  it("explicit bounds always narrow ('after … and before …' is between)", () => {
    expect(p("after 12 oct and before 20 oct").filters).toEqual({ dueFrom: "2026-10-13", dueTo: "2026-10-19" });
  });
  it("a weekday with its week: 'friday next week', 'next week fri'", () => {
    expect(due("friday next week")).toEqual(["2026-10-16", "2026-10-16"]);
    expect(due("next week fri")).toEqual(["2026-10-16", "2026-10-16"]);
    expect(due("wednesday this week")).toEqual(["2026-10-07", "2026-10-07"]);
  });
  it("dates are worked out in the person's timezone", () => {
    // 23:30 UTC on Fri 9 Oct is already Sat 10 Oct in London (BST), still Friday in New York
    vi.setSystemTime(new Date("2026-10-09T23:30:00Z"));
    expect(p("due today", { today: new Date() }).filters.dueFrom).toBe("2026-10-10");
    expect(p("due today", { today: new Date(), timezone: "America/New_York" }).filters.dueFrom).toBe("2026-10-09");
    // GMT again after the clocks go back (Sun 25 Oct): 00:30 UTC on the 26th is the 26th in London
    vi.setSystemTime(new Date("2026-10-26T00:30:00Z"));
    expect(p("today", { today: new Date() }).filters.dueFrom).toBe("2026-10-26");
    expect(todayIn("2026-10-09T08:00:00")).toBe("2026-10-09");
  });
  it("labels name the day, and the year when it isn't this one", () => {
    expect(dayLabel("2026-10-16", "2026-10-09")).toBe("Fri 16 Oct");
    expect(dayLabel("2027-10-16", "2026-10-09")).toBe("Sat 16 Oct 2027");
  });
});

describe("parseSearchNL — projects", () => {
  it("in / for / #: whole names, a word of the name, the start of it", () => {
    expect(p("pricing in launch").filters).toEqual({ projectId: "p-launch" });
    expect(p("pricing in launch").text).toBe("pricing");
    expect(p("for Brand Refresh").filters).toEqual({ projectId: "p-brand" });
    expect(p("#growth ideas").filters).toEqual({ projectId: "p-growth" });
    expect(p("#growth ideas").text).toBe("ideas");
    expect(p("in the infra project").filters).toEqual({ projectId: "p-infra" });
    expect(p("tasks in Q3 Product Launch").filters).toEqual({ projectId: "p-launch" });
    expect(p("in product launch").filters).toEqual({ projectId: "p-launch" });
  });
  it("a word that isn't a project stays text", () => {
    const r = p("pricing in slides");
    expect(r.filters).toEqual({});
    expect(r.text).toBe("pricing slides");
  });
  it("bare project words don't become filters", () => {
    expect(p("launch plan").filters).toEqual({});
  });
});

describe("parseSearchNL — kinds", () => {
  it("docs, comments, projects and people", () => {
    expect(p("comments mentioning the deck").filters).toEqual({ kinds: ["comment"] });
    expect(p("projects about growth").filters).toEqual({ kinds: ["project"] });
    expect(p("people named sana").filters).toEqual({ kinds: ["person"] });
    expect(p("people named sana").text).toBe("sana");
    expect(p("pricing in docs").filters).toEqual({ kinds: ["doc"] });
    expect(p("pricing in docs").text).toBe("pricing");
    expect(p("docs").filters).toEqual({ kinds: ["doc"] });
    expect(p("docs that mention pricing").text).toBe("pricing");
  });
  it("two kinds in one chip", () => {
    const r = p("docs and comments mentioning pricing");
    expect(r.filters).toEqual({ kinds: ["doc", "comment"] });
    expect(r.chips[0].label).toBe("Docs and comments");
    expect(r.text).toBe("pricing");
  });
  it("tasks are a filter only when asked for outright", () => {
    expect(p("tasks mentioning pricing").filters).toEqual({ kinds: ["task"] });
    expect(p("Maya's tasks").filters).toEqual({ assigneeId: "m-1" });
    expect(p("update api docs").filters).toEqual({});   // a title, not a kind
  });
});

describe("parseSearchNL — everyday words stay words unless something cues a filter", () => {
  const none = (input: string) => { const r = p(input); return { filters: r.filters, chips: r.chips.length }; };
  it("kind words: only the app's own nouns, and only with a cue", () => {
    for (const s of ["user research", "project plan", "reply to client email", "document the release process", "page speed",
      "member onboarding", "wiki cleanup", "page with broken links", "comments section redesign", "people ops hiring plan", "update api docs"]) {
      expect(none(s), s).toEqual({ filters: {}, chips: 0 });
    }
    expect(p("user research").text).toBe("user research");
    expect(p("document the release process").text).toBe("document release process");
  });
  it("…a clear connector makes even the everyday ones a filter", () => {
    expect(p("pages about pricing").filters).toEqual({ kinds: ["doc"] });
    expect(p("users named sana").filters).toEqual({ kinds: ["person"] });
    expect(p("documents mentioning tiers").text).toBe("tiers");
  });
  it("…and a plural kind word may lead with who or where", () => {
    expect(p("comments on the deck").filters).toEqual({ kinds: ["comment"] });
    expect(p("comments on the deck").text).toBe("deck");
    expect(p("docs in launch").filters).toEqual({ kinds: ["doc"], projectId: "p-launch" });
    expect(p("comment by Theo").filters).toEqual({ kinds: ["comment"], authorId: "m-2" });
    expect(p("Theo's replies").filters).toEqual({ kinds: ["comment"], authorId: "m-2" });
  });
  it("a possessive before an everyday word is the assignee", () => {
    expect(p("Maya's page redesign").filters).toEqual({ assigneeId: "m-1" });
    expect(p("Maya's page redesign").text).toBe("page redesign");
    expect(p("my page edits").filters).toEqual({ assigneeId: "m-self" });
  });
  it("status adjectives: alone, or beside another filter or 'tasks'", () => {
    for (const s of ["getting started guide", "closed beta", "definition of done", "pending invoices", "doing taxes", "finished goods count",
      "remaining budget", "ongoing support rota", "send deck for review"]) {
      expect(none(s), s).toEqual({ filters: {}, chips: 0 });
    }
    expect(p("closed beta").text).toBe("closed beta");
    expect(p("done").filters).toEqual({ statuses: ["done"] });
    expect(p("done tasks").filters).toEqual({ statuses: ["done"] });
    expect(p("Maya's done tasks").filters).toEqual({ assigneeId: "m-1", statuses: ["done"] });
    expect(p("closed in launch").filters).toEqual({ statuses: ["done"], projectId: "p-launch" });
    expect(p("pending tasks").filters).toEqual({ excludeDone: true });
    expect(p("started this week").filters).toEqual({ statuses: ["progress"], dueFrom: "2026-10-05", dueTo: "2026-10-11" });
    expect(p("done or blocked").filters).toEqual({ statuses: ["done", "blocked"] });
    expect(labels("done or blocked")).toEqual(["Done or blocked"]);
    expect(removeChipFromInput(p("pricing done or blocked"), "status")).toBe("pricing");
  });
  it("…but never the subject after a connector", () => {
    expect(p("comments about closed beta").filters).toEqual({ kinds: ["comment"] });
    expect(p("comments about closed beta").text).toBe("closed beta");
  });
  it("date words: alone, beside a filter or 'tasks', or after a cue", () => {
    for (const s of ["upcoming webinar", "late fees", "today page redesign", "Black Friday", "weekend plans", "Friday standup notes"]) {
      expect(none(s), s).toEqual({ filters: {}, chips: 0 });
    }
    expect(p("late tasks").filters).toEqual({ dueTo: "2026-10-08", excludeDone: true });
    expect(p("upcoming tasks").filters).toEqual({ dueFrom: "2026-10-09", dueTo: "2026-10-16" });
    expect(p("blocked today").filters).toEqual({ statuses: ["blocked"], dueFrom: "2026-10-09", dueTo: "2026-10-09" });
    expect(p("done today").filters).toEqual({ statuses: ["done"], dueFrom: "2026-10-09", dueTo: "2026-10-09" });
    expect(p("pricing deck due today").filters).toEqual({ dueFrom: "2026-10-09", dueTo: "2026-10-09" });
    expect(p("standup for friday").filters).toEqual({ dueFrom: "2026-10-09", dueTo: "2026-10-09" });
  });
  it("a weekday's short name is a date only after due / by / on / this / next", () => {
    for (const s of ["sun cream", "sat nav", "wed planning", "mon dashboard", "for sat"]) expect(none(s), s).toEqual({ filters: {}, chips: 0 });
    expect(p("sat nav for maya").filters).toEqual({ assigneeId: "m-1" });
    expect(p("sat nav for maya").text).toBe("sat nav");
    expect(due("due sat")).toEqual(["2026-10-10", "2026-10-10"]);
    expect(due("by sun")).toEqual([undefined, "2026-10-11"]);
    expect(due("on wed")).toEqual(["2026-10-14", "2026-10-14"]);
    expect(due("this sun")).toEqual(["2026-10-11", "2026-10-11"]);
    expect(due("next mon")).toEqual(["2026-10-12", "2026-10-12"]);
  });
  it("words that are also JavaScript's own names are just words", () => {
    expect(p("constructor").text).toBe("constructor");
    expect(p("toString deck").text).toBe("toString deck");
    expect(p("due constructor").chips).toEqual([]);
  });
});

describe("parseSearchNL — archived, filler and text", () => {
  it("archived", () => {
    expect(p("pricing including archived").filters).toEqual({ includeArchived: true });
    expect(p("archived launch plans").filters).toEqual({ includeArchived: true });
    expect(p("archived launch plans").text).toBe("launch plans");
  });
  it("filler goes; real words stay in order", () => {
    expect(p("show me all the blocked tasks please").text).toBe("");
    expect(p("find the pricing deck").text).toBe("pricing deck");
    expect(p("what's blocked in launch?").filters).toEqual({ statuses: ["blocked"], projectId: "p-launch" });
  });
  it("quoted words are always text", () => {
    const r = p('"overdue" report by Theo');
    expect(r.filters).toEqual({ assigneeId: "m-2" });
    expect(r.text).toBe('"overdue" report');
    expect(p("“in review” notes").filters).toEqual({});
  });
  it("plain searches are left alone; filler-only input is kept as typed", () => {
    expect(p("budget q3")).toMatchObject({ text: "budget q3", filters: {}, chips: [] });
    expect(p("the").text).toBe("the");
    expect(p("   ").text).toBe("");
    expect(p("").chips).toEqual([]);
  });
  it("never throws on odd input", () => {
    for (const s of ["'s", "''", "“", "by", "in", "due", "next", "#", "assigned to", "12/45", "31 feb", "    ’s ’s", "a".repeat(500)]) {
      expect(() => p(s)).not.toThrow();
    }
    expect(p("31 feb").filters).toEqual({});
    expect(p("assigned to").filters).toEqual({});
  });
});

describe("chips", () => {
  it("record their words and where they are, and can be taken back out of the input", () => {
    const r = p("Maya's overdue tasks in Launch about pricing");
    expect(r.chips.map((c) => c.source)).toEqual(["Maya's", "overdue", "in Launch"]);
    expect(removeChipFromInput(r, "project")).toBe("Maya's overdue tasks about pricing");
    expect(removeChipFromInput(r, "assignee")).toBe("overdue tasks in Launch about pricing");
    const again = p(removeChipFromInput(r, "due"));
    expect(again.filters).toEqual({ assigneeId: "m-1", projectId: "p-launch" });
  });
  it("removing one with removeSearchChip re-merges the rest", () => {
    const r = p("blocked this week in launch");
    const without = removeSearchChip(r, "due");
    expect(without.filters).toEqual({ statuses: ["blocked"], projectId: "p-launch" });
    expect(chipsToFilters(without.chips, { includeArchived: true })).toEqual({ includeArchived: true, statuses: ["blocked"], projectId: "p-launch" });
  });
  it("a joined status chip comes out whole", () => {
    const r = p("pricing blocked or in review");
    expect(removeChipFromInput(r, "status")).toBe("pricing");
  });
  it("protectLiteral quotes what would be read as a filter (old saved searches stay text)", () => {
    expect(protectLiteral("overdue report", CTX)).toBe('"overdue" report');
    expect(p(protectLiteral("overdue report", CTX)).filters).toEqual({});
    expect(protectLiteral("budget q3", CTX)).toBe("budget q3");
  });
});

describe("which kinds a search shows", () => {
  it("task filters alone mean tasks; an author means comments; kinds win", () => {
    expect(effectiveKinds({})).toEqual(["task", "comment", "doc", "project", "person"]);
    expect(effectiveKinds({ projectId: "p" })).toEqual(["task", "comment", "doc", "project", "person"]);
    expect(effectiveKinds({ statuses: ["blocked"] })).toEqual(["task"]);
    expect(effectiveKinds({ authorId: "m-2" })).toEqual(["comment"]);
    expect(effectiveKinds({ kinds: ["doc"], statuses: ["blocked"] })).toEqual(["doc"]);
    expect(hasTaskOnlyFilters({ dueTo: "2026-10-08" })).toBe(true);
    expect(hasTaskOnlyFilters({ includeArchived: true, projectId: "p" })).toBe(false);
  });
});

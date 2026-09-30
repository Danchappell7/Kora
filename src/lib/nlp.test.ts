import { describe, it, expect } from "vitest";
import { parseTask, parseDateText, splitLines, segments, stripTokens, matchMember, matchProject, dayLabel, type ParsedTask } from "./nlp";

// Wednesday 30 September 2026 (also the last day of the month)
const TODAY = new Date(2026, 8, 30);
const projects = [
  { id: "p-personal", name: "Personal" },
  { id: "p-launch", name: "Q3 Product Launch" },
  { id: "p-brand", name: "Brand Refresh" },
  { id: "p-infra", name: "Platform Infra" },
];
const members = [
  { id: "m-self", name: "Daniel Okai" },
  { id: "m-1", name: "Maya Lin" },
  { id: "m-2", name: "Theo Vance" },
  { id: "m-3", name: "Sana Rao" },
];
const tags = { design: { label: "Design" }, eng: { label: "Engineering" }, bug: { label: "Bug" } };
const parse = (text: string, extra: Parameters<typeof parseTask>[1] = {}) => parseTask(text, { today: TODAY, projects, members, tags, ...extra });

type Row = [input: string, expected: Partial<ParsedTask>];
const check = (rows: Row[]) => it.each(rows)("%s", (input, expected) => {
  const p = parse(input);
  const { spans: _spans, ...fields } = p;
  // every field the row names must match; fields it doesn't name must be unset
  const keys = new Set([...Object.keys(expected), ...Object.keys(fields)]);
  for (const k of keys) expect([k, fields[k as keyof typeof fields]]).toEqual([k, expected[k as keyof ParsedTask]]);
});

describe("dates", () => {
  check([
    ["Pay rent today", { title: "Pay rent", dueDate: "2026-09-30" }],
    ["Pay rent tod", { title: "Pay rent", dueDate: "2026-09-30" }],
    ["Pay rent tomorrow", { title: "Pay rent", dueDate: "2026-10-01" }],
    ["Pay rent tmr", { title: "Pay rent", dueDate: "2026-10-01" }],
    ["Pay rent tmrw", { title: "Pay rent", dueDate: "2026-10-01" }],
    ["Pay rent day after tomorrow", { title: "Pay rent", dueDate: "2026-10-02" }],
    // weekdays: the next one strictly after today…
    ["Pay rent mon", { title: "Pay rent", dueDate: "2026-10-05" }],
    ["Pay rent Monday", { title: "Pay rent", dueDate: "2026-10-05" }],
    ["Pay rent thursday", { title: "Pay rent", dueDate: "2026-10-01" }],
    ["Pay rent fri", { title: "Pay rent", dueDate: "2026-10-02" }],
    ["Pay rent wed", { title: "Pay rent", dueDate: "2026-10-07" }],
    // …"this" can be today, "next" is next week's
    ["Pay rent this wed", { title: "Pay rent", dueDate: "2026-09-30" }],
    ["Pay rent this fri", { title: "Pay rent", dueDate: "2026-10-02" }],
    ["Pay rent next tue", { title: "Pay rent", dueDate: "2026-10-06" }],
    ["Pay rent next fri", { title: "Pay rent", dueDate: "2026-10-09" }],
    ["Pay rent next week", { title: "Pay rent", dueDate: "2026-10-05" }],
    ["Pay rent weekend", { title: "Pay rent", dueDate: "2026-10-03" }],
    ["Pay rent this weekend", { title: "Pay rent", dueDate: "2026-10-03" }],
    ["Pay rent next weekend", { title: "Pay rent", dueDate: "2026-10-10" }],
    ["Pay rent end of week", { title: "Pay rent", dueDate: "2026-10-02" }],
    ["Pay rent eow", { title: "Pay rent", dueDate: "2026-10-02" }],
    ["Pay rent end of month", { title: "Pay rent", dueDate: "2026-09-30" }],
    ["Pay rent eom", { title: "Pay rent", dueDate: "2026-09-30" }],
    ["Pay rent in 3 days", { title: "Pay rent", dueDate: "2026-10-03" }],
    ["Pay rent in 2 weeks", { title: "Pay rent", dueDate: "2026-10-14" }],
    ["Pay rent in a fortnight", { title: "Pay rent", dueDate: "2026-10-14" }],
    ["Pay rent in 1 month", { title: "Pay rent", dueDate: "2026-10-30" }],
    // written dates, UK order
    ["Pay rent 3 Oct", { title: "Pay rent", dueDate: "2026-10-03" }],
    ["Pay rent 3rd October", { title: "Pay rent", dueDate: "2026-10-03" }],
    ["Pay rent 3rd of October 2027", { title: "Pay rent", dueDate: "2027-10-03" }],
    ["Pay rent Oct 3", { title: "Pay rent", dueDate: "2026-10-03" }],
    ["Pay rent October 3rd", { title: "Pay rent", dueDate: "2026-10-03" }],
    ["Pay rent 03/10", { title: "Pay rent", dueDate: "2026-10-03" }],
    ["Pay rent 3/10", { title: "Pay rent", dueDate: "2026-10-03" }],
    ["Pay rent 03/10/2026", { title: "Pay rent", dueDate: "2026-10-03" }],
    ["Pay rent 3/10/27", { title: "Pay rent", dueDate: "2027-10-03" }],
    ["Pay rent 2026-10-03", { title: "Pay rent", dueDate: "2026-10-03" }],
    // a year-less date more than a month back is next year's; a recent one stays
    ["Pay rent 3 Jan", { title: "Pay rent", dueDate: "2027-01-03" }],
    ["Pay rent 3 Sep", { title: "Pay rent", dueDate: "2026-09-03" }],
    // lead-in words go with the date
    ["Send invoice by fri", { title: "Send invoice", dueDate: "2026-10-02" }],
    ["Report due on 3 Oct", { title: "Report", dueDate: "2026-10-03" }],
    ["Book table for sat", { title: "Book table", dueDate: "2026-10-03" }],
    // …and words that only look like dates stay put
    ["Buy sun cream", { title: "Buy sun cream" }],
    ["Fix the sat nav", { title: "Fix the sat nav" }],
    ["Pay rent sun", { title: "Pay rent", dueDate: "2026-10-04" }],
    ["Review today's numbers", { title: "Review today's numbers" }],
    ["Cut portions to 1/2", { title: "Cut portions to 1/2" }],
    ["Pay rent 31/02", { title: "Pay rent 31/02" }],
    ["Budget 10,000 for Q3", { title: "Budget 10,000 for Q3" }],
    // a bare day/month mid-sentence needs a lead-in or a token after it; 24/7 is never a day
    ["Set up 24/7 on-call rota", { title: "Set up 24/7 on-call rota" }],
    ["Fix 24/7 monitoring", { title: "Fix 24/7 monitoring" }],
    ["Support 24/7", { title: "Support 24/7" }],
    ["Split the 20/12 budget", { title: "Split the 20/12 budget" }],
    ["Pay rent by 3/10 please", { title: "Pay rent please", dueDate: "2026-10-03" }],
    ["Pay rent 3/10 !high", { title: "Pay rent", dueDate: "2026-10-03", priority: "high" }],
    ["Book the train 3/10 at 9am", { title: "Book the train", dueDate: "2026-10-03", dueTime: "09:00" }],
    // "weekend" is a word too: only a lead-in, this/next or the end make it a day
    ["Review weekend sales", { title: "Review weekend sales" }],
    ["Plan the weekend", { title: "Plan the weekend" }],
    ["Tidy the garage by the weekend", { title: "Tidy the garage", dueDate: "2026-10-03" }],
    ["Paint the fence at the weekend", { title: "Paint the fence", dueDate: "2026-10-03" }],
    ["Tidy the garage weekend 10am", { title: "Tidy the garage", dueDate: "2026-10-03", dueTime: "10:00" }],
    // a day after "the", "last", "our"… is a noun; a title that opens with its day keeps it
    ["Prep for the Monday meeting", { title: "Prep for the Monday meeting" }],
    ["Last friday retro notes", { title: "Last friday retro notes" }],
    ["Enjoy the sun", { title: "Enjoy the sun" }],
    ["Monday standup notes", { title: "Monday standup notes" }],
    ["Monday 9am standup", { title: "standup", dueDate: "2026-10-05", dueTime: "09:00" }],
    ["Fri: send the deck", { title: ": send the deck", dueDate: "2026-10-02" }],
  ]);
  it("reads 3/10 month first when a file says so (import's date order)", () => {
    expect(parse("Pay rent 10/3", { dateOrder: "mdy" }).dueDate).toBe("2026-10-03");
    expect(parse("Pay rent 10/3").dueDate).toBe("2027-03-10");
    expect(parse("Pay rent 2026-10-03", { dateOrder: "mdy" }).dueDate).toBe("2026-10-03");
  });
});

describe("times", () => {
  check([
    // a time with no day means today (and goes on today's plan)
    ["Call Sana at 3pm", { title: "Call Sana", dueDate: "2026-09-30", dueTime: "15:00", planToday: true }],
    ["Call Sana 3pm", { title: "Call Sana", dueDate: "2026-09-30", dueTime: "15:00", planToday: true }],
    ["Call Sana 3:30 pm", { title: "Call Sana", dueDate: "2026-09-30", dueTime: "15:30", planToday: true }],
    ["Call Sana 15:00", { title: "Call Sana", dueDate: "2026-09-30", dueTime: "15:00", planToday: true }],
    ["Call Sana at 9.30", { title: "Call Sana", dueDate: "2026-09-30", dueTime: "09:30", planToday: true }],
    ["Call Sana at 3", { title: "Call Sana", dueDate: "2026-09-30", dueTime: "15:00", planToday: true }],
    ["Call Sana at 9", { title: "Call Sana", dueDate: "2026-09-30", dueTime: "09:00", planToday: true }],
    ["Lunch at noon", { title: "Lunch", dueDate: "2026-09-30", dueTime: "12:00", planToday: true }],
    ["Lunch midday", { title: "Lunch", dueDate: "2026-09-30", dueTime: "12:00", planToday: true }],
    ["Call Sana 12am", { title: "Call Sana", dueDate: "2026-09-30", dueTime: "00:00", planToday: true }],
    // with a date
    ["Call Sana fri 3pm", { title: "Call Sana", dueDate: "2026-10-02", dueTime: "15:00" }],
    ["Call Sana tomorrow at 9.30", { title: "Call Sana", dueDate: "2026-10-01", dueTime: "09:30" }],
    ["Call Sana today 4pm", { title: "Call Sana", dueDate: "2026-09-30", dueTime: "16:00", planToday: true }],
    // a bare "at 3" beside a day, or before another token, is a time…
    ["Call Sana fri at 3", { title: "Call Sana", dueDate: "2026-10-02", dueTime: "15:00" }],
    ["Call Sana at 3 on fri", { title: "Call Sana", dueDate: "2026-10-02", dueTime: "15:00" }],
    ["Call Sana at 3 #launch", { title: "Call Sana", dueDate: "2026-09-30", dueTime: "15:00", planToday: true, projectId: "p-launch" }],
    // …mid-sentence it's a title
    ["Look at 3 vendor quotes", { title: "Look at 3 vendor quotes" }],
    ["Look at 3 vendor quotes tomorrow", { title: "Look at 3 vendor quotes", dueDate: "2026-10-01" }],
    ["Meet at 10 Downing Street", { title: "Meet at 10 Downing Street" }],
    ["Meet at 10.30 in the lobby", { title: "Meet in the lobby", dueDate: "2026-09-30", dueTime: "10:30", planToday: true }],
    // not times
    ["Release v2.30", { title: "Release v2.30" }],
    ["Call Sana 13pm", { title: "Call Sana 13pm" }],
  ]);
});

describe("repeats", () => {
  check([
    ["Water plants every day", { title: "Water plants", recurrence: "daily", dueDate: "2026-09-30" }],
    ["Water plants daily", { title: "Water plants", recurrence: "daily", dueDate: "2026-09-30" }],
    ["Standup weekdays", { title: "Standup", recurrence: "weekdays", dueDate: "2026-09-30" }],
    ["Standup every weekday", { title: "Standup", recurrence: "weekdays", dueDate: "2026-09-30" }],
    ["Gym on weekdays", { title: "Gym", recurrence: "weekdays", dueDate: "2026-09-30" }],
    // "every mon" repeats weekly and starts on the next Monday (today counts)
    ["Team sync every mon", { title: "Team sync", recurrence: "weekly", dueDate: "2026-10-05" }],
    ["Team sync every Monday", { title: "Team sync", recurrence: "weekly", dueDate: "2026-10-05" }],
    ["Team sync every wed", { title: "Team sync", recurrence: "weekly", dueDate: "2026-09-30" }],
    ["Retro every other fri", { title: "Retro", recurrence: "biweekly", dueDate: "2026-10-02" }],
    ["Report every week", { title: "Report", recurrence: "weekly", dueDate: "2026-09-30" }],
    ["Payroll fortnightly", { title: "Payroll", recurrence: "biweekly", dueDate: "2026-09-30" }],
    ["Payroll every 2 weeks", { title: "Payroll", recurrence: "biweekly", dueDate: "2026-09-30" }],
    ["Invoice monthly", { title: "Invoice", recurrence: "monthly", dueDate: "2026-09-30" }],
    ["Invoice every month", { title: "Invoice", recurrence: "monthly", dueDate: "2026-09-30" }],
    // a date given with the repeat wins over the implied first one
    ["Invoice every month 3 Oct", { title: "Invoice", recurrence: "monthly", dueDate: "2026-10-03" }],
    // a bare "weekly"/"monthly" repeats only at the end, or before other tokens…
    ["Pay rent monthly !high", { title: "Pay rent", recurrence: "monthly", dueDate: "2026-09-30", priority: "high" }],
    ["Team sync weekly 10am", { title: "Team sync", recurrence: "weekly", dueDate: "2026-09-30", dueTime: "10:00", planToday: true }],
    ["Water plants daily.", { title: "Water plants.", recurrence: "daily", dueDate: "2026-09-30" }],
    ["Weekly 10am", { title: "Weekly", recurrence: "weekly", dueDate: "2026-09-30", dueTime: "10:00", planToday: true }],
    // …in the middle of a title it's an adjective
    ["Cancel the monthly subscription", { title: "Cancel the monthly subscription" }],
    ["Send weekly update to the board", { title: "Send weekly update to the board" }],
    ["Review weekdays schedule", { title: "Review weekdays schedule" }],
    ["Weekly review & plan", { title: "Weekly review & plan" }],
    ["Weekly review & plan every fri", { title: "Weekly review & plan", recurrence: "weekly", dueDate: "2026-10-02" }],
  ]);
});

describe("start dates", () => {
  check([
    ["Onboarding from mon", { title: "Onboarding", startDate: "2026-10-05" }],
    ["Campaign starting 3 Oct", { title: "Campaign", startDate: "2026-10-03" }],
    ["Campaign starts fri due 9 Oct", { title: "Campaign", startDate: "2026-10-02", dueDate: "2026-10-09" }],
    ["Report every week from mon", { title: "Report", recurrence: "weekly", startDate: "2026-10-05", dueDate: "2026-10-05" }],
    ["Email from Sarah", { title: "Email from Sarah" }],
  ]);
});

describe("durations and estimates", () => {
  check([
    ["Write memo 30m", { title: "Write memo", focusMin: 30 }],
    ["Write memo 1h", { title: "Write memo", focusMin: 60 }],
    ["Write memo 1h30", { title: "Write memo", focusMin: 90 }],
    ["Write memo 90 mins", { title: "Write memo", focusMin: 90 }],
    ["Write memo (2h)", { title: "Write memo", focusMin: 120 }],
    ["Migrate the database ~2h", { title: "Migrate the database", effortHours: 2 }],
    ["Migrate the database est 3h", { title: "Migrate the database", effortHours: 3 }],
    ["Migrate the database ~30m", { title: "Migrate the database", effortHours: 0.5 }],
    ["Migrate the database ~1h30", { title: "Migrate the database", effortHours: 1.5 }],
    ["Migrate the database est 2h 45m", { title: "Migrate the database", effortHours: 2.75 }],
    ["Upload 30mb file", { title: "Upload 30mb file" }],
  ]);
});

describe("priority", () => {
  check([
    ["Fix bug !", { title: "Fix bug", priority: "medium" }],
    ["Fix bug !!", { title: "Fix bug", priority: "high" }],
    ["Fix bug !!!", { title: "Fix bug", priority: "urgent" }],
    ["Fix bug !urgent", { title: "Fix bug", priority: "urgent" }],
    ["Fix bug !high", { title: "Fix bug", priority: "high" }],
    ["Fix bug !med", { title: "Fix bug", priority: "medium" }],
    ["Fix bug !low", { title: "Fix bug", priority: "low" }],
    ["Fix bug p1", { title: "Fix bug", priority: "urgent" }],
    ["Fix bug p2", { title: "Fix bug", priority: "high" }],
    ["Fix bug P3", { title: "Fix bug", priority: "medium" }],
    ["Fix bug p4", { title: "Fix bug", priority: "low" }],
    ["Fix !highway sign", { title: "Fix !highway sign" }],
    ["Urgent care booking", { title: "Urgent care booking" }],
    ["Plan Q3 offsite", { title: "Plan Q3 offsite" }],
  ]);
  it("reads bare urgent/asap only when asked (the Today capture)", () => {
    expect(parse("Fix login asap", { priorityWords: true })).toMatchObject({ title: "Fix login", priority: "high" });
    expect(parse("Fix login asap").priority).toBeUndefined();
  });
});

describe("projects, people and tags", () => {
  check([
    ["Draft FAQ #launch", { title: "Draft FAQ", projectId: "p-launch" }],
    ["Draft FAQ #brand", { title: "Draft FAQ", projectId: "p-brand" }],
    ["Draft FAQ #q3", { title: "Draft FAQ", projectId: "p-launch" }],
    ["Draft FAQ #infra", { title: "Draft FAQ", projectId: "p-infra" }],
    ["Draft FAQ #nowhere", { title: "Draft FAQ #nowhere" }],
    ["Fix issue #3", { title: "Fix issue #3" }],
    ["Send brief @sana", { title: "Send brief", assigneeId: "m-3" }],
    ["Send brief @Maya", { title: "Send brief", assigneeId: "m-1" }],
    ["Send brief @lin", { title: "Send brief", assigneeId: "m-1" }],
    ["Send brief @theo.", { title: "Send brief.", assigneeId: "m-2" }],
    ["Email dan@acme.com", { title: "Email dan@acme.com" }],
    ["Send brief @nobody", { title: "Send brief @nobody" }],
    ["Review the deck with @sana", { title: "Review the deck", assigneeId: "m-3" }],
    ["@sana to send the brief", { title: "send the brief", assigneeId: "m-3" }],
    ["Things to deal with", { title: "Things to deal with" }],
    ["Hero art +design", { title: "Hero art", tags: ["design"] }],
    ["Hero art +engineering +bug", { title: "Hero art", tags: ["eng", "bug"] }],
    ["Hero art +eng", { title: "Hero art", tags: ["eng"] }],
    ["Vote +1", { title: "Vote +1" }],
  ]);
});

describe("energy", () => {
  check([
    ["Write memo deep work", { title: "Write memo", energy: "deep" }],
    ["Write memo focus", { title: "Write memo", energy: "deep" }],
    ["Focus group prep", { title: "Focus group prep" }],
    ["Deep work on the pricing model", { title: "Deep work on the pricing model", energy: "deep" }],
  ]);
});

describe("the whole sentence", () => {
  it("reads “call Sana fri 3pm ~30m #launch”", () => {
    const p = parse("call Sana fri 3pm ~30m #launch");
    expect(p).toMatchObject({ title: "call Sana", dueDate: "2026-10-02", dueTime: "15:00", effortHours: 0.5, projectId: "p-launch" });
    expect(p.planToday).toBeUndefined();
    expect(p.spans).toEqual([
      { start: 10, end: 13, kind: "date", label: "Fri 2 Oct" },
      { start: 14, end: 17, kind: "time", label: "15:00" },
      { start: 18, end: 22, kind: "estimate", label: "30m estimate" },
      { start: 23, end: 30, kind: "project", label: "Q3 Product Launch" },
    ]);
  });

  it("records spans at their place in the original text, lead-ins included", () => {
    const text = "Send invoice by fri !high @maya +design every mon 45m";
    const p = parse(text);
    const got = p.spans.map((s) => [s.kind, text.slice(s.start, s.end)]);
    expect(got).toEqual([
      ["date", "by fri"], ["priority", "!high"], ["person", "@maya"], ["tag", "+design"], ["repeat", "every mon"], ["duration", "45m"],
    ]);
    expect(p.title).toBe("Send invoice");
  });

  it("segments rebuild the text exactly, with the tokens marked", () => {
    const text = "Plan launch tomorrow 3pm #brand";
    const segs = segments(text, parse(text).spans);
    expect(segs.map((s) => s.text).join("")).toBe(text);
    expect(segs.filter((s) => s.span).map((s) => s.text)).toEqual(["tomorrow", "3pm", "#brand"]);
  });

  it("keeps a token's first appearance only, and reads the rest as title", () => {
    expect(parse("Move today's call today")).toMatchObject({ title: "Move today's call", dueDate: "2026-09-30" });
    expect(parse("Plan fri or mon")).toMatchObject({ title: "Plan or mon", dueDate: "2026-10-02" });
  });

  it("reads only the kinds it's asked for, and never splits a phrase another kind owns", () => {
    expect(parse("Report every mon", { kinds: ["date"] })).toEqual({ title: "Report every mon", spans: [] });
    expect(parse("Call Sam at 3pm", { kinds: ["date", "duration"] }).title).toBe("Call Sam at 3pm");
    expect(parse("Scope est 3h", { kinds: ["duration"] })).toEqual({ title: "Scope est 3h", spans: [] });
  });

  it("can read “next week” as a week today, as the legacy parsers do", () => {
    expect(parse("Plan next week", { nextWeek: "+7" }).dueDate).toBe("2026-10-07");
  });

  it("reads a long paste in linear time (tags, rejected sat/sun, and all)", () => {
    const text = Array.from({ length: 4000 }, (_, i) => (i % 2 ? `Task ${i} +design sat nav` : `Task ${i} fri 3pm`)).join("\n");
    const t0 = performance.now();
    const p = parse(text);
    // was ~45s for 8,000 lines when every rule re-joined the text; now a few ms
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(p.tags).toEqual(["design"]);
    expect(p.spans.filter((s) => s.kind === "tag")).toHaveLength(2000);
  });

  it("uses the live day when none is given", () => {
    const p = parseTask("Pay rent tomorrow");
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1);
    expect(p.dueDate).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  });
});

describe("parseDateText", () => {
  it.each([
    ["fri", { date: "2026-10-02" }],
    ["Fri 3pm", { date: "2026-10-02", time: "15:00" }],
    ["on 3 Oct", { date: "2026-10-03" }],
    ["03/10", { date: "2026-10-03" }],
    ["tomorrow at 9.30", { date: "2026-10-01", time: "09:30" }],
    ["next week", { date: "2026-10-05" }],
    ["in 2 weeks", { date: "2026-10-14" }],
    ["3pm", { time: "15:00" }],
  ])("%s", (text, expected) => {
    expect(parseDateText(text, TODAY)).toEqual(expected);
  });
  it.each(["", "   ", "blah", "fri blah", "call Sana fri", "31/02"])("“%s” is not a date", (text) => {
    expect(parseDateText(text, TODAY)).toBeNull();
  });
});

describe("splitLines", () => {
  it("trims bullets and checkboxes, reads indents as depth and drops blank lines", () => {
    const text = "- Plan launch\n  - Book venue\n\t- Send invites\n    * Print badges\n\n1. Brief team\n[ ] Check budget\n- [ ] Buy snacks\n• Thank everyone\r\n2) Close out";
    expect(splitLines(text)).toEqual([
      { title: "Plan launch", depth: 0 },
      { title: "Book venue", depth: 1 },
      { title: "Send invites", depth: 1 },
      { title: "Print badges", depth: 2 },
      { title: "Brief team", depth: 0 },
      { title: "Check budget", depth: 0 },
      { title: "Buy snacks", depth: 0 },
      { title: "Thank everyone", depth: 0 },
      { title: "Close out", depth: 0 },
    ]);
  });
  it("leaves a tag or a plain line alone", () => {
    expect(splitLines("+design review\nCall Sana")).toEqual([{ title: "+design review", depth: 0 }, { title: "Call Sana", depth: 0 }]);
  });
});

describe("helpers", () => {
  it("stripTokens drops the kinds a field now owns", () => {
    const text = "Call Sana fri 3pm #launch";
    expect(stripTokens(text, parse(text).spans, ["date", "time"])).toBe("Call Sana #launch");
  });
  it("matches people by first name, full name or a word's start", () => {
    expect(matchMember("sana", members)?.id).toBe("m-3");
    expect(matchMember("mayalin", members)?.id).toBe("m-1");
    expect(matchMember("vance", members)?.id).toBe("m-2");
    expect(matchMember("x", members)).toBeUndefined();
    expect(matchProject("platform-infra", projects)?.id).toBe("p-infra");
  });
  it("labels days the way the app writes them", () => {
    expect(dayLabel("2026-10-02", TODAY)).toBe("Fri 2 Oct");
    expect(dayLabel("2027-01-03", TODAY)).toBe("Sun 3 Jan 2027");
  });
});

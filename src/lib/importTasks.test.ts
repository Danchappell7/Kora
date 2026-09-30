import { describe, it, expect } from "vitest";
import {
  analyseImport, parseImportText, parseDelimited, parseImportDate, parseMinutes, mapStatus, mapPriority,
  matchMember, decodeImportBytes, IMPORT_LIMIT,
} from "./importTasks";
import { buildTasksCsv } from "./exportTasks";
import type { Task } from "../data/types";

const TODAY = new Date(2026, 8, 30); // Wed 30 Sep 2026
const projects = [{ id: "p-web", name: "Website" }, { id: "p-ops", name: "Operations" }];
const members = [
  { id: "u-sarah", name: "Sarah Jones", email: "sarah@acme.co.uk" },
  { id: "u-tom", name: "Tom Baker", email: "tom.baker@acme.co.uk" },
];
const tags = { design: { label: "Design", color: "red" }, "tag-123": { label: "Q4 launch", color: "blue" } };
const sections = [{ id: "s-backlog", projectId: "p-web", name: "Backlog" }, { id: "s-build", projectId: "p-web", name: "Build" }];
const opts = { projects, members, tags, sections, defaultProjectId: "p-web", today: TODAY };

describe("parseDelimited", () => {
  it("handles quoted commas, newlines, doubled quotes and CRLF", () => {
    const recs = parseDelimited('Name,Notes\r\n"Book venue, catering","Line 1\nLine 2 ""quoted"""\r\nSend invites,\r\n', ",");
    expect(recs).toEqual([["Name", "Notes"], ["Book venue, catering", 'Line 1\nLine 2 "quoted"'], ["Send invites", ""]]);
  });
  it("reads a stray quote literally instead of swallowing the rest of the file", () => {
    const recs = parseDelimited('"Quick" wins\tHigh\nNext task\tLow', "\t");
    expect(recs).toEqual([['"Quick" wins', "High"], ["Next task", "Low"]]);
  });
});

describe("mode detection", () => {
  it("keeps a pasted list whole instead of cutting it at the first comma", () => {
    const rows = analyseImport("Call Sarah re budget, timeline\nBook venue, catering\nSend invites", opts).rows;
    expect(rows.map((r) => r.title)).toEqual(["Call Sarah re budget, timeline", "Book venue, catering", "Send invites"]);
  });
  it("keeps consistently comma-separated sentences whole when no column is typed", () => {
    const a = analyseImport("Book venue, catering\nCall Sarah, re budget", opts);
    expect(a.mode).toBe("lines");
    expect(a.rows.map((r) => r.title)).toEqual(["Book venue, catering", "Call Sarah, re budget"]);
  });
  it("recognises header aliases such as Task Name / Due Date and reads UK dates", () => {
    const a = analyseImport("Task Name,Due Date,Priority\nDraft brief,29/09/2026,High\nShip it,3/10/26,urgent", opts);
    expect(a.mode).toBe("columns");
    expect(a.hasHeader).toBe(true);
    expect(a.rows).toHaveLength(2);
    expect(a.rows[0]).toMatchObject({ title: "Draft brief", dueDate: "2026-09-29", priority: "high" });
    expect(a.rows[1]).toMatchObject({ title: "Ship it", dueDate: "2026-10-03", priority: "urgent" });
  });
  it("uses tab-separated rows copied from a spreadsheet without a header", () => {
    const a = analyseImport("Write report\t31/10/2026\tHigh\nReview deck\t01/11/2026\tLow", opts);
    expect(a.mode).toBe("columns");
    expect(a.hasHeader).toBe(false);
    expect(a.rows[0]).toMatchObject({ title: "Write report", dueDate: "2026-10-31", priority: "high" });
    expect(a.rows[1]).toMatchObject({ title: "Review deck", dueDate: "2026-11-01", priority: "low" });
  });
  it("uses comma columns without a header only when a column is clearly typed", () => {
    const a = analyseImport("Submit VAT return, 2026-10-07\nPay suppliers, 2026-10-10", opts);
    expect(a.mode).toBe("columns");
    expect(a.rows[0]).toMatchObject({ title: "Submit VAT return", dueDate: "2026-10-07" });
  });
  it("finds a header below a title line and skips repeated headers", () => {
    const a = analyseImport("Marketing board\nName\tStatus\tDate\tPerson\nPlan launch\tWorking on it\t2026-10-02\tSarah Jones\nName\tStatus\tDate\tPerson\nWrite copy\tDone\t2026-10-01\tTom Baker", opts);
    expect(a.warnings.skippedLeading).toBe(1);
    expect(a.rows.map((r) => r.title)).toEqual(["Plan launch", "Write copy"]);
    expect(a.rows[0]).toMatchObject({ status: "progress", dueDate: "2026-10-02", assigneeId: "u-sarah" });
    expect(a.rows[1]).toMatchObject({ status: "done", assigneeId: "u-tom" });
  });
  it("can be forced to one task per line", () => {
    const a = analyseImport("Title,Due\nA,2026-10-01", { ...opts, mode: "lines" });
    expect(a.rows.map((r) => r.title)).toEqual(["Title,Due", "A,2026-10-01"]);
  });
  it("drops a list heading, bullets and numbering, and reads checkboxes", () => {
    const a = analyseImport("To do\n- Email supplier\n• Book room\n2. Send agenda\n- [x] Order lunch\n[ ] Print badges\n-Call supplier", opts);
    expect(a.rows.map((r) => r.title)).toEqual(["Email supplier", "Book room", "Send agenda", "Order lunch", "Print badges", "-Call supplier"]);
    expect(a.rows[3].status).toBe("done");
    expect(a.rows[4].status).toBeUndefined();
  });
  it("leaves out a heading ending in a colon above a bulleted list", () => {
    const a = analyseImport("Actions from Monday:\n- Email supplier\n- Book room\nFollow up with legal", opts);
    expect(a.rows.map((r) => r.title)).toEqual(["Email supplier", "Book room", "Follow up with legal"]);
    expect(a.warnings.skippedHeadings).toBe(1);
    // without bullets, a colon is just part of the task
    expect(analyseImport("Agenda: budget\nCall Sam", opts).rows.map((r) => r.title)).toEqual(["Agenda: budget", "Call Sam"]);
  });
});

describe("natural-language text", () => {
  it("is not applied when a Title column is detected", () => {
    const rows = analyseImport("Title,Priority\nRecord 5 min intro video,low\nPlan next week offsite,low\nPrepare tomorrow's agenda,low", opts).rows;
    expect(rows.map((r) => r.title)).toEqual(["Record 5 min intro video", "Plan next week offsite", "Prepare tomorrow's agenda"]);
    expect(rows.every((r) => r.focusMin === undefined && r.dueDate === undefined)).toBe(true);
  });
  it("carries parsed durations on plain lists and leaves possessives alone", () => {
    const rows = analyseImport("Record 5 min intro video\nPrepare tomorrow's agenda\nDraft deck !high tomorrow", opts).rows;
    expect(rows[0]).toMatchObject({ title: "Record intro video", focusMin: 5, dur: 5 });
    expect(rows[1].title).toBe("Prepare tomorrow's agenda");
    expect(rows[1].dueDate).toBeUndefined();
    expect(rows[2]).toMatchObject({ title: "Draft deck", priority: "high" });
    expect(rows[2].dueDate).toBeTruthy();
  });
  it("can be switched off", () => {
    const rows = analyseImport("Record 5 min intro video", { ...opts, smartText: false }).rows;
    expect(rows[0].title).toBe("Record 5 min intro video");
    expect(rows[0].focusMin).toBeUndefined();
  });
});

describe("Asana / Trello / Jira exports", () => {
  it("imports an Asana CSV with multi-line notes, completion, people, sections, tags and sub-tasks", () => {
    const csv = [
      "Task ID,Created At,Completed At,Last Modified,Name,Section/Column,Assignee,Assignee Email,Start Date,Due Date,Tags,Notes,Projects,Parent task",
      '1,2026-09-01,,2026-09-02,Launch site,Build,Sarah Jones,sarah@acme.co.uk,2026-09-20,2026-10-15,"Design,Q4 launch","Line one\nLine two, with a comma",Website,',
      "2,2026-09-01,2026-09-10,2026-09-10,Write copy,Done,,tom.baker@acme.co.uk,,2026-09-09,,,,Launch site",
      "3,2026-09-01,,2026-09-02,Pick fonts,Brand ideas,Nobody Known,nobody@else.com,,,Fonts,,Marketing,",
    ].join("\n");
    const a = analyseImport(csv, { ...opts, csv: true });
    expect(a.rows).toHaveLength(3); // the multi-line note didn't become extra tasks
    const [launch, copy, fonts] = a.rows;
    expect(launch).toMatchObject({
      title: "Launch site", description: "Line one\nLine two, with a comma", assigneeId: "u-sarah",
      startDate: "2026-09-20", dueDate: "2026-10-15", tags: ["design", "tag-123"], sectionId: "s-build", projectId: "p-web",
    });
    expect(copy).toMatchObject({ status: "done", completedAt: "2026-09-10", assigneeId: "u-tom", parentTitle: "Launch site", parentIndex: 0 });
    expect(copy.sectionName).toBeUndefined(); // "Done" became a status, not a missing section
    expect(fonts).toMatchObject({ newTags: ["Fonts"], sectionName: "Brand ideas", projectId: "p-web" });
    expect(fonts.assigneeId).toBeUndefined();
    expect(a.warnings.unknownAssignees.count).toBe(1);
    expect(a.warnings.unknownProjects.names).toEqual(["Marketing"]);
    expect(a.warnings.missingSections).toEqual(["Brand ideas"]);
    expect(a.warnings.newTags).toEqual(["Fonts"]);
    expect(a.warnings.subtasks).toBe(1);
    // Task ID is used to link sub-tasks, so it isn't listed as dropped
    expect(a.ignoredColumns).toEqual(["Created At", "Last Modified"]);
  });
  it("imports a Trello CSV: card names, list status, label colours, archived cards", () => {
    const csv = [
      "Card ID,Card Name,Card Description,Labels,Members,Due Date,List Name,Archived",
      "a1,Fix header,,Design (green),Tom Baker,2026-10-01T09:00:00.000Z,Doing,false",
      "a2,Old card,,,,,Done,true",
    ].join("\n");
    const a = analyseImport(csv, { ...opts, csv: true });
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ title: "Fix header", status: "progress", tags: ["design"], assigneeId: "u-tom", dueDate: "2026-10-01" });
    expect(a.warnings.skippedArchived).toBe(1);
  });
  it("links Jira sub-tasks by id and prefers the parent summary for the name", () => {
    const csv = [
      "Summary,Issue key,Issue id,Parent,Parent summary,Status,Priority,Due date,Resolved,Labels,Labels",
      "Checkout revamp,WEB-1,1001,,,In Progress,Highest,30/Oct/26 5:00 PM,,payments,Design",
      "Card form,WEB-2,1002,1001,Checkout revamp,Done,Low,,02/Oct/26 11:12 AM,,",
    ].join("\n");
    const a = analyseImport(csv, { ...opts, csv: true });
    expect(a.rows[0]).toMatchObject({ status: "progress", priority: "urgent", dueDate: "2026-10-30", tags: ["design"], newTags: ["payments"] });
    expect(a.rows[1]).toMatchObject({ status: "done", completedAt: "2026-10-02", parentIndex: 0, parentTitle: "Checkout revamp" });
  });
});

describe("values", () => {
  it("maps status labels and keys", () => {
    expect(mapStatus("In progress")).toBe("progress");
    expect(mapStatus("In review")).toBe("review");
    expect(mapStatus("Working on it")).toBe("progress");
    expect(mapStatus("Stuck")).toBe("blocked");
    expect(mapStatus("done")).toBe("done");
    expect(mapStatus("On track")).toBeNull();
  });
  it("maps priorities from other tools", () => {
    expect(mapPriority("Highest")).toBe("urgent");
    expect(mapPriority("⚠️ Critical")).toBe("urgent");
    expect(mapPriority("P2")).toBe("medium");
    expect(mapPriority("1 - High")).toBe("high");
    expect(mapPriority("banana")).toBeNull();
  });
  it("reads durations", () => {
    expect(parseMinutes("90")).toBe(90);
    expect(parseMinutes("1h 30m")).toBe(90);
    expect(parseMinutes("1.5 hours")).toBe(90);
    expect(parseMinutes("0:45")).toBe(45);
    expect(parseMinutes("soon")).toBeNull();
  });
  it("matches people by email, full name or unambiguous first name", () => {
    expect(matchMember("SARAH@acme.co.uk", members)?.id).toBe("u-sarah");
    expect(matchMember("Tom Baker <tom.baker@acme.co.uk>", members)?.id).toBe("u-tom");
    expect(matchMember("sarah jones", members)?.id).toBe("u-sarah");
    expect(matchMember("Tom", members)?.id).toBe("u-tom");
    expect(matchMember("Jo", members)).toBeNull();
  });
  it("puts extra people on the task as collaborators", () => {
    const rows = analyseImport("Title,Assignee\nKick-off,\"Sarah Jones, Tom Baker\"", opts).rows;
    expect(rows[0]).toMatchObject({ assigneeId: "u-sarah", collaborators: ["u-tom"] });
  });
});

describe("parseImportDate", () => {
  const d = (s: string, o: "dmy" | "mdy" = "dmy") => parseImportDate(s, o, TODAY);
  it("reads ISO dates and zoned timestamps", () => {
    expect(d("2026-10-31")).toBe("2026-10-31");
    expect(d("2026/10/31")).toBe("2026-10-31");
    expect(d("2026-10-31 14:00")).toBe("2026-10-31");
    expect(d("20261031")).toBe("2026-10-31");
  });
  it("reads day-first UK dates, and month-first when asked or when only that reading works", () => {
    expect(d("31/10/2026")).toBe("2026-10-31");
    expect(d("3/4/26")).toBe("2026-04-03");
    expect(d("3/4/26", "mdy")).toBe("2026-03-04");
    expect(d("10/31/2026")).toBe("2026-10-31");
    expect(d("29.09.2026")).toBe("2026-09-29");
  });
  it("reads month names, weekdays and ordinals", () => {
    expect(d("31 Oct 2026")).toBe("2026-10-31");
    expect(d("Tue 31st October 2026")).toBe("2026-10-31");
    expect(d("Oct 31, 2026")).toBe("2026-10-31");
    expect(d("Oct 31")).toBe("2026-10-31");
    expect(d("5 Jan")).toBe("2027-01-05"); // the nearest 5 January to 30 Sep 2026
    expect(d("30/Sep/26 10:15 AM")).toBe("2026-09-30");
  });
  it("reads Excel serial numbers and relative words", () => {
    expect(d("46295")).toBe("2026-09-30");
    expect(d("46295.5")).toBe("2026-09-30");
    expect(d("tomorrow")).toBe("2026-10-01");
  });
  it("rejects impossible or unreadable dates", () => {
    expect(d("31/02/2026")).toBeNull();
    expect(d("13/13/2026")).toBeNull();
    expect(d("next sprint")).toBeNull();
    expect(d("12345")).toBeNull();
  });
  it("counts unreadable dates and detects ambiguous day/month order", () => {
    const a = analyseImport("Title,Due\nA,03/04/2026\nB,sometime\nC,31/31/2026", opts);
    expect(a.warnings.unreadableDates.count).toBe(2);
    expect(a.warnings.unreadableDates.examples).toEqual(["sometime", "31/31/2026"]);
    expect(a.ambiguousDates).toBe(true);
    expect(a.dateOrder).toBe("dmy");
    expect(a.rows[0].dueDate).toBe("2026-04-03");
    expect(analyseImport("Title,Due\nA,03/04/2026", { ...opts, dateOrder: "mdy" }).rows[0].dueDate).toBe("2026-03-04");
  });
  it("switches to month-first when the file can only be month-first", () => {
    const a = analyseImport("Title,Due\nA,03/04/2026\nB,12/25/2026", opts);
    expect(a.dateOrder).toBe("mdy");
    expect(a.rows[0].dueDate).toBe("2026-03-04");
  });
});

describe("limits and safety", () => {
  it("caps very long titles and keeps the full text in the description", () => {
    const long = "x".repeat(700);
    const r = analyseImport(`Title,Notes\n${long},note`, opts).rows[0];
    expect(r.title.length).toBe(500);
    expect(r.description?.startsWith(long)).toBe(true);
    expect(r.description?.endsWith("note")).toBe(true);
  });
  it("caps the number of rows and reports the total", () => {
    const text = Array.from({ length: IMPORT_LIMIT + 5 }, (_, i) => `Task ${i}`).join("\n");
    const a = analyseImport(text, opts);
    expect(a.rows).toHaveLength(IMPORT_LIMIT);
    expect(a.totalRows).toBe(IMPORT_LIMIT + 5);
    expect(a.truncated).toBe(true);
  });
  it("removes the export's formula guard on the way back in", () => {
    const r = analyseImport(`Title,Notes\n"'=SUM(A1)","'-5 degrees"`, opts).rows[0];
    expect(r.title).toBe("=SUM(A1)");
    expect(r.description).toBe("-5 degrees");
  });
  it("adds unmapped columns to the description only when asked", () => {
    const text = "Title,Budget,Owner team\nLaunch,£5k,Growth";
    expect(analyseImport(text, opts).rows[0].description).toBeUndefined();
    expect(analyseImport(text, { ...opts, extrasToDescription: true }).rows[0].description).toBe("Budget: £5k\nOwner team: Growth");
  });
  it("skips rows without a title and counts them", () => {
    const a = analyseImport("Title,Due\n,2026-10-01\nReal task,", opts);
    expect(a.rows).toHaveLength(1);
    expect(a.warnings.skippedNoTitle).toBe(1);
  });
  it("keeps the old parseImportText signature working", () => {
    const rows = parseImportText("Title,Status\nA,In progress\nB,review", projects, members, "p-ops");
    expect(rows).toEqual([
      { title: "A", status: "progress", projectId: "p-ops" },
      { title: "B", status: "review", projectId: "p-ops" },
    ]);
  });
});

describe("decodeImportBytes", () => {
  it("decodes UTF-8 (with or without BOM), UTF-16 and legacy Windows-1252", () => {
    expect(decodeImportBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0xc2, 0xa3, 0x35]))).toBe("£5");
    expect(decodeImportBytes(new Uint8Array([0xc2, 0xa3, 0x35]))).toBe("£5");
    expect(decodeImportBytes(new Uint8Array([0xff, 0xfe, 0xa3, 0x00, 0x35, 0x00]))).toBe("£5");
    expect(decodeImportBytes(new Uint8Array([0xa3, 0x35, 0x20, 0x63, 0x61, 0x66, 0xe9]))).toBe("£5 café");
  });
});

describe("export → import round trip", () => {
  const base: Task = {
    id: "t1", title: "=HYPERLINK(\"https://evil.example\",\"Open\")", description: "Line 1\nLine 2, with £ and café",
    status: "review", priority: "high", projectId: "p-web", assigneeId: "u-sarah", tags: ["design", "tag-123"],
    dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, dueDate: "2026-10-31", startDate: "2026-10-01",
    sectionId: "s-build",
  };
  const child: Task = { ...base, id: "t2", title: "-Call supplier", description: "", status: "done", completedAt: "2026-09-28", parentId: "t1", tags: [], sectionId: undefined, assigneeId: "u-tom" };
  it("brings status, people, dates, section, tags and sub-tasks back", () => {
    const csv = buildTasksCsv([base, child], { sections, members });
    const a = analyseImport(csv, { ...opts, csv: true });
    expect(a.rows).toHaveLength(2);
    expect(a.rows[0]).toMatchObject({
      title: base.title, description: base.description, status: "review", priority: "high", assigneeId: "u-sarah",
      dueDate: "2026-10-31", startDate: "2026-10-01", sectionId: "s-build", tags: ["design", "tag-123"],
    });
    expect(a.rows[1]).toMatchObject({ title: "-Call supplier", status: "done", completedAt: "2026-09-28", assigneeId: "u-tom", parentIndex: 0 });
    expect(a.ignoredColumns).toEqual([]);
    expect(a.warnings.unreadableDates.count).toBe(0);
  });
});

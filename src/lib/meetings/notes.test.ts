/* lib/meetings/notes: the notes doc a meeting leaves (the Meeting notes template, filled in), and the lines
   Extract tasks reads (owners and days come through to its review), and which item each new task belongs to. */
import { describe, expect, it } from "vitest";
import { blocksToMarkdown } from "../docBlocks";
import { extractTasks } from "../extractHeuristic";
import { actionTail, extractLine, extractText, linkCreated, makeTaskText, meetingDoc } from "./notes";
import type { AgendaItem, MeetingItem } from "./types";

const names: Record<string, string> = { u1: "Maya Lin", u2: "Theo Vance" };
const nameOf = (id: string) => names[id];
const item = (o: Partial<MeetingItem> & { id: string; kind: MeetingItem["kind"]; body: string }): MeetingItem => ({
  meetingId: "m", agendaKey: null, ownerId: null, due: null, taskId: null, createdBy: "u1", createdAt: "2026-11-10T10:00:00Z", ...o,
});
const AGENDA: AgendaItem[] = [
  { key: "overview", kind: "overview", title: "Where things stand", lede: [] },
  { key: "person:u1", kind: "person", title: "Maya Lin", personId: "u1", done: [], today: [], blocked: [], more: { done: 0, today: 0, blocked: 0 } },
  { key: "risks", kind: "risks", title: "Radar risks", risks: [] },
  { key: "wrap", kind: "wrap", title: "Wrap up" },
];
const ITEMS = [
  item({ id: "d1", kind: "decision", body: "Launch stays on the 18th", agendaKey: "risks" }),
  item({ id: "n1", kind: "note", body: "Theo's back Monday", agendaKey: "person:u1" }),
  item({ id: "a1", kind: "action", body: "Book the deck review", ownerId: "u1", due: "2026-11-13", agendaKey: "risks" }),
  item({ id: "a2", kind: "action", body: "Chase legal", ownerId: "u2", taskId: "t-9" }),
];

describe("the notes doc", () => {
  it("is the Meeting notes template, filled in: date, who came, the agenda, notes, decisions and actions", () => {
    const doc = meetingDoc({ title: "Foundrise team meeting, Tue 10 Nov", agenda: AGENDA }, ITEMS,
      { nameOf, attendees: ["Daniel Okai", "Maya Lin", "Theo Vance"], day: "2026-11-10", projectName: "Q3 Launch" });
    expect(doc.title).toBe("Foundrise team meeting, Tue 10 Nov");
    expect(doc.icon).toBe("🗒️");
    const md = blocksToMarkdown(doc.title, doc.body);
    expect(md).toContain("**Date:** 10 November 2026");
    expect(md).toContain("**Attendees:** Daniel Okai, Maya Lin and Theo Vance");
    expect(md).toMatch(/## Agenda\n\n1\. Where things stand\n2\. Maya Lin\n3\. Radar risks\n/);
    expect(md).toContain("- **Maya Lin:** Theo's back Monday");
    expect(md).toContain("- **Radar risks:** Launch stays on the 18th");
    expect(md).toContain("Book the deck review *(Maya · by 13 Nov)*");
    // an action that's a task links to it (the doc shows its live status)
    expect(doc.body.find((b) => b.taskId === "t-9")?.type).toBe("todo");
    expect(doc.body.filter((b) => b.type === "todo")).toHaveLength(2);
    // the template's tip stays; nobody is @mentioned (they have the task and the recap)
    expect(doc.body.some((b) => b.type === "callout")).toBe(true);
    expect(doc.body.some((b) => (b.spans ?? []).some((s) => s.mention))).toBe(false);
    expect(new Set(doc.body.map((b) => b.id)).size).toBe(doc.body.length);
  });
  it("keeps an empty line to write in under a heading with nothing yet", () => {
    const doc = meetingDoc({ title: "T", agenda: AGENDA }, [], { nameOf, attendees: [], day: "2026-11-10", projectName: "P" });
    const at = (h: string) => doc.body.findIndex((b) => b.type === "h2" && b.spans?.[0]?.text === h);
    for (const [h, type] of [["Notes", "bullet"], ["Decisions", "bullet"], ["Actions", "todo"]] as const) {
      expect(doc.body[at(h) + 1]).toMatchObject({ type, spans: [] });
    }
    expect(blocksToMarkdown(doc.title, doc.body)).not.toContain("Who does what");
  });
});

describe("lines for Extract tasks", () => {
  it("an action reads as '{Owner} to … by {day}', so the review has both", () => {
    expect(extractLine(ITEMS[2], nameOf)).toBe("Maya to book the deck review by 13 Nov");
    expect(extractLine(item({ id: "x", kind: "note", body: "Ship it." }), nameOf)).toBe("Ship it");
    expect(actionTail(ITEMS[2], nameOf)).toBe("Maya · by 13 Nov");
  });
  it("the actions that aren't tasks yet go under Actions; decisions and notes under their own headings", () => {
    const text = extractText(ITEMS, nameOf);
    expect(text).toBe("Actions\n- Maya to book the deck review by 13 Nov\n\nDecisions\n- Launch stays on the 18th\n\nNotes\n- Theo's back Monday");
    // on the device, only the actions come out (with their owner and day)
    const found = extractTasks(text, { members: [{ id: "u1", name: "Maya Lin" }, { id: "u2", name: "Theo Vance" }], today: new Date(2026, 10, 10), me: "u0" });
    expect(found).toEqual([expect.objectContaining({ title: expect.stringMatching(/^Book the deck review/i), assigneeId: "u1", dueDate: "2026-11-13" })]);
    expect(makeTaskText(ITEMS[0], nameOf)).toBe("Actions\n- Launch stays on the 18th");
  });
  it("each task Extract made goes back to the open action it came from, or becomes a new one", () => {
    const got = linkCreated([{ id: "t1", title: "Book the deck review" }, { id: "t2", title: "Order lunch" }, { id: "t3", title: "Chase legal" }], ITEMS);
    expect(got).toEqual([{ taskId: "t1", itemId: "a1" }, { taskId: "t2", itemId: null }, { taskId: "t3", itemId: null }]);   // a2 is already a task
  });
});

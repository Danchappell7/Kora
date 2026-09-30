import { describe, it, expect } from "vitest";
import { extractTasks } from "./extractHeuristic";

// Wednesday 30 September 2026
const today = new Date(2026, 8, 30);
const members = [
  { id: "m-self", name: "Daniel Okai" },
  { id: "m-1", name: "Maya Lin" },
  { id: "m-2", name: "Theo Vance" },
  { id: "m-3", name: "Sana Rao" },
];
const run = (text: string) => extractTasks(text, { members, today, me: "m-self" });
const one = (text: string) => { const r = run(text); expect(r).toHaveLength(1); return r[0]; };

describe("extractTasks", () => {
  it("reads “{Name} to …” with the date in the line", () => {
    expect(one("Sana to send the brief by Fri")).toMatchObject({
      title: "Send the brief", assigneeId: "m-3", assigneeName: "Sana", dueDate: "2026-10-02", confidence: 0.8,
    });
  });

  it.each([
    ["- [ ] Book the venue", { title: "Book the venue", confidence: 0.9 }],
    ["[ ] Order lunch", { title: "Order lunch", confidence: 0.9 }],
    ["* [ ] print badges tomorrow", { title: "Print badges", dueDate: "2026-10-01" }],
    ["TODO: update the FAQ", { title: "Update the FAQ", confidence: 0.9 }],
    ["To do - ring the printers", { title: "Ring the printers" }],
    ["Action: Maya to update the roadmap tomorrow", { title: "Update the roadmap", assigneeId: "m-1", dueDate: "2026-10-01" }],
    ["Action item: Theo will chase legal", { title: "Chase legal", assigneeId: "m-2" }],
    ["AP: Theo – book the room for Thursday", { title: "Book the room", assigneeId: "m-2", dueDate: "2026-10-01" }],
    ["Next step: share the deck with leadership", { title: "Share the deck with leadership" }],
    ["Follow-up: send the notes", { title: "Send the notes" }],
    ["Theo will chase legal", { title: "Chase legal", assigneeId: "m-2" }],
    ["Maya Lin to review the pricing copy", { title: "Review the pricing copy", assigneeId: "m-1" }],
    ["Theo'll draft the agenda", { title: "Draft the agenda", assigneeId: "m-2" }],
    ["@sana draft the FAQ", { title: "Draft the FAQ", assigneeId: "m-3" }],
    ["@maya to sign off the budget", { title: "Sign off the budget", assigneeId: "m-1" }],
    ["I'll send the recap tonight", { title: "Send the recap", assigneeId: "m-self", dueDate: "2026-09-30" }],
    ["I will book the train 3/10", { title: "Book the train", assigneeId: "m-self", dueDate: "2026-10-03" }],
    ["Sana to call the supplier fri 3pm", { title: "Call the supplier", assigneeId: "m-3", dueDate: "2026-10-02", dueTime: "15:00" }],
    ["- [ ] Fix the login urgent", { title: "Fix the login", priority: "urgent" }],
    ["TODO: renew the domain asap", { title: "Renew the domain", priority: "high" }],
    ["TODO: patch the server !!!", { title: "Patch the server", priority: "urgent" }],
    ["TODO: book the venue (Theo)", { title: "Book the venue", assigneeId: "m-2" }],
    ["TODO: print the menus - Sana", { title: "Print the menus", assigneeId: "m-3" }],
  ])("%s", (text, expected) => {
    expect(one(text)).toMatchObject(expected);
  });

  it("keeps a name it can't match, for the review sheet to flag", () => {
    const t = one("Priya to book the room");
    expect(t).toMatchObject({ title: "Book the room", assigneeName: "Priya" });
    expect(t.assigneeId).toBeUndefined();
  });

  it("leaves prose, decisions and finished items alone", () => {
    expect(run([
      "We will ship on Monday",
      "Pricing will change next quarter",
      "Budget is approved",
      "- [x] Sent the invites",
      "Welcome to the team",
      "Decided to keep the name",
    ].join("\n"))).toEqual([]);
  });

  it("takes every line under an Actions or Next steps heading, and stops at the next heading", () => {
    const notes = [
      "# Design review",
      "Attendees: Sana, Theo",
      "",
      "Next steps:",
      "- Draft the press release",
      "- Sana to review FAQ copy !high",
      "  Priya will chase the printers",
      "",
      "Notes:",
      "- Budget is approved",
      "",
      "**Actions**",
      "1. Share the deck with the board",
    ].join("\n");
    const r = run(notes);
    expect(r.map((t) => t.title)).toEqual(["Draft the press release", "Review FAQ copy", "Chase the printers", "Share the deck with the board"]);
    expect(r[1]).toMatchObject({ assigneeId: "m-3", priority: "high" });
    expect(r[2]).toMatchObject({ assigneeName: "Priya", confidence: 0.8 });
    expect(r[0].confidence).toBe(0.6);
  });

  it("reads an “Actions from Monday:” heading", () => {
    expect(run("Actions from Monday:\nOrder the lanyards").map((t) => t.title)).toEqual(["Order the lanyards"]);
  });

  it("drops duplicates, trims titles to 200 characters and keeps the source line", () => {
    const long = "TODO: " + "write ".repeat(60);
    const r = run(`TODO: Book venue\n- [ ] book venue\n${long}`);
    expect(r.map((t) => t.title.slice(0, 10))).toEqual(["Book venue", "Write writ"]);
    expect(r[1].title.length).toBeLessThanOrEqual(200);
    expect(r[0].note).toBe("TODO: Book venue");
  });

  it("finds nothing in an empty paste", () => {
    expect(run("")).toEqual([]);
    expect(run("\n\n  \n")).toEqual([]);
  });
});

/* One grammar, two doors: the app's src/lib/nlp.ts and the Slack app's
   supabase/functions/_shared/nlp.ts must read every sentence identically.
   The grammar lives only in the shared file (the app re-exports it with its
   live "today"), so /kanbo in Slack can never drift from Quick capture. */
import { describe, it, expect } from "vitest";
import * as app from "./nlp";
import * as shared from "../../supabase/functions/_shared/nlp.ts";
import { KANBO_TODAY } from "../data/data";

const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string };
const { cwd } = (globalThis as unknown as { process: { cwd(): string } }).process;

const TODAY = new Date(2026, 9, 20);
const PROJECTS = [{ id: "p1", name: "Q3 Product Launch" }, { id: "p2", name: "Ops" }, { id: "p3", name: "Website refresh" }];
const MEMBERS = [{ id: "u1", name: "Sana Rao" }, { id: "u2", name: "Theo Hart" }, { id: "u3", name: "Sam Okafor" }];
const TAGS = { design: { label: "Design" }, eng: { label: "Engineering" } };
const CORPUS = [
  "call Sana fri 3pm ~30m #launch",
  "Send the brief tomorrow at 9.30 @theo !high",
  "Book venue next week p1 #ops",
  "Draft update by 3 Nov from mon",
  "Pay rent monthly",
  "Water plants every other tue",
  "Deep work on the pricing model 90m",
  "Review +design +eng eod",
  "Monday standup notes",
  "24/7 on-call rota",
  "Meet at 10 Downing Street",
  "Look at 3 vendor quotes",
  "Weekend sales report sat",
  "Fix bug #123 asap",
  "in 2 weeks ship v2 !!",
  "end of month invoices est 1h30",
  "3/10 9am dentist",
  "",
  "   ",
];

describe("the grammar has one home", () => {
  it("the app's parseTask is the shared one with the app's 'today'", () => {
    for (const text of CORPUS) {
      const ctx = { today: TODAY, projects: PROJECTS, members: MEMBERS, tags: TAGS };
      expect(app.parseTask(text, ctx)).toEqual(shared.parseTask(text, ctx));
      expect(app.parseTask(text, { ...ctx, kinds: ["date", "time"] })).toEqual(shared.parseTask(text, { ...ctx, kinds: ["date", "time"] }));
      expect(app.parseTask(text, { ...ctx, priorityWords: true, nextWeek: "+7" })).toEqual(shared.parseTask(text, { ...ctx, priorityWords: true, nextWeek: "+7" }));
    }
  });
  it("without a day given, the app counts from KANBO_TODAY", () => {
    expect(app.parseTask("ship it tomorrow").dueDate).toBe(shared.parseTask("ship it tomorrow", { today: KANBO_TODAY }).dueDate);
    expect(app.parseDateText("fri")).toEqual(shared.parseDateText("fri", KANBO_TODAY));
    expect(app.dayLabel("2026-10-23")).toBe(shared.dayLabel("2026-10-23", KANBO_TODAY));
  });
  it("the helpers are the same functions", () => {
    expect(app.matchProject).toBe(shared.matchProject);
    expect(app.matchMember).toBe(shared.matchMember);
    expect(app.segments).toBe(shared.segments);
    expect(app.stripTokens).toBe(shared.stripTokens);
    expect(app.splitLines).toBe(shared.splitLines);
    expect(app.tidyTitle).toBe(shared.tidyTitle);
    expect(app.fmtMinutes).toBe(shared.fmtMinutes);
  });
  it("the shared file is pure (no imports) and the app's file keeps no copy of the rules", () => {
    const sharedSrc = readFileSync(`${cwd()}/supabase/functions/_shared/nlp.ts`, "utf8");
    const appSrc = readFileSync(`${cwd()}/src/lib/nlp.ts`, "utf8");
    expect(sharedSrc).not.toMatch(/^\s*import\s/m);
    expect(sharedSrc).not.toMatch(/\bDeno\./);
    for (const rule of ["DATE_RE", "TIME_RE", "REPEAT_RE", "PROJECT_RE", "PERSON_RE", "class Scan"]) expect(appSrc).not.toContain(rule);
  });
});

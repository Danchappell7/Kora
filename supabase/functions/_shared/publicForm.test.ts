// @vitest-environment node
// The rules the public-form function and the /f/<token> page share.
import { describe, expect, it } from "vitest";
import {
  buildPublicSchema, charLength, checkSubmission, cleanLine, cleanText, FIELD_MESSAGES, isEmailShape, isHoneypotHit,
  isIsoDay, isPublicToken, parsePublicSchema, PUBLIC_LIMITS, publicFieldsOf, requestDescription, requestLine,
  safeColour, safeLogoUrl, taskReference,
} from "./publicForm.ts";

const ALL = ["description", "priority", "dueDate"] as const;
const base = { title: "New hero banner", name: "Sam Jones", email: "sam@example.co.uk" };

describe("tokens and fields", () => {
  it("accepts the token shape 0043 allows, nothing else", () => {
    expect(isPublicToken("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isPublicToken("A".repeat(24))).toBe(true);
    for (const t of ["demo", "a".repeat(23), "a".repeat(129), "0123456789abcdef0123456789abcde/", "x' or 1=1 --aaaaaaaaaaaaa", null, 42]) {
      expect(isPublicToken(t)).toBe(false);
    }
  });
  it("keeps only the public fields, in page order, never the assignee", () => {
    expect(publicFieldsOf(["assignee", "dueDate", "description", "dueDate", "nonsense"])).toEqual(["description", "dueDate"]);
    expect(publicFieldsOf(null)).toEqual([]);
    expect(publicFieldsOf("description")).toEqual([]);
  });
});

describe("cleaning text", () => {
  it("one line: controls and invisible characters out, spaces collapsed", () => {
    expect(cleanLine("  Sam\u0000 ‮Jones​\n\tthe second ")).toBe("Sam Jones the second");
    expect(cleanLine(42)).toBe("");
  });
  it("multi-line: newlines kept, CRLF tidied, long blank runs shortened", () => {
    expect(cleanText("Line one  \r\nLine two\u0007\n\n\n\n\n\nEnd‮")).toBe("Line one\nLine two\n\n\nEnd");
  });
  it("counts characters as people do", () => {
    expect(charLength("👋🏽 hi")).toBe(5);
  });
});

describe("email, dates", () => {
  it("email shapes", () => {
    for (const ok of ["sam@example.com", "sam.o'neil+req@sub.example.co.uk", "a@b.io", "zoë@exämple.de", "x@example.xn--p1ai"]) expect(isEmailShape(ok)).toBe(true);
    for (const bad of ["", "sam", "sam@", "@example.com", "sam@example", "sam@@example.com", "sam @example.com", "sam@exa mple.com",
      "<sam@example.com>", "sam@example.c", ".sam@example.com", "sam..x@example.com", "sam@-example.com", "a".repeat(250) + "@example.com"]) {
      expect(isEmailShape(bad)).toBe(false);
    }
  });
  it("real calendar days only", () => {
    expect(isIsoDay("2026-10-05")).toBe(true);
    expect(isIsoDay("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-29", "2026-13-01", "2026-00-10", "2026-1-5", "05/10/2026", "1999-12-31", "2101-01-01", "2026-10-05T00:00"]) expect(isIsoDay(bad)).toBe(false);
  });
});

describe("checkSubmission", () => {
  it("passes a good submission through, tidied", () => {
    const r = checkSubmission(ALL, { title: "  New   hero banner ", name: " Sam  Jones ", email: " Sam@Example.CO.UK ", description: "Bigger.\r\nBolder. ", priority: "high", dueDate: "2026-10-20" });
    expect(r).toEqual({ ok: true, errors: {}, value: { title: "New hero banner", name: "Sam Jones", email: "sam@example.co.uk", description: "Bigger.\nBolder.", priority: "high", dueDate: "2026-10-20" } });
  });
  it("title, name and email are always asked for", () => {
    const r = checkSubmission([], { title: " ", name: "", email: "nope" });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual({ title: FIELD_MESSAGES.titleMissing, name: FIELD_MESSAGES.nameMissing, email: FIELD_MESSAGES.emailInvalid });
    expect(checkSubmission([], {}).errors).toEqual({ title: FIELD_MESSAGES.titleMissing, name: FIELD_MESSAGES.nameMissing, email: FIELD_MESSAGES.emailMissing });
  });
  it("caps every field (in characters, not UTF-16 units)", () => {
    const r = checkSubmission(ALL, { ...base, title: "x".repeat(PUBLIC_LIMITS.title + 1), name: "n".repeat(PUBLIC_LIMITS.name + 1), description: "d".repeat(PUBLIC_LIMITS.description + 1) });
    expect(Object.keys(r.errors).sort()).toEqual(["description", "name", "title"]);
    expect(checkSubmission(ALL, { ...base, title: "👋".repeat(PUBLIC_LIMITS.title) }).ok).toBe(true);
  });
  it("drops fields the form doesn't ask for, and every key it doesn't know", () => {
    const r = checkSubmission(["description"], { ...base, description: "Please", priority: "urgent", dueDate: "2026-10-20", assigneeId: "u-1", status: "done", user_id: "x" });
    expect(r).toEqual({ ok: true, errors: {}, value: { ...base, description: "Please" } });
  });
  it("refuses a priority or date it doesn't recognise; blanks are fine", () => {
    expect(checkSubmission(ALL, { ...base, priority: "critical" }).errors).toEqual({ priority: FIELD_MESSAGES.priorityInvalid });
    expect(checkSubmission(ALL, { ...base, dueDate: "next week" }).errors).toEqual({ dueDate: FIELD_MESSAGES.dueInvalid });
    expect(checkSubmission(ALL, { ...base, priority: "", dueDate: " ", description: "  " })).toEqual({ ok: true, errors: {}, value: base });
  });
  it("refuses a past date only when told what today is (the page's check)", () => {
    expect(checkSubmission(ALL, { ...base, dueDate: "2026-10-04" }, { today: "2026-10-05" }).errors).toEqual({ dueDate: FIELD_MESSAGES.duePast });
    expect(checkSubmission(ALL, { ...base, dueDate: "2026-10-05" }, { today: "2026-10-05" }).ok).toBe(true);
    expect(checkSubmission(ALL, { ...base, dueDate: "2026-10-04" }).ok).toBe(true);
  });
  it("refuses values that aren't strings", () => {
    const r = checkSubmission(ALL, { title: ["a"], name: { first: "Sam" }, email: 5, description: true, priority: 3, dueDate: {} });
    expect(r.errors).toEqual({ title: FIELD_MESSAGES.wrongType, name: FIELD_MESSAGES.wrongType, email: FIELD_MESSAGES.wrongType, description: FIELD_MESSAGES.wrongType, priority: FIELD_MESSAGES.wrongType, dueDate: FIELD_MESSAGES.wrongType });
    expect(checkSubmission(ALL, null).ok).toBe(false);
    expect(checkSubmission(ALL, [base]).ok).toBe(false);
  });
});

describe("the task it files", () => {
  it("a description the Inbox recognises as a request", () => {
    expect(requestLine("Design requests.")).toBe("Request via Design requests (public link)");
    expect(requestDescription("Design requests", { name: "Sam Jones", email: "sam@example.com", description: "Bigger banner.\nThanks" }))
      .toBe("Request via Design requests (public link).\n\nFrom: Sam Jones <sam@example.com>\n\nBigger banner.\nThanks");
    expect(requestDescription("Design requests", { name: "Sam", email: "sam@example.com" }))
      .toBe("Request via Design requests (public link).\n\nFrom: Sam <sam@example.com>");
  });
  it("a short reference from the task id", () => {
    expect(taskReference("7f3a9c12-0000-4000-8000-000000000000")).toBe("KB-7F3A9C");
    expect(taskReference("ab")).toBe("KB-AB0000");
  });
  it("the honeypot", () => {
    expect(isHoneypotHit({ website: "http://spam.example" })).toBe(true);
    expect(isHoneypotHit({ website: 1 })).toBe(true);
    for (const v of [{}, { website: "" }, { website: "   " }, { website: null }, null, "x"]) expect(isHoneypotHit(v)).toBe(false);
  });
});

describe("the public schema", () => {
  it("only what the page shows, capped and made safe", () => {
    const s = buildPublicSchema({
      form: { name: " Design requests ", description: "Tell us what you need.\r\n", fields: ["assignee", "priority", "description"] },
      project: { name: "Website refresh", emoji: "🎨", color: "oklch(0.62 0.16 293)" },
      workspace: { name: "Foundrise", logo_url: "https://abc.supabase.co/storage/v1/object/public/avatars/u/logo.png" },
    });
    expect(s).toEqual({
      name: "Design requests", intro: "Tell us what you need.",
      project: { name: "Website refresh", emoji: "🎨", color: "oklch(0.62 0.16 293)" },
      workspace: { name: "Foundrise", logoUrl: "https://abc.supabase.co/storage/v1/object/public/avatars/u/logo.png" },
      fields: ["description", "priority"],
    });
    const odd = buildPublicSchema({
      form: { name: "", description: null, fields: null },
      project: { name: "", emoji: null, color: "red; background:url(x)" },
      workspace: { name: "Team", logo_url: "javascript:alert(1)" },
    });
    expect(odd).toEqual({ name: "Request form", project: { name: "Untitled project", emoji: "", color: "oklch(0.62 0.16 270)" }, workspace: { name: "Team", logoUrl: null }, fields: [] });
    expect(buildPublicSchema({ form: { name: "x".repeat(400), fields: [] }, project: { name: "p" }, workspace: null }).name).toHaveLength(200);
  });
  it("logos: https only, no credentials", () => {
    expect(safeLogoUrl("http://example.com/a.png")).toBeNull();
    expect(safeLogoUrl("https://user:pw@example.com/a.png")).toBeNull();
    expect(safeLogoUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(safeLogoUrl("https://example.com/a.png")).toBe("https://example.com/a.png");
  });
  it("colours: CSS colour functions and hex only", () => {
    expect(safeColour("#5B7CFA")).toBe("#5B7CFA");
    expect(safeColour("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(safeColour("expression(alert(1))")).toBe("oklch(0.62 0.16 270)");
  });
  it("reads what came over the wire, or nothing", () => {
    const wire = { name: "Design requests", intro: "Hi", project: { name: "Web", emoji: "🎨", color: "#123456" }, workspace: { name: "Foundrise", logoUrl: null }, fields: ["description", "assignee"], secret: "x" };
    expect(parsePublicSchema(wire)).toEqual({ name: "Design requests", intro: "Hi", project: { name: "Web", emoji: "🎨", color: "#123456" }, workspace: { name: "Foundrise", logoUrl: null }, fields: ["description"] });
    for (const junk of [null, "x", { name: 1 }, { name: "a" }, { name: "a", project: "p" }]) expect(parsePublicSchema(junk)).toBeNull();
  });
});

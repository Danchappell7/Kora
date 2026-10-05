// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkCommentCreate, checkProjectCreate, checkProjectPatch, checkSectionCreate, checkTaskCreate, checkTaskPatch,
  cleanText, decodeCursor, encodeCursor, escapeLike, isRealDate, isTime, oneLine, parseBool, parseLimit,
  parseProjectQuery, parseTaskQuery, parseTimestamp, queryFingerprint, unknownParams,
} from "./validate.ts";

const U = "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9";
const sp = (s: string) => new URLSearchParams(s);
const fieldsOf = (r: { ok: boolean; fields?: Record<string, string> }) => (r.ok ? {} : r.fields ?? {});

describe("text", () => {
  it("cleans multi-line text: CRLF, control characters, NUL", () => {
    expect(cleanText("  a\r\nb\rc\u0000d\u0007 ")).toBe("a\nb\ncd");
    expect(cleanText("tab\there")).toBe("tab\there");
  });
  it("one-line text collapses whitespace", () => {
    expect(oneLine("  Website\n  refresh\t2 ")).toBe("Website refresh 2");
  });
  it("escapes LIKE wildcards", () => {
    expect(escapeLike("100%_done\\")).toBe("100\\%\\_done\\\\");
  });
});

describe("dates and times", () => {
  it("real calendar dates only", () => {
    expect(isRealDate("2026-02-28")).toBe(true);
    expect(isRealDate("2028-02-29")).toBe(true);
    expect(isRealDate("2026-02-29")).toBe(false);
    expect(isRealDate("2026-13-01")).toBe(false);
    expect(isRealDate("2026-1-1")).toBe(false);
    expect(isRealDate("1800-01-01")).toBe(false);
    expect(isRealDate(20260101)).toBe(false);
  });
  it("24-hour times", () => {
    expect(isTime("09:30")).toBe(true);
    expect(isTime("23:59")).toBe(true);
    expect(isTime("24:00")).toBe(false);
    expect(isTime("9:30")).toBe(false);
  });
  it("timestamps need a zone (or are a bare date)", () => {
    expect(parseTimestamp("2026-10-05T09:30:00Z")).toBe("2026-10-05T09:30:00.000Z");
    expect(parseTimestamp("2026-10-05T10:30:00.123456+01:00")).toBe("2026-10-05T09:30:00.123Z");
    expect(parseTimestamp("2026-10-05T10:30+0100")).toBe("2026-10-05T09:30:00.000Z");
    expect(parseTimestamp("2026-10-05")).toBe("2026-10-05T00:00:00.000Z");
    expect(parseTimestamp("2026-10-05T09:30:00")).toBeNull();
    expect(parseTimestamp("yesterday")).toBeNull();
    expect(parseTimestamp("2026-02-30T00:00:00Z")).toBeNull();
    expect(parseTimestamp("2026-10-05T25:00:00Z")).toBeNull();
  });
});

describe("query strings", () => {
  it("booleans, limits, unknown parameters", () => {
    expect(parseBool(null)).toBe(false);
    expect(parseBool("TRUE")).toBe(true);
    expect(parseBool("0")).toBe(false);
    expect(parseBool("maybe")).toBeNull();
    expect(parseLimit(null)).toBe(50);
    expect(parseLimit("100")).toBe(100);
    expect(parseLimit("101")).toBeNull();
    expect(parseLimit("0")).toBeNull();
    expect(parseLimit("1.5")).toBeNull();
    expect(unknownParams(sp("a=1&limit=2&a=3"), ["limit"])).toEqual(["a"]);
  });
  it("task filters", () => {
    const r = parseTaskQuery(sp(`workspace=PERSONAL&assignee=me&status=todo,done&status=review&due_before=2026-10-31&due_after=2026-10-01&updated_since=2026-10-05T09:00:00Z&include_archived=1&q=%20launch%20%20post&limit=10&parent=none&project=personal`));
    expect(r).toEqual({
      ok: true,
      value: {
        workspace: "personal", assignee: "me", status: ["todo", "done", "review"], dueBefore: "2026-10-31", dueAfter: "2026-10-01",
        updatedSince: "2026-10-05T09:00:00.000Z", includeArchived: true, q: "launch post", limit: 10, parent: "none", project: "p-personal",
      },
    });
    expect(parseTaskQuery(sp(`workspace=${U.toUpperCase()}`))).toMatchObject({ ok: true, value: { workspace: U } });
  });
  it("names every bad filter", () => {
    const f = fieldsOf(parseTaskQuery(sp("workspace=team&status=finished&due_before=31/10/2026&updated_since=today&limit=500&foo=1&assignee=bob&q=" + "x".repeat(201) + "&workspace=x")));
    expect(Object.keys(f).sort()).toEqual(["assignee", "due_before", "foo", "limit", "q", "status", "updated_since", "workspace"]);
    expect(fieldsOf(parseTaskQuery(sp("due_after=2026-11-01&due_before=2026-10-01")))).toHaveProperty("due_after");
  });
  it("project filters", () => {
    expect(parseProjectQuery(sp("workspace=personal&include_archived=true"))).toEqual({ ok: true, value: { workspace: "personal", includeArchived: true, limit: 50 } });
    expect(fieldsOf(parseProjectQuery(sp("status=on_track")))).toHaveProperty("status");
  });
});

describe("task bodies", () => {
  it("a full create is cleaned", () => {
    const r = checkTaskCreate({
      title: "  Write\nthe post ", description: "a\r\nb", status: "progress", priority: "urgent", projectId: U.toUpperCase(),
      sectionId: U, assigneeId: "ME", dueDate: "2026-10-31", dueTime: "17:00", startDate: "2026-10-01",
      tags: ["design", " Launch ", "launch"], effortHours: 1.234,
    });
    expect(r).toEqual({
      ok: true,
      value: {
        title: "Write the post", description: "a\nb", status: "progress", priority: "urgent", projectId: U, sectionId: U,
        assigneeId: "me", dueDate: "2026-10-31", dueTime: "17:00", startDate: "2026-10-01", tags: ["design", "Launch"], effortHours: 1.23,
      },
    });
  });
  it("the Personal list and nulls", () => {
    expect(checkTaskCreate({ title: "x", projectId: null, workspaceId: "personal", assigneeId: null, tags: null })).toEqual({
      ok: true, value: { title: "x", projectId: null, workspaceId: null, assigneeId: null, tags: [] },
    });
    expect(checkTaskCreate({ title: "x", projectId: "p-personal" })).toMatchObject({ ok: true, value: { projectId: null } });
  });
  it("needs a title; refuses unknown, read-only and snake_case fields with a hint", () => {
    expect(fieldsOf(checkTaskCreate({}))).toHaveProperty("title");
    const f = fieldsOf(checkTaskCreate({ title: "x", due_date: "2026-01-01", updatedAt: "x", id: U, createdBy: U }));
    expect(f.due_date).toMatch(/dueDate/);
    expect(Object.keys(f).sort()).toEqual(["createdBy", "due_date", "id", "updatedAt"]);
  });
  it("types, enums, ranges, caps", () => {
    const f = fieldsOf(checkTaskCreate({
      title: 5, description: "x".repeat(20_001), status: "finished", priority: "p1", projectId: "launch", sectionId: "s1",
      parentId: 3, assigneeId: "bob", dueDate: "2026-02-30", dueTime: "5pm", startDate: "soon", tags: "a,b", effortHours: -1,
    }));
    expect(Object.keys(f).sort()).toEqual(["assigneeId", "description", "dueDate", "dueTime", "effortHours", "parentId", "priority",
      "projectId", "sectionId", "startDate", "status", "tags", "title"]);
    expect(fieldsOf(checkTaskCreate({ title: "x".repeat(501) }))).toHaveProperty("title");
    expect(fieldsOf(checkTaskCreate({ title: "x", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }))).toHaveProperty("tags");
    expect(fieldsOf(checkTaskCreate({ title: "x", tags: ["x".repeat(41)] }))).toHaveProperty("tags");
    expect(fieldsOf(checkTaskCreate({ title: "x", effortHours: 10_001 }))).toHaveProperty("effortHours");
    expect(fieldsOf(checkTaskCreate({ title: "x", effortHours: "2" }))).toHaveProperty("effortHours");
  });
  it("cross-field rules", () => {
    expect(fieldsOf(checkTaskCreate({ title: "x", dueTime: "09:00" }))).toHaveProperty("dueTime");
    expect(fieldsOf(checkTaskCreate({ title: "x", startDate: "2026-11-01", dueDate: "2026-10-01" }))).toHaveProperty("startDate");
  });
  it("patches: at least one field, no workspaceId / parentId, title can't be null", () => {
    expect(fieldsOf(checkTaskPatch({}))).toHaveProperty("_");
    expect(Object.keys(fieldsOf(checkTaskPatch({ workspaceId: U, parentId: U })))).toEqual(["workspaceId", "parentId"]);
    expect(fieldsOf(checkTaskPatch({ title: null }))).toHaveProperty("title");
    expect(checkTaskPatch({ archived: false, dueDate: null, assigneeId: null })).toEqual({ ok: true, value: { archived: false, dueDate: null, assigneeId: null } });
    expect(fieldsOf(checkTaskPatch({ archived: "yes" }))).toHaveProperty("archived");
  });
});

describe("project, section and comment bodies", () => {
  it("projects", () => {
    expect(checkProjectCreate({ name: " Launch ", workspaceId: U, emoji: "🚀", color: "oklch(0.74 0.14 230)", status: "on_track" })).toEqual({
      ok: true, value: { name: "Launch", workspaceId: U, emoji: "🚀", color: "oklch(0.74 0.14 230)", status: "on_track" },
    });
    const f = fieldsOf(checkProjectCreate({ emoji: "not one emoji at all", color: "red;}", status: "done", owner_id: U }));
    expect(Object.keys(f).sort()).toEqual(["color", "emoji", "name", "owner_id", "status"]);
    expect(checkProjectPatch({ archived: true, status: null, description: "" })).toEqual({ ok: true, value: { archived: true, status: null, description: null } });
    expect(fieldsOf(checkProjectPatch({ workspaceId: U }))).toHaveProperty("workspaceId");
    expect(fieldsOf(checkProjectPatch({ name: null }))).toHaveProperty("name");
  });
  it("sections", () => {
    expect(checkSectionCreate({ projectId: U, name: " Doing " })).toEqual({ ok: true, value: { projectId: U, name: "Doing" } });
    expect(Object.keys(fieldsOf(checkSectionCreate({})))).toEqual(["projectId", "name"]);
    expect(fieldsOf(checkSectionCreate({ projectId: "p-personal", name: "x" }))).toHaveProperty("projectId");
  });
  it("comments", () => {
    expect(checkCommentCreate({ body: "  Hi\r\nthere " })).toEqual({ ok: true, value: { body: "Hi\nthere", parentId: null } });
    expect(fieldsOf(checkCommentCreate({ body: "   " }))).toHaveProperty("body");
    expect(fieldsOf(checkCommentCreate({ body: "x".repeat(10_001) }))).toHaveProperty("body");
    expect(fieldsOf(checkCommentCreate({ body: "x", parentId: "nope", mentions: [] }))).toEqual({ parentId: "Use an id, or null.", mentions: "Unknown field." });
  });
});

describe("cursors", () => {
  const c = { m: "c", k: "2026-10-05T09:12:44.120000", i: U, f: "9f3c1a2b4d5e6f70" };
  it("round-trip, opaque base64url", () => {
    const s = encodeCursor(c);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(s)).toEqual(c);
  });
  it("refuse anything forged or malformed", () => {
    const forge = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(decodeCursor("nope")).toBeNull();
    expect(decodeCursor("!!!")).toBeNull();
    expect(decodeCursor(forge({ ...c, v: 1, k: "'; drop table tasks;--" }))).toBeNull();
    expect(decodeCursor(forge({ ...c, v: 1, i: "1 or 1=1" }))).toBeNull();
    expect(decodeCursor(forge({ ...c, v: 2 }))).toBeNull();
    expect(decodeCursor("x".repeat(401))).toBeNull();
    expect(decodeCursor(forge({ ...c, v: 1 }))).toEqual(c);
  });
  it("fingerprints ignore the cursor and the page size, not the filters", async () => {
    const a = await queryFingerprint({ r: "tasks", status: ["todo"], limit: 5, cursor: "x" });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await queryFingerprint({ status: ["todo"], r: "tasks", limit: 50 })).toBe(a);
    expect(await queryFingerprint({ r: "tasks", status: ["done"] })).not.toBe(a);
  });
});

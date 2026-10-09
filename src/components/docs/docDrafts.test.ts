/* Doc changes kept in this tab when they couldn't be saved: per person and doc, forget only your own keep,
   cleared on sign-out with the task panel's unsaved text, and the tab asks before closing while one waits. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearTaskDrafts } from "../taskDetailHelpers";
import { DOC_DRAFT_PREFIX, draftWhen, forgetDocDraft, keepDocDraft, peekDocDraft, takeDocDraft } from "./docDrafts";

const BODY = [{ id: "a", type: "p" as const, spans: [{ text: "written on the train" }] }];
const leaving = () => {
  const e = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

beforeEach(() => sessionStorage.clear());
afterEach(() => { forgetDocDraft("u1", "d1"); forgetDocDraft("u1", "d2"); forgetDocDraft("u2", "d1"); });

describe("doc drafts", () => {
  it("keeps one per person and doc; peek leaves it, take removes it", () => {
    const id = keepDocDraft("u1", "d1", { title: "T", body: BODY, base: "2026-10-09T09:00:00.000Z" });
    expect(id).toBeTruthy();
    expect(peekDocDraft("u2", "d1")).toBeNull();
    expect(peekDocDraft("u1", "d2")).toBeNull();
    expect(peekDocDraft("u1", "d1")).toMatchObject({ title: "T", body: BODY, base: "2026-10-09T09:00:00.000Z", id });
    expect(takeDocDraft("u1", "d1")).toMatchObject({ title: "T", id });
    expect(takeDocDraft("u1", "d1")).toBeNull();
  });

  it("forget with an id removes only that keep, not one kept since", () => {
    const first = keepDocDraft("u1", "d1", { title: "1", body: [], base: "b" })!;
    const second = keepDocDraft("u1", "d1", { title: "2", body: [], base: "b" })!;
    forgetDocDraft("u1", "d1", first);
    expect(peekDocDraft("u1", "d1")?.id).toBe(second);
    forgetDocDraft("u1", "d1", second);
    expect(peekDocDraft("u1", "d1")).toBeNull();
  });

  it("anything malformed reads as nothing; block bodies are cleaned on the way out", () => {
    sessionStorage.setItem(`${DOC_DRAFT_PREFIX}u1:doc:d1`, "{not json");
    expect(peekDocDraft("u1", "d1")).toBeNull();
    sessionStorage.setItem(`${DOC_DRAFT_PREFIX}u1:doc:d1`, JSON.stringify({ title: 1, body: [{ id: "x", type: "evil", spans: [{ text: "hi", href: "javascript:alert(1)" }] }], base: "b", at: "2026-10-09T09:00:00.000Z" }));
    expect(peekDocDraft("u1", "d1")).toEqual({ title: "", body: [{ id: "x", type: "p", spans: [{ text: "hi" }] }], base: "b", at: "2026-10-09T09:00:00.000Z", id: "" });
  });

  it("signing out forgets them (the task panel's clearTaskDrafts), and its reload doesn't ask", () => {
    keepDocDraft("u1", "d1", { title: "T", body: BODY, base: "b" });
    expect(leaving()).toBe(true);
    clearTaskDrafts();
    expect(peekDocDraft("u1", "d1")).toBeNull();
    expect(leaving()).toBe(false);
  });

  it("while one waits, closing the tab asks first", () => {
    expect(leaving()).toBe(false);
    keepDocDraft("u1", "d1", { title: "T", body: BODY, base: "b" });
    keepDocDraft("u1", "d2", { title: "T", body: BODY, base: "b" });
    expect(leaving()).toBe(true);
    forgetDocDraft("u1", "d1");
    expect(leaving()).toBe(true);
    takeDocDraft("u1", "d2");
    expect(leaving()).toBe(false);
  });

  it("says when: today's time, or the date", () => {
    const now = new Date(2026, 9, 9, 15, 0).getTime();
    expect(draftWhen(new Date(2026, 9, 9, 14, 32).toISOString(), now)).toBe("at 14:32");
    expect(draftWhen(new Date(2026, 9, 8, 9, 5).toISOString(), now)).toBe("on 8 Oct at 09:05");
    expect(draftWhen(new Date(2025, 9, 8, 9, 5).toISOString(), now)).toBe("on 8 Oct 2025 at 09:05");
    expect(draftWhen("nonsense", now)).toBe("");
  });
});

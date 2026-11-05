// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cut, DETAIL_TEXT_MAX, isCutCopy, LIST_TEXT_MAX } from "./text.ts";

const long = "Start. " + "Real notes. ".repeat(1500) + "THE END.";

describe("a shortened copy of a description", () => {
  it("is caught when it's what get_task showed, plus a line", () => {
    const shown = cut(long, DETAIL_TEXT_MAX).text;
    expect(isCutCopy(long, `${shown}\n\nAdded by the model.`)).toBe(true);
    expect(isCutCopy(long, shown)).toBe(true);
    expect(isCutCopy(long, `${shown.trimEnd()}\n\nAdded.`)).toBe(true);
  });
  it("is caught when it's what a list showed, plus a line", () => {
    expect(isCutCopy(long, `${cut(long, LIST_TEXT_MAX).text}\nAdded.`)).toBe(true);
  });
  it("is caught just over the cut, where the copy with a line is longer than the original", () => {
    const stored = "x".repeat(DETAIL_TEXT_MAX + 100);
    const copy = `${"x".repeat(DETAIL_TEXT_MAX)}\n\n${"A new paragraph. ".repeat(20)}`;
    expect(copy.length).toBeGreaterThan(stored.length);
    expect(isCutCopy(stored, copy)).toBe(true);
  });
  it("isn't the whole text with a line added", () => {
    expect(isCutCopy(long, `${long}\n\nAdded.`)).toBe(false);
  });
  it("isn't an edit further on, or a rewrite", () => {
    const edited = long.replace("THE END.", "THE VERY END.");
    expect(isCutCopy(long, edited)).toBe(false);
    expect(isCutCopy("short notes", "short notes, longer")).toBe(false);
    expect(isCutCopy(long, "Something else altogether.")).toBe(false);
    expect(isCutCopy(long, "")).toBe(false);
    const fixedTypo = "a".repeat(300) + "b".repeat(300);
    expect(isCutCopy(fixedTypo, "a".repeat(300) + "c" + "b".repeat(299))).toBe(false);
  });
  it("short descriptions are shown whole, so there's nothing to catch", () => {
    const stored = "x".repeat(LIST_TEXT_MAX);
    expect(isCutCopy(stored, `${stored} and more`)).toBe(false);
  });
});

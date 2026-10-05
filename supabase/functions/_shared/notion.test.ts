// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOTION_TOKEN_RE, NOTION_VERSION, notionPageUrl, parseNotionId } from "./notion.ts";

const migration = readFileSync(new URL("../../migrations/0046_api_webhooks_notion.sql", import.meta.url), "utf8");
const ID = "89abcdef-0123-4567-89ab-cdef01234567";

describe("parseNotionId", () => {
  it("reads every way a page gets pasted", () => {
    for (const s of [
      "https://www.notion.so/acme/Launch-brief-89abcdef0123456789abcdef01234567",
      "https://www.notion.so/acme/Launch-brief-89abcdef0123456789abcdef01234567?pvs=4",
      "https://notion.so/89abcdef0123456789abcdef01234567",
      "https://acme.notion.site/Launch-brief-89abcdef0123456789abcdef01234567",
      "https://www.notion.so/acme/0000000000000000000000000000aaaa?v=1&p=89abcdef0123456789abcdef01234567&pm=s",
      "89abcdef0123456789abcdef01234567",
      "89ABCDEF-0123-4567-89ab-cdef01234567",
      "  89abcdef-0123-4567-89ab-cdef01234567  ",
    ]) expect(parseNotionId(s)).toBe(ID);
  });
  it("refuses other sites and non-ids", () => {
    for (const s of ["", "hello", "https://evil.example.com/89abcdef0123456789abcdef01234567",
      "https://notion.so.evil.example.com/89abcdef0123456789abcdef01234567", "https://www.notion.so/acme/Launch-brief",
      "javascript:alert('89abcdef0123456789abcdef01234567')"]) expect(parseNotionId(s)).toBeNull();
  });
  it("page url from an id", () => {
    expect(notionPageUrl(ID)).toBe("https://www.notion.so/89abcdef0123456789abcdef01234567");
  });
});

describe("matches the 0046 SQL", () => {
  it("token shape = workspace_integrations_notion / notion_connect", () => {
    expect(migration).toContain("'^(secret_|ntn_)[A-Za-z0-9]{20,180}$'");
    expect(NOTION_TOKEN_RE.source).toBe("^(secret_|ntn_)[A-Za-z0-9]{20,180}$");
    expect(NOTION_TOKEN_RE.test("ntn_" + "A1b2C3d4".repeat(6))).toBe(true);
    expect(NOTION_TOKEN_RE.test("Bearer abc")).toBe(false);
  });
  it("API version", () => expect(NOTION_VERSION).toBe("2022-06-28"));
});

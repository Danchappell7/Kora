/* The shared rank table (0058, project access): src/lib/projectAccessMatrix.json is what
   pa_rank_core() answers (the PGlite suite checks every row against the database) and what the
   app's mirror must answer. These are the table's own invariants, so a hand edit can't quietly
   break it. */
import { describe, it, expect } from "vitest";
import MATRIX from "./projectAccessMatrix.json";

type Row = { on: boolean; wsRole: string; visibility: string | null; isOwner: boolean; memberRole: string | null; rank: number };
const rows = MATRIX as Row[];
const ROLE_RANK: Record<string, number> = { editor: 3, commenter: 2, viewer: 1 };
const memberRank = (r: Row) => (r.memberRole ? ROLE_RANK[r.memberRole] : 0);

describe("projectAccessMatrix.json", () => {
  it("is the whole cross product, each combination once, ranks 0 to 3", () => {
    expect(rows).toHaveLength(320);
    expect(new Set(rows.map((r) => `${r.on}|${r.wsRole}|${r.visibility}|${r.isOwner}|${r.memberRole}`)).size).toBe(320);
    expect(rows.every((r) => Number.isInteger(r.rank) && r.rank >= 0 && r.rank <= 3)).toBe(true);
  });
  it("switch off is today's rule whatever the project says: staff edit, guests comment, nobody else sees", () => {
    for (const r of rows.filter((x) => !x.on)) {
      expect(r.rank).toBe(r.wsRole === "none" ? 0 : r.wsRole === "guest" ? 2 : 3);
    }
  });
  it("switch on: owners always edit, outsiders never see, guests never edit or see loose work", () => {
    const on = rows.filter((x) => x.on);
    expect(on.filter((r) => r.wsRole === "owner").every((r) => r.rank === 3)).toBe(true);
    expect(on.filter((r) => r.wsRole === "none").every((r) => r.rank === 0)).toBe(true);
    for (const r of on.filter((x) => x.wsRole === "guest")) expect(r.rank).toBe(r.visibility === null ? 0 : Math.min(memberRank(r), 2));
  });
  it("switch on: members keep Whole workspace and loose work, a project's owner edits it, admins edit Members only", () => {
    const on = rows.filter((x) => x.on);
    for (const r of on.filter((x) => x.wsRole === "admin" || x.wsRole === "member")) {
      const open = r.visibility === null || r.visibility === "workspace" || r.isOwner || (r.wsRole === "admin" && r.visibility === "members");
      expect(r.rank).toBe(open ? 3 : memberRank(r));
    }
  });
});

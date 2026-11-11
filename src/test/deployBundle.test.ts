// The owner's one-paste file for database updates 0051..0057 must be exactly what
// scripts/bundle-migrations.mjs makes from the migration files today: if a migration
// changes and the bundle isn't remade, this fails (remake it with
// `node scripts/bundle-migrations.mjs 0051 0057`).
import { describe, expect, it } from "vitest";
// @ts-ignore -- a plain Node script (no type declarations); vitest runs it as is
import { bundle } from "../../scripts/bundle-migrations.mjs";
import committed from "../../supabase/deploy/0051-0057_one_paste.sql?raw";

describe("supabase/deploy one-paste bundles", () => {
  it("0051-0057 matches its migration files", () => {
    const made: string = bundle("0051", "0057");
    expect(committed === made).toBe(true);
  });

  it("ends with one check that covers every file in it", () => {
    const sql = committed;
    for (const v of ["0051", "0052", "0053", "0054", "0055", "0056", "0057"]) {
      expect(sql).toContain(`-- >>>>>>>>>> ${v}_`);
      expect(sql).toContain(`as "${v}"`);
    }
    expect(sql.trimEnd().endsWith(`) m) as "not true";`)).toBe(true);
    // nothing in the paste manages its own transaction: the editor runs it as one, so a failure changes nothing
    expect(/^\s*(begin|commit|rollback)\s*;/im.test(sql)).toBe(false);
  });
});

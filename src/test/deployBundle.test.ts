// The owner's one-paste files for database updates 0051..0057 and 0051..0058 must be
// exactly what scripts/bundle-migrations.mjs makes from the migration files today: if a
// migration changes and a bundle isn't remade, this fails (remake it with
// `node scripts/bundle-migrations.mjs 0051 0057` / `... 0051 0058`).
import { describe, expect, it } from "vitest";
// @ts-ignore -- a plain Node script (no type declarations); vitest runs it as is
import { bundle, verifySelect } from "../../scripts/bundle-migrations.mjs";
import m0058 from "../../supabase/migrations/0058_project_access.sql?raw";
import upTo57 from "../../supabase/deploy/0051-0057_one_paste.sql?raw";
import upTo58 from "../../supabase/deploy/0051-0058_one_paste.sql?raw";
import doc from "../../DEPLOYMENT.md?raw";

const BUNDLES: Array<[string, string, string]> = [
  ["0051", "0057", upTo57],
  ["0051", "0058", upTo58],
];

describe("supabase/deploy one-paste bundles", () => {
  for (const [from, to, committed] of BUNDLES) {
    it(`${from}-${to} matches its migration files`, () => {
      const made: string = bundle(from, to);
      expect(committed === made).toBe(true);
    });

    it(`${from}-${to} ends with one check that covers every file in it`, () => {
      const sql = committed;
      for (let n = Number(from); n <= Number(to); n++) {
        const v = String(n).padStart(4, "0");
        expect(sql).toContain(`-- >>>>>>>>>> ${v}_`);
        expect(sql).toContain(`as "${v}"`);
      }
      expect(sql.trimEnd().endsWith(`) m) as "not true";`)).toBe(true);
      // nothing in the paste manages its own transaction: the editor runs it as one, so a failure changes nothing
      expect(/^\s*(begin|commit|rollback)\s*;/im.test(sql)).toBe(false);
    });
  }

  it("a VERIFY select ends at its semicolon, so notes written after it (as in 0058) don't break the final check", () => {
    const sel: string = verifySelect(m0058, "0058_project_access.sql");
    expect(sel.startsWith("select")).toBe(true);
    expect(sel.trimEnd().endsWith("as notion_contained")).toBe(true);
    expect(sel).not.toContain("everyone_still_off is true right after");
    expect(sel).not.toContain(";");
  });

  it("the shortest way in DEPLOYMENT.md copies the 0051-0058 file and deploys every function Steps 17, 18 and 19 name", () => {
    // a heading's section runs to the next "### Step" or "## " heading
    const section = (heading: string) => {
      const s = doc.indexOf(heading);
      expect(s, heading).toBeGreaterThan(0);
      const ends = [doc.indexOf("\n### Step ", s + 10), doc.indexOf("\n## ", s + 10)].filter((i) => i > 0);
      return doc.slice(s, ends.length ? Math.min(...ends) : undefined);
    };
    const short = section("\n### Step 17–19 in one go");
    expect(short).toContain("pbcopy < ~/Downloads/kora-app/supabase/deploy/0051-0058_one_paste.sql");
    const steps = ["17", "18", "19"].map((n) => section(`\n### Step ${n}:`));
    const deployed = (s: string) => new Set([...s.matchAll(/supabase functions deploy ([a-z-]+)/g)].map((m) => m[1]));
    const want = new Set(steps.flatMap((s) => [...deployed(s)]));
    expect([...deployed(short)].sort()).toEqual([...want].sort());
    // each function keeps the JWT setting it has in its own step
    const noJwt = (s: string, f: string) => new RegExp(`supabase functions deploy ${f} --no-verify-jwt`).test(s);
    for (const f of want) {
      for (const s of steps.filter((x) => deployed(x).has(f))) expect(noJwt(short, f), f).toBe(noJwt(s, f));
    }
  });
});

// @vitest-environment node
// The sync engine's flows run against Postgres in the PGlite replay
// (scratchpad/pgtest-a3: run.mjs, merge.mjs); this covers the lease's edges.
import { describe, expect, it } from "vitest";
import { LEASE_SEC, takeLease } from "./notionSync.ts";
import type { Tx } from "./api/types.ts";

const WS = "11111111-0000-4000-8000-000000000001";
function db(answer: (text: string, params: readonly unknown[]) => unknown[]) {
  const calls: { text: string; params: readonly unknown[] }[] = [];
  const service: Tx = { query: async (text, params = []) => { calls.push({ text, params }); return answer(text, params) as never[]; } };
  const logs: string[] = [];
  return { calls, logs, deps: { db: { service, withUser: async () => { throw new Error("no"); } }, log: (_l: string, m: string) => { logs.push(m); } } };
}

describe("one import or sync run per database at a time", () => {
  it("takes the lease (one key per workspace and database, any spelling of the id) and lets go of only its own", async () => {
    const d = db((t) => (/insert into public.rate_limits/.test(t) ? [{ at: "2026-10-05 20:00:00.123456+00" }] : []));
    const release = await takeLease(d.deps, WS, "0D0D0D0D000040008000000000000001");
    expect(release).toBeTypeOf("function");
    expect(d.calls[0].params).toEqual([`kanbo:notion:lease:${WS}:0d0d0d0d-0000-4000-8000-000000000001`, LEASE_SEC]);
    expect(d.calls[0].text).toMatch(/where rl\.last_at <= now\(\) - make_interval/);
    await release!();
    expect(d.calls[1].text).toMatch(/delete from public\.rate_limits where key = \$1 and last_at = \$2/);
    expect(d.calls[1].params).toEqual([`kanbo:notion:lease:${WS}:0d0d0d0d-0000-4000-8000-000000000001`, "2026-10-05 20:00:00.123456+00"]);
  });
  it("someone else holds it: null", async () => {
    const d = db(() => []);
    expect(await takeLease(d.deps, WS, "0d0d0d0d-0000-4000-8000-000000000001")).toBeNull();
  });
  it("the limiter can't be reached: carries on (like the rate limits), with a warning", async () => {
    const d = db(() => { throw new Error("connection refused"); });
    const release = await takeLease(d.deps, WS, "0d0d0d0d-0000-4000-8000-000000000001");
    expect(release).toBeTypeOf("function");
    await expect(release!()).resolves.toBeUndefined();
    expect(d.logs).toEqual(["notion lease unavailable (carrying on)"]);
  });
});

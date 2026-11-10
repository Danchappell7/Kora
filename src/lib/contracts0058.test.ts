/* 0058 (project access): the contract between the migration and the app. Every call the store makes,
   with every argument it sends, is a definer function in 0058 granted to signed-in people (never
   anon); the columns and table the store reads are 0058's; the error texts the app words are the
   ones 0058 raises. The SQL itself is attacked in the PGlite suite (supabase/tests/pglite/projectAccess.ts). */
import { describe, it, expect } from "vitest";
import MATRIX from "./projectAccessMatrix.json";
import { rankCore } from "./projectAccess";

const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string };
const { cwd } = (globalThis as unknown as { process: { cwd(): string } }).process;
const read = (p: string) => readFileSync(`${cwd()}/${p}`, "utf8");

const M58 = read("supabase/migrations/0058_project_access.sql");
const STORE = read("src/data/store.ts");

describe("migration 0058 and the store", () => {
  it("every RPC the store calls exists with each parameter it sends, revoked from anon, granted to authenticated", () => {
    const calls = [...STORE.matchAll(/rpc\("(set_project_access|set_project_visibility|set_project_member|remove_project_member|set_invite_projects)", \{([^}]*)\}/g)];
    expect(new Set(calls.map((c) => c[1]))).toEqual(new Set(["set_project_access", "set_project_visibility", "set_project_member", "remove_project_member", "set_invite_projects"]));
    for (const [, fn, args] of calls) {
      const def = M58.match(new RegExp(`create or replace function public\\.${fn}\\(([^)]*)\\)[\\s\\S]*?security definer`));
      expect(def, fn).toBeTruthy();
      for (const p of [...args.matchAll(/(p_[a-z_]+):/g)].map((m) => m[1])) expect(def![1], `${fn}(${p})`).toMatch(new RegExp(`\\b${p}\\b`));
    }
    expect(M58).toMatch(/execute format\('revoke execute on function %s from public, anon', f\)/);
    expect(M58).toMatch(/execute format\('grant execute on function %s to authenticated', f\)/);
    for (const sig of ["set_project_access(uuid,boolean,text,boolean)", "set_project_visibility(uuid,text)", "set_project_member(uuid,uuid,text)", "remove_project_member(uuid,uuid)", "set_invite_projects(uuid,jsonb)"]) {
      expect(M58).toContain(`'public.${sig}'`);
    }
  });

  it("the columns and table the store reads are 0058's, and clients can only read project_members", () => {
    for (const col of ["project_access", "project_access_default", "project_access_member_private", "project_access_changed_at"]) {
      expect(M58).toMatch(new RegExp(`alter table public\\.workspaces add column if not exists ${col}\\b`));
      expect(STORE).toContain(col);
    }
    expect(M58).toMatch(/alter table public\.projects add column if not exists visibility text/);
    expect(M58).toMatch(/create table if not exists public\.project_members/);
    expect(STORE).toContain('loadAllRows<ProjectMemberRow>(client, "project_members")');
    expect(M58).toContain("grant select on public.project_members to authenticated;");
    // nothing in the app writes the table, or the guarded columns, directly
    expect(STORE).not.toMatch(/from\("project_members"\)\.(insert|update|upsert|delete)/);
    expect(STORE).not.toMatch(/project_access:\s/);
  });

  it("the texts the app matches are the ones 0058 raises", () => {
    for (const text of ["not authorized", "not found", "invalid visibility", "invalid role", "invalid grants", "not a member of this workspace"]) {
      expect(M58).toContain(`raise exception '${text}'`);
    }
    expect(M58).toContain("raise exception 'assignee can''t see this project' using errcode = '42501'");
  });

  it("the app's rank table is the database's (every row of the shared matrix)", () => {
    for (const r of MATRIX as { on: boolean; wsRole: string; visibility: "workspace" | "members" | "private" | null; isOwner: boolean; memberRole: string | null; rank: number }[]) {
      expect(rankCore(r.on, r.wsRole, r.visibility, r.isOwner, r.memberRole)).toBe(r.rank);
    }
  });
});

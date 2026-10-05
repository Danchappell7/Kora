/* lib/publicForms signed in: switching a form's link and regenerating it,
   through a mocked Supabase client (the real one is never built in tests). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };
const state: {
  update: Result; rpc: Result; probe: Result;
  calls: { table?: string; patch?: unknown; eq?: [string, unknown]; select?: string; rpc?: [string, unknown] }[];
} = { update: { data: null, error: null }, rpc: { data: null, error: null }, probe: { data: [], error: null }, calls: [] };

vi.mock("./supabase", () => {
  const client = {
    from(table: string) {
      const call: (typeof state.calls)[number] = { table };
      state.calls.push(call);
      const q = {
        update(patch: unknown) { call.patch = patch; return q; },
        eq(c: string, v: unknown) { call.eq = [c, v]; return q; },
        select(cols: string) { call.select = cols; return q; },
        limit() { return Promise.resolve(state.probe); },
        maybeSingle() { return Promise.resolve(state.update); },
      };
      return q;
    },
    rpc(name: string, args: unknown) { state.calls.push({ rpc: [name, args] }); return Promise.resolve(state.rpc); },
  };
  return { supabase: client, isSupabaseConfigured: true };
});

import { PublicLinkError, publicLinksStatus, regenerateFormLink, resetPublicLinksStatus, setFormPublic } from "./publicForms";

const FORM = "33333333-3333-4333-8333-333333333333";
const TOKEN = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
  state.update = { data: null, error: null };
  state.rpc = { data: null, error: null };
  state.probe = { data: [], error: null };
  state.calls = [];
  resetPublicLinksStatus();
});
afterEach(() => { vi.restoreAllMocks(); });

const codeOf = async (p: Promise<unknown>) => { try { await p; return "resolved"; } catch (e) { return e instanceof PublicLinkError ? e.code : "other"; } };

describe("setFormPublic", () => {
  it("updates public_enabled and returns what the row says (the server mints the token)", async () => {
    state.update = { data: { public_enabled: true, public_token: TOKEN }, error: null };
    expect(await setFormPublic(FORM, true)).toEqual({ publicEnabled: true, publicToken: TOKEN });
    expect(state.calls[0]).toEqual({ table: "forms", patch: { public_enabled: true }, eq: ["id", FORM], select: "public_enabled, public_token" });
  });
  it("never sends a token of its own", async () => {
    state.update = { data: { public_enabled: false, public_token: TOKEN }, error: null };
    await setFormPublic(FORM, false);
    expect(JSON.stringify(state.calls[0].patch)).not.toContain("token");
  });
  it("no row back (RLS: a guest, a removed member, a deleted form) is a refusal", async () => {
    expect(await codeOf(setFormPublic(FORM, true))).toBe("forbidden");
  });
  it("before 0043 it says public links aren't switched on yet", async () => {
    state.update = { data: null, error: { code: "PGRST204", message: "Could not find the 'public_enabled' column of 'forms' in the schema cache" } };
    expect(await codeOf(setFormPublic(FORM, true))).toBe("unavailable");
    state.update = { data: null, error: { code: "42703", message: "column \"public_enabled\" does not exist" } };
    expect(await codeOf(setFormPublic(FORM, true))).toBe("unavailable");
  });
  it("a form that's still saving, and an offline browser, are told apart", async () => {
    expect(await codeOf(setFormPublic("tmp-form-1", true))).toBe("pending");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(await codeOf(setFormPublic(FORM, true))).toBe("offline");
    expect(state.calls).toHaveLength(0);
  });
  it("anything else is a plain 'didn't save'", async () => {
    state.update = { data: null, error: { code: "XX000", message: "boom" } };
    const e = await setFormPublic(FORM, true).catch((x) => x);
    expect(e).toBeInstanceOf(PublicLinkError);
    expect(e.code).toBe("failed");
    expect(e.message).toMatch(/didn't save/);
  });
});

describe("regenerateFormLink", () => {
  it("calls rotate_form_public_token and returns the new token", async () => {
    state.rpc = { data: TOKEN, error: null };
    expect(await regenerateFormLink(FORM)).toBe(TOKEN);
    expect(state.calls[0]).toEqual({ rpc: ["rotate_form_public_token", { p_form: FORM }] });
  });
  it("'form not found' (gone, or not yours to edit) is a refusal; a missing function is 'not yet'", async () => {
    state.rpc = { data: null, error: { code: "P0001", message: "form not found" } };
    expect(await codeOf(regenerateFormLink(FORM))).toBe("forbidden");
    state.rpc = { data: null, error: { code: "PGRST202", message: "Could not find the function public.rotate_form_public_token" } };
    expect(await codeOf(regenerateFormLink(FORM))).toBe("unavailable");
  });
  it("refuses a token of the wrong shape", async () => {
    state.rpc = { data: "short", error: null };
    expect(await codeOf(regenerateFormLink(FORM))).toBe("failed");
  });
});

describe("publicLinksStatus", () => {
  it("ready when the column answers; asks the function only when told to; caches", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    expect(await publicLinksStatus({ baseUrl: "https://abc.supabase.co" })).toEqual({ links: "ready", page: "unknown" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await publicLinksStatus({ baseUrl: "https://abc.supabase.co", checkPage: true, fetchImpl })).toEqual({ links: "ready", page: "live" });
    expect(fetchImpl).toHaveBeenCalledWith("https://abc.supabase.co/functions/v1/public-form?ping", expect.anything());
    await publicLinksStatus({ baseUrl: "https://abc.supabase.co", checkPage: true, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(state.calls.filter((c) => c.table === "forms")).toHaveLength(1);
  });
  it("unavailable before 0043; 'missing' when the function isn't deployed", async () => {
    state.probe = { data: null, error: { code: "42703", message: "column forms.public_enabled does not exist" } };
    const gateway404 = vi.fn(async () => new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 })) as unknown as typeof fetch;
    expect(await publicLinksStatus({ baseUrl: "https://abc.supabase.co", checkPage: true, fetchImpl: gateway404 })).toEqual({ links: "unavailable", page: "missing" });
  });
  it("an unknown answer is asked again next time", async () => {
    state.probe = { data: null, error: { code: "08006", message: "connection failure" } };
    expect((await publicLinksStatus()).links).toBe("unknown");
    state.probe = { data: [], error: null };
    expect((await publicLinksStatus()).links).toBe("ready");
  });
});

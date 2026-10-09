/* lib/projectPlanner against a (mocked) ai-assist: the request it sends, the
   reply checked again on the device, and every way the call can fail —
   no key, the daily limit, an account awaiting approval, a bad reply, an
   out-of-date function, offline. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./supabase", () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } },
  isSupabaseConfigured: true,
}));

import { PLANNER_COPY, PLAN_TIMEOUT_MS, plannerFailure, plannerRoster, planWithAi, resetPlannerSession, type PlannerError } from "./projectPlanner";
import type { Member, PlannerContext } from "../data/types";

const mem = (id: string, name: string): Member => ({ id, name, email: `${id}@x.test`, type: "team", color: "oklch(0.7 0.1 200)" });
const ctx: PlannerContext = { today: "2026-10-09", workspaceId: "ws", mode: "new", roster: plannerRoster([mem("me", "Daniel Okai"), mem("maya", "Maya Lin")], { currentUserId: "me" }) };
const httpError = (status: number, body: unknown) => ({
  name: "FunctionsHttpError", message: "Edge Function returned a non-2xx status code",
  context: { status, json: async () => body, clone: () => ({ json: async () => body }) },
});
const setOnline = (on: boolean) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as PlannerError; } throw new Error("expected a failure"); };
const PLAN = {
  project: { name: "Mobile app launch", emoji: "📱" },
  sections: [{ name: "Build" }, { name: "Launch" }],
  tasks: [
    { ref: "t1", title: "Freeze the scope", section: "Build", assigneeHint: "maya", estimateHours: 3, startOffset: 0, dueOffset: 1, dependsOn: [], isMilestone: false, description: "Must-fix list agreed." },
    { ref: "t2", title: "Launch day", section: "Launch", assigneeHint: null, estimateHours: null, startOffset: 5, dueOffset: 5, dependsOn: ["t1"], isMilestone: true, description: "" },
  ],
};

beforeEach(() => { invoke.mockReset(); resetPlannerSession(); setOnline(true); });
afterEach(() => setOnline(true));

describe("planWithAi", () => {
  it("sends mode plan with the roster and today, and turns the reply into a draft", async () => {
    invoke.mockResolvedValue({ data: { plan: PLAN, usage: { used: 3, limit: 200 } }, error: null });
    const d = await planWithAi({ goal: "Launch the mobile app", deadline: "2026-11-20", constraints: "No Friday releases" }, ctx);
    expect(invoke).toHaveBeenCalledWith("ai-assist", {
      body: {
        mode: "plan", goal: "Launch the mobile app", deadline: "2026-11-20", today: "2026-10-09",
        roster: [{ id: "me", name: "Daniel Okai" }, { id: "maya", name: "Maya Lin" }],
        constraints: "No Friday releases", projectName: null, existing: null,
      },
      timeout: PLAN_TIMEOUT_MS,
    });
    expect(d).toMatchObject({ source: "ai", name: "Mobile app launch", emoji: "📱", deadline: "2026-11-20", startDate: "2026-10-09" });
    expect(d.tasks.map((t) => [t.title, t.assigneeId])).toEqual([["Freeze the scope", "maya"], ["Launch day", null]]);
    expect(d.tasks[1].dependsOn).toEqual([d.tasks[0].key]);
  });

  it("checks the reply again: owners outside the roster are dropped, a malformed plan is bad_output", async () => {
    invoke.mockResolvedValue({ data: { plan: { ...PLAN, tasks: [{ ...PLAN.tasks[0], assigneeHint: "intruder-id" }] } }, error: null });
    expect((await planWithAi({ goal: "x" }, ctx)).tasks[0].assigneeId).toBeNull();
    invoke.mockResolvedValue({ data: { plan: { tasks: [] } }, error: null });
    const e = await fail(planWithAi({ goal: "x" }, ctx));
    expect(e.reason).toBe("bad_output");
    expect(e.message).toBe(PLANNER_COPY.badOutput);
  });

  it.each([
    [httpError(400, { error: "no_api_key" }), "ai_unavailable", PLANNER_COPY.unavailable],
    [httpError(502, { error: "anthropic_error", status: 529 }), "ai_unavailable", PLANNER_COPY.unavailable],
    [httpError(404, {}), "ai_unavailable", PLANNER_COPY.unavailable],
    [httpError(429, { error: "daily_limit", limit: 200, detail: "You've used today's 200 AI requests. They reset at midnight (UK time)." }), "daily_limit", "You've used today's 200 AI requests. They reset at midnight (UK time)."],
    [httpError(429, {}), "daily_limit", PLANNER_COPY.limit],
    [httpError(403, { error: "not_allowed" }), "not_allowed", PLANNER_COPY.notAllowed],
    [httpError(401, { error: "unauthorized" }), "not_allowed", PLANNER_COPY.notAllowed],
    [httpError(502, { error: "bad_output", detail: "cut_off" }), "bad_output", PLANNER_COPY.badOutput],
    [httpError(500, "not json"), "error", PLANNER_COPY.error],
    [{ name: "FunctionsFetchError", message: "Failed to send a request to the Edge Function" }, "network", PLANNER_COPY.unavailable],
    [{ name: "FunctionsRelayError", message: "Relay Error invoking the Edge Function" }, "ai_unavailable", PLANNER_COPY.unavailable],
    [{ name: "AbortError", message: "The operation was aborted" }, "error", PLANNER_COPY.timeout],
  ])("maps a refusal (%#) to its reason and sentence", async (error, reason, message) => {
    invoke.mockResolvedValue({ data: null, error });
    const e = await fail(planWithAi({ goal: "Launch" }, ctx));
    expect(e.reason).toBe(reason);
    expect(plannerFailure(e)).toBe(reason);
    expect(e.message).toBe(message);
  });

  it("a thrown invoke is mapped too", async () => {
    invoke.mockRejectedValue(new TypeError("Failed to fetch"));
    expect((await fail(planWithAi({ goal: "Launch" }, ctx))).reason).toBe("network");
  });

  it("offline: doesn't call at all", async () => {
    setOnline(false);
    const e = await fail(planWithAi({ goal: "Launch" }, ctx));
    expect(e.reason).toBe("network");
    expect(e.message).toBe(PLANNER_COPY.offline);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("an ai-assist from before the plan mode (answers as prioritise): unavailable, and not asked again this session", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    invoke.mockResolvedValue({ data: { items: [], summary: "Nothing open to prioritize." }, error: null });
    expect((await fail(planWithAi({ goal: "Launch" }, ctx))).reason).toBe("ai_unavailable");
    expect((await fail(planWithAi({ goal: "Launch" }, ctx))).reason).toBe("ai_unavailable");
    expect(invoke).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it("no goal: no call", async () => {
    expect((await fail(planWithAi({ goal: "   " }, ctx))).reason).toBe("error");
    expect(invoke).not.toHaveBeenCalled();
  });
});

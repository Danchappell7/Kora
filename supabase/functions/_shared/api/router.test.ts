// @vitest-environment node
import { describe, expect, it } from "vitest";
import { apiError, errorBody, json, matchRoute, newRequestId, stripBase, type Route } from "./router.ts";

const h = async () => new Response(null);
const routes: Route[] = [
  { method: "GET", path: "/tasks", handler: h },
  { method: "POST", path: "/tasks", handler: h },
  { method: "GET", path: "/tasks/:id", handler: h },
  { method: "PATCH", path: "/tasks/:id", handler: h },
  { method: "POST", path: "/tasks/:id/complete", handler: h },
  { method: "GET", path: "/tasks/:id/comments", handler: h },
];

describe("stripBase", () => {
  it("accepts the paths Supabase may hand the function", () => {
    expect(stripBase("/functions/v1/api/v1/tasks")).toBe("/tasks");
    expect(stripBase("/api/v1/tasks/abc/")).toBe("/tasks/abc");
    expect(stripBase("/v1/me")).toBe("/me");
    expect(stripBase("/api/v1")).toBe("/");
  });
  it("null outside /v1", () => {
    expect(stripBase("/api/v2/tasks")).toBeNull();
    expect(stripBase("/api/tasks")).toBeNull();
    expect(stripBase("/api/v1tasks")).toBeNull();
  });
});

describe("matchRoute", () => {
  it("matches with decoded params", () => {
    const m = matchRoute(routes, "get", "/tasks/a%20b/comments");
    expect(m.kind).toBe("match");
    if (m.kind === "match") expect(m.params).toEqual({ id: "a b" });
  });
  it("405 with the allowed methods", () => {
    const m = matchRoute(routes, "DELETE", "/tasks/1");
    expect(m).toEqual({ kind: "method_not_allowed", allow: ["GET", "PATCH"] });
  });
  it("404 for unknown paths and broken escapes", () => {
    expect(matchRoute(routes, "GET", "/nope").kind).toBe("not_found");
    expect(matchRoute(routes, "GET", "/tasks/%E0%A4%A/comments").kind).toBe("not_found");
  });
});

describe("responses", () => {
  it("errors share one shape", async () => {
    const r = apiError(404, "not_found", "Task not found", { requestId: "req_1" });
    expect(r.status).toBe(404);
    expect(r.headers.get("Content-Type")).toContain("application/json");
    expect(r.headers.get("X-Request-Id")).toBe("req_1");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await r.json()).toEqual({ error: { code: "not_found", message: "Task not found", status: 404, requestId: "req_1" } });
    expect(errorBody(422, "validation_failed", "x", undefined, { fields: { title: "required" } }).error.details).toEqual({ fields: { title: "required" } });
  });
  it("204 has no body", async () => {
    expect(await json(null, 204).text()).toBe("");
  });
  it("request ids", () => {
    expect(newRequestId()).toMatch(/^req_[0-9a-f]{16}$/);
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

// @vitest-environment node
// The OpenAPI document stays complete and in step with the code: every
// route is documented, every documented operation exists, request schemas
// list exactly the fields the validators accept, and every example has the
// fields its schema requires.
import { describe, expect, it } from "vitest";
import { buildOpenApi, type OpenApiOperation } from "./openapi.ts";
import { coreRoutes } from "./routes.ts";
import { PROJECT_CREATE_FIELDS, PROJECT_PATCH_FIELDS, TASK_CREATE_FIELDS, TASK_PATCH_FIELDS } from "./validate.ts";
import { webhookOpenApiPaths, webhookRoutes } from "./webhooks.ts";

const doc = buildOpenApi("https://ref.supabase.co/functions/v1/api/v1/");
const schemas = doc.components!.schemas as Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
const ops: Array<[string, string, OpenApiOperation]> = Object.entries(doc.paths).flatMap(([p, item]) =>
  Object.entries(item).map(([m, op]) => [p, m, op as OpenApiOperation] as [string, string, OpenApiOperation]));
const toOpenApiPath = (p: string) => p.replace(/:([a-zA-Z]+)/g, "{$1}");

function resolve(schema: unknown): { properties?: Record<string, unknown>; required?: string[] } {
  const r = (schema as { $ref?: string })?.$ref;
  return r ? schemas[r.replace("#/components/schemas/", "")] : (schema as never);
}

describe("OpenAPI document", () => {
  it("is OpenAPI 3.1 with bearer auth and the server", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "https://ref.supabase.co/functions/v1/api/v1" }]);
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.info.description).toMatch(/Idempotency-Key/);
  });

  it("documents every route, and only routes that exist", () => {
    const routes = [...coreRoutes, ...webhookRoutes].map((r) => `${r.method.toLowerCase()} ${toOpenApiPath(r.path)}`).sort();
    const documented = ops.filter(([p]) => p !== "/openapi.json").map(([p, m]) => `${m} ${p}`).sort();
    expect(documented).toEqual(routes);
    expect(Object.keys(webhookOpenApiPaths).every((p) => p in doc.paths)).toBe(true);
  });

  it("every operation (core and webhooks): a unique id, a summary, its access", () => {
    const ids = new Set<string>();
    for (const [p, m, op] of ops) {
      const where = `${m} ${p}`;
      expect(op.operationId, where).toBeTruthy();
      expect(ids.has(op.operationId), where).toBe(false);
      ids.add(op.operationId);
      expect(op.summary, where).toBeTruthy();
      expect(op["x-kanbo-access"], where).toBe(m === "get" ? "read" : "write");
    }
  });

  it("each core operation: a tag, examples, the errors it can give", () => {
    for (const [p, m, op] of ops.filter(([p]) => !(p in webhookOpenApiPaths))) {
      const where = `${m} ${p}`;
      expect(op.tags?.length, where).toBeGreaterThan(0);
      if (p !== "/openapi.json") expect(op.responses["401"], where).toBeTruthy();
      if (m !== "get" && p !== "/openapi.json") expect(op.responses["403"] ?? op.responses["401"], where).toBeTruthy();
      for (const [status, res] of Object.entries(op.responses)) {
        expect(res.description, `${where} ${status}`).toBeTruthy();
        const c = res.content?.["application/json"];
        if (c && p !== "/openapi.json") expect(c.example, `${where} ${status} example`).toBeDefined();
        if (Number(status) >= 400) expect((c?.example as { error?: { status?: number } })?.error?.status, `${where} ${status}`).toBe(Number(status));
      }
      for (const param of op.parameters ?? []) {
        if (param.in === "path") {
          expect(param.required, `${where} ${param.name}`).toBe(true);
          expect(p, where).toContain(`{${param.name}}`);
        }
      }
      if (op.requestBody) expect(op.requestBody.content["application/json"]?.example, where).toBeDefined();
    }
  });

  it("every $ref resolves", () => {
    const refs = JSON.stringify(doc).match(/"#\/components\/schemas\/[A-Za-z]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(20);
    for (const r of refs) expect(schemas[r.slice(22, -1)], r).toBeTruthy();
  });

  it("request schemas list exactly the fields the API accepts", () => {
    const keys = (n: string) => Object.keys(schemas[n].properties ?? {}).sort();
    expect(keys("TaskCreate")).toEqual([...TASK_CREATE_FIELDS].sort());
    expect(keys("TaskUpdate")).toEqual([...TASK_PATCH_FIELDS].sort());
    expect(keys("ProjectCreate")).toEqual([...PROJECT_CREATE_FIELDS].sort());
    expect(keys("ProjectUpdate")).toEqual([...PROJECT_PATCH_FIELDS].sort());
  });

  it("examples carry every required field (lists: their items too)", () => {
    for (const [p, m, op] of ops.filter(([p]) => !(p in webhookOpenApiPaths))) {
      for (const [status, res] of Object.entries(op.responses)) {
        const c = res.content?.["application/json"];
        if (!c?.schema || !c.example || p === "/openapi.json") continue;
        const s = resolve(c.schema);
        for (const k of s.required ?? []) expect(c.example, `${m} ${p} ${status}: ${k}`).toHaveProperty(k);
        const items = (s.properties?.data as { items?: unknown } | undefined)?.items;
        if (items) {
          const is = resolve(items);
          for (const row of (c.example as { data: unknown[] }).data) for (const k of is.required ?? []) expect(row, `${m} ${p} item: ${k}`).toHaveProperty(k);
        }
      }
      const body = op.requestBody?.content["application/json"];
      if (body?.schema) {
        const s = resolve(body.schema);
        for (const k of s.required ?? []) expect(body.example, `${m} ${p} body: ${k}`).toHaveProperty(k);
        for (const k of Object.keys(body.example as object)) expect(s.properties, `${m} ${p} body: ${k}`).toHaveProperty(k);
      }
    }
  });

  it("is plain JSON (the api function serves it as is)", () => {
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});

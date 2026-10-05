// ============================================================
// KANBO — public API v1: the OpenAPI 3.1 document (0046).        [architect → a1]
//
// One document, two readers: GET /v1/openapi.json (the api function) and
// Settings › Developers › API reference (src/components/settings/ApiDocs.tsx,
// which imports buildOpenApi directly — no fetch, no key needed).
//
// Package a1 fills `paths` / `components` (every endpoint, parameter,
// request body, response and error, with examples). The skeleton below is
// already a valid document so both readers work before then.
//
// Pure module (no Deno globals, no imports the app can't resolve).
// ============================================================
import { webhookOpenApiPaths } from "./webhooks.ts";

/** The parts of OpenAPI 3.1 Kanbo uses (loose on purpose: ApiDocs reads it defensively). */
export interface OpenApiDoc {
  openapi: "3.1.0";
  info: { title: string; version: string; description?: string; contact?: { email?: string; url?: string } };
  servers: { url: string; description?: string }[];
  security?: Record<string, string[]>[];
  tags?: { name: string; description?: string }[];
  paths: Record<string, Partial<Record<"get" | "post" | "patch" | "delete", OpenApiOperation>>>;
  components?: {
    securitySchemes?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    responses?: Record<string, unknown>;
  };
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{ name: string; in: "path" | "query" | "header"; required?: boolean; description?: string; schema?: unknown; example?: unknown }>;
  requestBody?: { required?: boolean; content: Record<string, { schema?: unknown; example?: unknown }> };
  responses: Record<string, { description: string; headers?: Record<string, unknown>; content?: Record<string, { schema?: unknown; example?: unknown }> }>;
  /** "write" when a read-only key can't call it */
  "x-kanbo-access"?: "read" | "write";
}

export const OPENAPI_TITLE = "Kanbo API";
export const OPENAPI_VERSION = "1.0.0";

/** The document, with `serverUrl` (…/functions/v1/api/v1) as its only server. */
export function buildOpenApi(serverUrl: string): OpenApiDoc {
  return {
    openapi: "3.1.0",
    info: {
      title: OPENAPI_TITLE,
      version: OPENAPI_VERSION,
      description: "Read and change your Kanbo tasks, projects and comments from your own tools. Authenticate with an API key from Settings › Developers.",
    },
    servers: [{ url: serverUrl.replace(/\/+$/, "") }],
    security: [{ bearerAuth: [] }],
    // a1's paths, then a2's webhook management paths (webhooks.ts)
    paths: { ...webhookOpenApiPaths },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "kanbo_sk_… (read & write) or kanbo_pk_… (read-only)" },
      },
    },
  };
}

// ============================================================
// KANBO — MCP: reading a JSON-RPC message off Streamable HTTP.
//
// A dual-era server. Modern clients (2026-07-28) put the version and their
// capabilities in every request's _meta and mirror them in headers; there's no
// handshake. Legacy clients (2025-03-26 to 2025-11-25) open with initialize and
// send a version header after that. Stateless either way: no session is ever
// minted, and Mcp-Session-Id and Last-Event-ID are ignored.
//
// Pure module: protocol.test.ts.
// ============================================================

export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const ALL_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
/** A request with no version header at all reads as this (the spec's own rule). */
export const DEFAULT_LEGACY_VERSION = "2025-03-26";
export const LATEST_LEGACY_VERSION = LEGACY_VERSIONS[0];

export const META_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export const RPC = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022,
} as const;

export type RpcId = string | number;

export interface RpcFault {
  status: number;
  code: number;
  message: string;
  id?: RpcId;
  data?: unknown;
}

export type Message =
  /** a request we must answer */
  | { kind: "request"; era: "modern" | "legacy"; version: string; id: RpcId; method: string; params: Record<string, unknown> }
  /** nothing to answer: 202 */
  | { kind: "notification"; method: string }
  /** a client's answer to something we never asked: 202 */
  | { kind: "response" };

export type Read = { ok: true; message: Message } | { ok: false; fault: RpcFault };

const fault = (status: number, code: number, message: string, id?: RpcId, data?: unknown): Read =>
  ({ ok: false, fault: { status, code, message, ...(id !== undefined ? { id } : {}), ...(data !== undefined ? { data } : {}) } });

/** The =?base64?…?= form a client uses for a header value that isn't plain ASCII. Null when it's malformed. */
export function decodeHeaderValue(raw: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(raw);
  if (!m) return raw.startsWith("=?base64?") ? null : raw;
  try {
    const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return null; }
}

/** A header's value has only visible ASCII, spaces and tabs. */
// deno-lint-ignore no-control-regex
const headerSafe = (v: string) => !/[^\x20-\x7E\t]/.test(v);

/**
 * One POST body + its headers → the message to act on, or the error to send.
 * The checks follow the 2026-07-28 transport page: modern requests must carry
 * headers that match the body, so nothing routing on a header can be fooled.
 */
export function readMessage(bodyText: string, headers: Headers): Read {
  let msg: unknown;
  try { msg = JSON.parse(bodyText); } catch { return fault(400, RPC.PARSE, "That isn't valid JSON."); }
  if (Array.isArray(msg)) return fault(400, RPC.INVALID_REQUEST, "Send one JSON-RPC message at a time: batches aren't supported.");
  if (!msg || typeof msg !== "object") return fault(400, RPC.INVALID_REQUEST, "Send a JSON-RPC 2.0 message.");
  const m = msg as Record<string, unknown>;
  if (m.jsonrpc !== "2.0") return fault(400, RPC.INVALID_REQUEST, "Send a JSON-RPC 2.0 message.");
  const hasId = m.id !== undefined;
  if (m.method === undefined) {
    if (hasId && (m.result !== undefined || m.error !== undefined)) return { ok: true, message: { kind: "response" } };
    return fault(400, RPC.INVALID_REQUEST, "A request needs a method.");
  }
  if (typeof m.method !== "string" || !m.method) return fault(400, RPC.INVALID_REQUEST, "The method must be a string.");
  if (!hasId) return { ok: true, message: { kind: "notification", method: m.method } };
  if (typeof m.id !== "string" && typeof m.id !== "number") return fault(400, RPC.INVALID_REQUEST, "A request's id must be a string or a number.");
  const id = m.id as RpcId;
  if (m.params !== undefined && (!m.params || typeof m.params !== "object" || Array.isArray(m.params))) {
    return fault(400, RPC.INVALID_PARAMS, "params must be an object.", id);
  }
  const params = (m.params ?? {}) as Record<string, unknown>;
  const meta = params._meta && typeof params._meta === "object" ? params._meta as Record<string, unknown> : null;
  const metaVersion = meta?.[META_VERSION];
  const headerVersion = headers.get("mcp-protocol-version")?.trim() ?? null;

  // initialize opens a legacy session, whatever else it carries
  const claimsLegacy = typeof metaVersion === "string" && (LEGACY_VERSIONS as readonly string[]).includes(metaVersion);
  if (m.method === "initialize") return { ok: true, message: { kind: "request", era: "legacy", version: DEFAULT_LEGACY_VERSION, id, method: m.method, params } };

  if (typeof metaVersion === "string" && !claimsLegacy) {
    // ---- modern: the version is in _meta and the headers mirror the body ----
    if (headerVersion === null) return fault(400, RPC.HEADER_MISMATCH, "The MCP-Protocol-Version header is missing.", id);
    if (headerVersion !== metaVersion) return fault(400, RPC.HEADER_MISMATCH, `The MCP-Protocol-Version header (${headerVersion.slice(0, 40)}) doesn't match the request's protocol version.`, id);
    if (!(MODERN_VERSIONS as readonly string[]).includes(metaVersion)) {
      return fault(400, RPC.UNSUPPORTED_VERSION, "Unsupported protocol version.", id, { supported: ALL_VERSIONS, requested: metaVersion.slice(0, 40) });
    }
    const caps = meta?.[META_CAPABILITIES];
    if (!caps || typeof caps !== "object" || Array.isArray(caps)) return fault(400, RPC.INVALID_PARAMS, `Every request needs ${META_CAPABILITIES} in its _meta.`, id);
    const methodHeader = headers.get("mcp-method");
    if (methodHeader === null) return fault(400, RPC.HEADER_MISMATCH, "The Mcp-Method header is missing.", id);
    if (!headerSafe(methodHeader)) return fault(400, RPC.HEADER_MISMATCH, "The Mcp-Method header has invalid characters.", id);
    if (methodHeader.trim() !== m.method) return fault(400, RPC.HEADER_MISMATCH, "The Mcp-Method header doesn't match the request's method.", id);
    if (m.method === "tools/call") {
      const nameHeader = headers.get("mcp-name");
      if (nameHeader === null) return fault(400, RPC.HEADER_MISMATCH, "The Mcp-Name header is missing.", id);
      if (!headerSafe(nameHeader)) return fault(400, RPC.HEADER_MISMATCH, "The Mcp-Name header has invalid characters.", id);
      const name = decodeHeaderValue(nameHeader.trim());
      if (name === null) return fault(400, RPC.HEADER_MISMATCH, "The Mcp-Name header's encoding isn't valid.", id);
      if (name !== params.name) return fault(400, RPC.HEADER_MISMATCH, "The Mcp-Name header doesn't match the tool's name.", id);
    }
    return { ok: true, message: { kind: "request", era: "modern", version: metaVersion, id, method: m.method, params } };
  }

  // ---- no modern _meta ----
  if (headerVersion !== null) {
    if ((MODERN_VERSIONS as readonly string[]).includes(headerVersion)) {
      return fault(400, RPC.INVALID_PARAMS, `Requests at ${headerVersion} need ${META_VERSION} and ${META_CAPABILITIES} in their _meta.`, id);
    }
    if (!(LEGACY_VERSIONS as readonly string[]).includes(headerVersion)) {
      return fault(400, RPC.UNSUPPORTED_VERSION, "Unsupported protocol version.", id, { supported: ALL_VERSIONS, requested: headerVersion.slice(0, 40) });
    }
  }
  if (m.method === "server/discover") return fault(400, RPC.INVALID_PARAMS, `server/discover needs ${META_VERSION} and ${META_CAPABILITIES} in its _meta.`, id);
  return { ok: true, message: { kind: "request", era: "legacy", version: headerVersion ?? DEFAULT_LEGACY_VERSION, id, method: m.method, params } };
}

/** initialize's version: the client's if we speak it, otherwise our newest legacy one. */
export function negotiateLegacyVersion(asked: unknown): string {
  return typeof asked === "string" && (LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_LEGACY_VERSION;
}

export const rpcResult = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
export const rpcError = (id: RpcId | undefined, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0" as const,
  ...(id !== undefined ? { id } : {}),
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

/* ------------------------------------------------------------ browsers */

const KNOWN_ORIGINS: ReadonlySet<string> = new Set([
  "https://www.kanbo.co.uk", "https://kanbo.co.uk",
  "https://claude.ai", "https://www.claude.ai", "https://claude.com", "https://www.claude.com",
  "https://chatgpt.com", "https://chat.openai.com", "https://platform.openai.com",
  "https://cursor.com", "https://www.cursor.com",
]);
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?$/;

/** No Origin (a server, a script, a desktop app) is fine; a present Origin must be one we know, or a tool on this computer. */
export function originAllowed(origin: string | null): boolean {
  if (origin === null) return true;
  return KNOWN_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin);
}

/** CORS headers for an allowed browser origin (none for everything else). */
export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !originAllowed(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id",
    "Access-Control-Expose-Headers": "WWW-Authenticate, X-Request-Id",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

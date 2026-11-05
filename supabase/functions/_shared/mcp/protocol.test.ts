// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ALL_VERSIONS, corsHeaders, decodeHeaderValue, META_CAPABILITIES, META_VERSION, negotiateLegacyVersion, originAllowed, readMessage, RPC,
} from "./protocol.ts";

const modernHeaders = (method: string, extra: Record<string, string> = {}) =>
  new Headers({ "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...extra });
const modernBody = (method: string, params: Record<string, unknown> = {}, meta: Record<string, unknown> = { [META_VERSION]: "2026-07-28", [META_CAPABILITIES]: {} }) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } });
const fault = (text: string, h = new Headers()) => {
  const r = readMessage(text, h);
  if (r.ok) throw new Error("expected a fault");
  return r.fault;
};
const msg = (text: string, h = new Headers()) => {
  const r = readMessage(text, h);
  if (!r.ok) throw new Error(r.fault.message);
  return r.message;
};

describe("readMessage: JSON-RPC", () => {
  it("refuses what isn't JSON-RPC", () => {
    expect(fault("not json")).toMatchObject({ status: 400, code: RPC.PARSE });
    expect(fault("[]")).toMatchObject({ status: 400, code: RPC.INVALID_REQUEST });
    expect(fault(`[{"jsonrpc":"2.0","id":1,"method":"ping"}]`).message).toMatch(/batches/);
    expect(fault("1")).toMatchObject({ code: RPC.INVALID_REQUEST });
    expect(fault(`{"id":1,"method":"ping"}`)).toMatchObject({ code: RPC.INVALID_REQUEST });
    expect(fault(`{"jsonrpc":"2.0","id":1}`)).toMatchObject({ code: RPC.INVALID_REQUEST });
    expect(fault(`{"jsonrpc":"2.0","id":1,"method":5}`)).toMatchObject({ code: RPC.INVALID_REQUEST });
    expect(fault(`{"jsonrpc":"2.0","id":null,"method":"ping"}`)).toMatchObject({ code: RPC.INVALID_REQUEST });
    expect(fault(`{"jsonrpc":"2.0","id":true,"method":"ping"}`)).toMatchObject({ code: RPC.INVALID_REQUEST });
    expect(fault(`{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}`)).toMatchObject({ code: RPC.INVALID_PARAMS, id: 1 });
  });
  it("notifications and responses need no answer", () => {
    expect(msg(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)).toEqual({ kind: "notification", method: "notifications/initialized" });
    expect(msg(`{"jsonrpc":"2.0","id":3,"result":{}}`)).toEqual({ kind: "response" });
    expect(msg(`{"jsonrpc":"2.0","id":3,"error":{"code":1,"message":"x"}}`)).toEqual({ kind: "response" });
  });
});

describe("readMessage: legacy", () => {
  it("initialize opens the legacy era, whatever else it has", () => {
    expect(msg(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`)).toMatchObject({ kind: "request", era: "legacy", method: "initialize" });
    expect(msg(`{"jsonrpc":"2.0","id":"a","method":"initialize"}`, new Headers({ "MCP-Protocol-Version": "2026-07-28" }))).toMatchObject({ era: "legacy" });
  });
  it("no header reads as 2025-03-26; a known one is kept", () => {
    expect(msg(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)).toMatchObject({ era: "legacy", version: "2025-03-26" });
    expect(msg(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, new Headers({ "MCP-Protocol-Version": "2025-11-25" }))).toMatchObject({ era: "legacy", version: "2025-11-25" });
  });
  it("an unknown version is refused, listing what's supported", () => {
    expect(fault(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, new Headers({ "MCP-Protocol-Version": "1999-01-01" }))).toMatchObject({ status: 400, code: RPC.UNSUPPORTED_VERSION, data: { supported: ALL_VERSIONS, requested: "1999-01-01" } });
  });
  it("a modern header with no _meta is a mistake, and so is discover without one", () => {
    expect(fault(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, new Headers({ "MCP-Protocol-Version": "2026-07-28" }))).toMatchObject({ status: 400, code: RPC.INVALID_PARAMS });
    expect(fault(`{"jsonrpc":"2.0","id":1,"method":"server/discover"}`)).toMatchObject({ status: 400, code: RPC.INVALID_PARAMS });
  });
  it("a legacy version in _meta stays legacy", () => {
    expect(msg(modernBody("tools/list", {}, { [META_VERSION]: "2025-06-18" }))).toMatchObject({ era: "legacy" });
  });
});

describe("readMessage: modern", () => {
  it("reads a good request", () => {
    expect(msg(modernBody("server/discover"), modernHeaders("server/discover"))).toMatchObject({ kind: "request", era: "modern", version: "2026-07-28", method: "server/discover" });
    expect(msg(modernBody("tools/call", { name: "whoami" }), modernHeaders("tools/call", { "Mcp-Name": "whoami" }))).toMatchObject({ era: "modern" });
  });
  it("needs the version header, and it must match", () => {
    expect(fault(modernBody("tools/list"), new Headers({ "Mcp-Method": "tools/list" }))).toMatchObject({ status: 400, code: RPC.HEADER_MISMATCH });
    expect(fault(modernBody("tools/list"), modernHeaders("tools/list", { "MCP-Protocol-Version": "2025-11-25" }))).toMatchObject({ status: 400, code: RPC.HEADER_MISMATCH });
  });
  it("an unsupported version says what is", () => {
    const body = modernBody("tools/list", {}, { [META_VERSION]: "1900-01-01", [META_CAPABILITIES]: {} });
    expect(fault(body, modernHeaders("tools/list", { "MCP-Protocol-Version": "1900-01-01" }))).toMatchObject({ status: 400, code: RPC.UNSUPPORTED_VERSION, data: { requested: "1900-01-01" } });
  });
  it("needs client capabilities", () => {
    expect(fault(modernBody("tools/list", {}, { [META_VERSION]: "2026-07-28" }), modernHeaders("tools/list"))).toMatchObject({ status: 400, code: RPC.INVALID_PARAMS });
    expect(fault(modernBody("tools/list", {}, { [META_VERSION]: "2026-07-28", [META_CAPABILITIES]: [] }), modernHeaders("tools/list"))).toMatchObject({ code: RPC.INVALID_PARAMS });
  });
  it("Mcp-Method must be there and match", () => {
    expect(fault(modernBody("tools/list"), new Headers({ "MCP-Protocol-Version": "2026-07-28" }))).toMatchObject({ code: RPC.HEADER_MISMATCH });
    expect(fault(modernBody("tools/list"), modernHeaders("tools/call"))).toMatchObject({ code: RPC.HEADER_MISMATCH });
  });
  it("Mcp-Name must be there and match on tools/call, and may be encoded", () => {
    expect(fault(modernBody("tools/call", { name: "whoami" }), modernHeaders("tools/call"))).toMatchObject({ code: RPC.HEADER_MISMATCH });
    expect(fault(modernBody("tools/call", { name: "whoami" }), modernHeaders("tools/call", { "Mcp-Name": "delete_task" }))).toMatchObject({ code: RPC.HEADER_MISMATCH });
    expect(msg(modernBody("tools/call", { name: "whoami" }), modernHeaders("tools/call", { "Mcp-Name": `=?base64?${btoa("whoami")}?=` }))).toMatchObject({ era: "modern" });
    expect(fault(modernBody("tools/call", { name: "whoami" }), modernHeaders("tools/call", { "Mcp-Name": "=?base64?***?=" }))).toMatchObject({ code: RPC.HEADER_MISMATCH });
  });
  it("carries the request's id on its error", () => {
    expect(fault(modernBody("tools/list"), new Headers())).toMatchObject({ id: 1 });
  });
});

describe("decodeHeaderValue", () => {
  it("decodes the sentinel, leaves plain values, refuses malformed", () => {
    expect(decodeHeaderValue("plain")).toBe("plain");
    expect(decodeHeaderValue("=?base64?SGVsbG8sIOS4lueVjA==?=")).toBe("Hello, 世界");
    expect(decodeHeaderValue("=?base64?!!?=")).toBeNull();
    expect(decodeHeaderValue("=?base64?abc")).toBeNull();
    expect(decodeHeaderValue("=?base64?/+8=?=")).toBeNull();   // not UTF-8
  });
});

describe("negotiateLegacyVersion", () => {
  it("keeps a version we speak, otherwise answers with our newest legacy one", () => {
    expect(negotiateLegacyVersion("2025-03-26")).toBe("2025-03-26");
    expect(negotiateLegacyVersion("2025-06-18")).toBe("2025-06-18");
    expect(negotiateLegacyVersion("2025-11-25")).toBe("2025-11-25");
    expect(negotiateLegacyVersion("2024-11-05")).toBe("2025-11-25");
    expect(negotiateLegacyVersion("2026-07-28")).toBe("2025-11-25");
    expect(negotiateLegacyVersion(undefined)).toBe("2025-11-25");
  });
});

describe("browsers", () => {
  it("no Origin is fine; known ones and this computer are; others aren't", () => {
    expect(originAllowed(null)).toBe(true);
    for (const o of ["https://www.kanbo.co.uk", "https://claude.ai", "https://chatgpt.com", "http://localhost:6274", "http://127.0.0.1:3000", "http://[::1]:9"]) expect(originAllowed(o), o).toBe(true);
    for (const o of ["https://evil.example", "null", "https://claude.ai.evil.example", "http://claude.ai", "http://localhost.evil.example", "file://"]) expect(originAllowed(o), o).toBe(false);
  });
  it("CORS names the one origin and exposes the sign-in header", () => {
    const h = corsHeaders("https://claude.ai");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://claude.ai");
    expect(h["Access-Control-Expose-Headers"]).toContain("WWW-Authenticate");
    expect(h["Access-Control-Allow-Headers"]).toContain("mcp-protocol-version");
    expect(h.Vary).toBe("Origin");
    expect(corsHeaders("https://evil.example")).toEqual({});
    expect(corsHeaders(null)).toEqual({});
  });
});

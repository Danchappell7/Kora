// @vitest-environment node
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isPublicAddress, isWebhookUrlShapeOk, MAX_CONSECUTIVE_FAILURES, parseSignatureHeader, RETRY_SCHEDULE_MIN, safeEqual,
  signatureHeader, verifySignature, WEBHOOK_EVENT_INFO, WEBHOOK_EVENTS, webhookRoutes,
} from "./webhooks.ts";

const migration = readFileSync(new URL("../../../migrations/0046_api_webhooks_notion.sql", import.meta.url), "utf8");
const SECRET = "whsec_jdGsQXdTNkPSgmI33ZLnz23lIrUXcu9vDtOYAOWNaJQ";
const BODY = JSON.stringify({ id: "evt_1", type: "task.created", createdAt: "2026-10-05T18:00:00.000Z", workspaceId: null, data: {} });

describe("signatures", () => {
  it("t=<unix>,v1=HMAC-SHA256(secret, `${t}.${body}`) in hex — what a receiver computes with any HMAC library", async () => {
    const h = await signatureHeader(SECRET, BODY, 1_760_000_000);
    const expected = createHmac("sha256", SECRET).update(`1760000000.${BODY}`).digest("hex");
    expect(h).toBe(`t=1760000000,v1=${expected}`);
  });
  it("verifies, and refuses tampering, other secrets and stale timestamps", async () => {
    const h = await signatureHeader(SECRET, BODY, 1_760_000_000);
    expect(await verifySignature(SECRET, h, BODY, { nowSec: 1_760_000_100 })).toBe(true);
    expect(await verifySignature(SECRET, h, BODY + " ", { nowSec: 1_760_000_100 })).toBe(false);
    expect(await verifySignature("whsec_other", h, BODY, { nowSec: 1_760_000_100 })).toBe(false);
    expect(await verifySignature(SECRET, h, BODY, { nowSec: 1_760_000_301 })).toBe(false);
    expect(await verifySignature(SECRET, null, BODY)).toBe(false);
  });
  it("accepts several v1 values (rotation) and ignores junk parts", async () => {
    const good = (await signatureHeader(SECRET, BODY, 100)).split("v1=")[1];
    const header = `t=100, v1=${"0".repeat(64)}, v0=zzz, v1=${good}`;
    expect(parseSignatureHeader(header)).toEqual({ t: 100, v1: ["0".repeat(64), good] });
    expect(await verifySignature(SECRET, header, BODY, { nowSec: 100 })).toBe(true);
    expect(parseSignatureHeader("v1=abc")).toBeNull();
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abc")).toBe(true);
  });
});

describe("the URL rule matches public.webhook_url_ok", () => {
  it("accepts public https hostnames", () => {
    for (const u of ["https://hooks.example.com/kanbo?team=w", "https://a.b.example.co.uk:8443/x", "https://hooks.zapier.com/hooks/catch/1/abc/"]) {
      expect(isWebhookUrlShapeOk(u)).toBe(true);
    }
  });
  it("refuses everything the database refuses", () => {
    for (const u of ["http://hooks.example.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x",
      "https://169.254.169.254/latest", "https://2130706433/", "https://[::1]/x", "https://user:pw@hooks.example.com/x",
      "https://metadata.google.internal/x", "https://printer.local/x", "https://intranet/x", "https://a.example.com/x y",
      "javascript:alert(1)", "https://a.example.com/" + "a".repeat(2000), "https://0x7f000001/", "https://x.example.com#frag"]) {
      expect(isWebhookUrlShapeOk(u)).toBe(false);
    }
  });
  it("the SSRF address check fails closed until a2 implements it", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(false);
    expect(webhookRoutes).toEqual([]);
  });
});

describe("constants match the 0046 SQL", () => {
  it("event names = webhook_event_names()", () => {
    const m = /function public\.webhook_event_names\(\)[\s\S]*?array\[([\s\S]*?)\]::text\[\]/.exec(migration);
    const sqlEvents = (m?.[1].match(/'([a-z.]+)'/g) ?? []).map((s) => s.slice(1, -1));
    expect([...WEBHOOK_EVENTS]).toEqual(sqlEvents);
    expect(Object.keys(WEBHOOK_EVENT_INFO).sort()).toEqual([...WEBHOOK_EVENTS].sort());
  });
  it("retry schedule = webhook_record_result's backoff", () => {
    const m = /backoff constant interval\[\] := array\[([^\]]*)\]/.exec(migration);
    const toMin = (s: string) => { const [n, u] = s.split(" "); return Number(n) * (u.startsWith("hour") ? 60 : 1); };
    expect((m?.[1].match(/'([^']+)'/g) ?? []).map((s) => toMin(s.slice(1, -1)))).toEqual([...RETRY_SCHEDULE_MIN]);
  });
  it("switch-off threshold = 20", () => {
    expect(migration).toContain(`w.failure_count >= ${MAX_CONSECUTIVE_FAILURES}`);
  });
});

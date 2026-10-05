// @vitest-environment node
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isPublicAddress, isWebhookUrlShapeOk, MAX_CONSECUTIVE_FAILURES, parseIPv4, parseIPv6, parseSignatureHeader, RETRY_SCHEDULE_MIN, safeEqual,
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
});

describe("the SSRF address check (isPublicAddress)", () => {
  it("accepts public unicast addresses, v4 and v6", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "151.101.1.69", "100.63.255.255", "100.128.0.1", "172.15.255.255",
      "172.32.0.1", "192.169.0.1", "198.20.0.1", "223.255.255.255", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e",
      "[2001:4860:4860::8888]", "::ffff:93.184.216.34", "64:ff9b::808:808", "2001:200::1"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });
  it("refuses private, loopback, link-local, CGNAT, multicast, reserved and documentation ranges", () => {
    for (const ip of ["10.0.0.5", "10.255.255.255", "127.0.0.1", "127.1.2.3", "0.0.0.0", "0.1.2.3", "169.254.169.254",
      "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.254", "192.0.0.8", "192.0.2.10",
      "192.88.99.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250",
      "240.0.0.1", "255.255.255.255"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["::", "::1", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456:789a::1", "fec0::1", "ff02::1", "100::1",
      "2001:db8::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:10::1", "2002:c0a8:101::1", "3fff::1",
      "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "::127.0.0.1", "::ffff:0:10.0.0.1",
      "64:ff9b::a00:1", "64:ff9b::127.0.0.1", "64:ff9b:1::1", "5f00::1"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
  it("fails closed on anything it can't read", () => {
    for (const ip of ["", "localhost", "example.com", "1.2.3", "1.2.3.4.5", "01.2.3.4", "1.2.3.256", "0x7f.0.0.1", "2130706433",
      "1:2:3:4:5:6:7:8:9", "1::2::3", ":::", "12345::1", "::ffff:1.2.3", "g::1", " 8.8.8.8x", null as unknown as string]) {
      expect(isPublicAddress(ip), String(ip)).toBe(false);
    }
  });
  it("parses IPv6 the long way round", () => {
    expect(parseIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6("2001:db8:0:0:0:0:2:1")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 2, 1]);
    expect(parseIPv4("192.168.0.1")).toEqual([192, 168, 0, 1]);
    expect(parseIPv4("192.168.00.1")).toBeNull();
  });
  it("routes are mounted", () => {
    expect(webhookRoutes.length).toBeGreaterThan(5);
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

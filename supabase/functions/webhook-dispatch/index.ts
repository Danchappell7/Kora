// ============================================================
// KANBO — webhook-dispatch (Deno / Supabase Edge Function).          [a2, 0046]
//
// Delivers signed webhooks. Two callers, both with the CRON_SECRET header
// (x-cron-secret), or the service-role key as a bearer token; anyone else
// gets 401:
//   • pg_cron, every minute (SQL in docs/api/webhooks.md), and
//   • the database itself, right after a change is captured
//     (public.webhook_poke() → pg_net, at most one per 3 seconds).
//
// The work is the pure engine in _shared/api/webhookDispatch.ts: fan out new
// events, lease what's due, send each one signed (HMAC-SHA256) to an address
// checked to be public — connecting to exactly that address so a second DNS
// answer can't swap in a private one — and record the result (retries 1m, 5m,
// 30m, 2h, 6h; 20 failures in a row switch the endpoint off with an Inbox
// notice). Everything here runs on the privileged connection: it is the
// dispatcher's own bookkeeping, never work done on behalf of an API key.
//
// Answers at once (202) and keeps working in the background
// (EdgeRuntime.waitUntil) so pg_net's 5-second timeout never cuts it short;
// POST {"wait": true} waits and returns the counts (manual checks).
//
// Deploy:   supabase functions deploy webhook-dispatch --no-verify-jwt
// Secrets:  CRON_SECRET (already set), APP_URL (already set)
//           SUPABASE_DB_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected
// Logs: event, host, status and timing — never secrets, signatures, paths or payloads.
// ============================================================
import { createApiDb } from "../_shared/api/db.ts";
import {
  dohResolver, fetchSender, isRuntimeUnsupported, postPinned, runDispatch, type Conn, type NetApi, type Resolver, type Sender,
} from "../_shared/api/webhookDispatch.ts";
import { safeEqual } from "../_shared/api/webhooks.ts";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// deno-lint-ignore no-explicit-any
const D = Deno as any;

/** Deno.resolveDns when the runtime has it; DNS-over-HTTPS when it doesn't (or can't answer). */
const doh = dohResolver(fetch);
const resolve: Resolver = async (host) => {
  if (typeof D.resolveDns === "function") {
    const [a, aaaa] = await Promise.allSettled([D.resolveDns(host, "A"), D.resolveDns(host, "AAAA")]);
    const got = [
      ...(a.status === "fulfilled" && Array.isArray(a.value) ? a.value : []),
      ...(aaaa.status === "fulfilled" && Array.isArray(aaaa.value) ? aaaa.value : []),
    ].filter((x): x is string => typeof x === "string");
    if (got.length) return got;
    const notFound = (r: PromiseSettledResult<unknown>) =>
      r.status === "rejected" && (r.reason?.name === "NotFound" || /not ?found|no (?:record|data)|nxdomain/i.test(String(r.reason?.message ?? "")));
    // one family answered empty / "no records" and the other likewise: the host really has no address
    if ((a.status === "fulfilled" || notFound(a)) && (aaaa.status === "fulfilled" || notFound(aaaa))) return [];
  }
  return doh(host);
};

/** Connect to the checked address itself (Deno.connect + Deno.startTls); fetch only where the runtime can't. */
const net: NetApi | null = typeof D.connect === "function" && typeof D.startTls === "function"
  ? {
    connect: (o) => D.connect({ hostname: o.hostname, port: o.port, transport: "tcp" }) as Promise<Conn>,
    startTls: (c, o) => D.startTls(c, { hostname: o.hostname }) as Promise<Conn>,
  }
  : null;
let pinnedUnsupported = false;
const viaFetch = fetchSender(fetch);
const send: Sender = async (target, headers, body, timeoutMs) => {
  if (net && !pinnedUnsupported) {
    try {
      return await postPinned(net, target, headers, body, timeoutMs);
    } catch (e) {
      // only "this runtime can't do raw TLS" switches to fetch; an endpoint's own failure never does
      if (isRuntimeUnsupported(e)) {
        pinnedUnsupported = true;
        console.warn("[webhooks] raw TLS isn't available here; sending with fetch (checked DNS first, no redirects)");
      } else {
        throw e;
      }
    }
  }
  return viaFetch(target, headers, body, timeoutMs);
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^\s*bearer\s+/i, "").trim();
  const given = req.headers.get("x-cron-secret") ?? "";
  const authed = (!!cronSecret && !!given && safeEqual(given, cronSecret)) || (!!serviceKey && !!bearer && safeEqual(bearer, serviceKey));
  if (!authed) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) ?? {}; } catch { /* pg_net / cron send {} or nothing */ }

  const appUrl = (Deno.env.get("APP_URL") ?? "").trim().replace(/\/+$/, "") || null;
  let ownHost = "";
  try { ownHost = new URL(Deno.env.get("SUPABASE_URL") ?? "").hostname; } catch { /* not set: nothing extra to block */ }

  // a poke (right after a change; at most one every 3 s) only needs a short run; the minute job sweeps up the rest
  const poke = body.source === "poke";
  const db = createApiDb();
  const job = runDispatch(
    { service: db.service, resolve, send, appUrl, blockedHosts: ownHost ? [ownHost] : [], log: (line) => console.log(line) },
    { deadlineMs: poke ? 15_000 : 40_000, batch: 20, concurrency: 5, leaseSeconds: 90 },
  ).then((stats) => {
    if (stats.attempted || stats.queued || stats.disabled) console.log(`[webhooks] ${JSON.stringify(stats)}`);
    return stats;
  });

  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (body.wait !== true && typeof runtime?.waitUntil === "function") {
    runtime.waitUntil(job.catch((e: unknown) => console.error(`[webhooks] dispatch failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`)));
    return json({ accepted: true, source: typeof body.source === "string" ? body.source.slice(0, 20) : "cron" }, 202);
  }
  try {
    return json({ ok: true, ...(await job) });
  } catch (e) {
    console.error(`[webhooks] dispatch failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return json({ error: "dispatch failed" }, 500);
  }
});

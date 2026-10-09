/* ============================================================
   KANBO — /admin › System status: the live health check, the
   running build and the operations links.                [w9-ops]
   Pure helpers (unit-tested) + one fetch. The `health` edge function
   (supabase/functions/health, verify_jwt off) answers 200/503 with a
   HealthReport; a 404 means it isn't deployed yet.
   Demo mode (no Supabase) gets a realistic healthy report.
   ============================================================ */
import type { HealthCheck, HealthCheckName, HealthReport } from "../../supabase/functions/_shared/health.ts";
import type { BuildInfo } from "./buildInfo";

export type { HealthCheck, HealthCheckName, HealthReport };

export const SUPABASE_REF_FALLBACK = "htnchiljplrnjkwimgla";
export const GITHUB_REPO_FALLBACK = "Danchappell7/Kora";
export const VERCEL_PROJECT_URL = "https://vercel.com/danchappell7-gmailcoms-projects/kora";
/** how long the panel waits for the function before calling it unreachable */
export const HEALTH_CLIENT_TIMEOUT_MS = 10_000;
/** the panel re-checks while it's open and the tab is visible */
export const HEALTH_REFRESH_MS = 60_000;
/** a check slower than this is shown as slow */
export const HEALTH_SLOW_MS = 1000;

export const HEALTH_CHECKS: { key: HealthCheckName; label: string; detail: string }[] = [
  { key: "db", label: "Database", detail: "A quick query with the server key" },
  { key: "auth", label: "Sign-in", detail: "Supabase Auth answering" },
  { key: "storage", label: "File storage", detail: "The attachments bucket" },
  { key: "functions", label: "Edge functions", detail: "The health check itself answering" },
];

export type HealthResult =
  | { state: "ok" | "degraded"; report: HealthReport; httpStatus: number; checkedAt: number; roundTripMs: number }
  | { state: "missing"; httpStatus: 404; checkedAt: number }
  | { state: "unreachable"; reason: "timeout" | "network" | "http"; httpStatus: number | null; checkedAt: number };

/* ---------------- parsing ---------------- */

const parseCheck = (raw: unknown): HealthCheck | null => {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.ok !== "boolean") return null;
  const ms = typeof o.ms === "number" && Number.isFinite(o.ms) && o.ms >= 0 ? Math.round(o.ms) : null;
  const error = typeof o.error === "string" && o.error.trim() ? o.error.trim().slice(0, 80) : null;
  return { ok: o.ok, ms, error };
};

/** The function's answer, checked field by field; null when it isn't a health report. */
export function parseHealthReport(raw: unknown): HealthReport | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const db = parseCheck(o.db), auth = parseCheck(o.auth), storage = parseCheck(o.storage), functions = parseCheck(o.functions);
  if (typeof o.ok !== "boolean" || !db || !auth || !storage || !functions) return null;
  const time = typeof o.time === "string" && !Number.isNaN(Date.parse(o.time)) ? o.time : new Date(0).toISOString();
  const schema = typeof o.schema === "string" && /^[0-9A-Za-z_.-]{1,16}$/.test(o.schema) ? o.schema : null;
  return { ok: o.ok && db.ok && auth.ok && storage.ok && functions.ok, db, auth, storage, functions, time, schema };
}

/* ---------------- fetching ---------------- */

/** The health function's address for a Supabase project URL; null without one. */
export function healthUrl(supabaseUrl: string | null | undefined): string | null {
  const base = (supabaseUrl ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/\s]+$/i.test(base) ? `${base}/functions/v1/health` : null;
}

/** "htnchiljplrnjkwimgla" from https://htnchiljplrnjkwimgla.supabase.co */
export function supabaseRef(supabaseUrl: string | null | undefined): string | null {
  const m = /^https?:\/\/([a-z0-9]{6,40})\.supabase\.co\/?$/i.exec((supabaseUrl ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One live check. Never throws. A plain GET with no headers (no CORS preflight, no credentials). */
export async function fetchHealth(url: string, opts: { fetch?: FetchLike; timeoutMs?: number; now?: () => number } = {}): Promise<HealthResult> {
  const now = opts.now ?? Date.now;
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const started = now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? HEALTH_CLIENT_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { method: "GET", cache: "no-store", credentials: "omit", signal: ac.signal });
    const checkedAt = now();
    if (res.status === 404) return { state: "missing", httpStatus: 404, checkedAt };
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    const report = parseHealthReport(body);
    if (!report || (res.status !== 200 && res.status !== 503)) return { state: "unreachable", reason: "http", httpStatus: res.status, checkedAt };
    return { state: report.ok && res.status === 200 ? "ok" : "degraded", report, httpStatus: res.status, checkedAt, roundTripMs: Math.max(0, Math.round(checkedAt - started)) };
  } catch {
    return { state: "unreachable", reason: ac.signal.aborted ? "timeout" : "network", httpStatus: null, checkedAt: now() };
  } finally {
    clearTimeout(timer);
  }
}

/** Demo mode: a healthy report with believable timings (slightly different each time). */
export function demoHealthResult(now: number = Date.now(), jitter: () => number = Math.random): HealthResult {
  const j = (base: number) => base + Math.round(jitter() * base * 0.4);
  const db = j(34), auth = j(52), storage = j(71);
  const report: HealthReport = {
    ok: true,
    db: { ok: true, ms: db, error: null },
    auth: { ok: true, ms: auth, error: null },
    storage: { ok: true, ms: storage, error: null },
    functions: { ok: true, ms: Math.max(db, auth, storage) + j(6), error: null },
    time: new Date(now).toISOString(),
    schema: "0047",
  };
  return { state: "ok", report, httpStatus: 200, checkedAt: now, roundTripMs: report.functions.ms! + j(90) };
}

/* ---------------- words ---------------- */

/** A check's short reason, in plain English. */
export function checkErrorText(error: string | null | undefined): string {
  const e = (error ?? "").trim();
  if (!e) return "Not answering";
  if (e === "timeout") return "Didn’t answer within 3 seconds";
  if (e === "unreachable") return "Couldn’t connect";
  if (e === "not configured") return "The function is missing its server keys";
  if (e === "bad answer") return "Answered, but not as expected";
  const http = /^HTTP (\d{3})$/.exec(e);
  if (http) return http[1] === "404" ? "Not found (HTTP 404) — has 0047 been run?" : `Error (HTTP ${http[1]})`;
  return e;
}

/** The names of the failing checks, in panel order. */
export function failingChecks(report: HealthReport): string[] {
  return HEALTH_CHECKS.filter((c) => !report[c.key].ok).map((c) => c.label);
}

/** One line for the whole panel (also the live-region text). */
export function healthSummary(result: HealthResult | null): { tone: "ok" | "signal" | "warn" | "neutral"; text: string } {
  if (!result) return { tone: "neutral", text: "Checking…" };
  if (result.state === "ok") return { tone: "ok", text: "All systems working" };
  if (result.state === "missing") return { tone: "warn", text: "Health check not deployed" };
  if (result.state === "unreachable") return { tone: "signal", text: result.reason === "timeout" ? "Health check timed out" : "Couldn’t reach the health check" };
  const failing = failingChecks(result.report);
  if (!failing.length) return { tone: "signal", text: "Something isn’t right" };
  return { tone: "signal", text: failing.length === 1 ? `${failing[0]} is failing` : `${failing.length} checks failing` };
}

/** "just now", "40 sec ago", "12 min ago", "3 hr ago", "yesterday", "5 days ago". */
export function timeAgo(then: number | string | null | undefined, now: number = Date.now()): string {
  if (then == null) return "—";
  const t = typeof then === "number" ? then : Date.parse(then);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} sec ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** "9 Oct 2026, 14:05" in London time. */
export function formatLondon(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(t);
}

/* ---------------- links ---------------- */

export interface OpsLink { id: string; label: string; href: string; detail: string }

/** Where to look next: Supabase, the function's logs, Vercel, the uptime runs, Sentry. */
export function opsLinks(opts: { supabaseUrl?: string | null; build: Pick<BuildInfo, "repo">; sentryIssuesUrl?: string | null }): OpsLink[] {
  const ref = supabaseRef(opts.supabaseUrl) ?? SUPABASE_REF_FALLBACK;
  const repo = opts.build.repo ?? GITHUB_REPO_FALLBACK;
  return [
    { id: "supabase", label: "Supabase", href: `https://supabase.com/dashboard/project/${ref}`, detail: "Database, auth and storage" },
    { id: "functions", label: "Edge functions", href: `https://supabase.com/dashboard/project/${ref}/functions`, detail: "Deploys and logs" },
    { id: "vercel", label: "Vercel", href: `${VERCEL_PROJECT_URL}/deployments`, detail: "App deployments" },
    { id: "uptime", label: "Uptime runs", href: `https://github.com/${repo}/actions/workflows/uptime.yml`, detail: "GitHub Actions, every 10 minutes" },
    { id: "sentry", label: "Sentry", href: opts.sentryIssuesUrl ?? "https://sentry.io/", detail: opts.sentryIssuesUrl ? "Errors and route timings" : "Not set up yet" },
  ];
}

/** The commit's page on GitHub. */
export function commitUrl(sha: string | null | undefined, repo: string | null | undefined): string | null {
  return sha && /^[0-9a-f]{7,40}$/.test(sha) ? `https://github.com/${repo ?? GITHUB_REPO_FALLBACK}/commit/${sha}` : null;
}

/** The command that deploys the function (shown when it's missing). */
export const HEALTH_DEPLOY_COMMAND = `supabase functions deploy health --project-ref ${SUPABASE_REF_FALLBACK} --no-verify-jwt`;

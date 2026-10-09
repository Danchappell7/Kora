/* ============================================================
   KANBO — error monitoring (Sentry)
   Fully env-driven: a no-op until VITE_SENTRY_DSN is set, so it
   stays silent in local/dev and only reports in environments
   where you've configured a DSN.

   What reaches Sentry (and what never does):
   • release      the build's commit (BUILD_INFO.release, a Vite define
                  from VERCEL_GIT_COMMIT_SHA) · environment: VITE_APP_ENV,
                  else Vercel's VERCEL_ENV, else production/development
   • user         a salted SHA-256 of the account id (20 hex) — never the
                  email, name or IP (Sentry is told not to infer it)
   • breadcrumbs  route changes (with the route's template, /p/:id/board)
                  and failed saves (reportError with a write `op`)
   • timings      a sample of page loads and route changes (default 10% in
                  production, 50% in previews; VITE_SENTRY_TRACES_RATE),
                  named by route template, not by address
   • scrubbed     capability tokens (/f/<token>, ?t=), auth tokens in
                  addresses (#access_token=…, ?code=, token_hash), JWTs,
                  Bearer values, API keys, webhook secrets, email
                  addresses, PostgREST filters (they can carry what people
                  typed), and any field named like a secret, everywhere
                  in an event; task text in error context (title, body…);
                  and the labels in Sentry's element paths. A click or
                  keypress breadcrumb, an interaction (INP) span and the
                  page-load's lcp.element / cls.source.N describe the
                  element as `div[aria-label="Task: …"] > button`, with the
                  aria-label, title, name and alt of it and five ancestors:
                  task titles, project and people's names. Those values go
                  (`div[aria-label] > button`); a path that doesn't read
                  cleanly becomes "[element]".
   ============================================================ */
import * as Sentry from "@sentry/react";
import { BUILD_INFO } from "./buildInfo";

const dsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined)?.trim() || undefined;
export const monitoringEnabled = Boolean(dsn);

/* ---------------- environment + sampling ---------------- */

/** VITE_APP_ENV wins, then Vercel's environment, then the build mode. */
export function resolveEnvironment(appEnv: string | undefined | null, vercelEnv: string | undefined | null, prod: boolean): string {
  const explicit = (appEnv ?? "").trim().toLowerCase();
  if (/^[a-z0-9_-]{1,40}$/.test(explicit)) return explicit;
  const vercel = (vercelEnv ?? "").trim().toLowerCase();
  if (vercel === "production" || vercel === "preview" || vercel === "development") return vercel;
  return prod ? "production" : "development";
}

export const MONITORING_ENVIRONMENT = resolveEnvironment(import.meta.env.VITE_APP_ENV as string | undefined, BUILD_INFO.vercelEnv, !!import.meta.env.PROD);

/** A sample rate from the environment: a number 0–1 (or a percentage like "25%"); anything else → the fallback. */
export function parseSampleRate(raw: string | undefined | null, fallback: number): number {
  const s = (raw ?? "").trim();
  if (!s) return fallback;
  const pct = s.endsWith("%");
  const n = Number(pct ? s.slice(0, -1) : s);
  if (!Number.isFinite(n)) return fallback;
  const v = pct ? n / 100 : n;
  return Math.min(1, Math.max(0, v));
}

/** Production is busy: time one route load in ten. Previews: half. Anything else: all. */
export const defaultTracesRate = (environment: string): number =>
  environment === "production" ? 0.1 : environment === "preview" ? 0.5 : 1;

export const ROUTE_SAMPLE_RATE = parseSampleRate(import.meta.env.VITE_SENTRY_TRACES_RATE as string | undefined, defaultTracesRate(MONITORING_ENVIRONMENT));

type SamplerInput = { name?: string; parentSampled?: boolean; attributes?: Record<string, unknown> };
/** Only page loads and route changes are timed (at `rate`); a span that inherits a decision keeps it. */
export function routeLoadSampler(rate: number) {
  return (ctx: SamplerInput): number | boolean => {
    if (typeof ctx.parentSampled === "boolean") return ctx.parentSampled;
    const a = ctx.attributes ?? {};
    const origin = typeof a["sentry.origin"] === "string" ? (a["sentry.origin"] as string) : "";
    if (a["kanbo.route_load"] === true || /^auto\.(pageload|navigation)\b/.test(origin)) return rate;
    return 0;
  };
}

/* ---------------- route templates ---------------- */

const ID_SEG = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]{11,}|[0-9]+)$/i;
/** An address as its route's template: ids and tokens become :id / :token, the query and hash go.
 *  "/p/9f0c…/board?task=…" → "/p/:id/board" · "/f/Ab3…" → "/f/:token". */
export function routeName(pathOrUrl: string): string {
  let path = pathOrUrl || "/";
  try { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) path = new URL(path).pathname; } catch { /* keep as is */ }
  path = path.split(/[?#]/)[0] || "/";
  const seg = path.split("/").filter(Boolean);
  if (!seg.length) return "/";
  if (seg[0] === "f") return "/f/:token";
  const out = seg.map((s, i) => {
    if (seg[0] === "p" && i === 1) return ":id";
    if (seg[0] === "p" && seg[2] === "docs" && i === 3) return ":docId";
    if (seg[0] === "search" && seg[1] === "list" && i === 2) return ":id";
    return ID_SEG.test(s) || s.length > 40 ? ":id" : s;
  });
  return "/" + out.join("/");
}

/* ---------------- scrubbing ---------------- */

/**
 * Capability links never reach Sentry: a public request form's address
 * (/f/<token>) and the token on a form or calendar-feed request (?t=<token>)
 * work for anyone who has them, so page URLs, breadcrumbs and spans carry
 * placeholders instead.
 */
export function scrubCapabilityUrls(text: string): string {
  return text
    .replace(/\/f\/[A-Za-z0-9_-]+/g, "/f/:token")
    .replace(/([?&]t=)[^&#\s"'\\]+/g, "$1:token");
}

// auth redirects (#access_token=…&refresh_token=…, ?code=… for PKCE), email links (?token_hash=)
const AUTH_PARAM = /([?&#](?:access_token|refresh_token|provider_token|provider_refresh_token|id_token|token_hash|token|code|apikey|api_key|key|secret)=)[^&#\s"'\\]+/gi;
// (bounded repeats: linear time on long runs of word characters)
const EMAIL = /[A-Z0-9._%+-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63}){0,8}\.[A-Z]{2,24}\b/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const KANBO_KEY = /\bkanbo_(sk|pk)_[A-Za-z0-9_-]+/g;
const WEBHOOK_SECRET = /\bwhsec_[A-Za-z0-9_+/=-]+/g;
const SLACK_HOOK = /(hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/gi;
// PostgREST filters (rest/v1/tasks?title=ilike.*…*) can carry what someone typed
const REST_QUERY = /(\/(?:rest|storage)\/v1\/[^\s?#"'\\]*)\?[^\s#"'\\]*/g;

/* Sentry's element paths (htmlTreeAsString): `tag#id.class[aria-label="…"][type="…"][name="…"][title="…"][alt="…"]`
   for the element and up to four ancestors, joined by " > ". The values of aria-label, title, name and alt are
   what Kanbo shows people (task titles, project and people's names). */
// strict: a value runs to the `"]` that ends the attribute (another attribute, the next element, or the end)
const DOM_TEXT_ATTR = /\[(aria-label|title|name|alt)="[\s\S]*?"\](?=\[|\s>\s|$)/g;
// loose, for any other text (a serialised DOM event's target): up to the first quote
const DOM_TEXT_ATTR_LOOSE = /\[(aria-label|title|name|alt)="[^"]*"\]/g;
// one element once the labels are gone: a tag (or component name), #id, .classes, then [label] or a short [attr="token"]
const DOM_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*(?:#[^\s#.[\]>"]+)?(?:\.[^\s#.[\]>"]+)*(?:\[(?:aria-label|title|name|alt)\]|\[[a-z][a-z0-9_:.-]{0,40}="[A-Za-z0-9_:.-]{0,40}"\])*$/;

/** A Sentry element path with the labels taken out: `div[aria-label="Task: Q4 plan"] > button.kbtn` →
 *  `div[aria-label] > button.kbtn`. Fails closed: anything that doesn't read as a plain path (a label
 *  with `"]` in it, say) becomes "[element]". */
export function scrubDomPath(path: string): string {
  if (typeof path !== "string" || !path || path === "<unknown>") return path;
  const out = path.replace(DOM_TEXT_ATTR, "[$1]");
  return out.split(" > ").every((seg) => DOM_SEGMENT.test(seg)) ? out : "[element]";
}

/** Every token, secret and address we know of in a piece of text, replaced by a placeholder. */
export function scrubText(text: string): string {
  if (!text) return text;
  return scrubCapabilityUrls(text)
    .replace(DOM_TEXT_ATTR_LOOSE, "[$1]")
    .replace(AUTH_PARAM, "$1:redacted")
    .replace(REST_QUERY, "$1?:redacted")
    .replace(JWT, "[jwt]")
    .replace(BEARER, "$1[redacted]")
    .replace(KANBO_KEY, "kanbo_$1_[redacted]")
    .replace(WEBHOOK_SECRET, "whsec_[redacted]")
    .replace(SLACK_HOOK, "$1[redacted]")
    .replace(EMAIL, "[email]");
}

/** Field names whose value is never sent, wherever they appear. */
const SECRET_KEY = /^(?:password|passwd|pass|secret|client_secret|token|access_token|refresh_token|id_token|provider_token|authorization|cookie|cookies|set-cookie|apikey|api_key|x-api-key|email|e-mail|phone|http\.query|http\.fragment)$/i;
/** Field names that carry what people wrote: dropped from error context and breadcrumb data. */
const CONTENT_KEY = /^(?:title|name|body|description|comment|comments|content|text|note|notes|message|query|search|q|subject|summary|answer|prompt)$/i;

const SKIP_KEYS = new Set(["sdkProcessingMetadata"]);   // Sentry's own internals (scopes): left alone
const isPlain = (v: object): boolean => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };

function redactContent(v: unknown, depth = 0): unknown {
  if (!v || typeof v !== "object" || depth > 6) return v;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = redactContent(v[i], depth + 1); return v; }
  if (!isPlain(v)) return v;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (CONTENT_KEY.test(k) && (typeof o[k] === "string" || Array.isArray(o[k]))) {
      o[k] = typeof o[k] === "string" ? `[redacted ${(o[k] as string).length} chars]` : "[redacted]";
    } else o[k] = redactContent(o[k], depth + 1);
  }
  return v;
}

type SpanLike = { op?: unknown; origin?: unknown; description?: unknown; data?: Record<string, unknown> | null };
type Scrubbable = {
  user?: Record<string, unknown> | null;
  request?: { cookies?: unknown; headers?: Record<string, unknown> } | null;
  extra?: Record<string, unknown>;
  breadcrumbs?: Array<{ category?: unknown; message?: unknown; data?: Record<string, unknown> } | null>;
  spans?: Array<SpanLike | null>;
  contexts?: { trace?: { data?: Record<string, unknown> | null } | null } | null;
  sdk?: Record<string, unknown>;
  sdkProcessingMetadata?: { dynamicSamplingContext?: unknown };
};

/** Span attributes that hold an element path: the page load's largest paint and layout shifts. */
const DOM_PATH_ATTR = /^(?:lcp\.element|cls\.source\.\d+)$/;
function scrubDomPathAttrs(data: Record<string, unknown> | null | undefined): void {
  if (!data || typeof data !== "object") return;
  for (const k of Object.keys(data)) if (DOM_PATH_ATTR.test(k) && typeof data[k] === "string") data[k] = scrubDomPath(data[k] as string);
}

/** A click or keypress breadcrumb (`ui.click`, `ui.input`): its message is the element's path. */
const isUiCrumb = (c: { category?: unknown; message?: unknown }): c is { category: string; message: string } =>
  typeof c.category === "string" && c.category.startsWith("ui.") && typeof c.message === "string";

/** A span named after an element (an interaction / INP span, a layout shift): its description is the path. */
function isElementSpan(sp: SpanLike): boolean {
  const op = typeof sp.op === "string" ? sp.op : "";
  const origin = typeof sp.origin === "string" ? sp.origin : typeof sp.data?.["sentry.origin"] === "string" ? (sp.data["sentry.origin"] as string) : "";
  return /^ui\.(?:interaction|webvital)/.test(op) || /^auto\.(?:http\.browser\.(?:inp|cls)|ui\.browser\.metrics)\b/.test(origin);
}

function scrubSpanLike(sp: SpanLike | null | undefined): void {
  if (!sp || typeof sp !== "object") return;
  if (typeof sp.description === "string" && isElementSpan(sp)) sp.description = scrubDomPath(sp.description);
  scrubDomPathAttrs(sp.data);
}

/** Scrubs every string in plain data in place (scrubText) and drops secret-named fields.
 *  One per pass: it remembers what it has seen (cycles, shared objects). */
function deepScrubber(): (v: unknown, depth: number) => unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return scrubText(v);
    if (!v || typeof v !== "object" || depth > 12 || seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i], depth + 1); return v; }
    if (!isPlain(v)) return v;                                           // plain data only
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (SKIP_KEYS.has(k)) continue;
      if (SECRET_KEY.test(k) && o[k] != null && o[k] !== "") o[k] = "[redacted]";
      else o[k] = walk(o[k], depth + 1);
    }
    return v;
  };
  return walk;
}

/** Every string in an event's plain data, scrubbed in place (page URL, transaction,
 *  breadcrumbs, spans, contexts), secret-named fields dropped, what people wrote kept
 *  out of error context and breadcrumb data, the user reduced to the hashed id, and
 *  Sentry told not to infer an IP address. Also the trace header's transaction name. */
export function scrubEvent<T>(event: T): T {
  const walk = deepScrubber();
  try {
    const e = event as unknown as Scrubbable | null;
    if (e && typeof e === "object") {
      // who: only the hashed id this module set (never an email, username or IP)
      if (e.user) {
        const id = typeof e.user.id === "string" && /^[0-9a-f]{12,64}$/.test(e.user.id) ? e.user.id : null;
        e.user = id ? { id } : null;
        if (!id) delete e.user;
      }
      if (e.request) { delete e.request.cookies; if (e.request.headers) { delete e.request.headers.Cookie; delete e.request.headers.cookie; } }
      if (e.extra) redactContent(e.extra);
      if (Array.isArray(e.breadcrumbs)) for (const b of e.breadcrumbs) {
        if (!b) continue;
        if (b.data) redactContent(b.data);
        if (isUiCrumb(b)) b.message = scrubDomPath(b.message);   // (second lock: beforeBreadcrumb did it already)
      }
      // element paths in a transaction: its spans, and the page load's lcp.element / cls.source.N
      if (Array.isArray(e.spans)) for (const sp of e.spans) scrubSpanLike(sp);
      scrubDomPathAttrs(e.contexts?.trace?.data);
    }
    walk(event, 0);
    const meta = e?.sdkProcessingMetadata;
    if (meta?.dynamicSamplingContext) walk(meta.dynamicSamplingContext, 0);
    // Sentry otherwise infers the sender's IP address for browser events
    if (e && typeof e === "object") e.sdk = { ...(e.sdk ?? {}), settings: { ...((e.sdk?.settings as object) ?? {}), infer_ip: "never" } };
  } catch { /* never stop an error report over this */ }
  return event;
}

/** Breadcrumbs as they're recorded: route changes get their template; addresses are scrubbed;
 *  a click or keypress names its element without the labels (no task titles or people's names). */
export function shapeBreadcrumb<T extends { category?: string; message?: string; data?: Record<string, unknown> }>(crumb: T): T {
  try {
    if (crumb.category === "navigation" && crumb.data) {
      const to = typeof crumb.data.to === "string" ? crumb.data.to : null;
      if (to) crumb.data.route = routeName(to);
    }
    if (isUiCrumb(crumb)) crumb.message = scrubDomPath(crumb.message);
    if (crumb.data) for (const k of ["url", "from", "to"]) if (typeof crumb.data[k] === "string") crumb.data[k] = scrubText(crumb.data[k] as string);
  } catch { /* keep the crumb as it was */ }
  return crumb;
}

/** A span as it's sent (beforeSendSpan: a transaction's spans and standalone ones such as INP):
 *  element paths without their labels, then the same scrub as everything else. */
export function scrubSpan<T>(span: T): T {
  try {
    scrubSpanLike(span as unknown as SpanLike);
    deepScrubber()(span, 0);
  } catch { /* never drop a span over this */ }
  return span;
}

/* ---------------- who ---------------- */

/** A salted SHA-256 of the account id (20 hex characters): stable per person, useless
 *  outside Sentry. Null when the browser can't hash (an insecure context) — then no user is set. */
export async function hashUserId(id: string, subtleCrypto?: SubtleCrypto | null): Promise<string | null> {
  const subtle = subtleCrypto === undefined ? globalThis.crypto?.subtle : subtleCrypto;
  if (!id || !subtle) return null;
  try {
    const buf = await subtle.digest("SHA-256", new TextEncoder().encode(`kanbo-sentry:v1:${id}`));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 20);
  } catch { return null; }
}

/* ---------------- failed saves ---------------- */

/** Is this reportError `op` a write (a failed save) rather than a read? */
export function isSaveOp(op: string | null | undefined): boolean {
  if (!op) return false;
  return !/^(list|get|load|fetch|bootstrap|realtime|confirm|subscribe|read|search|schema|sign|watch|open|poll|check)/i.test(op);
}

/* ---------------- init + API ---------------- */

/** Which part of the site this page is (a low-cardinality tag). */
export function surfaceOf(pathname: string): "app" | "admin" | "public-form" | "legal" {
  const p = pathname.replace(/\/+$/, "");
  if (p === "/admin") return "admin";
  if (/^\/f\//.test(p)) return "public-form";
  if (p === "/privacy" || p === "/terms") return "legal";
  return "app";
}

let initialised = false;

export function initMonitoring(): void {
  if (!dsn || initialised) return;
  initialised = true;
  Sentry.init({
    dsn,
    release: BUILD_INFO.release ?? undefined,
    environment: MONITORING_ENVIRONMENT,
    sendDefaultPii: false,
    integrations: [
      // page-load and navigation spans are named after the route template: never a token or an id
      Sentry.browserTracingIntegration({
        beforeStartSpan: (o) => ({ ...o, name: routeName(o.name), attributes: { ...(o.attributes ?? {}), "kanbo.route_load": true } }),
      }),
    ],
    tracesSampler: routeLoadSampler(ROUTE_SAMPLE_RATE),
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    // noise that says nothing about Kanbo
    ignoreErrors: [/ResizeObserver loop/i],
    denyUrls: [/^(?:chrome|moz|safari(?:-web)?)-extension:\/\//i, /^chrome:\/\//i],
    beforeBreadcrumb: (crumb) => shapeBreadcrumb(crumb),
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeSendSpan: (span) => scrubSpan(span),
  });
  try { Sentry.setTag("surface", surfaceOf(window.location.pathname)); } catch { /* no window */ }
}

/** Report an error (and log it). A context `op` becomes a tag, and a failed write
 *  (createTask, updateTask, flushQueue-retry …) also leaves a "save" breadcrumb, so a
 *  later crash shows the saves that failed before it. */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  if (dsn) {
    const op = typeof context?.op === "string" ? context.op.slice(0, 64) : undefined;
    if (op && isSaveOp(op)) Sentry.addBreadcrumb({ category: "save", level: "error", message: `Save failed: ${op}`, data: { op } });
    Sentry.captureException(error, { extra: context, tags: op ? { op } : undefined });
  }
  // always surface to the console for local debugging
  console.error(error, context ?? "");
}

/** A breadcrumb of our own (no-op without a DSN). Data is scrubbed like everything else. */
export function addBreadcrumb(category: string, message: string, data?: Record<string, unknown>): void {
  if (!dsn) return;
  Sentry.addBreadcrumb({ category, message, data, level: "info" });
}

let userSeq = 0;
/** The signed-in person, as a hashed id only. (The email argument is accepted and ignored.) */
export function setUserContext(user: { id: string; email?: string } | null): void {
  if (!dsn) return;
  const seq = ++userSeq;
  if (!user) { Sentry.setUser(null); return; }
  void hashUserId(user.id).then((hash) => { if (seq === userSeq) Sentry.setUser(hash ? { id: hash } : null); });
}

/* ---------------- for /admin › System status ---------------- */

export interface MonitoringInfo {
  enabled: boolean;
  environment: string;
  release: string | null;
  /** the share of route loads timed (0–1) */
  tracesRate: number;
  /** the Sentry project's issues page, when the DSN says which project */
  issuesUrl: string | null;
}

/** Where a DSN's issues live: sentry.io's org redirect with the project id (no key, no secret). */
export function sentryIssuesUrl(rawDsn: string | null | undefined): string | null {
  if (!rawDsn) return null;
  try {
    const u = new URL(rawDsn);
    const project = u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (!/^\d+$/.test(project)) return null;
    if (/(^|\.)sentry\.io$/i.test(u.hostname)) return `https://sentry.io/orgredirect/organizations/:orgslug/issues/?project=${project}`;
    return `${u.protocol}//${u.host}/`;   // self-hosted: its own address
  } catch { return null; }
}

export function monitoringInfo(): MonitoringInfo {
  return {
    enabled: monitoringEnabled,
    environment: MONITORING_ENVIRONMENT,
    release: BUILD_INFO.release,
    tracesRate: ROUTE_SAMPLE_RATE,
    issuesUrl: sentryIssuesUrl(dsn),
  };
}

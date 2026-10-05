/* ============================================================
   KANBO — error monitoring (Sentry)
   Fully env-driven: a no-op until VITE_SENTRY_DSN is set, so it
   stays silent in local/dev and only reports in environments
   where you've configured a DSN.
   ============================================================ */
import * as Sentry from "@sentry/react";

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
export const monitoringEnabled = Boolean(dsn);

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

const SKIP_KEYS = new Set(["sdkProcessingMetadata"]);   // Sentry's own internals (scopes): left alone
/** Every string in an event's plain data, scrubbed in place (page URL, transaction,
 *  breadcrumbs, spans, contexts), and the trace header's transaction name. */
export function scrubEvent<T>(event: T): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return scrubCapabilityUrls(v);
    if (!v || typeof v !== "object" || depth > 12 || seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i], depth + 1); return v; }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;          // plain data only
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!SKIP_KEYS.has(k)) o[k] = walk(o[k], depth + 1);
    return v;
  };
  try {
    walk(event, 0);
    const meta = (event as { sdkProcessingMetadata?: { dynamicSamplingContext?: unknown } } | null)?.sdkProcessingMetadata;
    if (meta?.dynamicSamplingContext) walk(meta.dynamicSamplingContext, 0);
  } catch { /* never stop an error report over this */ }
  return event;
}

export function initMonitoring(): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: (import.meta.env.VITE_APP_ENV as string) || (import.meta.env.PROD ? "production" : "development"),
    // page-load and navigation spans are named after the address: never a form's token
    integrations: [Sentry.browserTracingIntegration({ beforeStartSpan: (o) => ({ ...o, name: scrubCapabilityUrls(o.name) }) })],
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  });
}

export function reportError(error: unknown, context?: Record<string, unknown>): void {
  if (dsn) Sentry.captureException(error, context ? { extra: context } : undefined);
  // always surface to the console for local debugging
  console.error(error, context ?? "");
}

export function setUserContext(user: { id: string; email?: string } | null): void {
  if (!dsn) return;
  Sentry.setUser(user ? { id: user.id, email: user.email } : null);
}

/* ============================================================
   KANBO — error monitoring (Sentry)
   Fully env-driven: a no-op until VITE_SENTRY_DSN is set, so it
   stays silent in local/dev and only reports in environments
   where you've configured a DSN.
   ============================================================ */
import * as Sentry from "@sentry/react";

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
export const monitoringEnabled = Boolean(dsn);

export function initMonitoring(): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: (import.meta.env.VITE_APP_ENV as string) || (import.meta.env.PROD ? "production" : "development"),
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
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

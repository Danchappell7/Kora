// ============================================================
// KANBO — uptime: the `health` edge function's answer, shared with the
// /admin console's System status panel.                       [architect → w9]
//
// GET https://<ref>.supabase.co/functions/v1/health  (verify_jwt OFF; no
// secrets in the answer). Each check runs with its own timeout
// (HEALTH_TIMEOUT_MS) and never throws; `ok` is every check's ok. 200 when
// ok, 503 when not (the GitHub Actions uptime job fails on non-200).
//   db        rpc kanbo_health() with the service role (0047): one cheap query
//   auth      GET /auth/v1/health
//   storage   list one bucket (service role)
//   functions this function answering at all (always ok when it answers)
// Pure module: the app imports the types.
// ============================================================

export const HEALTH_TIMEOUT_MS = 3000;

export type HealthCheckName = "db" | "auth" | "storage" | "functions";

export interface HealthCheck {
  ok: boolean;
  /** how long the check took; null when it didn't run */
  ms: number | null;
  /** a short reason when not ok ("timeout", "HTTP 500") — never a secret or a stack */
  error?: string | null;
}

export interface HealthReport {
  ok: boolean;
  db: HealthCheck;
  auth: HealthCheck;
  storage: HealthCheck;
  functions: HealthCheck;
  /** ISO time the answer was made */
  time: string;
  /** the latest applied migration ("0047"), from kanbo_health() */
  schema?: string | null;
}

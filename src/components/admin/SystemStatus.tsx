/* ============================================================
   KANBO — /admin › System status.                      [0047 stub → w9]
   A live health check (the `health` edge function: database, auth,
   storage, functions — each with its time), the running build (release
   commit + when it was built), and links to Supabase, Vercel, GitHub
   Actions (uptime runs) and Sentry. Admin console only.
   Renders nothing until package w9 builds it.
   ============================================================ */

export interface SystemStatusProps {
  /** the running build's commit (Vite define from VERCEL_GIT_COMMIT_SHA); null locally */
  release?: string | null;
  /** when that build ran (ISO); null locally */
  builtAt?: string | null;
}

export function SystemStatus(_props: SystemStatusProps) {
  return null;
}

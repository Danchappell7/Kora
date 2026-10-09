/* ============================================================
   KANBO — is there a backend? (both Supabase env vars set). Its own
   module, with no import of supabase-js, so code that only needs to
   know (the demo data, the first download) never loads the client.
   lib/supabase re-exports it.
   ============================================================ */
export const isSupabaseConfigured = Boolean(
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) && (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined),
);

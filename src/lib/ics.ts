/* ============================================================
   KANBO — iCalendar builder, shared with the ics-feed edge function. [f7-calendar]
   The one copy lives in supabase/functions/_shared/ics.ts (pure, no Deno
   globals) so the function and the app can never drift; this file only
   re-exports it for the web app and its tests.
   ============================================================ */
export * from "../../supabase/functions/_shared/ics.ts";

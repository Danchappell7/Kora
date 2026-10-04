// ============================================================
// KANBO — private calendar feed (Deno / Supabase Edge Function).   [f7-calendar]
// "Add Kanbo to your calendar": Google Calendar, Outlook and Apple Calendar
// subscribe to
//   GET https://<project>.supabase.co/functions/v1/ics-feed?t=<feed token>
// and poll it. No OAuth and no Supabase JWT: the unguessable per-person token
// (public.calendar_feed_tokens, migration 0043) is the only credential, looked
// up with the service role. The feed holds that person's planned blocks for
// today and the next 14 days (busy) and, if they want them, their due dates
// (all-day, free), each linking back to <APP_URL>/?task=<id>.
//
// All the logic (and its tests) lives in ../_shared/icsFeed.ts and
// ../_shared/ics.ts; this file only wires in the environment.
//
// Deploy:  supabase functions deploy ics-feed --no-verify-jwt
// Secrets: APP_URL (already set for the reminder emails)
// Needs:   migration 0043 (and 0042's rate_limits for throttling; fails open)
// Owner steps: docs/integrations/calendar-feed.md
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleFeedRequest } from "../_shared/icsFeed.ts";

// the live app, when APP_URL isn't set (links must be absolute in a calendar)
const DEFAULT_APP_URL = "https://www.kanbo.co.uk";

Deno.serve((req) => {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const appUrl = (Deno.env.get("APP_URL") || DEFAULT_APP_URL).replace(/\/+$/, "");
  if (!url || !serviceKey) {
    return Promise.resolve(new Response("Calendar feed is not configured.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    }));
  }
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return handleFeedRequest(req, { db, appUrl });
});

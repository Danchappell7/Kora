// ============================================================
// KANBO — the Kanbo Slack app (Deno / Supabase Edge Function). [0049]
//
//   https://htnchiljplrnjkwimgla.supabase.co/functions/v1/slack-app
//
// Slack calls this one address for the /kanbo slash command, buttons and
// modals (interactivity), the modal's pickers (options loads) and events
// (link previews, the Home tab): docs/integrations/slack-app-manifest.json.
// Everything is in ../_shared/slackAppHandler.ts (verified, routed, rate
// limited, and run AS the linked Kanbo person with RLS); this file only
// wires in the secrets, the database and Slack.
//
//   • SLACK_SIGNING_SECRET — every request's X-Slack-Signature is checked
//     with it (v0 HMAC-SHA256, constant time, 5-minute window). Not set →
//     every request is refused (503).
//   • SLACK_BOT_TOKEN — the app's xoxb- token for Slack's Web API (views,
//     ephemeral messages, unfurls, permalinks, users.info). Only ever in the
//     Authorization header to slack.com; never logged, never stored.
//   • SUPABASE_DB_URL (injected) — ../_shared/api/db.ts: the privileged
//     connection for the Slack-side tables and rate limits only; every task,
//     project and person read or write runs in withUser() as the linked
//     person (SET LOCAL ROLE authenticated + their JWT claims).
//   • APP_URL (already set) — links into Kanbo and the /link/slack page.
//   • optional SLACK_APP_TZ — the day "fri" counts from when Slack doesn't
//     say the person's zone (default Europe/London).
//
// Deploy:  supabase functions deploy slack-app --no-verify-jwt --project-ref htnchiljplrnjkwimgla
//          (config.toml has verify_jwt = false: Slack signs its requests,
//          it has no Supabase JWT.)
// Needs:   migrations 0046 (rate limits, user_can_act) and 0049.
// ============================================================
import { createApiDb, type ApiDb } from "../_shared/api/db.ts";
import { safeErrorNote } from "../_shared/slack.ts";
import { slackApi } from "../_shared/slackAppApi.ts";
import { handleSlackRequest, type SlackAppDeps } from "../_shared/slackAppHandler.ts";

const APP_URL = (Deno.env.get("APP_URL") || "https://www.kanbo.co.uk").replace(/\/+$/, "");
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "https://htnchiljplrnjkwimgla.supabase.co").replace(/\/+$/, "");
const SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET") ?? "";
const BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN") ?? "";

/** 32 random bytes, base64url (43 characters): a one-time link token. */
function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Supabase's runtime keeps an isolate alive for promises handed to EdgeRuntime.waitUntil
// (work finished after Slack has had its answer). Without it, the promise still runs.
declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;
const waitUntil = (p: Promise<unknown>) => {
  try {
    if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime?.waitUntil === "function") { EdgeRuntime.waitUntil(p); return; }
  } catch { /* fall through */ }
  p.catch(() => {});
};

let deps: SlackAppDeps | null = null;
function wire(db: ApiDb): SlackAppDeps {
  deps ??= {
    db,
    slack: slackApi(BOT_TOKEN, { fetch: (u, i) => fetch(u, i) }),
    signingSecret: SIGNING_SECRET,
    appUrl: APP_URL,
    apiBase: `${SUPABASE_URL}/functions/v1/api/v1`,
    tz: Deno.env.get("SLACK_APP_TZ") || "Europe/London",
    now: () => Date.now(),
    waitUntil,
    // never a token, a secret or a request body: messages and Slack's error words only
    log: (level, msg, extra) => (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(msg, JSON.stringify(extra ?? {})),
    newToken,
  };
  return deps;
}

let db: ApiDb | null = null;

Deno.serve(async (req) => {
  try {
    db ??= createApiDb();
  } catch (e) {
    console.error("[slack-app] database not configured:", safeErrorNote(e));
    return new Response("Unavailable", { status: 503 });
  }
  return handleSlackRequest(req, wire(db));
});

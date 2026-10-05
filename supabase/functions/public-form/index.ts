// ============================================================
// KANBO — public request forms (Deno / Supabase Edge Function). [f9-public-forms]
//
// The page at https://www.kanbo.co.uk/f/<token> (src/public/PublicFormPage)
// talks to this function. People without an account read the form and file
// one request through it; the request becomes a task in the form's project,
// run through the project's "When a task is created" rules, assigned to the
// project's owner unless a rule says otherwise, with an Inbox item for them.
//
//   GET  /functions/v1/public-form?t=<token>   → { form } | 404 | 410 | 429
//   POST /functions/v1/public-form?t=<token>   → { ok, reference } | 400 | 404 | 410 | 429 | 503
//   GET  /functions/v1/public-form?ping        → { ok: true }
//
// Everything that matters is in handler.ts (pure, unit-tested); this file
// reads the request, makes the service-role client and adds CORS.
// Signed-out callers, so the gateway JWT check is OFF (config.toml):
// the unguessable token, the enabled flag, the honeypot and the rate
// limits are the gate. The service role key never leaves this function.
//
// Deploy:  supabase functions deploy public-form --no-verify-jwt
// Needs:   migrations 0042 (rate_limits) and 0043 (forms.public_token).
//          No secrets beyond the built-in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { clientIp, hashKey, hit, refund, sweep } from "../_shared/limits.ts";
import { FAILURE_MESSAGES, MAX_BODY_BYTES } from "../_shared/publicForm.ts";
import { handlePublicForm } from "./handler.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      // the form can be switched off at any moment: never cache an answer
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });

/** The body as text, or null once it passes `cap` bytes (a slow, huge upload stops early). */
async function readCapped(req: Request, cap: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > cap) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("public-form: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
    return json({ reason: "unavailable", error: FAILURE_MESSAGES.unavailable }, 503);
  }
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const body = req.method === "POST" ? await readCapped(req, MAX_BODY_BYTES) : undefined;
    const res = await handlePublicForm(
      { method: req.method, token: url.searchParams.get("t"), ip: clientIp(req.headers), body, ping: url.searchParams.has("ping") },
      {
        db: admin,
        hit: (key, opts) => hit(admin, key, opts),
        refund: (key) => refund(admin, key),
        hash: hashKey,
        randomId: () => crypto.randomUUID(),
        // codes and messages only: never names, emails or tokens
        log: (message, detail) => console.warn(message, detail ?? ""),
      },
    );
    if (req.method === "POST" && res.status === 200) await sweep(admin);
    return json(res.body, res.status, res.headers);
  } catch (e) {
    console.error("public-form error", String((e as Error)?.message ?? e).slice(0, 200));
    return json({ reason: "unavailable", error: FAILURE_MESSAGES.unavailable }, 503);
  }
});

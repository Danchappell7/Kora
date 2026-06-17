// ============================================================
// KANBO — permanently delete the signed-in user's account (Deno / Supabase)
// Deploy:  supabase functions deploy delete-account
// Secrets: (none beyond the auto-injected SUPABASE_URL / keys)
//
// Verifies the caller from their JWT, then uses the service-role key to
// delete that auth user. Every user-owned table references auth.users with
// ON DELETE CASCADE (tasks, subtasks, comments, activity, profiles,
// attachments, subscriptions, workspace_members…), so removing the auth
// user wipes all of their data in one shot. A user can only ever delete
// themselves — the id comes from the verified token, never the request body.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: ures } = await supa.auth.getUser();
    if (!ures?.user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error } = await admin.auth.admin.deleteUser(ures.user.id);
    if (error) return json({ error: error.message }, 400);

    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ============================================================
// KANBO — permanently delete the signed-in user's account (Deno / Supabase)
// Deploy:  supabase functions deploy delete-account
// Secrets: (none beyond the auto-injected SUPABASE_URL / keys)
//
// Verifies the caller from their JWT, then uses the service-role key to
// delete that auth user. Their personal data goes with them (ON DELETE
// CASCADE); their work in team workspaces stays with the team — the
// before-delete trigger from migration 0041 hands any workspace they own to
// the next admin/member and re-attributes their tasks/projects/comments.
// A user can only ever delete themselves — the id comes from the verified
// token, never the request body.
// Their face photos ("<uid>/avatar-*" in the public avatars bucket) are not
// part of that cascade, so they are removed first (best-effort; workspace
// logos stay with the workspaces). This covers every route to deletion, not
// just the Settings screen's own clean-up.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { forgetRemovedAvatar, removeAvatarPhotos } from "../_shared/avatars.ts";

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

    const uid = ures.user.id;
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const photos = await removeAvatarPhotos(admin, uid);
    const { error } = await admin.auth.admin.deleteUser(uid);
    if (error) {
      // still here, so don't leave the profile pointing at a photo just removed
      await forgetRemovedAvatar(admin, uid, photos);
      return json({ error: error.message }, 400);
    }

    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

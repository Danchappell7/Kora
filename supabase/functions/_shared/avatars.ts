// ============================================================
// KANBO — face-photo clean-up when an account is deleted (service role).
//
// Profile photos live in the PUBLIC avatars bucket at "<uid>/avatar-*". Storage
// objects are not covered by the account's ON DELETE CASCADE, so without this a
// deleted person's face stays reachable at its public URL for ever. Workspace
// logos share the folder ("<uid>/wslogo-*") and are left alone: those
// workspaces pass to the next admin (0041's before-delete trigger).
//
// Both helpers are best-effort and never throw: a leftover file must never be
// the reason an account can't be deleted.
//
// Pure module (no Deno globals, no remote imports) so vitest can exercise it
// with an in-memory fake client: see avatars.test.ts.
// ============================================================

export const AVATAR_BUCKET = "avatars";

/** The slice of a supabase-js service-role client these helpers use. */
export type StorageAdmin = {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
  storage: {
    from(bucket: string): {
      list(path: string, opts: { limit: number }): Promise<{ data: { name: string }[] | null; error: { message: string } | null }>;
      remove(paths: string[]): Promise<{ data: unknown; error: { message: string } | null }>;
    };
  };
};

/** Remove every "<uid>/avatar-*" photo. Returns the paths it removed. */
export async function removeAvatarPhotos(admin: StorageAdmin, uid: string): Promise<string[]> {
  if (!uid) return [];
  try {
    const bucket = admin.storage.from(AVATAR_BUCKET);
    const { data, error } = await bucket.list(uid, { limit: 1000 });
    if (error) { console.warn("[avatars] couldn't list photos:", error.message); return []; }
    const mine = (data ?? [])
      .filter((o) => typeof o?.name === "string" && o.name.startsWith("avatar-"))
      .map((o) => `${uid}/${o.name}`);
    if (!mine.length) return [];
    const { error: rmErr } = await bucket.remove(mine);
    if (rmErr) { console.warn("[avatars] couldn't remove photos:", rmErr.message); return []; }
    return mine;
  } catch (e) {
    console.warn("[avatars] photo clean-up failed:", e);
    return [];
  }
}

/**
 * The account survived (deletion failed) but its photos are gone: stop the
 * profile pointing at one of them, so teammates don't see a broken image.
 * Leaves any other picture (e.g. a Google profile photo) untouched.
 */
export async function forgetRemovedAvatar(admin: StorageAdmin, uid: string, removed: string[]): Promise<void> {
  if (!uid || !removed.length) return;
  try {
    const { data, error } = await admin.from("profiles").select("avatar_url").eq("id", uid).maybeSingle();
    if (error) { console.warn("[avatars] couldn't read the profile:", error.message); return; }
    let path = "";
    try { path = decodeURIComponent(new URL(String(data?.avatar_url ?? "")).pathname); } catch { return; }
    if (!removed.some((p) => path.endsWith(`/${AVATAR_BUCKET}/${p}`))) return;
    const { error: upErr } = await admin.from("profiles").update({ avatar_url: null }).eq("id", uid);
    if (upErr) console.warn("[avatars] couldn't clear the profile photo:", upErr.message);
  } catch (e) {
    console.warn("[avatars] couldn't clear the profile photo:", e);
  }
}

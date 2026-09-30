// ============================================================
// KANBO — look up an existing auth account by email (service role).
// profiles.email mirrors the real auth email for every account (0041 creates
// a profile row at signup and stops users spoofing it), so it's the index we
// search; the auth record then tells us whether they've ever signed in.
// ============================================================

export interface FoundUser {
  id: string;
  /** they have signed in before, so they already have a way in (password/Google) */
  hasSignedIn: boolean;
  approved: boolean | null;
  suspended: boolean;
}

// deno-lint-ignore no-explicit-any
type Admin = { from(t: string): any; auth: { admin: { getUserById(id: string): Promise<any> } } };

export async function findUserByEmail(admin: Admin, email: string): Promise<FoundUser | null> {
  const e = email.trim().toLowerCase();
  const { data: rows, error } = await admin.from("profiles")
    .select("id,approved,suspended").eq("email", e).limit(2);
  if (error) { console.warn("[users] profile lookup failed:", error.message); return null; }
  const row = (rows ?? [])[0] as { id: string; approved: boolean | null; suspended: boolean | null } | undefined;
  if (!row) return null;
  const { data: u, error: uErr } = await admin.auth.admin.getUserById(row.id);
  if (uErr || !u?.user) return null;
  return {
    id: row.id,
    hasSignedIn: !!u.user.last_sign_in_at,
    approved: row.approved,
    suspended: !!row.suspended,
  };
}

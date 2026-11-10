// ============================================================
// KANBO — who notify tells about a project update, and when it says
// nothing (0053 "update_ask", 0054 "status_update"). Pure: the function
// reads the ask or the update, its project and the workspace's people,
// then asks these.
//
//   • An ask: only its asker may have it sent, once, while it's fresh;
//     the project must still be live, in the ask's workspace and owned by
//     the person asked, who must still be in the workspace and able to post
//     its update (an owner, admin or member: a guest can't).
//   • A posted update: only its author may have it sent, once, while it's
//     fresh, for a team update about a live project in its own workspace.
//     Push and email go to the people its Ask names (still in the
//     workspace, never the author). Its owner and contributors hear in
//     their Inbox, and in the daily digest if they're on it: an FYI never
//     sends an email or a push of its own.
// ============================================================

/** How fresh an ask must be to be news (ask_for_update answers, then the app asks straight away). */
export const ASK_FRESH_MS = 10 * 60 * 1000;
/** How fresh an update must be to be news (the app asks straight after posting it). */
export const POSTED_FRESH_MS = 10 * 60 * 1000;
/** the roles that can post a project's update */
const POSTERS = new Set(["owner", "admin", "member"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AskRow { id: string; project_id: string; workspace_id: string; asked_by: string; owner_id: string; created_at: string }
export interface UpdateProjectRow { id: string; name: string | null; workspace_id: string | null; owner_id: string | null; contributor_ids?: string[] | null; archived_at: string | null }
export interface PostedRow { id: string; project_id: string; workspace_id: string | null; author_id: string | null; ask_user_ids: string[] | null; created_at: string }

/** null: not this caller's to send (answer 404, giving nothing away); else "ok", or why nobody's told. */
export function askVerdict(a: AskRow | null, actorId: string, now: number): null | "ok" | "not new" {
  if (!a || a.asked_by !== actorId) return null;
  return now - Date.parse(a.created_at) > ASK_FRESH_MS ? "not new" : "ok";
}

/** Can the owner still be told about this ask? ("ok", or why not) — `roles`: the workspace's active people and their roles. */
export function askOwnerVerdict(a: AskRow, p: UpdateProjectRow | null, roles: ReadonlyMap<string, string>, actorId: string): "ok" | "project changed" | "not a member" | "guest" {
  if (!p || p.archived_at || p.workspace_id !== a.workspace_id || p.owner_id !== a.owner_id) return "project changed";
  if (!roles.has(actorId) || !roles.has(a.owner_id) || a.owner_id === actorId) return "not a member";
  return POSTERS.has(roles.get(a.owner_id) ?? "") ? "ok" : "guest";
}

/** null: not this caller's to send (404); else "ok", or why nobody's told. */
export function postedVerdict(u: PostedRow | null, actorId: string, now: number): null | "ok" | "personal" | "not new" | "no project" {
  if (!u || u.author_id !== actorId) return null;
  if (!u.workspace_id) return "personal";
  if (now - Date.parse(u.created_at) > POSTED_FRESH_MS) return "not new";
  return UUID.test(u.project_id) ? "ok" : "no project";
}

/** Who gets a push and an email for an update just posted: the people its Ask names, still in the workspace,
 *  never its author, at most `max` (an FYI reader hears in the Inbox and the digest, nothing more). */
export function postedRecipients(u: Pick<PostedRow, "ask_user_ids">, actorId: string, members: ReadonlySet<string>, max: number): string[] {
  return [...new Set((u.ask_user_ids ?? []).map(String))].filter((id) => UUID.test(id) && id !== actorId && members.has(id)).slice(0, max);
}

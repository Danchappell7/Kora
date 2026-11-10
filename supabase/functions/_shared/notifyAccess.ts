// ============================================================
// KANBO — who notify may tell, with Project access (0058).        [w4]
//
// notify runs with the service role, so it checks the work's project itself
// before an email or a push names it (the Inbox is the database's: its own
// trigger already leaves out people who can't see the work):
//   • the caller must be able to see the task (and, for "assigned", edit
//     it), or the project for an update notice; if not, the same 404 as a
//     task that isn't there, so nothing is given away;
//   • only the recipients who can see it are told.
// Before 0058 every check is today's (everyone in the workspace), and a
// personal task is never asked about. A check that can't be made sends
// nothing (503): the Inbox still has it, and an email is never sent unchecked.
//
// The daily digest (daily-reminders) mails unread Inbox items: one with no
// task is checked by the project it names (digestItemProjects), in the
// order the database's own Inbox gate uses: an update's, a doc's, then
// meta.project_id. A meeting's recap is the meeting's, and always counts.
//
// Pure (no Deno globals, no remote imports): vitest runs it (notifyAccess.test.ts).
// ============================================================
import { AccessLookupFailed, isMissingAccessFn, type ProjectAccess, type TableDb } from "./projectAccess.ts";
import { digestMetaProject, type DigestItem } from "./notifyCompose.ts";

export type NoticeGate =
  | { ok: true; recipients: string[] }
  | { ok: false; status: 404 | 503; body: Record<string, unknown> };

const unavailable = (): NoticeGate => ({ ok: false, status: 503, body: { error: "couldn't check who can see this — nothing was sent", reason: "unavailable" } });
const hidden = (notFound: string): NoticeGate => ({ ok: false, status: 404, body: { error: notFound } });

/** A task's notice (assigned, mention, comment, approval, kudos): the caller sees it (edits it, `needsEdit`); recipients who can see it.
 *  `callerChecked`: this call already passed the caller (an earlier gate with no recipients), so only the recipients are asked about. */
export async function taskNoticeGate(access: ProjectAccess, o: {
  actorId: string; task: { id: string; workspace_id: string | null; project_id?: string | null }; recipients: readonly string[];
  needsEdit?: boolean; notFound: string; callerChecked?: boolean;
}): Promise<NoticeGate> {
  if (!o.task.workspace_id) return { ok: true, recipients: [...o.recipients] };
  try {
    if (!o.callerChecked && !(await access.canSeeTask(o.actorId, o.task.id))) return hidden(o.notFound);
    if (o.needsEdit && !o.callerChecked) {
      const rank = await access.projectRank(o.actorId, o.task.workspace_id, String(o.task.project_id ?? ""));
      if (rank !== null && rank < 3) return hidden(o.notFound);
    }
    return { ok: true, recipients: await access.usersWhoCanSeeTask(o.task.id, o.recipients) };
  } catch (e) {
    if (e instanceof AccessLookupFailed) return unavailable();
    throw e;
  }
}

/** A project's notice (an ask for an update, a posted update): the caller sees the project; recipients who can see it. */
export async function projectNoticeGate(access: ProjectAccess, o: {
  actorId: string; project: { id: string; workspace_id: string | null }; recipients: readonly string[]; notFound: string;
}): Promise<NoticeGate> {
  if (!o.project.workspace_id) return { ok: true, recipients: [...o.recipients] };
  try {
    if (!(await access.canSeeProject(o.actorId, o.project.id))) return hidden(o.notFound);
    return { ok: true, recipients: await access.usersWhoCanSeeProject(o.project.id, o.recipients) };
  } catch (e) {
    if (e instanceof AccessLookupFailed) return unavailable();
    throw e;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOf = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null);

/**
 * For the digest: each task-less item's project (item id → project id, lower case), from its meta: a
 * project update's (status_update_id), a doc's (doc_id), or meta.project_id. Read with the service role.
 * A table that isn't there yet (before 0047 / 0054) names nothing; any other failed read throws
 * AccessLookupFailed (that person's digest waits for the next run).
 */
export async function digestItemProjects(db: TableDb, items: readonly DigestItem[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo = items.filter((a) => !a.task_id && a.kind !== "meeting");
  const byId = async (table: string, ids: string[]): Promise<Map<string, string>> => {
    const found = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from(table).select("id,project_id").in("id", ids.slice(i, i + 200));
      if (error) {
        if (isMissingAccessFn(error)) return found;
        throw new AccessLookupFailed(table, error);
      }
      for (const r of (data ?? []) as { id: string; project_id: string | null }[]) {
        const p = uuidOf(r.project_id);
        if (p) found.set(String(r.id).toLowerCase(), p);
      }
    }
    return found;
  };
  const updates = await byId("status_updates", [...new Set(todo.map((a) => uuidOf(a.meta?.status_update_id)).filter((x): x is string => !!x))]);
  const docs = await byId("project_docs", [...new Set(todo.map((a) => uuidOf(a.meta?.doc_id)).filter((x): x is string => !!x))]);
  for (const a of todo) {
    const u = uuidOf(a.meta?.status_update_id), d = uuidOf(a.meta?.doc_id);
    const p = (u && updates.get(u)) || (d && docs.get(d)) || uuidOf(digestMetaProject(a));
    if (p) out.set(a.id, p);
  }
  return out;
}

/** The projects (of `projectIds`) they can still see; null before 0058 (today's rule). Throws AccessLookupFailed. */
export async function projectsTheySee(access: ProjectAccess, userId: string, projectIds: readonly string[]): Promise<Set<string> | null> {
  if (access.before0058) return null;
  const seen = new Set<string>();
  for (const p of new Set(projectIds)) {
    const ok = await access.canSeeProject(userId, p);
    if (access.before0058) return null;
    if (ok) seen.add(p.toLowerCase());
  }
  return projectIds.length ? seen : null;
}

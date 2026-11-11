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
// meta.project_id, and by the rank it has there (so a project in the bin
// counts as the Inbox shows it: with the switch off, as before 0058). A
// meeting's recap is the meeting's, and always counts.
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

/** What a task-less digest item is about: its project (lower case) and, when known, that project's workspace. */
export interface DigestScope { project: string; workspaceId: string | null }
/** One key per scope (projectsTheySee's answer is a set of these). */
export const scopeKey = (s: DigestScope): string => `${s.project.toLowerCase()}|${(s.workspaceId ?? "").toLowerCase()}`;

/**
 * For the digest: each task-less item's project (item id → scope), from its meta: a project update's
 * (status_update_id), a doc's (doc_id), or meta.project_id. Read with the service role. The workspace is
 * the update's or the doc's own, as the database's Inbox gate reads it, else (a project in the bin, whose
 * docs went with it) the bin's: so the project is judged by its rank there, which knows a binned, retired
 * or departed project, and never by a projects row that's no longer there (null: a live project, or none
 * known, judged by the project itself). A table that isn't there yet (before 0047 / 0054) names nothing;
 * any other failed read throws AccessLookupFailed (that person's digest waits for the next run).
 */
export async function digestItemProjects(db: TableDb, items: readonly DigestItem[]): Promise<Map<string, DigestScope>> {
  const out = new Map<string, DigestScope>();
  const todo = items.filter((a) => !a.task_id && a.kind !== "meeting");
  type Found = { project: string; ws: string | null };
  type Query = ReturnType<TableDb["from"]>;
  const read = async (table: string, key: string, cols: string, ids: string[], narrow: (q: Query) => Query = (q) => q): Promise<Map<string, Found>> => {
    const found = new Map<string, Found>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await narrow(db.from(table).select(cols)).in(key, ids.slice(i, i + 200));
      if (error) {
        if (isMissingAccessFn(error)) return found;
        throw new AccessLookupFailed(table, error);
      }
      for (const r of (data ?? []) as Record<string, string | null>[]) {
        const p = table === "trash" ? uuidOf(r.item_id) : uuidOf(r.project_id);
        if (p) found.set(String(r[key]).toLowerCase(), { project: p, ws: uuidOf(r.workspace_id) });
      }
    }
    return found;
  };
  const updates = await read("status_updates", "id", "id,project_id,workspace_id", [...new Set(todo.map((a) => uuidOf(a.meta?.status_update_id)).filter((x): x is string => !!x))]);
  const docs = await read("project_docs", "id", "id,project_id,workspace_id", [...new Set(todo.map((a) => uuidOf(a.meta?.doc_id)).filter((x): x is string => !!x))]);
  const found = new Map<string, Found>();
  for (const a of todo) {
    const u = uuidOf(a.meta?.status_update_id), d = uuidOf(a.meta?.doc_id);
    const f = (u && updates.get(u)) || (d && docs.get(d)) || null;
    const p = f?.project ?? uuidOf(digestMetaProject(a));
    if (p) found.set(a.id, { project: p, ws: f?.ws ?? null });
  }
  // (a project named by its id alone: in the bin, its workspace is the bin row's)
  const loose = [...new Set([...found.values()].filter((f) => !f.ws).map((f) => f.project))];
  const binned = loose.length
    ? await read("trash", "item_id", "item_id,workspace_id", loose, (q) => q.eq("kind", "project").is("restored_at", null))
    : new Map<string, Found>();
  for (const [id, f] of found) out.set(id, { project: f.project, workspaceId: f.ws ?? binned.get(f.project)?.ws ?? null });
  return out;
}

/**
 * The scopes (of `scopes`) whose project they can still see, by scopeKey; null before 0058 (today's rule).
 * With its workspace known, by their rank there (user_project_rank: a project in the bin, or one that has
 * left, is judged by the access it had, and with the switch off by their role, as before 0058); else by
 * the project itself (user_can_see_project). Throws AccessLookupFailed.
 */
export async function projectsTheySee(access: ProjectAccess, userId: string, scopes: readonly DigestScope[]): Promise<Set<string> | null> {
  if (access.before0058) return null;
  const seen = new Set<string>();
  const asked = new Set<string>();
  for (const s of scopes) {
    const k = scopeKey(s);
    if (asked.has(k)) continue;
    asked.add(k);
    let ok: boolean;
    if (s.workspaceId) {
      const r = await access.projectRank(userId, s.workspaceId, s.project);
      if (r === null) return null;
      ok = r >= 1;
    } else ok = await access.canSeeProject(userId, s.project);
    if (access.before0058) return null;
    if (ok) seen.add(k);
  }
  return scopes.length ? seen : null;
}

/**
 * The morning due list (daily-reminders): the ids of `ids` they can see. It runs once a day and
 * nothing re-tries it, so a lookup that fails (a timeout, a dropped connection) is asked again
 * after a pause, `tries` times in all, before that person's list is given up for the day.
 * Throws AccessLookupFailed only when every try failed.
 */
export async function dueTasksTheySee(access: ProjectAccess, userId: string, ids: readonly string[],
  o: { tries?: number; pauseMs?: number; sleep?: (ms: number) => Promise<unknown> } = {}): Promise<string[]> {
  const tries = Math.max(1, o.tries ?? 3);
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      return await access.visibleTaskIds(userId, ids);
    } catch (e) {
      if (!(e instanceof AccessLookupFailed) || i >= tries) throw e;
      await sleep((o.pauseMs ?? 500) * i);
    }
  }
}

/** An archived project, as the due list and the digest read it (with the service role): where it is. */
export interface ArchivedProject { workspaceId: string | null; owner: string | null }
/**
 * Is a task on `person`'s due list in an archived project (left off the list, as the app hides it)? A
 * project counts only where the task really is in it: a team task's own workspace's, or, for a Personal
 * task, `person`'s own personal project (the calendar feed's rule: icsFeed). tasks.project_id is free
 * text, so anyone can put another project's id on a Personal task of their own: that names nothing, and
 * mustn't tell them from their email whether that project (a Private one they can't see, say) is archived.
 */
export function inArchivedProject(t: { project_id: string | null; workspace_id: string | null }, person: string,
  archived: ReadonlyMap<string, ArchivedProject>): boolean {
  const p = t.project_id ? archived.get(t.project_id) : undefined;
  if (!p) return false;
  return t.workspace_id ? p.workspaceId === t.workspace_id : p.workspaceId === null && p.owner === person;
}

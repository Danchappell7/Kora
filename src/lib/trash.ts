/* ============================================================
   KANBO — the recycle bin (Projects › Recycle bin, and Undo after a
   delete already reached the server).            [0047 contract → w1]

   Contract (database 0047):
     table trash (RLS: personal → its creator; team → the workspace's
       members, guests too). Select TRASH_COLUMNS explicitly — the snapshot
       column is not granted, so select=* is refused. Unrestored rows:
       restored_at is null; newest first: order deleted_at desc.
     rpc restore_from_trash(p_id) → { id, kind, item_id, status, project_id, note, counts }
         writers of the workspace (personal: the creator); status
         'already_restored' is a success (idempotent)
     rpc restore_trash_items(p_ids uuid[] ≤ 200) → [{ id, ok, result | error }]
         newest delete first; each succeeds or fails alone
     rpc purge_trash(p_id) → true    owners/admins (team), the creator (personal)
     errors: 'not authorized' · 'not found' (gone, or not yours) ·
             'restore conflict' (an id exists again) · 'no project to restore into' ·
             'too many items'
   Deleting stays the same call as before (a plain delete on tasks /
   projects): the database moves the row graph into the bin itself. A
   project's delete takes its tasks and sections with it, so the app's
   follow-up per-task deletes find nothing (that's fine).

   Package w1 implements the async functions (real + demo fakes) and
   the screens; parsers, constants and daysLeft are final.
   ============================================================ */
import type {
  Priority, Status, TrashBulkResult, TrashCounts, TrashFailure, TrashItem, TrashKind, TrashRestoreResult, TrashSummary,
} from "../data/types";

/** Days a deleted item waits in the bin. */
export const TRASH_DAYS = 30;
/** The columns a client may read (everything but the snapshot). */
export const TRASH_COLUMNS = "id,kind,item_id,workspace_id,user_id,project_id,title,summary,deleted_by,deleted_by_name,deleted_at,purge_after,restored_at,restored_by";
/** restore_trash_items() takes at most this many ids per call. */
export const TRASH_BULK_MAX = 200;

const KINDS = new Set<TrashKind>(["task", "project"]);
const STATUSES = new Set<Status>(["todo", "progress", "review", "blocked", "done"]);
const PRIORITIES = new Set<Priority>(["low", "medium", "high", "urgent"]);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const pick = (r: Record<string, unknown>, snake: string, camel: string) => (r[snake] !== undefined ? r[snake] : r[camel]);

/** trash.summary.counts → TrashCounts (missing numbers are 0). */
export function parseTrashCounts(raw: unknown): TrashCounts {
  const c = obj(raw) ?? {};
  return {
    tasks: num(c.tasks), subtasks: num(c.subtasks), comments: num(c.comments), attachments: num(c.attachments),
    checklist: num(c.checklist), sections: num(c.sections), docs: num(c.docs),
  };
}

/** trash.summary → TrashSummary. */
export function parseTrashSummary(raw: unknown): TrashSummary {
  const s = obj(raw) ?? {};
  const p = obj(s.project);
  const parent = obj(s.parent);
  const status = s.status, priority = s.priority;
  return {
    project: p && str(p.id) && typeof p.name === "string"
      ? { id: str(p.id)!, name: p.name, emoji: typeof p.emoji === "string" ? p.emoji : "📁", color: typeof p.color === "string" ? p.color : "", ...(p.description !== undefined ? { description: str(p.description) } : {}) }
      : null,
    parent: parent && str(parent.id) ? { id: str(parent.id)!, title: typeof parent.title === "string" ? parent.title : "" } : null,
    ...(typeof status === "string" && STATUSES.has(status as Status) ? { status: status as Status } : {}),
    ...(typeof priority === "string" && PRIORITIES.has(priority as Priority) ? { priority: priority as Priority } : {}),
    ...(pick(s, "due_date", "dueDate") !== undefined ? { dueDate: str(pick(s, "due_date", "dueDate")) } : {}),
    ...(pick(s, "assignee_id", "assigneeId") !== undefined ? { assigneeId: str(pick(s, "assignee_id", "assigneeId")) } : {}),
    archived: s.archived === true,
    counts: parseTrashCounts(s.counts),
  };
}

/** A trash row (snake_case; camelCase also read) → TrashItem; null if malformed. */
export function parseTrashItem(raw: unknown): TrashItem | null {
  const r = obj(raw);
  if (!r) return null;
  const id = str(r.id), kind = r.kind, itemId = str(pick(r, "item_id", "itemId"));
  const deletedAt = str(pick(r, "deleted_at", "deletedAt")), purgeAfter = str(pick(r, "purge_after", "purgeAfter"));
  if (!id || !itemId || typeof kind !== "string" || !KINDS.has(kind as TrashKind) || !deletedAt || !purgeAfter) return null;
  return {
    id, kind: kind as TrashKind, itemId,
    workspaceId: str(pick(r, "workspace_id", "workspaceId")),
    userId: str(pick(r, "user_id", "userId")),
    projectId: str(pick(r, "project_id", "projectId")),
    title: typeof r.title === "string" ? r.title : "",
    summary: parseTrashSummary(r.summary),
    deletedBy: str(pick(r, "deleted_by", "deletedBy")),
    deletedByName: str(pick(r, "deleted_by_name", "deletedByName")),
    deletedAt, purgeAfter,
    restoredAt: str(pick(r, "restored_at", "restoredAt")),
    restoredBy: str(pick(r, "restored_by", "restoredBy")),
  };
}

/** restore_from_trash()'s answer → TrashRestoreResult; null if malformed. */
export function parseTrashRestoreResult(raw: unknown): TrashRestoreResult | null {
  const r = obj(raw);
  if (!r) return null;
  const id = str(r.id), kind = r.kind, itemId = str(pick(r, "item_id", "itemId")), status = r.status;
  if (!id || !itemId || typeof kind !== "string" || !KINDS.has(kind as TrashKind)) return null;
  if (status !== "restored" && status !== "already_restored") return null;
  return {
    id, kind: kind as TrashKind, itemId, status,
    projectId: str(pick(r, "project_id", "projectId")),
    note: str(r.note),
    counts: obj(r.counts) ? parseTrashCounts(r.counts) : null,
  };
}

/** A database / network error → why (the messages the 0047 functions raise). */
export function trashFailure(e: unknown): TrashFailure {
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  if (code === "42883" || code === "PGRST202" || code === "42P01" || /could not find the function|does not exist|relation .* does not exist/i.test(msg)) return "unavailable";
  if (/failed to fetch|network|load failed/i.test(msg)) return "network";
  if (/restore conflict/i.test(msg)) return "conflict";
  if (/no project to restore into/i.test(msg)) return "no_project";
  if (/not authorized|not allowed|permission denied/i.test(msg)) return "not_allowed";
  if (/not found/i.test(msg)) return "not_found";
  return "error";
}

/** restore_trash_items()'s answer → one TrashBulkResult per id. */
export function parseTrashBulk(raw: unknown): TrashBulkResult[] {
  if (!Array.isArray(raw)) return [];
  const out: TrashBulkResult[] = [];
  for (const x of raw) {
    const r = obj(x);
    const id = r && str(r.id);
    if (!r || !id) continue;
    if (r.ok === true) {
      const result = parseTrashRestoreResult(r.result);
      out.push(result ? { id, ok: true, result } : { id, ok: false, error: "error" });
    } else {
      const message = typeof r.error === "string" ? r.error : "";
      out.push({ id, ok: false, error: trashFailure({ message }), message });
    }
  }
  return out;
}

/** Days left before the bin deletes it for good, rounded up: 30 just after the
 *  delete, 1 on its last day, 0 once it's due (housekeeping runs daily). */
export function daysLeft(purgeAfter: string, now: number = Date.now()): number {
  const t = Date.parse(purgeAfter);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 86_400_000));
}

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package w1)`));

/** The bin of a workspace (null = your Personal bin): unrestored, newest first. Demo mode: realistic fakes. */
export function listTrash(_workspaceId: string | null): Promise<TrashItem[]> { return notBuilt("listTrash"); }
/** For Undo after the delete already went out: deleted item id → its (newest, unrestored) bin row id. */
export function findTrashForItems(_itemIds: string[]): Promise<Record<string, string>> { return notBuilt("findTrashForItems"); }
export function restoreFromTrash(_id: string): Promise<TrashRestoreResult> { return notBuilt("restoreFromTrash"); }
/** Bulk restore (and Undo): ≤ TRASH_BULK_MAX ids per call; split larger sets. */
export function restoreTrashItems(_ids: string[]): Promise<TrashBulkResult[]> { return notBuilt("restoreTrashItems"); }
/** "Delete forever". */
export function purgeTrash(_id: string): Promise<void> { return notBuilt("purgeTrash"); }

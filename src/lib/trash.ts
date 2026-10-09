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
import { supabase } from "./supabase";
import { MEMBERS, PROJECTS } from "../data/data";
import { spectrumColor } from "./projectIdentity";

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

/* ============================================================
   Package w1: the calls (real + demo).
   Every failure is an Error carrying the server's message and code, so
   trashFailure(e) names it. A bin that isn't there yet (0047 not run)
   answers "unavailable" whichever way PostgREST says so.
   ============================================================ */

/** The bin shows at most this many items (newest first); older ones still purge on time. */
export const TRASH_LIST_MAX = 1000;
/** Item ids per findTrashForItems() request (keeps the address short). */
const FIND_CHUNK = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A PostgREST / RPC error → an Error trashFailure() reads (message + code). */
function binError(error: { message?: unknown; code?: unknown } | null | undefined): Error & { code?: string } {
  const message = typeof error?.message === "string" && error.message ? error.message : "error";
  const code = typeof error?.code === "string" ? error.code : "";
  // a table PostgREST doesn't know (0047 not run) says so in its own words: name it the way trashFailure reads
  if (code === "PGRST205" || /could not find the table/i.test(message)) return Object.assign(new Error(message), { code: "42P01" });
  return Object.assign(new Error(message), { code });
}

const unique = (ids: string[]) => [...new Set(ids.filter((x) => typeof x === "string" && x))];
const chunks = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** The bin of a workspace (null = your Personal bin): unrestored, newest first. Demo mode: realistic fakes. */
export function listTrash(workspaceId: string | null): Promise<TrashItem[]> {
  if (!supabase) return demoList(workspaceId);
  return (async () => {
    let q = supabase.from("trash").select(TRASH_COLUMNS).is("restored_at", null);
    // personal: RLS already narrows it to your own rows
    q = workspaceId ? q.eq("workspace_id", workspaceId) : q.is("workspace_id", null);
    const { data, error } = await q.order("deleted_at", { ascending: false }).order("id", { ascending: false }).limit(TRASH_LIST_MAX);
    if (error) throw binError(error);
    return (Array.isArray(data) ? data : []).map(parseTrashItem).filter((x): x is TrashItem => !!x);
  })();
}

/** For Undo after the delete already went out: deleted item id → its (newest, unrestored) bin row id. */
export function findTrashForItems(itemIds: string[]): Promise<Record<string, string>> {
  const ids = unique(itemIds);
  if (!supabase) return demoFind(ids);
  return (async () => {
    const out: Record<string, string> = {};
    // only real ids can be in the bin (a task that never reached the server has a local id)
    for (const part of chunks(ids.filter((x) => UUID_RE.test(x)), FIND_CHUNK)) {
      const { data, error } = await supabase.from("trash").select("id,item_id,deleted_at")
        .in("item_id", part).is("restored_at", null).order("deleted_at", { ascending: false });
      if (error) throw binError(error);
      for (const r of Array.isArray(data) ? data as { id?: unknown; item_id?: unknown }[] : []) {
        // newest first: the first row per item is its latest delete
        if (typeof r.id === "string" && typeof r.item_id === "string" && !out[r.item_id]) out[r.item_id] = r.id;
      }
    }
    return out;
  })();
}

/** Restore one bin row (writers; Personal: its creator). "already_restored" is a success. */
export function restoreFromTrash(id: string): Promise<TrashRestoreResult> {
  if (!supabase) return demoRestore(id);
  return (async () => {
    const { data, error } = await supabase.rpc("restore_from_trash", { p_id: id });
    if (error) throw binError(error);
    const r = parseTrashRestoreResult(data);
    if (!r) throw binError({ message: "unexpected answer from restore_from_trash" });
    return r;
  })();
}

/** Bulk restore (and Undo): ≤ TRASH_BULK_MAX ids per call, so larger sets are split.
 *  Never rejects: every id gets an answer. A call that fails outright (offline,
 *  the bin not switched on) fails each of its ids with that reason, and the
 *  chunks after it aren't tried. Pass ids newest delete first (the bin's own
 *  order) when there are more than TRASH_BULK_MAX, so parents still come back
 *  before sub-tasks across chunks. */
export function restoreTrashItems(ids: string[]): Promise<TrashBulkResult[]> {
  const list = unique(ids);
  if (!supabase) return demoRestoreMany(list);
  return (async () => {
    const out: TrashBulkResult[] = [];
    let stop: { error: TrashFailure; message: string } | null = null;
    for (const part of chunks(list, TRASH_BULK_MAX)) {
      if (stop) { for (const id of part) out.push({ id, ok: false, ...stop }); continue; }
      const { data, error } = await supabase.rpc("restore_trash_items", { p_ids: part });
      if (error) {
        const e = binError(error);
        stop = { error: trashFailure(e), message: e.message };
        for (const id of part) out.push({ id, ok: false, ...stop });
        continue;
      }
      const got = parseTrashBulk(data);
      const seen = new Set(got.map((r) => r.id));
      out.push(...got);
      // an id the server didn't answer for (shouldn't happen): say so rather than drop it
      for (const id of part) if (!seen.has(id)) out.push({ id, ok: false, error: "error", message: "no answer" });
    }
    return out;
  })();
}

/** "Delete forever": owners/admins for team items, the creator for personal ones. */
export function purgeTrash(id: string): Promise<void> {
  if (!supabase) return demoPurge(id);
  return (async () => {
    const { error } = await supabase.rpc("purge_trash", { p_id: id });
    if (error) throw binError(error);
  })();
}

/* ---------------- Undo after the delete reached the server ---------------- */

export interface BinUndoResult {
  /** restored: everything came back · partial: some did · failed: none did ·
   *  unavailable: there's no bin to restore from (before 0047, or demo mode) — use the old copy-restore */
  status: "restored" | "partial" | "failed" | "unavailable";
  /** item ids (tasks / projects) back under their own ids, with their comments, files and history */
  restored: string[];
  /** item ids the bin had but couldn't put back, and why */
  failed: { itemId: string; error: TrashFailure; message?: string }[];
  /** item ids the bin hasn't got (the delete never reached the server, or it's been purged) */
  missing: string[];
  /** the server's notes, de-duplicated ("Its project was deleted, so it's back in “X”.") */
  notes: string[];
  results: TrashRestoreResult[];
}

/** Undo a delete that already went out: find each deleted item's newest bin row
 *  and restore them all (newest delete first). Pass the ROOT ids that were sent
 *  to the server (sub-tasks come back inside their parent's entry). Never rejects. */
export async function restoreDeletedItems(itemIds: string[]): Promise<BinUndoResult> {
  const ids = unique(itemIds);
  const empty: BinUndoResult = { status: "restored", restored: [], failed: [], missing: [], notes: [], results: [] };
  if (!ids.length) return empty;
  if (!supabase) return { ...empty, status: "unavailable", missing: ids };
  let found: Record<string, string>;
  try {
    found = await findTrashForItems(ids);
  } catch (e) {
    const why = trashFailure(e);
    if (why === "unavailable") return { ...empty, status: "unavailable", missing: ids };
    return { ...empty, status: "failed", failed: ids.map((itemId) => ({ itemId, error: why, message: String((e as Error)?.message ?? "") })) };
  }
  const missing = ids.filter((x) => !found[x]);
  const binIds = ids.map((x) => found[x]).filter(Boolean);
  const itemOf = new Map(Object.entries(found).map(([item, bin]) => [bin, item]));
  const answers = binIds.length ? await restoreTrashItems(binIds) : [];
  if (answers.length && answers.every((a) => !a.ok && a.error === "unavailable")) return { ...empty, status: "unavailable", missing: ids };
  const restored: string[] = [], failed: BinUndoResult["failed"] = [], results: TrashRestoreResult[] = [];
  for (const a of answers) {
    const itemId = a.result?.itemId ?? itemOf.get(a.id) ?? a.id;
    if (a.ok && a.result) { restored.push(itemId); results.push(a.result); }
    else failed.push({ itemId, error: a.error ?? "error", ...(a.message ? { message: a.message } : {}) });
  }
  const notes = [...new Set(results.map((r) => r.note).filter((n): n is string => !!n))];
  const status = !failed.length && !missing.length ? "restored" : restored.length ? "partial" : "failed";
  return { status, restored, failed, missing, notes, results };
}

/** A sentence for a restore that didn't work (toasts and the bin's rows). */
export function trashFailureText(why: TrashFailure, kind: TrashKind = "task"): string {
  const it = kind === "project" ? "this project" : "this task";
  switch (why) {
    case "conflict": return `Part of ${it} is already back in Kanbo, so it can't be restored over it.`;
    case "no_project": return "There's no project in this workspace to put it back into. Make a project first, then try again.";
    case "not_allowed": return "You can't do that in this workspace.";
    case "not_found": return "It's no longer in the bin: someone restored it or deleted it for good.";
    case "unavailable": return "The recycle bin isn't switched on yet.";
    case "network": return "Couldn't reach Kanbo. Check your connection and try again.";
    default: return "Something went wrong. Try again.";
  }
}

/* ============================================================ demo (no Supabase) */

const demoScopes = new Map<string, TrashItem[]>();
let DEMO_DELAY_MS = 300;
let demoSeq = 0;
const wait = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());
const scopeKey = (ws: string | null) => ws ?? "personal";
const demoId = () => `trash-demo-${(++demoSeq).toString(36)}`;
const DAY = 86_400_000;

/** Tests: start the demo bin afresh (and answer at once). */
export function resetTrashDemo(opts: { demoDelayMs?: number } = {}) {
  demoScopes.clear();
  demoSeq = 0;
  DEMO_DELAY_MS = opts.demoDelayMs ?? 300;
}

const demoMemberName = (id: string | null) => (id ? MEMBERS.find((m) => m.id === id)?.name ?? null : null);
const demoProject = (id: string) => {
  const p = PROJECTS.find((x) => x.id === id);
  return p ? { id: p.id, name: p.name, emoji: p.emoji, color: p.color } : null;
};
const ZERO: TrashCounts = { tasks: 0, subtasks: 0, comments: 0, attachments: 0, checklist: 0, sections: 0, docs: 0 };

interface DemoSeed {
  kind: TrashKind;
  title: string;
  /** minutes ago */
  ago: number;
  by: string | null;
  project: TrashSummary["project"];
  parent?: { id: string; title: string } | null;
  status?: TrashSummary["status"];
  priority?: TrashSummary["priority"];
  counts?: Partial<TrashCounts>;
  /** what restoring it says (the server's own words) */
  restoreTo?: { projectId: string; note: string | null };
}

function demoItem(ws: string | null, s: DemoSeed): TrashItem {
  const at = Date.now() - s.ago * 60_000;
  const itemId = `${s.kind === "project" ? "p" : "t"}-bin-${(++demoSeq).toString(36)}`;
  const tasks = s.kind === "task" ? 1 + (s.counts?.subtasks ?? 0) : s.counts?.tasks ?? 0;
  const item: TrashItem = {
    id: demoId(), kind: s.kind, itemId, workspaceId: ws, userId: s.by ?? "m-self",
    projectId: s.kind === "project" ? itemId : s.project?.id ?? null,
    title: s.title,
    summary: {
      project: s.kind === "project" ? { id: itemId, name: s.title, emoji: s.project?.emoji ?? "📁", color: s.project?.color ?? "", description: null } : s.project,
      parent: s.parent ?? null,
      ...(s.kind === "task" ? { status: s.status ?? "todo", priority: s.priority ?? "medium", dueDate: null, assigneeId: s.by } : {}),
      archived: false,
      counts: { ...ZERO, ...s.counts, tasks },
    },
    deletedBy: s.by,
    deletedByName: s.by ? demoMemberName(s.by) ?? "Someone" : "Kanbo",
    deletedAt: new Date(at).toISOString(),
    purgeAfter: new Date(at + TRASH_DAYS * DAY).toISOString(),
    restoredAt: null,
    restoredBy: null,
  };
  if (s.restoreTo) demoRestoreTo.set(item.id, s.restoreTo);
  return item;
}
const demoRestoreTo = new Map<string, { projectId: string; note: string | null }>();

function demoSeed(ws: string | null): TrashItem[] {
  const key = scopeKey(ws);
  const have = demoScopes.get(key);
  if (have) return have;
  const H = 60, D = 24 * 60;
  const seeds: DemoSeed[] = [];
  if (ws === null) {
    const personal = demoProject("p-personal") ?? { id: "p-personal", name: "Personal", emoji: "📌", color: spectrumColor("iris") };
    seeds.push(
      { kind: "task", title: "Renew passport", ago: 3 * D + 2 * H, by: "m-self", project: personal, status: "todo", priority: "high", counts: { checklist: 3 } },
      { kind: "project", title: "Home move", ago: 11 * D, by: "m-self", project: { id: "", name: "Home move", emoji: "📦", color: spectrumColor("amber") }, counts: { tasks: 6, sections: 2, comments: 1, attachments: 2 } },
      { kind: "task", title: "Book a dentist appointment", ago: 26 * D + 5 * H, by: "m-self", project: personal, counts: {} },
    );
  } else {
    const own = PROJECTS.filter((p) => p.workspaceId === ws && !p.archivedAt);
    const first = own[0] ? demoProject(own[0].id) : null;
    const pick = (id: string) => demoProject(id) ?? first;
    const launch = pick("p-launch"), infra = pick("p-infra"), brand = pick("p-brand");
    if (ws === "ws-foundrise" || !own.length) {
      seeds.push(
        { kind: "task", title: "Draft press release", ago: 25, by: "m-1", project: launch, status: "progress", priority: "high", counts: { subtasks: 2, comments: 4, checklist: 3 } },
        { kind: "task", title: "Book venue", ago: D + 3 * H, by: "m-self", project: launch, parent: { id: "t-launch-event", title: "Launch event" }, status: "todo", priority: "medium",
          restoreTo: { projectId: launch?.id ?? "p-launch", note: "Its parent task isn't there any more, so it's a top-level task now." } },
        { kind: "project", title: "Webinar series", ago: 4 * D + 6 * H, by: "m-self", project: { id: "", name: "Webinar series", emoji: "🎙️", color: spectrumColor("violet") },
          counts: { tasks: 9, sections: 2, docs: 1, comments: 12, attachments: 3, checklist: 5 } },
        { kind: "task", title: "Fix flaky checkout test", ago: 6 * D + 2 * H, by: "m-2", project: infra, status: "blocked", priority: "urgent", counts: { comments: 3, attachments: 1 } },
        { kind: "task", title: "Migrate blog posts", ago: 9 * D, by: "m-3", project: { id: "p-website-v1", name: "Website v1", emoji: "🌐", color: spectrumColor("lagoon") }, status: "todo", priority: "low",
          counts: { subtasks: 4, comments: 2 }, restoreTo: { projectId: first?.id ?? "p-launch", note: `Its project was deleted, so it's back in “${first?.name ?? "Q3 Product Launch"}”.` } },
        { kind: "task", title: "Moodboard v2", ago: 27 * D + 2 * H, by: "m-3", project: brand, status: "review", priority: "medium", counts: { attachments: 6, comments: 5 } },
        { kind: "task", title: "Pricing FAQ (from Notion)", ago: 29 * D + 14 * H, by: null, project: launch, status: "todo", priority: "low", counts: { comments: 0 } },
      );
    } else {
      const p = first;
      seeds.push(
        { kind: "task", title: "A/B test the pricing page", ago: 2 * D + 4 * H, by: "m-1", project: p, status: "progress", priority: "high", counts: { subtasks: 1, comments: 2 } },
        { kind: "project", title: "Referral programme", ago: 8 * D, by: "m-self", project: { id: "", name: "Referral programme", emoji: "🎁", color: spectrumColor("coral") }, counts: { tasks: 5, sections: 1, comments: 4 } },
        { kind: "task", title: "Churn survey copy", ago: 19 * D, by: "m-self", project: p, status: "todo", priority: "medium", counts: { comments: 1 } },
      );
    }
  }
  const items = seeds.map((s) => demoItem(ws, s)).sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
  demoScopes.set(key, items);
  return items;
}

const copyItem = (t: TrashItem): TrashItem => ({ ...t, summary: { ...t.summary, counts: { ...t.summary.counts } } });
function demoLocate(id: string): { list: TrashItem[]; item: TrashItem } | null {
  for (const list of demoScopes.values()) {
    const item = list.find((t) => t.id === id);
    if (item) return { list, item };
  }
  return null;
}

async function demoList(ws: string | null): Promise<TrashItem[]> {
  await wait(DEMO_DELAY_MS);
  return demoSeed(ws).filter((t) => !t.restoredAt).map(copyItem);
}

async function demoFind(itemIds: string[]): Promise<Record<string, string>> {
  await wait(DEMO_DELAY_MS / 3);
  const out: Record<string, string> = {};
  for (const list of demoScopes.values()) for (const t of list) if (!t.restoredAt && itemIds.includes(t.itemId) && !out[t.itemId]) out[t.itemId] = t.id;
  return out;
}

function demoRestoreNow(id: string): TrashRestoreResult {
  const hit = demoLocate(id);
  if (!hit) throw Object.assign(new Error("not found"), { code: "P0001" });
  const { item } = hit;
  if (item.restoredAt) {
    return { id, kind: item.kind, itemId: item.itemId, status: "already_restored", projectId: item.kind === "project" ? item.itemId : item.projectId, note: null, counts: { ...item.summary.counts } };
  }
  item.restoredAt = new Date().toISOString();
  item.restoredBy = "m-self";
  const to = demoRestoreTo.get(id);
  return {
    id, kind: item.kind, itemId: item.itemId, status: "restored",
    projectId: item.kind === "project" ? item.itemId : to?.projectId ?? item.projectId,
    note: to?.note ?? null, counts: { ...item.summary.counts },
  };
}

async function demoRestore(id: string): Promise<TrashRestoreResult> {
  await wait(DEMO_DELAY_MS);
  return demoRestoreNow(id);
}

async function demoRestoreMany(ids: string[]): Promise<TrashBulkResult[]> {
  await wait(DEMO_DELAY_MS);
  // newest delete first, like the server
  const at = (id: string) => { const hit = demoLocate(id); return hit ? Date.parse(hit.item.deletedAt) : -Infinity; };
  return [...ids].sort((a, b) => at(b) - at(a)).map((id): TrashBulkResult => {
    try { return { id, ok: true, result: demoRestoreNow(id) }; }
    catch (e) { const message = (e as Error).message; return { id, ok: false, error: trashFailure({ message }), message }; }
  });
}

async function demoPurge(id: string): Promise<void> {
  await wait(DEMO_DELAY_MS);
  const hit = demoLocate(id);
  if (!hit) throw Object.assign(new Error("not found"), { code: "P0001" });
  hit.list.splice(hit.list.indexOf(hit.item), 1);
}

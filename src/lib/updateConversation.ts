/* ============================================================
   KANBO — the conversation on a project update (0054): comments,
   reactions and "Seen by 6", plus telling people it was posted.
   Each update's thread is read when its project's Updates tab (or a
   portfolio's Updates tab) shows it, kept here, and shared by every
   screen that shows the same update. Anyone who reads an update
   comments and reacts (guests too); you edit and delete your own
   comments, owners and admins remove any; you take back only your
   own reactions; "seen by" is recorded by the database for the
   updates you read (never your own). Demo: in memory, seeded.
   Before 0054: no thread is offered (conversationOn() is false).
   ============================================================ */
import { useEffect, useSyncExternalStore } from "react";
import type { UpdateComment } from "../data/types";
import { DEMO_UPDATE_THREADS, getMember } from "../data/data";
import { errText } from "./rowUtils";
import { supabase } from "./supabase";

/** The six reactions an update takes (the database allows these only). */
export const UPDATE_REACTIONS = ["👍", "❤️", "🎉", "👀", "✅", "🚀"] as const;
export const COMMENT_MAX = 4000;
const COMMENT_COLUMNS = "id,update_id,user_id,author_name,body,mentions,created_at,edited_at";

export interface UpdateThread {
  comments: UpdateComment[];
  /** emoji → who reacted (in the order they did) */
  reactions: Record<string, string[]>;
  /** who has read it (never its author) */
  seenBy: string[];
}
const EMPTY: UpdateThread = { comments: [], reactions: {}, seenBy: [] };

export type ConversationFailure = "not_allowed" | "unavailable" | "failed";
export class ConversationError extends Error {
  constructor(readonly reason: ConversationFailure, message: string) { super(message); this.name = "ConversationError"; }
}

/** status_update_comments (anything) → a comment, or null. */
export function parseUpdateComment(r: unknown): UpdateComment | null {
  const o = r as Record<string, unknown> | null;
  if (!o || typeof o.id !== "string" || typeof o.update_id !== "string" || typeof o.body !== "string") return null;
  return {
    id: o.id, updateId: o.update_id, authorId: typeof o.user_id === "string" ? o.user_id : null,
    authorName: typeof o.author_name === "string" && o.author_name.trim() ? o.author_name : "Former member",
    body: o.body, mentions: Array.isArray(o.mentions) ? o.mentions.map(String) : [],
    createdAt: String(o.created_at ?? ""), editedAt: typeof o.edited_at === "string" ? o.edited_at : null,
  };
}

/* ---------- what's loaded ---------- */

let threads = new Map<string, UpdateThread>();
let loaded = new Set<string>();
let missing = false;
let snapshot = { threads, missing };
let seq = 0;
const listeners = new Set<() => void>();
const tell = () => { snapshot = { threads, missing }; listeners.forEach((fn) => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const put = (id: string, patch: Partial<UpdateThread>) => {
  threads = new Map(threads);
  threads.set(id, { ...(threads.get(id) ?? EMPTY), ...patch });
  tell();
};

/** Are comments, reactions and "seen by" there to offer? (Before 0054 the tables aren't.) */
export const conversationOn = (): boolean => !missing;

const isMissing = (e: unknown) => {
  const code = String((e as { code?: unknown })?.code ?? "");
  return code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205" || /could not find|does not exist|schema cache/i.test(errText(e));
};
const failure = (e: unknown, what: string): ConversationError => {
  if (isMissing(e)) { missing = true; tell(); return new ConversationError("unavailable", "Replies on updates aren't switched on yet."); }
  const m = errText(e);
  if (/row-level security|policy|permission|not authori[sz]ed/i.test(m)) return new ConversationError("not_allowed", "You can't do that on this update.");
  if (/too many/i.test(m)) return new ConversationError("failed", "That's a lot of replies for one hour. Try again a little later.");
  return new ConversationError("failed", `Couldn't ${what} just now. Try again in a moment.`);
};

/** Read the threads of these updates (once each; again with `force`). At most 50 at a time. */
export async function loadUpdateConversation(ids: readonly string[], force = false): Promise<void> {
  const want = [...new Set(ids)].filter((id) => id && !id.startsWith("tmp-") && (force || !loaded.has(id))).slice(0, 50);
  if (!want.length || missing) return;
  if (!supabase) {
    // demo: the seeded threads, copied (each update's once)
    threads = new Map(threads);
    for (const id of want) {
      loaded.add(id);
      const seed = DEMO_UPDATE_THREADS[id];
      if (seed && !threads.has(id)) threads.set(id, { comments: seed.comments.map((c) => ({ ...c })), reactions: Object.fromEntries(Object.entries(seed.reactions).map(([k, v]) => [k, [...v]])), seenBy: [...seed.seenBy] });
    }
    tell();
    return;
  }
  for (const id of want) loaded.add(id);
  const [c, r, v] = await Promise.all([
    supabase.from("status_update_comments").select(COMMENT_COLUMNS).in("update_id", want).order("created_at", { ascending: true }).limit(1000),
    supabase.from("status_update_reactions").select("update_id,user_id,emoji,created_at").in("update_id", want).order("created_at", { ascending: true }).limit(2000),
    supabase.from("status_update_views").select("update_id,user_id,seen_at").in("update_id", want).order("seen_at", { ascending: true }).limit(2000),
  ]);
  const err = c.error ?? r.error ?? v.error;
  if (err) {
    for (const id of want) loaded.delete(id);
    if (isMissing(err)) { missing = true; tell(); }
    return;
  }
  threads = new Map(threads);
  for (const id of want) threads.set(id, { comments: [], reactions: {}, seenBy: [] });
  for (const row of (c.data as unknown[] | null) ?? []) {
    const cm = parseUpdateComment(row);
    if (cm) threads.get(cm.updateId)?.comments.push(cm);
  }
  for (const row of (r.data as { update_id: string; user_id: string; emoji: string }[] | null) ?? []) {
    const t = threads.get(row.update_id);
    if (t) (t.reactions[row.emoji] ??= []).push(row.user_id);
  }
  for (const row of (v.data as { update_id: string; user_id: string }[] | null) ?? []) threads.get(row.update_id)?.seenBy.push(row.user_id);
  tell();
}

/** These updates' threads, kept current (each loads the first time it's shown). */
export function useUpdateConversation(ids: readonly string[]): { threads: ReadonlyMap<string, UpdateThread>; on: boolean } {
  const snap = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  const key = ids.join(",");
  useEffect(() => { void loadUpdateConversation(ids); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key]);
  return { threads: snap.threads, on: !snap.missing };
}

export const threadOf = (m: ReadonlyMap<string, UpdateThread>, id: string): UpdateThread => m.get(id) ?? EMPTY;

/* ---------- writing ---------- */

/** Reply on an update. Throws ConversationError. */
export async function addUpdateComment(updateId: string, body: string, mentions: string[], me: string): Promise<UpdateComment> {
  const text = body.trim().slice(0, COMMENT_MAX);
  if (!text) throw new ConversationError("failed", "Write something first.");
  if (!supabase) {
    const c: UpdateComment = { id: `uc-demo-${++seq}`, updateId, authorId: me, authorName: getMember(me)?.name ?? "You", body: text,
      mentions: [...new Set(mentions)].filter((m) => m !== me), createdAt: new Date().toISOString(), editedAt: null };
    put(updateId, { comments: [...threadOf(threads, updateId).comments, c] });
    return c;
  }
  if (missing) throw new ConversationError("unavailable", "Replies on updates aren't switched on yet.");
  const { data, error } = await supabase.from("status_update_comments")
    .insert({ update_id: updateId, user_id: me, body: text, mentions: [...new Set(mentions)].slice(0, 20) }).select(COMMENT_COLUMNS).single();
  if (error) throw failure(error, "reply");
  const c = parseUpdateComment(data);
  if (!c) throw new ConversationError("failed", "Couldn't reply just now. Try again in a moment.");
  put(updateId, { comments: [...threadOf(threads, updateId).comments.filter((x) => x.id !== c.id), c] });
  return c;
}

/** Change your own reply (marked edited). */
export async function editUpdateComment(c: UpdateComment, body: string): Promise<UpdateComment> {
  const text = body.trim().slice(0, COMMENT_MAX);
  if (!text) throw new ConversationError("failed", "A reply can't be empty. Delete it instead.");
  let next: UpdateComment = { ...c, body: text, editedAt: new Date().toISOString() };
  if (supabase) {
    const { data, error } = await supabase.from("status_update_comments").update({ body: text }).eq("id", c.id).select(COMMENT_COLUMNS);
    if (error) throw failure(error, "save that");
    const got = parseUpdateComment((data as unknown[] | null)?.[0]);
    if (!got) throw new ConversationError("not_allowed", "Only the person who wrote a reply can change it.");
    next = got;
  }
  put(c.updateId, { comments: threadOf(threads, c.updateId).comments.map((x) => (x.id === c.id ? next : x)) });
  return next;
}

/** Delete a reply: your own, or (owners and admins) anyone's. */
export async function deleteUpdateComment(c: UpdateComment): Promise<void> {
  if (supabase) {
    const { data, error } = await supabase.from("status_update_comments").delete().eq("id", c.id).select("id");
    if (error) throw failure(error, "delete that");
    if (!(data as unknown[] | null)?.length) throw new ConversationError("not_allowed", "Only its writer, or a workspace owner or admin, can delete a reply.");
  }
  put(c.updateId, { comments: threadOf(threads, c.updateId).comments.filter((x) => x.id !== c.id) });
}

/** Add your reaction, or take it back. Shown at once; put back if the database says no. */
export async function toggleUpdateReaction(updateId: string, emoji: string, me: string): Promise<void> {
  const before = threadOf(threads, updateId).reactions;
  const had = (before[emoji] ?? []).includes(me);
  const next = { ...before, [emoji]: had ? (before[emoji] ?? []).filter((x) => x !== me) : [...(before[emoji] ?? []), me] };
  if (!next[emoji].length) delete next[emoji];
  put(updateId, { reactions: next });
  if (!supabase) return;
  const res = had
    ? await supabase.from("status_update_reactions").delete().eq("update_id", updateId).eq("user_id", me).eq("emoji", emoji)
    : await supabase.from("status_update_reactions").insert({ update_id: updateId, user_id: me, emoji });
  if (res.error) {
    put(updateId, { reactions: before });
    throw failure(res.error, "react");
  }
}

/** You've read these updates (the ones you didn't write): "seen by" counts you. Best-effort. */
export async function markUpdatesSeen(ids: readonly string[], me: string, authorOf: (id: string) => string | null | undefined): Promise<void> {
  const fresh = [...new Set(ids)].filter((id) => id && !id.startsWith("tmp-") && authorOf(id) !== me && !threadOf(threads, id).seenBy.includes(me));
  if (!fresh.length || missing || !me) return;
  threads = new Map(threads);
  for (const id of fresh) threads.set(id, { ...threadOf(threads, id), seenBy: [...threadOf(threads, id).seenBy, me] });
  tell();
  if (!supabase) return;
  try {
    const { error } = await supabase.rpc("mark_status_updates_seen", { p_ids: fresh.slice(0, 200) });
    if (error && isMissing(error)) { missing = true; tell(); }
  } catch { /* offline: it's counted next time */ }
}

/** Email and push for the people a new update is for (the database has already put it in their Inbox). Best-effort. */
export function notifyUpdatePosted(updateId: string): void {
  if (!supabase || !updateId || updateId.startsWith("tmp-")) return;
  try {
    void supabase.functions.invoke("notify", { body: { kind: "status_update", updateId } }).then(() => undefined, () => undefined);
  } catch { /* not deployed: the Inbox still has it */ }
}

/** "Seen by Maya, Theo and 4 others" for a tooltip; "Seen by 6" is the visible line. */
export function seenByNames(ids: readonly string[], nameOf: (id: string) => string | undefined = (id) => getMember(id)?.name): string {
  const names = ids.map((id) => nameOf(id)?.split(/\s+/)[0]).filter((n): n is string => !!n);
  if (!names.length) return "";
  if (names.length <= 3) return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

/** Tests and demo: start again (optionally with these threads). */
export function resetUpdateConversation(seed: Record<string, Partial<UpdateThread>> = {}): void {
  threads = new Map(Object.entries(seed).map(([id, t]) => [id, { ...EMPTY, ...t }]));
  loaded = new Set(Object.keys(seed));
  missing = false; seq = 0; tell();
}

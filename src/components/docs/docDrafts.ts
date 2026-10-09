/* ============================================================
   KANBO — doc changes that didn't reach the server.          [0047, w5]
   When a doc closes with changes it couldn't save (offline, a refusal,
   or someone else's save still waiting on "keep mine or reload"), the
   editor keeps them here and offers them back the next time that doc
   opens. The same home as a task's unsaved title and description
   (taskDetailHelpers: this tab's sessionStorage, the "kanbo-unsaved:"
   prefix), so clearTaskDrafts() forgets them on sign-out and they never
   outlive the tab on a shared desk. Keyed by the signed-in person too:
   someone else signing in here is never offered them. While one is
   waiting in this tab, closing or reloading the tab asks first.
   ============================================================ */
import type { DocBlock } from "../../data/types";
import { parseDocBody } from "../../lib/docs";

/** must match UNSAVED_PREFIX in components/taskDetailHelpers.ts (cleared on sign-out) */
export const DOC_DRAFT_PREFIX = "kanbo-unsaved:";
const draftKey = (userId: string, docId: string) => `${DOC_DRAFT_PREFIX}${userId}:doc:${docId}`;

export interface DocDraft {
  title: string;
  body: DocBlock[];
  /** the updatedAt the changes were made on */
  base: string;
  /** when they were kept (ISO) */
  at: string;
  /** which keep this was (forget only removes the one you kept) */
  id: string;
}

function store(): Storage | null {
  try { return typeof window !== "undefined" ? window.sessionStorage : null; } catch { return null; }
}

/* closing the tab while a kept draft hasn't been saved: let the browser ask */
const waiting = new Set<string>();
const onLeave = (e: BeforeUnloadEvent) => {
  // (only ones still there: signing out clears them — clearTaskDrafts — and then reloads)
  const s = store();
  let any = false;
  try { for (const k of waiting) if (s?.getItem(k) != null) { any = true; break; } } catch { /* storage blocked */ }
  if (!any) return;
  e.preventDefault();
  e.returnValue = "";
};
function track(key: string, on: boolean) {
  if (typeof window === "undefined") return;
  const had = waiting.size > 0;
  if (on) waiting.add(key); else waiting.delete(key);
  if (!had && waiting.size) window.addEventListener("beforeunload", onLeave);
  else if (had && !waiting.size) window.removeEventListener("beforeunload", onLeave);
}

let seq = 0;

/** Keep changes for this doc (replacing any kept before). Returns which keep it was; null when this
 *  browser won't store them (blocked, or full). */
export function keepDocDraft(userId: string, docId: string, d: { title: string; body: DocBlock[]; base: string }): string | null {
  const s = store();
  if (!s || !userId || !docId) return null;
  const k = draftKey(userId, docId);
  const draft: DocDraft = { title: d.title, body: d.body, base: d.base, at: new Date().toISOString(), id: `${Date.now().toString(36)}-${++seq}` };
  try {
    s.setItem(k, JSON.stringify(draft));
  } catch {
    return null;
  }
  track(k, true);
  return draft.id;
}

function read(s: Storage, k: string): DocDraft | null {
  try {
    const raw = JSON.parse(s.getItem(k) || "null") as Partial<DocDraft> | null;
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.body) || typeof raw.base !== "string" || typeof raw.at !== "string") return null;
    return { title: typeof raw.title === "string" ? raw.title : "", body: parseDocBody(raw.body), base: raw.base, at: raw.at, id: typeof raw.id === "string" ? raw.id : "" };
  } catch {
    return null;
  }
}

/** What's kept for this doc, left where it is. */
export function peekDocDraft(userId: string, docId: string): DocDraft | null {
  const s = store();
  return s && userId && docId ? read(s, draftKey(userId, docId)) : null;
}

/** What's kept for this doc, taken out (the editor holds it while it offers it back). */
export function takeDocDraft(userId: string, docId: string): DocDraft | null {
  const s = store();
  if (!s || !userId || !docId) return null;
  const k = draftKey(userId, docId);
  const d = read(s, k);
  try { s.removeItem(k); } catch { /* storage blocked */ }
  track(k, false);
  return d;
}

/** Forget what's kept for this doc; with `id`, only if it's still that keep (not one kept since). */
export function forgetDocDraft(userId: string, docId: string, id?: string): void {
  const s = store();
  if (!s || !userId || !docId) return;
  const k = draftKey(userId, docId);
  if (id !== undefined) {
    const cur = read(s, k);
    if (cur && cur.id !== id) return;
  }
  try { s.removeItem(k); } catch { /* storage blocked */ }
  track(k, false);
}

/** "at 14:32" today · "on 8 Oct at 14:32" · "on 8 Oct 2025 at 14:32". */
export function draftWhen(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return `at ${time}`;
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: d.getFullYear() === n.getFullYear() ? undefined : "numeric" });
  return `on ${date} at ${time}`;
}

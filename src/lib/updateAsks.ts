/* ============================================================
   KANBO — "Ask for an update" (0053). A workspace's owners and admins
   can ask a project's owner for its status update from any project
   row (the directory, a portfolio, the Group page). The database
   keeps it to one ask per project in 20 hours, and 30 a day per asker
   (ask_for_update); the owner hears through the notify queue (push
   and email, with their digest and quiet hours) and in Today's update
   line until they post. Asks are read by the two people in them.
   Demo: in memory (nobody's asked yet). Before 0053: the button isn't
   offered.
   ============================================================ */
import { useEffect, useSyncExternalStore } from "react";
import type { Project, Role, StatusUpdate, UpdateAsk } from "../data/types";
import { errText } from "./rowUtils";
import { supabase } from "./supabase";

export const ASK_COLUMNS = "id,project_id,workspace_id,asked_by,owner_id,created_at";
/** an ask is answered by an update posted after it; one this old has had its say */
export const ASK_SHOWN_DAYS = 7;
/** the same project can be asked about again after this long */
export const ASK_AGAIN_HOURS = 20;
const HOUR = 3_600_000;

export type AskFailure = "recent" | "not_allowed" | "unavailable" | "failed";
export class AskError extends Error {
  constructor(readonly reason: AskFailure, message: string) { super(message); this.name = "AskError"; }
}

/** update_asks (anything) → an ask, or null. */
export function parseAsk(r: unknown): UpdateAsk | null {
  const o = r as Record<string, unknown> | null;
  if (!o || typeof o.id !== "string" || typeof o.project_id !== "string" || typeof o.owner_id !== "string" || typeof o.asked_by !== "string") return null;
  return { id: o.id, projectId: o.project_id, workspaceId: String(o.workspace_id ?? ""), askedBy: o.asked_by, ownerId: o.owner_id, createdAt: String(o.created_at ?? "") };
}

/* ---------- the asks you can read (yours, and those to you) ---------- */

let rows: UpdateAsk[] = [];
let loaded: "no" | "loading" | "yes" = "no";
/** whose asks are loaded (another sign-in reads its own) */
let loadedFor: string | null = null;
let missing = false;
let seq = 0;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** Is "Ask for an update" there to offer? (Before 0053 the table and function aren't.) */
export const asksOn = (): boolean => !missing;

const isMissing = (e: unknown) => {
  const code = String((e as { code?: unknown })?.code ?? "");
  return code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205" || /could not find|does not exist|schema cache/i.test(errText(e));
};

/** Read the last week's asks for `me` (once per person; again after `force`). */
export async function loadUpdateAsks(me: string, force = false): Promise<UpdateAsk[]> {
  if (!supabase) { loaded = "yes"; return rows; }
  if (!me || missing || (loaded !== "no" && loadedFor === me && !force)) return rows;
  if (loadedFor !== me) { rows = []; loadedFor = me; }
  loaded = "loading";
  const since = new Date(Date.now() - ASK_SHOWN_DAYS * 24 * HOUR).toISOString();
  const { data, error } = await supabase.from("update_asks").select(ASK_COLUMNS).gte("created_at", since).order("created_at", { ascending: false }).limit(500);
  if (error) {
    loaded = "no";
    if (isMissing(error)) { missing = true; tell(); }
    return rows;
  }
  loaded = "yes";
  rows = ((data as unknown[] | null) ?? []).map(parseAsk).filter((a): a is UpdateAsk => !!a);
  tell();
  return rows;
}

/** Every ask you (`me`) can read, kept current; loads once you're signed in, and again for someone else. */
export function useUpdateAsks(me: string): UpdateAsk[] {
  const list = useSyncExternalStore(subscribe, () => rows, () => rows);
  useEffect(() => { if (me) void loadUpdateAsks(me); }, [me]);
  return list;
}

/** Email + push for the owner: best-effort (the ask itself is saved either way, and shows on their Today). */
function notifyAsk(askId: string): void {
  if (!supabase) return;
  try {
    void supabase.functions.invoke("notify", { body: { kind: "update_ask", askId } }).then(() => undefined, () => undefined);
  } catch { /* not deployed: Today still shows it */ }
}

/** Ask a project's owner for an update (rpc ask_for_update). Throws AskError. */
export async function askForUpdate(project: Pick<Project, "id" | "workspaceId" | "ownerId">, me: string, now: Date = new Date()): Promise<UpdateAsk> {
  if (!supabase) {
    if (!project.ownerId || !project.workspaceId || project.ownerId === me) throw new AskError("not_allowed", "There's nobody else to ask.");
    if (recentAsk(rows, project.id, now)) throw new AskError("recent", "Someone asked about this project today.");
    const a: UpdateAsk = { id: `ask-demo-${++seq}`, projectId: project.id, workspaceId: project.workspaceId, askedBy: me, ownerId: project.ownerId, createdAt: now.toISOString() };
    rows = [a, ...rows];
    tell();
    return a;
  }
  if (missing) throw new AskError("unavailable", "Asking for updates isn't switched on yet.");
  const { data, error } = await supabase.rpc("ask_for_update", { p_project: project.id });
  if (error) {
    if (isMissing(error)) { missing = true; tell(); throw new AskError("unavailable", "Asking for updates isn't switched on yet."); }
    const m = errText(error);
    if (/recent|already asked/i.test(m)) throw new AskError("recent", "Someone asked about this project today.");
    if (/too many/i.test(m)) throw new AskError("recent", "You've asked for a lot of updates today. Try again tomorrow.");
    if (/not authori[sz]ed|not allowed|no owner|own project/i.test(m)) throw new AskError("not_allowed", "Only the workspace's owners and admins can ask.");
    throw new AskError("failed", "Couldn't ask just now. Try again in a moment.");
  }
  const a = parseAsk(Array.isArray(data) ? data[0] : data);
  if (!a) throw new AskError("failed", "Couldn't ask just now. Try again in a moment.");
  rows = [a, ...rows.filter((x) => x.id !== a.id)];
  tell();
  notifyAsk(a.id);
  return a;
}

/* ---------- reading them ---------- */

/** The latest ask about a project in the last ASK_AGAIN_HOURS (anyone's you can read). */
export function recentAsk(asks: readonly UpdateAsk[], projectId: string, now: Date = new Date()): UpdateAsk | undefined {
  const since = now.getTime() - ASK_AGAIN_HOURS * HOUR;
  return asks.find((a) => a.projectId === projectId && Date.parse(a.createdAt) >= since);
}

/** May you ask for this project's update? You lead its workspace (owner or admin), and someone else owns it. */
export function canAskFor(p: Pick<Project, "id" | "workspaceId" | "ownerId" | "archivedAt">, me: string, role: Role | null | undefined): boolean {
  return !!p.workspaceId && !!p.ownerId && p.ownerId !== me && !p.archivedAt && p.id !== "p-personal" && (role === "owner" || role === "admin");
}

/** Asks to you that your projects haven't answered yet (no update since), newest first, one per project. */
export function asksAwaiting(asks: readonly UpdateAsk[], me: string, latestOf: (projectId: string) => Pick<StatusUpdate, "createdAt"> | undefined, now: Date = new Date()): UpdateAsk[] {
  const since = now.getTime() - ASK_SHOWN_DAYS * 24 * HOUR;
  const seen = new Set<string>();
  return [...asks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter((a) => {
    if (a.ownerId !== me || a.askedBy === me || seen.has(a.projectId) || Date.parse(a.createdAt) < since) return false;
    const latest = latestOf(a.projectId);
    if (latest && latest.createdAt >= a.createdAt) return false;
    seen.add(a.projectId);
    return true;
  });
}

/** What the project rows need: may you ask, have you (or someone) just asked, and ask. */
export interface AskForUpdate {
  canAsk: (p: Project) => boolean;
  /** the ask in the last ASK_AGAIN_HOURS, if any */
  asked: (p: Project) => UpdateAsk | undefined;
  ask: (p: Project) => Promise<UpdateAsk>;
}

/** The rows' AskForUpdate for the signed-in person (`roleIn`: their role in a workspace). */
export function useAskForUpdate(me: string, roleIn: (workspaceId: string | null | undefined) => Role | null): AskForUpdate | undefined {
  const asks = useUpdateAsks(me);
  if (!asksOn()) return undefined;
  return {
    canAsk: (p) => canAskFor(p, me, roleIn(p.workspaceId)),
    asked: (p) => recentAsk(asks, p.id),
    ask: (p) => askForUpdate(p, me),
  };
}

/** Tests: start again. */
export function resetUpdateAsks(seed: UpdateAsk[] = []): void {
  rows = seed; loaded = "no"; loadedFor = null; missing = false; seq = 0; tell();
}

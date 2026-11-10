/* ============================================================
   KANBO — what this database's project updates can hold: whether
   0054's columns (status_updates.sections and ask_user_ids) are in.
   The store learns it from the update rows it reads and writes (and,
   with none to read, from one small probe at sign-in); until then it's
   unknown. Picking the people an Ask is for is offered only once 0054
   is known to be in: before it nobody could be told, so the composer
   and the editor don't promise it (the Ask's words still post, in the
   update itself). Demo: in.
   ============================================================ */
import { useSyncExternalStore } from "react";
import { supabase } from "./supabase";

/** "full": 0054's columns are there; "old": they aren't (yet); null: not known yet. */
export type UpdateColumns = "full" | "old" | null;

let columns: UpdateColumns = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** The store: what a read or a write just showed. */
export function noteUpdateColumns(next: "full" | "old"): void {
  if (columns === next) return;
  columns = next;
  listeners.forEach((fn) => fn());
}

/** What's known so far. */
export const updateColumns = (): UpdateColumns => columns;

/** May an update name the people its Asks are for (and so tell them)? Only once 0054 is known to be in. */
export const updateAsksOn = (): boolean => !supabase || columns === "full";

/** updateAsksOn, kept current. */
export function useUpdateAsksOn(): boolean {
  return useSyncExternalStore(subscribe, updateAsksOn, updateAsksOn);
}

/** Tests: start again. */
export function resetUpdateColumns(next: UpdateColumns = null): void {
  columns = next;
  listeners.forEach((fn) => fn());
}

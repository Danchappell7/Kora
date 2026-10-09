/* ============================================================
   KANBO — saved views (public.saved_views, 0048).      [0048 contract → u6]
   Any filtered list — My tasks, a project's list or board, a search —
   saved with a name and an emoji, personal or shared with the workspace.
   • Rules (the database enforces them): you read your own and the shared
     ones of your workspaces (guests too, read-only); writers share; you
     edit your own; owners/admins also rename, unpin or delete shared
     ones (they stay their maker's). A pinned shared view is pinned for
     everyone; each person may hide one for themselves and order the
     sidebar their own way (per-viewer, localStorage "kanbo-views-order:<userId>").
   • Old saved searches move across transparently: listSavedViews calls
     adopt_saved_searches() once per session (same ids; pinned; kind
     "search"), so the sidebar's old "Saved" entries become Views.
   • Live counts are computed here from the tasks the app holds
     (viewCount), the same predicate the list itself uses.
   • Demo mode: realistic fake views (DEMO_SAVED_VIEWS), kept in memory.
   ============================================================ */
import type { Role, SavedView, SavedViewInput, SavedViewPatch, Task } from "../data/types";
import type { Route } from "../app-types";

export { parseSavedView, parseSavedViewQuery, savedViewFailure, SAVED_VIEW_LIMITS } from "./viewRows";

/** select= for saved_views (every column) */
export const SAVED_VIEW_COLUMNS = "id,workspace_id,user_id,name,emoji,kind,query,pinned,position,shared,created_at,updated_at";

export interface ViewContext {
  tasks: Task[];
  currentUserId: string;
  /** "today" for due-date filters (pin it in tests) */
  today?: Date;
}

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package u6)`));

/** Your views + the workspace's shared ones (workspaceId null: Personal's). Adopts old saved searches once. */
export function listSavedViews(_workspaceId: string | null): Promise<SavedView[]> { return notBuilt("listSavedViews"); }
export function createSavedView(_input: SavedViewInput): Promise<SavedView> { return notBuilt("createSavedView"); }
export function updateSavedView(_id: string, _patch: SavedViewPatch): Promise<SavedView> { return notBuilt("updateSavedView"); }
export function deleteSavedView(_id: string): Promise<void> { return notBuilt("deleteSavedView"); }
/** Your own views' positions in this order (shared ones you don't own: per-viewer order, local). */
export function reorderSavedViews(_ids: string[]): Promise<void> { return notBuilt("reorderSavedViews"); }
/** rpc adopt_saved_searches (old saved searches → views); how many moved. */
export function adoptLegacySavedSearches(): Promise<number> { return notBuilt("adoptLegacySavedSearches"); }
/** Realtime: a view in this scope changed. Returns unsubscribe. */
export function subscribeSavedViews(_workspaceId: string | null, _onChange: () => void): () => void { return () => undefined; }

/** Does this task belong in the view? (the list's own predicate: lib/searchQuery taskMatchesQuery + the view's scope) */
export function viewMatchesTask(_view: SavedView, _task: Task, _ctx: ViewContext): boolean { return false; }
/** The sidebar's live count. */
export function viewCount(_view: SavedView, _ctx: ViewContext): number { return 0; }
/** Where the view opens. */
export function viewRoute(_view: SavedView): Route { return { view: "tasks" }; }

/** May this person rename / unpin / delete it?  [final] */
export function canEditView(view: Pick<SavedView, "userId" | "shared" | "workspaceId">, me: { userId: string; role: Role | null }): boolean {
  if (view.userId === me.userId) return true;
  return view.shared && view.workspaceId !== null && (me.role === "owner" || me.role === "admin");
}
/** May this person share views here? (writers in a team workspace; never Personal, never guests)  [final] */
export function canShareViews(role: Role | null, workspaceId: string | null): boolean {
  return workspaceId !== null && (role === "owner" || role === "admin" || role === "member");
}

/** Demo mode's views (Personal + the demo team), built from the demo world in data.ts. */
export const DEMO_SAVED_VIEWS: readonly SavedView[] = [];

/* ============================================================
   KANBO — the sidebar's Views group (under My tasks): your pinned
   saved views (and the team's pinned shared ones you haven't hidden),
   each with its emoji, a quiet "shared" mark and its live count.
   • Click opens it (lib/views viewRoute). The open one is the page
     (aria-current), not My tasks or its project.
   • Reorder: drag with a mouse or pen (Escape cancels; a drop never
     opens the view), or ⌥↑ / ⌥↓ on a focused row, or the ⋯ menu's
     Move up / Move down (the way on touch); a polite live region says
     where it went. The order is yours (this device; your own views'
     positions follow — only the moved one is written, as a rule).
   • ⋯ or a right-click (Shift+F10, the context-menu key, a long press on
     Android): rename in place (also F2), edit, change the icon, share /
     stop sharing (your own views only), unpin (for everyone, on a shared
     view), hide a
     teammate's from your sidebar, copy its link, delete with Undo.
     Guests and anyone else who can't change a view get only what's theirs
     to do: details, hide, order, link.
   • "All views" lists the rest (unpinned, hidden, past the first six).
   Lazy: the list can't show before lib/savedViews/remote has fetched it,
   so this module arrives alongside; the Sidebar renders it in Suspense.
   ============================================================ */
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../primitives";
import { useToast } from "../Toast";
import type { Role, SavedView, Task } from "../../data/types";
import type { Route } from "../../app-types";
import { chunk, lazyComponent, prefetch } from "../../lib/lazyLoad";
import {
  canEditView, canShareViews, isViewActive, reorderSavedViews, savedViewFailure, updateSavedView, useViewerMarks,
} from "../../lib/views";
import { viewCounts as countViews } from "../../lib/savedViews/counts";
import { savedViewMessage } from "../../lib/savedViews/messages";
import { ViewGlyph, SharedGlyph } from "./ViewGlyph";
import { ViewMenu } from "./ViewMenu";
import "./savedViews.css";

/** Pinned views shown under My tasks; the rest are in All views. */
export const MAX_SIDEBAR_VIEWS = 6;

const editorChunk = chunk(() => import("../views/SavedViewEditor"));
const LazySavedViewEditor = lazyComponent(editorChunk, (m) => m.SavedViewEditor, "SavedViewEditor");
const allViewsChunk = chunk(() => import("./AllViews"));
const LazyAllViews = lazyComponent(allViewsChunk, (m) => m.AllViews, "AllViews");
const warm = () => prefetch(editorChunk, allViewsChunk);
/** The editor and All views, ahead of need (an idle warm-up; tests). */
export function warmSidebarViewSheets(): Promise<void> {
  return Promise.all([editorChunk(), allViewsChunk()]).then(() => undefined);
}

/** Move one item of a list to another index. */
function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, it);
  return next;
}

function ViewRow({ view, count, active, shareName, dragging, renaming, menuOpen, onOpen, onPointerDown, onKeyDown, onMenu, onRename, onRenameEnd, buttonRef, moreRef }: {
  view: SavedView;
  count: number | null | undefined;
  active: boolean;
  /** the workspace a shared view is shared with */
  shareName: string;
  dragging: boolean;
  renaming: boolean;
  /** its ⋯ menu is open (the button stays shown) */
  menuOpen: boolean;
  onOpen: () => void;
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onMenu: () => void;
  onRename: (name: string) => void;
  onRenameEnd: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
  moreRef: (el: HTMLButtonElement | null) => void;
}) {
  const label = `${view.name}${count != null ? `, ${count} ${count === 1 ? "task" : "tasks"}` : ""}${view.shared ? `, shared with ${shareName}` : ""}`;
  const done = useRef(false);
  useEffect(() => { if (renaming) done.current = false; }, [renaming]);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    const name = value?.trim();
    if (name && name !== view.name) onRename(name);
    onRenameEnd();
  };
  return (
    <div className="ksaved-row kview-row" data-dragging={dragging || undefined}
      onContextMenu={(e: ReactMouseEvent) => { if (renaming) return; e.preventDefault(); onMenu(); }}>
      {renaming ? (
        <input className="kfield kview-rename" defaultValue={view.name} aria-label={`Rename view ${view.name}`} maxLength={80}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); finish(e.currentTarget.value); }
            else if (e.key === "Escape") { e.preventDefault(); finish(null); }
          }}
          onBlur={(e) => finish(e.currentTarget.value)} />
      ) : (
        <button ref={buttonRef} type="button" className="knav" data-nested="" data-view-id={view.id} data-active={active || undefined} aria-current={active ? "page" : undefined}
          aria-label={label} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown F2" onClick={onOpen} onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
          <ViewGlyph view={view} />
          <span className="knav-label">{view.name}</span>
          {view.shared && <SharedGlyph />}
          {count != null && <span className="knav-count knav-badge" aria-hidden="true">{count}</span>}
        </button>
      )}
      {!renaming && (
        <button ref={moreRef} type="button" className="ksaved-del kview-more" aria-label={`Options for view ${view.name}`} title="View options"
          aria-haspopup="menu" aria-expanded={menuOpen} onPointerEnter={warm} onFocus={warm}
          onClick={(e) => { e.stopPropagation(); onMenu(); }}>
          <Icon name="more" size={14} sw={2} />
        </button>
      )}
    </div>
  );
}

export interface SidebarViewsProps {
  /** every view in this workspace you can see (lib/views useSavedViews(...).views) */
  views: SavedView[];
  /** counts by id from the host; missing ones are counted here over `tasks` */
  counts?: Record<string, number | null | undefined>;
  tasks: Task[];
  route: Route;
  currentUserId: string;
  myRole: Role | null;
  /** a view's workspace name ("Personal" for a personal search) */
  shareName: (v: SavedView) => string;
  /** the active workspace's name (All views' notes) */
  workspaceName: string;
  onOpen: (view: SavedView) => void;
  /** the host's own editor (default: SavedViewEditor here) */
  onEditView?: (view: SavedView) => void;
  onReorderViews?: (ids: string[]) => void | Promise<unknown>;
}

export function SidebarViews({ views, counts: hostCounts, tasks, route, currentUserId, myRole, shareName, workspaceName, onOpen, onEditView, onReorderViews }: SidebarViewsProps) {
  const toast = useToast();
  const marks = useViewerMarks();
  const me = { userId: currentUserId, role: myRole };
  const shown = useMemo(() => views.filter((v) => v.pinned && !marks.hiddenIds.has(v.id)).slice(0, MAX_SIDEBAR_VIEWS), [views, marks]);
  const offSidebar = views.length - shown.length;
  const own = useMemo(() => (hostCounts ? null : countViews(views, { tasks, currentUserId })), [hostCounts, views, tasks, currentUserId]);
  const counts: Record<string, number | null | undefined> = hostCounts ?? own ?? {};
  const fail = (e: unknown) => toast.error(savedViewMessage(savedViewFailure(e), "change"));

  const rowEls = useRef(new Map<string, HTMLButtonElement>());
  const moreEls = useRef(new Map<string, HTMLButtonElement>());
  const [refocus, setRefocus] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!refocus) return;
    rowEls.current.get(refocus)?.focus({ preventScroll: true });
    setRefocus(null);
  }, [refocus]);
  const [announce, setAnnounce] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState<SavedView | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorIcon, setEditorIcon] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const allBtnRef = useRef<HTMLButtonElement>(null);

  const editView = (v: SavedView, icon = false) => {
    if (onEditView) { onEditView(v); return; }
    setEditing(v); setEditorIcon(icon); setEditorOpen(true);
  };
  const openMenu = (v: SavedView) => {
    menuAnchor.current = moreEls.current.get(v.id) ?? rowEls.current.get(v.id) ?? null;
    warm();
    setMenuFor(v.id);
  };
  // the sidebar's rows in their new order (the views off the sidebar keep their places after them)
  const commitOrder = (shownIds: string[]) => {
    let result: void | Promise<unknown>;
    try { result = (onReorderViews ?? reorderSavedViews)(shownIds); } catch (e) { result = Promise.reject(e); }
    Promise.resolve(result).catch(fail);
  };
  const moveBy = (v: SavedView, delta: -1 | 1) => {
    const ids = shown.map((x) => x.id);
    const i = ids.indexOf(v.id), j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    commitOrder(moveItem(ids, i, j));
    setRefocus(v.id);
    setAnnounce(`Moved ${v.name} to position ${j + 1} of ${ids.length}`);
  };
  /** after a delete, focus goes to the row below (or above) */
  const focusNeighbour = (v: SavedView) => {
    const ids = shown.map((x) => x.id);
    const i = ids.indexOf(v.id);
    const next = ids[i + 1] ?? ids[i - 1];
    if (next) setRefocus(next);
  };

  // drag a view to reorder it (mouse and pen; on touch, and from the keyboard: Move up / down or ⌥↑ / ⌥↓)
  const [drag, setDrag] = useState<{ id: string; to: number } | null>(null);
  const dragRef = useRef<{ id: string; name: string; from: number; to: number; x: number; y: number; active: boolean; shown: boolean; mids: number[] } | null>(null);
  const swallowClick = useRef(false);
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const onRowPointerDown = (v: SavedView) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || e.pointerType === "touch" || shown.length < 2 || renaming) return;
    const from = shown.findIndex((x) => x.id === v.id);
    if (from < 0) return;
    dragCleanup.current?.();
    const rows = shown;
    dragRef.current = { id: v.id, name: v.name, from, to: from, x: e.clientX, y: e.clientY, active: false, shown: false, mids: [] };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.active) {
        if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 4) return;
        d.active = true;
        d.mids = rows.map((x) => { const r = rowEls.current.get(x.id)?.getBoundingClientRect(); return r ? r.top + r.height / 2 : 0; });
      }
      ev.preventDefault();
      // the slot among the rows as they stood when the drag began
      const to = d.mids.filter((m, i) => i !== d.from && m < ev.clientY).length;
      if (to !== d.to || !d.shown) { d.to = to; d.shown = true; setDrag({ id: d.id, to }); }
    };
    const finish = (commit: boolean) => {
      dragCleanup.current?.();
      const d = dragRef.current;
      dragRef.current = null;
      if (!d?.active) return;
      swallowClick.current = true;
      window.setTimeout(() => { swallowClick.current = false; }, 0);
      setDrag(null);
      if (!commit || d.to === d.from) return;
      const ids = moveItem(rows.map((x) => x.id), d.from, d.to);
      commitOrder(ids);
      setAnnounce(`Moved ${d.name} to position ${d.to + 1} of ${ids.length}`);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape" && dragRef.current?.active) { ev.preventDefault(); ev.stopPropagation(); finish(false); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    dragCleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      dragCleanup.current = null;
    };
  };
  const onRowKey = (v: SavedView) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault(); e.stopPropagation();
      moveBy(v, e.key === "ArrowUp" ? -1 : 1);
    } else if (e.key === "F2" && canEditView(v, me)) {
      e.preventDefault();
      setRenaming(v.id);
    }
  };

  const display = drag ? moveItem(shown, shown.findIndex((v) => v.id === drag.id), drag.to) : shown;
  const menuView = menuFor ? views.find((v) => v.id === menuFor) : undefined;
  const editingView = editing ? views.find((v) => v.id === editing.id) ?? editing : null;
  if (views.length === 0 && !allOpen && !editorOpen) return null;

  return (
    <div role="group" aria-label="Saved views" className="kviews" data-reordering={drag ? "" : undefined}>
      {display.map((v) => (
        <ViewRow key={v.id} view={v} count={counts[v.id]} active={isViewActive(v, route)} shareName={shareName(v)}
          dragging={drag?.id === v.id} renaming={renaming === v.id} menuOpen={menuFor === v.id}
          onOpen={() => { if (!swallowClick.current) onOpen(v); }} onPointerDown={onRowPointerDown(v)} onKeyDown={onRowKey(v)}
          onMenu={() => openMenu(v)} onRename={(name) => { updateSavedView(v.id, { name }).catch(fail); }}
          onRenameEnd={() => { setRenaming(null); setRefocus(v.id); }}
          buttonRef={(el) => { if (el) rowEls.current.set(v.id, el); else rowEls.current.delete(v.id); }}
          moreRef={(el) => { if (el) moreEls.current.set(v.id, el); else moreEls.current.delete(v.id); }} />
      ))}
      {(offSidebar > 0 || allOpen) && (
        <button ref={allBtnRef} type="button" className="knav" data-nested="" aria-haspopup="dialog" aria-expanded={allOpen}
          aria-label={offSidebar > 0 ? `All views, ${offSidebar} more` : "All views"} onClick={() => setAllOpen((o) => !o)} onPointerEnter={warm} onFocus={warm}>
          <Icon name="layers" size={14} sw={1.75} className="knav-ico" />
          <span className="knav-label">All views</span>
          {offSidebar > 0 && <span className="knav-count" aria-hidden="true">{offSidebar}</span>}
        </button>
      )}
      {/* (aria-live without role="status": the toasts are the page's status line) */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{announce}</span>

      {menuView && (
        <ViewMenu view={menuView} anchorRef={menuAnchor} onClose={() => setMenuFor(null)} currentUserId={currentUserId} myRole={myRole}
          legacy={marks.legacyIds.has(menuView.id)} shareName={shareName} index={shown.findIndex((x) => x.id === menuView.id)} count={shown.length}
          onRename={() => setRenaming(menuView.id)} onEdit={(icon) => editView(menuView, icon)} onMove={(d) => moveBy(menuView, d)}
          onDeleted={() => focusNeighbour(menuView)} />
      )}
      {editingView && (
        <Suspense fallback={null}>
          <LazySavedViewEditor open={editorOpen} view={editingView} workspaceId={editingView.workspaceId} workspaceName={shareName(editingView)}
            canShare={canShareViews(myRole, editingView.workspaceId)} canEdit={canEditView(editingView, me)} currentUserId={currentUserId} pickIcon={editorIcon}
            onClose={() => { setEditorOpen(false); setRefocus(editingView.id); }} />
        </Suspense>
      )}
      {allOpen && (
        <Suspense fallback={null}>
          <LazyAllViews open={allOpen} anchorRef={allBtnRef} onClose={() => setAllOpen(false)} views={views} counts={counts}
            hiddenIds={marks.hiddenIds} legacyIds={marks.legacyIds} route={route} currentUserId={currentUserId} myRole={myRole}
            workspaceName={workspaceName} shareName={shareName} onOpen={onOpen} onDetails={(v) => editView(v)} />
        </Suspense>
      )}
    </div>
  );
}

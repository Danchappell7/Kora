/* ============================================================
   KANBO — All views: every saved view in this workspace, from the
   sidebar's "All views" row. The pinned ones first (what the sidebar
   shows), then the rest: each opens with one click, a star pins or
   unpins it (for everyone, on a shared view you may edit), an eye shows
   or hides a teammate's pinned view in YOUR sidebar only, and ⋯ opens
   its details (the editor; read-only when it isn't yours to change).
   A dialog popover: Tab moves through it, Escape closes. Lazy.
   ============================================================ */
import type { RefObject } from "react";
import { Icon } from "../primitives";
import { Popover } from "../primitives/Popover";
import type { Role, SavedView } from "../../data/types";
import type { Route } from "../../app-types";
import { canEditView, isViewActive } from "../../lib/views";
import { ViewGlyph, SharedGlyph } from "./ViewGlyph";
import { useViewActions } from "./ViewMenu";
import "./savedViews.css";

export interface AllViewsProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  views: readonly SavedView[];
  counts: Record<string, number | null | undefined>;
  hiddenIds: ReadonlySet<string>;
  legacyIds: ReadonlySet<string>;
  route: Route;
  currentUserId: string;
  myRole: Role | null;
  workspaceName?: string;
  /** the workspace a view is shared in (for the toasts) */
  shareName?: (v: SavedView) => string;
  onOpen: (view: SavedView) => void;
  onDetails: (view: SavedView) => void;
  /** pin / unpin (default: lib/views, with a toast and Undo) */
  onPin?: (view: SavedView, pinned: boolean) => void;
  /** hide / show in your sidebar (default: lib/views, with a toast and Undo) */
  onHide?: (view: SavedView, hidden: boolean) => void;
}

function Star({ filled }: { filled: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinejoin="round">
      <path d="M12 3.6l2.55 5.2 5.75.84-4.16 4.05.98 5.72L12 16.72l-5.12 2.69.98-5.72-4.16-4.05 5.75-.84z" />
    </svg>
  );
}

export function AllViews({ open, anchorRef, onClose, views, counts, hiddenIds, legacyIds, route, currentUserId, myRole, workspaceName, shareName, onOpen, onDetails, onPin, onHide }: AllViewsProps) {
  const me = { userId: currentUserId, role: myRole };
  const act = useViewActions({ currentUserId, shareName: shareName ?? (() => workspaceName ?? "the workspace") });
  const pin = onPin ?? act.pin;
  const hide = onHide ?? act.hide;
  const inSidebar = views.filter((v) => v.pinned && !hiddenIds.has(v.id));
  const rest = views.filter((v) => !v.pinned || hiddenIds.has(v.id));
  const row = (v: SavedView) => {
    const editable = canEditView(v, me);
    const legacy = legacyIds.has(v.id);
    const hidden = hiddenIds.has(v.id);
    const count = counts[v.id];
    const active = isViewActive(v, route);
    const mine = v.userId === currentUserId;
    const sharedNote = v.shared ? `, shared with ${shareName?.(v) ?? workspaceName ?? "the workspace"}` : "";
    return (
      <div key={v.id} className="kav-row">
        <button type="button" className="kav-open" aria-current={active ? "page" : undefined} data-hidden={hidden || undefined}
          aria-label={`${v.name}${count != null ? `, ${count} ${count === 1 ? "task" : "tasks"}` : ""}${sharedNote}${hidden ? ", hidden from your sidebar" : ""}`}
          onClick={() => { onClose(); onOpen(v); }}>
          <ViewGlyph view={v} />
          <span className="kav-name">{v.name}</span>
          {v.shared && <SharedGlyph />}
          {count != null && <span className="kav-n" aria-hidden="true">{count}</span>}
        </button>
        {editable && !legacy && !hidden ? (
          <button type="button" className="kav-act" aria-pressed={v.pinned}
            aria-label={`Pin ${v.name} to the sidebar${v.shared ? " for everyone" : ""}`} title={v.pinned ? "Unpin" : "Pin to sidebar"}
            onClick={() => pin(v, !v.pinned)}>
            <Star filled={v.pinned} />
          </button>
        ) : (v.pinned && !mine) || hidden ? (
          <button type="button" className="kav-act" aria-pressed={!hidden}
            aria-label={`Show ${v.name} in my sidebar`} title={hidden ? "Show in my sidebar" : "Hide from my sidebar"}
            onClick={() => hide(v, !hidden)}>
            <Icon name="eye" size={14} sw={1.75} />
          </button>
        ) : <span className="kav-act" aria-hidden="true" />}
        <button type="button" className="kav-act" aria-label={editable ? `Edit ${v.name}` : `About ${v.name}`} title={editable ? "Edit view" : "About this view"}
          onClick={() => { onClose(); onDetails(v); }}>
          <Icon name="more" size={14} sw={1.75} />
        </button>
      </div>
    );
  };
  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} role="dialog" label="All views" minWidth={260} maxHeight={440} style={{ padding: 4 }}>
      <div className="kav">
        <div className="kav-head"><h2>All views</h2></div>
        {views.length === 0 ? (
          <p className="kav-empty">No saved views yet. Filter any list (My tasks, a project or Search) and choose Save view.</p>
        ) : (
          <>
            {inSidebar.length > 0 && <h3 className="kav-group">In your sidebar</h3>}
            {inSidebar.map(row)}
            {rest.length > 0 && <h3 className="kav-group">Not in your sidebar</h3>}
            {rest.map(row)}
          </>
        )}
        <p className="kav-foot">Pinning a shared view pins it for everyone. Hiding one only changes your sidebar.</p>
      </div>
    </Popover>
  );
}

/* ============================================================
   KANBO — a saved view's ⋯ menu (the sidebar row's ⋯, or a right-click
   on it) and the actions it shares with All views. What it offers
   follows who you are: the view's maker (and owners/admins, for a
   shared one) may rename, edit, change its icon, share or stop sharing,
   unpin (for everyone, when shared) and delete — with Undo; anyone may
   hide a teammate's pinned view from their own sidebar, move a view up
   or down in their sidebar, and copy its link. Lazy: loaded the first
   time a menu opens (warmed when the pointer or focus reaches a ⋯).
   ============================================================ */
import type { ReactNode, RefObject } from "react";
import { Icon, Kbd } from "../primitives";
import { Popover } from "../primitives/Popover";
import { MenuSeparator } from "../Topbar";
import { useToast } from "../Toast";
import type { Role, SavedView } from "../../data/types";
import { pathOf } from "../../lib/nav";
import {
  canEditView, canShareViews, savedViewFailure, setViewHidden, stageDeleteSavedView, updateSavedView, viewRoute,
} from "../../lib/views";
import { savedViewMessage } from "../../lib/savedViews/messages";

/** The view actions, each with its toast (and Undo where it can be taken back). */
export function useViewActions(opts: { currentUserId: string; shareName: (v: SavedView) => string }) {
  const toast = useToast();
  const fail = (e: unknown, action: "change" | "delete" = "change") => toast.error(savedViewMessage(savedViewFailure(e), action));
  return {
    pin(v: SavedView, pinned: boolean) {
      updateSavedView(v.id, { pinned }).catch((e: unknown) => fail(e));
      if (!pinned) toast.action(`Unpinned “${v.name}”${v.shared ? " for everyone" : ""}`, "Undo", () => { updateSavedView(v.id, { pinned: true }).catch((e: unknown) => fail(e)); });
    },
    hide(v: SavedView, hidden: boolean) {
      setViewHidden(v.id, hidden);
      if (hidden) toast.action(`Hid “${v.name}” from your sidebar`, "Undo", () => setViewHidden(v.id, false));
    },
    share(v: SavedView, shared: boolean) {
      updateSavedView(v.id, { shared }).catch((e: unknown) => fail(e));
      toast.toast(shared ? `Shared “${v.name}” with ${opts.shareName(v)}`
        : v.userId === opts.currentUserId ? `“${v.name}” is just yours again` : `“${v.name}” is back to being private to its maker`);
    },
    remove(v: SavedView) {
      const staged = stageDeleteSavedView(v.id);
      toast.action(`Deleted “${v.name}”`, "Undo", staged.undo, {
        onExpire: () => { staged.commit().catch((e: unknown) => toast.error(`Couldn't delete “${v.name}”. ${savedViewMessage(savedViewFailure(e), "delete")}`)); },
      });
    },
    copyLink(v: SavedView) {
      const failed = () => toast.error("Couldn't copy the link.");
      try { navigator.clipboard.writeText(`${window.location.origin}${pathOf(viewRoute(v))}`).then(() => toast.success("Link copied"), failed); }
      catch { failed(); }
    },
  };
}

function Item({ icon, label, kbd, tone, disabled, onClick }: { icon?: ReactNode; label: string; kbd?: string; tone?: "danger"; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className="kmenu-item" data-tone={tone} disabled={disabled} onClick={onClick}>
      {icon}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      {kbd && <span aria-hidden="true" style={{ display: "inline-flex" }}><Kbd>{kbd}</Kbd></span>}
    </button>
  );
}

const glyph = (d: ReactNode) => (
  <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.75}
    strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--icon-quiet, var(--ink-4))" }}>{d}</svg>
);
const PENCIL = glyph(<><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></>);
const STAR = glyph(<path d="M12 3.6l2.55 5.2 5.75.84-4.16 4.05.98 5.72L12 16.72l-5.12 2.69.98-5.72-4.16-4.05 5.75-.84z" fill="currentColor" />);

export interface ViewMenuProps {
  view: SavedView;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  currentUserId: string;
  myRole: Role | null;
  /** an old saved search (rename, move and delete only) */
  legacy: boolean;
  /** the workspace a view is shared in ("Share with Foundrise") */
  shareName: (v: SavedView) => string;
  /** its place among the sidebar's rows (-1: not shown there) and how many there are */
  index: number;
  count: number;
  onRename: () => void;
  onEdit: (pickIcon?: boolean) => void;
  onMove: (delta: -1 | 1) => void;
  /** after Delete (the sidebar moves focus to a neighbour) */
  onDeleted?: () => void;
}

export function ViewMenu({ view: v, anchorRef, onClose, currentUserId, myRole, legacy, shareName, index, count, onRename, onEdit, onMove, onDeleted }: ViewMenuProps) {
  const act = useViewActions({ currentUserId, shareName });
  const editable = canEditView(v, { userId: currentUserId, role: myRole });
  const mine = v.userId === currentUserId;
  const run = (fn: () => void) => () => { onClose(); fn(); };
  return (
    <Popover open anchorRef={anchorRef} onClose={onClose} label={`Options for view ${v.name}`} minWidth={224} style={{ padding: 4 }}>
      {editable && <Item icon={PENCIL} label="Rename" kbd="F2" onClick={run(onRename)} />}
      <Item icon={<Icon name="sliders" size={16} sw={1.75} />} label={editable ? "Edit view…" : "About this view…"} onClick={run(() => onEdit())} />
      {editable && !legacy && <Item icon={<Icon name="sparkles" size={16} sw={1.75} />} label="Change icon…" onClick={run(() => onEdit(true))} />}
      {editable && !legacy && canShareViews(myRole, v.workspaceId) && (
        <Item icon={<Icon name="users" size={16} sw={1.75} />} label={v.shared ? "Stop sharing" : `Share with ${shareName(v)}`} onClick={run(() => act.share(v, !v.shared))} />
      )}
      {editable && !legacy && v.pinned && (
        <Item icon={STAR} label={v.shared ? "Unpin for everyone" : "Unpin from sidebar"} onClick={run(() => act.pin(v, false))} />
      )}
      {v.shared && !mine && v.pinned && (
        <Item icon={<Icon name="eye" size={16} sw={1.75} />} label="Hide from my sidebar" onClick={run(() => act.hide(v, true))} />
      )}
      <MenuSeparator />
      <Item icon={<Icon name="chevronDown" size={16} sw={1.75} style={{ transform: "rotate(180deg)" }} />} label="Move up" kbd="⌥↑" disabled={index <= 0} onClick={run(() => onMove(-1))} />
      <Item icon={<Icon name="chevronDown" size={16} sw={1.75} />} label="Move down" kbd="⌥↓" disabled={index < 0 || index >= count - 1} onClick={run(() => onMove(1))} />
      <Item icon={<Icon name="link" size={16} sw={1.75} />} label="Copy link" onClick={run(() => act.copyLink(v))} />
      {editable && (
        <>
          <MenuSeparator />
          <Item icon={<Icon name="trash" size={16} sw={1.75} />} label="Delete view" tone="danger" onClick={run(() => { act.remove(v); onDeleted?.(); })} />
        </>
      )}
    </Popover>
  );
}

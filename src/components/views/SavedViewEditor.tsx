/* ============================================================
   KANBO — save / edit a view.                          [0048 stub → u6]
   SavedViewEditor: a small sheet — name, emoji (the primitives'
   EmojiPicker), "Pin to sidebar", "Share with <workspace>" (writers only;
   explains that everyone in the workspace will see it, read-only for
   guests), what it shows (a readable summary of the filters, grouping and
   sort), Save / Delete (with confirm). SaveViewButton: the toolbar button
   that appears in list / board / search toolbars when filters are active
   ("Save view"), opening the editor prefilled. Both through lib/views
   (createSavedView / updateSavedView / deleteSavedView); toasts with Undo
   for delete. Keyboard and screen-reader complete; demo mode works.
   Render nothing until package u6 builds them.
   ============================================================ */
import type { SavedView, SavedViewKind, SavedViewQuery } from "../../data/types";

export interface SavedViewEditorProps {
  open: boolean;
  /** editing this view; absent = a new one from `draft` */
  view?: SavedView | null;
  /** a new view: what it saves */
  draft?: { kind: SavedViewKind; query: SavedViewQuery; name?: string; emoji?: string | null } | null;
  /** the scope it's saved in (null = Personal) and its name ("Share with Foundrise") */
  workspaceId: string | null;
  workspaceName?: string;
  /** writers in a team workspace (lib/views canShareViews) */
  canShare: boolean;
  /** owner/admin editing someone else's shared view, or your own (lib/views canEditView) */
  canEdit?: boolean;
  onClose: () => void;
  onSaved?: (view: SavedView) => void;
  onDeleted?: (id: string) => void;
}

export function SavedViewEditor(_props: SavedViewEditorProps) {
  return null;
}

export interface SaveViewButtonProps {
  kind: SavedViewKind;
  /** the toolbar's current filters / grouping / sort as a view query */
  query: SavedViewQuery;
  /** show only when something is filtered (the host decides; false renders nothing) */
  active: boolean;
  workspaceId: string | null;
  workspaceName?: string;
  canShare: boolean;
  /** suggested name ("Blocked in Launch") */
  suggestedName?: string;
  size?: "sm" | "md";
  onSaved?: (view: SavedView) => void;
}

export function SaveViewButton(_props: SaveViewButtonProps) {
  return null;
}

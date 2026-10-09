/* ============================================================
   KANBO — a saved view's mark: its emoji, or a quiet icon for where
   it opens (My tasks: list · a project: its list / board / calendar /
   timeline · a search: the magnifier). Decorative (the row names the
   view). Tiny: the Sidebar draws it in the first download.
   ============================================================ */
import { Icon } from "../primitives";
import type { IconName, SavedView } from "../../data/types";

const TYPE_ICON: Record<string, IconName> = { list: "list", board: "board", calendar: "calendar", timeline: "timeline" };

export function viewIcon(view: Pick<SavedView, "kind" | "query">): IconName {
  if (view.kind === "search") return "search";
  if (view.kind === "project") return TYPE_ICON[view.query?.viewType ?? "list"] ?? "list";
  return "tasks";
}

export function ViewGlyph({ view, size = 14 }: { view: Pick<SavedView, "kind" | "query" | "emoji">; size?: 14 | 16 }) {
  if (view.emoji) {
    return <span className="kview-emoji" aria-hidden="true" style={{ width: size + 2, fontSize: size - 1 }}>{view.emoji}</span>;
  }
  return <Icon name={viewIcon(view)} size={size} sw={1.75} className="knav-ico" />;
}

/** "shared": the people mark, 12px, in the quiet ink (the Sidebar and the All views list). */
export function SharedGlyph() {
  return <Icon name="users" size={12} sw={2} className="kview-shared" />;
}

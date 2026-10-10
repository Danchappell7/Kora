/* ============================================================
   KANBO — the filters a search's words were read as (searchNL chips):
   the icon each kind of chip wears and how a screen reader names one.
   Shared by the Search page's chips (components/search/SearchParts)
   and ⌘K's, so the two always say the same thing.
   ============================================================ */
import type { IconName, SearchChip, SearchChipKind } from "../../data/types";

export const CHIP_ICON: Record<SearchChipKind, IconName> = {
  assignee: "user", author: "message", project: "folder", status: "circle", due: "calendar", kind: "layers", archived: "archive", open: "circle",
};

/** How a screen reader names a chip ("assigned to Maya Lin", "status blocked", "due Fri 16 Oct"). */
export function chipSpoken(c: Pick<SearchChip, "kind" | "label">): string {
  const lower = c.label.charAt(0).toLowerCase() + c.label.slice(1);
  switch (c.kind) {
    case "assignee": return /^assigned/i.test(c.label) ? lower : `assigned to ${c.label}`;
    case "author": return `comments ${lower}`;
    case "status": return `status ${lower}`;
    case "open": return "open tasks only";
    case "kind": return `showing ${lower}`;
    default: return lower;
  }
}

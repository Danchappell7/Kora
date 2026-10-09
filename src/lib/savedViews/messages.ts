/* ============================================================
   KANBO — saved views: what went wrong, in a sentence (the editor,
   the ⋯ menu and the sidebar's toasts). Its own module so the first
   download doesn't carry it.
   ============================================================ */
import type { SavedViewFailure } from "../../data/types";

/** What went wrong, in a sentence. */
export function savedViewMessage(f: SavedViewFailure, action: "save" | "change" | "delete" | "load" = "save"): string {
  switch (f) {
    case "not_allowed": return action === "delete" ? "You can't delete this view." : "You can't change views here.";
    case "too_many": return "You've reached 300 saved views. Delete one to save another.";
    case "invalid": return "That view is too big or its name is too long.";
    case "not_found": return "That view no longer exists.";
    case "unavailable": return "Saved views aren't available yet.";
    case "network": return "You're offline. Try again when you're back online.";
    default: return action === "load" ? "Couldn't load your views." : `Couldn't ${action} the view. Please try again.`;
  }
}

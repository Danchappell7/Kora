/* ============================================================
   KANBO — where the task panel keeps text between visits (this tab's
   sessionStorage): unsent comment drafts and title/description edits
   that couldn't be saved. Its own module so sign-out can forget them
   (clearTaskDrafts) without loading the task panel's code.
   ============================================================ */

/** unsent comment drafts: `kanbo-draft:<user>:<task>` */
export const DRAFT_PREFIX = "kanbo-draft:";
/** title/description text that couldn't be saved: `kanbo-unsaved:<user>:<task>:<field>` */
export const UNSAVED_PREFIX = "kanbo-unsaved:";

/** Forget every unsent comment draft and unsaved edit in this tab (call on sign-out). */
export function clearTaskDrafts(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && (k.startsWith(DRAFT_PREFIX) || k.startsWith(UNSAVED_PREFIX))) doomed.push(k);
    }
    doomed.forEach((k) => sessionStorage.removeItem(k));
  } catch { /* storage blocked */ }
}

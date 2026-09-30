/* ============================================================
   KANBO — "just happened" registries for completion and drops.
   Completing a task often MOVES its row (e.g. into the Done group),
   which unmounts the checkbox mid-animation; the re-mounted control
   looks itself up here and finishes the celebration in place. The same
   idea serves drag-and-drop: a dropped card often re-mounts in its new
   column, so the "landed" settle is looked up by id on mount.
   Shared by Check (index.tsx) and StatusGlyph (kit.tsx); index.tsx
   re-exports these names unchanged.
   ============================================================ */

export const CELEBRATE_MS = 700;

const recentlyCompleted = new Map<string, number>();
export function markJustCompleted(key?: string) {
  if (!key) return;
  const now = Date.now();
  recentlyCompleted.forEach((t, k) => { if (now - t > 5000) recentlyCompleted.delete(k); });
  recentlyCompleted.set(key, now);
}
export function wasJustCompleted(key?: string): boolean {
  const t = key ? recentlyCompleted.get(key) : undefined;
  return !!t && Date.now() - t < CELEBRATE_MS;
}

const recentlyLanded = new Map<string, number>();
export function markJustLanded(key?: string) {
  if (!key) return;
  const now = Date.now();
  recentlyLanded.forEach((t, k) => { if (now - t > 5000) recentlyLanded.delete(k); });
  recentlyLanded.set(key, now);
}
export function wasJustLanded(key?: string): boolean {
  const t = key ? recentlyLanded.get(key) : undefined;
  return !!t && Date.now() - t < CELEBRATE_MS;
}

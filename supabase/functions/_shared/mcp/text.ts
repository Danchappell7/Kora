// ============================================================
// KANBO — long text in the MCP server's answers. Pure module.
// ============================================================

/** A description in a list, and in what a change answers with. */
export const LIST_TEXT_MAX = 200;
/** One page of a description in get_task. */
export const DETAIL_TEXT_MAX = 6_000;

/** At most `max` characters, never splitting a surrogate pair. */
export function cut(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xD800 && c <= 0xDBFF) end--;
  return { text: s.slice(0, end), truncated: true };
}

/**
 * Does this new description start with what a tool showed of a longer one, and then stop following it?
 * That's a shortened copy sent back, and saving it would lose everything past the cut for good.
 * An edit further on still follows the stored text past the cut, so it isn't caught by this.
 */
export function isCutCopy(stored: string, next: string): boolean {
  for (const n of [LIST_TEXT_MAX, DETAIL_TEXT_MAX / 2, DETAIL_TEXT_MAX]) {
    if (stored.length <= n) continue;
    const shown = cut(stored, n).text.trimEnd();
    if (shown && next.startsWith(shown) && !next.startsWith(stored.slice(0, shown.length + 16))) return true;
  }
  return false;
}

export const CUT_COPY_REFUSAL =
  "This task's description is longer than what was shown, and this would replace all of it with the shortened copy, so nothing was changed. " +
  "Use appendToDescription to add to it, read the rest with get_task's descriptionOffset, or send confirmReplaceDescription: true if the person wants the rest gone.";

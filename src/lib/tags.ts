/* ============================================================
   KANBO — tags the shell needs without loading the tag picker or the
   reports: the palette a new tag is coloured from (a tag reads as a dot
   and a word), and resolving a tag a rule names.
   ============================================================ */
import type { TagDef } from "../data/types";

export const TAG_COLORS: { c: string; name: string }[] = [
  { c: "oklch(0.74 0.16 305)", name: "purple" }, { c: "oklch(0.74 0.14 230)", name: "blue" }, { c: "oklch(0.75 0.13 155)", name: "green" },
  { c: "oklch(0.78 0.15 70)", name: "amber" }, { c: "oklch(0.66 0.2 20)", name: "red" }, { c: "oklch(0.7 0.02 240)", name: "grey" },
];

/** The tag id an "Add tag" action value refers to: the id itself, or — for
 *  rules saved before the tag picker, which stored free text — the one tag
 *  whose label matches (case-insensitive). null when there's no single match. */
export function resolveTagId(value: string, tags: Record<string, TagDef>): string | null {
  if (!value) return null;
  if (tags[value]) return value;
  const want = value.trim().toLowerCase();
  const hits = Object.entries(tags).filter(([, t]) => t.label.trim().toLowerCase() === want);
  return hits.length === 1 ? hits[0][0] : null;
}

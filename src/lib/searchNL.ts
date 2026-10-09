/* ============================================================
   KANBO — natural-language search filters (0048).      [0048 contract → u2]
   "Maya's overdue tasks in Launch"  → assignee Maya · overdue · project Launch
   "docs mentioning pricing"         → kinds [doc] · text "pricing"
   "blocked this week"               → status blocked · due this week
   "assigned to me due friday"       → assignee me · due Friday
   "comments by Theo about the deck" → kinds [comment] · author Theo · text "deck"
   Each filter found becomes a removable chip (SearchChip.patch is what it
   adds); what's left is the text to search. Dates are worked out in the
   person's timezone from `today` (pin it in tests). Names match members
   and projects with lib/nlp's matchMember / matchProject (accents and
   case folded; "Maya's" / "Maya’s"). Words that are only filler ("tasks",
   "show me", "all") vanish. British English ("colour"), both spellings
   accepted where it matters. Never throws; unknown input is all text.
   ============================================================ */
import type { Member, ParsedSearch, Project, SearchChip, SearchFilters } from "../data/types";

export interface SearchNLContext {
  members: Pick<Member, "id" | "name">[];
  projects: Pick<Project, "id" | "name">[];
  currentUserId: string;
  /** "today" for relative dates (a Date, or YYYY-MM-DD) */
  today: Date | string;
  /** the person's timezone (default Europe/London) */
  timezone?: string;
}

/** Parse a search box's input into text + filters + chips. */
export function parseSearchNL(input: string, _ctx: SearchNLContext): ParsedSearch {
  return { input, text: input.trim(), filters: {}, chips: [] };
}

/** Every chip's patch merged (later chips win on the same field).  [final] */
export function chipsToFilters(chips: readonly SearchChip[], base: SearchFilters = {}): SearchFilters {
  const out: SearchFilters = { ...base };
  for (const c of chips) Object.assign(out, c.patch);
  return out;
}

/** The same search without one chip (its words are gone from the text too).  [final] */
export function removeSearchChip(parsed: ParsedSearch, chipId: string, base: SearchFilters = {}): ParsedSearch {
  const chips = parsed.chips.filter((c) => c.id !== chipId);
  return { ...parsed, chips, filters: chipsToFilters(chips, base) };
}

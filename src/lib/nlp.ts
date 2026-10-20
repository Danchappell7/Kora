/* ============================================================
   KANBO — the one natural-language grammar (the app's door to it).
   Quick capture, New task, the Today capture, pasted notes and Ask
   all read a task sentence the same way:
     "call Sana fri 3pm ~30m #launch"  →  Fri · 15:00 · 30m estimate ·
                                          Q3 Product Launch · title "call Sana"

   The grammar itself lives in supabase/functions/_shared/nlp.ts, so the
   Slack app's /kanbo (an edge function) reads a sentence exactly as the
   app does: one copy, never two that drift. This file only makes the
   app's live "today" (KANBO_TODAY, refreshed by the live clock) the
   default day, as it always was.

   data.ts's parseCapture and parseTaskTokens are thin wrappers over
   parseTask (see `kinds`, `nextWeek` and `priorityWords`).
   ============================================================ */
// (a cycle with data.ts, which wraps parseTask: both sides only use the
// other's exports inside functions, so either may load first)
import { KANBO_TODAY } from "../data/data";
import * as grammar from "../../supabase/functions/_shared/nlp.ts";
import type { NlpContext, ParsedTask } from "../../supabase/functions/_shared/nlp.ts";

export type { NlpKind, NlpContext, NlpSpan, ParsedTask } from "../../supabase/functions/_shared/nlp.ts";
export {
  HOURS_RE, MINS_RE, DEEP_RE, fmtMinutes, matchProject, matchMember, tidyTitle, splitLines, segments, stripTokens,
} from "../../supabase/functions/_shared/nlp.ts";

/** "Fri 2 Oct" (with the year when it isn't this year's) */
export function dayLabel(iso: string, today: Date = KANBO_TODAY): string {
  return grammar.dayLabel(iso, today);
}

/**
 * Read a task sentence. Words that are read come out of the title and are
 * listed in `spans` (offsets into `text`). A time with no day means today, and
 * a repeat with no day starts on its first occurrence.
 */
export function parseTask(text: string, ctx: NlpContext = {}): ParsedTask {
  return grammar.parseTask(text, ctx.today ? ctx : { ...ctx, today: KANBO_TODAY });
}

/**
 * A day and/or time typed on its own ("fri", "3 Oct 15:00", "tomorrow at
 * 9.30"), for date fields: null when the text is anything more than that.
 * A time alone leaves `date` unset (the field keeps its day).
 */
export function parseDateText(text: string, today: Date = KANBO_TODAY): { date?: string; time?: string } | null {
  return grammar.parseDateText(text, today);
}

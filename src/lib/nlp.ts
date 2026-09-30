/* ============================================================
   KANBO — natural-language task grammar (one grammar for quick
   add, capture, Ask and pasted notes).
   W0 stub: parseTask delegates to data.ts's parseTaskTokens and
   records no spans; parseDateText knows today / tomorrow /
   weekend / next week and ISO dates. P14 replaces the bodies.
   ============================================================ */
import { parseTaskTokens, toLocalISO, KANBO_TODAY, type DuePreset } from "../data/data";
import type { Priority, Recurrence, EnergyKind } from "../data/types";

export interface NlpContext {
  today?: Date;
  projects?: { id: string; name: string }[];
  members?: { id: string; name: string }[];
  tags?: Record<string, { label: string }>;
}

/** Where a recognised token sits in the original text (for live highlighting). */
export interface NlpSpan {
  start: number;
  end: number;
  kind: "date" | "time" | "repeat" | "start" | "priority" | "project" | "person" | "tag" | "duration" | "estimate" | "energy";
  label: string;
}

export interface ParsedTask {
  title: string;
  dueDate?: string;
  dueTime?: string;
  startDate?: string;
  recurrence?: Recurrence;
  priority?: Priority;
  projectId?: string;
  assigneeId?: string;
  tags?: string[];
  focusMin?: number;
  effortHours?: number;
  energy?: EnergyKind;
  planToday?: boolean;
  spans: NlpSpan[];
}

export function parseTask(text: string, ctx: NlpContext = {}): ParsedTask {
  const t = parseTaskTokens(text, ctx.projects, ctx.members);
  return {
    title: t.title,
    ...(t.dueDate ? { dueDate: t.dueDate } : {}),
    ...(t.priority ? { priority: t.priority } : {}),
    ...(t.projectId ? { projectId: t.projectId } : {}),
    ...(t.assigneeId ? { assigneeId: t.assigneeId } : {}),
    ...(t.focusMin ? { focusMin: t.focusMin } : {}),
    spans: [],
  };
}

const PRESET_WORDS: Record<string, DuePreset> = {
  today: "today", tomorrow: "tomorrow", weekend: "weekend", "this weekend": "weekend", "next week": "nextweek",
};

/** The same arithmetic as data.ts presetDate, from any day (not only today). */
function presetFrom(kind: DuePreset, from: Date): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  if (kind === "tomorrow") d.setDate(d.getDate() + 1);
  else if (kind === "weekend") d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7)); // the coming Saturday
  else if (kind === "nextweek") d.setDate(d.getDate() + 7);
  return toLocalISO(d);
}

/** A date (and, later, a time) written in words: "tomorrow", "next week",
 *  "2026-10-02". Null when the text isn't one. */
export function parseDateText(text: string, today: Date = KANBO_TODAY): { date?: string; time?: string } | null {
  const w = text.trim().toLowerCase().replace(/\s+/g, " ");
  const preset = PRESET_WORDS[w];
  if (preset) return { date: presetFrom(preset, today) };
  const iso = w.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (d.getMonth() === Number(iso[2]) - 1) return { date: toLocalISO(d) };
  }
  return null;
}

/** Pasted lines → task titles with their nesting depth. Bullets and
 *  checkboxes are trimmed ("- ", "* ", "• ", "[ ] ", "- [ ] ", "1. "); a tab
 *  or two spaces of indent is one level; blank lines are dropped. */
export function splitLines(text: string): { title: string; depth: number }[] {
  const out: { title: string; depth: number }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^[\t ]*/)?.[0] ?? "";
    const depth = [...indent].reduce((n, c) => n + (c === "\t" ? 2 : 1), 0) >> 1;
    const title = raw.trim().replace(/^(?:[-*•]\s+)?(?:\[[ xX]?\]\s+)?(?:\d+[.)]\s+)?/, "").trim();
    if (title) out.push({ title, depth });
  }
  return out;
}

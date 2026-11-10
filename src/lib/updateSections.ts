/* ============================================================
   KANBO — an update's optional sections (0054): Highlights, Risks,
   Asks and Next, so a portfolio's roll-up reads the same way for
   every project. Kanbo's AI fills them; when it can't, the on-device
   draft writes Highlights, Risks and Next from the same facts as the
   update's words (Asks are left for the person: only they know what
   they need). Before 0054 they're kept in the update's text.
   Pure: no React, no I/O.
   ============================================================ */
import type { UpdateSections } from "../data/types";
import type { StatusFacts } from "./statusDraft";
import { fmtShortDay } from "./statusDraft";
import { localDay } from "../components/views/reportingUtils";

export const SECTION_KEYS = ["highlights", "risks", "asks", "next"] as const;
export type SectionKey = typeof SECTION_KEYS[number];
export const SECTION_LABELS: Record<SectionKey, string> = { highlights: "Highlights", risks: "Risks", asks: "Asks", next: "Next" };
export const SECTION_HINTS: Record<SectionKey, string> = {
  highlights: "What went well",
  risks: "What might slip, and why",
  asks: "What you need, and from whom",
  next: "What happens next",
};
/** the most a section holds (the database's limit) */
export const SECTION_MAX = 2000;

/** An update's sections (status_updates.sections) → its four optional parts; anything else dropped. */
export function parseSections(v: unknown): UpdateSections | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const out: UpdateSections = {};
  for (const k of SECTION_KEYS) if (typeof o[k] === "string" && (o[k] as string).trim()) out[k] = (o[k] as string).trim().slice(0, SECTION_MAX);
  return Object.keys(out).length ? out : undefined;
}

/** Does it say anything? */
export const hasSections = (s: UpdateSections | undefined | null): boolean => !!s && SECTION_KEYS.some((k) => !!s[k]?.trim());

/** The sections in words ("Highlights: …"), one per line: for a database without 0054, and for CSV. */
export function sectionsAsText(s: UpdateSections | undefined): string {
  if (!s) return "";
  return SECTION_KEYS.filter((k) => s[k]?.trim()).map((k) => `${SECTION_LABELS[k]}: ${s[k]!.trim()}`).join("\n");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clean = (title: string) => title.trim().replace(/[.!?;:,\s]+$/, "");
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Highlights, Risks and Next written on this device from a project's facts (Asks stay yours). */
export function draftSectionsLocal(f: StatusFacts): UpdateSections {
  const today = localDay(f.today) ?? new Date();
  const out: UpdateSections = {};
  if (f.done7.length) {
    const names = f.done7.slice(0, 3).map((t) => clean(t.title));
    out.highlights = f.done7.length > 3 ? `Done this week: ${list(names)}, and ${plural(f.done7.length - 3, "more task")}.` : `Done this week: ${list(names)}.`;
  } else if (f.health === "complete") out.highlights = "Every task is done.";
  const risks: string[] = [];
  const blocked = f.blocked[0];
  if (blocked) {
    const on = (f.waitingOn[blocked.id] ?? [])[0];
    risks.push(f.blocked.length === 1 ? `${clean(blocked.title)} is blocked${on ? ` on ${clean(on.title)}` : ""}.`
      : `${plural(f.blocked.length, "task is", "tasks are")} blocked, including ${clean(blocked.title)}.`);
  }
  const late = f.overdue.filter((t) => t.status !== "blocked");
  if (late.length) risks.push(late.length <= 2 ? `Overdue: ${list(late.map((t) => clean(t.title)))}.` : `${plural(late.length, "task")} overdue.`);
  if (f.slipped.length && risks.length < 2) risks.push(`${plural(f.slipped.length, "due date has", "due dates have")} moved later than planned.`);
  if (risks.length) out.risks = risks.join(" ");
  const next: string[] = [];
  if (f.nextMilestone) next.push(`${clean(f.nextMilestone.title)}, ${fmtShortDay(f.nextMilestone.dueDate, today)}.`);
  if (f.criticalPath && f.criticalPath.id !== f.nextMilestone?.id) next.push(`Unblock the critical path: ${clean(f.criticalPath.title)}.`);
  if (next.length) out.next = next.join(" ");
  return out;
}

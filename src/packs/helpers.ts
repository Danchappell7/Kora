/* ============================================================
   KANBO — the shorthand the business packs are written in.
   • t(section, title, days, hours, extras): due `days` after the
     day the pack is used (0 = that day).
   • before(section, title, days, hours, extras): due `days` before
     its project's anchor day ("90 days before opening").
   • after(section, title, days, hours, extras): `days` after it.
   • onTheDay(section, title, extras): the anchor day itself, as a
     milestone ("Opening day").
   Extras are anything else a task can have: priority ("low" …
   "urgent"), focusMin (its focus block, in minutes), description
   (Markdown), recurrence ("daily", "weekdays", "weekly", "biweekly",
   "monthly").
   ============================================================ */
import type { TemplateTask } from "../data/types";

type Extras = Partial<Omit<TemplateTask, "section" | "title" | "dueInDays" | "fromAnchor" | "effortHours">>;

export const t = (section: string, title: string, days: number, hours: number, extras: Extras = {}): TemplateTask =>
  ({ section, title, dueInDays: days, effortHours: hours, ...extras });

export const before = (section: string, title: string, days: number, hours: number, extras: Extras = {}): TemplateTask =>
  ({ section, title, fromAnchor: -Math.abs(days), effortHours: hours, ...extras });

export const after = (section: string, title: string, days: number, hours: number, extras: Extras = {}): TemplateTask =>
  ({ section, title, fromAnchor: Math.abs(days), effortHours: hours, ...extras });

export const onTheDay = (section: string, title: string, extras: Extras = {}): TemplateTask =>
  ({ section, title, fromAnchor: 0, milestone: true, priority: "high", ...extras });

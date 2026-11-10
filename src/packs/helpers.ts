/* ============================================================
   KANBO — the shorthand the business packs are written in.
   • t(section, title, days, hours, extras): due `days` after the
     day the pack is used (0 = that day).
   • before(section, title, days, hours, extras): due `days` before
     its project's anchor day ("90 days before opening").
   • after(section, title, days, hours, extras): `days` after it.
   • onTheDay(section, title, extras): the anchor day itself, as a
     milestone ("Opening day").
   • monthly(section, title, dayOfMonth, hours, extras): every month,
     by that day of it ("numbers in by the 10th").
   Extras are anything else a task can have: priority ("low" …
   "urgent"), focusMin (its focus block, in minutes), description
   (Markdown), recurrence ("daily", "weekdays", "weekly", "biweekly",
   "monthly"), forTeam (a routine whoever's on shift picks up, like
   opening checks: it's nobody's yet, so it doesn't land on your day).
   Dates skip weekends and the Christmas break (24 Dec to 1 Jan).
   ============================================================ */
import type { TemplateTask } from "../data/types";

type Extras = Partial<Omit<TemplateTask, "section" | "title" | "dueInDays" | "fromAnchor" | "dayOfMonth" | "effortHours">>;

export const t = (section: string, title: string, days: number, hours: number, extras: Extras = {}): TemplateTask =>
  ({ section, title, dueInDays: days, effortHours: hours, ...extras });

export const before = (section: string, title: string, days: number, hours: number, extras: Extras = {}): TemplateTask =>
  ({ section, title, fromAnchor: -Math.abs(days), effortHours: hours, ...extras });

export const after = (section: string, title: string, days: number, hours: number, extras: Extras = {}): TemplateTask =>
  ({ section, title, fromAnchor: Math.abs(days), effortHours: hours, ...extras });

export const onTheDay = (section: string, title: string, extras: Extras = {}): TemplateTask =>
  ({ section, title, fromAnchor: 0, milestone: true, priority: "high", ...extras });

export const monthly = (section: string, title: string, dayOfMonth: number, hours: number, extras: Extras = {}): TemplateTask =>
  ({ section, title, dayOfMonth, effortHours: hours, recurrence: "monthly", ...extras });

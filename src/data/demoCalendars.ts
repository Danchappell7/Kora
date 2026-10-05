/* ============================================================
   KANBO — demo calendars: two connected accounts (a work Google
   account and a personal Outlook), several calendars in each, each in
   its own colour, and a believable month of meetings. Demo mode only:
   the store hands these out when there's no Supabase.
   No imports from data.ts (data.ts colours its demo day from here), so
   the generator takes "today" and today's meetings as arguments.
   ============================================================ */
import type { CalEvent, CalProvider, ExtCalendar, ExternalEvent } from "./types";

export interface DemoCalendarAccount {
  id: string;
  provider: CalProvider;
  accountEmail: string;
  calendars: ExtCalendar[];
  /** ids shown in Kanbo; null = just the primary */
  selected: string[] | null;
}

const cal = (id: string, name: string, color: string, extra: Partial<ExtCalendar> = {}): ExtCalendar =>
  ({ id, name, color, primary: false, accessRole: "owner", ...extra });

/** Every demo calendar, by a short key. */
export const DEMO_CAL = {
  work: cal("daniel@foundrise.co", "Work", "#3f7fe0", { primary: true }),
  launch: cal("launch-team@group.calendar.google.com", "Launch team", "#2e9d6a", { accessRole: "writer" }),
  interviews: cal("interviews@group.calendar.google.com", "Interviews", "#e0663a", { accessRole: "writer" }),
  holidays: cal("en.uk#holiday@group.v.calendar.google.com", "Holidays in the United Kingdom", "#8a8f98", { accessRole: "reader" }),
  home: cal("AAMkAD-demo-calendar=", "Calendar", "#c98a1b", { primary: true }),
  family: cal("AAMkAD-demo-family=", "Family", "#a35bc4"),
  birthdays: cal("AAMkAD-demo-birthdays=", "Birthdays", "#d14d72"),
} as const;
type DemoCalKey = keyof typeof DEMO_CAL;

export const DEMO_CAL_ACCOUNT_IDS = { work: "demo-cal-google-work", home: "demo-cal-outlook-home" } as const;

/** A fresh copy of the demo accounts (the store keeps one per page session). */
export function demoCalendarAccounts(): DemoCalendarAccount[] {
  return [
    {
      id: DEMO_CAL_ACCOUNT_IDS.work, provider: "google", accountEmail: "daniel@foundrise.co",
      calendars: [DEMO_CAL.work, DEMO_CAL.holidays, DEMO_CAL.interviews, DEMO_CAL.launch].map((c) => ({ ...c })),
      selected: [DEMO_CAL.work.id, DEMO_CAL.launch.id, DEMO_CAL.interviews.id],
    },
    {
      id: DEMO_CAL_ACCOUNT_IDS.home, provider: "microsoft", accountEmail: "daniel.okai@outlook.com",
      calendars: [DEMO_CAL.home, DEMO_CAL.birthdays, DEMO_CAL.family].map((c) => ({ ...c })),
      selected: [DEMO_CAL.home.id, DEMO_CAL.family.id],
    },
  ];
}

/** Which calendar each of the demo day's meetings (data.ts EVENTS) sits in. */
export const DEMO_DAY_CALENDARS: Record<string, DemoCalKey> = { e1: "work", e5: "launch", e3: "work", e4: "work" };

/** The colour and calendar name for one of the demo day's meetings. */
export function demoDayCalendar(eventId: string): { color: string; calendarName: string } | undefined {
  const k = DEMO_DAY_CALENDARS[eventId];
  return k ? { color: DEMO_CAL[k].color, calendarName: DEMO_CAL[k].name } : undefined;
}

/** The weekly rhythm (0 = Sunday): calendar, title, start and end (24h, local). */
const WEEKLY: { days: number[]; cal: DemoCalKey; title: string; from: string; to: string }[] = [
  { days: [1, 3], cal: "home", title: "Gym", from: "07:00", to: "08:00" },
  { days: [1, 2, 3, 4, 5], cal: "work", title: "Team standup", from: "09:00", to: "09:30" },
  { days: [2, 4], cal: "launch", title: "Launch sync", from: "11:00", to: "11:30" },
  { days: [3], cal: "work", title: "Design review", from: "13:00", to: "14:00" },
  { days: [1], cal: "launch", title: "Launch readiness review", from: "14:00", to: "15:00" },
  { days: [4], cal: "interviews", title: "Interview: product designer", from: "15:00", to: "16:00" },
  { days: [5], cal: "work", title: "1:1 with Maya", from: "16:30", to: "17:00" },
  { days: [5], cal: "home", title: "Dinner with Sam", from: "19:30", to: "22:00" },
  { days: [6], cal: "family", title: "Swimming lessons", from: "10:00", to: "11:00" },
  { days: [0], cal: "family", title: "Lunch at Mum's", from: "13:00", to: "15:30" },
];
/** All-day, a set number of days from today. */
const ALL_DAY: { offset: number; cal: DemoCalKey; title: string }[] = [
  { offset: 9, cal: "birthdays", title: "Maya's birthday" },
  { offset: 11, cal: "family", title: "School inset day" },
  { offset: 23, cal: "birthdays", title: "Sam's birthday" },
];
/** Google's UK holidays calendar (fixed dates; month is 1-based). */
const HOLIDAYS: { m: number; d: number; title: string }[] = [
  { m: 1, d: 1, title: "New Year's Day" }, { m: 2, d: 14, title: "Valentine's Day" }, { m: 10, d: 31, title: "Halloween" },
  { m: 11, d: 5, title: "Guy Fawkes Night" }, { m: 11, d: 11, title: "Remembrance Day" },
  { m: 12, d: 25, title: "Christmas Day" }, { m: 12, d: 26, title: "Boxing Day" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const at = (day: Date, hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); const d = new Date(day); d.setHours(h, m, 0, 0); return d; };
const atMin = (day: Date, min: number) => { const d = new Date(day); d.setHours(0, min, 0, 0); return d; };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The demo accounts' events in [startISO, endISO), from the calendars each account shows.
 *  Today's timed meetings are exactly `todayEvents` (the demo day on Today), so Month and
 *  Today agree; the other days follow the weekly rhythm above. */
export function demoCalendarEvents(startISO: string, endISO: string, accounts: DemoCalendarAccount[], today: Date, todayEvents: CalEvent[]): ExternalEvent[] {
  const start = new Date(startISO), end = new Date(endISO);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return [];
  // calendar key → the account showing it (or nothing when it isn't shown)
  const shown = new Map<DemoCalKey, { account: DemoCalendarAccount; cal: ExtCalendar }>();
  for (const account of accounts) {
    const ids = account.selected ?? account.calendars.filter((c) => c.primary).map((c) => c.id);
    for (const id of ids) {
      const key = (Object.keys(DEMO_CAL) as DemoCalKey[]).find((k) => DEMO_CAL[k].id === id);
      const c = account.calendars.find((x) => x.id === id);
      if (key && c) shown.set(key, { account, cal: c });
    }
  }
  const out: ExternalEvent[] = [];
  const push = (key: DemoCalKey, title: string, s: Date, e: Date, allDay = false) => {
    const hit = shown.get(key);
    if (!hit) return;
    out.push({
      id: `demo-${key}-${ymd(s)}-${slug(title)}`, title, allDay,
      start: allDay ? ymd(s) : s.toISOString(), end: allDay ? ymd(e) : e.toISOString(),
      provider: hit.account.provider, connectionId: hit.account.id, calendarId: hit.cal.id, calendarName: hit.cal.name, color: hit.cal.color,
    });
  };
  const todayKey = ymd(today);
  const day = new Date(start); day.setHours(0, 0, 0, 0);
  for (let guard = 0; day < end && guard < 400; guard++, day.setDate(day.getDate() + 1)) {
    const key = ymd(day);
    if (key === todayKey) {
      for (const e of todayEvents) {
        const k = e.kind === "meeting" ? DEMO_DAY_CALENDARS[e.id] : undefined;
        if (k) push(k, e.title, atMin(day, e.start), atMin(day, e.end));
      }
    } else {
      for (const w of WEEKLY) if (w.days.includes(day.getDay())) push(w.cal, w.title, at(day, w.from), at(day, w.to));
    }
    const next = new Date(day); next.setDate(day.getDate() + 1);
    for (const h of HOLIDAYS) if (day.getMonth() + 1 === h.m && day.getDate() === h.d) push("holidays", h.title, day, next, true);
    const offset = Math.round((new Date(day).setHours(12) - new Date(today).setHours(12)) / 86_400_000);
    for (const a of ALL_DAY) if (a.offset === offset) push(a.cal, a.title, day, next, true);
  }
  return out.filter((e) => e.allDay || (Date.parse(e.end) > start.getTime() && Date.parse(e.start) < end.getTime()))
    .sort((a, b) => a.start.localeCompare(b.start));
}

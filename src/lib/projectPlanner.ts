/* ============================================================
   KANBO — "Plan a project with Kanbo" (New project › Plan it with Kanbo,
   the Projects empty state, ⌘K "Plan a project…", and "Add tasks with
   Kanbo" inside a project).                        [0047 contract → w3]

   Flow: describe (goal, deadline, people, constraints) → review (an
   editable PlanDraft grouped by section, a mini timeline, warnings) →
   create (applyProjectPlan through the host's own create paths).
   AI: ai-assist { mode: "plan", …AiPlanRequest } → { plan: AiPlanReply,
   usage } (supabase/functions/_shared/projectPlan.ts; counts toward the
   daily AI limit). No AI (no key, 400 no_api_key, offline, demo mode, the
   Settings switch off): fallbackPlan() — deterministic, from keywords.
   Dates: offsets are working days (Mon–Fri) from the start day (today in
   Europe/London, or the next working day).

   Everything here is pure except planWithAi (one function call) and
   applyProjectPlan (through the host's `deps`), so the planner works the
   same in demo mode, offline and signed in.
   ============================================================ */
import type {
  AiPlanReply, AiPlanRequest, AppliedProjectPlan, Member, PlanApplyDeps, PlanApplyProgress, PlanDraft, PlannerContext, PlannerFailure,
  PlannerInput, PlannerRosterMember, PlanSection, PlanTask, PlanWarning, Project, Section, Task,
} from "../data/types";
import {
  PLAN_DEFAULT_SECTION, PLAN_LIMITS, PLAN_PROJECT_NAME_MAX, planEmoji, planLine, planText, resolveRosterHint, validatePlanReply,
} from "../../supabase/functions/_shared/projectPlan.ts";
import { supabase } from "./supabase";
import { SPECTRUM, spectrumColor, stableHash, type SpectrumKey } from "./projectIdentity";
import { capacityOf, loadForWeek, loadTone, readCapacities } from "./radar";
import { KANBO_TODAY } from "../data/data";
import { addDays, localDay, startOfWeekMon } from "../components/views/reportingUtils";

export { PLAN_LIMITS } from "../../supabase/functions/_shared/projectPlan.ts";
export { PLAN_PROJECT_NAME_MAX } from "../../supabase/functions/_shared/projectPlan.ts";

/* ================================ dates ================================ */

const DAY_MS = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const noon = (iso: string) => Date.parse(iso + "T12:00:00Z");
const isoAt = (t: number) => new Date(t).toISOString().slice(0, 10);
const weekday = (iso: string) => new Date(noon(iso)).getUTCDay();
/** YYYY-MM-DD for a real calendar day. */
export const isPlanDay = (v: unknown): v is string => typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(noon(v)) && isoAt(noon(v)) === v;

/** Today in Europe/London, "YYYY-MM-DD" (the day the server plans from too). */
export function londonToday(now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export const isWorkingDay = (iso: string): boolean => { const d = weekday(iso); return d !== 0 && d !== 6; };

/** The plan's day 0: `today`, or the Monday after a Saturday or Sunday. */
export function planStartDay(today: string): string {
  const d = weekday(today);
  return d === 6 ? isoAt(noon(today) + 2 * DAY_MS) : d === 0 ? isoAt(noon(today) + DAY_MS) : today;
}

/** YYYY-MM-DD plus n working days (Mon–Fri). A weekend start counts from the Monday after; n may be negative. */
export function addWorkingDays(startISO: string, n: number): string {
  let t = noon(planStartDay(startISO));
  let left = Math.trunc(Number.isFinite(n) ? n : 0);
  const step = left < 0 ? -1 : 1;
  while (left !== 0) {
    t += step * DAY_MS;
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) left -= step;
  }
  return isoAt(t);
}

/** Working days from `startISO` to `iso` (a weekend day counts as the Friday before); negative before it. */
export function workingDaysBetween(startISO: string, iso: string): number {
  const a = noon(planStartDay(startISO)), b = noon(iso);
  if (b < a) {
    // working days in (iso, start]: a weekend day before the start counts as the Friday before it
    let n = 0;
    for (let t = a; t > b; t -= DAY_MS) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) n--; }
    return n;
  }
  let n = 0;
  for (let t = a + DAY_MS; t <= b; t += DAY_MS) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) n++; }
  return n;
}

/** A date someone picked → a working-day offset: a weekend start moves to the Monday after,
 *  a weekend due date to the Friday before; clamped to 0…PLAN_LIMITS.maxOffset. */
export function offsetForDate(startISO: string, iso: string, edge: "start" | "due"): number {
  let n = workingDaysBetween(startISO, iso);
  if (edge === "start" && !isWorkingDay(iso)) n += 1;
  return Math.min(PLAN_LIMITS.maxOffset, Math.max(0, n));
}

/** A draft task's dates. */
export function taskDates(draft: Pick<PlanDraft, "startDate">, t: Pick<PlanTask, "startOffset" | "dueOffset">): { start: string; due: string } {
  return { start: addWorkingDays(draft.startDate, t.startOffset), due: addWorkingDays(draft.startDate, t.dueOffset) };
}

/** The deadline as a working-day offset (null without one). */
export function deadlineOffset(draft: Pick<PlanDraft, "startDate" | "deadline">): number | null {
  return draft.deadline && isPlanDay(draft.deadline) ? workingDaysBetween(draft.startDate, draft.deadline) : null;
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Fri 20 Nov" */
export function planDayLabel(iso: string): string {
  const d = new Date(noon(iso));
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}
/** "12 Oct" */
export function planShortDay(iso: string): string {
  const d = new Date(noon(iso));
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/* ================================ copy ================================ */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtHours = (h: number) => `${Math.round(h * 10) / 10}h`;

/** Why the plan came from the device, and the planner's other sentences. */
export const PLANNER_COPY = {
  unavailable: "Kanbo AI isn't available right now, so this plan was drafted on this device.",
  off: "Kanbo AI is off in Settings, so this plan was drafted on this device.",
  demo: "In the demo, plans are drafted on this device.",
  offline: "You're offline, so this plan was drafted on this device.",
  limit: "You've used today's Kanbo AI requests. They reset at midnight (UK time).",
  notAllowed: "Your account is still awaiting approval, so Kanbo AI isn't available yet.",
  badOutput: "Kanbo's plan came back incomplete, so it couldn't be used.",
  timeout: "Kanbo took too long to draft the plan.",
  error: "Kanbo couldn't draft the plan just now.",
  guest: "Guests can view and comment. Ask a workspace admin for member access to plan projects.",
} as const;

/** Four goals to start from (step 1). */
export const PLANNER_EXAMPLES: readonly string[] = Object.freeze([
  "Launch our mobile app in the App Store, with a press push and an email to existing customers",
  "Hire a senior product designer and have them start before the end of the year",
  "Run a two-day team offsite in Lisbon for 30 people, with workshops and a dinner",
  "Redesign the marketing website with a new pricing page and customer stories",
]);

/* ================================ identity & names ================================ */

export type PlanCategory = "launch" | "event" | "hire" | "website" | "campaign" | "move" | "research" | "build" | "general";

interface CategoryMeta { label: string; emoji: string; hue: SpectrumKey; words: [RegExp, number][] }
const CATEGORY: Record<PlanCategory, CategoryMeta> = {
  launch: { label: "Launch", emoji: "🚀", hue: "cobalt", words: [[/\blaunch(es|ing)?\b/, 3], [/\b(release|go[- ]live|roll ?out|ship|announce|app store|play store|beta)\b/, 2], [/\b(product|feature|version|v\d)\b/, 1]] },
  event: { label: "Event", emoji: "📅", hue: "tangerine", words: [[/\b(off-?site|away ?day|retreat|conference|summit|meet-?up|hackathon|gala|festival)\b/, 4], [/\b(event|party|workshop|dinner|venue|celebration|ceremony|awards?)\b/, 3], [/\b(attendees|guests|speakers|catering)\b/, 2]] },
  hire: { label: "Hiring", emoji: "👥", hue: "jade", words: [[/\b(hire|hiring|recruit(ing|ment)?|headcount|vacancy)\b/, 4], [/\b(candidates?|interview(s|ing)?|job (ad|advert|description)|new starter|onboard(ing)?)\b/, 2]] },
  website: { label: "Website", emoji: "🖥️", hue: "lagoon", words: [[/\b(website|web ?site|landing page|homepage|home page|pricing page)\b/, 4], [/\b(site|web|cms|webflow|wordpress|seo|sitemap)\b/, 2], [/\bredesign\b/, 1]] },
  campaign: { label: "Campaign", emoji: "📣", hue: "rose", words: [[/\b(campaign|promotion|promo|black friday|newsletter|advertising|ads)\b/, 4], [/\b(marketing|social media|awareness|pr|press|influencers?|sale)\b/, 2]] },
  move: { label: "Office move", emoji: "🏠", hue: "amber", words: [[/\b(office move|move (the )?office|new office|relocat(e|ion|ing)|fit-? ?out)\b/, 5], [/\b(moving|move|lease|removals?)\b/, 1]] },
  research: { label: "Research", emoji: "🧪", hue: "violet", words: [[/\b(research|user interviews|usability|survey|study|discovery)\b/, 4], [/\b(insights?|participants|findings|personas?)\b/, 2]] },
  build: { label: "Build", emoji: "🛠️", hue: "sky", words: [[/\b(mvp|prototype|build|develop(ment)?|integration|api|migrat(e|ion)|refactor)\b/, 3], [/\b(app|feature|platform|dashboard|tool|software|mobile|backend|frontend)\b/, 1]] },
  general: { label: "General", emoji: "📋", hue: "iris", words: [] },
};
const CATEGORY_ORDER: PlanCategory[] = ["event", "hire", "move", "website", "campaign", "research", "launch", "build"];

/** The kind of project a goal describes (its keywords, weighted); "general" when nothing fits. */
export function planCategory(goal: string): PlanCategory {
  const g = ` ${(goal ?? "").toLowerCase()} `;
  let best: PlanCategory = "general", score = 0;
  for (const c of CATEGORY_ORDER) {
    let s = 0;
    for (const [re, w] of CATEGORY[c].words) if (re.test(g)) s += w;
    if (s > score) { best = c; score = s; }
  }
  return best;
}
export const planCategoryLabel = (c: PlanCategory): string => CATEGORY[c].label;

/** An emoji and a spectrum hue that suit the goal (the person can change both). */
export function suggestIdentity(goal: string): { emoji: string; hue: SpectrumKey } {
  const c = planCategory(goal);
  if (c !== "general") return { emoji: CATEGORY[c].emoji, hue: CATEGORY[c].hue };
  return { emoji: CATEGORY.general.emoji, hue: SPECTRUM[stableHash((goal ?? "").trim().toLowerCase()) % SPECTRUM.length].key };
}

const FILLER = /^(?:(?:please|can you|could you|help me|help us|i want to|i'd like to|we want to|we'd like to|we need to|i need to|we have to|we must|let's|lets|plan|planning|draft|create a plan (?:for|to)|make a plan (?:for|to)|a plan (?:for|to)|how (?:do|can) (?:i|we))\s+)+/i;
const TAIL = /\s+(?:by|before|until|no later than|in time for|ahead of|starting|from)\s+.*$/i;

const EVENT_VERB = /^(?:run|organi[sz]e|hold|host|throw|arrange|put on)\s+(?:a|an|the|our)\s+/i;

/** A short project name from the goal: its first clause, filler and the deadline phrase gone, ≤ 48 characters at a word.
 *  "Run a two-day team offsite in Lisbon for 30 people" → "Two-day team offsite in Lisbon". */
export function projectNameFrom(goal: string): string {
  let s = planLine(goal, 400).split(/(?<=[.!?])\s|[;:—–]|\s-\s|,\s/)[0] ?? "";
  s = s.replace(FILLER, "").replace(TAIL, "").replace(/[.!?]+$/, "").trim();
  s = s.replace(EVENT_VERB, "").replace(/^(?:a|an)\s+(?=\S)/i, "");
  // long: drop trailing "for 30 people", "with workshops"… one phrase at a time
  while (s.length > 40) {
    const m = /^(.*\S)\s+(?:for|with|in|at|to|on|from|across|including)\s+\S.*$/i.exec(s);
    if (!m || m[1].length < 12) break;
    s = m[1];
  }
  if (s.length > 48) {
    const cut = s.slice(0, 49);
    s = (cut.lastIndexOf(" ") > 20 ? cut.slice(0, cut.lastIndexOf(" ")) : cut.slice(0, 48)).replace(/[\s,;:]+$/, "");
  }
  if (!s) return "New project";
  return s.charAt(0).toLocaleUpperCase("en-GB") + s.slice(1);
}

/* ================================ roster ================================ */

/** The people a plan may assign, the person planning first (the fallback gives them the lead's work).
 *  Members may carry a workspace job `title` (WorkspaceMember.title): it helps both planners assign well. */
export function plannerRoster(members: ReadonlyArray<Member & { title?: string | null }>, opts: { guestIds?: readonly string[]; currentUserId?: string } = {}): PlannerRosterMember[] {
  const guests = new Set(opts.guestIds ?? []);
  const seen = new Set<string>();
  const out: PlannerRosterMember[] = [];
  for (const m of members) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    const title = typeof m.title === "string" && m.title.trim() ? m.title.trim().slice(0, 60) : null;
    out.push({ id: m.id, name: (m.name || m.email || "Someone").trim(), ...(title ? { title } : {}), ...(guests.has(m.id) ? { guest: true } : {}) });
  }
  const me = opts.currentUserId ? out.findIndex((r) => r.id === opts.currentUserId) : -1;
  if (me > 0) out.unshift(...out.splice(me, 1));
  return out.slice(0, PLAN_LIMITS.roster);
}

/** The roster a plan may use: the people picked, else everyone. */
function pickedRoster(input: PlannerInput, ctx: PlannerContext): PlannerRosterMember[] {
  const ids = input.memberIds?.length ? new Set(input.memberIds) : null;
  const roster = ctx.roster ?? [];
  return ids ? roster.filter((r) => ids.has(r.id)) : roster;
}

/* ================================ on-device planner ================================ */

type Role = "lead" | "design" | "eng" | "marketing" | "content" | "ops" | "people" | "sales" | "research" | "finance" | "any";
const ROLE_RE: Record<Role, RegExp> = {
  any: /$^/,
  lead: /\b(lead|head|manager|director|founder|ceo|coo|owner|pm|product manager|producer)\b/i,
  design: /\b(design(er)?|ux|ui|creative|art director|illustrat)/i,
  eng: /\b(engineer|developer|dev|cto|tech(nical)?|software|platform|backend|front-?end|full-?stack|qa|devops)\b/i,
  marketing: /\b(market(ing|er)?|growth|brand|comms|communications|social|pr|campaigns?)\b/i,
  content: /\b(content|writer|copy(writer)?|editor|comms|documentation)\b/i,
  ops: /\b(ops|operations|office|admin(istrator)?|facilities|events?|coordinator|assistant|logistics)\b/i,
  people: /\b(people|hr|talent|recruit(er|ing|ment)?)\b/i,
  sales: /\b(sales|account (manager|executive)|partnerships?|business development|bd|customer success)\b/i,
  research: /\b(research(er)?|insights?|analyst|data)\b/i,
  finance: /\b(finance|accountant|accounts|cfo|bookkeep(er|ing)|controller)\b/i,
};

interface TplTask {
  ref: string;
  title: string;
  role: Role;
  hours: number;
  /** working days it spans */
  days: number;
  after?: string[];
  milestone?: boolean;
  desc: string;
  /** only in plans whose goal suits it */
  when?: (f: GoalFacts) => boolean;
}
interface TplSection { name: string; tasks: TplTask[] }

/** Specifics read from the goal, for titles that sound like this project rather than any project. */
export interface GoalFacts {
  people?: number;
  place?: string;
  role?: string;
  travel: boolean;
}
const NOT_PLACES = /^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Q[1-4]|H[12]|Spring|Summer|Autumn|Winter|Kanbo|Time|Total|Person|Advance)$/;
export function goalFacts(goal: string): GoalFacts {
  const g = planLine(goal, PLAN_LIMITS.goal);
  const facts: GoalFacts = { travel: /\b(off-?site|retreat|away|abroad|travel|flights?|hotel|conference)\b/i.test(g) };
  const people = /\b(\d{1,4})\s*(?:people|guests|attendees|staff|colleagues|delegates|of us|employees|participants|team members)\b/i.exec(g);
  if (people) facts.people = Number(people[1]);
  const placeRe = /\bin ((?:[A-Z][\p{L}'’-]+)(?: [A-Z][\p{L}'’-]+)?)/gu;
  for (let m = placeRe.exec(g); m; m = placeRe.exec(g)) {
    if (!NOT_PLACES.test(m[1].split(" ")[0])) { facts.place = m[1]; facts.travel = facts.travel || true; break; }
  }
  const role = /\b(?:hire|hiring|recruit(?:ing)?)\s+(?:a|an|our|two|three|\d+)?\s*(?:new\s+)?([a-z][a-z /&+-]{2,40}?)(?=\s+(?:by|before|in|for|to|and|who|with|this|next|starting)\b|[,.;]|$)/i.exec(g);
  if (role) facts.role = role[1].trim().replace(/s$/i, (s) => (/(ss|us)$/i.test(role[1].trim()) ? s : ""));
  return facts;
}

const T = (ref: string, title: string, role: Role, hours: number, days: number, desc: string, after?: string[], extra: Partial<TplTask> = {}): TplTask =>
  ({ ref, title, role, hours, days, desc, ...(after ? { after } : {}), ...extra });
const M = (ref: string, title: string, after: string[], desc: string): TplTask =>
  ({ ref, title, role: "lead", hours: 0, days: 0, after, milestone: true, desc });

function template(c: PlanCategory, f: GoalFacts, name: string): TplSection[] {
  const n = f.people ? ` for ${f.people} people` : "";
  const at = f.place ? ` in ${f.place}` : "";
  switch (c) {
    case "launch": return [
      { name: "Plan & positioning", tasks: [
        T("a1", "Write the launch brief: audience, message and success measures", "lead", 4, 2, `One page for “${name}”: who it's for, the one thing they should remember, and the three numbers that say it worked.`),
        T("a2", "Agree the launch date, owners and go/no-go checklist", "lead", 1.5, 1, "A short call with everyone involved; the checklist lives in this project.", ["a1"]),
        M("a3", "Launch plan signed off", ["a2"], "Date, owners and the go/no-go checklist agreed."),
      ] },
      { name: "Product readiness", tasks: [
        T("a4", "Freeze the launch scope and list the must-fix bugs", "eng", 3, 1, "Anything not on the list waits for the next release.", ["a3"]),
        T("a5", "Fix the must-fix bugs", "eng", 24, 8, "Each fix reviewed and merged behind the launch flag.", ["a4"]),
        T("a6", "Add analytics events for the launch funnel", "eng", 6, 3, "Sign-up, activation and the first key action, on a dashboard before launch day.", ["a4"]),
        T("a7", "Run a full QA pass on the release candidate", "eng", 6, 2, "Main browsers and devices, plus keyboard and screen-reader basics.", ["a5", "a6"]),
        M("a8", "Release candidate approved", ["a7"], "Every item on the go/no-go checklist is green."),
      ] },
      { name: "Launch assets", tasks: [
        T("a9", "Design the launch visuals: hero image, social cards and screenshots", "design", 12, 5, "Sized for the website, email and each social channel, with alt text for every image.", ["a3"]),
        T("a10", "Write the announcement post and landing page copy", "content", 8, 4, "Lead with the problem it solves and end on one clear call to action.", ["a3"]),
        T("a11", "Record a 60-second demo video", "design", 8, 4, "Captioned, with a shorter cut for social.", ["a9"]),
        T("a12", "Update the help centre and FAQ", "content", 5, 3, "New articles for what's changed and old screenshots replaced.", ["a10"]),
      ] },
      { name: "Go-to-market", tasks: [
        T("a13", "Build the launch email to existing customers", "marketing", 4, 2, "Segmented by plan, with a test send checked on a phone.", ["a10"]),
        T("a14", "Schedule the launch-week social posts", "marketing", 3, 2, "Five posts across launch week, each with its own visual.", ["a9", "a10"]),
        T("a15", "Line up three customer quotes for launch day", "sales", 4, 5, "Early users quoted by name, each approved in writing.", ["a3"]),
        T("a16", "Brief sales and support on what's changing", "lead", 2, 1, "Talking points, known issues and who to escalate to.", ["a12"]),
      ] },
      { name: "Launch & follow-up", tasks: [
        M("a17", "Launch day", ["a8", "a11", "a13", "a14", "a15", "a16"], "Live, announced and watched."),
        T("a18", "Watch launch-day metrics and the support queue", "lead", 4, 1, "Hourly checks on sign-ups, errors and tickets; fix or roll back fast.", ["a17"]),
        T("a19", "Share the one-week results recap", "lead", 2, 4, "Numbers against the brief's success measures, and what to do next.", ["a18"]),
      ] },
    ];
    case "event": return [
      { name: "Scope & budget", tasks: [
        T("e1", `Set the goals, audience and headcount${n}`, "lead", 2, 1, "What should people leave with, and who is invited?"),
        T("e2", "Draft the budget and get it approved", "finance", 3, 3, "Venue, food, travel, AV and a 10% contingency.", ["e1"]),
        M("e3", "Budget approved", ["e2"], "A signed-off budget to book against."),
      ] },
      { name: "Venue & logistics", tasks: [
        T("e4", `Shortlist three venues${at}${n}`, "ops", 5, 4, "Capacity, step-free access, availability on your dates and a quote from each.", ["e1"]),
        T("e5", "Book the venue and sign the contract", "ops", 2, 3, "Check the cancellation terms and what the deposit covers.", ["e3", "e4"]),
        T("e6", "Arrange catering, including dietary requirements", "ops", 3, 3, "Confirm final numbers a week before.", ["e5"]),
        T("e7", "Book AV: screens, microphones and Wi-Fi", "ops", 2, 2, "Test everything at the venue the day before.", ["e5"]),
        T("e8", `Arrange travel and accommodation${at ? ` for the trip to ${f.place}` : ""}`, "ops", 6, 5, "Flights or trains, rooms near the venue, and one list of who arrives when.", ["e5"], { when: (x) => x.travel }),
      ] },
      { name: "Programme", tasks: [
        T("e9", "Draft the agenda and running order", "lead", 4, 3, "Timed to the minute, with a break at least every 90 minutes.", ["e1"]),
        T("e10", "Confirm speakers and session leads", "lead", 3, 5, "Each with a topic, a slot and a date for their slides.", ["e9"]),
        T("e11", "Prepare slides, name badges and printed materials", "design", 8, 4, "One template for every speaker; large-print copies available.", ["e10"]),
      ] },
      { name: "Invitations", tasks: [
        T("e12", "Send save-the-dates", "marketing", 1.5, 1, "Date, place and why it's worth coming; registration to follow.", ["e5"]),
        T("e13", "Open registration and track RSVPs", "ops", 3, 10, "One form for attendance, dietary and access needs.", ["e12"]),
        T("e14", "Send joining instructions", "ops", 2, 1, "Directions, timings, what to bring and who to call on the day.", ["e13"]),
      ] },
      { name: "On the day & after", tasks: [
        T("e15", "Set up the room and run the on-the-day checklist", "ops", 8, 1, "Signage, registration desk, AV check and a runner for each session.", ["e6", "e7", "e8", "e11", "e14"]),
        M("e16", "Event day", ["e15"], "Everyone there, everything working."),
        T("e17", "Send the feedback survey", "marketing", 1, 2, "Five questions, sent within 24 hours while it's fresh.", ["e16"]),
        T("e18", "Settle the invoices and close the budget", "finance", 3, 5, "Actual spend against the approved budget, shared with the team.", ["e16"]),
      ] },
    ];
    case "hire": {
      const role = f.role ? ` ${f.role}` : "";
      return [
        { name: "Role & approval", tasks: [
          T("h1", `Write the scorecard for the${role || " role"}: what they'll achieve in six months`, "lead", 3, 2, "Outcomes, must-have skills and the values you'll interview for."),
          T("h2", "Agree the salary band and get headcount approval", "finance", 2, 3, "Benchmarked against two or three similar roles.", ["h1"]),
          T("h3", "Write and publish the job advert", "people", 4, 3, "Salary shown, inclusive wording checked, how to apply in one line.", ["h2"]),
        ] },
        { name: "Sourcing", tasks: [
          T("h4", "Post the role on job boards and LinkedIn", "people", 2, 1, "Plus any community boards where the best candidates already are.", ["h3"]),
          T("h5", "Ask the team and your network for referrals", "lead", 1, 1, "A short note with the advert and what makes the role worth it.", ["h3"]),
          T("h6", "Reach out to 20 strong sourced candidates", "people", 6, 5, "A personal message to each, tracked in one list.", ["h3"]),
        ] },
        { name: "Interviews", tasks: [
          T("h7", "Screen applications against the scorecard", "people", 6, 5, "Two reviewers per application; reasons noted for every no.", ["h4", "h6"]),
          T("h8", "Run first-round calls", "lead", 8, 5, "30 minutes each, the same questions for everyone, notes against the scorecard.", ["h7"]),
          T("h9", "Set the work sample or take-home task", "lead", 3, 2, "Under three hours of the candidate's time, and paid if longer.", ["h1"]),
          M("h10", "Shortlist agreed", ["h8", "h9"], "Three to five people through to the final round."),
          T("h11", "Run the final interviews", "lead", 10, 5, "Work sample review plus a values conversation with someone outside the team.", ["h10"]),
        ] },
        { name: "Offer & onboarding", tasks: [
          T("h12", "Take up references", "people", 2, 3, "Two references, one a recent manager.", ["h11"]),
          T("h13", "Make the offer and agree a start date", "lead", 2, 3, "Verbal first, then in writing within a day.", ["h12"]),
          M("h14", "Offer accepted", ["h13"], "A signed offer and a start date."),
          T("h15", "Send the contract and do the right-to-work check", "people", 2, 2, "Original documents checked before day one.", ["h14"]),
          T("h16", "Order equipment and set up accounts", "ops", 3, 5, "Laptop, email, tools and building access ready for day one.", ["h14"]),
          T("h17", "Plan the first two weeks of onboarding", "lead", 4, 3, "A buddy, a first small win and a 30-day check-in in the calendar.", ["h14"]),
        ] },
      ];
    }
    case "website": return [
      { name: "Discovery", tasks: [
        T("w1", "Audit the current site: top pages, traffic and broken journeys", "research", 5, 3, "Analytics for the last 12 months plus a click-through of every main journey."),
        T("w2", "Agree the goals and the main call to action for each page", "lead", 2, 1, "One primary action per page, written down.", ["w1"]),
        T("w3", "Map the sitemap and page list", "design", 3, 2, "Every page, what it's for and which old URL it replaces.", ["w2"]),
      ] },
      { name: "Content", tasks: [
        T("w4", "Write the homepage copy", "content", 6, 3, "Headline, proof points and the main call to action.", ["w3"]),
        T("w5", "Write the copy for the remaining pages", "content", 12, 6, "Plain English, scannable headings, one job per page.", ["w4"]),
        T("w6", "Gather images, logos and customer stories", "content", 4, 4, "With permission to use each one, and alt text.", ["w3"]),
      ] },
      { name: "Design", tasks: [
        T("w7", "Wireframe the key pages", "design", 10, 4, "Homepage, pricing, a content page and the contact form, at phone and desktop sizes.", ["w3"]),
        T("w8", "Design the visual style and page templates", "design", 16, 6, "Colours and type that pass WCAG AA contrast.", ["w7"]),
        M("w9", "Designs signed off", ["w8", "w4"], "Templates and homepage copy approved."),
      ] },
      { name: "Build", tasks: [
        T("w10", "Set up hosting, the CMS and a staging site", "eng", 6, 3, "Backups on, and a staging link everyone can review.", ["w2"]),
        T("w11", "Build the page templates", "eng", 24, 8, "Responsive, keyboard-friendly, and editable in the CMS.", ["w9", "w10"]),
        T("w12", "Load the content and set up redirects from old URLs", "eng", 6, 3, "Every old URL in the sitemap redirects somewhere useful.", ["w11", "w5", "w6"]),
        T("w13", "Add analytics, cookie consent and form handling", "eng", 4, 2, "Consent before tracking; form messages reach the right inbox.", ["w11"]),
      ] },
      { name: "Launch", tasks: [
        T("w14", "Test on phones, for accessibility and for speed", "eng", 6, 3, "WCAG AA checks, a screen-reader pass and page speed on 4G.", ["w12", "w13"]),
        T("w15", "Fix the issues from testing", "eng", 8, 3, "Anything blocking goes first; the rest is logged for after launch.", ["w14"]),
        M("w16", "Site live", ["w15"], "The new site is on the real domain."),
        T("w17", "Submit the sitemap and check search indexing", "marketing", 1, 2, "Search Console checked for errors a few days after launch.", ["w16"]),
      ] },
    ];
    case "campaign": return [
      { name: "Strategy", tasks: [
        T("c1", "Set the campaign goal, audience and budget", "lead", 3, 2, "One number to hit, who you're talking to and what you can spend."),
        T("c2", "Write the key message and the offer", "marketing", 3, 2, "One sentence anyone on the team could repeat.", ["c1"]),
        M("c3", "Campaign brief approved", ["c2"], "Goal, audience, message and budget signed off."),
      ] },
      { name: "Creative", tasks: [
        T("c4", "Design the ad and social creative", "design", 12, 5, "Sizes for each channel and two visual routes to test.", ["c3"]),
        T("c5", "Write ad copy variants to test", "content", 4, 2, "Three headlines and two calls to action per channel.", ["c3"]),
        T("c6", "Build the campaign landing page", "eng", 8, 4, "Fast on a phone, with one form and tracking in place.", ["c4", "c5"]),
        T("c7", "Write the email sequence", "content", 6, 3, "Three emails: launch, reminder and last chance.", ["c3"]),
      ] },
      { name: "Channels", tasks: [
        T("c8", "Set up ad accounts, audiences and conversion tracking", "marketing", 4, 3, "Test conversions firing before any money is spent.", ["c3"]),
        T("c9", "Schedule the organic social posts", "marketing", 3, 2, "A post for each week of the campaign, each with its own visual.", ["c4", "c5"]),
        T("c10", "Brief partners and press", "sales", 3, 3, "A short pack: the story, the offer and images they can use.", ["c2"]),
      ] },
      { name: "Run & measure", tasks: [
        M("c11", "Campaign live", ["c6", "c7", "c8", "c9"], "Ads, emails and posts all running."),
        T("c12", "Review results twice a week and move budget to what works", "marketing", 6, 10, "Pause anything below target after the first week.", ["c11"]),
        T("c13", "Write the end-of-campaign report", "marketing", 3, 2, "Spend, results against the goal and three lessons for next time.", ["c12"]),
      ] },
    ];
    case "move": return [
      { name: "Planning", tasks: [
        T("o1", "Agree the move date, budget and must-haves for the new space", "lead", 3, 2, "Desks, meeting rooms, accessibility and the commute for the team."),
        T("o2", "Check the lease break clause and give notice", "finance", 2, 3, "Notice period, dilapidations and the deposit terms.", ["o1"]),
        T("o3", "Measure up and plan the desk layout", "ops", 5, 4, "Power and data points marked on the floor plan.", ["o1"]),
        M("o4", "Move plan agreed", ["o2", "o3"], "Date, layout and budget agreed."),
      ] },
      { name: "New space", tasks: [
        T("o5", "Arrange the fit-out: power, data and furniture", "ops", 10, 10, "Quotes from two suppliers; delivery booked before move day.", ["o4"]),
        T("o6", "Order broadband and Wi-Fi for the new office", "eng", 4, 10, "Order early: installation can take weeks.", ["o4"]),
        T("o7", "Update insurance and building access", "ops", 2, 3, "Passes or fobs for everyone, ready on move day.", ["o4"]),
      ] },
      { name: "Moving", tasks: [
        T("o8", "Book the removals company", "ops", 2, 3, "Two quotes; check their insurance covers IT equipment.", ["o4"]),
        T("o9", "Pack and label everything by team", "ops", 6, 3, "Labels match the new floor plan.", ["o8", "o5"]),
        M("o10", "Move day", ["o9", "o6", "o7"], "Everything out of the old office and into the new one."),
        T("o11", "Unpack and test every desk's setup", "eng", 6, 2, "Screens, power and network checked at each desk.", ["o10"]),
      ] },
      { name: "Settling in", tasks: [
        T("o12", "Update the address everywhere", "finance", 4, 5, "Website, Companies House, bank, HMRC, suppliers and email signatures.", ["o10"]),
        T("o13", "Hand back the old office and get the deposit back", "finance", 3, 5, "Final walk-round with photos.", ["o10"]),
        T("o14", "Share a guide to the new building and area", "ops", 2, 1, "Access, kitchens, fire exits and the best lunch spots.", ["o10"]),
      ] },
    ];
    case "research": return [
      { name: "Plan", tasks: [
        T("r1", "Write the research plan: questions, method and who to talk to", "research", 4, 2, "Three to five questions the team will act on."),
        T("r2", "Get the plan agreed with stakeholders", "lead", 1, 2, "Agree up front what decision the findings will inform.", ["r1"]),
        M("r3", "Plan agreed", ["r2"], "Questions, method and participants signed off."),
      ] },
      { name: "Recruit", tasks: [
        T("r4", `Recruit ${f.people ?? 8} participants who match the criteria`, "research", 6, 7, "A screener survey and a few spares in case of no-shows.", ["r3"]),
        T("r5", "Prepare consent forms and incentives", "ops", 2, 2, "UK GDPR-compliant consent and how recordings are stored.", ["r3"]),
        T("r6", "Write the discussion guide", "research", 4, 2, "Open questions, timed sections and the tasks to observe.", ["r3"]),
      ] },
      { name: "Run sessions", tasks: [
        T("r7", "Run a pilot session and fix the guide", "research", 2, 1, "With a colleague, timing every section.", ["r6"]),
        T("r8", "Run the sessions", "research", 12, 7, "A note-taker in every session, recordings saved with consent.", ["r4", "r5", "r7"]),
        T("r9", "Write up notes within a day of each session", "research", 6, 7, "Quotes and observations, not interpretations yet.", ["r7"]),
      ] },
      { name: "Synthesise & share", tasks: [
        T("r10", "Cluster the findings into themes", "research", 6, 3, "With the team, from the notes: what came up and how often.", ["r8", "r9"]),
        T("r11", "Write the findings report with recommendations", "research", 8, 3, "Each recommendation linked to the evidence behind it.", ["r10"]),
        M("r12", "Findings shared", ["r11"], "The report is with everyone who needs it."),
        T("r13", "Present the findings and agree next steps", "lead", 2, 1, "Owners and dates for every next step.", ["r12"]),
      ] },
    ];
    case "build": return [
      { name: "Define", tasks: [
        T("b1", "Write the one-page spec: problem, users and what's out of scope", "lead", 4, 2, `What “${name}” must do on day one, and what can wait.`),
        T("b2", "Agree the success measures and the release date", "lead", 1, 1, "Two or three numbers you'll check after release.", ["b1"]),
        M("b3", "Spec signed off", ["b2"], "Scope and dates agreed."),
      ] },
      { name: "Design", tasks: [
        T("b4", "Sketch the user flows", "design", 6, 3, "The main journey end to end, plus the empty and error states.", ["b3"]),
        T("b5", "Design the screens", "design", 16, 6, "Phone and desktop, accessible contrast and focus states.", ["b4"]),
        T("b6", "Test the prototype with five users", "research", 6, 4, "Fix the top three problems before build starts.", ["b5"]),
      ] },
      { name: "Build", tasks: [
        T("b7", "Set up the repo, environments and CI", "eng", 6, 2, "Every change tested and deployed to staging automatically.", ["b3"]),
        T("b8", "Build the data model and API", "eng", 24, 8, "With migrations and access rules from the start.", ["b7"]),
        T("b9", "Build the screens", "eng", 32, 10, "Against the designs, keyboard-friendly, behind a feature flag.", ["b6", "b8"]),
        T("b10", "Write automated tests for the main paths", "eng", 10, 5, "The happy path and the failures people will actually hit.", ["b8"]),
      ] },
      { name: "Test & release", tasks: [
        T("b11", "Run QA on staging", "eng", 8, 3, "Main browsers and devices, plus a screen-reader pass.", ["b9", "b10"]),
        T("b12", "Fix the release-blocking bugs", "eng", 12, 4, "Anything not blocking is logged for the next release.", ["b11"]),
        M("b13", "Ready to release", ["b12"], "QA passed and the release plan agreed."),
        T("b14", "Release to production behind a flag", "eng", 3, 1, "Turned on for the team first, then everyone.", ["b13"]),
        T("b15", "Write release notes and update the help centre", "content", 3, 2, "What's new, who it's for and how to use it.", ["b13"]),
        T("b16", "Review the first two weeks' usage against the success measures", "lead", 2, 10, "Decide what to improve next.", ["b14"]),
      ] },
    ];
    default: {
      return [
        { name: "Plan", tasks: [
          T("g1", "Write down what done looks like and how you'll measure it", "lead", 2, 1, `A few lines for “${name}”: the outcome, the deadline and how you'll know it worked.`),
          T("g2", "Break the work into steps and agree owners", "lead", 2, 1, "Everyone knows what they're doing and by when.", ["g1"]),
          M("g3", "Plan agreed", ["g2"], "Steps, owners and dates agreed."),
        ] },
        { name: "Delivery", tasks: [] }, // filled from the goal's own clauses below
        { name: "Review & wrap-up", tasks: [
          T("g9", "Get feedback from the people it's for", "any", 3, 3, "Early enough to act on what they say.", ["g8"]),
          T("g10", "Make the changes from feedback", "any", 6, 3, "Agree which changes matter before starting.", ["g9"]),
          M("g11", "Done", ["g10"], "Delivered and signed off."),
          T("g12", "Share what was done and what's next", "lead", 1, 1, "A short note to everyone involved.", ["g11"]),
        ] },
      ];
    }
  }
}

/** The goal's own steps ("Clean up the CRM, set up a sales pipeline and train the team") as tasks. */
function clauseTasks(goal: string): TplTask[] {
  const clauses = planLine(goal, PLAN_LIMITS.goal)
    .replace(TAIL, "")
    .split(/[.;\n]|,\s*(?:and\s+|then\s+)?|\s+(?:and then|then|and)\s+/i)
    .map((s) => s.replace(FILLER, "").replace(/[.!?]+$/, "").trim())
    .filter((s) => s.length >= 4 && s.split(/\s+/).length >= 2)
    .slice(0, 6);
  const steps = clauses.length ? clauses : [projectNameFrom(goal)];
  const out: TplTask[] = steps.map((s, i) => T(`d${i + 1}`, s.charAt(0).toLocaleUpperCase("en-GB") + s.slice(1, 80), "any", 8, 5, "Share a first version early rather than a finished one late.", ["g3"]));
  // the wrap-up waits for the last delivery step (g8 is its stand-in ref)
  out.push(M("g8", "First version ready for feedback", out.map((t) => t.ref), "Everything above in a state people can react to."));
  return out;
}

/** The Monday-to-Friday positions a template's tasks take, from their spans and dependencies. */
function schedule(tasks: TplTask[]): Map<string, { start: number; due: number }> {
  const at = new Map<string, { start: number; due: number }>();
  for (const t of tasks) {
    const deps = (t.after ?? []).map((r) => at.get(r)).filter((x): x is { start: number; due: number } => !!x);
    const ready = deps.length ? Math.max(...deps.map((d) => d.due)) : -1;
    if (t.milestone) { const d = Math.max(0, ready); at.set(t.ref, { start: d, due: d }); continue; }
    const start = ready + 1;
    at.set(t.ref, { start, due: start + Math.max(1, t.days) - 1 });
  }
  return at;
}

/** Fit a schedule to the deadline: squeezed when it runs past, eased out (up to twice as long) when there's plenty of room. */
function fitToDeadline(at: Map<string, { start: number; due: number }>, deadline: number | null): void {
  const end = Math.max(0, ...[...at.values()].map((x) => x.due));
  if (deadline == null || end <= 0) return;
  let f = 1;
  if (end > deadline) f = Math.max(0, deadline) / end;
  else if (end < deadline * 0.6) f = Math.min(2, (deadline * 0.85) / end);
  if (f === 1) return;
  for (const [k, v] of at) {
    const start = Math.floor(v.start * f);
    at.set(k, { start, due: Math.max(start, Math.min(PLAN_LIMITS.maxOffset, Math.floor(v.due * f))) });
  }
}

/** Assign by role (job titles first), sharing the hours out; guests only when nobody else is picked. */
function assigner(roster: PlannerRosterMember[]) {
  const team = roster.filter((r) => !r.guest);
  const pool = team.length ? team : roster;
  const load = new Map(pool.map((r) => [r.id, 0]));
  return (role: Role, hours: number): string | null => {
    if (!pool.length) return null;
    const fits = pool.filter((r) => r.title && ROLE_RE[role].test(r.title));
    let candidates = fits.length ? fits : pool;
    // the lead's work goes to the person planning (first on the roster) unless someone's title says lead
    if (role === "lead" && !fits.length) candidates = [pool[0]];
    let best = candidates[0];
    for (const c of candidates) if ((load.get(c.id) ?? 0) < (load.get(best.id) ?? 0)) best = c;
    load.set(best.id, (load.get(best.id) ?? 0) + Math.max(hours, 0.5));
    return best.id;
  };
}

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A deterministic, template-based plan from the goal's keywords (launch, hire, event, website, campaign…). */
export function fallbackPlan(input: PlannerInput, ctx: PlannerContext): PlanDraft {
  const goal = planText(input.goal, PLAN_LIMITS.goal);
  const category = planCategory(goal);
  const facts = goalFacts(goal);
  const name = planLine(input.projectName, PLAN_PROJECT_NAME_MAX) || projectNameFrom(goal);
  const identity = suggestIdentity(goal);
  const startDate = planStartDay(isPlanDay(ctx.today) ? ctx.today : londonToday());
  const deadline = isPlanDay(input.deadline) && input.deadline >= startDate ? input.deadline : null;

  const sections = template(category, facts, name);
  if (category === "general") sections[1].tasks = clauseTasks(goal);
  const original = new Map(sections.flatMap((s) => s.tasks).map((t) => [t.ref, { ...t, after: [...(t.after ?? [])] }]));
  // tasks that don't suit this goal go; so does — appending — anything the project already has
  // (filed under its own sections where the names match)
  const existingTitles = ctx.mode === "append" ? ctx.existingTitles ?? [] : [];
  const existingSections = ctx.mode === "append" ? ctx.existingSections ?? [] : [];
  for (const s of sections) s.tasks = s.tasks.filter((t) => (!t.when || t.when(facts)) && !existingTitles.some((x) => sameTitle(x, t.title)));
  // what waited on a task that went now waits on what that task waited on (so the schedule still follows the chain)
  const keptRefs = new Set(sections.flatMap((s) => s.tasks.map((t) => t.ref)));
  const inherit = (ref: string, seen: Set<string>): string[] => {
    if (keptRefs.has(ref)) return [ref];
    if (seen.has(ref)) return [];
    seen.add(ref);
    return (original.get(ref)?.after ?? []).flatMap((r) => inherit(r, seen));
  };
  for (const s of sections) for (const t of s.tasks) if (t.after) t.after = [...new Set(t.after.flatMap((r) => inherit(r, new Set())))];

  const all = sections.flatMap((s) => s.tasks);
  const at = schedule(all);
  fitToDeadline(at, deadline ? workingDaysBetween(startDate, deadline) : null);
  const assign = assigner(pickedRoster(input, ctx));

  const planSections: PlanSection[] = [];
  const tasks: PlanTask[] = [];
  const keyOf = new Map<string, string>();
  for (const s of sections) {
    if (!s.tasks.length) continue;
    const existing = existingSections.find((x) => sameTitle(x, s.name));
    const key = `s${planSections.length + 1}`;
    planSections.push({ key, name: (existing ?? s.name).slice(0, PLAN_LIMITS.sectionName) });
    for (const t of s.tasks) {
      if (tasks.length >= PLAN_LIMITS.tasks) break;
      const pos = at.get(t.ref) ?? { start: 0, due: 0 };
      const k = `k${tasks.length + 1}`;
      keyOf.set(t.ref, k);
      tasks.push({
        key: k,
        title: t.title.slice(0, PLAN_LIMITS.title),
        sectionKey: key,
        assigneeId: t.milestone ? null : assign(t.role, t.hours),
        estimateHours: t.milestone ? null : t.hours,
        startOffset: pos.start,
        dueOffset: pos.due,
        dependsOn: [],
        isMilestone: !!t.milestone,
        description: t.desc.slice(0, PLAN_LIMITS.description),
      });
    }
  }
  // links between the tasks that made it (past the cap, a prerequisite's own prerequisites are inherited)
  const byRef = new Map(all.map((t) => [t.ref, t]));
  const resolve = (ref: string, seen = new Set<string>()): string[] => {
    if (keyOf.has(ref)) return [keyOf.get(ref)!];
    if (seen.has(ref)) return [];
    seen.add(ref);
    return (byRef.get(ref)?.after ?? []).flatMap((r) => resolve(r, seen));
  };
  for (const t of all) {
    const k = keyOf.get(t.ref);
    const task = k ? tasks.find((x) => x.key === k) : undefined;
    if (task) task.dependsOn = [...new Set((t.after ?? []).flatMap((r) => resolve(r)))].filter((d) => d !== task.key);
  }

  return {
    name: ctx.mode === "append" ? (planLine(input.projectName, PLAN_PROJECT_NAME_MAX) || name) : name,
    emoji: identity.emoji,
    hue: identity.hue,
    startDate,
    deadline,
    sections: planSections,
    tasks,
    source: "fallback",
  };
}

/* ================================ Kanbo AI ================================ */

/** How long the planner waits for the AI: a 60-task plan is the longest reply any mode writes. */
export const PLAN_TIMEOUT_MS = 150_000;

/** A planner failure, with a sentence to show. */
export class PlannerError extends Error {
  readonly reason: PlannerFailure;
  readonly detail?: string;
  constructor(reason: PlannerFailure, message: string, detail?: string) {
    super(message);
    this.name = "PlannerError";
    this.reason = reason;
    if (detail) this.detail = detail;
  }
}

const FAILURES: readonly PlannerFailure[] = ["ai_unavailable", "daily_limit", "not_allowed", "bad_output", "network", "error"];
/** An error from planWithAi / the function → why. */
export function plannerFailure(e: unknown): PlannerFailure {
  const r = (e as { reason?: unknown })?.reason;
  if (typeof r === "string" && (FAILURES as readonly string[]).includes(r)) return r as PlannerFailure;
  const msg = String((e as { message?: unknown })?.message ?? e ?? "").toLowerCase();
  if (/daily_limit|daily limit/.test(msg)) return "daily_limit";
  if (/no_api_key|not configured|not deployed/.test(msg)) return "ai_unavailable";
  if (/not_allowed|not allowed|unauthori[sz]ed/.test(msg)) return "not_allowed";
  if (/bad_output/.test(msg)) return "bad_output";
  if (/failed to fetch|network|offline|load failed|fetch failed/.test(msg)) return "network";
  return "error";
}

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
// set when the deployed ai-assist predates the plan mode (it answers as "prioritise": { items, summary })
let planModeMissing = false;
/** Tests: forget that the function was found out of date. */
export function resetPlannerSession(): void { planModeMissing = false; }

/** The request ai-assist gets: the goal, the people picked, today (London) and — appending — what's there. */
export function planRequestBody(input: PlannerInput, ctx: PlannerContext): AiPlanRequest {
  const roster = pickedRoster(input, ctx).map((r) => (r.title ? { id: r.id, name: r.name, title: r.title } : { id: r.id, name: r.name }));
  return {
    mode: "plan",
    goal: planText(input.goal, PLAN_LIMITS.goal),
    deadline: isPlanDay(input.deadline) ? input.deadline : null,
    today: isPlanDay(ctx.today) ? ctx.today : londonToday(),
    roster,
    constraints: planText(input.constraints, PLAN_LIMITS.constraints) || null,
    projectName: planLine(input.projectName, PLAN_PROJECT_NAME_MAX) || null,
    existing: ctx.mode === "append"
      ? { sections: (ctx.existingSections ?? []).slice(0, 40), titles: (ctx.existingTitles ?? []).slice(0, 200) }
      : null,
  };
}

async function invokeFailure(error: unknown): Promise<PlannerError> {
  const name = String((error as { name?: unknown })?.name ?? "");
  const text = String((error as { message?: unknown })?.message ?? error ?? "");
  if (/abort|timed? ?out|timeout/i.test(name + " " + text)) return new PlannerError("error", PLANNER_COPY.timeout);
  if (name === "FunctionsFetchError" || isOffline() || error instanceof TypeError || /failed to fetch|network|load failed|fetch failed/i.test(text)) {
    return new PlannerError("network", isOffline() ? PLANNER_COPY.offline : PLANNER_COPY.unavailable);
  }
  if (name === "FunctionsRelayError") return new PlannerError("ai_unavailable", PLANNER_COPY.unavailable);
  const ctx = (error as { context?: { status?: number; json?: () => Promise<unknown>; clone?: () => { json: () => Promise<unknown> } } })?.context;
  const status = typeof ctx?.status === "number" ? ctx.status : undefined;
  let body: Record<string, unknown> = {};
  try {
    const raw = await (ctx?.clone ? ctx.clone().json() : ctx?.json?.());
    if (raw && typeof raw === "object") body = raw as Record<string, unknown>;
  } catch { /* not JSON */ }
  const code = typeof body.error === "string" ? body.error : "";
  if (code === "daily_limit" || status === 429) {
    const detail = typeof body.detail === "string" && body.detail.trim() ? body.detail.trim().slice(0, 300) : PLANNER_COPY.limit;
    return new PlannerError("daily_limit", detail, detail);
  }
  if (code === "no_api_key" || code === "anthropic_error" || status === 404) return new PlannerError("ai_unavailable", PLANNER_COPY.unavailable);
  if (code === "not_allowed" || code === "unauthorized" || status === 401 || status === 403) return new PlannerError("not_allowed", PLANNER_COPY.notAllowed);
  if (code === "bad_output") return new PlannerError("bad_output", PLANNER_COPY.badOutput);
  return new PlannerError("error", PLANNER_COPY.error);
}

/** Ask ai-assist for a plan; rejects with an Error whose `reason` is a PlannerFailure. */
export async function planWithAi(input: PlannerInput, ctx: PlannerContext): Promise<PlanDraft> {
  if (!supabase || planModeMissing) throw new PlannerError("ai_unavailable", PLANNER_COPY.unavailable);
  if (isOffline()) throw new PlannerError("network", PLANNER_COPY.offline);
  const body = planRequestBody(input, ctx);
  if (!body.goal) throw new PlannerError("error", "Say what you want to achieve first.");
  let res: { data: unknown; error: unknown };
  try { res = await supabase.functions.invoke("ai-assist", { body, timeout: PLAN_TIMEOUT_MS }); }
  catch (e) { throw await invokeFailure(e); }
  if (res.error) throw await invokeFailure(res.error);
  const d = (res.data && typeof res.data === "object" ? res.data : {}) as Record<string, unknown>;
  if (Array.isArray(d.items)) {
    // an ai-assist from before this mode answered as "prioritise": plan on the device for the rest of the session
    planModeMissing = true;
    console.info("[kanbo] The ai-assist function needs redeploying for “Plan with Kanbo”; planning on the device until then.");
    throw new PlannerError("ai_unavailable", PLANNER_COPY.unavailable);
  }
  // the server checked it; checked again here against what this app sent (the roster, the caps)
  const reply = validatePlanReply(d.plan, body);
  if (!reply) throw new PlannerError("bad_output", PLANNER_COPY.badOutput);
  return draftFromAiReply(reply, input, ctx);
}

/** The function's checked reply → an editable draft (assignee hints resolved against the roster). */
export function draftFromAiReply(reply: AiPlanReply, input: PlannerInput, ctx: PlannerContext): PlanDraft {
  const goal = planText(input.goal, PLAN_LIMITS.goal);
  const identity = suggestIdentity(goal);
  const startDate = planStartDay(isPlanDay(ctx.today) ? ctx.today : londonToday());
  const deadline = isPlanDay(input.deadline) && input.deadline >= startDate ? input.deadline : null;
  const roster = pickedRoster(input, ctx);
  const existing = ctx.mode === "append" ? (ctx.existingTitles ?? []) : [];

  const sections: PlanSection[] = [];
  const sectionKey = new Map<string, string>();
  for (const s of reply.sections ?? []) {
    const name = planLine(s?.name, PLAN_LIMITS.sectionName);
    if (!name || sectionKey.has(name.toLowerCase()) || sections.length >= PLAN_LIMITS.sections) continue;
    const key = `s${sections.length + 1}`;
    sections.push({ key, name });
    sectionKey.set(name.toLowerCase(), key);
  }
  const keyOfRef = new Map<string, string>();
  const tasks: PlanTask[] = [];
  for (const t of reply.tasks ?? []) {
    if (tasks.length >= PLAN_LIMITS.tasks) break;
    const title = planLine(t?.title, PLAN_LIMITS.title);
    if (!title || existing.some((x) => sameTitle(x, title))) continue;
    let sk = sectionKey.get(planLine(t.section, PLAN_LIMITS.sectionName).toLowerCase()) ?? null;
    if (!sk) {
      // a section the reply didn't list (the server adds them; this is belt and braces)
      const name = planLine(t.section, PLAN_LIMITS.sectionName) || PLAN_DEFAULT_SECTION;
      if (sections.length < PLAN_LIMITS.sections) {
        sk = `s${sections.length + 1}`;
        sections.push({ key: sk, name });
        sectionKey.set(name.toLowerCase(), sk);
      } else sk = sections[0]?.key ?? null;
    }
    const key = `k${tasks.length + 1}`;
    keyOfRef.set(t.ref, key);
    const isMilestone = t.isMilestone === true;
    const start = Math.max(0, Math.min(PLAN_LIMITS.maxOffset, Math.round(Number(t.startOffset) || 0)));
    const due = Math.max(start, Math.min(PLAN_LIMITS.maxOffset, Math.round(Number(t.dueOffset) || 0)));
    tasks.push({
      key, title, sectionKey: sk,
      assigneeId: isMilestone ? null : resolveRosterHint(t.assigneeHint, roster),
      estimateHours: isMilestone ? null : (typeof t.estimateHours === "number" && t.estimateHours > 0 ? Math.min(PLAN_LIMITS.estimateHours, t.estimateHours) : null),
      startOffset: isMilestone ? due : start,
      dueOffset: due,
      dependsOn: [],
      isMilestone,
      description: planText(t.description, PLAN_LIMITS.description),
    });
  }
  // links between the tasks that are here (one to a task the project already had is dropped)
  (reply.tasks ?? []).forEach((t) => {
    const key = keyOfRef.get(t.ref);
    const task = key ? tasks.find((x) => x.key === key) : undefined;
    if (task) task.dependsOn = [...new Set((t.dependsOn ?? []).map((r) => keyOfRef.get(r)).filter((k): k is string => !!k && k !== key))];
  });
  const used = new Set(tasks.map((t) => t.sectionKey));
  const appendName = planLine(input.projectName, PLAN_PROJECT_NAME_MAX);
  return {
    name: ctx.mode === "append"
      ? (appendName || "")
      : (appendName || reply.project?.name || projectNameFrom(goal)),
    emoji: planEmoji(reply.project?.emoji) || identity.emoji,
    hue: identity.hue,
    startDate,
    deadline,
    sections: sections.filter((s) => used.has(s.key)),
    tasks,
    source: "ai",
  };
}

/* ================================ editing a draft (pure) ================================ */

/** A key no task or section in the draft has. */
export function freshKey(draft: Pick<PlanDraft, "tasks" | "sections">, prefix: "k" | "s"): string {
  const used = new Set([...draft.tasks.map((t) => t.key), ...draft.sections.map((s) => s.key)]);
  let i = (prefix === "k" ? draft.tasks.length : draft.sections.length) + 1;
  while (used.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

/** The draft's tasks in display order: by section (in order), then any without one. */
export function tasksBySection(draft: Pick<PlanDraft, "tasks" | "sections">): { section: PlanSection | null; tasks: PlanTask[] }[] {
  const known = new Set(draft.sections.map((s) => s.key));
  const out: { section: PlanSection | null; tasks: PlanTask[] }[] = draft.sections.map((s) => ({ section: s, tasks: draft.tasks.filter((t) => t.sectionKey === s.key) }));
  const loose = draft.tasks.filter((t) => !t.sectionKey || !known.has(t.sectionKey));
  if (loose.length) out.push({ section: null, tasks: loose });
  return out;
}

/** Change one task (dates kept in order: a start moved past the due date takes the due date with it, and back). */
export function patchPlanTask(draft: PlanDraft, key: string, patch: Partial<Omit<PlanTask, "key">>): PlanDraft {
  return {
    ...draft,
    tasks: draft.tasks.map((t) => {
      if (t.key !== key) return t;
      const next = { ...t, ...patch };
      if (patch.isMilestone === true) { next.startOffset = next.dueOffset; next.estimateHours = null; }
      if (next.isMilestone) next.startOffset = next.dueOffset;
      if ("startOffset" in patch && next.startOffset > next.dueOffset) next.dueOffset = next.startOffset;
      if ("dueOffset" in patch && next.dueOffset < next.startOffset) next.startOffset = next.dueOffset;
      next.startOffset = Math.max(0, Math.min(PLAN_LIMITS.maxOffset, Math.round(next.startOffset)));
      next.dueOffset = Math.max(next.startOffset, Math.min(PLAN_LIMITS.maxOffset, Math.round(next.dueOffset)));
      next.title = next.title.slice(0, PLAN_LIMITS.title);
      next.description = next.description.slice(0, PLAN_LIMITS.description);
      return next;
    }),
  };
}

/** Remove tasks; links to them go too. */
export function removePlanTasks(draft: PlanDraft, keys: readonly string[]): PlanDraft {
  const gone = new Set(keys);
  return {
    ...draft,
    tasks: draft.tasks.filter((t) => !gone.has(t.key)).map((t) => (t.dependsOn.some((d) => gone.has(d)) ? { ...t, dependsOn: t.dependsOn.filter((d) => !gone.has(d)) } : t)),
  };
}

/** Remove a section and its tasks. */
export function removePlanSection(draft: PlanDraft, sectionKey: string): PlanDraft {
  const keys = draft.tasks.filter((t) => t.sectionKey === sectionKey).map((t) => t.key);
  const d = removePlanTasks(draft, keys);
  return { ...d, sections: d.sections.filter((s) => s.key !== sectionKey) };
}

/** Rename a section (blank names aren't kept). */
export function renamePlanSection(draft: PlanDraft, sectionKey: string, name: string): PlanDraft {
  const n = name.replace(/\s+/g, " ").slice(0, PLAN_LIMITS.sectionName);
  return { ...draft, sections: draft.sections.map((s) => (s.key === sectionKey ? { ...s, name: n } : s)) };
}

/** Add a section at the end (null at the cap). */
export function addPlanSection(draft: PlanDraft, name = "New section"): { draft: PlanDraft; key: string } | null {
  if (draft.sections.length >= PLAN_LIMITS.sections) return null;
  const key = freshKey(draft, "s");
  return { draft: { ...draft, sections: [...draft.sections, { key, name: name.slice(0, PLAN_LIMITS.sectionName) }] }, key };
}

/** Add a task at the end of a section, dated like the section's last task (null at the cap). */
export function addPlanTask(draft: PlanDraft, sectionKey: string | null, title = ""): { draft: PlanDraft; key: string } | null {
  if (draft.tasks.length >= PLAN_LIMITS.tasks) return null;
  const key = freshKey(draft, "k");
  const inSection = draft.tasks.filter((t) => t.sectionKey === sectionKey);
  const last = inSection[inSection.length - 1];
  const day = last ? last.dueOffset : 0;
  const task: PlanTask = {
    key, title: title.slice(0, PLAN_LIMITS.title), sectionKey, assigneeId: null, estimateHours: null,
    startOffset: day, dueOffset: day, dependsOn: [], isMilestone: false, description: "",
  };
  // after the section's last task in the overall order (so creation order matches what's shown)
  const at = last ? draft.tasks.findIndex((t) => t.key === last.key) + 1 : draft.tasks.length;
  const tasks = [...draft.tasks.slice(0, at), task, ...draft.tasks.slice(at)];
  return { draft: { ...draft, tasks }, key };
}

/** Move a task to `index` within a section's tasks (another section's too). */
export function movePlanTask(draft: PlanDraft, key: string, toSection: string | null, toIndex: number): PlanDraft {
  const task = draft.tasks.find((t) => t.key === key);
  if (!task) return draft;
  const rest = draft.tasks.filter((t) => t.key !== key);
  const moved = { ...task, sectionKey: toSection };
  const peers = rest.filter((t) => t.sectionKey === toSection);
  const i = Math.max(0, Math.min(peers.length, Math.round(toIndex)));
  let at: number;
  if (i < peers.length) at = rest.indexOf(peers[i]);
  else if (peers.length) at = rest.indexOf(peers[peers.length - 1]) + 1;
  else {
    // an empty section: after the tasks of the sections before it
    const order = draft.sections.map((s) => s.key);
    const before = new Set(order.slice(0, Math.max(0, order.indexOf(toSection ?? ""))));
    let last = -1;
    rest.forEach((t, j) => { if (t.sectionKey && before.has(t.sectionKey)) last = j; });
    at = last + 1;
  }
  return { ...draft, tasks: [...rest.slice(0, at), moved, ...rest.slice(at)] };
}

/** Move a task one place up or down in what's shown, into the neighbouring section at an end. */
export function nudgePlanTask(draft: PlanDraft, key: string, delta: -1 | 1): PlanDraft {
  const groups = tasksBySection(draft);
  const gi = groups.findIndex((g) => g.tasks.some((t) => t.key === key));
  if (gi < 0) return draft;
  const g = groups[gi];
  const i = g.tasks.findIndex((t) => t.key === key);
  const sectionOf = (x: { section: PlanSection | null }) => x.section?.key ?? null;
  if (delta < 0 && i > 0) return movePlanTask(draft, key, sectionOf(g), i - 1);
  if (delta > 0 && i < g.tasks.length - 1) return movePlanTask(draft, key, sectionOf(g), i + 1);
  const ng = groups[gi + delta];
  if (!ng) return draft;
  return movePlanTask(draft, key, sectionOf(ng), delta < 0 ? ng.tasks.length : 0);
}

/** Start the whole plan on another day (offsets stay: everything moves with it). */
export function shiftPlanStart(draft: PlanDraft, iso: string): PlanDraft {
  return isPlanDay(iso) ? { ...draft, startDate: planStartDay(iso) } : draft;
}

/** Tasks that wait on `key`, directly or further down the chain. */
export function dependentsOf(draft: Pick<PlanDraft, "tasks">, key: string): Set<string> {
  const out = new Set<string>();
  const stack = [key];
  while (stack.length) {
    const k = stack.pop()!;
    for (const t of draft.tasks) if (t.dependsOn.includes(k) && !out.has(t.key)) { out.add(t.key); stack.push(t.key); }
  }
  return out;
}

/** Totals for the review header. */
export function planTotals(draft: PlanDraft): { tasks: number; sections: number; milestones: number; hours: number; start: string; end: string; people: number } {
  const end = draft.tasks.reduce((m, t) => Math.max(m, t.dueOffset), 0);
  return {
    tasks: draft.tasks.length,
    sections: tasksBySection(draft).filter((g) => g.tasks.length).length,
    milestones: draft.tasks.filter((t) => t.isMilestone).length,
    hours: Math.round(draft.tasks.reduce((s, t) => s + (t.isMilestone ? 0 : t.estimateHours ?? 0), 0) * 10) / 10,
    start: draft.startDate,
    end: addWorkingDays(draft.startDate, end),
    people: new Set(draft.tasks.map((t) => t.assigneeId).filter(Boolean)).size,
  };
}

/* ================================ the mini timeline ================================ */

export interface TimelineBar { key: string; start: number; due: number; row: number; milestone: boolean; late: boolean }
export interface TimelineLane { key: string; name: string; rows: number; bars: TimelineBar[] }
export interface PlanTimeline {
  /** working days shown: 0 … days-1 */
  days: number;
  lanes: TimelineLane[];
  /** Mondays (and day 0) with a "12 Oct" label */
  ticks: { day: number; label: string }[];
  deadline: number | null;
  end: number;
}
/** Lanes per section, each task a bar packed into as few rows as fit (at most `maxRows`). */
export function planTimeline(draft: PlanDraft, maxRows = 4): PlanTimeline {
  const dl = deadlineOffset(draft);
  const end = draft.tasks.reduce((m, t) => Math.max(m, t.dueOffset), 0);
  const days = Math.max(end, dl ?? 0) + 1;
  const lanes: TimelineLane[] = tasksBySection(draft).filter((g) => g.tasks.length).map((g) => {
    const rowsEnd: number[] = [];
    const bars: TimelineBar[] = [...g.tasks].sort((a, b) => a.startOffset - b.startOffset || a.dueOffset - b.dueOffset).map((t) => {
      let row = rowsEnd.findIndex((e) => e < t.startOffset);
      if (row < 0) { if (rowsEnd.length < maxRows) { row = rowsEnd.length; rowsEnd.push(-1); } else row = rowsEnd.indexOf(Math.min(...rowsEnd)); }
      rowsEnd[row] = Math.max(rowsEnd[row], t.dueOffset);
      return { key: t.key, start: t.startOffset, due: t.dueOffset, row, milestone: t.isMilestone, late: dl != null && t.dueOffset > dl };
    });
    return { key: g.section?.key ?? "none", name: g.section?.name ?? "No section", rows: Math.max(1, rowsEnd.length), bars };
  });
  // a label at day 0 and on Mondays, thinned so at most ~8 show
  const mondays: number[] = [];
  for (let d = 1; d < days; d++) if (weekday(addWorkingDays(draft.startDate, d)) === 1) mondays.push(d);
  const step = Math.max(1, Math.ceil((mondays.length + 1) / 8));
  const shown = mondays.filter((_, i) => (i + 1) % step === 0);
  // day 0's own label only when the first Monday isn't right beside it (they'd collide)
  const lead = shown.length && shown[0] < 3 ? [] : [0];
  const ticks = [...lead, ...shown].map((day) => ({ day, label: planShortDay(addWorkingDays(draft.startDate, day)) }));
  return { days, lanes, ticks, deadline: dl, end };
}

/* ================================ warnings ================================ */

const memberName = (members: { id: string; name: string }[], id: string) => members.find((m) => m.id === id)?.name ?? "Someone";

/** The draft's tasks as the app's tasks would be (for the Workload model). */
function asTasks(draft: PlanDraft): Task[] {
  return draft.tasks.map((t, i) => {
    const { start, due } = taskDates(draft, t);
    return {
      id: `plan:${t.key}`, title: t.title, description: "", status: "todo", priority: "medium", projectId: "plan",
      assigneeId: t.assigneeId ?? "", tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0,
      dueDate: due, ...(start < due ? { startDate: start } : {}), isMilestone: t.isMilestone,
      ...(t.estimateHours ? { effortHours: t.estimateHours } : {}), position: i,
    } as Task;
  });
}

/** Overloaded people (the Workload model, existing work included), dates past the deadline, unassigned work, a task due before what it depends on.
 *  Optional: `guestIds` (guests carry no team capacity), `capacities` (weekly hours per person; default Workload's on this device),
 *  `today` (YYYY-MM-DD; default the app's today). */
export function planWarnings(draft: PlanDraft, ctx: { tasks: Task[]; members: Member[]; deadline?: string | null; guestIds?: readonly string[]; capacities?: Record<string, number>; today?: string }): PlanWarning[] {
  const out: PlanWarning[] = [];
  const members = ctx.members ?? [];
  const guests = new Set(ctx.guestIds ?? []);
  const titleOf = new Map(draft.tasks.map((t) => [t.key, t.title]));
  const quote = (keys: string[], max = 2) => {
    const names = keys.slice(0, max).map((k) => `“${titleOf.get(k) ?? "a task"}”`);
    return keys.length > max ? `${names.join(", ")} and ${plural(keys.length - max, "other")}` : names.join(" and ");
  };

  // 1. overload: each person's weekly hours (their existing open work plus this plan) against their capacity
  const caps = ctx.capacities ?? readCapacities();
  const today = ctx.today && isPlanDay(ctx.today) ? localDay(ctx.today)! : new Date(KANBO_TODAY);
  const planned = asTasks(draft);
  const people = [...new Set(draft.tasks.map((t) => t.assigneeId).filter((id): id is string => !!id && !guests.has(id) && members.some((m) => m.id === id)))];
  if (people.length && draft.tasks.length) {
    const all = [...(ctx.tasks ?? []).filter((t) => !t.id.startsWith("plan:")), ...planned];
    const first = startOfWeekMon(localDay(draft.startDate)!);
    const last = startOfWeekMon(localDay(planTotals(draft).end)!);
    const worst = new Map<string, { hours: number; cap: number; week: Date; keys: string[]; weeks: number }>();
    for (let w = first, i = 0; w <= last && i < 60; w = addDays(w, 7), i++) {
      const { rows } = loadForWeek(all, w, today);
      for (const id of people) {
        const r = rows.get(id);
        if (!r) continue;
        const cap = capacityOf(caps, id);
        if (loadTone(r.hours, cap) !== "signal") continue;
        const keys = r.items.map((x) => x.task.id).filter((x) => x.startsWith("plan:")).map((x) => x.slice(5));
        if (!keys.length) continue; // over already, without this plan: Workload says so, not the planner
        const prev = worst.get(id);
        if (!prev || r.hours - cap > prev.hours - prev.cap) worst.set(id, { hours: r.hours, cap, week: w, keys, weeks: (prev?.weeks ?? 0) + 1 });
        else prev.weeks++;
      }
    }
    for (const id of people) {
      const o = worst.get(id);
      if (!o) continue;
      const more = o.weeks > 1 ? ` ${plural(o.weeks - 1, "other week")} ${o.weeks === 2 ? "is" : "are"} over too.` : "";
      const wk = `${o.week.getDate()} ${MON[o.week.getMonth()]}`;
      out.push({
        kind: "overloaded", memberId: id, taskKeys: o.keys,
        message: `${memberName(members, id)} would have ${fmtHours(o.hours)} of work in the week of ${wk}, against ${fmtHours(o.cap)} of capacity.${more}`,
      });
    }
  }

  // 2. past the deadline
  const deadline = ctx.deadline !== undefined ? ctx.deadline : draft.deadline;
  if (deadline && isPlanDay(deadline)) {
    const late = draft.tasks.filter((t) => taskDates(draft, t).due > deadline).map((t) => t.key);
    if (late.length) {
      out.push({
        kind: "past_deadline", taskKeys: late,
        message: late.length === 1
          ? `${quote(late)} is due after the deadline, ${planDayLabel(deadline)}.`
          : `${plural(late.length, "task")} are due after the deadline, ${planDayLabel(deadline)}: ${quote(late)}.`,
      });
    }
  }

  // 3. starts before what it waits for is done
  const byKey = new Map(draft.tasks.map((t) => [t.key, t]));
  const early: string[] = [];
  let firstPair: [string, string] | null = null;
  for (const t of draft.tasks) {
    for (const d of t.dependsOn) {
      const dep = byKey.get(d);
      if (dep && (t.isMilestone ? t.dueOffset < dep.dueOffset : t.startOffset < dep.dueOffset)) {
        early.push(t.key);
        if (!firstPair) firstPair = [t.key, d];
        break;
      }
    }
  }
  if (early.length && firstPair) {
    const [a, b] = firstPair;
    out.push({
      kind: "dependency_order", taskKeys: early,
      message: early.length === 1
        ? `“${titleOf.get(a)}” starts before “${titleOf.get(b)}” is due, but waits for it.`
        : `${plural(early.length, "task")} start before what they wait for is due, like “${titleOf.get(a)}” and “${titleOf.get(b)}”.`,
    });
  }

  // 4. nobody on it (only worth saying when there are people to choose from)
  if (members.length) {
    const open = draft.tasks.filter((t) => !t.isMilestone && !t.assigneeId).map((t) => t.key);
    if (open.length) out.push({ kind: "unassigned", taskKeys: open, message: open.length === 1 ? `${quote(open)} has no one assigned.` : `${plural(open.length, "task")} have no one assigned.` });
  }

  // 5. past the caps (the editor stops at them; a draft from elsewhere might not)
  if (draft.tasks.length > PLAN_LIMITS.tasks || draft.sections.length > PLAN_LIMITS.sections) {
    out.push({ kind: "trimmed", message: `Only the first ${PLAN_LIMITS.tasks} tasks in ${PLAN_LIMITS.sections} sections will be created.` });
  }
  return out;
}

/* ================================ making it ================================ */

const newUuid = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // RFC 4122 v4 from Math.random (only where crypto.randomUUID is missing)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => { const r = (Math.random() * 16) | 0; return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16); });
};
const errText = (e: unknown) => String((e as { message?: unknown })?.message ?? e ?? "").slice(0, 300);

/** A failure before anything stands: nothing was made (or what was made was removed). */
export class PlanApplyError extends Error {
  readonly step: PlanApplyProgress["step"];
  constructor(step: PlanApplyProgress["step"], message: string) { super(message); this.name = "PlanApplyError"; this.step = step; }
}

/** How many links a plan has between tasks that will be made. */
export function planEdgeCount(draft: PlanDraft): number {
  const keys = new Set(draft.tasks.slice(0, PLAN_LIMITS.tasks).map((t) => t.key));
  return draft.tasks.slice(0, PLAN_LIMITS.tasks).reduce((n, t) => n + t.dependsOn.filter((d) => keys.has(d)).length, 0);
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const run = async () => { while (i < items.length) { const item = items[i++]; await fn(item); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** Make it: project (new mode, with identity), sections, tasks (one createTasks batch), dependencies — with progress, and rollback messaging on failure.
 *  New mode: the project, its sections and the tasks stand or fall together — a failure removes what was made (`deps.deleteProject`;
 *  it goes to the recycle bin) and resolves with `rolledBack`. If the project itself can't be made, it rejects with a PlanApplyError
 *  (nothing was made). Append mode: tasks that saved are removed again (`deps.deleteTasks`) when others didn't; sections it added stay.
 *  Dependency links are made last, a few at a time: one that fails is reported in `failed`, and never undoes the plan.
 *  `opts.goal` (optional) becomes the new project's description. */
export async function applyProjectPlan(
  draft: PlanDraft,
  opts: { workspaceId: string | null; currentUserId: string; project?: Project | null; sections?: Section[]; goal?: string },
  deps: PlanApplyDeps,
  onProgress?: (p: PlanApplyProgress) => void,
): Promise<AppliedProjectPlan> {
  const append = !!opts.project;
  const report = (p: PlanApplyProgress) => { try { onProgress?.(p); } catch { /* the host's problem */ } };
  const planTasks = draft.tasks.slice(0, PLAN_LIMITS.tasks).filter((t) => planLine(t.title, PLAN_LIMITS.title));
  if (!planTasks.length) throw new PlanApplyError("tasks", "There are no tasks to create. Add one, or go back and describe the project again.");
  const groups = tasksBySection({ ...draft, tasks: planTasks }).filter((g) => g.tasks.length);
  const failed: string[] = [];

  // 1. the project
  let project: Project;
  if (append) project = opts.project!;
  else {
    report({ step: "project", done: 0, total: 1 });
    const name = planLine(draft.name, PLAN_PROJECT_NAME_MAX) || "New project";
    const description = planText(opts.goal, 1000);
    try {
      project = await deps.createProject({ name, emoji: draft.emoji, color: spectrumColor(draft.hue), workspaceId: opts.workspaceId, ...(description ? { description } : {}) });
    } catch (e) {
      throw new PlanApplyError("project", `Couldn't create “${name}”, so nothing was made. ${errText(e) ? `(${errText(e)})` : ""}`.trim());
    }
    report({ step: "project", done: 1, total: 1 });
  }
  const ws = project.workspaceId ?? opts.workspaceId ?? null;

  /** Remove what was made: true when nothing of it is left. */
  const undo = async (made: Task[]): Promise<boolean> => {
    if (!append) {
      if (!deps.deleteProject) return false;
      try { await deps.deleteProject(project.id); } catch { return false; }
      // with 0047 the project's delete takes its tasks into the bin with it (these deletes are then no-ops);
      // before it, tasks outlive their project, so they're removed too
      if (made.length && deps.deleteTasks) { try { await deps.deleteTasks(made.map((t) => t.id)); } catch { /* the project is gone: nothing shows them */ } }
      return true;
    }
    if (!made.length) return true;
    if (!deps.deleteTasks) return false;
    try { await deps.deleteTasks(made.map((t) => t.id)); return true; } catch { return false; }
  };
  const result = (over: Partial<AppliedProjectPlan>): AppliedProjectPlan => ({
    project, sections: [], tasks: [], dependencies: 0, failed, rolledBack: false, ...over,
  });

  // 2. sections: a new project's own, or — appending — only the names the project doesn't have yet
  const madeSections: Section[] = [];
  const sectionId = new Map<string, string>(); // plan section key → section id
  const wanted = groups.filter((g) => g.section).map((g) => g.section!);
  const existing = append ? (opts.sections ?? []).filter((s) => s.projectId === project.id) : [];
  const toMake = wanted.filter((s) => {
    const have = existing.find((x) => sameTitle(x.name, s.name));
    if (have) sectionId.set(s.key, have.id);
    return !have;
  });
  const basePos = existing.reduce((m, s) => Math.max(m, s.position ?? 0), 0);
  report({ step: "sections", done: 0, total: toMake.length });
  for (const [i, s] of toMake.entries()) {
    try {
      const sec = await deps.createSection({ projectId: project.id, workspaceId: ws, name: planLine(s.name, PLAN_LIMITS.sectionName) || "Section", position: basePos + i + 1 });
      madeSections.push(sec);
      sectionId.set(s.key, sec.id);
      report({ step: "sections", done: i + 1, total: toMake.length });
    } catch (e) {
      failed.push(s.name);
      if (append) continue; // the tasks still go in, without that section
      const ok = await undo([]);
      if (!ok) failed.push(`the half-made project “${project.name}”`);
      return result({ sections: ok ? [] : madeSections, rolledBack: ok });
    }
  }

  // 3. the tasks, in one batch, with their final ids (so the links can be made)
  const base = Date.now();
  const idOf = new Map<string, string>();
  const built: Task[] = [];
  groups.forEach((g) => g.tasks.forEach((t) => {
    const id = newUuid();
    idOf.set(t.key, id);
    const { start, due } = taskDates(draft, t);
    const span = Math.max(1, t.dueOffset - t.startOffset + 1);
    const hours = !t.isMilestone && t.estimateHours && t.estimateHours > 0 ? Math.min(PLAN_LIMITS.estimateHours, t.estimateHours) : undefined;
    const focus = hours ? Math.min(240, Math.max(30, Math.round((hours * 60) / span / 15) * 15)) : 30;
    built.push({
      id, title: planLine(t.title, PLAN_LIMITS.title), description: planText(t.description, PLAN_LIMITS.description),
      status: "todo", priority: t.isMilestone ? "high" : "medium",
      projectId: project.id, workspaceId: ws,
      assigneeId: t.assigneeId ?? "",
      ...(g.section && sectionId.get(g.section.key) ? { sectionId: sectionId.get(g.section.key) } : {}),
      dueDate: due,
      ...(!t.isMilestone && start < due ? { startDate: start } : {}),
      ...(t.isMilestone ? { isMilestone: true } : {}),
      ...(hours ? { effortHours: hours } : {}),
      tags: [], dependencies: [], subtasks: [], comments: 0, followers: [], collaborators: [],
      focusMin: focus, dur: focus, aiScore: 50, scheduled: null, planToday: false, recurrence: "none",
      position: base + built.length,
    });
  }));
  report({ step: "tasks", done: 0, total: built.length });
  let saved: Task[];
  try {
    saved = await deps.createTasks(built);
    if (!Array.isArray(saved)) saved = [];
  } catch (e) {
    const partial = Array.isArray((e as { saved?: unknown })?.saved) ? ((e as { saved: Task[] }).saved) : [];
    const savedIds = new Set(partial.map((t) => t.id));
    const lost = Array.isArray((e as { failed?: unknown })?.failed)
      ? ((e as { failed: { task?: Task }[] }).failed).map((f) => f.task?.title).filter((x): x is string => !!x)
      : built.filter((b) => !savedIds.has(b.id)).map((b) => b.title);
    failed.push(...(lost.length ? lost : [`${plural(built.length, "task")}`]));
    const ok = await undo(partial);
    if (!ok) failed.push(append ? `${plural(partial.length, "task")} that did save` : `the half-made project “${project.name}”`);
    return result({ sections: madeSections, tasks: ok ? [] : partial, rolledBack: ok });
  }
  // the saved copies, matched to the plan by id (or by position, if the host gave them new ids)
  const byId = new Map(saved.map((t) => [t.id, t]));
  const finalId = new Map<string, string>();
  built.forEach((b, i) => {
    const s = byId.get(b.id) ?? (saved.length === built.length ? saved[i] : undefined);
    if (s) finalId.set(b.id, s.id);
  });
  report({ step: "tasks", done: saved.length, total: built.length });

  // 4. dependencies, a few at a time
  const keyOfId = new Map([...idOf].map(([k, id]) => [finalId.get(id) ?? id, k]));
  const titleOfKey = new Map(planTasks.map((t) => [t.key, t.title]));
  const edges: [string, string][] = [];
  for (const t of planTasks) {
    const a = finalId.get(idOf.get(t.key) ?? "");
    if (!a) continue;
    for (const d of t.dependsOn) { const b = finalId.get(idOf.get(d) ?? ""); if (b && b !== a) edges.push([a, b]); }
  }
  const linked = new Map<string, string[]>();
  let done = 0;
  report({ step: "dependencies", done: 0, total: edges.length });
  await pool(edges, 4, async ([a, b]) => {
    try {
      await deps.addDependency(a, b);
      linked.set(a, [...(linked.get(a) ?? []), b]);
    } catch {
      failed.push(`the link from “${titleOfKey.get(keyOfId.get(b) ?? "") ?? "a task"}” to “${titleOfKey.get(keyOfId.get(a) ?? "") ?? "a task"}”`);
    }
    report({ step: "dependencies", done: ++done, total: edges.length });
  });
  const tasks = saved.map((t) => ({ ...t, dependencies: linked.get(t.id) ?? [] }));
  report({ step: "done", done: 1, total: 1 });
  return result({ sections: madeSections, tasks, dependencies: [...linked.values()].reduce((n, l) => n + l.length, 0) });
}

/* ================================ wiring (for the host) ================================ */

/** The store-shaped create paths the planner needs (data/store's `store` fits). */
export interface PlannerStore {
  createProject(input: { name: string; emoji: string; color: string; workspaceId: string | null }, userId: string): Promise<Project>;
  updateProject?(id: string, patch: { description?: string }): Promise<void>;
  createSection(input: { projectId: string; workspaceId: string | null; name: string; position?: number }, userId: string): Promise<Section>;
  createTasksBatch(tasks: Task[], userId: string): Promise<Task[]>;
  addDependency(taskId: string, dependsOn: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  deleteTask(id: string): Promise<void>;
}

/** PlanApplyDeps over the store, as the signed-in person: `plannerDeps(store, userId)`.
 *  A description is a nice-to-have (the project stands without it); task deletes run a few at a time. */
export function plannerDeps(s: PlannerStore, userId: string): PlanApplyDeps {
  return {
    createProject: async (input) => {
      const p = await s.createProject({ name: input.name, emoji: input.emoji, color: input.color, workspaceId: input.workspaceId }, userId);
      if (!input.description || !s.updateProject) return p;
      try { await s.updateProject(p.id, { description: input.description }); return { ...p, description: input.description }; }
      catch { return p; }
    },
    createSection: (input) => s.createSection(input, userId),
    createTasks: (tasks) => s.createTasksBatch(tasks, userId),
    addDependency: (a, b) => s.addDependency(a, b),
    deleteProject: (id) => s.deleteProject(id),
    deleteTasks: async (ids) => {
      const failed: unknown[] = [];
      await pool(ids, 4, async (id) => { try { await s.deleteTask(id); } catch (e) { failed.push(e); } });
      if (failed.length) throw failed[0];
    },
  };
}

/** The planner's people for a workspace: its active members (with their job titles, which help
 *  both planners assign well) and which of them are guests. `members` are the app's Member records;
 *  `rows` the workspace_members rows (WorkspaceMember). Personal (workspaceId null): just you. */
export function plannerPeople(
  members: readonly Member[],
  rows: ReadonlyArray<{ workspaceId: string; userId: string | null; role: string; status: string; name?: string; email?: string; title?: string | null }>,
  workspaceId: string | null,
  currentUserId: string,
): { members: (Member & { title?: string })[]; guestIds: string[] } {
  if (workspaceId === null) {
    const me = members.find((m) => m.id === currentUserId);
    return { members: me ? [me] : [], guestIds: [] };
  }
  const here = rows.filter((r) => r.workspaceId === workspaceId && r.userId && r.status === "active");
  const out: (Member & { title?: string })[] = [];
  for (const r of here) {
    const m = members.find((x) => x.id === r.userId);
    const base: Member = m ?? { id: r.userId!, name: r.name || r.email || "Someone", email: r.email ?? "", type: r.role === "guest" ? "external" : "team", color: "oklch(0.7 0.1 268)" };
    out.push(r.title?.trim() ? { ...base, title: r.title.trim() } : base);
  }
  return { members: out, guestIds: here.filter((r) => r.role === "guest").map((r) => r.userId!) };
}

/** The toast after the planner has made something (or had to undo it). */
export function plannerResultMessage(r: AppliedProjectPlan, mode: "new" | "append"): { tone: "success" | "info" | "error"; text: string } {
  const name = r.project?.name ?? "the project";
  if (r.rolledBack) {
    return { tone: "error", text: mode === "new"
      ? `Couldn't finish making “${name}”, so Kanbo removed what it had made (it's in the recycle bin for 30 days). Try again in a moment.`
      : `Couldn't add the tasks to “${name}”, so Kanbo removed the ones that had saved. Try again in a moment.` };
  }
  if (!r.tasks.length) return { tone: "error", text: `Couldn't create the tasks in “${name}”. Try again in a moment.` };
  const made = mode === "new"
    ? `“${name}” is ready: ${plural(r.tasks.length, "task")}${r.sections.length ? ` in ${plural(r.sections.length, "section")}` : ""}`
    : `Added ${plural(r.tasks.length, "task")} to “${name}”`;
  if (!r.failed.length) return { tone: "success", text: `${made}.` };
  const shown = r.failed.slice(0, 2).join("; ");
  const more = r.failed.length > 2 ? ` and ${r.failed.length - 2} more` : "";
  return { tone: "info", text: `${made}, but ${shown}${more} couldn't be added.` };
}

// ============================================================
// KANBO — Slack app: reading "/kanbo …" and Slack's message text.   [0049]
//
// Slack sends text with its own escapes (the manifest asks for them:
// should_escape true, so a real @mention arrives as the person's Slack id):
//   <@U123|sana>  <@U123>       a person          → "@<handle>" the grammar reads
//   <#C123|launch>              a channel link    → "#launch" (people type #project
//                                                    and Slack may turn it into a channel)
//   <!here> <!channel> <!subteam^S1|@team>        → plain words, never a mention
//   <https://x|label> <mailto:a@b|a@b>            → the label (or the address)
//   &lt; &gt; &amp;                               → < > &
// Then the ONE grammar (nlp.ts, the app's Quick capture) reads the sentence,
// with "today" as the person's own day (Europe/London unless Slack says
// otherwise). /kanbo reads: dates, times, start dates, !priority / p1–p4,
// #project, @person and ~estimates. Repeats, focus durations, energy and
// +tags are left in the title (the task API doesn't take them).
//
// A Slack @mention becomes a Kanbo person by their Slack profile's email
// (users:read.email) matched to a workspace member's, else by their Slack
// name (resolveMention); a typed "@sana" matches member names as in the app.
//
// Pure: vitest runs it (slackAppParse.test.ts).
// ============================================================
import { matchMember, parseTask, type NlpKind } from "./nlp.ts";

/** What /kanbo reads from a sentence (the rest stays in the title). */
export const SLACK_KINDS: NlpKind[] = ["date", "time", "start", "priority", "project", "person", "estimate"];

export interface SlackMention {
  slackUserId: string;
  /** the name Slack showed, if any */
  label: string;
  /** what replaced it in the text: "@" + handle */
  handle: string;
}

const HANDLE_PREFIX = "kslk";
const handleFor = (id: string) => `${HANDLE_PREFIX}${id.toLowerCase()}`;

/** Slack's escaped text → plain text, with each person mention swapped for a handle. */
export function decodeSlackText(text: string): { text: string; mentions: SlackMention[] } {
  const mentions: SlackMention[] = [];
  const seen = new Set<string>();
  const out = String(text ?? "").replace(/<([^<>]{1,600})>/g, (_m, inner: string) => {
    const [target, ...rest] = inner.split("|");
    const label = rest.join("|").trim();
    if (/^@[UW][A-Z0-9]{2,32}$/.test(target)) {
      const id = target.slice(1);
      const handle = handleFor(id);
      if (!seen.has(id)) { seen.add(id); mentions.push({ slackUserId: id, label: label.replace(/^@/, ""), handle }); }
      return `@${handle}`;
    }
    if (target.startsWith("#C") || target.startsWith("#G")) return label ? `#${label.replace(/^#/, "")}` : "";
    if (target.startsWith("!subteam^")) return label.replace(/^@/, "");
    if (target.startsWith("!date^")) return label;
    if (target.startsWith("!")) return target.slice(1).replace(/[^a-z]/gi, "");
    if (/^(https?:|mailto:|tel:)/i.test(target)) return label || target.replace(/^mailto:/i, "");
    return label || target;
  });
  return { text: out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), mentions };
}

/** A message as people read it: mentions as "@name" (from `names`, else "@someone"), escapes undone. */
export function readableSlackText(text: string, names: Map<string, string> = new Map()): string {
  const { text: plain, mentions } = decodeSlackText(text);
  let s = plain;
  for (const m of mentions) s = s.split(`@${m.handle}`).join(`@${names.get(m.slackUserId) || m.label || "someone"}`);
  return s;
}

/** Midnight (in the runtime's own clock) of today's date in `tz`: the grammar's "today". */
export function zonedToday(tz: string, now: Date = new Date()): Date {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return new Date(get("year"), get("month") - 1, get("day"));
}

/** An IANA zone Slack gave (users.info tz), or the fallback. */
export function safeTz(tz: unknown, fallback = "Europe/London"): string {
  if (typeof tz !== "string" || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return fallback;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return tz; } catch { return fallback; }
}

export interface Member { id: string; name: string; email?: string | null }
export interface Project { id: string; name: string; emoji?: string | null }

/** A Slack profile (users.info) → the workspace member it is: email first, then names. */
export function resolveMention(profile: { email?: string | null; displayName?: string | null; realName?: string | null; label?: string | null },
  members: Member[]): Member | undefined {
  const email = String(profile.email ?? "").trim().toLowerCase();
  if (email) {
    const byEmail = members.find((m) => String(m.email ?? "").trim().toLowerCase() === email);
    if (byEmail) return byEmail;
  }
  for (const n of [profile.realName, profile.displayName, profile.label]) {
    const name = String(n ?? "").trim();
    if (!name) continue;
    const exact = members.find((m) => m.name.trim().toLowerCase() === name.toLowerCase());
    if (exact) return exact;
  }
  // a looser match only on a full name (first + last), never a bare first letter or two
  const real = String(profile.realName ?? "").trim();
  return real.split(/\s+/).length >= 2 ? matchMember(real, members) : undefined;
}

export type SlashIntent = { kind: "help" } | { kind: "modal" } | { kind: "create"; text: string };

/** What a /kanbo command asks for. */
export function slashIntent(text: string): SlashIntent {
  const t = String(text ?? "").trim();
  if (!t) return { kind: "modal" };
  if (/^(help|\?|-h|--help)$/i.test(t)) return { kind: "help" };
  return { kind: "create", text: t };
}

export interface SlackParsedTask {
  title: string;
  dueDate?: string;
  dueTime?: string;
  startDate?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  projectId?: string;
  assigneeId?: string;
  effortHours?: number;
  /** "#words" that named no project (left in the title) */
  unknownProjects: string[];
  /** "@words" that named nobody (left in the title, as people typed them) */
  unknownPeople: string[];
}

/**
 * Read a /kanbo sentence. `resolved`: Slack user id → Kanbo user id for the
 * mentions decodeSlackText found (the caller asks Slack who they are).
 */
export function parseSlackTask(raw: string, ctx: {
  today: Date;
  projects: Project[];
  members: Member[];
  resolved?: Map<string, string>;
}): SlackParsedTask {
  const { text, mentions } = decodeSlackText(raw);
  const resolved = ctx.resolved ?? new Map<string, string>();
  // a resolved mention reads as its handle, an unresolved one as the name Slack showed
  let sentence = text;
  const synthetic: Member[] = [];
  for (const m of mentions) {
    const uid = resolved.get(m.slackUserId);
    if (uid) synthetic.push({ id: uid, name: m.handle });
    else sentence = sentence.split(`@${m.handle}`).join(m.label ? `@${m.label.replace(/\s+/g, "")}` : "@someone");
  }
  const p = parseTask(sentence, {
    today: ctx.today,
    kinds: SLACK_KINDS,
    projects: ctx.projects.map((x) => ({ id: x.id, name: x.name })),
    // the handles first: an exact handle always wins over a member whose name starts the same
    members: [...synthetic, ...ctx.members.map((x) => ({ id: x.id, name: x.name }))],
  });
  // whatever looks like #project / @person but wasn't read stays in the title: say so
  const unknownProjects = [...p.title.matchAll(/(?:^|[\s(\[,;])#(\p{L}[\p{L}\p{N}_-]*)/gu)].map((m) => m[1]);
  const unknownPeople = [...p.title.matchAll(/(?:^|[\s(\[,;])@(\p{L}[\p{L}\p{N}._-]*)/gu)].map((m) => m[1]).filter((w) => w !== "someone");
  return {
    title: p.title,
    ...(p.dueDate ? { dueDate: p.dueDate } : {}),
    ...(p.dueTime ? { dueTime: p.dueTime } : {}),
    ...(p.startDate ? { startDate: p.startDate } : {}),
    ...(p.priority ? { priority: p.priority } : {}),
    ...(p.projectId ? { projectId: p.projectId } : {}),
    ...(p.assigneeId ? { assigneeId: p.assigneeId } : {}),
    ...(p.effortHours !== undefined ? { effortHours: p.effortHours } : {}),
    unknownProjects,
    unknownPeople,
  };
}

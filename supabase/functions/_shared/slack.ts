// ============================================================
// KANBO — Slack messages, pure.                                  [f6-slack]
// Shared by the slack-post and slack-standup edge functions and the web
// app (src/lib/slack.ts re-exports the webhook rule), so the URL check, the
// Block Kit layout and the stand-up text can never drift apart.
//
// No Deno globals, no remote imports: vitest runs it (slack.test.ts).
//
// Slack's limits this file enforces (https://api.slack.com/reference/block-kit):
//   header text ≤ 150 characters (plain text, one line)
//   section text ≤ 3,000 characters (mrkdwn)
//   ≤ 50 blocks per message
// Everything people typed is escaped for mrkdwn (& < >), so a post can't
// @channel, @here, mention anyone or hide a link behind other words.
// ============================================================

/** The only webhook shape accepted: the same rule as the 0043 database check. */
export const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+$/;
/** The longest webhook URL accepted (the 0043 check). */
export const SLACK_URL_MAX = 500;

/** True for a Slack Incoming Webhook URL (https://hooks.slack.com/services/…, ≤ 500 chars). */
export function isSlackWebhookUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const u = url.trim();
  return u.length > 0 && u.length <= SLACK_URL_MAX && SLACK_WEBHOOK_RE.test(u);
}

export const SLACK_LIMITS = {
  /** header block text */
  header: 150,
  /** one section block's text */
  section: 3000,
  /** blocks in one message */
  blocks: 50,
  /** the write-up people send (characters, before escaping); longer is cut short */
  text: 12000,
  /** a heading override */
  title: 150,
  /** the notification text Slack shows in banners and search */
  fallback: 300,
  /** names in the context line */
  name: 80,
} as const;

export type SlackMessageKind = "test" | "standup" | "status" | "risks";
export type SlackStatusKind = "on_track" | "at_risk" | "off_track";

export const STATUS_WORDS: Record<SlackStatusKind, { label: string; emoji: string }> = {
  on_track: { label: "On track", emoji: ":large_green_circle:" },
  at_risk: { label: "At risk", emoji: ":large_yellow_circle:" },
  off_track: { label: "Off track", emoji: ":red_circle:" },
};
export const isStatusKind = (v: unknown): v is SlackStatusKind =>
  v === "on_track" || v === "at_risk" || v === "off_track";

/* ---------------------------------------------------------------- text */

/** mrkdwn's three control characters, escaped (Slack's own rule). */
export function escapeMrkdwn(s: string): string {
  return String(s ?? "").replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair,
 *  adding "…" when anything was cut. */
export function clip(s: string, max: number): string {
  const str = String(s ?? "");
  if (str.length <= max) return str;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  let end = max - 1;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;   // don't leave half an emoji
  return str.slice(0, end).trimEnd() + "…";
}

/** One line of plain text: control characters and runs of whitespace become
 *  single spaces, then capped. */
export function oneLine(s: string, max: number): string {
  // deno-lint-ignore no-control-regex
  return clip(String(s ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim(), max);
}

/** Text people typed, tidied for a message: Windows line ends, stray control
 *  characters and trailing spaces gone, at most two blank lines in a row,
 *  capped at SLACK_LIMITS.text. */
export function tidyText(s: string, max: number = SLACK_LIMITS.text): { text: string; cut: boolean } {
  const t = String(s ?? "")
    .replace(/\r\n?/g, "\n")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > max ? { text: clip(t, max), cut: true } : { text: t, cut: false };
}

/** Where a hard split may fall in escaped text at or before `at`: never inside
 *  an entity (&amp; &lt; &gt;) or a surrogate pair, preferably after a space. */
function safeCut(s: string, at: number): number {
  let cut = at;
  const space = s.lastIndexOf(" ", cut);
  if (space > at * 0.6) cut = space + 1;
  const amp = s.lastIndexOf("&", cut - 1);
  if (amp >= 0 && amp > cut - 5 && s.indexOf(";", amp) >= cut) cut = amp;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return Math.max(1, cut);
}

/**
 * Escaped text split into section-sized chunks (≤ `max` characters each):
 * whole lines packed together where they fit, a line longer than a section
 * split at a space. Empty text → [].
 */
export function splitSections(text: string, max: number = SLACK_LIMITS.section): string[] {
  const lines = escapeMrkdwn(text).split("\n");
  const out: string[] = [];
  let cur = "";
  const flush = () => { if (cur.trim()) out.push(cur.replace(/\n+$/, "")); cur = ""; };
  for (let line of lines) {
    while (line.length > max) {
      flush();
      const cut = safeCut(line, max);
      out.push(line.slice(0, cut).trimEnd());
      line = line.slice(cut);
    }
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > max) { flush(); cur = line; } else cur = next;
  }
  flush();
  return out;
}

/** A URL Slack can link: http(s) only, and nothing that would end the
 *  <url|label> syntax early. Null for anything else. */
export function safeLinkUrl(url: string | null | undefined): string | null {
  const u = String(url ?? "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(u) || u.length > 2000) return null;
  return u.replace(/&/g, "&amp;").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\|/g, "%7C");
}

/** <url|label>, with the label escaped; just the escaped label without a usable URL. */
export function slackLink(url: string | null | undefined, label: string): string {
  const safe = safeLinkUrl(url);
  const text = escapeMrkdwn(oneLine(label, 120)).replace(/\|/g, "/");
  return safe ? `<${safe}|${text}>` : text;
}

/** "Mon 5 Oct" from YYYY-MM-DD (the date as written, no time zone maths). */
export function fmtDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "");
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

/* ---------------------------------------------------------------- Block Kit */

export type SlackBlock =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji: boolean } }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: { type: "mrkdwn"; text: string }[] }
  | { type: "divider" };

export interface SlackMessage {
  /** notification / fallback text (mrkdwn, escaped) */
  text: string;
  blocks: SlackBlock[];
  /** link previews off: the message carries its own link back */
  unfurl_links: false;
  unfurl_media: false;
}

export interface SlackMessageInput {
  kind: SlackMessageKind;
  /** what people wrote (Pulse's write-up, the update, Radar's summary): Slack mrkdwn, escaped here */
  text?: string;
  /** heading override */
  title?: string;
  workspaceName?: string;
  /** kind "status": the project's name (read on the server) */
  projectName?: string;
  /** kind "status" */
  status?: SlackStatusKind | null;
  /** the link back into Kanbo (APP_URL + /team/pulse or /p/:id) */
  url?: string | null;
  /** who posted; null/empty = Kanbo's daily auto-post */
  actorName?: string | null;
  /** kind "test": the channel label, if one was given */
  channelLabel?: string | null;
  /** kind "standup": YYYY-MM-DD for the default heading */
  day?: string;
}

const header = (text: string): SlackBlock => ({ type: "header", text: { type: "plain_text", text: oneLine(text, SLACK_LIMITS.header) || "Kanbo", emoji: true } });
const section = (text: string): SlackBlock => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string): SlackBlock => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

/** A first line that is only *bold* text is a heading (Pulse writes one). */
const BOLD_HEADING = /^\*([^*\n]{1,200})\*\s*$/;

/**
 * The message for one post: a header, the words in sections (escaped, ≤ 3,000
 * characters each), and a context line saying who posted it with a link back
 * to Kanbo. At most 50 blocks; anything past that is cut with a note.
 */
export function buildSlackMessage(input: SlackMessageInput): SlackMessage {
  const ws = oneLine(input.workspaceName ?? "", SLACK_LIMITS.name);
  const who = oneLine(input.actorName ?? "", SLACK_LIMITS.name);
  const title = oneLine(input.title ?? "", SLACK_LIMITS.title);
  let { text: body, cut } = tidyText(input.text ?? "");

  let heading: string;
  const lead: SlackBlock[] = [];
  let linkLabel = "Open in Kanbo";
  switch (input.kind) {
    case "test": {
      heading = "Kanbo is connected";
      const where = input.channelLabel ? ` in ${escapeMrkdwn(oneLine(input.channelLabel, 80))}` : " here";
      body = "";
      lead.push(section(
        `${ws ? `*${escapeMrkdwn(ws)}*` : "Your Kanbo workspace"} will post stand-ups, project status updates and risks${where} whenever someone shares them from Kanbo.`,
      ));
      linkLabel = "Open Kanbo";
      break;
    }
    case "status": {
      const project = oneLine(input.projectName ?? "", 100) || "Project";
      heading = title || `${project} · status update`;
      if (input.status && STATUS_WORDS[input.status]) {
        const s = STATUS_WORDS[input.status];
        lead.push(section(`${s.emoji} *${s.label}*`));
      }
      linkLabel = "Open the project in Kanbo";
      break;
    }
    case "risks": {
      heading = title || (ws ? `Risks on the Radar · ${ws}` : "Risks on the Radar");
      linkLabel = "Open the Radar in Kanbo";
      break;
    }
    default: {
      // stand-up: Pulse's own bold first line becomes the heading
      const m = BOLD_HEADING.exec(body.split("\n", 1)[0] ?? "");
      if (m) body = body.slice(body.indexOf("\n") + 1 || body.length).replace(/^\n+/, "");
      heading = title || (m ? m[1].trim() : `Stand-up${input.day ? ` · ${fmtDay(input.day)}` : ""}`);
      linkLabel = "Open Pulse in Kanbo";
    }
  }

  const sections = splitSections(body).map(section);
  if (input.kind !== "test" && !sections.length && !lead.length) sections.push(section("_Nothing was written._"));
  if (cut) sections.push(context("_Cut short to fit Slack. The rest is in Kanbo._"));

  const by = who ? `Posted from Kanbo by ${escapeMrkdwn(who)}` : input.kind === "test" ? "Sent from Kanbo" : "Posted automatically by Kanbo";
  const place = ws && input.kind !== "test" ? ` · ${escapeMrkdwn(ws)}` : "";
  const link = safeLinkUrl(input.url) ? ` · ${slackLink(input.url, linkLabel)}` : "";
  const foot = context(`${by}${place}${link}`);

  const head = header(heading);
  let blocks: SlackBlock[] = [head, ...lead, ...sections];
  const room = SLACK_LIMITS.blocks - 1;   // the context line always fits
  if (blocks.length > room) {
    blocks = blocks.slice(0, room - 1);
    blocks.push(context("_Cut short to fit Slack. The rest is in Kanbo._"));
  }
  blocks.push(foot);

  const firstWords = body.split("\n").map((l) => l.replace(/[*_~`]/g, "").trim()).find(Boolean) ?? "";
  const statusWord = input.kind === "status" && input.status && STATUS_WORDS[input.status] ? ` (${STATUS_WORDS[input.status].label})` : "";
  const fallback = oneLine(`${head.type === "header" ? head.text.text : heading}${statusWord}${firstWords ? `: ${firstWords}` : ""}`, SLACK_LIMITS.fallback);
  return { text: escapeMrkdwn(fallback), blocks, unfurl_links: false, unfurl_media: false };
}

/* ---------------------------------------------------------------- Slack's answer */

export type SlackDelivery =
  | { ok: true }
  | { ok: false; reason: "rate_limited" | "slack_rejected"; detail: string; retryAfter?: number; gone?: boolean };

/** Slack's error words that mean the webhook will never work again. */
const GONE = new Set(["no_service", "no_team", "team_disabled", "invalid_token", "channel_not_found", "channel_is_archived", "no_active_hooks"]);

/**
 * What Slack's reply to a webhook POST means. 2xx is delivered; 429 is a
 * pause (Retry-After seconds); 3xx (never followed) and everything else is a
 * refusal with Slack's error word as `detail` ("no_service", "invalid_payload",
 * "channel_is_archived"…). `gone`: the webhook was revoked or its channel is
 * gone; an owner/admin has to reconnect.
 */
export function classifySlackResponse(status: number, body: string, retryAfter?: string | null): SlackDelivery {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 429) {
    const secs = Number.parseInt(String(retryAfter ?? ""), 10);
    return { ok: false, reason: "rate_limited", detail: "rate_limited", retryAfter: Number.isFinite(secs) && secs > 0 ? Math.min(secs, 3600) : 30 };
  }
  if (status >= 300 && status < 400) return { ok: false, reason: "slack_rejected", detail: "redirect" };
  if (status >= 500) return { ok: false, reason: "slack_rejected", detail: "slack_unavailable" };
  const word = String(body ?? "").trim().toLowerCase();
  const detail = /^[a-z_]{2,60}$/.test(word) ? word : `http_${status}`;
  return GONE.has(detail) || status === 404 || status === 410
    ? { ok: false, reason: "slack_rejected", detail, gone: true }
    : { ok: false, reason: "slack_rejected", detail };
}

/* ---------------------------------------------------------------- time (Europe/London) */

export interface ZonedNow {
  /** YYYY-MM-DD in the zone */
  day: string;
  /** minutes since midnight in the zone */
  minutes: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock day, time and weekday in `tz` (BST-aware). */
export function zonedNow(now: Date = new Date(), tz = "Europe/London"): ZonedNow {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? new Date(now).getUTCDay(),
  };
}

/** "HH:MM" → minutes since midnight; null for anything else. */
export function parseHhMm(t: string | null | undefined): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(t ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** How far back a run looks for auto-post times: the cron runs every 15
 *  minutes; 5 more cover a late start (the per-day key stops a second post). */
export const STANDUP_WINDOW_MIN = 20;

/** Is a stand-up set for `time` due on a run at `nowMinutes` (same day)? */
export function isStandupDue(time: string | null | undefined, nowMinutes: number, windowMin = STANDUP_WINDOW_MIN): boolean {
  const t = parseHhMm(time);
  if (t === null) return false;
  const late = nowMinutes - t;
  return late >= 0 && late < windowMin;
}

/** Monday to Friday. */
export const isWeekday = (weekday: number) => weekday >= 1 && weekday <= 5;

/** Add days to YYYY-MM-DD. */
export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1) + n * 86400_000);
  return dt.toISOString().slice(0, 10);
}

/** The workday before `today`: Monday (and the weekend) look back to Friday. */
export function lastWorkdayIso(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const wd = new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay();
  return addDaysIso(today, wd === 1 ? -3 : wd === 0 ? -2 : -1);   // Mon → Fri · Sun → Fri · otherwise the day before
}

/* ---------------------------------------------------------------- the daily stand-up */

export interface StandupTaskRow {
  id: string;
  title: string | null;
  status: string;
  assignee_id: string | null;
  due_date?: string | null;
  completed_at?: string | null;
  archived_at?: string | null;
  project_id?: string | null;
}
export interface StandupEventRow { task_id: string; field: string; new_value: string | null; created_at: string }
export interface StandupMember { id: string; name: string; guest?: boolean }
export interface StandupInput {
  tasks: StandupTaskRow[];
  /** status changes since `since` (for tasks finished without a completed_at) */
  events?: StandupEventRow[];
  members: StandupMember[];
  /** YYYY-MM-DD (Europe/London) */
  today: string;
  /** YYYY-MM-DD: the first day "done" counts from (default: the last workday) */
  since?: string;
  tz?: string;
}

const MAX_TITLES = 5;
const MAX_PEOPLE = 40;
const firstNameOf = (n: string) => n.trim().split(/\s+/)[0] || n.trim();
const sinceWord = (since: string, today: string) => {
  if (addDaysIso(today, -1) === since) return "yesterday";
  const [y, m, d] = since.split("-").map(Number);
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const listOf = (titles: string[]) => {
  const shown = titles.slice(0, MAX_TITLES).map((t) => oneLine(t, 120));
  return titles.length > MAX_TITLES ? `${shown.join(", ")} +${titles.length - MAX_TITLES} more` : shown.join(", ");
};
const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The stand-up the daily auto-post sends, in Slack mrkdwn (not escaped:
 * buildSlackMessage escapes it). From the workspace's tasks: per person,
 * what they finished since the last workday, what's in progress, what's due
 * today, what's overdue and what's blocked. People with nothing to report are
 * left out; guests come last.
 */
export function buildStandupText(input: StandupInput): string {
  const today = input.today;
  const since = input.since ?? lastWorkdayIso(today);
  const tz = input.tz ?? "Europe/London";
  const tasks = input.tasks.filter((t) => !t.archived_at);
  const doneByEvent = new Set((input.events ?? [])
    .filter((e) => e.field === "status" && e.new_value === "done" && zonedNow(new Date(e.created_at), tz).day >= since)
    .map((e) => e.task_id));
  const finished = tasks.filter((t) => t.status === "done" && ((!!t.completed_at && t.completed_at.slice(0, 10) >= since) || doneByEvent.has(t.id)));
  const open = tasks.filter((t) => t.status !== "done");
  const blocked = open.filter((t) => t.status === "blocked");
  // an overdue task is listed once, as overdue, whatever else it is
  const overdue = open.filter((t) => t.status !== "blocked" && !!t.due_date && t.due_date < today);
  const late = new Set(overdue.map((t) => t.id));
  const doing = open.filter((t) => (t.status === "progress" || t.status === "review") && !late.has(t.id));
  const dueToday = open.filter((t) => t.status === "todo" && t.due_date === today);

  const firsts = new Map<string, number>();
  input.members.forEach((m) => { const f = firstNameOf(m.name); firsts.set(f, (firsts.get(f) ?? 0) + 1); });
  const shortName = (n: string) => ((firsts.get(firstNameOf(n)) ?? 0) > 1 ? n.trim() : firstNameOf(n));
  const titlesFor = (list: StandupTaskRow[], id: string) => list.filter((t) => t.assignee_id === id).map((t) => t.title || "Untitled task");

  const people = [...input.members]
    .sort((a, b) => Number(!!a.guest) - Number(!!b.guest) || a.name.localeCompare(b.name))
    .map((m) => {
      const bits = [
        ["done", titlesFor(finished, m.id)],
        ["doing", titlesFor(doing, m.id)],
        ["due today", titlesFor(dueToday, m.id)],
        ["overdue", titlesFor(overdue, m.id)],
        ["blocked", titlesFor(blocked, m.id)],
      ] as const;
      const said = bits.filter(([, ts]) => ts.length).map(([label, ts]) => `${label}: ${listOf([...ts])}`);
      return said.length ? `• *${shortName(m.name) || "Someone"}* — ${said.join("; ")}` : null;
    })
    .filter((l): l is string => !!l);

  const word = sinceWord(since, today);
  const lede: string[] = [];
  lede.push(finished.length ? `Since ${word} the team finished ${counted(finished.length, "task", "tasks")}.` : `Nothing has been finished since ${word}.`);
  const clauses: string[] = [];
  clauses.push(doing.length ? `${doing.length} ${doing.length === 1 ? "is" : "are"} in progress` : "nothing is in progress");
  if (dueToday.length) clauses.push(`${dueToday.length} ${dueToday.length === 1 ? "is" : "are"} due today`);
  if (overdue.length) clauses.push(`${overdue.length} ${overdue.length === 1 ? "is" : "are"} overdue`);
  clauses.push(blocked.length ? `${blocked.length} ${blocked.length === 1 ? "is" : "are"} blocked` : "nothing is blocked");
  const second = clauses.length > 1 ? `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}` : clauses[0];
  lede.push(second.charAt(0).toUpperCase() + second.slice(1) + ".");

  const lines = people.slice(0, MAX_PEOPLE);
  if (people.length > MAX_PEOPLE) lines.push(`…and ${people.length - MAX_PEOPLE} more people.`);
  return [`*Stand-up — ${fmtDay(today)}*`, lede.join(" "), "", ...(lines.length ? lines : ["Nobody has anything to report yet."])].join("\n");
}

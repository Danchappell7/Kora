// ============================================================
// KANBO — what a notification says (0048, u4). Pure module (no Deno
// globals, no remote imports): notify, daily-reminders and their tests share
// it — see notifyCompose.test.ts.
//
//   • a lone notice: its own push / email, pre-rendered when it's queued
//     (NoticePayload), exactly as notify sent them before 0048;
//   • a bundle: everything held for one task in one window, as ONE push and
//     ONE email — "3 comments on Launch deck from Sana and Theo", every
//     mention named ("Sana mentioned you");
//   • the morning due list and the daily digest (daily-reminders);
//   • project updates (0053): the update-day reminder (daily-reminders'
//     digest run) and "Ask for an update" (notify), and both in the digest;
//   • (0054) a posted update for the project's owner and contributors, and
//     an Ask in it for the people it names (notify { kind: "status_update" }).
// Everything user-written is escaped; titles are one line and capped.
// ============================================================
import type { PushMessage } from "./webpush.ts";
import { esc, oneLine, renderEmail } from "./email.ts";

/** notify_queue.payload: a lone notice pre-rendered, plus its line in a bundle. */
export interface NoticePayload {
  v: 1;
  /** "Sana Rao mentioned you" — what a bundle lists */
  line: string;
  /** same-origin path to open ("/?task=<id>", "/today") */
  url: string;
  push?: PushMessage;
  email?: { subject: string; html: string };
  /** a held morning due list (daily-reminders in quiet hours) */
  due?: { today: string; tasks: DueTask[]; more: number };
}
export interface DueTask { id: string; title: string | null; due_date: string }

/** The slice of a notify_queue row composing needs. */
export interface ComposeRow {
  kind: string;
  actor_name: string;
  title: string;
  task_id: string | null;
  payload: NoticePayload | Record<string, unknown> | null;
  created_at?: string;
}

export interface Composed {
  push?: PushMessage;
  email?: { subject: string; html: string; text?: string };
}

const who = (n: string | null | undefined) => oneLine(n, 60) || "Someone";

/** One notice in a list: "Sana Rao mentioned you" · "Theo Vance commented" · "Maya Lin assigned you this task". */
export function noticeLine(kind: string, actorName: string): string {
  const w = who(actorName);
  switch (kind) {
    case "mention": return `${w} mentioned you`;
    case "comment": return `${w} commented`;
    case "assigned": return `${w} assigned you this task`;
    case "approval": return `${w} asked about an approval`;
    case "kudos": return `${w} sent you kudos`;
    case "update": return `${w} asked for an update`;
    default: return `${w} updated it`;
  }
}

/** The email notify has always sent for assigned / mention / comment. */
const EVENT_COPY: Record<string, { subj: (t: string) => string; line: string }> = {
  assigned: { subj: (t) => `You were assigned: ${t}`, line: "assigned you a task" },
  mention: { subj: (t) => `You were mentioned: ${t}`, line: "mentioned you in" },
  comment: { subj: (t) => `New comment: ${t}`, line: "commented on" },
};
export function eventEmail(kind: "assigned" | "mention" | "comment", actorName: string, taskTitle: string, link: string): { subject: string; html: string } {
  const title = oneLine(taskTitle, 140) || "a task";
  const c = EVENT_COPY[kind];
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
        <p style="font-size:15px"><strong>${esc(who(actorName))}</strong> ${c.line} <strong>${esc(title)}</strong>.</p>
        ${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#6a5cff;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:14px">Open in Kanbo</a></p>` : ""}
        <p style="font-size:12px;color:#888">Manage notification emails in Kanbo → Settings.</p>
      </div>`;
  return { subject: c.subj(title), html };
}

/** Kudos, to the person thanked: "Theo sent you 👏 for Launch deck", and their note. The emoji is one of the ten
 *  the database allows (anything else reads 🎉); the note is the giver's, escaped and one line. */
const KUDOS_EMOJI = ["🎉", "👏", "🙌", "💪", "⭐", "🚀", "❤️", "🔥", "💯", "🏆"];
export function kudosPush(fromName: string, emoji: string, note: string | null | undefined, taskTitle: string, taskId: string): PushMessage {
  const em = KUDOS_EMOJI.includes(emoji) ? emoji : "🎉";
  const n = oneLine(note ?? "", 140);
  const title = oneLine(taskTitle, 120) || "a task";
  return { title: `${who(fromName)} sent you ${em}`, body: n ? `For ${title}: “${n}”` : `For ${title}`, url: `/?task=${encodeURIComponent(taskId)}`, tag: `kudos-${taskId}`, kind: "kudos" };
}
export function kudosEmail(fromName: string, emoji: string, note: string | null | undefined, taskTitle: string, link: string): { subject: string; html: string } {
  const em = KUDOS_EMOJI.includes(emoji) ? emoji : "🎉";
  const n = oneLine(note ?? "", 140);
  const title = oneLine(taskTitle, 140) || "a task";
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
        <p style="font-size:15px"><strong>${esc(who(fromName))}</strong> sent you ${em} for <strong>${esc(title)}</strong>.</p>
        ${n ? `<p style="font-size:15px;margin:0 0 12px">“${esc(n)}”</p>` : ""}
        ${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#6a5cff;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:14px">Open in Kanbo</a></p>` : ""}
        <p style="font-size:12px;color:#888">Manage notification emails in Kanbo → Settings.</p>
      </div>`;
  return { subject: `${em} Kudos from ${who(fromName)}: ${title}`, html };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const firstName = (n: string) => (n.includes("@") ? n : n.trim().split(/\s+/)[0] || n);
/** "Sana and Theo", "Sana, Theo and 2 others" — first names unless two share one */
export function peopleList(names: string[]): string {
  const uniq = [...new Set(names.map((n) => who(n)))];
  const firsts = uniq.map(firstName);
  const shown = new Set(firsts).size === firsts.length ? firsts : uniq;
  return shown.length <= 3 ? listJoin(shown) : `${shown.slice(0, 2).join(", ")} and ${shown.length - 2} others`;
}

const KIND_ORDER = ["mention", "approval", "assigned", "comment", "kudos"];
const KIND_NOUN: Record<string, [string, string]> = {
  mention: ["mention", "mentions"], approval: ["approval update", "approval updates"], assigned: ["assignment", "assignments"],
  comment: ["comment", "comments"], kudos: ["kudos", "kudos"],
};

/**
 * One message for everything held for a task: the push replaces the task's
 * earlier one on the lock screen (same tag); the email lists each notice.
 * Rows are oldest first or any order: they're sorted by created_at.
 */
export function composeBundle(rows: readonly ComposeRow[], appUrl: string): Composed {
  const sorted = [...rows].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const taskTitle = oneLine(sorted[sorted.length - 1]?.title, 140) || "a task";
  const taskId = sorted.find((r) => r.task_id)?.task_id ?? null;
  const counts = new Map<string, number>();
  for (const r of sorted) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const kinds = [...counts.keys()].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
  const n = sorted.length;
  const actors = sorted.map((r) => r.actor_name).filter(Boolean).reverse();   // newest first
  const from = actors.length ? ` from ${peopleList(actors)}` : "";
  const headline = kinds.length === 1
    ? `${plural(n, (KIND_NOUN[kinds[0]] ?? ["update", "updates"])[0], (KIND_NOUN[kinds[0]] ?? ["update", "updates"])[1])} on ${taskTitle}`
    : `${plural(n, "update")} on ${taskTitle}`;
  // never bury what asks something of you: every mention and assignment is named
  const named = (kind: string) => [...new Set(sorted.filter((r) => r.kind === kind).map((r) => firstName(who(r.actor_name))))];
  const mentioners = named("mention"), assigners = named("assigned");
  const mentionLine = [
    mentioners.length ? `${listJoin(mentioners)} mentioned you` : "",
    assigners.length ? `${listJoin(assigners)} assigned it to you` : "",
  ].filter(Boolean).join(" · ");
  // (a project's notices have no task: they open where their own said, e.g. its Updates tab)
  const own = (sorted[sorted.length - 1]?.payload ?? {}) as Partial<NoticePayload>;
  const path = taskId ? `/?task=${encodeURIComponent(taskId)}` : typeof own.url === "string" && own.url.startsWith("/") ? own.url : "/inbox";
  const push: PushMessage = {
    title: headline,
    body: [mentionLine, actors.length ? `From ${peopleList(actors)}` : ""].filter(Boolean).join(" · ") || taskTitle,
    url: path,
    tag: taskId ? `task-${taskId}` : "kanbo-bundle",
    kind: mentioners.length ? "mention" : kinds.includes("assigned") ? "assigned" : kinds.includes("approval") ? "approval" : "comment",
  };
  const link = appUrl ? `${appUrl}${path}` : "";
  const lines = sorted.map((r) => {
    const p = (r.payload ?? {}) as Partial<NoticePayload>;
    const line = typeof p.line === "string" && p.line ? p.line : noticeLine(r.kind, r.actor_name);
    return `<li style="margin:0 0 6px">${r.kind === "mention" || r.kind === "assigned" ? `<strong>${esc(oneLine(line, 160))}</strong>` : esc(oneLine(line, 160))}</li>`;
  }).join("");
  const mail = renderEmail({
    heading: `${headline}${from}`,
    paragraphs: [
      ...(mentionLine ? [`<strong>${esc(mentionLine)}.</strong>`] : []),
      `<ul style="margin:0;padding:0 0 0 18px">${lines}</ul>`,
    ],
    cta: link ? { label: "Open in Kanbo", href: link } : undefined,
    footnotes: ["Related updates within two minutes arrive together. Change this in Kanbo › Settings › Notifications."],
  });
  return { push, email: { subject: oneLine(`${headline}${from}`, 180), html: mail.html, text: mail.text } };
}

/* ---------- the morning due list ---------- */

/** daily-reminders' email for what's due today or overdue (oldest first, 50 at most). */
export function dueEmail(tasks: readonly DueTask[], today: string, appUrl: string, more = 0): { subject: string; html: string } {
  const sorted = [...tasks].sort((a, b) => a.due_date.localeCompare(b.due_date));
  const total = sorted.length + more;
  const rows = sorted.slice(0, 50).map((t) => {
    const overdue = t.due_date < today;
    const title = esc(oneLine(t.title || "Untitled task", 160));
    const cell = appUrl ? `<a href="${esc(`${appUrl}/?task=${encodeURIComponent(t.id)}`)}" style="color:#1a1a1a;text-decoration:none">${title}</a>` : title;
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${cell}</td>` +
      `<td style="padding:8px 0;border-bottom:1px solid #eee;color:${overdue ? "#c0392b" : "#555"};text-align:right;white-space:nowrap">${overdue ? "Overdue" : "Today"}</td></tr>`;
  }).join("");
  const extra = total - Math.min(50, sorted.length);
  const tail = extra > 0 ? `<p style="color:#555;font-size:13px">…and ${extra} more.</p>` : "";
  const html =
    `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:520px;margin:auto;color:#1a1a1a">` +
    `<h2 style="font-weight:600">Your day on Kanbo</h2>` +
    `<p style="color:#555">You have <strong>${total}</strong> task${total === 1 ? "" : "s"} due today or overdue.</p>` +
    `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>${tail}` +
    (appUrl ? `<p style="margin-top:20px"><a href="${esc(appUrl)}" style="background:#6a5cff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open Kanbo</a></p>` : "") +
    `<p style="font-size:12px;color:#888;margin-top:18px">Turn these off in Kanbo → Settings → Notifications.</p>` +
    `</div>`;
  return { subject: `${total} task${total === 1 ? "" : "s"} due on Kanbo`, html };
}

/* ---------- the daily digest ---------- */

/** An unread Inbox item (public.activity, the columns the digest reads). */
export interface DigestItem {
  id: string;
  task_id: string | null;
  task_title: string;
  kind: string;
  detail: string;
  created_at: string;
  meta?: Record<string, unknown> | null;
}

/** The Inbox's own history: never a notification. */
const SELF = new Set(["created", "status", "completed", "reopened", "deleted"]);

export interface DigestThread {
  taskId: string | null;
  title: string;
  /** "Sana mentioned you", "3 comments from Sana and Theo", "Maya assigned you" */
  lines: string[];
  mention: boolean;
  latest: string;
}

const DIGEST_ORDER = ["mention", "doc_mention", "approval", "assigned", "comment", "kudos", "update", "meeting", "integration"];
const digestRank = (k: string) => { const i = DIGEST_ORDER.indexOf(k); return i < 0 ? 99 : i; };

/** The thread an item belongs to: its task; a project update's, its project (a portfolio update's, its portfolio);
 *  a doc mention or notice stands alone. */
function threadKey(it: DigestItem): string {
  if (it.task_id) return `t:${it.task_id}`;
  const ref = it.kind === "update" ? it.meta?.project_id ?? it.meta?.portfolio_id : null;
  return typeof ref === "string" && ref ? `u:${ref}` : `i:${it.id}`;
}

/** Unread items → threads (see threadKey), mentions first, then newest. */
export function digestThreads(items: readonly DigestItem[]): DigestThread[] {
  const groups = new Map<string, DigestItem[]>();
  for (const it of items) {
    if (SELF.has(it.kind)) continue;
    const key = threadKey(it);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
  }
  const out: DigestThread[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const lines: string[] = [];
    const byKind = new Map<string, DigestItem[]>();
    for (const it of list) (byKind.get(it.kind) ?? byKind.set(it.kind, []).get(it.kind)!).push(it);
    const names = (xs: DigestItem[]) => peopleList(xs.map((x) => x.detail).filter((d) => d && !/^Request via\b/i.test(d)));
    for (const kind of [...byKind.keys()].sort((a, b) => digestRank(a) - digestRank(b))) {
      const xs = byKind.get(kind)!;
      const ppl = names(xs);
      if (kind === "mention" || kind === "doc_mention") lines.push(`${ppl || "Someone"} mentioned you`);
      else if (kind === "comment") lines.push(`${plural(xs.length, "comment")}${ppl ? ` from ${ppl}` : ""}`);
      else if (kind === "assigned") lines.push(/^Request via\b/i.test(xs[0].detail) ? `New request ${oneLine(xs[0].detail.replace(/^Request\s+/i, ""), 80)}` : `${ppl || "Someone"} assigned you`);
      else if (kind === "approval") lines.push(xs.length === 1 ? `${ppl || "Someone"}: approval ${String(xs[0].meta?.event ?? "update").replace(/_/g, " ")}` : `${xs.length} approval updates`);
      else if (kind === "kudos") lines.push(`${ppl || "Someone"} sent you kudos`);
      // 0054: a project update (the thread is its project): an Ask for you, replies, or posted
      else if (kind === "update") {
        const asks = xs.filter((x) => x.meta?.ask === true);
        const replies = xs.filter((x) => x.meta?.update_event === "comment" && x.meta?.ask !== true);
        const posted = xs.length - asks.length - replies.length;
        if (asks.length) lines.push(`${peopleList(asks.map((x) => x.detail)) || "Someone"} asked you something in an update`);
        if (replies.length) lines.push(`${plural(replies.length, "reply", "replies")} on your update${names(replies) ? ` from ${names(replies)}` : ""}`);
        if (posted > 0) lines.push(posted === 1 ? `${names(xs.filter((x) => x.meta?.ask !== true && x.meta?.update_event !== "comment")) || "Someone"} posted an update` : `${posted} updates posted`);
      }
      // 0056: a meeting's recap (its own thread): who shared it, and what it left
      else if (kind === "meeting") {
        const d = Number(xs[0].meta?.decisions ?? 0), a = Number(xs[0].meta?.actions ?? 0);
        const left = [d > 0 ? plural(d, "decision") : "", a > 0 ? plural(a, "action") : ""].filter(Boolean).join(" and ");
        lines.push(`${ppl || "Someone"} shared the recap${left ? `: ${left}` : ""}`);
      }
      else if (kind === "integration") lines.push(oneLine(xs[0].detail || "An integration needs you", 120));
      else lines.push(plural(xs.length, "update"));
    }
    out.push({
      taskId: list[0].task_id, title: oneLine(list[0].task_title, 140) || (list[0].kind === "integration" ? "Integrations" : list[0].kind === "meeting" ? "A meeting" : "A task"),
      lines, mention: list.some((x) => x.kind === "mention" || x.kind === "doc_mention"), latest: list[0].created_at,
    });
  }
  return out.sort((a, b) => Number(b.mention) - Number(a.mention) || b.latest.localeCompare(a.latest));
}

/**
 * What goes in someone's digest: items on tasks they can still see (a doc
 * mention or a notice has no task and always counts), not in a snoozed
 * thread, and of a kind whose email they haven't switched off.
 */
export function filterDigestItems(items: readonly DigestItem[], visibleTasks: ReadonlySet<string>, snoozedTasks: ReadonlySet<string>,
  wants: (kind: string) => boolean = () => true): DigestItem[] {
  return items.filter((a) => (!a.task_id || (visibleTasks.has(a.task_id) && !snoozedTasks.has(a.task_id))) && wants(a.kind));
}

/** The digest email: unread updates by thread, then what's due, then your project updates (0053). null when there's nothing to say. */
export function digestEmail(threads: readonly DigestThread[], due: readonly DueTask[], today: string, appUrl: string,
  opts: { firstName?: string; digestTime?: string; updates?: readonly DigestUpdate[] } = {}):
  { subject: string; html: string; text: string } | null {
  const ups = opts.updates ?? [];
  if (!threads.length && !due.length && !ups.length) return null;
  const updates = threads.reduce((n, t) => n + t.lines.length, 0);
  const shown = threads.slice(0, 25);
  const link = (taskId: string | null) => (appUrl ? `${appUrl}${taskId ? `/?task=${encodeURIComponent(taskId)}` : "/inbox"}` : "");
  const threadHtml = shown.map((t) => {
    const href = link(t.taskId);
    const head = href ? `<a href="${esc(href)}" style="color:#18181b;font-weight:600;text-decoration:none">${esc(t.title)}</a>` : `<strong>${esc(t.title)}</strong>`;
    return `<li style="margin:0 0 10px">${head}<br><span style="color:#52525b">${t.lines.map((l) => esc(l)).join(" · ")}</span></li>`;
  }).join("");
  const moreThreads = threads.length > shown.length ? `<p style="color:#71717a;font-size:13px;margin:0">…and ${threads.length - shown.length} more in your Inbox.</p>` : "";
  const sortedDue = [...due].sort((a, b) => a.due_date.localeCompare(b.due_date));
  const dueHtml = sortedDue.slice(0, 15).map((t) => {
    const overdue = t.due_date < today;
    const href = link(t.id);
    const title = esc(oneLine(t.title || "Untitled task", 140));
    return `<li style="margin:0 0 6px">${href ? `<a href="${esc(href)}" style="color:#18181b;text-decoration:none">${title}</a>` : title}` +
      ` <span style="color:${overdue ? "#b42318" : "#71717a"}">${overdue ? "Overdue" : "Due today"}</span></li>`;
  }).join("");
  const parts: string[] = [];
  if (threads.length) parts.push(`<strong>${esc(plural(updates, "update"))} in your Inbox</strong>`, `<ul style="margin:0;padding:0 0 0 18px">${threadHtml}</ul>${moreThreads}`);
  if (due.length) parts.push(`<strong>${esc(`${plural(due.length, "task")} due today or overdue`)}</strong>`, `<ul style="margin:0;padding:0 0 0 18px">${dueHtml}</ul>${due.length > 15 ? `<p style="color:#71717a;font-size:13px;margin:0">…and ${due.length - 15} more.</p>` : ""}`);
  if (ups.length) {
    const upHtml = ups.slice(0, 10).map((u) => {
      const href = appUrl ? `${appUrl}/p/${encodeURIComponent(u.projectId)}/updates` : "";
      const name = esc(oneLine(u.name, 120) || "A project");
      return `<li style="margin:0 0 6px">${href ? `<a href="${esc(href)}" style="color:#18181b;text-decoration:none">${name}</a>` : name} <span style="color:#71717a">${esc(oneLine(u.line, 120))}</span></li>`;
    }).join("");
    parts.push(`<strong>${esc(ups.length === 1 ? "Your project update" : `${ups.length} project updates`)}</strong>`,
      `<ul style="margin:0;padding:0 0 0 18px">${upHtml}</ul><p style="color:#71717a;font-size:13px;margin:0">Kanbo has a draft ready on Today. Nothing is posted until you do.</p>`);
  }
  const bits = [threads.length ? plural(updates, "update") : "", due.length ? `${plural(due.length, "task")} due` : "", ups.length ? (ups.length === 1 ? "your project update" : `${ups.length} project updates`) : ""].filter(Boolean);
  const mail = renderEmail({
    heading: opts.firstName ? `Your Kanbo digest, ${oneLine(opts.firstName, 40)}` : "Your Kanbo digest",
    paragraphs: parts,
    cta: appUrl ? { label: "Open your Inbox", href: `${appUrl}/inbox` } : undefined,
    footnotes: [`You get one email a day${opts.digestTime ? ` at ${esc(opts.digestTime)}` : ""}, plus a push for mentions and approvals. Change this in Kanbo › Settings › Notifications.`],
  });
  return { subject: `Your Kanbo digest: ${bits.join(", ")}`, html: mail.html, text: mail.text };
}

/* ---------- project updates (0053) ---------- */

/** A project update that's yours to post: its name, and why ("due today", "was due Fri 6 Nov", "Theo asked for one"). */
export interface DigestUpdate { projectId: string; name: string; line: string }

/** One project on its update day (or a follow-up day) for its owner. */
export interface UpdateDueItem {
  projectId: string;
  name: string;
  /** "today", "Fri 6 Nov" */
  when: string;
  /** 0 on the day, then 1 and 2 */
  followUp: number;
}

const projectName = (n: string | null | undefined) => oneLine(n, 120) || "your project";
const dueSays = (i: UpdateDueItem) => (i.followUp === 0 || i.when === "today" ? "due today" : `was due ${i.when}`);
/** "Your Q3 launch update is due today" · "Your Q3 launch update was due Fri 6 Nov" · "3 project updates are waiting on you" */
const dueHeading = (items: readonly UpdateDueItem[]) => {
  if (items.length !== 1) return `${items.length} project updates are waiting on you`;
  const i = items[0];
  return i.followUp === 0 || i.when === "today" ? `Your ${projectName(i.name)} update is due today` : `Your ${projectName(i.name)} update was due ${i.when}`;
};

/** The update-day reminder's push: one a day for everything that's yours (it opens Today, where the drafts are). */
export function updateDuePush(items: readonly UpdateDueItem[]): PushMessage {
  const one = items.length === 1;
  return {
    title: dueHeading(items),
    body: one ? "Kanbo has drafted it from this week's work. Check it and post." : `${listJoin(items.slice(0, 4).map((i) => projectName(i.name)))}. Kanbo has drafts ready.`,
    url: "/today",
    tag: "kanbo-updates",
    kind: "update",
  };
}

/** …and its email. */
export function updateDueEmail(items: readonly UpdateDueItem[], appUrl: string): { subject: string; html: string; text: string } {
  const one = items.length === 1;
  const heading = dueHeading(items);
  const list = items.slice(0, 10).map((i) => {
    const href = appUrl ? `${appUrl}/p/${encodeURIComponent(i.projectId)}/updates` : "";
    const name = esc(projectName(i.name));
    return `<li style="margin:0 0 6px">${href ? `<a href="${esc(href)}" style="color:#18181b;text-decoration:none;font-weight:600">${name}</a>` : `<strong>${name}</strong>`} <span style="color:#71717a">${esc(dueSays(i))}</span></li>`;
  }).join("");
  const mail = renderEmail({
    heading,
    paragraphs: [
      ...(one ? [] : [`<ul style="margin:0;padding:0 0 0 18px">${list}</ul>`]),
      one ? "Kanbo has drafted it from this week's work: what finished, what's late and what's next. Check it, change what you like, and post." : "Kanbo has drafted each from this week's work. Check them, change what you like, and post.",
    ],
    cta: appUrl ? { label: one ? "Review the draft" : "Open Today", href: one && items[0] ? `${appUrl}/p/${encodeURIComponent(items[0].projectId)}/updates` : `${appUrl}/today` } : undefined,
    footnotes: ["It's your team's update day. If it's still to do you'll hear at most twice more, on the next working days. Change this in Kanbo › Settings › Notifications."],
  });
  return { subject: oneLine(heading, 180), html: mail.html, text: mail.text };
}

/** "Ask for an update": the push to the project's owner (it opens the project's Updates tab). */
export function updateAskPush(askerName: string, name: string, projectId: string): PushMessage {
  return {
    title: `${who(askerName)} asked for an update`,
    body: `On ${projectName(name)}. Kanbo has a draft ready.`,
    url: `/p/${encodeURIComponent(projectId)}/updates`,
    tag: `update-ask-${projectId}`,
    kind: "update",
  };
}

/** …and its email. */
export function updateAskEmail(askerName: string, name: string, link: string): { subject: string; html: string; text: string } {
  const heading = `${who(askerName)} asked for an update on ${projectName(name)}`;
  const mail = renderEmail({
    heading,
    paragraphs: ["Kanbo has drafted one from this week's work. Check it, change what you like, and post. Everyone following the project sees it."],
    cta: link ? { label: "Review the draft", href: link } : undefined,
    footnotes: ["Change project update emails in Kanbo › Settings › Notifications."],
  });
  return { subject: oneLine(heading, 180), html: mail.html, text: mail.text };
}

/* ---------- a posted update (0054) ---------- */

const STATUS_WORDS: Record<string, string> = { on_track: "On track", at_risk: "At risk", off_track: "Off track", on_hold: "On hold" };
/** "On track" for a status key ("" for anything else). */
export const statusWord = (s: string | null | undefined): string => STATUS_WORDS[String(s)] ?? "";

/** What a posted update says in a notice: who, which project, its call, and (for the people its Ask names) the Ask. */
export interface PostedUpdate { actorName: string; projectName: string; projectId: string; status: string; summary: string; ask?: string | null }

/** One line in a bundle: "Sana Rao posted an update" · "Sana Rao asked you something". */
export const postedLine = (u: Pick<PostedUpdate, "actorName">, asked: boolean): string =>
  `${who(u.actorName)} ${asked ? "asked you something in an update" : "posted an update"}`;

/** The push, for the people an Ask names (FYI readers get email only, or the digest). */
export function updatePostedPush(u: PostedUpdate): PushMessage {
  return {
    title: `${who(u.actorName)} asked you something`,
    body: oneLine(u.ask ? `${projectName(u.projectName)}: ${u.ask}` : `In the ${projectName(u.projectName)} update.`, 160),
    url: `/p/${encodeURIComponent(u.projectId)}/updates`,
    tag: `update-posted-${u.projectId}`,
    kind: "update",
  };
}

/** The email: the call, the words, and (asked) what it asks of you. */
export function updatePostedEmail(u: PostedUpdate, asked: boolean, link: string): { subject: string; html: string; text: string } {
  const word = statusWord(u.status);
  const heading = asked
    ? `${who(u.actorName)} asked you something in the ${projectName(u.projectName)} update`
    : `${who(u.actorName)} posted an update on ${projectName(u.projectName)}${word ? `: ${word}` : ""}`;
  const quote = (t: string) => `<p style="margin:0;padding:8px 12px;border-left:3px solid #e4e4e7;color:#3f3f46">${esc(oneLine(t, 600))}</p>`;
  const mail = renderEmail({
    heading,
    paragraphs: [
      ...(asked && u.ask ? [`<strong>The ask</strong>`, quote(u.ask)] : []),
      quote(u.summary),
      asked ? "Reply on the update, and everyone following the project sees it." : "Reply or react on the update in Kanbo.",
    ],
    cta: link ? { label: asked ? "Reply" : "Open the update", href: link } : undefined,
    footnotes: ["Change project update emails in Kanbo › Settings › Notifications."],
  });
  return { subject: oneLine(heading, 180), html: mail.html, text: mail.text };
}

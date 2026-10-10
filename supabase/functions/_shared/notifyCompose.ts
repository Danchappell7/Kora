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
//   • the morning due list and the daily digest (daily-reminders).
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
  const path = taskId ? `/?task=${encodeURIComponent(taskId)}` : "/inbox";
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

const DIGEST_ORDER = ["mention", "doc_mention", "approval", "assigned", "comment", "kudos", "integration"];
const digestRank = (k: string) => { const i = DIGEST_ORDER.indexOf(k); return i < 0 ? 99 : i; };

/** Unread items → threads (one per task; a doc mention or notice stands alone), mentions first, then newest. */
export function digestThreads(items: readonly DigestItem[]): DigestThread[] {
  const groups = new Map<string, DigestItem[]>();
  for (const it of items) {
    if (SELF.has(it.kind)) continue;
    const key = it.task_id ? `t:${it.task_id}` : `i:${it.id}`;
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
      else if (kind === "integration") lines.push(oneLine(xs[0].detail || "An integration needs you", 120));
      else lines.push(plural(xs.length, "update"));
    }
    out.push({
      taskId: list[0].task_id, title: oneLine(list[0].task_title, 140) || (list[0].kind === "integration" ? "Integrations" : "A task"),
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

/** The digest email: unread updates by thread, then what's due. null when there's nothing to say. */
export function digestEmail(threads: readonly DigestThread[], due: readonly DueTask[], today: string, appUrl: string, opts: { firstName?: string; digestTime?: string } = {}):
  { subject: string; html: string; text: string } | null {
  if (!threads.length && !due.length) return null;
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
  const bits = [threads.length ? plural(updates, "update") : "", due.length ? `${plural(due.length, "task")} due` : ""].filter(Boolean);
  const mail = renderEmail({
    heading: opts.firstName ? `Your Kanbo digest, ${oneLine(opts.firstName, 40)}` : "Your Kanbo digest",
    paragraphs: parts,
    cta: appUrl ? { label: "Open your Inbox", href: `${appUrl}/inbox` } : undefined,
    footnotes: [`You get one email a day${opts.digestTime ? ` at ${esc(opts.digestTime)}` : ""}, plus a push for mentions and approvals. Change this in Kanbo › Settings › Notifications.`],
  });
  return { subject: `Your Kanbo digest: ${bits.join(", ")}`, html: mail.html, text: mail.text };
}

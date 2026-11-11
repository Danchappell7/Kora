// ============================================================
// KANBO — Slack app: every message, modal, unfurl and Home tab it shows. [0049]
//
// Everything that came from a person (task titles, project and people's
// names, Slack display names, workspace names) is escaped for mrkdwn
// (& < >) or sent as plain_text, so nothing can @channel, mention anyone,
// or hide a link behind other words; link labels also lose "|" (it would
// end the label). Every mrkdwn text object is sent verbatim (verbatim:
// true): Slack doesn't turn a bare URL, a #channel or an @name someone typed
// into a link or a mention (by default it would, inside a Kanbo card the
// whole channel may see). Links are only ever the <url|label> links built
// here, to Kanbo's own address (APP_URL) or a Slack permalink, and those
// still work verbatim. Slack's limits are enforced here: plain_text in buttons
// and options ≤ 75, option values ≤ 150, section text ≤ 3,000, modal title
// ≤ 24, private_metadata ≤ 3,000, ≤ 100 options, ≤ 50 blocks (100 in a view).
//
// Action ids the router reads back (slackAppHandler.ts):
//   open_task        a link button (Slack still sends a block_action: ignored)
//   link_account     a link button (ignored)
//   assign_me        value = task id
//   complete_task    value = task id
//   undo_create      value = task id
// Modal: callback_id create_kanbo_task; blocks title / description /
//   project (external_select) / assignee (external_select) / due
//   (datepicker) / priority (static_select).
//
// Pure: vitest runs it (slackAppBlocks.test.ts).
// ============================================================
import { clip, escapeMrkdwn, fmtDay, oneLine, safeLinkUrl } from "./slack.ts";

/* ------------------------------------------------------------ ids */

export const ACTIONS = {
  open: "open_task",
  link: "link_account",
  assignMe: "assign_me",
  complete: "complete_task",
  undo: "undo_create",
} as const;
export const MODAL_CALLBACK = "create_kanbo_task";
export const SHORTCUT_CALLBACK = "create_kanbo_task";
export const BLOCK = { title: "title", description: "description", project: "project", assignee: "assignee", due: "due", priority: "priority" } as const;
/** the Personal list (projects.id convention, validate.ts PERSONAL_PROJECT_ID) */
export const PERSONAL = "p-personal";
/** how long Undo is offered after /kanbo makes a task (the database allows 30 s more) */
export const UNDO_MS = 2 * 60_000;

export const LIMITS = { button: 75, option: 75, value: 150, section: 3000, modalTitle: 24, metadata: 3000, options: 100, title: 200, description: 3000 } as const;

/* ------------------------------------------------------------ text helpers */

type Json = Record<string, unknown>;
const plain = (text: string, max: number = LIMITS.option, emoji = true) => ({ type: "plain_text", text: oneLine(text, max) || " ", emoji });
/** verbatim: Slack shows the text as written (no auto-linked URLs, #channels or @names); our own <url|label> links still work */
const mrkdwn = (text: string) => ({ type: "mrkdwn", text: clip(text, LIMITS.section), verbatim: true });
const section = (text: string, extra: Json = {}) => ({ type: "section", text: mrkdwn(text), ...extra });
const context = (...lines: string[]) => ({ type: "context", elements: lines.filter(Boolean).map((t) => mrkdwn(t)) });
const esc = (s: string | null | undefined, max = 200) => escapeMrkdwn(oneLine(String(s ?? ""), max));

/** <url|label> with the label escaped (and no "|"); just the label without a usable URL. */
export function link(url: string | null | undefined, label: string, max = 150): string {
  const safe = safeLinkUrl(url);
  const text = esc(label, max).replace(/\|/g, "/") || "Untitled task";
  return safe ? `<${safe}|${text}>` : text;
}

/** A button: plain text ≤ 75; a URL button when `url`. */
function button(text: string, actionId: string, opts: { value?: string; url?: string | null; style?: "primary" | "danger"; label?: string } = {}): Json {
  const b: Json = { type: "button", text: plain(text, LIMITS.button), action_id: actionId };
  if (opts.value !== undefined) b.value = String(opts.value).slice(0, 2000);
  const u = opts.url ? safeLinkUrl(opts.url) : null;
  if (u) b.url = opts.url;
  if (opts.style) b.style = opts.style;
  if (opts.label) b.accessibility_label = oneLine(opts.label, 75);
  return b;
}

/** "Fri 2 Oct" or "Fri 2 Oct, 15:00" (as written, no time zone maths). */
export function dueLabel(date?: string | null, time?: string | null): string | null {
  if (!date) return null;
  return time && /^\d{2}:\d{2}/.test(time) ? `${fmtDay(date)}, ${time.slice(0, 5)}` : fmtDay(date);
}

const STATUS_LABEL: Record<string, string> = { todo: "To do", progress: "In progress", review: "In review", blocked: "Blocked", done: "Done" };
const PRIORITY_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };
export const statusLabel = (s?: string | null) => STATUS_LABEL[String(s ?? "")] ?? "To do";
export const priorityLabel = (p?: string | null) => PRIORITY_LABEL[String(p ?? "")] ?? "Medium";

/** The task's address in Kanbo, or null without a usable app address. */
export function taskUrl(appUrl: string, id: string): string | null {
  const base = String(appUrl ?? "").replace(/\/+$/, "");
  return /^https?:\/\//.test(base) && /^[0-9a-f-]{36}$/i.test(id) ? `${base}/?task=${id}` : null;
}
export function projectUrl(appUrl: string, id: string): string | null {
  const base = String(appUrl ?? "").replace(/\/+$/, "");
  return /^https?:\/\//.test(base) && /^[0-9a-f-]{36}$/i.test(id) ? `${base}/p/${id}` : null;
}

/* ------------------------------------------------------------ the task card */

export interface TaskCard {
  id: string;
  title: string;
  status?: string | null;
  priority?: string | null;
  projectName?: string | null;
  projectEmoji?: string | null;
  /** a Personal-list task (only its maker sees it) */
  personal?: boolean;
  dueDate?: string | null;
  dueTime?: string | null;
  assigneeName?: string | null;
  assignedToMe?: boolean;
}

/** "📁 Launch · 📅 Fri 2 Oct, 15:00 · 👤 Sana Rao" */
export function cardFacts(t: TaskCard): string {
  const bits: string[] = [];
  bits.push(t.personal ? "📥 Your Personal list" : `${esc(t.projectEmoji || "📁", 8)} ${esc(t.projectName || "No project", 80)}`);
  const due = dueLabel(t.dueDate, t.dueTime);
  bits.push(due ? `📅 Due ${esc(due)}` : "📅 No due date");
  // only the person themselves reads a card: "You" (link previews, read by the channel, name them: taskUnfurl)
  bits.push(t.assignedToMe ? "👤 You" : t.assigneeName ? `👤 ${esc(t.assigneeName, 80)}` : "👤 Unassigned");
  if (t.priority && t.priority !== "medium") bits.push(`⚑ ${priorityLabel(t.priority)} priority`);
  return bits.join("  ·  ");
}

export interface SlackMessage {
  response_type?: "ephemeral" | "in_channel";
  replace_original?: boolean;
  delete_original?: boolean;
  text: string;
  blocks?: Json[];
}

/** The ephemeral confirmation after /kanbo or the shortcut made a task. */
export function createdMessage(t: TaskCard, opts: { appUrl: string; canUndo: boolean; notes?: string[]; replace?: boolean }): SlackMessage {
  const url = taskUrl(opts.appUrl, t.id);
  const actions: Json[] = [button("Open in Kanbo", ACTIONS.open, { url, style: "primary", value: t.id })];
  if (!t.assignedToMe && !t.personal) actions.push(button("Assign to me", ACTIONS.assignMe, { value: t.id }));
  if (opts.canUndo) actions.push(button("Undo", ACTIONS.undo, { value: t.id, style: "danger", label: `Undo: delete ${t.title}` }));
  const blocks: Json[] = [
    section(`:white_check_mark: Added to Kanbo: *${link(url, t.title)}*`),
    context(cardFacts(t)),
  ];
  const notes = (opts.notes ?? []).filter(Boolean);
  // notes quote what people typed (a #project that wasn't found): escaped like everything else
  if (notes.length) blocks.push(context(...notes.slice(0, 3).map((n) => `_${esc(n, 400)}_`)));
  blocks.push({ type: "actions", block_id: "task_actions", elements: actions });
  return {
    response_type: "ephemeral",
    ...(opts.replace ? { replace_original: true } : {}),
    text: `Added to Kanbo: ${esc(t.title)}`,
    blocks,
  };
}

/** After Assign to me / Complete on the confirmation: the card again, as it is now (no Undo). */
export function updatedMessage(t: TaskCard, opts: { appUrl: string; note: string }): SlackMessage {
  const url = taskUrl(opts.appUrl, t.id);
  const actions: Json[] = [button("Open in Kanbo", ACTIONS.open, { url, style: "primary", value: t.id })];
  if (!t.assignedToMe && !t.personal && t.status !== "done") actions.push(button("Assign to me", ACTIONS.assignMe, { value: t.id }));
  return {
    response_type: "ephemeral",
    replace_original: true,
    text: `${opts.note} ${esc(t.title)}`,
    blocks: [
      section(`${t.status === "done" ? ":white_check_mark:" : ":bust_in_silhouette:"} ${esc(opts.note, 120)} *${link(url, t.title)}*`),
      context(cardFacts(t)),
      { type: "actions", block_id: "task_actions", elements: actions },
    ],
  };
}

/** After Undo: the card is replaced with this. */
export function undoneMessage(title: string): SlackMessage {
  return {
    response_type: "ephemeral",
    replace_original: true,
    text: `Removed “${esc(title)}” from Kanbo.`,
    blocks: [section(`:wastebasket: Removed “${esc(title)}” from Kanbo. It's in the recycle bin for 30 days if you change your mind.`)],
  };
}

/** A one-line ephemeral answer (problems, refusals). */
export function noticeMessage(text: string, opts: { replace?: boolean; emoji?: string } = {}): SlackMessage {
  return {
    response_type: "ephemeral",
    ...(opts.replace ? { replace_original: true } : {}),
    text: esc(text, 300),
    blocks: [section(`${opts.emoji ?? ":information_source:"} ${esc(text, 1000)}`)],
  };
}

/* ------------------------------------------------------------ linking */

/** Shown to someone whose Slack account isn't linked yet. */
export function linkPromptMessage(opts: { url: string; minutes?: number }): SlackMessage {
  const mins = opts.minutes ?? 15;
  return {
    response_type: "ephemeral",
    text: "Link your Kanbo account to use Kanbo in Slack.",
    blocks: [
      section(":wave: *Link your Kanbo account first.* Then `/kanbo` adds tasks to Kanbo as you, with your access, and Kanbo links can show a preview here."),
      { type: "actions", block_id: "link", elements: [button("Link your Kanbo account", ACTIONS.link, { url: opts.url, style: "primary" })] },
      context(`This link is just for you. It works once, for ${mins} minutes.`),
    ],
  };
}

/* ------------------------------------------------------------ help */

export function helpMessage(): SlackMessage {
  return {
    response_type: "ephemeral",
    text: "How to use /kanbo",
    blocks: [
      section("*Add a task to Kanbo from anywhere in Slack*\nType `/kanbo` and the task in your own words. Kanbo reads dates, times and a few symbols, just like Quick capture:"),
      section([
        "• `/kanbo Send the brief fri 3pm` — due Friday at 15:00",
        "• `/kanbo Review the deck #launch @sana tomorrow` — in the Launch project, assigned to Sana",
        "• `/kanbo Book the venue next week !high ~2h` — high priority, 2-hour estimate",
        "• `/kanbo Draft the update by 3 Nov from mon` — due 3 November, starts Monday",
      ].join("\n")),
      section([
        "*#project* picks a project in your team's Kanbo workspace (part of its name is enough).",
        "*@person* assigns it to a teammate (needs a #project). Without a project the task goes to your Personal list.",
        "*!high*, *!urgent*, *!low* or *p1*–*p4* set the priority; *~30m* or *~2h* the estimate.",
      ].join("\n")),
      section("`/kanbo` on its own opens a form. On any message, choose *⋯ More actions › Create a Kanbo task* to turn it into a task with a link back to the message."),
      context("Kanbo links you paste show a preview to people in the channel when you've linked your account."),
    ],
  };
}

/* ------------------------------------------------------------ the create modal */

export interface ModalMeta {
  /** channel the message is in */
  c?: string;
  /** the message's ts */
  ts?: string;
  /** thread parent ts, when the message is a reply */
  tt?: string;
  /** the message's permalink, when Slack gave it straight away */
  pl?: string;
  /** response_url (to confirm in the channel afterwards) */
  ru?: string;
  /** team domain (to build a permalink if Slack didn't give one) */
  d?: string;
}

export function encodeMeta(m: ModalMeta): string {
  const s = JSON.stringify(m);
  return s.length <= LIMITS.metadata ? s : JSON.stringify({ ...m, pl: undefined, ru: undefined });
}
export function decodeMeta(s: unknown): ModalMeta {
  if (typeof s !== "string" || !s) return {};
  try {
    const v = JSON.parse(s);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const str = (x: unknown) => (typeof x === "string" && x.length <= 600 ? x : undefined);
    return { c: str(v.c), ts: str(v.ts), tt: str(v.tt), pl: str(v.pl), ru: str(v.ru), d: str(v.d) };
  } catch { return {}; }
}

export interface Option { text: string; value: string }
export const option = (text: string, value: string): Json => ({ text: plain(text, LIMITS.option), value: String(value).slice(0, LIMITS.value) });
export const PRIORITY_OPTIONS: Option[] = [
  { text: "Low", value: "low" }, { text: "Medium", value: "medium" }, { text: "High", value: "high" }, { text: "Urgent", value: "urgent" },
];
export const personalOption = (): Option => ({ text: "📥 Personal (only you)", value: PERSONAL });

/** The "Create a Kanbo task" modal (message shortcut, or /kanbo on its own). */
export function createModal(opts: {
  title?: string;
  description?: string;
  meta?: ModalMeta;
  /** the Kanbo workspace tasks go to (shown under the title), or null when none is set */
  workspaceName?: string | null;
  initialProject?: Option | null;
  initialAssignee?: Option | null;
  initialDue?: string | null;
}): Json {
  const blocks: Json[] = [];
  blocks.push(context(opts.workspaceName
    ? `Adds the task to *${esc(opts.workspaceName, 80)}* in Kanbo, as you.`
    : "No Kanbo workspace is connected to this Slack workspace yet, so the task goes to your Personal list."));
  blocks.push({
    type: "input", block_id: BLOCK.title, label: plain("Title"),
    element: { type: "plain_text_input", action_id: BLOCK.title, max_length: LIMITS.title, ...(opts.title ? { initial_value: clip(opts.title, LIMITS.title) } : {}),
      placeholder: plain("What needs doing?") },
  });
  blocks.push({
    type: "input", block_id: BLOCK.description, optional: true, label: plain("Description"),
    element: { type: "plain_text_input", action_id: BLOCK.description, multiline: true, max_length: LIMITS.description,
      ...(opts.description ? { initial_value: clip(opts.description, LIMITS.description) } : {}) },
  });
  blocks.push({
    type: "input", block_id: BLOCK.project, label: plain("Project"),
    hint: plain("Personal tasks are only for you.", 150),
    element: { type: "external_select", action_id: BLOCK.project, min_query_length: 0, placeholder: plain("Choose a project"),
      initial_option: option((opts.initialProject ?? personalOption()).text, (opts.initialProject ?? personalOption()).value) },
  });
  blocks.push({
    type: "input", block_id: BLOCK.assignee, optional: true, label: plain("Assignee"),
    element: { type: "external_select", action_id: BLOCK.assignee, min_query_length: 0, placeholder: plain("Unassigned"),
      ...(opts.initialAssignee ? { initial_option: option(opts.initialAssignee.text, opts.initialAssignee.value) } : {}) },
  });
  blocks.push({
    type: "input", block_id: BLOCK.due, optional: true, label: plain("Due date"),
    element: { type: "datepicker", action_id: BLOCK.due, ...(opts.initialDue && /^\d{4}-\d{2}-\d{2}$/.test(opts.initialDue) ? { initial_date: opts.initialDue } : {}),
      placeholder: plain("No due date") },
  });
  blocks.push({
    type: "input", block_id: BLOCK.priority, optional: true, label: plain("Priority"),
    element: { type: "static_select", action_id: BLOCK.priority, options: PRIORITY_OPTIONS.map((o) => option(o.text, o.value)),
      initial_option: option("Medium", "medium") },
  });
  return {
    type: "modal",
    callback_id: MODAL_CALLBACK,
    title: plain("Create a Kanbo task", LIMITS.modalTitle),
    submit: plain("Create task", LIMITS.modalTitle),
    close: plain("Cancel", LIMITS.modalTitle),
    private_metadata: encodeMeta(opts.meta ?? {}),
    blocks,
  };
}

/** What the modal's fields say on submit (view.state.values). */
export interface ModalValues { title: string; description: string; projectId: string | null; assigneeId: string | null; dueDate: string | null; priority: string | null }
export function readModal(view: unknown): ModalValues {
  const values = ((view as { state?: { values?: Record<string, Record<string, Record<string, unknown>>> } })?.state?.values) ?? {};
  const field = (block: string) => values?.[block]?.[block] ?? {};
  const sel = (block: string) => {
    const o = field(block).selected_option as { value?: unknown } | null | undefined;
    return typeof o?.value === "string" ? o.value : null;
  };
  const text = (block: string) => (typeof field(block).value === "string" ? String(field(block).value) : "");
  const date = field(BLOCK.due).selected_date;
  return {
    title: text(BLOCK.title).trim(),
    description: text(BLOCK.description),
    projectId: sel(BLOCK.project),
    assigneeId: sel(BLOCK.assignee),
    dueDate: typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    priority: sel(BLOCK.priority),
  };
}

/** options for an external_select (≤ 100, plain text). */
export function optionsPayload(items: Option[]): Json {
  return { options: items.slice(0, LIMITS.options).map((o) => option(o.text, o.value)) };
}

/** A message's first line as a task title (≤ 200 characters). */
export function titleFromMessage(text: string): string {
  const first = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return clip(oneLine(first, 1000), LIMITS.title);
}

/** The description for a task made from a message: its text, then where it came from. */
export function descriptionFromMessage(text: string, permalink: string | null): string {
  const body = clip(String(text ?? "").replace(/\r\n?/g, "\n").trim(), LIMITS.description - 120);
  return permalink ? `${body}${body ? "\n\n" : ""}From Slack: ${permalink}` : body;
}

/* ------------------------------------------------------------ unfurls */

/** A name the whole channel may read: a member with no name shows as their email in Kanbo, never in a preview. */
export function publicName(name: string | null | undefined): string | null {
  const n = String(name ?? "").trim();
  if (!n) return null;
  const at = n.indexOf("@");
  return at > 0 && /^[^\s@<>|]+@[^\s@<>|]+\.[^\s@<>|]+$/.test(n) ? n.slice(0, at) : n;
}

/**
 * A Kanbo task link's preview (only for people who can see it; actions run as whoever clicks). The whole
 * channel reads it, so it's written for them, not the sharer: the assignee by name, never "You".
 */
export function taskUnfurl(t: TaskCard, appUrl: string): Json {
  const url = taskUrl(appUrl, t.id);
  const who = publicName(t.assigneeName);
  const fields = [
    mrkdwn(`*Project*\n${t.personal ? "Personal" : `${esc(t.projectEmoji || "📁", 8)} ${esc(t.projectName || "No project", 80)}`}`),
    mrkdwn(`*Status*\n${statusLabel(t.status)}`),
    mrkdwn(`*Assignee*\n${who ? esc(who, 80) : "Unassigned"}`),
    mrkdwn(`*Due*\n${esc(dueLabel(t.dueDate, t.dueTime) ?? "No due date")}`),
  ];
  const actions: Json[] = [];
  if (t.status !== "done") actions.push(button("Complete", ACTIONS.complete, { value: t.id, style: "primary", label: `Mark ${t.title} done` }));
  actions.push(button("Open in Kanbo", ACTIONS.open, { url, value: t.id }));
  return {
    blocks: [
      { type: "section", text: mrkdwn(`${t.status === "done" ? ":white_check_mark: " : ""}*${link(url, t.title)}*`), fields },
      { type: "actions", block_id: "task_actions", elements: actions },
      context("Kanbo"),
    ],
  };
}

/** A Kanbo project link's preview. */
export function projectUnfurl(p: { id: string; name: string; emoji?: string | null; openCount: number; doneCount: number; description?: string | null }, appUrl: string): Json {
  const url = projectUrl(appUrl, p.id);
  const desc = p.description ? `\n${esc(p.description, 280)}` : "";
  return {
    blocks: [
      section(`${esc(p.emoji || "📁", 8)} *${link(url, p.name)}*${desc}`),
      context(`${p.openCount} open ${p.openCount === 1 ? "task" : "tasks"} · ${p.doneCount} done · Kanbo`),
    ],
  };
}

/**
 * The preview for a link to a Members only or Private project, or to a task in one (0058, Project access on).
 * The whole channel reads a preview, and a Slack channel is the whole team's: it names nothing (no title,
 * status, assignee or counts), only where to open it. Kanbo shows the rest to whoever may see it.
 */
export function privateUnfurl(kind: "task" | "project", id: string, appUrl: string): Json {
  const url = kind === "task" ? taskUrl(appUrl, id) : projectUrl(appUrl, id);
  return {
    blocks: [
      section(kind === "task" ? ":lock: *A task in a private Kanbo project*" : ":lock: *A private Kanbo project*"),
      { type: "actions", block_id: "private_actions", elements: [button("Open in Kanbo", ACTIONS.open, { url, value: id })] },
      context("Only the people on it can see it in Kanbo."),
    ],
  };
}

/* ------------------------------------------------------------ App Home */

export interface HomeTask extends TaskCard {
  overdue?: boolean;
  /** they can see it but not change it (0058: a Members only or Private project they view or comment on): no Complete */
  readOnly?: boolean;
}

export function homeView(opts: { linked: boolean; tasks?: HomeTask[]; appUrl: string; workspaceName?: string | null; today?: string; more?: number }): Json {
  const blocks: Json[] = [{ type: "header", text: plain("Kanbo", 150) }];
  if (!opts.linked) {
    blocks.push(section("Link your Kanbo account to see your tasks here and add new ones with `/kanbo`.\nType `/kanbo` in any channel and Kanbo will send you a link that only you can see."));
    blocks.push(context("Kanbo only acts for people who've linked their account, and always with their own access."));
    return { type: "home", blocks };
  }
  const tasks = opts.tasks ?? [];
  blocks.push(section(`*Your tasks today*${opts.today ? ` · ${esc(fmtDay(opts.today))}` : ""}`));
  if (!tasks.length) {
    blocks.push(section("Nothing due today or overdue. :tada:"));
  } else {
    for (const t of tasks.slice(0, 20)) {
      const url = taskUrl(opts.appUrl, t.id);
      const due = dueLabel(t.dueDate, t.dueTime);
      const where = t.personal ? "Personal" : `${esc(t.projectEmoji || "📁", 8)} ${esc(t.projectName || "No project", 60)}`;
      blocks.push({
        type: "section",
        text: mrkdwn(`*${link(url, t.title)}*\n${where}${due ? ` · ${t.overdue ? ":warning: was due " : "due "}${esc(due)}` : ""}`),
        ...(t.readOnly ? {} : { accessory: button("Complete", ACTIONS.complete, { value: t.id, label: `Mark ${t.title} done` }) }),
      });
    }
    if ((opts.more ?? 0) > 0) blocks.push(context(`And ${opts.more} more in Kanbo.`));
  }
  blocks.push({ type: "divider" });
  blocks.push(context(`Add a task from any channel: \`/kanbo Send the brief fri 3pm #project\`${opts.workspaceName ? ` · Connected to ${esc(opts.workspaceName, 80)}` : ""} · ${link(opts.appUrl, "Open Kanbo")}`));
  return { type: "home", blocks: blocks.slice(0, 100) };
}

// ============================================================
// KANBO — the Slack app's requests, end to end (slack-app function). [0049]
//
// One URL for everything Slack sends (the manifest points the slash
// command, interactivity, options loads and events at it):
//   /kanbo <text>            slash command (form: command=…)
//   buttons, modal submits   interactivity (form: payload={…})
//     block_actions          assign_me · complete_task · undo_create (open/link are URL buttons: ignored)
//     message_action         "Create a Kanbo task" on a message → the modal
//     view_submission        the modal → a task
//     block_suggestion       the modal's project / assignee pickers
//   events (JSON)            url_verification · link_shared (unfurls) · app_home_opened
//
// In order, for every request:
//   1. the Slack signature (slackAppVerify.ts) over the raw body: wrong,
//      missing or older than 5 minutes → 401 before anything is read; the
//      same signature twice (a replay inside those 5 minutes) is dropped;
//   2. the Slack person must be LINKED to a Kanbo account (slack_user_links,
//      made only by claim_slack_link) and able to act (not suspended); an
//      unlinked person only ever gets "Link your Kanbo account" (a one-time,
//      15-minute link only they can see);
//   3. a rate limit per Slack person (and per Slack workspace);
//   4. the work, as that person, with RLS (slackAppData.ts), pinned to the
//      Slack workspace's chosen Kanbo workspace (or their own Personal list).
// Slack wants an answer within 3 seconds: the work races a timer (2.2 s);
// if it isn't done, Slack gets an empty 200 and the answer follows through
// the response_url (EdgeRuntime.waitUntil keeps the function alive). Events
// are always answered at once and de-duplicated by event id (Slack resends
// when it thinks we missed one: X-Slack-Retry-Num).
//
// Everything shown in Slack is built in slackAppBlocks.ts (escaped). The bot
// token and signing secret never reach a log line, a reply or the database.
//
// Pure (database, Slack and the clock are passed in): vitest drives it with
// a stubbed Slack Web API (slackAppHandler.test.ts); the PGlite replay runs
// it against the real migrations (scratchpad/pgtest-slack).
// ============================================================
import { safeErrorNote } from "./slack.ts";
import { isSlackPermalink } from "./slackPermalink.ts";
import { verifySlackRequest } from "./slackAppVerify.ts";
import type { SlackApi, SlackApiAnswer } from "./slackAppApi.ts";
import {
  ACTIONS, createdMessage, createModal, decodeMeta, descriptionFromMessage, helpMessage, homeView, linkPromptMessage, MODAL_CALLBACK,
  noticeMessage, optionsPayload, personalOption, PERSONAL, projectUnfurl, readModal, SHORTCUT_CALLBACK, taskUnfurl, titleFromMessage,
  undoneMessage, updatedMessage, BLOCK, type ModalMeta, type SlackMessage, type TaskCard,
} from "./slackAppBlocks.ts";
import { decodeSlackText, parseSlackTask, readableSlackText, resolveMention, safeTz, slashIntent, zonedToday, type Member } from "./slackAppParse.ts";
import {
  assignToMe, completeTask, createLinkRequest, createTask, findLink, firstTimeSeen, firstTimeSigned, homeTasks, isMissingSchema, isSlackId, loadCard,
  loadProjectCard, memberOptions, projectOptions, rateHit, SlackWriteError, taskScope, teamInfo, undoCreate, workspaceContext,
  type SlackDb, type SlackLink, type TeamInfo,
} from "./slackAppData.ts";
import { toLocalISO } from "./nlp.ts";
import type { ApiTask } from "./api/serialise.ts";

export interface SlackAppDeps {
  db: SlackDb;
  slack: SlackApi;
  /** SLACK_SIGNING_SECRET (empty → every request refused) */
  signingSecret: string;
  /** the app's address (APP_URL): links into Kanbo, and /link/slack */
  appUrl: string;
  /** the public API's base (handlers build Location headers from it; never shown) */
  apiBase: string;
  /** the zone "today" is in when Slack doesn't say (Europe/London) */
  tz: string;
  now: () => number;
  /** keeps the function alive for work finished after the answer (EdgeRuntime.waitUntil) */
  waitUntil: (p: Promise<unknown>) => void;
  log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
  /** 32 random bytes, base64url: a one-time link token */
  newToken: () => string;
  /** how long to wait for the work before answering Slack and finishing in the background (ms) */
  ackAfterMs?: number;
}

export const MAX_BODY = 512 * 1024;
export const LINK_MINUTES = 15;
/** per Slack person: commands, buttons and submissions · options loads · events */
export const RATE = { actions: { windowSec: 60, max: 20 }, options: { windowSec: 60, max: 120 }, events: { windowSec: 60, max: 60 }, team: { windowSec: 60, max: 300 } } as const;

type Json = Record<string, unknown>;
const ack = () => new Response(null, { status: 200 });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const plainText = (status: number, text: string) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

export const COPY = {
  notSetUp: "Kanbo's Slack app isn't fully set up yet. Ask whoever installed it to finish the steps in Kanbo's Slack guide.",
  cantAct: "Your Kanbo account can't add or change things right now. If that's unexpected, ask your Kanbo admin.",
  busy: (s: number) => `That's a lot of Kanbo in a short time. Try again in ${Math.max(1, s)} seconds.`,
  failed: "Kanbo couldn't do that just now. Try again in a moment.",
  noTitle: "Add a few words for the task, e.g. `/kanbo Send the brief fri 3pm`.",
  elsewhere: "That task is in another Kanbo workspace, so it can't be changed from this Slack workspace.",
  gone: "Kanbo couldn't find that task, or you can't see it any more.",
  undoLate: "It's too late to undo that here. You can delete the task in Kanbo instead.",
  modalSlow: "That took too long to open. Try again.",
};

/** Wait for `p`, but at most `ms`. Never rejects for the timer's sake. */
export async function within<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ done: false }>((r) => { timer = setTimeout(() => r({ done: false }), ms); });
  try {
    return await Promise.race([p.then((value) => ({ done: true as const, value })), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const sha256Hex = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");

/* ============================================================ entry */

export async function handleSlackRequest(req: Request, deps: SlackAppDeps): Promise<Response> {
  if (req.method !== "POST") return plainText(405, "Method not allowed");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return plainText(413, "Too large");
  let raw: string;
  try { raw = await req.text(); } catch { return plainText(400, "Unreadable request"); }
  if (raw.length > MAX_BODY) return plainText(413, "Too large");

  const v = await verifySlackRequest({
    secret: deps.signingSecret,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    rawBody: raw,
    now: deps.now(),
  });
  if (!v.ok) {
    deps.log("warn", "slack-app: refused a request that isn't signed by Slack", { reason: v.reason });
    return plainText(v.reason === "no_secret" ? 503 : 401, "Invalid request");
  }
  // the same signed request twice is a replay (Slack signs every retry afresh): answered, never run again
  if (!(await firstTimeSigned(deps.db.service, req.headers.get("x-slack-signature") ?? ""))) {
    deps.log("warn", "slack-app: dropped a replayed request");
    return ack();
  }

  try {
    const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
    if (ctype.includes("application/json")) {
      let body: Json;
      try { body = obj(JSON.parse(raw)); } catch { return plainText(400, "Unreadable request"); }
      return await onEvent(body, req.headers, deps);
    }
    const form = new URLSearchParams(raw);
    if (form.get("ssl_check")) return ack();
    if (form.has("command")) return await onCommand(form, deps);
    const payload = form.get("payload");
    if (payload) {
      let p: Json;
      try { p = obj(JSON.parse(payload)); } catch { return plainText(400, "Unreadable request"); }
      return await onPayload(p, deps);
    }
    return plainText(400, "Unrecognised request");
  } catch (e) {
    deps.log("error", "slack-app: request failed", { error: safeErrorNote(e) });
    // Slack shows a failed request as an ugly error: answer quietly
    return ack();
  }
}

/* ============================================================ shared steps */

type Gate =
  | { ok: true; link: SlackLink; team: TeamInfo }
  | { ok: false; message: SlackMessage };

/** Linked, able to act, and the Slack workspace's Kanbo workspace. An unlinked person gets a fresh link. */
async function gate(deps: SlackAppDeps, teamId: string, slackUserId: string, opts: { teamName?: string | null; offerLink?: boolean } = {}): Promise<Gate> {
  try {
    const link = await findLink(deps.db.service, teamId, slackUserId);
    if (!link) {
      if (opts.offerLink === false) return { ok: false, message: noticeMessage("Link your Kanbo account first: type /kanbo in any channel.") };
      return { ok: false, message: await offerLink(deps, teamId, slackUserId, opts.teamName ?? null) };
    }
    if (!link.canAct) return { ok: false, message: noticeMessage(COPY.cantAct, { emoji: ":no_entry:" }) };
    return { ok: true, link, team: await teamInfo(deps.db.service, teamId) };
  } catch (e) {
    if (isMissingSchema(e)) return { ok: false, message: noticeMessage(COPY.notSetUp, { emoji: ":construction:" }) };
    throw e;
  }
}

/** A one-time link to /link/slack for this Slack person (only its hash is stored). */
async function offerLink(deps: SlackAppDeps, teamId: string, slackUserId: string, teamName: string | null): Promise<SlackMessage> {
  const prof = await slackProfile(deps, slackUserId, 1500);
  const token = deps.newToken();
  await createLinkRequest(deps.db.service, {
    tokenHash: await sha256Hex(token), teamId, teamName, slackUserId,
    slackUserName: prof?.name ?? null, slackEmail: prof?.email ?? null,
  });
  const url = `${deps.appUrl.replace(/\/+$/, "")}/link/slack?t=${encodeURIComponent(token)}`;
  return linkPromptMessage({ url, minutes: LINK_MINUTES });
}

interface SlackProfile { name: string | null; realName: string | null; displayName: string | null; email: string | null; tz: string | null; bot: boolean }

/** users.info, capped at `ms` (null when Slack is slow or says no). */
async function slackProfile(deps: SlackAppDeps, slackUserId: string, ms: number): Promise<SlackProfile | null> {
  if (!isSlackId(slackUserId)) return null;
  const r = await within(deps.slack.call("users.info", { user: slackUserId }), ms);
  if (!r.done || !r.value.ok) return null;
  const u = obj(r.value.user);
  const p = obj(u.profile);
  const realName = str(p.real_name) || str(u.real_name) || null;
  const displayName = str(p.display_name) || null;
  return {
    name: (realName || displayName || str(u.name) || null)?.slice(0, 200) ?? null,
    realName, displayName,
    email: str(p.email) || null,
    tz: str(u.tz) || null,
    bot: u.is_bot === true,
  };
}

/** Limit per Slack person and per Slack workspace (fails open). A message when over. */
async function limited(deps: SlackAppDeps, kind: keyof typeof RATE, teamId: string, slackUserId: string): Promise<SlackMessage | null> {
  const r = RATE[kind];
  const [u, t] = await Promise.all([
    rateHit(deps.db.service, `kanbo:api:slack:${kind}:${teamId}:${slackUserId}`, r.windowSec, r.max),
    rateHit(deps.db.service, `kanbo:api:slack:team:${teamId}`, RATE.team.windowSec, RATE.team.max),
  ]);
  if (u.allowed && t.allowed) return null;
  return noticeMessage(COPY.busy(Math.max(u.retryAfter, t.retryAfter)), { emoji: ":hourglass:" });
}

/** Answer with the work's message if it's ready in time; otherwise ack now and send it to response_url when it is. */
async function settle(deps: SlackAppDeps, work: Promise<SlackMessage | null>, responseUrl: string): Promise<Response> {
  const safe = work.catch((e): SlackMessage => {
    deps.log("error", "slack-app: work failed", { error: safeErrorNote(e) });
    return noticeMessage(COPY.failed, { emoji: ":warning:" });
  });
  const r = await within(safe, deps.ackAfterMs ?? 2200);
  if (r.done) return r.value ? json(r.value) : ack();
  deps.waitUntil(safe.then(async (m) => { if (m) await deps.slack.respond(responseUrl, m); }));
  return ack();
}

/** Run work that answers through response_url / Slack's API itself: wait a little, then finish in the background. */
async function background(deps: SlackAppDeps, work: Promise<unknown>): Promise<Response> {
  const safe = work.catch((e) => deps.log("error", "slack-app: work failed", { error: safeErrorNote(e) }));
  const r = await within(safe, deps.ackAfterMs ?? 2200);
  if (!r.done) deps.waitUntil(safe);
  return ack();
}

const todayIn = (deps: SlackAppDeps, tz?: string | null) => zonedToday(safeTz(tz, deps.tz), new Date(deps.now()));

/** An ApiTask (just written) → the card, with names from what we already know. */
function cardOf(t: ApiTask, me: string, ctx: { projects?: { id: string; name: string; emoji?: string | null }[]; members?: Member[] }): TaskCard {
  const proj = (ctx.projects ?? []).find((p) => p.id === t.projectId);
  const who = t.assigneeId ? (t.assigneeId === me ? "You" : (ctx.members ?? []).find((m) => m.id === t.assigneeId)?.name ?? "Someone") : null;
  return {
    id: t.id, title: t.title, status: t.status, priority: t.priority, projectName: proj?.name ?? null, projectEmoji: proj?.emoji ?? null,
    personal: t.workspaceId == null, dueDate: t.dueDate, dueTime: t.dueTime, assigneeName: who, assignedToMe: t.assigneeId === me,
  };
}

/* ============================================================ /kanbo */

async function onCommand(form: URLSearchParams, deps: SlackAppDeps): Promise<Response> {
  const teamId = form.get("team_id") ?? "";
  const slackUserId = form.get("user_id") ?? "";
  const responseUrl = form.get("response_url") ?? "";
  const triggerId = form.get("trigger_id") ?? "";
  if (!isSlackId(teamId) || !isSlackId(slackUserId)) return plainText(400, "Unrecognised request");
  const over = await limited(deps, "actions", teamId, slackUserId);
  if (over) return json(over);
  const intent = slashIntent(form.get("text") ?? "");
  if (intent.kind === "help") return json(helpMessage());

  const work = (async (): Promise<SlackMessage | null> => {
    const g = await gate(deps, teamId, slackUserId, { teamName: form.get("team_domain") });
    if (!g.ok) return g.message;
    if (intent.kind === "modal") return openCreateModal(deps, g, { triggerId });
    return createFromText(deps, g, slackUserId, intent.text);
  })();
  return settle(deps, work, responseUrl);
}

/** "/kanbo Send the brief fri 3pm #launch @sana !high ~2h" → a task, as the person. */
async function createFromText(deps: SlackAppDeps, g: Extract<Gate, { ok: true }>, slackUserId: string, text: string): Promise<SlackMessage> {
  const me = g.link.userId;
  const ws = g.team.workspaceId;
  const wsName = g.team.workspaceName ?? "your team's Kanbo workspace";
  const { mentions } = decodeSlackText(text);
  const [wsc, prof, people] = await Promise.all([
    ws ? workspaceContext(deps.db, me, ws) : Promise.resolve({ role: "none", projects: [], members: [] }),
    slackProfile(deps, slackUserId, 1200),
    Promise.all(mentions.slice(0, 5).map(async (m) => ({ m, p: await slackProfile(deps, m.slackUserId, 1500) }))),
  ]);
  const teamOk = !!ws && wsc.role !== "none" && wsc.role !== "guest";
  const resolved = new Map<string, string>();
  if (teamOk) {
    for (const { m, p } of people) {
      const who = resolveMention({ email: p?.email, realName: p?.realName, displayName: p?.displayName, label: m.label }, wsc.members);
      if (who) resolved.set(m.slackUserId, who.id);
    }
  }
  const parsed = parseSlackTask(text, {
    today: todayIn(deps, prof?.tz),
    projects: teamOk ? wsc.projects : [],
    members: teamOk ? wsc.members : [],
    resolved,
  });
  if (!parsed.title) return noticeMessage(COPY.noTitle, { emoji: ":pencil2:" });

  const notes: string[] = [];
  const projectId = parsed.projectId ?? PERSONAL;
  if (!ws) notes.push("This Slack workspace isn't connected to a Kanbo workspace yet, so the task is in your Personal list. An owner or admin can connect one in Kanbo › Settings › Calendar & integrations.");
  else if (wsc.role === "none") notes.push(`You're not a member of ${wsName}, so the task is in your Personal list.`);
  else if (wsc.role === "guest") notes.push(`Guests can't add tasks to ${wsName}, so the task is in your Personal list.`);
  else if (parsed.unknownProjects.length && !parsed.projectId) notes.push(`No project called “${parsed.unknownProjects[0]}” in ${wsName}, so the task is in your Personal list.`);
  if (teamOk && parsed.unknownPeople.length && !parsed.assigneeId) notes.push(`Nobody called “@${parsed.unknownPeople[0]}” in ${wsName}, so the task isn't assigned.`);

  let assigneeId = parsed.assigneeId;
  if (assigneeId && assigneeId !== me && projectId === PERSONAL) {
    return noticeMessage("Tasks in your Personal list are only for you. To give it to someone, add a #project too, e.g. `/kanbo Review the deck #launch @sana`.", { emoji: ":pushpin:" });
  }
  if (projectId === PERSONAL) assigneeId = undefined;

  try {
    const t = await createTask({ db: deps.db, appUrl: deps.appUrl, apiBase: deps.apiBase }, me, ws, {
      title: parsed.title, projectId, assigneeId, dueDate: parsed.dueDate, dueTime: parsed.dueTime, startDate: parsed.startDate,
      priority: parsed.priority, effortHours: parsed.effortHours,
    });
    return createdMessage(cardOf(t, me, wsc), { appUrl: deps.appUrl, canUndo: true, notes });
  } catch (e) {
    if (e instanceof SlackWriteError) return noticeMessage(`Kanbo couldn't add that: ${e.message}`, { emoji: ":warning:" });
    throw e;
  }
}

/** The modal, as a message shortcut or a bare /kanbo opens it (within Slack's 3-second trigger window). */
async function openCreateModal(deps: SlackAppDeps, g: Extract<Gate, { ok: true }>, opts: {
  triggerId: string; title?: string; description?: string; meta?: ModalMeta;
}): Promise<SlackMessage | null> {
  if (!opts.triggerId) return noticeMessage(COPY.modalSlow);
  const view = createModal({
    title: opts.title, description: opts.description, meta: opts.meta,
    workspaceName: g.team.workspaceId ? g.team.workspaceName : null,
    initialProject: personalOption(),
  });
  const r = await deps.slack.call("views.open", { trigger_id: opts.triggerId, view });
  if (r.ok) return null;
  deps.log("warn", "slack-app: views.open refused", { error: r.error });
  return noticeMessage(r.error === "expired_trigger_id" ? COPY.modalSlow : COPY.failed, { emoji: ":warning:" });
}

/* ============================================================ interactivity */

async function onPayload(p: Json, deps: SlackAppDeps): Promise<Response> {
  const type = str(p.type);
  const user = obj(p.user);
  const slackUserId = str(user.id);
  const teamId = str(obj(p.team).id) || str(user.team_id);
  if (!isSlackId(teamId) || !isSlackId(slackUserId)) return plainText(400, "Unrecognised request");

  switch (type) {
    case "block_actions": return onBlockActions(p, deps, teamId, slackUserId);
    case "block_suggestion": return onSuggestion(p, deps, teamId, slackUserId);
    case "message_action": return onMessageShortcut(p, deps, teamId, slackUserId);
    case "view_submission": return onViewSubmission(p, deps, teamId, slackUserId);
    default: return ack();   // view_closed, global shortcuts, anything new: nothing to do
  }
}

/** Assign to me · Complete · Undo (link buttons only open their URL). */
async function onBlockActions(p: Json, deps: SlackAppDeps, teamId: string, slackUserId: string): Promise<Response> {
  const action = obj((Array.isArray(p.actions) ? p.actions : [])[0]);
  const id = str(action.action_id);
  if (id !== ACTIONS.assignMe && id !== ACTIONS.complete && id !== ACTIONS.undo) return ack();
  const taskId = str(action.value);
  const responseUrl = str(p.response_url);
  const container = obj(p.container);
  const fromHome = str(container.type) === "view";
  const onOwnCard = str(container.type) === "message" && container.is_ephemeral === true;
  const channelId = str(obj(p.channel).id) || str(container.channel_id);

  /** tell the person: their own card is replaced; elsewhere (an unfurl) a new message only they see */
  const tell = async (m: SlackMessage) => {
    const msg: SlackMessage = onOwnCard ? m : { ...m, replace_original: false };
    if (responseUrl && await deps.slack.respond(responseUrl, msg)) return;
    if (channelId && isSlackId(channelId)) await deps.slack.call("chat.postEphemeral", { channel: channelId, user: slackUserId, text: msg.text, blocks: msg.blocks });
  };

  const work = (async () => {
    const over = await limited(deps, "actions", teamId, slackUserId);
    if (over) return tell(over);
    const g = await gate(deps, teamId, slackUserId, { teamName: str(obj(p.team).domain) || null });
    if (!g.ok) return tell(g.message);
    const me = g.link.userId;
    const scope = await taskScope(deps.db, me, taskId);
    if (!scope) return tell(noticeMessage(COPY.gone, { replace: onOwnCard }));
    if (scope.workspaceId !== null && scope.workspaceId !== g.team.workspaceId) return tell(noticeMessage(COPY.elsewhere));
    const ws = scope.workspaceId;
    const w = { db: deps.db, appUrl: deps.appUrl, apiBase: deps.apiBase };

    if (id === ACTIONS.undo) {
      const title = await undoCreate(deps.db, me, ws, taskId);
      return tell(title !== null ? undoneMessage(title) : noticeMessage(COPY.undoLate, { replace: false }));
    }
    try {
      if (id === ACTIONS.assignMe) await assignToMe(w, me, ws, taskId);
      else await completeTask(w, me, ws, taskId);
    } catch (e) {
      if (e instanceof SlackWriteError) return tell({ ...noticeMessage(e.message, { emoji: ":warning:" }), replace_original: false });
      throw e;
    }
    if (fromHome) return publishHome(deps, g, slackUserId);
    const card = await loadCard(deps.db, me, ws, taskId);
    if (!card) return;
    const note = id === ACTIONS.assignMe ? "Assigned to you:" : "Marked done:";
    return tell(onOwnCard ? updatedMessage(card, { appUrl: deps.appUrl, note }) : noticeMessage(`${note} ${card.title}`, { emoji: ":white_check_mark:" }));
  })();
  return background(deps, work);
}

/** The modal's pickers: projects (with the Personal list) and people in the Slack workspace's Kanbo workspace. */
async function onSuggestion(p: Json, deps: SlackAppDeps, teamId: string, slackUserId: string): Promise<Response> {
  const actionId = str(p.action_id);
  const q = str(p.value);
  const work = (async () => {
    const over = await limited(deps, "options", teamId, slackUserId);
    if (over) return optionsPayload([]);
    const link = await findLink(deps.db.service, teamId, slackUserId).catch(() => null);
    if (!link || !link.canAct) return optionsPayload([]);
    const team = await teamInfo(deps.db.service, teamId);
    if (actionId === BLOCK.project) return optionsPayload(await projectOptions(deps.db, link.userId, team.workspaceId, q));
    if (actionId === BLOCK.assignee) return optionsPayload(await memberOptions(deps.db, link.userId, team.workspaceId, q));
    return optionsPayload([]);
  })().catch((e) => { deps.log("error", "slack-app: options failed", { error: safeErrorNote(e) }); return optionsPayload([]); });
  const r = await within(work, 2500);
  return json(r.done ? r.value : optionsPayload([]));
}

/** "Create a Kanbo task" on a message: the modal, prefilled from the message. */
async function onMessageShortcut(p: Json, deps: SlackAppDeps, teamId: string, slackUserId: string): Promise<Response> {
  if (str(p.callback_id) !== SHORTCUT_CALLBACK) return ack();
  const responseUrl = str(p.response_url);
  const triggerId = str(p.trigger_id);
  const message = obj(p.message);
  const channelId = str(obj(p.channel).id);
  const ts = str(message.ts);
  const threadTs = str(message.thread_ts);
  const domain = str(obj(p.team).domain);

  const work = (async (): Promise<SlackMessage | null> => {
    const over = await limited(deps, "actions", teamId, slackUserId);
    if (over) return over;
    const g = await gate(deps, teamId, slackUserId, { teamName: domain || null });
    if (!g.ok) return g.message;
    // the trigger lasts 3 seconds: what Slack can't tell us in ~1 s, we do without
    const rawText = str(message.text);
    const { mentions } = decodeSlackText(rawText);
    const [permalink, names] = await Promise.all([
      messagePermalink(deps, { channelId, ts, threadTs, domain }, 1000),
      Promise.all(mentions.slice(0, 5).map(async (m) => [m.slackUserId, (await slackProfile(deps, m.slackUserId, 900))?.name ?? ""] as const)),
    ]);
    const text = readableSlackText(rawText, new Map(names.filter(([, n]) => !!n)));
    return openCreateModal(deps, g, {
      triggerId,
      title: titleFromMessage(text) || "Follow up on a Slack message",
      description: descriptionFromMessage(text, permalink),
      meta: { c: channelId || undefined, ts: ts || undefined, tt: threadTs || undefined, pl: permalink ?? undefined, ru: responseUrl || undefined, d: domain || undefined },
    });
  })();
  // a shortcut's answer body isn't shown: anything to say goes to the channel through response_url (only they see it)
  return background(deps, work.catch((e): SlackMessage => {
    deps.log("error", "slack-app: shortcut failed", { error: safeErrorNote(e) });
    return noticeMessage(COPY.failed, { emoji: ":warning:" });
  }).then(async (m) => { if (m) await deps.slack.respond(responseUrl, m); }));
}

/** chat.getPermalink (capped), else the link Slack's own permalinks follow. Null if neither is a Slack message link. */
async function messagePermalink(deps: SlackAppDeps, m: { channelId: string; ts: string; threadTs?: string; domain?: string }, ms: number): Promise<string | null> {
  if (!isSlackId(m.channelId) || !/^\d{1,12}\.\d{1,8}$/.test(m.ts)) return null;
  const r = await within(deps.slack.call("chat.getPermalink", { channel: m.channelId, message_ts: m.ts }), ms);
  if (r.done && r.value.ok && isSlackPermalink(r.value.permalink)) return r.value.permalink as string;
  if (!m.domain || !/^[a-z0-9-]{1,63}$/i.test(m.domain)) return null;
  const thread = m.threadTs && m.threadTs !== m.ts && /^\d{1,12}\.\d{1,8}$/.test(m.threadTs) ? `?thread_ts=${m.threadTs}&cid=${m.channelId}` : "";
  const built = `https://${m.domain}.slack.com/archives/${m.channelId}/p${m.ts.replace(".", "")}${thread}`;
  return isSlackPermalink(built) ? built : null;
}

/** API field → the modal block it belongs to. */
const FIELD_BLOCK: Record<string, string> = {
  title: BLOCK.title, description: BLOCK.description, projectId: BLOCK.project, assigneeId: BLOCK.assignee,
  dueDate: BLOCK.due, startDate: BLOCK.due, priority: BLOCK.priority,
};

/** The modal's "Create task": a task as the person, then a confirmation in the channel (only they see it). */
async function onViewSubmission(p: Json, deps: SlackAppDeps, teamId: string, slackUserId: string): Promise<Response> {
  const view = obj(p.view);
  if (str(view.callback_id) !== MODAL_CALLBACK) return ack();
  const v = readModal(view);
  const meta = decodeMeta(view.private_metadata);
  if (!v.title) return json({ response_action: "errors", errors: { [BLOCK.title]: "Give the task a title." } });

  type Outcome = { errors: Record<string, string> } | { done: true };
  const work = (async (): Promise<Outcome> => {
    const over = await limited(deps, "actions", teamId, slackUserId);
    if (over) return { errors: { [BLOCK.title]: over.text } };
    const g = await gate(deps, teamId, slackUserId, { offerLink: false });
    if (!g.ok) return { errors: { [BLOCK.title]: g.message.text } };
    const me = g.link.userId;
    const projectId = v.projectId || PERSONAL;
    if (projectId === PERSONAL && v.assigneeId && v.assigneeId !== me) {
      return { errors: { [BLOCK.assignee]: "Tasks in your Personal list are only for you. Choose a project to assign someone else." } };
    }
    const permalink = meta.pl && isSlackPermalink(meta.pl) ? meta.pl
      : await messagePermalink(deps, { channelId: meta.c ?? "", ts: meta.ts ?? "", threadTs: meta.tt, domain: meta.d }, 800);
    let t: ApiTask;
    try {
      t = await createTask({ db: deps.db, appUrl: deps.appUrl, apiBase: deps.apiBase }, me, g.team.workspaceId, {
        title: v.title, description: v.description, projectId, assigneeId: projectId === PERSONAL ? null : v.assigneeId,
        dueDate: v.dueDate ?? undefined, priority: v.priority ?? undefined,
      }, permalink);
    } catch (e) {
      if (!(e instanceof SlackWriteError)) throw e;
      const field = Object.keys(e.fields).find((f) => FIELD_BLOCK[f]);
      return { errors: { [field ? FIELD_BLOCK[field] : BLOCK.title]: e.message.slice(0, 150) } };
    }
    const wsc = g.team.workspaceId && t.workspaceId ? await workspaceContext(deps.db, me, g.team.workspaceId).catch(() => null) : null;
    const msg = createdMessage(cardOf(t, me, wsc ?? {}), { appUrl: deps.appUrl, canUndo: true });
    if (meta.ru) await deps.slack.respond(meta.ru, msg);
    return { done: true };
  })().catch((e): Outcome => {
    deps.log("error", "slack-app: submit failed", { error: safeErrorNote(e) });
    return { errors: { [BLOCK.title]: COPY.failed } };
  });

  const r = await within(work, deps.ackAfterMs ?? 2200);
  if (r.done) return "errors" in r.value ? json({ response_action: "errors", errors: r.value.errors }) : ack();
  // slower than Slack waits: the modal closes now; a refusal is told in the channel
  deps.waitUntil(work.then(async (o) => {
    if ("errors" in o && meta.ru) await deps.slack.respond(meta.ru, noticeMessage(`Kanbo couldn't add that task: ${Object.values(o.errors)[0]}`, { emoji: ":warning:" }));
  }));
  return ack();
}

/* ============================================================ events */

async function onEvent(body: Json, headers: Headers, deps: SlackAppDeps): Promise<Response> {
  const type = str(body.type);
  if (type === "url_verification") {
    const challenge = str(body.challenge);
    return /^[A-Za-z0-9_-]{1,200}$/.test(challenge) ? json({ challenge }) : plainText(400, "Bad challenge");
  }
  if (type !== "event_callback") return ack();
  const teamId = str(body.team_id);
  const ev = obj(body.event);
  const slackUserId = str(ev.user);
  if (!isSlackId(teamId) || !isSlackId(slackUserId)) return ack();
  const eventId = str(body.event_id);
  // a resend of an event we're already handling (or handled) is answered and dropped
  if (!(await firstTimeSeen(deps.db.service, eventId))) {
    deps.log("info", "slack-app: duplicate event dropped", { retry: headers.get("x-slack-retry-num") ?? "0" });
    return ack();
  }
  const work = (async () => {
    const over = await limited(deps, "events", teamId, slackUserId);
    if (over) return;
    if (str(ev.type) === "link_shared") return onLinkShared(deps, teamId, slackUserId, ev);
    if (str(ev.type) === "app_home_opened" && str(ev.tab) === "home") return onHomeOpened(deps, teamId, slackUserId);
  })().catch((e) => deps.log("error", "slack-app: event failed", { error: safeErrorNote(e) }));
  deps.waitUntil(work);
  return ack();
}

/** Which Kanbo thing a pasted link is: ?task=<id> anywhere on Kanbo's site, or /p/<project id>. */
export function kanboLinkTarget(url: string, appUrl: string): { kind: "task" | "project"; id: string } | null {
  let u: URL;
  let app: URL;
  try { u = new URL(String(url).replace(/&amp;/g, "&")); app = new URL(appUrl); } catch { return null; }
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
  if (u.protocol !== "https:" || bare(u.hostname) !== bare(app.hostname)) return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const task = u.searchParams.get("task");
  if (task && uuid.test(task)) return { kind: "task", id: task.toLowerCase() };
  const m = /^\/p\/([^/]+)/.exec(u.pathname);
  if (m && uuid.test(decodeURIComponent(m[1]))) return { kind: "project", id: decodeURIComponent(m[1]).toLowerCase() };
  return null;
}

/** Previews for Kanbo links, only for a linked person who can see the thing, only in the Slack workspace's Kanbo workspace. */
async function onLinkShared(deps: SlackAppDeps, teamId: string, slackUserId: string, ev: Json): Promise<void> {
  const link = await findLink(deps.db.service, teamId, slackUserId);
  if (!link || !link.canAct) return;
  const team = await teamInfo(deps.db.service, teamId);
  const ws = team.workspaceId;
  if (!ws) return;
  const links = (Array.isArray(ev.links) ? ev.links : []).slice(0, 5).map((l) => str(obj(l).url)).filter(Boolean);
  const unfurls: Record<string, unknown> = {};
  for (const url of links) {
    const target = kanboLinkTarget(url, deps.appUrl);
    if (!target) continue;
    if (target.kind === "task") {
      const card = await loadCard(deps.db, link.userId, ws, target.id);
      if (card) unfurls[url] = taskUnfurl(card, deps.appUrl);
    } else {
      const proj = await loadProjectCard(deps.db, link.userId, ws, target.id);
      if (proj) unfurls[url] = projectUnfurl(proj, deps.appUrl);
    }
  }
  if (!Object.keys(unfurls).length) return;
  const where: Json = str(ev.unfurl_id) && str(ev.source)
    ? { unfurl_id: str(ev.unfurl_id), source: str(ev.source) }
    : { channel: str(ev.channel), ts: str(ev.message_ts) };
  const r: SlackApiAnswer = await deps.slack.call("chat.unfurl", { ...where, unfurls });
  if (!r.ok) deps.log("warn", "slack-app: chat.unfurl refused", { error: r.error });
}

async function onHomeOpened(deps: SlackAppDeps, teamId: string, slackUserId: string): Promise<void> {
  const link = await findLink(deps.db.service, teamId, slackUserId).catch((e) => { if (isMissingSchema(e)) return null; throw e; });
  if (!link || !link.canAct) {
    await deps.slack.call("views.publish", { user_id: slackUserId, view: homeView({ linked: false, appUrl: deps.appUrl }) });
    return;
  }
  await publishHome(deps, { ok: true, link, team: await teamInfo(deps.db.service, teamId) }, slackUserId);
}

async function publishHome(deps: SlackAppDeps, g: Extract<Gate, { ok: true }>, slackUserId: string): Promise<void> {
  const prof = await slackProfile(deps, slackUserId, 1500);
  const today = toLocalISO(todayIn(deps, prof?.tz));
  const { tasks, more } = await homeTasks(deps.db, g.link.userId, g.team.workspaceId, today);
  const view = homeView({ linked: true, tasks, more, appUrl: deps.appUrl, workspaceName: g.team.workspaceName, today });
  const r = await deps.slack.call("views.publish", { user_id: slackUserId, view });
  if (!r.ok) deps.log("warn", "slack-app: views.publish refused", { error: r.error });
}

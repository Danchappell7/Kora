// ============================================================
// KANBO — public request forms: what the public-form function does,
// as a pure handler (no Deno globals, no remote imports), so vitest can
// run every path against an in-memory database (handler.test.ts).
// index.ts is only the HTTP wrapper around it.          [f9-public-forms]
//
//   GET  ?t=<token>  → 200 { form: PublicFormSchema }
//                      404 not_found · 410 disabled · 429 rate_limited
//   GET  ?ping       → 200 { ok: true }   (lets the app see the function is live)
//   POST ?t=<token>  body: PublicFormSubmission
//                    → 200 { ok: true, reference: "KB-7F3A9C" } (also written into the task)
//                      400 invalid (+ field, fields) · 404 · 410 · 429 (+ scope) · 503
//
// Who can do what: anyone with an enabled form's link reads the form's
// public face (name, intro, project name / emoji / colour, team name and
// logo, which of description / priority / due date it asks for) and files
// ONE task through it. Nothing else is readable or writable: the token is
// looked up with the service role, and every value written comes from the
// form's row (project, workspace, creator), the project's own checked rules
// (below), or the whitelisted, capped, re-validated submission.
//
// Abuse limits (rate_limits from 0042, failing open without it):
//   reads   120 per IP per 10 minutes
//   sends    30 per IP per 10 minutes, across every form (an office or
//             event Wi-Fi is one address, and the QR code invites a queue)
//            20 per IP per form per hour: one network can never use more
//             than a fifth of a form's allowance
//             3 per email address per 10 minutes
//           100 per form per hour, counted LAST and only for a request
//             that's then filed (a failed save gives its slot back), so a
//             request the narrower limits refuse costs the form nothing
//   a filled honeypot ("website") gets a normal-looking reference and
//   nothing is stored. IPs, emails and tokens are hashed in keys.
//   A form whose hourly allowance is used up says so in its own words
//   (scope "form"); regenerating the link starts a fresh allowance.
//
// Whose project: a team form files only into a project of its own team; a
// personal form only into its creator's own projects (forms.project_id is
// free text, so it's checked here, with the service role, every time), and
// only its creator is ever assigned or told: the same audience the app's
// own notify_assignee / is_task_audience allow.
//
// The project's rules: a request runs the project's enabled "When a task is
// created" rules, as a form filled in inside the app does (App.tsx applyRules:
// set priority, set assignee, set section, add tag; later rules win). Each
// value is checked here first: an assignee only if they could be given the
// request anyway (see chooseAssignee), a section only if it's in the form's
// project, a tag only if it's built in, the team's, or the rule author's own.
// Anything else is skipped, never guessed.
// ============================================================
import { KEY_PREFIX, type Db } from "../_shared/limits.ts";
import {
  buildPublicSchema, checkSubmission, FAILURE_MESSAGES, FAILURE_STATUS, isHoneypotHit, isPublicToken,
  MAX_BODY_BYTES, PUBLIC_PRIORITIES, publicFieldsOf, RATE_LIMIT_MESSAGES, requestDescription, requestLine, taskReference,
  type CleanSubmission, type PublicFailure, type PublicFieldKey, type RateLimitScope, type SubmissionKey,
} from "../_shared/publicForm.ts";

export const PUBLIC_FORM_LIMITS = {
  getPerIp: { windowSec: 600, max: 120 },
  /** burst, across all forms: a room on one Wi-Fi queueing at a QR code */
  postPerIp: { windowSec: 600, max: 30 },
  /** sustained, per form: one network never takes more than a fifth of postPerForm */
  postPerIpPerForm: { windowSec: 3600, max: 20 },
  postPerEmail: { windowSec: 600, max: 3 },
  /** the owner's Inbox flood guard: counted last, only for requests that are filed */
  postPerForm: { windowSec: 3600, max: 100 },
} as const;

export interface PublicFormRequest {
  method: string;
  /** ?t= */
  token: string | null;
  /** the caller's IP from headers they can't forge ("" when unknown: no per-IP limit) */
  ip: string;
  /** the raw body (POST), already capped by the wrapper; null when it was too large */
  body?: string | null;
  /** ?ping: "is the function deployed?" */
  ping?: boolean;
}

export interface PublicFormResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface PublicFormDeps {
  db: Db;
  /** rate limiter: hit(db, key, window) from _shared/limits.ts */
  hit: (key: string, opts: { windowSec: number; max?: number }) => Promise<{ allowed: boolean; retryAfter: number }>;
  /** give one hit back: refund(db, key) from _shared/limits.ts (the form's slot, when the task didn't save) */
  refund?: (key: string) => Promise<void>;
  /** hashKey from _shared/limits.ts (non-reversible key parts) */
  hash: (value: string) => Promise<string>;
  /** a random v4 uuid: the new task's id (so its reference is known before it's saved), and the honeypot's fake one */
  randomId: () => string;
  now?: () => number;
  /** diagnostics: never given names, emails or tokens */
  log?: (message: string, detail?: unknown) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSONAL = { id: "p-personal", name: "Personal", emoji: "📥", color: "oklch(0.62 0.154 270)" };
const WRITER_ROLES = new Set(["owner", "admin", "member"]);
/** The app's built-in tags (src/data/data.ts BUILTIN_TAGS: id → label; drift-tested). */
export const BUILTIN_TAG_LABELS: Readonly<Record<string, string>> = {
  design: "Design", eng: "Engineering", research: "Research", writing: "Writing", ops: "Ops", bug: "Bug",
};
/** How many of a project's rules, and of a team's tags, a request reads at most. */
const MAX_RULES = 50;
const MAX_TAGS = 500;
const isBuiltinTag = (v: string) => Object.prototype.hasOwnProperty.call(BUILTIN_TAG_LABELS, v);
/** ids compare case-blind (uuid columns come back lower-case; free-text ones may not) */
const idOf = (v: string | null | undefined) => (v ? String(v).toLowerCase() : null);

function fail(reason: Exclude<PublicFailure, "network">, message?: string, extra: Record<string, unknown> = {}): PublicFormResponse {
  return { status: FAILURE_STATUS[reason], body: { reason, error: message ?? FAILURE_MESSAGES[reason], ...extra } };
}
/** 429. scope "sender": this address or this email has sent a lot; "form": the form's hourly allowance is used up. */
function limited(retryAfter: number, scope: RateLimitScope = "sender"): PublicFormResponse {
  const s = Math.max(1, Math.ceil(retryAfter || 60));
  return {
    status: 429,
    body: { reason: "rate_limited", scope, error: RATE_LIMIT_MESSAGES[scope], retryAfter: s },
    headers: { "Retry-After": String(s) },
  };
}
const dbError = (e: unknown) => {
  const err = e as { code?: string; message?: string } | null;
  return { code: err?.code ?? "", message: String(err?.message ?? e ?? "").slice(0, 200) };
};

interface FormRow { id: string; user_id: string; workspace_id: string | null; project_id: string; name: string; description: string | null; fields: unknown; public_enabled: boolean | null }
interface ProjectRow { id: string; user_id?: string; name: string; emoji: string | null; color: string | null; owner_id: string | null; workspace_id: string | null; archived_at?: string | null }
interface WorkspaceRow { id: string; name: string; logo_url: string | null; owner_id: string }
interface ProfileRow { id: string; suspended?: boolean | null; approved?: boolean | null; notify_prefs?: Record<string, unknown> | null }

interface Target {
  form: FormRow;
  project: ProjectRow;
  workspace: WorkspaceRow | null;
  fields: PublicFieldKey[];
}

/** May this account act at all (not suspended, not waiting for approval)? Unknown counts as yes. */
const inGoodStanding = (p: ProfileRow | undefined) => !p || (!p.suspended && p.approved !== false);

async function profilesOf(db: Db, ids: string[], log?: PublicFormDeps["log"]): Promise<Map<string, ProfileRow> | null> {
  const list = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (!list.length) return new Map();
  const { data, error } = await db.from("profiles").select("id, suspended, approved, notify_prefs").in("id", list);
  if (error) { log?.("public-form: profiles lookup failed", dbError(error)); return null; }
  return new Map(((data ?? []) as ProfileRow[]).map((p) => [p.id, p]));
}

/** The enabled form behind a token, with its project and team, or why there isn't one. */
async function findTarget(db: Db, token: string, log?: PublicFormDeps["log"]): Promise<{ ok: true; target: Target } | { ok: false; reason: "not_found" | "disabled" | "unavailable" }> {
  const { data: form, error } = await db.from("forms")
    .select("id, user_id, workspace_id, project_id, name, description, fields, public_enabled")
    .eq("public_token", token).maybeSingle();
  if (error) {
    // 42703 / PGRST204: 0043 isn't in yet (no public_token column)
    log?.("public-form: form lookup failed", dbError(error));
    return { ok: false, reason: "unavailable" };
  }
  const f = form as FormRow | null;
  if (!f) return { ok: false, reason: "not_found" };
  if (!f.public_enabled) return { ok: false, reason: "disabled" };

  let project: ProjectRow;
  if (UUID.test(String(f.project_id))) {
    const { data: p, error: pe } = await db.from("projects")
      .select("id, user_id, name, emoji, color, owner_id, workspace_id, archived_at")
      .eq("id", f.project_id).maybeSingle();
    if (pe) { log?.("public-form: project lookup failed", dbError(pe)); return { ok: false, reason: "unavailable" }; }
    // the project was deleted or archived: there's nowhere to file the request
    if (!p || (p as ProjectRow).archived_at) return { ok: false, reason: "disabled" };
    project = p as ProjectRow;
  } else if (f.project_id === PERSONAL.id && !f.workspace_id) {
    project = { ...PERSONAL, user_id: f.user_id, owner_id: f.user_id, workspace_id: null };
  } else {
    return { ok: false, reason: "disabled" };
  }
  // a form only ever files into its own team: a project and form that disagree take nothing
  if (idOf(project.workspace_id) !== idOf(f.workspace_id)) return { ok: false, reason: "disabled" };
  // ...and a personal form only into its creator's own projects. forms.project_id is
  // free text: without this, a form could point at anyone's personal project and
  // show its name to strangers, file tasks into it and reach its owner's Inbox.
  if (!f.workspace_id && idOf(project.user_id) !== idOf(f.user_id)) {
    log?.("public-form: personal form points at a project its creator doesn't own");
    return { ok: false, reason: "disabled" };
  }

  let workspace: WorkspaceRow | null = null;
  if (f.workspace_id) {
    const { data: w, error: we } = await db.from("workspaces").select("id, name, logo_url, owner_id").eq("id", f.workspace_id).maybeSingle();
    if (we) { log?.("public-form: workspace lookup failed", dbError(we)); return { ok: false, reason: "unavailable" }; }
    if (!w) return { ok: false, reason: "not_found" };
    workspace = w as WorkspaceRow;
  }

  // a suspended (or not yet approved) account's forms don't take requests:
  // the creator's for a personal form, the team owner's for a team form
  const gate = workspace ? workspace.owner_id : f.user_id;
  const profiles = await profilesOf(db, [gate], log);
  if (profiles && !inGoodStanding(profiles.get(gate))) return { ok: false, reason: "disabled" };

  return { ok: true, target: { form: f, project, workspace, fields: publicFieldsOf(f.fields) } };
}

/* ---------------- the project's rules ---------------- */

export interface RuleRow { id?: string; user_id: string; workspace_id: string | null; project_id: string; trigger?: string | null; actions: unknown; enabled?: boolean | null }
/** What the rules ask for, unchecked: later rules win (priority, assignee,
 *  section), tags add up, each remembering whose rule asked for it. */
export interface RulePlan { priority?: string; assigneeId?: string; sectionId?: string; tags: { value: string; author: string }[] }

/** Fold rules (oldest first) the way the app's applyRules does at creation. */
export function planRules(rules: readonly RuleRow[]): RulePlan {
  const plan: RulePlan = { tags: [] };
  for (const r of rules) {
    if (r.enabled === false || (r.trigger || "task_created") !== "task_created" || !Array.isArray(r.actions)) continue;
    for (const a of r.actions as unknown[]) {
      if (!a || typeof a !== "object") continue;
      const { type, value } = a as { type?: unknown; value?: unknown };
      if (typeof value !== "string" || !value) continue;
      if (type === "set_priority") plan.priority = value;
      else if (type === "set_assignee") plan.assigneeId = value;
      else if (type === "set_section") plan.sectionId = value;
      else if (type === "add_tag") plan.tags.push({ value, author: r.user_id });
    }
  }
  return plan;
}

/** The form's project's rules, oldest first: on a team form the team's, on a
 *  personal form only its creator's own (automation_rules.project_id is free
 *  text, so a rule elsewhere naming this project id never counts). */
async function projectRules(db: Db, t: Target, log?: PublicFormDeps["log"]): Promise<RuleRow[]> {
  let q = db.from("automation_rules").select("id, user_id, workspace_id, project_id, trigger, actions, enabled")
    .eq("project_id", t.form.project_id).eq("enabled", true);
  q = t.form.workspace_id ? q.eq("workspace_id", t.form.workspace_id) : q.is("workspace_id", null).eq("user_id", t.form.user_id);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(MAX_RULES);
  // no rules table, or a hiccup: file the request as it is rather than lose it
  if (error) { log?.("public-form: rules lookup failed", dbError(error)); return []; }
  return (data ?? []) as RuleRow[];
}

/** The rules' section, when it's one of the form's project's own. */
async function ruleSection(db: Db, t: Target, sectionId: string | undefined, log?: PublicFormDeps["log"]): Promise<string | null> {
  if (!sectionId || !UUID.test(sectionId)) return null;
  const { data, error } = await db.from("sections").select("id, user_id, workspace_id, project_id").eq("id", sectionId).maybeSingle();
  if (error) { log?.("public-form: section lookup failed", dbError(error)); return null; }
  const sec = data as { id: string; user_id: string; workspace_id: string | null; project_id: string } | null;
  if (!sec || sec.project_id !== t.form.project_id) return null;
  if (idOf(sec.workspace_id) !== idOf(t.form.workspace_id)) return null;
  if (!t.form.workspace_id && idOf(sec.user_id) !== idOf(t.form.user_id)) return null;
  return sec.id;
}

/** The rules' tags as the ids a task stores: built-in ones, the team's (on a
 *  team form), and the rule author's own personal tags; a name (older rules
 *  stored the tag's name) when exactly one of those has it, like resolveTagId. */
async function ruleTags(db: Db, t: Target, wanted: RulePlan["tags"], log?: PublicFormDeps["log"]): Promise<string[]> {
  if (!wanted.length) return [];
  type TagRow = { id: string; label: string | null; user_id: string; workspace_id: string | null };
  let scoped: TagRow[] = [];
  if (wanted.some((w) => !isBuiltinTag(w.value))) {
    const authors = [...new Set(wanted.map((w) => w.author).filter((a) => UUID.test(a)))];
    const reads: Promise<{ data: unknown; error: unknown }>[] = [];
    if (t.form.workspace_id) reads.push(db.from("tags").select("id, label, user_id, workspace_id").eq("workspace_id", t.form.workspace_id).limit(MAX_TAGS));
    if (authors.length) reads.push(db.from("tags").select("id, label, user_id, workspace_id").is("workspace_id", null).in("user_id", authors).limit(MAX_TAGS));
    for (const { data, error } of await Promise.all(reads)) {
      if (error) { log?.("public-form: tags lookup failed", dbError(error)); continue; }
      scoped = scoped.concat((data ?? []) as TagRow[]);
    }
  }
  const out: string[] = [];
  for (const { value, author } of wanted) {
    // the tags this rule's author could have picked in the app
    const mine = scoped.filter((g) => (g.workspace_id ? true : g.user_id === author));
    let id: string | null = null;
    if (isBuiltinTag(value)) id = value;
    else if (mine.some((g) => g.id === value)) id = value;
    else {
      const want = value.trim().toLowerCase();
      const hits = [
        ...Object.entries(BUILTIN_TAG_LABELS).filter(([, label]) => label.toLowerCase() === want).map(([k]) => k),
        ...mine.filter((g) => String(g.label ?? "").trim().toLowerCase() === want).map((g) => g.id),
      ];
      if (hits.length === 1) id = hits[0];
    }
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Who gets the request, and whether they want an Inbox item. Only someone who
 *  could see the task in the app (is_task_audience): on a personal form that's
 *  its creator, nobody else, whatever the project row or a rule says. On a team
 *  form: the rules' assignee if they're an active writer in good standing, else
 *  the project's owner on the same terms, else the form's creator, else the
 *  team's owner (always in the team). */
async function chooseAssignee(db: Db, t: Target, preferred?: string, log?: PublicFormDeps["log"]): Promise<{ id: string; notify: boolean }> {
  const ws = t.workspace;
  // a rule's assignee goes first, on exactly the same terms as everyone else
  const candidates = ws
    ? [...new Set([preferred?.toLowerCase(), t.project.owner_id, t.form.user_id, ws.owner_id].filter((x): x is string => typeof x === "string" && UUID.test(x)))]
    : [t.form.user_id];
  const fallback = ws ? ws.owner_id : t.form.user_id;
  const profiles = await profilesOf(db, candidates, log);
  let writers = new Set<string>();
  if (ws) {
    const { data, error } = await db.from("workspace_members").select("user_id, role, status")
      .eq("workspace_id", ws.id).in("user_id", candidates);
    // can't tell who's still in the team: only the team's owner is certain
    if (error) log?.("public-form: members lookup failed", dbError(error));
    else writers = new Set(((data ?? []) as { user_id: string; role: string; status: string }[])
      .filter((m) => m.status === "active" && WRITER_ROLES.has(m.role)).map((m) => m.user_id));
  }
  const eligible = (id: string) => inGoodStanding(profiles?.get(id)) && (!ws || id === ws.owner_id || writers.has(id));
  const id = candidates.find(eligible) ?? fallback;
  // notif_on(user, 'assigned'): on unless they've switched it off (a stored "false" counts too)
  const prefs = profiles?.get(id)?.notify_prefs;
  const assigned = prefs && typeof prefs === "object" ? (prefs as Record<string, unknown>).assigned : undefined;
  return { id, notify: !(assigned === false || assigned === "false") };
}

export async function handlePublicForm(req: PublicFormRequest, deps: PublicFormDeps): Promise<PublicFormResponse> {
  const { db, log } = deps;
  const method = req.method.toUpperCase();
  if (method === "GET" && req.ping && !req.token) return { status: 200, body: { ok: true } };
  if (method !== "GET" && method !== "POST") {
    return { status: 405, body: { reason: "invalid", error: "Use GET or POST." }, headers: { Allow: "GET, POST, OPTIONS" } };
  }
  const token = req.token ?? "";
  // a token of the wrong shape can't exist: answer without touching the database
  if (!isPublicToken(token)) return fail("not_found");
  const ipKey = req.ip ? await deps.hash(req.ip) : "";

  /* ---------------- read the form ---------------- */
  if (method === "GET") {
    if (ipKey) {
      const h = await deps.hit(`${KEY_PREFIX}pf:get:${ipKey}`, PUBLIC_FORM_LIMITS.getPerIp);
      if (!h.allowed) return limited(h.retryAfter);
    }
    const found = await findTarget(db, token, log);
    if (!found.ok) return fail(found.reason);
    const { form, project, workspace } = found.target;
    return { status: 200, body: { form: buildPublicSchema({ form, project, workspace }) } };
  }

  /* ---------------- file a request ---------------- */
  if (req.body == null || req.body.length > MAX_BODY_BYTES) {
    return fail("invalid", "That request is too long. Shorten the details and try again.");
  }
  let raw: unknown;
  try { raw = JSON.parse(req.body || "{}"); } catch { return fail("invalid", "That request couldn't be read. Try again."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid", "That request couldn't be read. Try again.");

  // Limits, narrowest first, so a request one of them refuses costs nobody
  // else anything: this network (burst, any form), then this network on this
  // form, then this email address, and only then the form's shared allowance.
  if (ipKey) {
    const h = await deps.hit(`${KEY_PREFIX}pf:ip:${ipKey}`, PUBLIC_FORM_LIMITS.postPerIp);
    if (!h.allowed) return limited(h.retryAfter);
  }
  // a bot filled the hidden field: look like it worked, store nothing
  if (isHoneypotHit(raw)) return { status: 200, body: { ok: true, reference: taskReference(deps.randomId()) } };

  const found = await findTarget(db, token, log);
  if (!found.ok) return fail(found.reason);
  const t = found.target;

  const checked = checkSubmission(t.fields, raw);
  if (!checked.ok) {
    const order: SubmissionKey[] = ["title", "description", "priority", "dueDate", "name", "email"];
    const field = order.find((k) => checked.errors[k]) ?? (Object.keys(checked.errors)[0] as SubmissionKey);
    return fail("invalid", checked.errors[field], { field, fields: checked.errors });
  }
  const s = checked.value;

  if (ipKey) {
    const h = await deps.hit(`${KEY_PREFIX}pf:ipform:${await deps.hash(`${req.ip}|${token}`)}`, PUBLIC_FORM_LIMITS.postPerIpPerForm);
    if (!h.allowed) return limited(h.retryAfter);
  }
  const perEmail = await deps.hit(`${KEY_PREFIX}pf:email:${await deps.hash(s.email)}`, PUBLIC_FORM_LIMITS.postPerEmail);
  if (!perEmail.allowed) return limited(perEmail.retryAfter);

  // the id is chosen here so the reference the requester is given is in the
  // task itself (its description), where the team's search finds it
  const newId = deps.randomId();
  if (!UUID.test(newId)) return fail("unavailable", "Your request wasn't saved. Try again in a few minutes.");
  const reference = taskReference(newId);

  // the form's shared allowance, last: only a request that's about to be filed
  // uses it (a failed save gives it back below)
  const formKey = `${KEY_PREFIX}pf:form:${await deps.hash(token)}`;
  const perForm = await deps.hit(formKey, PUBLIC_FORM_LIMITS.postPerForm);
  if (!perForm.allowed) return limited(perForm.retryAfter, "form");
  try {
    return await fileRequest(deps, t, s, newId, reference, formKey);
  } catch (e) {
    // nothing was filed (the wrapper answers 503): the form gets its slot back
    await deps.refund?.(formKey);
    throw e;
  }
}

/** Write the task (through the project's checked rules) and its Inbox item. */
async function fileRequest(deps: PublicFormDeps, t: Target, s: CleanSubmission, newId: string, reference: string, formKey: string): Promise<PublicFormResponse> {
  const { db, log } = deps;
  // the project's "When a task is created" rules, each value checked
  const plan = planRules(await projectRules(db, t, log));
  const [assignee, sectionId, tags] = await Promise.all([
    chooseAssignee(db, t, plan.assigneeId, log),
    ruleSection(db, t, plan.sectionId, log),
    ruleTags(db, t, plan.tags, log),
  ]);
  const rulePriority = (PUBLIC_PRIORITIES as readonly string[]).includes(plan.priority ?? "") ? plan.priority : undefined;
  const now = deps.now?.() ?? Date.now();
  const row: Record<string, unknown> = {
    id: newId,
    user_id: t.form.user_id,
    workspace_id: t.form.workspace_id,
    project_id: t.form.project_id,
    title: s.title,
    description: requestDescription(t.form.name, s, reference),
    status: "todo",
    // a rule's priority wins over the requester's, as it does in the app
    priority: rulePriority ?? s.priority ?? "medium",
    assignee_id: assignee.id,
    due_date: s.dueDate ?? null,
    tags,
    focus_min: 30,
    dur: 30,
    ai_score: 50,
    plan_today: false,
    scheduled: null,
    position: now,
  };
  if (sectionId) row.section_id = sectionId;
  const { data: created, error: insErr } = await db.from("tasks").insert(row).select("id").single();
  const taskId = (created as { id?: string } | null)?.id;
  if (insErr || !taskId) {
    log?.("public-form: task insert failed", dbError(insErr));
    // nothing was filed: the form gets its slot back
    await deps.refund?.(formKey);
    return fail("unavailable", "Your request wasn't saved. Try again in a few minutes.");
  }

  // the Inbox item ("New request: …"), unless they've switched assignment notices off
  if (assignee.notify) {
    const { error: actErr } = await db.from("activity").insert({
      user_id: assignee.id, task_id: taskId, task_title: s.title, kind: "assigned", detail: requestLine(t.form.name),
    });
    if (actErr) log?.("public-form: activity insert failed", dbError(actErr));
  }
  return { status: 200, body: { ok: true, reference } };
}

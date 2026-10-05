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
//                    → 200 { ok: true, reference: "KB-7F3A9C" }
//                      400 invalid (+ field, fields) · 404 · 410 · 429 · 503
//
// Who can do what: anyone with an enabled form's link reads the form's
// public face (name, intro, project name / emoji / colour, team name and
// logo, which of description / priority / due date it asks for) and files
// ONE task through it. Nothing else is readable or writable: the token is
// looked up with the service role, and every value written comes from the
// form's row (project, workspace, creator) or the whitelisted, capped,
// re-validated submission.
//
// Abuse limits (rate_limits from 0042, failing open without it):
//   reads   120 per IP per 10 minutes
//   sends     5 per IP per 10 minutes, 50 per form per hour,
//             3 per email address per 10 minutes
//   a filled honeypot ("website") gets a normal-looking reference and
//   nothing is stored. IPs, emails and tokens are hashed in keys.
// ============================================================
import { KEY_PREFIX, type Db } from "../_shared/limits.ts";
import {
  buildPublicSchema, checkSubmission, FAILURE_MESSAGES, FAILURE_STATUS, isHoneypotHit, isPublicToken,
  MAX_BODY_BYTES, publicFieldsOf, requestDescription, requestLine, taskReference,
  type PublicFailure, type PublicFieldKey, type SubmissionKey,
} from "../_shared/publicForm.ts";

export const PUBLIC_FORM_LIMITS = {
  getPerIp: { windowSec: 600, max: 120 },
  postPerIp: { windowSec: 600, max: 5 },
  postPerForm: { windowSec: 3600, max: 50 },
  postPerEmail: { windowSec: 600, max: 3 },
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
  /** hashKey from _shared/limits.ts (non-reversible key parts) */
  hash: (value: string) => Promise<string>;
  /** a random uuid (the honeypot's fake reference) */
  randomId: () => string;
  now?: () => number;
  /** diagnostics: never given names, emails or tokens */
  log?: (message: string, detail?: unknown) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSONAL = { id: "p-personal", name: "Personal", emoji: "📥", color: "oklch(0.62 0.154 270)" };
const WRITER_ROLES = new Set(["owner", "admin", "member"]);

function fail(reason: Exclude<PublicFailure, "network">, message?: string, extra: Record<string, unknown> = {}): PublicFormResponse {
  return { status: FAILURE_STATUS[reason], body: { reason, error: message ?? FAILURE_MESSAGES[reason], ...extra } };
}
function limited(retryAfter: number): PublicFormResponse {
  const s = Math.max(1, Math.ceil(retryAfter || 60));
  return { status: 429, body: { reason: "rate_limited", error: FAILURE_MESSAGES.rate_limited, retryAfter: s }, headers: { "Retry-After": String(s) } };
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
    project = { ...PERSONAL, owner_id: f.user_id, workspace_id: null };
  } else {
    return { ok: false, reason: "disabled" };
  }
  // a form only ever files into its own team: a project and form that disagree take nothing
  const wsOf = (v: string | null | undefined) => (v ? String(v).toLowerCase() : null);
  if (wsOf(project.workspace_id) !== wsOf(f.workspace_id)) return { ok: false, reason: "disabled" };

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

/** The project's owner if they can take it (an active writer in good standing), else the
 *  form's creator, else the team's owner. Also says whether they want an Inbox item. */
async function chooseAssignee(db: Db, t: Target, log?: PublicFormDeps["log"]): Promise<{ id: string; notify: boolean }> {
  const candidates = [...new Set([t.project.owner_id, t.form.user_id, t.workspace?.owner_id].filter((x): x is string => typeof x === "string" && UUID.test(x)))];
  const fallback = t.workspace?.owner_id ?? t.form.user_id;
  const profiles = await profilesOf(db, candidates, log);
  let writers: Set<string> | null = null;
  if (t.workspace) {
    const { data, error } = await db.from("workspace_members").select("user_id, role, status")
      .eq("workspace_id", t.workspace.id).in("user_id", candidates);
    if (error) log?.("public-form: members lookup failed", dbError(error));
    else writers = new Set(((data ?? []) as { user_id: string; role: string; status: string }[])
      .filter((m) => m.status === "active" && WRITER_ROLES.has(m.role)).map((m) => m.user_id));
  }
  const eligible = (id: string) =>
    inGoodStanding(profiles?.get(id)) && (!t.workspace || id === t.workspace.owner_id || writers === null || writers.has(id));
  const id = candidates.find(eligible) ?? fallback;
  const prefs = profiles?.get(id)?.notify_prefs;
  return { id, notify: !(prefs && typeof prefs === "object" && (prefs as Record<string, unknown>).assigned === false) };
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

  const perForm = await deps.hit(`${KEY_PREFIX}pf:form:${await deps.hash(token)}`, PUBLIC_FORM_LIMITS.postPerForm);
  if (!perForm.allowed) return limited(perForm.retryAfter);
  const perEmail = await deps.hit(`${KEY_PREFIX}pf:email:${await deps.hash(s.email)}`, PUBLIC_FORM_LIMITS.postPerEmail);
  if (!perEmail.allowed) return limited(perEmail.retryAfter);

  const assignee = await chooseAssignee(db, t, log);
  const now = deps.now?.() ?? Date.now();
  const row: Record<string, unknown> = {
    user_id: t.form.user_id,
    workspace_id: t.form.workspace_id,
    project_id: t.form.project_id,
    title: s.title,
    description: requestDescription(t.form.name, s),
    status: "todo",
    priority: s.priority ?? "medium",
    assignee_id: assignee.id,
    due_date: s.dueDate ?? null,
    tags: [],
    focus_min: 30,
    dur: 30,
    ai_score: 50,
    plan_today: false,
    scheduled: null,
    position: now,
  };
  const { data: created, error: insErr } = await db.from("tasks").insert(row).select("id").single();
  const taskId = (created as { id?: string } | null)?.id;
  if (insErr || !taskId) {
    log?.("public-form: task insert failed", dbError(insErr));
    return fail("unavailable", "Your request wasn't saved. Try again in a few minutes.");
  }

  // the Inbox item ("New request: …"), unless they've switched assignment notices off
  if (assignee.notify) {
    const { error: actErr } = await db.from("activity").insert({
      user_id: assignee.id, task_id: taskId, task_title: s.title, kind: "assigned", detail: requestLine(t.form.name),
    });
    if (actErr) log?.("public-form: activity insert failed", dbError(actErr));
  }
  return { status: 200, body: { ok: true, reference: taskReference(taskId) } };
}

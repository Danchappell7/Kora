// ============================================================
// KANBO — public request forms: the rules both sides share.   [f9-public-forms]
//
// The public-form edge function and the /f/<token> page both import this
// module (src/lib/publicForms.ts re-exports what the page needs), so the
// limits, the field whitelist and the messages can never drift apart: the
// page checks a submission before it's sent, the server checks it again
// and never trusts the page.
//
// Pure: no Deno globals, no remote imports, no DOM. Tested with vitest in
// publicForm.test.ts.
// ============================================================

/** The fields a public form may ask for, in the order the page shows them.
 *  "assignee" is never public: it would list the team's names to strangers. */
export const PUBLIC_FIELD_KEYS = ["description", "priority", "dueDate"] as const;
export type PublicFieldKey = (typeof PUBLIC_FIELD_KEYS)[number];
export type PublicPriority = "low" | "medium" | "high" | "urgent";
export const PUBLIC_PRIORITIES: readonly PublicPriority[] = ["low", "medium", "high", "urgent"];

/** Length caps (characters) the page enforces and the server re-checks. */
export const PUBLIC_LIMITS = { title: 200, name: 120, email: 254, description: 5000 } as const;
/** Caps on what the server sends back about a form. */
export const SCHEMA_LIMITS = { formName: 200, intro: 1000, projectName: 200, workspaceName: 120, emoji: 16 } as const;
/** The largest request body the function reads (bytes). */
export const MAX_BODY_BYTES = 24_000;

/** A form's public token: what 0043's check constraint allows (minted as 32 hex). */
export const PUBLIC_TOKEN_RE = /^[A-Za-z0-9_-]{24,128}$/;
export const isPublicToken = (t: unknown): t is string => typeof t === "string" && PUBLIC_TOKEN_RE.test(t);

/** The submission keys the server reads; anything else in the body is ignored. */
export const SUBMISSION_KEYS = ["title", "name", "email", "description", "priority", "dueDate", "website"] as const;
export type SubmissionKey = (typeof SUBMISSION_KEYS)[number];

export interface CleanSubmission {
  title: string;
  name: string;
  email: string;
  description?: string;
  priority?: PublicPriority;
  dueDate?: string;
}

// C0/C1 controls (keeping tab and newline where text may span lines) and the
// invisible format characters that make text read differently from what it
// is: zero-width spaces and joiners, bidi overrides and isolates, BOM.
// eslint-disable-next-line no-control-regex
const CONTROL_LINE = /[\u0000-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** One line: controls removed, runs of white space collapsed, trimmed. */
export function cleanLine(v: unknown): string {
  return typeof v === "string" ? v.replace(CONTROL_LINE, " ").replace(/\s+/g, " ").trim() : "";
}

/** Multi-line text: CRLF → LF, controls removed, trailing spaces and 3+ blank lines tidied, trimmed. */
export function cleanText(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n?/g, "\n").replace(CONTROL_TEXT, "").replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n").trim();
}

/** Length in characters as people count them (an emoji is one, not two UTF-16 units). */
export const charLength = (s: string): number => Array.from(s).length;

/** A plausible email address: one @, a dotted domain, no spaces or brackets. */
export function isEmailShape(v: string): boolean {
  if (!v || v.length > PUBLIC_LIMITS.email) return false;
  if (!/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/.test(v)) return false;
  const [local, domain] = v.split("@");
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((l) => !l || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) return false;
  const tld = labels[labels.length - 1];
  return /^\p{L}{2,63}$/u.test(tld) || /^xn--[a-z0-9-]{1,59}$/i.test(tld);
}

/** A real calendar day, YYYY-MM-DD, between 2000 and 2100. */
export function isIsoDay(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** The form's fields that may be public, de-duplicated, in page order. */
export function publicFieldsOf(fields: unknown): PublicFieldKey[] {
  const list = Array.isArray(fields) ? fields : [];
  return PUBLIC_FIELD_KEYS.filter((k) => list.includes(k));
}

/** The messages people see next to a field. British English, no exclamation marks. */
export const FIELD_MESSAGES = {
  titleMissing: "Give your request a short title.",
  titleLong: `Keep the title to ${PUBLIC_LIMITS.title} characters or fewer.`,
  nameMissing: "Add your name so the team knows who's asking.",
  nameLong: `Keep your name to ${PUBLIC_LIMITS.name} characters or fewer.`,
  emailMissing: "Add your email address so the team can reply.",
  emailInvalid: "That email address doesn't look right. Check it and try again.",
  descriptionLong: `Keep the details to ${PUBLIC_LIMITS.description.toLocaleString("en-GB")} characters or fewer.`,
  priorityInvalid: "Choose one of the priorities.",
  dueInvalid: "Choose a date from the calendar, or leave it blank.",
  duePast: "Choose today or a later date.",
  wrongType: "This answer couldn't be read. Try typing it again.",
} as const;

export type FieldErrors = Partial<Record<SubmissionKey, string>>;

export interface CheckOptions {
  /** YYYY-MM-DD; when given, a due date before it is refused (the page passes the visitor's today). */
  today?: string;
}

/**
 * Check and tidy a submission against the form's public fields.
 * Only whitelisted keys are read; a field the form doesn't ask for is
 * dropped, whatever was sent. Returns the clean values, or the problems.
 */
export function checkSubmission(fields: readonly PublicFieldKey[], raw: unknown, opts: CheckOptions = {}):
  { ok: true; value: CleanSubmission; errors: FieldErrors } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const str = (k: SubmissionKey): string | null => {
    const v = src[k];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") { errors[k] = FIELD_MESSAGES.wrongType; return null; }
    return v;
  };

  const titleRaw = str("title");
  const title = cleanLine(titleRaw ?? "");
  if (titleRaw !== null) {
    if (!title) errors.title = FIELD_MESSAGES.titleMissing;
    else if (charLength(title) > PUBLIC_LIMITS.title) errors.title = FIELD_MESSAGES.titleLong;
  }

  const nameRaw = str("name");
  const name = cleanLine(nameRaw ?? "");
  if (nameRaw !== null) {
    if (!name) errors.name = FIELD_MESSAGES.nameMissing;
    else if (charLength(name) > PUBLIC_LIMITS.name) errors.name = FIELD_MESSAGES.nameLong;
  }

  const emailRaw = str("email");
  const email = cleanLine(emailRaw ?? "").toLowerCase();
  if (emailRaw !== null) {
    if (!email) errors.email = FIELD_MESSAGES.emailMissing;
    else if (!isEmailShape(email)) errors.email = FIELD_MESSAGES.emailInvalid;
  }

  const value: CleanSubmission = { title, name, email };

  if (fields.includes("description")) {
    const d = str("description");
    if (d !== null) {
      const description = cleanText(d);
      if (charLength(description) > PUBLIC_LIMITS.description) errors.description = FIELD_MESSAGES.descriptionLong;
      else if (description) value.description = description;
    }
  }
  if (fields.includes("priority")) {
    const p = str("priority");
    if (p !== null && p !== "") {
      if ((PUBLIC_PRIORITIES as readonly string[]).includes(p)) value.priority = p as PublicPriority;
      else errors.priority = FIELD_MESSAGES.priorityInvalid;
    }
  }
  if (fields.includes("dueDate")) {
    const d = str("dueDate");
    const day = d === null ? "" : d.trim();
    if (d !== null && day) {
      if (!isIsoDay(day)) errors.dueDate = FIELD_MESSAGES.dueInvalid;
      else if (opts.today && day < opts.today) errors.dueDate = FIELD_MESSAGES.duePast;
      else value.dueDate = day;
    }
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value, errors };
}

/** Anything in the honeypot ("website") means a bot filled the form in. */
export function isHoneypotHit(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const v = (raw as Record<string, unknown>).website;
  return v !== undefined && v !== null && v !== "" && !(typeof v === "string" && !v.trim());
}

/** "Request via Design requests (public link)": the line the Inbox recognises. */
export function requestLine(formName: string): string {
  const name = cleanLine(formName).replace(/\.+$/, "") || "a request form";
  return `Request via ${name} (public link)`;
}

/**
 * The task description a public submission files:
 *
 *   Request via Design requests (public link).
 *
 *   From: Sam Jones <sam@example.com>
 *   Reference: KB-7F3A9C
 *
 *   (their details)
 *
 * The first line is what the Inbox recognises (requestSource reads up to its
 * first full stop, so nothing else goes on it). The reference is the one the
 * requester was given, so when they quote it the team's search finds the task.
 */
export function requestDescription(formName: string, s: Pick<CleanSubmission, "name" | "email" | "description">, reference?: string): string {
  const from = `From: ${cleanLine(s.name)} <${cleanLine(s.email)}>`;
  const who = reference ? `${from}\nReference: ${cleanLine(reference)}` : from;
  return [`${requestLine(formName)}.`, who, s.description ? cleanText(s.description) : ""].filter(Boolean).join("\n\n");
}

/** A short reference the requester can quote: "KB-" + the first six hex of the task id.
 *  The function chooses the id before saving, so the reference is in the task too. */
export function taskReference(taskId: string): string {
  const hex = String(taskId || "").replace(/[^0-9a-f]/gi, "").slice(0, 6).toUpperCase();
  return `KB-${hex.padEnd(6, "0")}`;
}

/** The failures the page tells apart, and what the function answers for each. */
export type PublicFailure = "disabled" | "not_found" | "rate_limited" | "invalid" | "unavailable" | "network";
export const FAILURE_STATUS: Record<Exclude<PublicFailure, "network">, number> = {
  invalid: 400, not_found: 404, disabled: 410, rate_limited: 429, unavailable: 503,
};
export const FAILURE_MESSAGES: Record<PublicFailure, string> = {
  not_found: "This form doesn't exist. The link may be mistyped, or the form has been removed.",
  disabled: "This form isn't taking requests at the moment.",
  rate_limited: "There have been a lot of requests from here. Wait a few minutes, then try again.",
  invalid: "Some answers need another look.",
  unavailable: "This form isn't available right now. Try again in a few minutes.",
  network: "Kanbo couldn't be reached. Check your connection, then try again.",
};

/** Whose limit a 429 is: this sender's (their network or their email address)
 *  or the form's own hourly allowance (everyone's). */
export type RateLimitScope = "sender" | "form";
export const RATE_LIMIT_MESSAGES: Record<RateLimitScope, string> = {
  sender: FAILURE_MESSAGES.rate_limited,
  form: "This form has had a lot of requests in the last hour. Wait a while, then try again.",
};

/* ---------------- what GET returns ---------------- */

export interface PublicSchemaOut {
  name: string;
  intro?: string;
  project: { name: string; emoji: string; color: string };
  workspace?: { name: string; logoUrl?: string | null } | null;
  fields: PublicFieldKey[];
}

const cap = (s: string, n: number) => Array.from(s).slice(0, n).join("");
/** A colour string safe to hand to CSS (oklch/rgb/hsl/hex); anything else becomes the default. */
export function safeColour(v: unknown, fallback = "oklch(0.62 0.16 270)"): string {
  const s = typeof v === "string" ? v.trim() : "";
  return /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lch|lab)\([0-9a-z.,%\s/+-]{1,80}\))$/i.test(s) ? s : fallback;
}
/** The twelve hues of the app's project spectrum, in order (src/lib/projectIdentity.ts
 *  SPECTRUM; publicForms.test.ts keeps the two equal). */
export const SPECTRUM_HUES = [270, 293, 318, 350, 22, 48, 78, 110, 158, 190, 225, 250] as const;
/** Below this chroma the app reads a colour as having no hue (projectIdentity's MIN_HUED_CHROMA). */
const MIN_HUED_CHROMA = 0.02;

/** FNV-1a, as projectIdentity's stableHash: the same id always lands on the same hue. */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * The colour the public page paints a project in, so it wears the same
 * identity there as in Kanbo without the page ever seeing the project's id.
 * A colour with a hue goes as it is (the page snaps it to the spectrum, as
 * the app does). A grey or unusable one is where the app falls back to a
 * stable hash of the project's id: that hue is worked out here and sent as
 * a colour instead. Without an id (the page re-reading what it was sent)
 * it's safeColour.
 */
export function identityColour(colour: unknown, projectId?: unknown): string {
  const safe = safeColour(colour, "");
  if (typeof projectId !== "string" || !projectId) return safe || safeColour(null);
  const m = /^oklch\(\s*[\d.]+%?\s+([\d.]+)(%?)\s+[\d.]+/i.exec(safe);
  const chroma = m ? (m[2] ? (parseFloat(m[1]) / 100) * 0.4 : parseFloat(m[1])) : null;
  if (safe && (chroma === null || chroma >= MIN_HUED_CHROMA)) return safe;
  return `oklch(0.62 0.15 ${SPECTRUM_HUES[stableHash(projectId) % SPECTRUM_HUES.length]})`;
}

/** Only an https image URL may become the team logo on the public page. */
export function safeLogoUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 1000) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
}

/** Build the public schema from the rows the function read (only what the page shows). */
export function buildPublicSchema(input: {
  form: { name: unknown; description?: unknown; fields: unknown };
  /** id: the project's own (server side only), for identityColour; never sent */
  project: { id?: unknown; name: unknown; emoji?: unknown; color?: unknown };
  workspace?: { name: unknown; logo_url?: unknown } | null;
}): PublicSchemaOut {
  const intro = cleanText(input.form.description);
  const emoji = cleanLine(input.project.emoji);
  const wsName = input.workspace ? cleanLine(input.workspace.name) : "";
  return {
    name: cap(cleanLine(input.form.name) || "Request form", SCHEMA_LIMITS.formName),
    ...(intro ? { intro: cap(intro, SCHEMA_LIMITS.intro) } : {}),
    project: {
      name: cap(cleanLine(input.project.name) || "Untitled project", SCHEMA_LIMITS.projectName),
      emoji: emoji ? cap(emoji, SCHEMA_LIMITS.emoji) : "",
      color: identityColour(input.project.color, input.project.id),
    },
    workspace: wsName ? { name: cap(wsName, SCHEMA_LIMITS.workspaceName), logoUrl: safeLogoUrl(input.workspace?.logo_url) } : null,
    fields: publicFieldsOf(input.form.fields),
  };
}

/** Read a schema the page received (never trust the wire): null when it isn't one. */
export function parsePublicSchema(raw: unknown): PublicSchemaOut | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const p = r.project as Record<string, unknown> | undefined;
  if (typeof r.name !== "string" || !p || typeof p !== "object" || typeof p.name !== "string") return null;
  const w = r.workspace as Record<string, unknown> | null | undefined;
  return buildPublicSchema({
    form: { name: r.name, description: r.intro, fields: r.fields },
    project: { name: p.name, emoji: p.emoji, color: p.color },
    workspace: w && typeof w === "object" && typeof w.name === "string" ? { name: w.name, logo_url: w.logoUrl } : null,
  });
}

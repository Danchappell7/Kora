/* ============================================================
   KANBO — public request forms ("Anyone with the link can submit"). [f9-public-forms]
   0043 adds forms.public_token (server-generated, unique) and
   forms.public_enabled. People who may edit the form switch it with a
   plain update (RLS: personal creator or workspace writers, never guests);
   rotate_form_public_token(form_id) → the new token.

   Edge-function contract ("public-form", verify_jwt OFF, service role inside):
     GET  /functions/v1/public-form?t=<token>
          200 { form: PublicFormSchema }
          404 { reason: "not_found", error }   410 { reason: "disabled", error }
          429 { reason: "rate_limited", error, retryAfter }
     POST /functions/v1/public-form?t=<token>   body: PublicFormSubmission
          200 { ok: true, reference: string }  ("KB-7F3A9C")
          400 { reason: "invalid", error, field?: keyof PublicFormSubmission, fields? }
          404 / 410 / 429 as above, 503 { reason: "unavailable" }
     GET  /functions/v1/public-form?ping → 200 { ok: true } (is it deployed?)
   The page lives at /f/:token (src/public/PublicFormPage.tsx, rendered by
   main.tsx before auth). /f/demo previews it with demo data, no network.

   The validation rules, caps and messages are shared with the function
   (supabase/functions/_shared/publicForm.ts): one copy, never drifting.
   main.tsx imports this module at startup, so it stays small: no React,
   no demo data, nothing from the app shell. The page itself never uses
   the Supabase client: it talks to the function with plain fetch, no
   cookies and no Kanbo session.
   ============================================================ */
import type { PublicFormFailure, PublicFormLoad, PublicFormResult, PublicFormSchema, PublicFormSubmission } from "../data/types";
import {
  checkSubmission, FAILURE_MESSAGES, isPublicToken, parsePublicSchema, PUBLIC_LIMITS, RATE_LIMIT_MESSAGES,
  type PublicFieldKey, type RateLimitScope,
} from "../../supabase/functions/_shared/publicForm.ts";
import { supabase } from "./supabase";

export { PUBLIC_LIMITS, PUBLIC_PRIORITIES, FIELD_MESSAGES, FAILURE_MESSAGES, RATE_LIMIT_MESSAGES, isPublicToken } from "../../supabase/functions/_shared/publicForm.ts";
export type { RateLimitScope } from "../../supabase/functions/_shared/publicForm.ts";

/** The token /f/demo uses: the page renders demoPublicForm() and fakes a submission. */
export const DEMO_PUBLIC_TOKEN = "demo";

/** "/f/<token>" (optionally with a trailing slash) → the token; null for any other path. */
export function publicFormTokenFromPath(pathname: string): string | null {
  const m = /^\/f\/([A-Za-z0-9_-]{1,128})\/?$/.exec(pathname || "");
  return m ? m[1] : null;
}

/** The shareable link: <origin>/f/<token> (origin defaults to the current page's). */
export function publicFormUrl(token: string, origin?: string): string {
  const base = (origin ?? (typeof window !== "undefined" ? window.location.origin : "https://www.kanbo.co.uk")).replace(/\/+$/, "");
  return `${base}/f/${encodeURIComponent(token)}`;
}

/** The form /f/demo shows: the demo workspace's "Launch requests" form (data.ts DEMO_FORMS),
 *  so the in-app demo's "Open the public page" lands on the form it came from. */
export function demoPublicForm(): PublicFormSchema {
  return {
    name: "Launch requests",
    intro: "Ask the launch team for copy, assets or a fix before launch day.",
    project: { name: "Q3 Product Launch", emoji: "🚀", color: "oklch(0.62 0.117 225)" },
    workspace: { name: "Foundrise", logoUrl: null },
    fields: ["description", "priority", "dueDate"],
  };
}

/** Today in the visitor's own time zone, YYYY-MM-DD (a due date can't be before it). */
export function localISODate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Field → message for everything wrong with a submission ({} = fine to send). */
export function validateSubmission(form: PublicFormSchema, s: PublicFormSubmission): Partial<Record<keyof PublicFormSubmission, string>> {
  const r = checkSubmission(form.fields as PublicFieldKey[], s, { today: localISODate() });
  return r.ok ? {} : (r.errors as Partial<Record<keyof PublicFormSubmission, string>>);
}

/* ---------------- talking to the function ---------------- */

export interface PublicFormCallOptions {
  /** the Supabase project URL (defaults to VITE_SUPABASE_URL) */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** give up after this long (ms); default 15 s */
  timeoutMs?: number;
  /** demo: how long the fake round trip takes (ms) */
  demoDelayMs?: number;
}

/** What a failed submission says about each field (the server's own words),
 *  and for a 429 whose limit it hit ("form": the form's hourly allowance). */
export type PublicSubmitResult = PublicFormResult & {
  field?: keyof PublicFormSubmission;
  fields?: Partial<Record<keyof PublicFormSubmission, string>>;
  scope?: RateLimitScope;
};

const envBase = (): string => {
  const v = (import.meta.env?.VITE_SUPABASE_URL as string | undefined) ?? "";
  return v.trim().replace(/\/+$/, "");
};

/** <SUPABASE_URL>/functions/v1/public-form?t=<token> */
export function publicFormEndpoint(token: string, baseUrl?: string): string {
  return `${(baseUrl ?? envBase()).replace(/\/+$/, "")}/functions/v1/public-form?t=${encodeURIComponent(token)}`;
}

const REASONS: readonly PublicFormFailure[] = ["disabled", "not_found", "rate_limited", "invalid", "unavailable", "network"];
const failed = (reason: PublicFormFailure, message = FAILURE_MESSAGES[reason], retryAfter?: number) =>
  ({ ok: false as const, reason, message, ...(retryAfter ? { retryAfter } : {}) });
const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function call(url: string, init: RequestInit, opts: PublicFormCallOptions): Promise<{ res: Response; body: Record<string, unknown> | null }> {
  const f = opts.fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!f) throw new Error("no fetch");
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000) : 0;
  try {
    // no cookies, no Kanbo session: the function only ever sees the token
    const res = await f(url, { ...init, credentials: "omit", cache: "no-store", signal: ctrl?.signal });
    const text = await res.text().catch(() => "");
    let body: Record<string, unknown> | null = null;
    try { const j = JSON.parse(text); body = j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { /* not JSON */ }
    return { res, body };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Turn a non-2xx answer into a failure the page can show. */
function failureFrom(res: Response, body: Record<string, unknown> | null): PublicSubmitResult {
  const said = typeof body?.reason === "string" && (REASONS as readonly string[]).includes(body.reason) ? (body.reason as PublicFormFailure) : null;
  const retryRaw = Number(body?.retryAfter ?? res.headers?.get?.("Retry-After") ?? 0);
  const retryAfter = Number.isFinite(retryRaw) && retryRaw > 0 ? Math.ceil(retryRaw) : undefined;
  if (res.status === 429 || said === "rate_limited") {
    const scope: RateLimitScope = body?.scope === "form" ? "form" : "sender";
    return { ...failed("rate_limited", RATE_LIMIT_MESSAGES[scope], retryAfter ?? 60), scope };
  }
  if (res.status === 410 || said === "disabled") return failed("disabled");
  // a 404 without our reason is the gateway's: the function isn't deployed yet
  if (res.status === 404) return said === "not_found" ? failed("not_found") : failed("unavailable");
  if ((res.status === 400 || res.status === 413) && said === "invalid") {
    const message = typeof body?.error === "string" && body.error ? String(body.error).slice(0, 300) : FAILURE_MESSAGES.invalid;
    const out: PublicSubmitResult = failed("invalid", message);
    const field = typeof body?.field === "string" ? (body.field as keyof PublicFormSubmission) : undefined;
    const fields = body?.fields && typeof body.fields === "object" ? (body.fields as Record<string, unknown>) : null;
    if (field) out.field = field;
    if (fields) {
      out.fields = {};
      for (const [k, v] of Object.entries(fields)) if (typeof v === "string") (out.fields as Record<string, string>)[k] = v.slice(0, 300);
    }
    return out;
  }
  return failed("unavailable");
}

/** GET the form's public schema. Never throws. */
export async function loadPublicForm(token: string, opts: PublicFormCallOptions = {}): Promise<PublicFormLoad> {
  try {
    if (token === DEMO_PUBLIC_TOKEN) {
      if (opts.demoDelayMs) await sleep(opts.demoDelayMs);
      return { ok: true, form: demoPublicForm() };
    }
    if (!isPublicToken(token)) return failed("not_found");
    const base = opts.baseUrl ?? envBase();
    if (!base) return failed("unavailable");
    if (isOffline()) return failed("network");
    const { res, body } = await call(publicFormEndpoint(token, base), { method: "GET", headers: { Accept: "application/json" } }, opts);
    if (res.ok) {
      const form = parsePublicSchema(body?.form);
      return form ? { ok: true, form: form as PublicFormSchema } : failed("unavailable");
    }
    const f = failureFrom(res, body);
    return f.ok ? failed("unavailable") : { ok: false, reason: f.reason, message: f.message, ...(f.retryAfter ? { retryAfter: f.retryAfter } : {}) };
  } catch {
    // offline, a timeout, or the request never reached Kanbo
    return failed("network");
  }
}

/** The body the function reads: whitelisted keys only, blanks left out. */
export function submissionBody(s: PublicFormSubmission): PublicFormSubmission {
  const out: PublicFormSubmission = { title: s.title ?? "", name: s.name ?? "", email: s.email ?? "" };
  if (s.description && s.description.trim()) out.description = s.description;
  if (s.priority) out.priority = s.priority;
  if (s.dueDate) out.dueDate = s.dueDate;
  if (s.website) out.website = s.website;
  return out;
}

/** A believable demo reference: KB- and six hex digits. */
const demoReference = () => "KB-" + Array.from({ length: 6 }, () => "0123456789ABCDEF"[Math.floor(Math.random() * 16)]).join("");

/** POST a submission. Never throws. */
export async function submitPublicForm(token: string, s: PublicFormSubmission, opts: PublicFormCallOptions = {}): Promise<PublicSubmitResult> {
  try {
    if (token === DEMO_PUBLIC_TOKEN) {
      // the preview: same checks, nothing sent anywhere
      await sleep(opts.demoDelayMs ?? 600);
      const errors = validateSubmission(demoPublicForm(), s);
      const keys = Object.keys(errors) as (keyof PublicFormSubmission)[];
      if (keys.length) return { ...failed("invalid", errors[keys[0]]), field: keys[0], fields: errors };
      return { ok: true, reference: demoReference() };
    }
    if (!isPublicToken(token)) return failed("not_found");
    const base = opts.baseUrl ?? envBase();
    if (!base) return failed("unavailable");
    if (isOffline()) return failed("network");
    const { res, body } = await call(publicFormEndpoint(token, base), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(submissionBody(s)),
    }, opts);
    if (res.ok && body?.ok === true && typeof body.reference === "string") {
      return { ok: true, reference: String(body.reference).slice(0, 40) };
    }
    if (res.ok) return failed("unavailable");
    return failureFrom(res, body);
  } catch {
    return failed("network");
  }
}

/* ---------------- in the app: switching the link ---------------- */

export type PublicLinkErrorCode = "unavailable" | "forbidden" | "offline" | "failed" | "pending";

/** A refusal from setFormPublic / regenerateFormLink: `code` says which (the panel words it). */
export class PublicLinkError extends Error {
  constructor(public code: PublicLinkErrorCode, message: string) {
    super(message);
    this.name = "PublicLinkError";
  }
}

const LINK_MESSAGES: Record<PublicLinkErrorCode, string> = {
  unavailable: "Public links aren't switched on for Kanbo yet.",
  forbidden: "You can't change this form's link. Ask someone who can edit the form.",
  offline: "You're offline. Try again when you're back online.",
  failed: "That didn't save. Try again in a moment.",
  pending: "This form is still being saved. Try again in a moment.",
};

/** 0043 missing: an unknown column or function, a missing table. */
export function isMissingFeature(e: unknown): boolean {
  const err = e as { code?: string; message?: string; status?: number } | null;
  const code = String(err?.code ?? "");
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(code)
    || err?.status === 404
    || /does not exist|schema cache|could not find the/i.test(String(err?.message ?? ""));
}

function linkError(e: unknown): PublicLinkError {
  if (e instanceof PublicLinkError) return e;
  if (isMissingFeature(e)) return new PublicLinkError("unavailable", LINK_MESSAGES.unavailable);
  const msg = String((e as { message?: string } | null)?.message ?? "");
  if (/form not found|not authori[sz]ed|permission denied|row-level security|42501/i.test(msg) || (e as { code?: string })?.code === "42501") {
    return new PublicLinkError("forbidden", LINK_MESSAGES.forbidden);
  }
  if (isOffline() || /failed to fetch|network|load failed/i.test(msg)) return new PublicLinkError("offline", LINK_MESSAGES.offline);
  return new PublicLinkError("failed", LINK_MESSAGES.failed);
}

/** Switch the public link on/off; returns the row's state afterwards (switching on mints a token). Throws on refusal. */
export async function setFormPublic(formId: string, enabled: boolean): Promise<{ publicEnabled: boolean; publicToken: string | null }> {
  // demo: nothing to save; every demo form previews at /f/demo
  if (!supabase) return { publicEnabled: enabled, publicToken: DEMO_PUBLIC_TOKEN };
  if (!formId || formId.startsWith("tmp-")) throw new PublicLinkError("pending", LINK_MESSAGES.pending);
  if (isOffline()) throw new PublicLinkError("offline", LINK_MESSAGES.offline);
  type Row = { public_enabled?: boolean | null; public_token?: string | null };
  let data: Row | null = null;
  try {
    const r = await supabase.from("forms").update({ public_enabled: enabled }).eq("id", formId).select("public_enabled, public_token").maybeSingle();
    if (r.error) throw r.error;
    data = (r.data as Row | null) ?? null;
  } catch (e) {
    throw linkError(e);
  }
  // RLS: nothing updated (a guest, a removed member, a deleted form)
  if (!data) throw new PublicLinkError("forbidden", LINK_MESSAGES.forbidden);
  return { publicEnabled: !!data.public_enabled, publicToken: typeof data.public_token === "string" ? data.public_token : null };
}

/** "Regenerate link": a new token (the old link stops working). Throws on refusal. */
export async function regenerateFormLink(formId: string): Promise<string> {
  if (!supabase) return DEMO_PUBLIC_TOKEN;
  if (!formId || formId.startsWith("tmp-")) throw new PublicLinkError("pending", LINK_MESSAGES.pending);
  if (isOffline()) throw new PublicLinkError("offline", LINK_MESSAGES.offline);
  let token: unknown;
  try {
    const r = await supabase.rpc("rotate_form_public_token", { p_form: formId });
    if (r.error) throw r.error;
    token = r.data;
  } catch (e) {
    throw linkError(e);
  }
  if (!isPublicToken(token)) throw new PublicLinkError("failed", LINK_MESSAGES.failed);
  return token;
}

/* ---------------- is it all switched on? ---------------- */

export interface PublicLinksStatus {
  /** can forms be switched public (0043)? "demo" without a backend */
  links: "demo" | "ready" | "unavailable" | "unknown";
  /** does the public page answer (the public-form function is deployed)? */
  page: "demo" | "live" | "missing" | "unknown";
}

let linksProbe: Promise<PublicLinksStatus["links"]> | null = null;
let pageProbe: Promise<PublicLinksStatus["page"]> | null = null;

/** Probe once per session (an "unknown" answer is tried again next time). Never throws. */
export async function publicLinksStatus(opts: PublicFormCallOptions & { checkPage?: boolean } = {}): Promise<PublicLinksStatus> {
  if (!supabase) return { links: "demo", page: "demo" };
  const db = supabase;
  if (!linksProbe) {
    linksProbe = (async (): Promise<PublicLinksStatus["links"]> => {
      try {
        const { error } = await db.from("forms").select("public_enabled").limit(0);
        if (!error) return "ready";
        return isMissingFeature(error) ? "unavailable" : "unknown";
      } catch { return "unknown"; }
    })();
  }
  const links = await linksProbe;
  if (links === "unknown") linksProbe = null;
  if (!opts.checkPage) return { links, page: "unknown" };
  if (!pageProbe) {
    pageProbe = (async (): Promise<PublicLinksStatus["page"]> => {
      try {
        const base = opts.baseUrl ?? envBase();
        if (!base) return "unknown";
        const { res, body } = await call(`${base}/functions/v1/public-form?ping`, { method: "GET" }, { ...opts, timeoutMs: opts.timeoutMs ?? 8000 });
        if (res.ok && body?.ok === true) return "live";
        return res.status === 404 ? "missing" : "unknown";
      } catch { return "unknown"; }
    })();
  }
  const page = await pageProbe;
  if (page === "unknown") pageProbe = null;
  return { links, page };
}

/** Tests: forget the cached probes. */
export function resetPublicLinksStatus(): void {
  linksProbe = null;
  pageProbe = null;
}

/* ---------------- the public page's theme ---------------- */

/**
 * The public page is Paper unless the visitor's system is dark. It ignores
 * the app's saved theme (a requester isn't a Kanbo user). Sets data-theme on
 * <html> now and follows system changes; returns the clean-up.
 */
export function applyPublicTheme(): () => void {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement;
  let mq: MediaQueryList | null = null;
  try { mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null; } catch { mq = null; }
  const set = () => root.setAttribute("data-theme", mq?.matches ? "dark" : "light");
  set();
  if (!mq) return () => {};
  const on = () => set();
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", on);
  else mq.addListener?.(on);
  return () => {
    if (typeof mq!.removeEventListener === "function") mq!.removeEventListener("change", on);
    else mq!.removeListener?.(on);
  };
}

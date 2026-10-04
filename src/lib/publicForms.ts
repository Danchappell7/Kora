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
          200 { ok: true, reference: string }  ("KB-7F3A")
          400 { reason: "invalid", error, field?: keyof PublicFormSubmission }
          404 / 410 / 429 as above
   The page lives at /f/:token (src/public/PublicFormPage.tsx, rendered by
   main.tsx before auth). /f/demo previews it with demo data.
   CONTRACT STUB — f9 replaces the bodies (publicFormTokenFromPath is final),
   keeps every exported name/signature.
   ============================================================ */
import type { PublicFormLoad, PublicFormResult, PublicFormSchema, PublicFormSubmission } from "../data/types";

/** The token /f/demo uses: the page renders demoPublicForm() and fakes a submission. */
export const DEMO_PUBLIC_TOKEN = "demo";

/** Length caps (characters) the page enforces and the server re-checks. */
export const PUBLIC_LIMITS = { title: 200, name: 120, email: 254, description: 5000 } as const;

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

/** The form /f/demo shows. */
export function demoPublicForm(): PublicFormSchema {
  return { name: "Design requests", intro: "Tell us what you need and we'll pick it up.", project: { name: "Website refresh", emoji: "🎨", color: "oklch(0.62 0.16 293)" }, workspace: { name: "Foundrise" }, fields: ["description", "priority", "dueDate"] };
}

/** Field → message for everything wrong with a submission ({} = fine to send). */
export function validateSubmission(form: PublicFormSchema, s: PublicFormSubmission): Partial<Record<keyof PublicFormSubmission, string>> {
  void form; void s;
  return {};
}

/** GET the form's public schema. Never throws. */
export async function loadPublicForm(token: string): Promise<PublicFormLoad> {
  void token;
  return { ok: false, reason: "unavailable", message: "This form isn't available right now." };
}

/** POST a submission. Never throws. */
export async function submitPublicForm(token: string, s: PublicFormSubmission): Promise<PublicFormResult> {
  void token; void s;
  return { ok: false, reason: "unavailable", message: "This form isn't available right now." };
}

/** Switch the public link on/off; returns the row's state afterwards (switching on mints a token). Throws on refusal. */
export async function setFormPublic(formId: string, enabled: boolean): Promise<{ publicEnabled: boolean; publicToken: string | null }> {
  void formId; void enabled;
  throw new Error("Public links aren't available yet.");
}

/** "Regenerate link": a new token (the old link stops working). Throws on refusal. */
export async function regenerateFormLink(formId: string): Promise<string> {
  void formId;
  throw new Error("Public links aren't available yet.");
}

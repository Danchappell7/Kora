// ============================================================
// KANBO — shared email helpers for Edge Functions (Resend).
// One branded layout, strict HTML escaping of every interpolated value, a
// plain-text alternative for deliverability, and one retry on Resend's 429/5xx.
// Pure module (no Deno globals) so vitest can test it: see email.test.ts.
// ============================================================
import type { Db } from "./limits.ts";

export const DEFAULT_APP_URL = "https://www.kanbo.co.uk";
export const BRAND = "#8B5CF6";

/** HTML-escape text AND attribute values (quotes included). */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

/** Collapse newlines/whitespace and cap length — for subjects and inline names. */
export function oneLine(s: unknown, max = 140): string {
  const t = String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const isUuid = (s: unknown) => typeof s === "string" && UUID_RE.test(s);
export const isEmail = (s: unknown) => typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s);

/** APP_URL without trailing slashes; only http(s) is accepted. */
export function appUrlFrom(raw: string | undefined | null): string {
  const u = String(raw ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : DEFAULT_APP_URL;
}

/**
 * Scanner-safe auth link: the app shows a "Continue" button and only calls
 * supabase.auth.verifyOtp({ token_hash, type }) when the person clicks it, so
 * corporate link scanners (Safe Links, Mimecast) can't burn the one-time token.
 */
export function tokenLink(appUrl: string, hashedToken: string, type: "invite" | "recovery"): string {
  return `${appUrlFrom(appUrl)}/?token_hash=${encodeURIComponent(hashedToken)}&type=${type}`;
}

/** Escape LIKE/ILIKE wildcards so a pattern matches the literal text only. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export interface Layout {
  heading: string;          // plain text (escaped here)
  paragraphs: string[];     // trusted HTML fragments — escape anything user-supplied BEFORE passing
  cta?: { label: string; href: string };
  footnotes?: string[];     // trusted HTML fragments
}

/** Branded HTML + plain-text bodies. */
export function renderEmail(l: Layout): { html: string; text: string } {
  const p = (h: string) => `<p style="margin:0 0 14px;color:#3f3f46;font-size:15px;line-height:1.6">${h}</p>`;
  const html =
    `<div style="background:#f5f6f9;padding:28px 12px">` +
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7e7ee;border-radius:14px;padding:28px 26px;color:#18181b">` +
    `<div style="font-weight:700;font-size:15px;letter-spacing:.2px;color:${BRAND};margin:0 0 18px">Kanbo</div>` +
    `<h1 style="font-weight:700;font-size:21px;line-height:1.3;margin:0 0 14px;color:#18181b">${esc(l.heading)}</h1>` +
    l.paragraphs.map(p).join("") +
    (l.cta
      ? `<p style="margin:22px 0 22px"><a href="${esc(l.cta.href)}" style="display:inline-block;background:${BRAND};color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px">${esc(l.cta.label)}</a></p>`
      : "") +
    (l.footnotes ?? []).map((f) => `<p style="margin:0 0 8px;color:#71717a;font-size:12.5px;line-height:1.55">${f}</p>`).join("") +
    `</div></div>`;
  const text = [
    l.heading,
    ...l.paragraphs.map(htmlToText),
    ...(l.cta ? [`${l.cta.label}: ${l.cta.href}`] : []),
    ...(l.footnotes?.length ? [l.footnotes.map(htmlToText).join("\n")] : []),
  ].join("\n\n");
  return { html, text };
}

function htmlToText(h: string): string {
  return h.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export interface MailConfig { resendKey?: string | null; from?: string | null }
export interface Mail { to: string | string[]; subject: string; html: string; text?: string; replyTo?: string }
export interface SendResult { ok: boolean; status: number; error?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send through Resend; retries once on 429/5xx. Never throws. */
export async function sendEmail(cfg: MailConfig, m: Mail, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  if (!cfg.resendKey) return { ok: false, status: 0, error: "RESEND_API_KEY is not set" };
  const body = JSON.stringify({
    from: cfg.from || "Kanbo <onboarding@resend.dev>",
    to: m.to,
    subject: oneLine(m.subject, 180),
    html: m.html,
    ...(m.text ? { text: m.text } : {}),
    ...(m.replyTo ? { reply_to: m.replyTo } : {}),
  });
  let last: SendResult = { ok: false, status: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.resendKey}`, "Content-Type": "application/json" },
        body,
      });
      if (r.ok) return { ok: true, status: r.status };
      const detail = (await r.text().catch(() => "")).slice(0, 500);
      last = { ok: false, status: r.status, error: detail };
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      last = { ok: false, status: 0, error: String((e as Error)?.message ?? e) };
    }
    if (attempt === 0) await sleep(1200);
  }
  console.error("[email] resend failed", last.status, last.error);
  return last;
}

/**
 * Who hears about new access requests: the ADMIN_NOTIFY_EMAIL secret (comma or
 * semicolon separated) plus every platform admin (profiles.is_admin, not
 * suspended). De-duplicated, lower-cased, capped at 20.
 */
export async function adminRecipients(db: Db, notifyEnv: string | undefined | null): Promise<string[]> {
  const out = new Set<string>();
  for (const e of String(notifyEnv ?? "").split(/[,;\s]+/)) {
    const v = e.trim().toLowerCase();
    if (isEmail(v)) out.add(v);
  }
  try {
    const { data, error } = await db.from("profiles").select("email,suspended").eq("is_admin", true).limit(50);
    if (error) console.warn("[email] couldn't list admins:", error.message);
    for (const r of (data ?? []) as { email: string | null; suspended: boolean | null }[]) {
      const v = String(r.email ?? "").trim().toLowerCase();
      if (!r.suspended && isEmail(v)) out.add(v);
    }
  } catch (e) {
    console.warn("[email] couldn't list admins:", e);
  }
  return [...out].slice(0, 20);
}

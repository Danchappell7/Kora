// ============================================================
// KANBO — Slack app: the Slack Web API, as the slack-app function uses it. [0049]
//
//   call(method, args)    POST https://slack.com/api/<method> with the bot
//                         token (form-encoded; objects and arrays as JSON
//                         strings, which every method accepts). Answers
//                         Slack's own { ok, error, … } — never throws.
//   respond(url, body)    POST to a response_url Slack gave us (slash
//                         commands, buttons): only https://hooks.slack.com/…,
//                         never redirected, never anywhere else.
//
// The token is only ever in the Authorization header: never in a URL, a
// log line or an error (errors are reduced to Slack's error word or
// "timeout" / "unreachable"). Methods used and their scopes:
//   views.open / views.update / views.publish      (none beyond the app's)
//   chat.postEphemeral                              chat:write
//   chat.unfurl                                     links:write
//   chat.getPermalink                               (none: any channel the app can see)
//   users.info                                      users:read, users:read.email
//
// Pure (fetch is passed in): vitest runs it (slackAppApi.test.ts).
// ============================================================

export interface SlackApiAnswer {
  ok: boolean;
  /** Slack's error word ("not_in_channel", "ratelimited", "expired_trigger_id"…) or ours ("timeout", "unreachable", "bad_reply") */
  error?: string;
  /** seconds, on ratelimited */
  retryAfter?: number;
  [key: string]: unknown;
}

export interface SlackApi {
  call(method: string, args: Record<string, unknown>): Promise<SlackApiAnswer>;
  respond(responseUrl: string, body: object): Promise<boolean>;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** The only methods the app calls (anything else is refused before it leaves). */
export const SLACK_METHODS = new Set([
  "views.open", "views.update", "views.publish", "chat.postEphemeral", "chat.unfurl", "chat.getPermalink", "users.info",
]);

/** A response_url Slack would give: https://hooks.slack.com/commands|actions|app/… */
export const RESPONSE_URL_RE = /^https:\/\/hooks\.slack\.com\/(?:commands|actions|app)\/[A-Za-z0-9_/.-]+$/;

export function isResponseUrl(url: unknown): url is string {
  return typeof url === "string" && url.length <= 500 && RESPONSE_URL_RE.test(url);
}

/** args → application/x-www-form-urlencoded (objects as JSON; null/undefined dropped). */
export function formBody(args: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    p.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return p.toString();
}

export function slackApi(token: string, opts: { fetch: FetchFn; timeoutMs?: number; base?: string }): SlackApi {
  const base = (opts.base ?? "https://slack.com/api").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 8000;
  return {
    async call(method, args) {
      if (!SLACK_METHODS.has(method)) return { ok: false, error: "method_not_allowed" };
      if (!token) return { ok: false, error: "not_configured" };
      let res: Response;
      try {
        res = await opts.fetch(`${base}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", Authorization: `Bearer ${token}` },
          body: formBody(args),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable" };
      }
      if (res.status === 429) {
        const s = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
        await res.body?.cancel().catch(() => {});
        return { ok: false, error: "ratelimited", retryAfter: Number.isFinite(s) && s > 0 ? Math.min(s, 3600) : 30 };
      }
      let data: unknown = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: res.ok ? "bad_reply" : `http_${res.status}` };
      const d = data as Record<string, unknown>;
      const error = typeof d.error === "string" && /^[a-z0-9_]{1,80}$/.test(d.error) ? d.error : d.ok === true ? undefined : "unknown_error";
      return { ...d, ok: d.ok === true, ...(error ? { error } : {}) };
    },
    async respond(responseUrl, body) {
      if (!isResponseUrl(responseUrl)) return false;
      try {
        const res = await opts.fetch(responseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(body),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        await res.body?.cancel().catch(() => {});
        return res.status >= 200 && res.status < 300;
      } catch {
        return false;
      }
    },
  };
}

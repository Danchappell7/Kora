// ============================================================
// KANBO — the Slack message a task came from (tasks.slack_permalink, 0049).
//
// The same rule as the database's tasks_slack_permalink_shape check: an
// https link to a message in a Slack workspace (or an Enterprise Grid org),
// as chat.getPermalink returns it, at most 500 characters. Anything else is
// not shown and not stored: the task's "From Slack" chip, the API's
// slackPermalink and webhook payloads all read it through slackPermalinkOf().
//
// Pure: no Deno globals, no imports (the app, the API serialiser and the
// slack-app edge function all use it).
// ============================================================

/** chat.getPermalink's shape: https://<team>.slack.com/archives/<channel>/p<ts>[?thread_ts=…&cid=…]. */
export const SLACK_PERMALINK_RE = /^https:\/\/[A-Za-z0-9-]+(\.enterprise)?\.slack\.com\/archives\/[A-Z0-9]+\/p[0-9]+(\?[A-Za-z0-9=&._%-]*)?$/;
export const SLACK_PERMALINK_MAX = 500;

/** True for a Slack message link Kanbo will keep and show. */
export function isSlackPermalink(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= SLACK_PERMALINK_MAX && SLACK_PERMALINK_RE.test(v);
}

/** The value as a permalink, or null (missing, or not a Slack message link). */
export function slackPermalinkOf(v: unknown): string | null {
  return isSlackPermalink(v) ? v : null;
}

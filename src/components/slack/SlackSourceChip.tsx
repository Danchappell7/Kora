/* ============================================================
   KANBO — "From Slack": the message a task was made from.        [0049]
   A small chip in TaskDetail when the task carries a Slack message link
   (tasks.slack_permalink, set by the Kanbo Slack app's "Create a Kanbo
   task" shortcut). Opens the message in Slack in a new tab. Only a real
   Slack message link is ever shown (the database's own rule, shared via
   slackPermalink.ts); anything else renders nothing.
   Mount (integrator): TaskDetail, beside the Notion links —
     <SlackSourceChip permalink={task.slackPermalink} />
   ============================================================ */
import { Icon } from "../primitives";
import { isSlackPermalink } from "../../lib/slackApp";
import "./slackApp.css";

export interface SlackSourceChipProps {
  /** tasks.slack_permalink (null / anything that isn't a Slack message link → nothing) */
  permalink?: string | null;
}

export function SlackSourceChip({ permalink }: SlackSourceChipProps) {
  if (!isSlackPermalink(permalink)) return null;
  const where = /^https:\/\/([a-z0-9-]+)\./i.exec(permalink)?.[1] ?? "Slack";
  return (
    <div className="kslka-src-wrap">
      <a className="kslka-src" href={permalink} target="_blank" rel="noopener noreferrer"
        aria-label={`From Slack: open the message in ${where}.slack.com (opens in a new tab)`}>
        <Icon name="message" size={14} sw={1.75} />
        <span>From Slack</span>
        <Icon name="arrowUpRight" size={12} sw={2} />
      </a>
    </div>
  );
}

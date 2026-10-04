/* ============================================================
   KANBO — Settings › Calendar & integrations › Slack.            [f6-slack]
   Owners/admins: paste an Incoming Webhook URL (Connect), Send test,
   Disconnect, daily stand-up auto-post on/off + time. Members/guests: see
   whether it's connected (and to which channel label), nothing else.
   Personal workspace: explains Slack is per team workspace.
   Demo: works against lib/slack's in-memory fake.
   Mount (integrator): inside SettingsModal's calendar section, after the
   Calendars group, with the active workspace.
   CONTRACT STUB — f6 replaces the body, keeps the name and props.
   ============================================================ */
import type { Role } from "../../data/types";

export interface SlackSettingsPanelProps {
  /** the active workspace (null = Personal) */
  workspaceId: string | null;
  workspaceName?: string;
  /** the viewer's role there (owner/admin manage; the server re-checks) */
  role?: Role | null;
}

export function SlackSettingsPanel(props: SlackSettingsPanelProps) {
  void props;
  return null;
}

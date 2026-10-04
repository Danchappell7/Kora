/* ============================================================
   KANBO — "Post to Slack".                                       [f6-slack]
   Renders nothing unless the workspace has Slack connected and the viewer
   may post (owner/admin/member; never guests). Click → posts getText()
   through lib/slack postToSlack, then shows Posted / the reason it failed
   (toast when a ToastProvider is present, else inline status).
   Mount (integrator): Team › Pulse header (kind "standup"), Radar panel
   (kind "risks"), the project Updates composer (kind "status").
   CONTRACT STUB — f6 replaces the body, keeps the name and props.
   ============================================================ */
import type { SlackPostKind, StatusKind } from "../../data/types";
import type { CtlSize } from "../primitives";

export interface SlackPostButtonProps {
  workspaceId: string | null;
  kind: SlackPostKind;
  /** the text to post, read at click time (Pulse write-up, the update, Radar's summary) */
  getText: () => string;
  /** kind "status": the project, and its status */
  projectId?: string;
  status?: StatusKind;
  /** optional heading override */
  title?: string;
  size?: CtlSize;
  variant?: "secondary" | "ghost";
  /** default "Post to Slack" */
  label?: string;
  disabled?: boolean;
  onPosted?: () => void;
}

export function SlackPostButton(props: SlackPostButtonProps) {
  void props;
  return null;
}

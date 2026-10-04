/* ============================================================
   KANBO — "Post to Slack".                                       [f6-slack]
   Renders nothing unless the workspace has Slack connected and the viewer
   may post (owner/admin/member; never guests). Click → posts getText()
   through lib/slack postToSlack, then shows Posted / the reason it failed
   (toast when a ToastProvider is present, else inline status).
   Mount (integrator): Team › Pulse header (kind "standup"), Radar panel
   (kind "risks"), the project Updates composer (kind "status").
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import type { SlackPostKind, StatusKind } from "../../data/types";
import { Button, Icon, type CtlSize } from "../primitives";
import { useOptionalToast } from "../rituals/shared";
import { postToSlack, SLACK_COPY } from "../../lib/slack";
import { useSlackStatus } from "./useSlackStatus";
import "./slack.css";

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

/** How long "Posted" stays on the button. */
const POSTED_MS = 3000;

export function SlackPostButton({ workspaceId, kind, getText, projectId, status, title, size = "sm", variant = "secondary", label = "Post to Slack", disabled, onPosted }: SlackPostButtonProps) {
  const { status: slack } = useSlackStatus(workspaceId);
  const toast = useOptionalToast();
  const [phase, setPhase] = useState<"idle" | "posting" | "posted">("idle");
  const [note, setNote] = useState<{ tone: "ok" | "signal"; text: string } | null>(null);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => { alive.current = false; clearTimeout(timer.current); }, []);

  if (!workspaceId || !slack?.connected || !slack.canPost) return null;
  const where = slack.channelLabel || "Slack";

  const say = (tone: "ok" | "signal", text: string) => {
    if (toast) { if (tone === "ok") toast.success(text); else toast.error(text); }
    else setNote({ tone, text });
  };

  const post = async () => {
    if (phase === "posting") return;
    clearTimeout(timer.current);
    setNote(null);
    let text = "";
    try { text = getText()?.trim() ?? ""; } catch { text = ""; }
    if (!text) { say("signal", SLACK_COPY.nothingToPost); return; }
    setPhase("posting");
    const r = await postToSlack(workspaceId, { kind, text, projectId, status, title });
    if (!alive.current) return;
    if (r.ok) {
      setPhase("posted");
      say("ok", `Posted to ${where}`);
      onPosted?.();
      timer.current = setTimeout(() => { if (alive.current) { setPhase("idle"); setNote(null); } }, POSTED_MS);
    } else {
      setPhase("idle");
      say("signal", r.message);
    }
  };

  const posted = phase === "posted";
  return (
    <span className="kslk-post" data-kind={kind}>
      <Button size={size} variant={variant} icon={posted ? "check" : "send"} loading={phase === "posting"}
        disabled={disabled} onClick={() => void post()} data-posted={posted || undefined}
        aria-label={posted ? `Posted to ${where}` : label === "Post to Slack" && slack.channelLabel ? `Post to Slack, ${slack.channelLabel}` : undefined}>
        {phase === "posting" ? "Posting…" : posted ? "Posted" : label}
      </Button>
      {!toast && (
        <span className="kslk-post-note" role="status" data-tone={note?.tone}>
          {note && <>{note.tone === "ok" ? <Icon name="check" size={14} sw={2} /> : <Icon name="alert" size={14} sw={2} />}<span>{note.text}</span></>}
        </span>
      )}
    </span>
  );
}

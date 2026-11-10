/* ============================================================
   KANBO — "Run meeting" (Team › Pulse, each business on the Group
   page, and the Group page itself). When a meeting is already live
   there it says so instead: "Join · Live" opens it, presenter and all.
   The host decides who sees it (never a guest); this only asks the
   meeting host (MeetingsHost) to start or open one.
   ============================================================ */
import { Button } from "../primitives";
import { requestMeetingOpen, requestMeetingStart, useLiveMeetings, type MeetingScope } from "./meetingBus";
import "./meetings.css";

export function RunMeetingButton({ scope, size = "sm", variant = "secondary", label = "Run meeting" }: {
  scope: MeetingScope;
  size?: "sm" | "md";
  variant?: "secondary" | "ghost" | "primary";
  label?: string;
}) {
  const wss = scope.workspaceIds?.length ? scope.workspaceIds : [scope.workspaceId];
  const live = useLiveMeetings([scope.workspaceId]).find((m) => {
    if (m.workspaceId !== scope.workspaceId) return false;
    // a Group meeting is the one over the same businesses; a business's own, any of its meetings
    return scope.workspaceIds?.length ? [...m.workspaceIds].sort().join(",") === [...wss].sort().join(",") : m.workspaceIds.length === 1;
  });
  if (live) {
    return (
      <Button size={size} variant={variant === "ghost" ? "ghost" : "secondary"} className="kmtg-join" onClick={() => requestMeetingOpen(live.id)}
        title={live.title} aria-label={`Join ${live.title}, live now`}>
        <span className="kmtg-livedot" aria-hidden="true" />Join · Live
      </Button>
    );
  }
  return (
    <Button size={size} variant={variant} icon="play" onClick={() => requestMeetingStart(scope)}>{label}</Button>
  );
}

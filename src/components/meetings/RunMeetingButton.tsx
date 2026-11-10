/* ============================================================
   KANBO — "Run meeting" (Team › Pulse, each business on the Group
   page, and the Group page itself). When a meeting of its kind is
   already live there (over the same businesses, whichever hosts it)
   it says so instead: "Join · Live" opens it, presenter and all. A
   live meeting of the other kind sits beside Run meeting, never in
   its way; one left running over 12 hours isn't offered at all.
   The host decides who sees it (never a guest); this only asks the
   meeting host (MeetingsHost) to start or open one.
   ============================================================ */
import { Button } from "../primitives";
import { sameBusinesses } from "../../lib/meetings/sync";
import type { Meeting } from "../../lib/meetings/types";
import { requestMeetingOpen, requestMeetingStart, useLiveMeetings, type MeetingScope } from "./meetingBus";
import "./meetings.css";

export function RunMeetingButton({ scope, size = "sm", variant = "secondary", label = "Run meeting" }: {
  scope: MeetingScope;
  size?: "sm" | "md";
  variant?: "secondary" | "ghost" | "primary";
  label?: string;
}) {
  const wss = scope.workspaceIds?.length ? scope.workspaceIds : [scope.workspaceId];
  // (a Group meeting's host can be any of its businesses: watch them all, and match the set)
  const here = useLiveMeetings(wss).filter((m) => sameBusinesses(m.workspaceIds, wss));
  const live = here.find((m) => m.preset === scope.preset);
  // the other kind running here (a leadership meeting beside the team's): joinable, and never in the way
  const other = !live ? here.find((m) => m.preset !== scope.preset && (m.preset === "team" || scope.canLead)) : undefined;
  const join = (m: Meeting, words: string) => (
    <Button size={size} variant={variant === "ghost" ? "ghost" : "secondary"} className="kmtg-join" onClick={() => requestMeetingOpen(m.id)}
      title={m.title} aria-label={`Join ${m.title}, live now`}>
      <span className="kmtg-livedot" aria-hidden="true" />{words}
    </Button>
  );
  if (live) return join(live, "Join · Live");
  return (
    <>
      {other && join(other, other.preset === "leadership" ? "Leadership · Live" : "Team meeting · Live")}
      <Button size={size} variant={variant} icon="play" onClick={() => requestMeetingStart(scope)}>{label}</Button>
    </>
  );
}

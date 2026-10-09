/* ============================================================
   KANBO — who else is here: a small avatar stack.      [0048 stub → u5]
   For the task panel header and the doc header ("Sana is viewing" as the
   accessible name and tooltip), and tiny ones on list rows / board cards
   being viewed by others. Up to `max` faces then "+2"; each face in the
   person's colour (the primitives' Avatar); a soft ring pulse on join
   (none with reduced motion). Nothing when there's nobody.
   Renders nothing until package u5 builds it.
   ============================================================ */
import type { PresencePeer } from "../../data/types";

export interface PresenceAvatarsProps {
  peers: PresencePeer[];
  /** faces before "+n" (default 3) */
  max?: number;
  size?: "xs" | "sm" | "md";
  /** override the sentence ("Sana is viewing") used as the label */
  label?: string;
}

export function PresenceAvatars(_props: PresenceAvatarsProps) {
  return null;
}

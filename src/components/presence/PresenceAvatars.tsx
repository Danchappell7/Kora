/* ============================================================
   KANBO — who else is here: a small avatar stack.      [0048, u5]
   For the task panel header and the doc header ("Sana is viewing" as the
   accessible name and tooltip), and tiny ones on list rows / board cards
   being viewed by others. Up to `max` faces then "+2"; each face in the
   person's colour (their photo when the app has one, else initials on
   their hue, exactly as Avatar paints them) with a ring in that colour;
   a soft ring pulse on join (none with reduced motion). Nothing when
   there's nobody.
   Keyboard: the header sizes are a tab stop that shows the sentence (the
   tooltip) on focus; the row size isn't (a row has its own name, and the
   integrator puts the sentence in it).
   ============================================================ */
import type { CSSProperties } from "react";
import type { PresencePeer } from "../../data/types";
import { getMember, memberInitials } from "../../data/data";
import { peerHue, presenceSentence } from "./core";
import "./presence.css";

export interface PresenceAvatarsProps {
  peers: PresencePeer[];
  /** faces before "+n" (default 3) */
  max?: number;
  size?: "xs" | "sm" | "md";
  /** override the sentence ("Sana is viewing") used as the label */
  label?: string;
}

const SIZES = { xs: { px: 16, type: 9, ring: 2.5 }, sm: { px: 20, type: 10, ring: 3 }, md: { px: 24, type: 10, ring: 3.5 } } as const;

/** The verb that fits everyone: all typing / all editing, else viewing. */
export function presenceVerb(peers: readonly Pick<PresencePeer, "state">[]): "viewing" | "typing" | "editing" {
  if (peers.length && peers.every((p) => p.state === "typing")) return "typing";
  if (peers.length && peers.every((p) => p.state !== "viewing")) return "editing";
  return "viewing";
}

export function PresenceAvatars({ peers, max = 3, size = "sm", label }: PresenceAvatarsProps) {
  if (!peers.length) return null;
  const s = SIZES[size];
  const cap = Math.max(1, max);
  const faces = peers.length > cap ? peers.slice(0, cap) : peers;
  const more = peers.length - faces.length;
  const sentence = label ?? presenceSentence(peers, presenceVerb(peers));
  const focusable = size !== "xs";
  return (
    <span className="kpres" data-size={size} role="img" aria-label={sentence} data-tip={sentence} data-tip-pos="bottom"
      tabIndex={focusable ? 0 : undefined} style={{ "--kp-size": `${s.px}px`, "--kp-type": `${s.type}px`, "--kp-ring": `${s.ring}px` } as CSSProperties}>
      {faces.map((p) => {
        const photo = getMember(p.userId)?.avatarUrl;
        return (
          <span key={p.userId} className="kpres-face" aria-hidden="true" style={{ "--kp-h": peerHue(p.color) } as CSSProperties}>
            {photo ? <img src={photo} alt="" /> : size === "xs" ? memberInitials(p.name).slice(0, 1) : memberInitials(p.name)}
          </span>
        );
      })}
      {more > 0 && <span className="kpres-more" aria-hidden="true">+{more}</span>}
    </span>
  );
}

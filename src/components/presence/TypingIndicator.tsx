/* ============================================================
   KANBO — "Theo is typing…" under the task comment box.  [0048 stub → u5]
   A polite live region (announced once per person, not per keystroke);
   three dots that breathe (still with reduced motion). Nothing when nobody
   is typing.
   Renders nothing until package u5 builds it.
   ============================================================ */
import type { PresencePeer } from "../../data/types";

export interface TypingIndicatorProps {
  typers: PresencePeer[];
}

export function TypingIndicator(_props: TypingIndicatorProps) {
  return null;
}

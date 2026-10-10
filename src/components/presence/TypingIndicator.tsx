/* ============================================================
   KANBO — "Theo is typing…" under the task comment box.  [0048, u5]
   A polite live region (announced once per person, not per keystroke:
   someone who keeps starting and stopping is said again only after a
   minute); three dots that breathe (still with reduced motion). Nothing
   when nobody is typing (the live region stays, empty, so the first
   announcement is heard).
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import type { PresencePeer } from "../../data/types";
import { presenceSentence } from "./core";
import "./presence.css";

export interface TypingIndicatorProps {
  typers: PresencePeer[];
}

/** a person is announced again after this long */
export const TYPING_ANNOUNCE_AGAIN_MS = 60_000;

export function TypingIndicator({ typers }: TypingIndicatorProps) {
  const [said, setSaid] = useState("");
  const last = useRef(new Map<string, number>());
  const key = typers.map((t) => t.userId).join(",");
  useEffect(() => {
    if (!typers.length) return;
    const now = Date.now();
    const fresh = typers.filter((t) => now - (last.current.get(t.userId) ?? -Infinity) > TYPING_ANNOUNCE_AGAIN_MS);
    if (!fresh.length) return;
    fresh.forEach((t) => last.current.set(t.userId, now));
    const words = `${presenceSentence(fresh, "typing")}…`;
    // (the same words twice still get read out: they differ by a trailing no-break space)
    setSaid((prev) => (prev === words ? words + " " : words));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div className="ktyping" data-on={typers.length ? "true" : undefined}>
      {typers.length > 0 && (
        <span className="ktyping-vis" aria-hidden="true">
          <span className="ktyping-dots"><i /><i /><i /></span>
          <span>{presenceSentence(typers, "typing")}…</span>
        </span>
      )}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{said}</span>
    </div>
  );
}

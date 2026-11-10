/* ============================================================
   KANBO — one status pill for a project: the lead's call and Kanbo's
   read together (lib/honestStatus mergedStatus). It wears the lead's
   words; when they're rosier than the work, a small mark in Kanbo's
   colour sits on it. "Lead says … · Kanbo sees …" shows on hover and
   on keyboard focus, and is the pill's name to a screen reader.
   Portfolios (cards and table) and the Group page use it.
   ============================================================ */
import type { MergedStatus } from "../../lib/honestStatus";
import "./updates.css";

export function MergedStatusPill({ m, extra }: { m: MergedStatus; extra?: string }) {
  const tip = [m.says, m.sees, extra].filter(Boolean).join(" · ");
  return (
    <span className="kpill kup-pair" data-tone={m.tone} data-mismatch={m.mismatch || undefined} tabIndex={0} role="img"
      data-tip={tip} aria-label={`${m.label}. ${tip}.`}>
      {m.label}
      {m.mismatch && <span className="kup-pair-mark" data-tone={m.kanboTone} aria-hidden="true" />}
    </span>
  );
}

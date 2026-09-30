/* ============================================================
   KANBO — "What moved": a one-time card for people who knew the
   old layout. Five lines on where things went, then it's gone for
   good (per browser). Never shown in tests.
   Desktop: bottom right (toasts live bottom left), stepping aside
   while a task panel is open. Phones: under the header, clear of
   the bottom bar and the toasts above it.
   ============================================================ */
import { useState, type ReactNode } from "react";
import { Icon, Button, IconButton, Kbd } from "./primitives";
import type { IconName } from "../data/types";

export const WHAT_MOVED_KEY = "kanbo-what-moved-v1";

/** Has this browser already seen (or been spared) the card? */
export function whatMovedSeen(): boolean {
  try { return localStorage.getItem(WHAT_MOVED_KEY) === "1"; } catch { return true; } // no storage: never nag
}
/** Don't show it (seen, dismissed, or someone new who just toured the five places). */
export function markWhatMovedSeen(): void {
  try { localStorage.setItem(WHAT_MOVED_KEY, "1"); } catch { /* private mode */ }
}

const B = ({ children }: { children: ReactNode }) => <strong style={{ fontWeight: 600, color: "var(--ink)" }}>{children}</strong>;

const lines = (touch: boolean): { icon: IconName; text: ReactNode }[] => [
  { icon: "sun", text: <>Home and Plan my day are now <B>Today</B>.</> },
  { icon: "calendar", text: <>My week and Calendar live in <B>Today › Week</B> and <B>Month</B>.</> },
  { icon: "kanbo", text: <>Goals, Portfolios, Rules and Requests are under <B>Projects</B>.</> },
  { icon: "users", text: <>Workload and Insights are under <B>Team</B>.</> },
  touch
    ? { icon: "search", text: <>Search and Ask are behind the <B>search</B> button at the top. Type a question to ask Kanbo.</> }
    : { icon: "search", text: <>Search and Ask live in <Kbd>⌘K</Kbd>. Type a question to ask Kanbo.</> },
];

export function WhatMoved({ onShowMe, onDismiss, isMobile = false, hidden = false }: {
  /** "Show me around": opens the command bar */
  onShowMe: () => void;
  /** after either button (the card has already remembered it was seen) */
  onDismiss?: () => void;
  /** phones: full width, under the page header */
  isMobile?: boolean;
  /** stand aside for now (a task panel is open where the card sits); it comes back after */
  hidden?: boolean;
}) {
  const [open, setOpen] = useState(() => import.meta.env.MODE !== "test" && !whatMovedSeen());
  if (!open || hidden) return null;
  const close = () => { markWhatMovedSeen(); setOpen(false); onDismiss?.(); };
  return (
    <aside aria-labelledby="kwhat-title"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}
      style={{
        position: "fixed", zIndex: "var(--z-popover, 80)",
        ...(isMobile
          ? { left: 16, right: 16, top: "calc(60px + env(safe-area-inset-top, 0px))" }
          : { right: 24, bottom: 24, width: 360 }),
        padding: "16px 20px 16px",
        // raised surface laid on the canvas colour, so it's opaque in every theme
        background: "linear-gradient(var(--surface-raised), var(--surface-raised)), var(--bg)",
        borderRadius: "var(--r-lg, 12px)", boxShadow: "var(--e2, var(--shadow-lg))",
        animation: isMobile ? "fadeIn var(--d-3, 240ms) var(--ease)" : "ksheetIn var(--d-3, 240ms) var(--ease)",
      }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <h2 id="kwhat-title" style={{ flex: 1, margin: "2px 0 0", fontFamily: "var(--font-ui, var(--font-display))", fontSize: "var(--t-body, 15px)", lineHeight: "var(--lh-body, 24px)", fontWeight: 600, color: "var(--ink)" }}>
          Kanbo's had a tidy-up
        </h2>
        <IconButton icon="x" label="Dismiss" size="sm" onClick={close} style={{ marginRight: -8 }} />
      </div>
      <p style={{ margin: "2px 0 12px", fontSize: "var(--t-meta, 12px)", lineHeight: "var(--lh-meta, 16px)", color: "var(--ink-3)" }}>
        Five places instead of nineteen. Everything you used is still here.
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {lines(isMobile).map((l, i) => (
          <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: "var(--t-ui, 13px)", lineHeight: "var(--lh-ui, 20px)", color: "var(--ink-2)" }}>
            <Icon name={l.icon} size={16} style={{ flexShrink: 0, marginTop: 2, color: "var(--icon-quiet, var(--ink-4))" }} />
            <span>{l.text}</span>
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <Button variant="ghost" size="sm" onClick={() => { close(); onShowMe(); }}>Show me around</Button>
        <Button variant="primary" size="sm" onClick={close}>Got it</Button>
      </div>
    </aside>
  );
}

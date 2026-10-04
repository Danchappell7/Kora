/* ============================================================
   KANBO — Settings › Calendar & integrations › "Add Kanbo to your calendar". [f7-calendar]
   The private feed URL (copy), one-click Google Calendar, Outlook steps,
   "Include due dates" toggle, "Reset link". Demo: an example URL and a
   note that it works once signed in. Before 0043: explains it isn't
   switched on yet (never crashes).
   Mount (integrator): inside SettingsModal's calendar section.
   CONTRACT STUB — f7 replaces the body, keeps the name and props.
   ============================================================ */

export interface CalendarFeedPanelProps {
  /** called after a successful "Reset link" (e.g. to toast) */
  onReset?: () => void;
}

export function CalendarFeedPanel(props: CalendarFeedPanelProps) {
  void props;
  return null;
}

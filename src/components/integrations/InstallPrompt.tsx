/* ============================================================
   KANBO — "Install Kanbo" (the installable app).                 [f8-push-pwa]
   variant "settings": a SetRow in Settings (Install button, or the iOS
   "Share › Add to Home Screen" hint, or "Installed").
   variant "nudge": a one-time quiet sidebar card, shown only when the
   browser offers an install and the person hasn't dismissed it before
   (remembered per device); renders null otherwise.
   Reads lib/install (main.tsx calls listenForInstallPrompt() at startup).
   CONTRACT STUB — f8 replaces the body, keeps the name and props.
   ============================================================ */

export interface InstallPromptProps {
  variant: "settings" | "nudge";
  /** the nudge was dismissed or acted on (the host can stop rendering it) */
  onDismiss?: () => void;
}

export function InstallPrompt(props: InstallPromptProps) {
  void props;
  return null;
}

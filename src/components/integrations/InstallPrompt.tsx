/* ============================================================
   KANBO — "Install Kanbo" (the installable app).                 [f8-push-pwa]
   variant "settings": a SetRow for a Settings card (Install button, or
   the iOS "Share › Add to Home Screen" hint, or "Installed", or how to
   install from this browser's menu).
   variant "nudge": a one-time quiet sidebar card, shown only when the
   browser offers an install and the person hasn't dismissed it before
   (remembered per device); renders null otherwise.
   Reads lib/install (main.tsx calls listenForInstallPrompt() at startup).
   ============================================================ */
import { useEffect, useState } from "react";
import { Button, Icon, IconButton, KanboLogo } from "../primitives";
import { SetRow } from "./settingsBits";
import { useOptionalToast } from "../rituals/shared";
import { browserFamily, installState, isStandalone, onInstallStateChange, promptInstall, type InstallState } from "../../lib/install";
import "./push.css";

export interface InstallPromptProps {
  variant: "settings" | "nudge";
  /** the nudge was dismissed or acted on (the host can stop rendering it) */
  onDismiss?: () => void;
}

/** localStorage key: the nudge was dismissed (or acted on) on this device. */
export const INSTALL_NUDGE_KEY = "kanbo-install-nudge";
const nudgeDismissed = (): boolean => {
  try { return localStorage.getItem(INSTALL_NUDGE_KEY) === "dismissed"; } catch { return false; }
};
const dismissNudge = () => { try { localStorage.setItem(INSTALL_NUDGE_KEY, "dismissed"); } catch { /* private mode */ } };

function useInstallState(): InstallState {
  const [s, setS] = useState<InstallState>(() => installState());
  useEffect(() => {
    setS(installState()); // the prompt may have arrived between render and effect
    return onInstallStateChange(setS);
  }, []);
  return s;
}

/** iOS's Share glyph (a box with an arrow up), so the hint matches what's on screen. */
function ShareGlyph() {
  return (
    <svg className="kpush-share" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 3v12M8 7l4-4 4 4M7 11H5v10h14V11h-2" />
    </svg>
  );
}

const isPhone = () => {
  try { return !!window.matchMedia?.("(max-width: 859px), (pointer: coarse)").matches; } catch { return false; }
};

export function InstallPrompt({ variant, onDismiss }: InstallPromptProps) {
  const state = useInstallState();
  const toast = useOptionalToast();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(() => nudgeDismissed());

  const install = async () => {
    if (busy) return;
    setBusy(true);
    const r = await promptInstall();
    setBusy(false);
    if (variant === "nudge") { dismissNudge(); setHidden(true); onDismiss?.(); }
    if (r === "accepted") toast?.success("Kanbo is installed. Open it from your dock, Start menu or Home Screen.");
    else if (r === "unavailable") toast?.toast("Your browser didn't offer the install. Try its menu, under Install Kanbo.", "info");
  };

  if (variant === "nudge") {
    if (hidden || state !== "available") return null;
    const close = () => { dismissNudge(); setHidden(true); onDismiss?.(); };
    return (
      <div className="kpush-nudge" role="group" aria-label="Install Kanbo">
        <button type="button" className="kpush-nudge-main" onClick={() => { void install(); }} aria-busy={busy || undefined}
          aria-label={`Install Kanbo, ${isPhone() ? "on your Home Screen" : "in its own window"}`}>
          {busy ? <span className="kspin" aria-hidden="true" /> : <KanboLogo size={16} />}
          <span className="kpush-nudge-text" aria-hidden="true">
            <span className="kpush-nudge-title">Install Kanbo</span>
            <span className="kpush-nudge-sub">{isPhone() ? "On your Home Screen" : "In its own window"}</span>
          </span>
        </button>
        <IconButton size="sm" icon="x" label="Not now" onClick={close} />
      </div>
    );
  }

  // ---- Settings row ----
  const icon = <Icon name="kanbo" size={16} sw={1.75} />;
  if (state === "installed") {
    return (
      <SetRow icon={icon} label="Kanbo app"
        desc={isStandalone() ? "You're using the installed app." : "Open Kanbo from your dock, Start menu or Home Screen."}>
        <span className="kpush-state"><Icon name="check" size={14} sw={2.25} />Installed</span>
      </SetRow>
    );
  }
  if (state === "available") {
    return (
      <SetRow icon={icon} label="Install Kanbo" desc="Kanbo in its own window, one click from your dock or Home Screen. It opens straight to Today.">
        <Button size="sm" variant="primary" loading={busy} onClick={() => { void install(); }}>Install</Button>
      </SetRow>
    );
  }
  if (state === "ios") {
    return (
      <SetRow icon={icon} label="Add Kanbo to your Home Screen"
        desc={<>Tap Share<ShareGlyph />, then Add to Home Screen. On iPhone and iPad, notifications need the Home Screen app.</>} />
    );
  }
  const family = browserFamily();
  const how = family === "safari-mac" ? "In Safari, choose File, then Add to Dock."
    : family === "firefox" ? "Firefox doesn't install web apps. Chrome, Edge and Safari can, or keep using Kanbo here."
    : family === "chromium" ? "Use the install button in the address bar, or Install Kanbo in the browser's menu. It isn't offered when Kanbo is already installed."
    : "Look for Install or Add to Home Screen in your browser's menu.";
  return <SetRow icon={icon} label="Install Kanbo" desc={how} />;
}

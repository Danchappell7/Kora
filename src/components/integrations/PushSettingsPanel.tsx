/* ============================================================
   KANBO — Settings › Notifications › Push on this device.         [f8-push-pwa]
   "On this device" switch (asks permission from the click), "Send a test
   notification", and per-kind toggles (notify_prefs "<kind>_push", unset
   = on; they follow the person to every device). Hidden entirely when
   lib/push says "unconfigured" (no VAPID key, or the app isn't running the
   sign-out guard, watchPushSession, yet); explains "unsupported"
   (iPhone: add to Home Screen first) and "denied" (how to allow it again)
   instead of hiding. Demo mode: a local stand-in (the test notification
   is shown right here; nothing leaves the browser).
   Mount (integrator): in SettingsModal's notifications section, under the
   In-app / Email table, with the same notifyPrefs / onSaveNotifyPrefs.
   ============================================================ */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Icon, Pill, Toggle } from "../primitives";
import { SetGroup, SetNote, SetRow } from "./settingsBits";
import { useOptionalToast } from "../rituals/shared";
import {
  deniedMessage, disablePush, enablePush, isPushDemo, isPushOnHere, onPushChange, pushAvailability, pushPrefKey,
  PUSH_KINDS, sendTestPush, unsupportedMessage,
} from "../../lib/push";
import type { PushAvailability } from "../../data/types";
import "./push.css";

export interface PushSettingsPanelProps {
  notifyPrefs: Record<string, boolean>;
  /** saves the whole prefs object (SettingsModal's onSaveNotifyPrefs) */
  onSaveNotifyPrefs?: (prefs: Record<string, boolean>) => void;
}

type Busy = "check" | "enable" | "disable" | "test" | null;
interface Msg { tone: "signal" | "ok" | "neutral"; text: string }

export function PushSettingsPanel({ notifyPrefs, onSaveNotifyPrefs }: PushSettingsPanelProps) {
  const demo = isPushDemo();
  const toast = useOptionalToast();
  const [avail, setAvail] = useState<PushAvailability>(() => pushAvailability());
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState<Busy>("check");
  const [msg, setMsg] = useState<Msg | null>(null);
  const [live, setLive] = useState("");
  const alive = useRef(true);
  const descId = "kpush-d" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const busyRef = useRef<Busy>("check");
  const setBusyBoth = (b: Busy) => { busyRef.current = b; setBusy(b); };

  /** re-read the browser's state (permission, subscription) */
  const refresh = useCallback(async () => {
    const a = pushAvailability();
    const isOn = await isPushOnHere();
    if (!alive.current) return;
    setAvail(a);
    setOn(isOn);
    if (busyRef.current === "check") setBusyBoth(null);
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const off = onPushChange(() => { void refresh(); });
    // back from the browser's site settings, or a permission changed under us
    const onVis = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVis);
    let perm: PermissionStatus | null = null;
    const onPerm = () => { void refresh(); };
    try {
      navigator.permissions?.query({ name: "notifications" as PermissionName })
        .then((p) => { if (!alive.current) return; perm = p; p.addEventListener?.("change", onPerm); }, () => {});
    } catch { /* no Permissions API */ }
    return () => {
      alive.current = false;
      off();
      document.removeEventListener("visibilitychange", onVis);
      perm?.removeEventListener?.("change", onPerm);
    };
  }, [refresh]);

  if (!demo && avail === "unconfigured") return null;

  const say = (m: Msg | null) => { setMsg(m); setLive(m?.text ?? ""); };

  const toggleDevice = async () => {
    if (busyRef.current) return;
    say(null);
    if (on) {
      setBusyBoth("disable");
      await disablePush();
      if (!alive.current) return;
      setOn(false);
      setBusyBoth(null);
      setLive("Notifications are off for this device.");
      return;
    }
    setBusyBoth("enable");
    const r = await enablePush();
    if (!alive.current) return;
    setBusyBoth(null);
    const a = pushAvailability();
    setAvail(a);
    if (r.ok) {
      setOn(true);
      setLive("Notifications are on for this device.");
    } else if (!demo && (a === "denied" || a === "unsupported")) {
      setLive(r.message); // the row itself now explains it
    } else {
      say({ tone: r.reason === "dismissed" ? "neutral" : "signal", text: r.message });
    }
  };

  const test = async () => {
    if (busyRef.current) return;
    setBusyBoth("test");
    say(null);
    const r = await sendTestPush();
    if (!alive.current) return;
    setBusyBoth(null);
    if (r.ok) {
      setLive(r.message);
      if (toast) toast.success(r.message); else say({ tone: "ok", text: r.message });
    } else {
      say({ tone: "signal", text: r.message });
    }
  };

  const prefOn = (k: string) => notifyPrefs[k] !== false;
  const togglePref = (k: string) => onSaveNotifyPrefs?.({ ...notifyPrefs, [k]: !prefOn(k) });

  const blocked = !demo && (avail === "denied" || avail === "unsupported");
  const deviceDesc = blocked
    ? (avail === "denied" ? deniedMessage() : unsupportedMessage())
    : busy === "check" ? "Checking this device…"
    : on ? (demo ? "On. In the demo, the test notification is shown right here." : "On. Kanbo can reach this device, even when it's closed.")
    : demo ? "Try it out. The demo shows notifications on this device only."
    : "Get a notification here when something needs you, even when Kanbo is closed.";

  return (
    <div className="kpush-panel">
      <SetGroup title="Push notifications" action={demo ? <Pill tone="neutral">Demo</Pill> : undefined}>
        {/* SetRow's markup, with the description's id so the switch can point at it */}
        <div className="kset-row">
          <div className="kset-row-text">
            <span className="kset-row-label">On this device</span>
            <span id={descId} className="kset-row-desc">{deviceDesc}</span>
          </div>
          <div className="kset-row-ctl">
            {blocked ? (
              <span className="kpush-state" style={{ color: avail === "denied" ? "var(--signal, var(--st-blocked))" : "var(--ink-3)" }}>
                <Icon name={avail === "denied" ? "lock" : "alert"} size={14} sw={2} />
                {avail === "denied" ? "Blocked" : "Not available"}
              </span>
            ) : (
              <span className="kpush-ctl">
                {(busy === "enable" || busy === "disable" || busy === "check") && <span className="kspin" aria-hidden="true" />}
                <button type="button" role="switch" className="ktoggle-switch kpush-switch"
                  aria-checked={on} aria-label="Push notifications on this device" aria-describedby={descId}
                  aria-busy={busy === "enable" || busy === "disable" || undefined}
                  disabled={busy === "check"} onClick={() => { void toggleDevice(); }}>
                  <span className="ktoggle-thumb" aria-hidden="true" />
                </button>
              </span>
            )}
          </div>
        </div>
        {msg && (
          <p className="kpush-msg" data-tone={msg.tone}>
            <Icon name={msg.tone === "signal" ? "alert" : msg.tone === "ok" ? "check" : "bell"} size={14} sw={2} />
            <span>{msg.text}</span>
          </p>
        )}
        {on && !blocked && (
          <SetRow label="Send a test notification" desc="Check one arrives, and see how it looks on this device.">
            <Button size="sm" icon="send" loading={busy === "test"} onClick={() => { void test(); }}>Send test</Button>
          </SetRow>
        )}
      </SetGroup>
      <SetGroup title="Push me about">
        {PUSH_KINDS.map((k) => (
          <div key={k.key} className="kset-row">
            <Toggle checked={prefOn(pushPrefKey(k.key))} onChange={() => togglePref(pushPrefKey(k.key))}
              label={k.label} description={k.hint} disabled={!onSaveNotifyPrefs} />
          </div>
        ))}
      </SetGroup>
      <SetNote>
        {demo
          ? "This is the demo: nothing leaves your browser."
          : "These choices apply on every device where push is on. Email has its own settings."}
      </SetNote>
      <span className="sr-only" role="status" aria-live="polite">{live}</span>
    </div>
  );
}

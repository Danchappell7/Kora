/* ============================================================
   KANBO — Settings › Notifications › Push on this device.         [f8-push-pwa]
   "Push notifications on this device" switch (asks permission from the
   click), per-kind toggles (notify_prefs "<kind>_push", unset = on), and
   "Send a test notification". Hidden entirely when lib/push says
   "unconfigured" (no VAPID key / demo); explains "unsupported" and
   "denied" (how to allow it again) instead of hiding.
   Mount (integrator): in SettingsModal's notifications section, under the
   In-app / Email table, with the same notifyPrefs / onSaveNotifyPrefs.
   CONTRACT STUB — f8 replaces the body, keeps the name and props.
   ============================================================ */

export interface PushSettingsPanelProps {
  notifyPrefs: Record<string, boolean>;
  /** saves the whole prefs object (SettingsModal's onSaveNotifyPrefs) */
  onSaveNotifyPrefs?: (prefs: Record<string, boolean>) => void;
}

export function PushSettingsPanel(props: PushSettingsPanelProps) {
  void props;
  return null;
}

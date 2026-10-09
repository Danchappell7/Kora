/* ============================================================
   KANBO — Settings › Notifications › Delivery.        [0048 stub → u4]
   Below the existing In-app / Email table and the push panel:
     • Delivery: Real time (bundled per task within 2 minutes) or a
       Daily digest at a time you pick (push then only for mentions and
       approvals); "Bundle related notifications" switch
     • Quiet hours: on/off, start–end, which days; "Notifications wait
       until quiet hours end. Your Inbox still updates."
     • Timezone (defaults to Europe/London; "Use this device's timezone")
     • a plain-English summary line ("Real time, quiet 22:00–07:00 on
       weekdays, London time")
   Saves through onSaveNotifyPrefs (the whole object, as the rest of the
   panel does); lib/notifyPrefs readNotifyPrefs / applyNotifyPrefsPatch.
   Demo: works on the demo profile. Keyboard and screen-reader complete.
   Renders nothing until package u4 builds it.
   ============================================================ */
import type { NotifyPrefs } from "../../data/types";

export interface NotificationPrefsPanelProps {
  notifyPrefs: NotifyPrefs;
  /** saves the whole prefs object (SettingsModal's onSaveNotifyPrefs); absent = read-only */
  onSaveNotifyPrefs?: (prefs: NotifyPrefs) => void;
  /** the browser's timezone, offered as "Use this device's timezone" (default: Intl's) */
  deviceTimeZone?: string;
}

export function NotificationPrefsPanel(_props: NotificationPrefsPanelProps) {
  return null;
}

/* ============================================================
   KANBO — Settings › Notifications › Delivery, quiet hours, time zone.   [u4]
   Below the existing In-app / Email table and the push panel:
     • a plain-English summary line ("Real time, quiet 22:00–07:00 on
       weekdays, London time"), announced as it changes
     • Delivery: Real time (bundled per task within 2 minutes) or a
       Daily digest at a time you pick (push then only for mentions and
       approvals); "Bundle related notifications" switch
     • Quiet hours: on/off, from–to, which days they start on;
       "Notifications wait until quiet hours end. Your Inbox still updates."
     • Time zone (defaults to Europe/London; "Use this device's time zone")
   Saving: each change goes as a patch through merge_notify_prefs
   (lib/notifyPrefs mergeNotifyPrefs), one after another, so two devices
   (or a stale tab) never overwrite each other's settings and a slow reply
   can't undo a newer choice. The change shows at once; if it can't be
   saved it's put back and the panel says so. The stored prefs go to
   onNotifyPrefsStored (state only), or, when only onSaveNotifyPrefs is
   wired, to it once a burst of changes settles. Typed times save once
   they're whole and you pause or leave the field. A change to quiet hours,
   time zone or delivery also re-plans notices already held
   (rescheduleHeldNotices). Without either callback it's read-only. Demo:
   the whole object through onSaveNotifyPrefs, on the demo profile.
   Keyboard and screen-reader complete; phone width wraps.
   ============================================================ */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Icon, Segmented, Toggle, type SegmentedOption } from "../primitives";
import { SetGroup, SetNote, SetRow } from "../integrations/settingsBits";
import { isSupabaseConfigured } from "../../lib/backend";
import {
  applyNotifyPrefsPatch, deviceTimeZone as browserTimeZone, describeNotifyPrefs, mergeNotifyPrefs, quietDaysLabel, readNotifyPrefs,
  rescheduleHeldNotices, timeZoneChoices, touchesTiming, zoneLabel, zoneOption,
} from "../../lib/notifyPrefs";
import { digestMoment, hhmmToMinutes, inQuietHours, localParts, zonedTime } from "../../../supabase/functions/_shared/notifyTiming.ts";
import type { NotifyDelivery, NotifyPrefs } from "../../data/types";
import "./notificationPrefs.css";

export interface NotificationPrefsPanelProps {
  notifyPrefs: NotifyPrefs;
  /** SettingsModal's onSaveNotifyPrefs (saves the whole object). With a backend the panel saves each
   *  change itself and calls this only when onNotifyPrefsStored isn't given: once a burst of changes
   *  settles, with the prefs as stored. Demo: every change, as before. */
  onSaveNotifyPrefs?: (prefs: NotifyPrefs) => void;
  /** (preferred) the prefs as stored after each change — keep the profile in step; don't save them again */
  onNotifyPrefsStored?: (prefs: NotifyPrefs) => void;
  /** the browser's timezone, offered as "Use this device's timezone" (default: Intl's) */
  deviceTimeZone?: string;
}

const DELIVERY: SegmentedOption<NotifyDelivery>[] = [
  { value: "realtime", label: "Real time", icon: "zap" },
  { value: "digest", label: "Daily digest", icon: "sunset" },
];
const DAYS: { n: number; short: string; long: string }[] = [
  { n: 1, short: "Mon", long: "Monday" }, { n: 2, short: "Tue", long: "Tuesday" }, { n: 3, short: "Wed", long: "Wednesday" },
  { n: 4, short: "Thu", long: "Thursday" }, { n: 5, short: "Fri", long: "Friday" }, { n: 6, short: "Sat", long: "Saturday" },
  { n: 7, short: "Sun", long: "Sunday" },
];
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const DEFAULT_QUIET = { start: "22:00", end: "07:00", days: ALL_DAYS };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** a typed time saves after this pause (or when you leave the field) */
const TIME_SAVE_MS = 600;

export function NotificationPrefsPanel({ notifyPrefs, onSaveNotifyPrefs, onNotifyPrefsStored, deviceTimeZone }: NotificationPrefsPanelProps) {
  const readOnly = !onSaveNotifyPrefs && !onNotifyPrefsStored;
  const demo = !isSupabaseConfigured;
  const device = deviceTimeZone || browserTimeZone();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  // what's shown: the profile's prefs, with this panel's changes on top until they're stored
  const [overlay, setOverlay] = useState<NotifyPrefs | null>(null);
  const [saveError, setSaveError] = useState(false);
  const shown = overlay ?? notifyPrefs;
  const p = readNotifyPrefs(shown);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const props = useRef({ notifyPrefs, onSaveNotifyPrefs, onNotifyPrefsStored });
  props.current = { notifyPrefs, onSaveNotifyPrefs, onNotifyPrefsStored };
  // saves in flight, in order: what they'll make of the prefs, and the server's latest answer
  const io = useRef({
    chain: Promise.resolve() as Promise<unknown>, pending: [] as NotifyPrefs[], view: shown, stored: null as NotifyPrefs | null,
    retime: false, alive: true,
  });
  useEffect(() => { io.current.alive = true; return () => { io.current.alive = false; }; }, []);
  // the profile caught up (or changed elsewhere): show it, unless a save is still on its way
  useEffect(() => { if (!io.current.pending.length) setOverlay(null); }, [notifyPrefs]);

  const save = (patch: NotifyPrefs) => {
    if (readOnly) return;
    const s = io.current;
    const next = applyNotifyPrefsPatch(s.pending.length ? s.view : shownRef.current, patch);
    s.view = next;
    setOverlay(next);
    setSaveError(false);
    if (demo) {
      // the demo profile is the store, in this tab only: the whole object, as before
      (props.current.onSaveNotifyPrefs ?? props.current.onNotifyPrefsStored)?.(next);
      return;
    }
    s.pending.push(patch);
    s.chain = s.chain.then(async () => {
      let stored: NotifyPrefs | null = null;
      try { stored = await mergeNotifyPrefs(patch); } catch { stored = null; }
      s.pending.shift();
      if (stored) s.stored = stored;
      // the server's answer, with what's still on its way on top (a failed change falls away)
      s.view = s.pending.reduce((acc, x) => applyNotifyPrefsPatch(acc, x), s.stored ?? props.current.notifyPrefs);
      if (s.alive) { setOverlay(s.view); if (!stored) setSaveError(true); }
      const { onNotifyPrefsStored: told, onSaveNotifyPrefs: whole } = props.current;
      if (stored) {
        told?.(stored);
        if (touchesTiming(patch)) s.retime = true;
      }
      if (!s.pending.length) {
        if (s.stored && !told) whole?.(s.stored);
        // quiet hours, time zone or delivery changed: what's already held follows (once per burst)
        if (s.retime) void rescheduleHeldNotices();
        s.stored = null; s.retime = false;
      }
    });
  };

  // typed times: one save once you pause or leave the field (not one per keystroke)
  const typing = useRef<{ key: string; id: number; run: () => void } | null>(null);
  const flushTyping = () => {
    const t = typing.current;
    if (!t) return;
    typing.current = null;
    window.clearTimeout(t.id);
    t.run();
  };
  const saveTyped = (key: string, run: () => void) => {
    if (typing.current && typing.current.key !== key) flushTyping();
    if (typing.current) window.clearTimeout(typing.current.id);
    typing.current = { key, run, id: window.setTimeout(flushTyping, TIME_SAVE_MS) };
  };
  const cancelTyped = (key: string) => {
    if (typing.current?.key !== key) return;
    window.clearTimeout(typing.current.id);
    typing.current = null;
  };
  // closing Settings mid-pause still saves what was typed
  const flushRef = useRef(flushTyping);
  flushRef.current = flushTyping;
  useEffect(() => () => flushRef.current(), []);

  // times are typed into native fields: keep what's being typed, save it once it's a whole time
  const [digestDraft, setDigestDraft] = useState(p.digestTime);
  const [startDraft, setStartDraft] = useState(p.quietHours?.start ?? DEFAULT_QUIET.start);
  const [endDraft, setEndDraft] = useState(p.quietHours?.end ?? DEFAULT_QUIET.end);
  useEffect(() => { setDigestDraft(p.digestTime); }, [p.digestTime]);
  useEffect(() => { if (p.quietHours) { setStartDraft(p.quietHours.start); setEndDraft(p.quietHours.end); } }, [p.quietHours?.start, p.quietHours?.end]);
  const [dayError, setDayError] = useState(false);

  const quiet = p.quietHours;
  const sameTimes = startDraft === endDraft && HHMM.test(startDraft);
  const overnight = HHMM.test(startDraft) && HHMM.test(endDraft) && hhmmToMinutes(endDraft) < hhmmToMinutes(startDraft);

  const setQuietTimes = (start: string, end: string) => {
    if (!quiet || !HHMM.test(start) || !HHMM.test(end) || start === end) { cancelTyped("quiet"); return; }
    saveTyped("quiet", () => {
      // as things are when it saves (days may have changed meanwhile)
      const q = readNotifyPrefs(shownRef.current).quietHours;
      if (!q || (start === q.start && end === q.end)) return;
      save({ quiet_hours: { start, end, days: q.days } });
    });
  };
  const toggleDay = (n: number) => {
    if (!quiet) return;
    const days = quiet.days.includes(n) ? quiet.days.filter((d) => d !== n) : [...quiet.days, n].sort();
    if (!days.length) { setDayError(true); return; }
    setDayError(false);
    save({ quiet_hours: { start: quiet.start, end: quiet.end, days } });
  };

  // the digest's time falls inside quiet hours: say when it really comes
  const digestShift = useMemo(() => {
    if (p.delivery !== "digest" || !p.quietHours) return null;
    const today = localParts(new Date(), p.timezone).date;
    const nominal = zonedTime(today, hhmmToMinutes(p.digestTime), p.timezone);
    if (!inQuietHours(nominal, p.quietHours, p.timezone)) return null;
    const at = digestMoment(today, p);
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: p.timezone }).format(at);
  }, [p]);

  const zones = useMemo(() => timeZoneChoices(p.timezone, device, "Europe/London"), [p.timezone, device]);
  const zoneLabels = useMemo(() => { const at = new Date(); return new Map(zones.map((z) => [z, zoneOption(z, at)])); }, [zones]);

  const deliveryDesc = p.delivery === "digest"
    ? "One email a day with everything still unread, and what's due. Push only for mentions and approvals."
    : "Push and email as things happen.";

  return (
    <div className="knp-panel">
      <p className="knp-summary" role="status" aria-live="polite">
        <Icon name="bell" size={14} sw={1.75} />
        <span>{describeNotifyPrefs(p)}</span>
      </p>
      {saveError && (
        <p className="knp-err" role="alert">
          <Icon name="alert" size={14} sw={2} />
          <span>Couldn't save that change, so it's back as it was. Check your connection and try again.</span>
        </p>
      )}

      <SetGroup title="Delivery">
        <SetRow group label="How notifications reach you" desc={deliveryDesc}>
          <Segmented options={DELIVERY} value={p.delivery} ariaLabel="Delivery"
            onChange={(v) => { if (!readOnly && v !== p.delivery) save({ delivery: v }); }} />
        </SetRow>
        {p.delivery === "digest" && (
          <div className="kset-row knp-row">
            <div className="kset-row-text">
              <label htmlFor={`knp-digest-${uid}`} className="kset-row-label">Digest time</label>
              <span id={`knp-digest-${uid}-d`} className="kset-row-desc">
                {digestShift
                  ? `Inside your quiet hours, so it arrives when they end, at ${digestShift}.`
                  : `Every day at this time, ${zoneLabel(p.timezone)}.`}
              </span>
            </div>
            <div className="kset-row-ctl">
              <input id={`knp-digest-${uid}`} type="time" step={900} className="kset-input knp-time" value={digestDraft} disabled={readOnly}
                aria-describedby={`knp-digest-${uid}-d`}
                onBlur={flushTyping}
                onChange={(e) => {
                  const v = e.target.value;
                  setDigestDraft(v);
                  if (!HHMM.test(v)) { cancelTyped("digest"); return; }
                  saveTyped("digest", () => { if (v !== readNotifyPrefs(shownRef.current).digestTime) save({ digest_time: v }); });
                }} />
            </div>
          </div>
        )}
        <div className="kset-row">
          <Toggle checked={p.bundle} disabled={readOnly} onChange={(v) => save({ bundle: v ? null : false })}
            label="Bundle related notifications"
            description="Comments and updates on the same task within 2 minutes arrive as one. Mentions are always named." />
        </div>
      </SetGroup>

      <SetGroup title="Quiet hours">
        <div className="kset-row">
          <Toggle checked={!!quiet} disabled={readOnly}
            onChange={(v) => { setDayError(false); save({ quiet_hours: v ? { start: HHMM.test(startDraft) && startDraft !== endDraft ? startDraft : DEFAULT_QUIET.start, end: HHMM.test(endDraft) && startDraft !== endDraft ? endDraft : DEFAULT_QUIET.end, days: ALL_DAYS } : null }); }}
            label="Quiet hours"
            description="Notifications wait until quiet hours end. Your Inbox still updates." />
        </div>
        {quiet && (
          <>
            <div className="kset-row knp-row" role="group" aria-labelledby={`knp-hours-${uid}`} aria-describedby={`knp-hours-${uid}-d`}>
              <div className="kset-row-text">
                <span id={`knp-hours-${uid}`} className="kset-row-label">Hours</span>
                <span id={`knp-hours-${uid}-d`} className="kset-row-desc" data-tone={sameTimes ? "signal" : undefined}>
                  {sameTimes ? "Pick an end time that's different from the start."
                    : overnight ? `Overnight: ends at ${endDraft} the next morning.` : `${startDraft}–${endDraft}, ${zoneLabel(p.timezone)}.`}
                </span>
              </div>
              <div className="kset-row-ctl knp-span">
                <label className="knp-inline">
                  <span>From</span>
                  <input type="time" step={900} className="kset-input knp-time" value={startDraft} disabled={readOnly}
                    aria-invalid={sameTimes || undefined} onBlur={flushTyping}
                    onChange={(e) => { setStartDraft(e.target.value); setQuietTimes(e.target.value, endDraft); }} />
                </label>
                <label className="knp-inline">
                  <span>to</span>
                  <input type="time" step={900} className="kset-input knp-time" value={endDraft} disabled={readOnly}
                    aria-invalid={sameTimes || undefined} onBlur={flushTyping}
                    onChange={(e) => { setEndDraft(e.target.value); setQuietTimes(startDraft, e.target.value); }} />
                </label>
              </div>
            </div>
            <div className="kset-row knp-row" role="group" aria-labelledby={`knp-days-${uid}`} aria-describedby={`knp-days-${uid}-d`}>
              <div className="kset-row-text">
                <span id={`knp-days-${uid}`} className="kset-row-label">Days</span>
                <span id={`knp-days-${uid}-d`} className="kset-row-desc" data-tone={dayError ? "signal" : undefined}>
                  {dayError ? "Keep at least one day, or switch quiet hours off." : `Starting ${quietDaysLabel(quiet.days)}.`}
                </span>
              </div>
              <div className="kset-row-ctl knp-days">
                {DAYS.map((d) => {
                  const on = quiet.days.includes(d.n);
                  return (
                    <button key={d.n} type="button" className="knp-day" aria-pressed={on} aria-label={d.long} disabled={readOnly}
                      onClick={() => toggleDay(d.n)}>
                      {d.short}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </SetGroup>

      <SetGroup title="Time zone">
        <div className="kset-row knp-row">
          <div className="kset-row-text">
            <label htmlFor={`knp-zone-${uid}`} className="kset-row-label">Your time zone</label>
            <span id={`knp-zone-${uid}-d`} className="kset-row-desc">Quiet hours, your digest and snoozes like “Tomorrow 09:00” follow it.</span>
          </div>
          <div className="kset-row-ctl knp-zone-ctl">
            <select id={`knp-zone-${uid}`} className="kset-input knp-zone" value={p.timezone} disabled={readOnly}
              aria-describedby={`knp-zone-${uid}-d`}
              onChange={(e) => { if (e.target.value !== p.timezone) save({ timezone: e.target.value }); }}>
              {zones.map((z) => <option key={z} value={z}>{zoneLabels.get(z) ?? z}</option>)}
            </select>
          </div>
        </div>
        {device !== p.timezone && (
          <SetRow label={`This device is on ${zoneLabel(device)}`} desc="Travelling? Switch, and switch back when you're home.">
            <Button size="sm" icon="refresh" disabled={readOnly} onClick={() => save({ timezone: device })}>Use this device's time zone</Button>
          </SetRow>
        )}
      </SetGroup>

      <SetNote>
        {demo
          ? "This is the demo: these choices are kept, but nothing is sent."
          : "These apply to email and push on every device. Your Inbox always updates straight away."}
      </SetNote>
    </div>
  );
}

/* ============================================================
   KANBO — a person's week and time off, in their profile (Team ›
   People, 0055). Their capacity, working days and hours at this
   business (you set yours; owners and admins set anyone's; guests
   carry none), and their time off: what's coming up, and a way to
   add some (from, to, half a day, and a private reason only they and
   the owners and admins see). Everyone on the team reads it; the
   reason only reaches those it's for. Before 0055 is run it says so
   to owners and admins, and shows nothing to anyone else.
   ============================================================ */
import { useEffect, useId, useMemo, useState } from "react";
import { Button, IconButton, SectionLabel } from "../primitives";
import { useToast } from "../Toast";
import { KANBO_TODAY, toLocalISO } from "../../data/data";
import type { Role } from "../../data/types";
import {
  availabilityOn, canEditTimeOff, canEditWeek, clockOf, DEFAULT_WEEKLY_HOURS, hoursWords, MAX_WEEKLY_HOURS, MIN_WEEKLY_HOURS,
  roleOf, seesTimeOff, spanWords, weekOf, workDaysWords, type MemberWeek, type TimeOff,
} from "../../lib/availability";
import { deleteTimeOff, saveTimeOff, saveWeek } from "../../lib/availabilitySync";
import { useAvailability } from "./useAvailability";
import "./availability.css";

function useOptionalToast() { try { return useToast(); } catch { return null; } }

const DAYS: [number, string, string][] = [[1, "M", "Monday"], [2, "T", "Tuesday"], [3, "W", "Wednesday"], [4, "T", "Thursday"], [5, "F", "Friday"], [6, "S", "Saturday"], [7, "S", "Sunday"]];
const toMin = (v: string): number | null => { const m = /^(\d{1,2}):(\d{2})/.exec(v); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

export function AvailabilityPanel({ workspaceId, userId, name, isSelf, myRole }: {
  workspaceId: string | null;
  userId: string;
  name: string;
  isSelf: boolean;
  /** your role here (for the "not switched on" note) */
  myRole?: Role;
}) {
  const s = useAvailability();
  const toast = useOptionalToast();
  const first = name.trim().split(/\s+/)[0] || name;
  const today = toLocalISO(KANBO_TODAY);
  if (!workspaceId) return null;
  if (!availabilityOn(s)) {
    if (s.status !== "off" || (myRole !== "owner" && myRole !== "admin")) return null;
    return (
      <div className="kprof-field">
        <SectionLabel>Working week</SectionLabel>
        <p className="kav-quiet">Shared hours and time off aren't switched on yet. They need the 0055 database update.</p>
      </div>
    );
  }
  if (!seesTimeOff(workspaceId, s) && !isSelf) return null;
  const guest = roleOf(workspaceId, userId, s) === "guest";
  const say = (r: { ok: boolean; message?: string }, done: string) => {
    if (!toast) return;
    if (r.ok) toast.success(done); else toast.error(r.message ?? "Couldn't save that.");
  };
  return (
    <>
      {!guest && <WeekEditor key={`${workspaceId}:${userId}`} workspaceId={workspaceId} userId={userId} first={first} isSelf={isSelf} say={say} />}
      <TimeOffList userId={userId} first={first} isSelf={isSelf} today={today} say={say} />
    </>
  );
}

function WeekEditor({ workspaceId, userId, first, isSelf, say }: {
  workspaceId: string; userId: string; first: string; isSelf: boolean;
  say: (r: { ok: boolean; message?: string }, done: string) => void;
}) {
  const s = useAvailability();
  const week = weekOf(workspaceId, userId, s);
  const editable = canEditWeek(workspaceId, userId, s);
  const id = useId();
  // the form, as text; `base` is the saved week it started from. A saved change (here or a
  // teammate's) shows unless something's been changed in the form meanwhile.
  const fields = (w: MemberWeek) => ({ hours: String(w.weeklyHours ?? DEFAULT_WEEKLY_HOURS), days: [...w.workDays], start: clockOf(w.dayStart), end: w.dayEnd >= 1440 ? "23:59" : clockOf(w.dayEnd) });
  const [form, setForm] = useState(() => fields(week));
  const [base, setBase] = useState(() => keyOf(fields(week)));
  const [busy, setBusy] = useState(false);
  const saved = keyOf(fields(week));
  const dirty = keyOf(form) !== base;
  useEffect(() => {
    if (saved === base) return;
    if (!dirty) { setForm(fields(week)); setBase(saved); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const { hours, days, start, end } = form;
  const h = Number(hours);
  const s0 = toMin(start), e0 = toMin(end);
  const problem = !(h >= MIN_WEEKLY_HOURS && h <= MAX_WEEKLY_HOURS) ? `Hours a week: ${MIN_WEEKLY_HOURS}–${MAX_WEEKLY_HOURS}`
    : !days.length ? "Pick at least one working day"
    : s0 == null || e0 == null || e0 - s0 < 60 ? "The day ends at least an hour after it starts"
    : null;
  const summary = `${round1(week.weeklyHours ?? DEFAULT_WEEKLY_HOURS)}h a week · ${workDaysWords(week.workDays)} · ${hoursWords(week)}`;
  if (!editable) {
    return (
      <div className="kprof-field">
        <SectionLabel>Working week</SectionLabel>
        <p className="kav-summary">{summary}</p>
        <p className="kprof-hint">{first} or an owner or admin can change it.</p>
      </div>
    );
  }
  const save = async () => {
    if (problem || busy) return;
    setBusy(true);
    const next: MemberWeek = { workspaceId, userId, weeklyHours: round1(h) === DEFAULT_WEEKLY_HOURS && week.weeklyHours == null ? null : round1(h),
      workDays: [...days].sort((a, b) => a - b), dayStart: s0!, dayEnd: e0 === 1439 ? 1440 : e0! };
    const r = await saveWeek(next);
    setBusy(false);
    if (r.ok) { const f = fields(next); setForm(f); setBase(keyOf(f)); }
    say(r, isSelf ? "Your working week is saved for the team" : `${first}'s working week is saved`);
  };
  return (
    <div className="kprof-field kav-week">
      <SectionLabel>Working week</SectionLabel>
      <div className="kav-week-row">
        <label className="kav-field" htmlFor={`${id}-h`}>
          <span className="kprof-label">Hours a week</span>
          <input id={`${id}-h`} type="number" min={MIN_WEEKLY_HOURS} max={MAX_WEEKLY_HOURS} step={0.5} inputMode="decimal" className="kfield-input kav-hours"
            value={hours} onChange={(e) => set({ hours: e.target.value })} />
        </label>
        <label className="kav-field" htmlFor={`${id}-s`}>
          <span className="kprof-label">Starts</span>
          <input id={`${id}-s`} type="time" step={900} className="kfield-input kav-time" value={start} onChange={(e) => set({ start: e.target.value })} />
        </label>
        <label className="kav-field" htmlFor={`${id}-e`}>
          <span className="kprof-label">Ends</span>
          <input id={`${id}-e`} type="time" step={900} className="kfield-input kav-time" value={end} onChange={(e) => set({ end: e.target.value })} />
        </label>
      </div>
      <div className="kav-field" role="group" aria-labelledby={`${id}-d`}>
        <span className="kprof-label" id={`${id}-d`}>Working days</span>
        <span className="kav-days">
          {DAYS.map(([d, letter, long]) => {
            const on = days.includes(d);
            return (
              <button key={d} type="button" className="kav-day" aria-pressed={on} aria-label={long} title={long}
                onClick={() => set({ days: on ? days.filter((x) => x !== d) : [...days, d] })}>{letter}</button>
            );
          })}
        </span>
      </div>
      <div className="kav-week-foot">
        <span className="kprof-hint" role={problem ? "alert" : undefined} data-tone={problem ? "signal" : undefined}>
          {problem ?? (isSelf ? "Workload, Radar and your Today use this. Everyone on the team sees it." : `Workload and Radar use this for ${first}.`)}
        </span>
        <Button variant="primary" size="sm" disabled={!dirty || !!problem} loading={busy} onClick={() => void save()}>Save</Button>
      </div>
    </div>
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;
/** a form's values as one comparable string (days in order, hours as a number) */
const keyOf = (f: { hours: string; days: number[]; start: string; end: string }) => `${round1(Number(f.hours))}|${[...f.days].sort((a, b) => a - b).join()}|${f.start}|${f.end}`;

function TimeOffList({ userId, first, isSelf, today, say }: {
  userId: string; first: string; isSelf: boolean; today: string;
  say: (r: { ok: boolean; message?: string }, done: string) => void;
}) {
  const s = useAvailability();
  const editable = canEditTimeOff(userId, s);
  const coming = useMemo(() => s.timeOff.filter((t) => t.userId === userId && t.endsOn >= today).sort((a, b) => a.startsOn.localeCompare(b.startsOn)), [s.timeOff, userId, today]);
  const [adding, setAdding] = useState(false);
  if (!editable && !coming.length) return null;
  const remove = async (t: TimeOff) => {
    const r = await deleteTimeOff(t.id);
    say(r, `Removed time off ${spanWords(t)}`);
  };
  return (
    <div className="kprof-field">
      <SectionLabel count={coming.length || undefined}
        action={editable && !adding ? <Button size="sm" variant="ghost" icon="plus" onClick={() => setAdding(true)}>Add time off</Button> : undefined}>
        Time off
      </SectionLabel>
      {coming.length === 0 && !adding && <p className="kprof-hint">{isSelf ? "Nothing booked. Add your holidays so the team plans around them." : `Nothing booked for ${first}.`}</p>}
      {coming.length > 0 && (
        <ul className="kav-offs">
          {coming.map((t) => (
            <li key={t.id} className="kav-off">
              <span className="kav-off-when">{spanWords(t)}{t.startsOn <= today && <span className="kav-off-now"> · now</span>}</span>
              <span className="kav-off-why" data-private={t.reason ? "" : undefined}>{t.reason ?? "Off"}</span>
              {editable && <IconButton icon="x" size="sm" label={`Remove time off ${spanWords(t)}`} onClick={() => void remove(t)} />}
            </li>
          ))}
        </ul>
      )}
      {adding && <TimeOffForm userId={userId} first={first} isSelf={isSelf} today={today} onDone={() => setAdding(false)} say={say} />}
    </div>
  );
}

function TimeOffForm({ userId, first, isSelf, today, onDone, say }: {
  userId: string; first: string; isSelf: boolean; today: string; onDone: () => void;
  say: (r: { ok: boolean; message?: string }, done: string) => void;
}) {
  const id = useId();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [half, setHalf] = useState<"" | "am" | "pm">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const single = from === to;
  const problem = !from || !to ? "Pick the days" : to < from ? "The last day comes after the first" : reason.trim().length > 200 ? "Keep the note under 200 characters" : null;
  const add = async () => {
    if (problem || busy) return;
    setBusy(true);
    const r = await saveTimeOff({ userId, startsOn: from, endsOn: to, halfDay: single && half ? half : null, reason: reason.trim() || null });
    setBusy(false);
    say(r, `Time off added: ${spanWords({ startsOn: from, endsOn: to, halfDay: single && half ? half : null })}`);
    if (r.ok) onDone();
  };
  return (
    <div className="kav-form" role="group" aria-label={isSelf ? "Add your time off" : `Add time off for ${first}`}>
      <div className="kav-week-row">
        <label className="kav-field" htmlFor={`${id}-f`}>
          <span className="kprof-label">From</span>
          <input id={`${id}-f`} type="date" className="kfield-input" value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} />
        </label>
        <label className="kav-field" htmlFor={`${id}-t`}>
          <span className="kprof-label">To</span>
          <input id={`${id}-t`} type="date" className="kfield-input" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {single && (
          <label className="kav-field" htmlFor={`${id}-p`}>
            <span className="kprof-label">Part</span>
            <select id={`${id}-p`} className="kfield-select" value={half} onChange={(e) => setHalf(e.target.value as "" | "am" | "pm")}>
              <option value="">Whole day</option>
              <option value="am">Morning</option>
              <option value="pm">Afternoon</option>
            </select>
          </label>
        )}
      </div>
      <div className="kav-field">
        <label className="kprof-label" htmlFor={`${id}-r`}>Note (optional)</label>
        <input id={`${id}-r`} className="kfield-input" value={reason} maxLength={200} placeholder="e.g. Holiday" aria-describedby={`${id}-rh`} onChange={(e) => setReason(e.target.value)} />
        <span className="kprof-hint" id={`${id}-rh`}>{isSelf ? "Only you and the owners and admins see the note. Everyone else sees “Off”." : `Only ${first} and the owners and admins see the note. Everyone else sees “Off”.`}</span>
      </div>
      <div className="kav-week-foot">
        <span className="kprof-hint" role={problem ? "alert" : undefined} data-tone={problem ? "signal" : undefined}>{problem ?? ""}</span>
        <span className="kav-actions">
          <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!!problem} loading={busy} onClick={() => void add()}>Add</Button>
        </span>
      </div>
    </div>
  );
}

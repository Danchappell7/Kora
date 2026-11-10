/* ============================================================
   KANBO — starting a meeting (0056). Kanbo has the agenda ready: the
   sheet shows what it found in each section (and how it would open),
   and you choose the kind (where you may run either), what's on it,
   who's coming and which project keeps the notes doc. A leadership
   meeting suggests a "Leadership" project (made here if there isn't
   one); the business's last choice comes back next time. Before 0056
   is run it says the meeting will run on this screen only.
   ============================================================ */
import { useEffect, useId, useMemo, useState } from "react";
import { Avatar, Button, Icon, Segmented, Sheet, spectrumColor } from "../primitives";
import type { WorkspaceEvent } from "../../data/types";
import type { NewProject } from "../../data/store";
import { KANBO_TODAY, getMember, toLocalISO } from "../../data/data";
import { readCapacities } from "../../lib/radar";
import { awayNote, getAvailability, seesTimeOff } from "../../lib/availability";
import {
  PRESETS, SECTION_LABEL, SECTION_ORDER, agendaFacts, assembleAgenda, meetingDay, meetingPeople, meetingTitle, mayRun, overviewLede, type AgendaFacts,
} from "../../lib/meetings/agenda";
import { isDemoMeetings, lastMeeting, startMeeting } from "../../lib/meetings/sync";
import type { Meeting, MeetingItem, MeetingPreset, MeetingSection } from "../../lib/meetings/types";
import { useMeetingsMode, type MeetingScope } from "./meetingBus";
import type { MeetingData } from "./MeetingsHost";
import "./meetings.css";

const HISTORY_DAYS = 30;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const LEADERSHIP = "Leadership";

export function StartMeetingSheet({ scope, data, loadEvents, onCreateProject, onClose, onStarted }: {
  scope: MeetingScope;
  data: MeetingData;
  loadEvents: (workspaceId: string, sinceISO: string) => Promise<WorkspaceEvent[]>;
  onCreateProject?: (input: NewProject) => void;
  onClose: () => void;
  onStarted: (m: Meeting) => void;
}) {
  const { me, workspaces, members, projects } = data;
  const host = scope.workspaceId;
  const group = !!scope.workspaceIds && scope.workspaceIds.length > 1;
  const wss = useMemo(() => [...new Set([host, ...(scope.workspaceIds ?? [])])], [host, scope.workspaceIds]);
  const covered = useMemo(() => workspaces.filter((w) => w.id && wss.includes(w.id)), [workspaces, wss]);
  const mode = useMeetingsMode();
  const uid = useId();
  const canTeam = !group && mayRun("team", host, wss, me, members, workspaces);
  const canLead = mayRun("leadership", host, wss, me, members, workspaces);
  const [preset, setPreset] = useState<MeetingPreset>(group || !canTeam ? "leadership" : scope.preset === "leadership" && canLead ? "leadership" : "team");
  const today = useMemo(() => new Date(KANBO_TODAY), []);
  const autoTitle = meetingTitle(preset, covered, today);
  const [title, setTitle] = useState<string | null>(null);
  const [sections, setSections] = useState<Set<MeetingSection>>(() => new Set(PRESETS[preset].sections));
  useEffect(() => { setSections(new Set(PRESETS[preset].sections.filter((s) => !(group && s === "people")))); }, [preset, group]);

  /* ---- the change history and the last meeting ---- */
  const [events, setEvents] = useState<WorkspaceEvent[] | undefined>(undefined);
  const [prev, setPrev] = useState<{ meeting: Meeting; items: MeetingItem[] } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const since = new Date(today); since.setDate(since.getDate() - HISTORY_DAYS);
    const evs = group ? Promise.resolve(undefined) : loadEvents(host, since.toISOString()).catch(() => undefined);
    Promise.all([evs, lastMeeting(host, preset, wss).catch(() => null)]).then(([e, p]) => {
      if (!alive) return;
      setEvents(Array.isArray(e) ? e : undefined);
      setPrev(p);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [host, preset, group, wss, loadEvents, today]);

  /* ---- what Kanbo found ---- */
  const facts: AgendaFacts = useMemo(() => {
    const avail = getAvailability();
    return agendaFacts({
      preset, workspaces: covered, hostId: host, members, me, tasks: data.tasks, goalTasks: data.goalTasks, projects, goals: data.goals,
      statusUpdates: data.statusUpdates, today, events, previous: prev,
      capacitiesFor: (ws) => readCapacities(ws),
      // "Off today" (the label only: a reason never goes on an agenda everyone reads)
      offNote: (user, ws) => { if (!seesTimeOff(ws, avail)) return null; const n = awayNote(user, toLocalISO(today), { ws }, avail); return n ? { label: n.label, now: n.now } : null; },
    });
  }, [preset, covered, host, members, me, data.tasks, data.goalTasks, projects, data.goals, data.statusUpdates, today, events, prev]);
  const chosen = SECTION_ORDER.filter((s) => sections.has(s));
  const lede = overviewLede(facts, chosen);

  /* ---- who's coming ---- */
  const people = useMemo(() => meetingPeople(preset, host, wss, me, members, workspaces), [preset, host, wss, me, members, workspaces]);
  const [away, setAway] = useState<Set<string>>(new Set());
  const coming = people.filter((p) => !away.has(p.id));

  /* ---- where the notes go ---- */
  const hostProjects = useMemo(() => projects.filter((p) => p.workspaceId === host && !p.archivedAt), [projects, host]);
  const leadershipProject = hostProjects.find((p) => p.name.trim().toLowerCase() === LEADERSHIP.toLowerCase() && !p.id.startsWith("tmp-"));
  const [projectId, setProjectId] = useState<string>("");
  const [making, setMaking] = useState(false);
  useEffect(() => {
    // the business's last choice, else a Leadership project for a leadership meeting, else a project of yours
    const last = prev?.meeting.docProjectId && hostProjects.some((p) => p.id === prev.meeting.docProjectId) ? prev.meeting.docProjectId : null;
    const mine = hostProjects.find((p) => p.ownerId === me);
    setProjectId((cur) => cur && hostProjects.some((p) => p.id === cur) ? cur
      : last ?? (preset === "leadership" ? leadershipProject?.id : undefined) ?? mine?.id ?? hostProjects[0]?.id ?? "");
  }, [prev, hostProjects, preset, leadershipProject, me]);
  useEffect(() => {
    if (making && leadershipProject) { setProjectId(leadershipProject.id); setMaking(false); }
  }, [making, leadershipProject]);
  const guestsHere = members.some((m) => m.workspaceId === host && m.status === "active" && m.role === "guest");

  /* ---- start ---- */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true); setError(null);
    const r = await startMeeting({
      workspaceId: host, workspaceIds: wss, preset, title: (title ?? autoTitle).trim() || autoTitle,
      agenda: assembleAgenda(facts, chosen), attendees: coming.map((p) => p.id),
      docProjectId: projectId && !projectId.startsWith("tmp-") ? projectId : null, previousId: prev?.meeting.id ?? null, me,
    });
    setBusy(false);
    if (r.ok) onStarted(r.data);
    else setError(r.message);
  };
  const makeLeadership = () => {
    if (!onCreateProject) return;
    setMaking(true);
    onCreateProject({ name: LEADERSHIP, emoji: "🧭", color: spectrumColor("cobalt"), workspaceId: host });
  };

  const count = (s: MeetingSection) => facts.counts[s];
  const sectionNote = (s: MeetingSection): string => {
    if (loading && (s === "actions" || s === "people")) return "Looking…";
    const n = count(s);
    switch (s) {
      case "people": return group ? "One business at a time" : n ? `${n} ${n === 1 ? "person" : "people"}${facts.offToday.length ? `, ${facts.offToday.length} off today` : ""}` : "Nobody on the team yet";
      case "risks": return n ? `${n} ${n === 1 ? "risk" : "risks"}` : "Nothing on the Radar";
      case "goals": return n ? `${n} behind` : "Every goal on pace";
      case "projects": return n ? `${n} to look at` : "Nothing to look at";
      case "actions": return facts.from ? `${n} from ${facts.from.endedAt ? meetingDay(new Date(facts.from.endedAt)) : "last time"}` : "No meeting here yet";
    }
  };

  return (
    <Sheet open onClose={onClose} label="Run a meeting" title="Run a meeting" width={600}
      footer={(
        <>
          {error && <span className="kmtg-start-err" role="alert">{error}</span>}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="hero" icon="play" onClick={() => void start()} loading={busy} disabled={making || loading}>Start meeting</Button>
        </>
      )}>
      <div className="kmtg-start">
        {canTeam && canLead && !group && (
          <Segmented<MeetingPreset> ariaLabel="Kind of meeting" value={preset} onChange={setPreset}
            options={[{ value: "team", label: PRESETS.team.label }, { value: "leadership", label: PRESETS.leadership.label }]} />
        )}
        <p className="kmtg-start-blurb">{group ? `Every business you run: ${covered.map((w) => w.name).join(", ")}.` : PRESETS[preset].blurb}</p>

        <label className="kmtg-field">
          <span className="kmtg-label">Title</span>
          <input className="kmtg-input" value={title ?? autoTitle} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </label>

        <fieldset className="kmtg-fieldset">
          <legend className="kmtg-label">On the agenda</legend>
          <ul className="kmtg-secs">
            {SECTION_ORDER.map((s) => {
              const off = group && s === "people";
              return (
                <li key={s}>
                  <label className="kmtg-sec" data-off={off || undefined}>
                    <input type="checkbox" checked={sections.has(s) && !off} disabled={off}
                      onChange={(e) => setSections((cur) => { const n = new Set(cur); if (e.target.checked) n.add(s); else n.delete(s); return n; })} />
                    <span className="kmtg-sec-name">{SECTION_LABEL[s]}</span>
                    <span className="kmtg-sec-n" data-zero={!loading && count(s) === 0 ? "" : undefined}>{sectionNote(s)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="kmtg-start-lede" aria-live="polite">
            <span className="kmtg-start-lede-k"><Icon name="kanbo" size={14} /> Kanbo opens with</span>
            {loading ? <span className="kmtg-start-skel"><span className="skel" /><span className="skel" /></span>
              : <p>{lede.map((p, i) => p.strong ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>)}</p>}
          </div>
        </fieldset>

        <fieldset className="kmtg-fieldset">
          <legend className="kmtg-label">Who's coming <span className="kmtg-count">{coming.length} of {people.length}</span></legend>
          <div className="kmtg-people">
            {people.map((p) => {
              const on = !away.has(p.id);
              return (
                <button key={p.id} type="button" className="kmtg-person" aria-pressed={on} disabled={p.id === me}
                  title={p.id === me ? "You're running it" : on ? `Leave ${p.name} out` : `Ask ${p.name}`}
                  onClick={() => setAway((cur) => { const n = new Set(cur); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}>
                  <span aria-hidden="true" style={{ display: "inline-flex" }}>{getMember(p.id) ? <Avatar id={p.id} size={22} /> : <span className="kmtg-initial">{p.name.charAt(0)}</span>}</span>
                  <span>{p.id === me ? "You" : firstName(p.name)}</span>
                </button>
              );
            })}
          </div>
          {preset === "leadership" && <p className="kmtg-hint">Leadership meetings are for {group ? "people who run every one of these businesses" : "owners and admins"}. Guests never see them.</p>}
        </fieldset>

        <div className="kmtg-field">
          <label className="kmtg-label" htmlFor={`${uid}-doc`}>Notes doc goes in</label>
          <span className="kmtg-row">
            <select id={`${uid}-doc`} className="kmtg-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={making}
              aria-describedby={guestsHere && projectId ? `${uid}-guests` : undefined}>
              {!hostProjects.length && <option value="">No project yet</option>}
              {hostProjects.map((p) => <option key={p.id} value={p.id}>{p.emoji ? `${p.emoji} ` : ""}{p.name}</option>)}
            </select>
            {preset === "leadership" && !leadershipProject && onCreateProject && (
              <Button size="sm" variant="ghost" icon="plus" onClick={makeLeadership} loading={making}>New Leadership project</Button>
            )}
          </span>
          {guestsHere && projectId && <span className="kmtg-hint" id={`${uid}-guests`}>Guests at this business can read the docs in its projects.</span>}
        </div>

        {mode === "local" && !isDemoMeetings() && (
          <p className="kmtg-note" role="note"><Icon name="alert" size={14} /> Shared meetings aren't switched on yet, so this one runs on your screen only: nobody else can follow it and no recap is sent. The notes doc still saves. Ask the workspace owner to run the 0056 update.</p>
        )}
      </div>
    </Sheet>
  );
}

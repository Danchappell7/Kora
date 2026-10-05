/* ============================================================
   KANBO — Team › Pulse: the standup that writes itself, with the
   Radar of risks beside it.
   The lede and the table come from lib/pulse (tasks + the change
   history), the Radar from lib/radar. "Write it up" asks Kanbo for five
   lines when AI is on, and otherwise fills in the same facts as a
   Slack-ready template — it never waits on the network to be useful.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import { AiMark, Avatar, Button, EmptyState, Meter, Segmented, Sheet, StatusGlyph, Vellum } from "../primitives";
import { useToast } from "../Toast";
import { getMember, KANBO_TODAY, toLocalISO } from "../../data/data";
import { ROLE_META } from "../../lib/permissions";
import type { Task, WorkspaceMember, WorkspaceEvent } from "../../data/types";
import type { AiOutcome } from "../../lib/askTypes";
import { buildPulse, periodStart, plainText, pulseFactsForAi, pulseMarkdown, pulseSentence, pulseSentenceParts, pulseTaskCount, sinceWords, type PulsePeriod, type PulsePerson } from "../../lib/pulse";
import { computeRisks, loadTone, readCapacities } from "../../lib/radar";
import { addDays, fmtDayMonth, localDay } from "./reportingUtils";
import { RadarPanel } from "./RadarPanel";
import { SlackPostButton } from "../integrations";
import { risksSlackText } from "../../lib/slack";

function useOptionalToast() { try { return useToast(); } catch { return null; } }

/** How far back the change history is read: Pulse needs a week at most; Radar
 *  looks for slips and quiet work over a month. One read covers both. */
const HISTORY_DAYS = 30;
/** The most changes one read returns (the store's page: its newest 500). A read
 *  that comes back this full may have stopped short of HISTORY_DAYS, so the
 *  history then only counts from the oldest change it holds. */
const HISTORY_PAGE = 500;
const SHOWN = 3;

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* permission denied / insecure context — fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-1000px";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
/** The write-up box fits its text (about 80 characters to a line in the 640px sheet, and
 *  a line to spare), from 6 rows up to 18; past that it scrolls. Browsers with
 *  field-sizing (see the CSS) fit it exactly. */
const rowsFor = (text: string) =>
  Math.min(18, Math.max(6, text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 80)), 0) + 1));

type Person = { id: string; name: string; role?: string; guest?: boolean };
type WriteUp = { status: "loading" } | { status: "ready"; text: string; ai: boolean; note?: string };

export function TeamPulse({ tasks, members, currentUserId, workspaceName, workspaceId = null, readOnly, loadEvents, onOpen, onNudge, onPatch, onOpenWorkload, onWriteUp, personal, onNewWorkspace, onOpenPeople }: {
  tasks: Task[];
  members: WorkspaceMember[];
  currentUserId: string;
  workspaceName: string;
  /** the team workspace: Post to Slack shows once it has a channel connected (never for guests) */
  workspaceId?: string | null;
  readOnly: boolean;
  loadEvents: (sinceISO: string) => Promise<WorkspaceEvent[]>;
  onOpen: (id: string) => void;
  /** posts the nudge as a comment; reject, or resolve false/null, when it wasn't posted */
  onNudge: (taskId: string, userId: string, text: string) => Promise<unknown>;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onOpenWorkload: () => void;
  onWriteUp?: (facts: unknown) => Promise<AiOutcome<string>>;
  /** the Personal workspace: Pulse is for teams, so it explains itself instead */
  personal?: boolean;
  onNewWorkspace?: () => void;
  /** Team › People, where the team is invited (the action on an empty team) */
  onOpenPeople?: () => void;
}) {
  const toast = useOptionalToast();
  const [period, setPeriod] = useState<PulsePeriod>("day");
  const [capacities] = useState(readCapacities);
  const todayISO = toLocalISO(KANBO_TODAY);

  /* ---- the change history (task_events) ---- */
  const [events, setEvents] = useState<WorkspaceEvent[] | null>(null);   // null = loading
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const load = useRef(loadEvents);
  load.current = loadEvents;
  const historyStart = toLocalISO(addDays(localDay(todayISO) ?? new Date(KANBO_TODAY), -HISTORY_DAYS));
  const wsKey = members[0]?.workspaceId ?? workspaceName;
  useEffect(() => {
    if (personal) return;
    let alive = true;
    setEvents(null); setFailed(false);
    const since = (localDay(historyStart) ?? new Date(KANBO_TODAY)).toISOString();
    // (one read covers both periods: switching Since yesterday ↔ This week filters it)
    let read: Promise<WorkspaceEvent[]>;
    try { read = Promise.resolve(load.current(since)); } catch (e) { read = Promise.reject(e); }
    read.then((ev) => { if (alive) setEvents(Array.isArray(ev) ? ev : []); })
      .catch(() => { if (alive) { setFailed(true); setEvents([]); } });
    return () => { alive = false; };
  }, [historyStart, wsKey, attempt, personal]);
  const loading = events === null;
  /* What the history can vouch for. After a failed read it's unknown: Pulse
     carries on from completions, and Radar skips what needs the history
     (slips, stale work) rather than reading "no changes" into it. A full page
     may be only the newest changes, so it counts from the oldest one it holds. */
  const history = useMemo((): { events: WorkspaceEvent[]; since: string } | undefined => {
    if (!events || failed) return undefined;
    if (events.length < HISTORY_PAGE) return { events, since: historyStart };
    const oldest = events.reduce((min, e) => (e.createdAt < min ? e.createdAt : min), events[0].createdAt);
    const day = localDay(oldest);
    return { events, since: day && toLocalISO(day) > historyStart ? toLocalISO(day) : historyStart };
  }, [events, failed, historyStart]);

  /* ---- who's on the team ---- */
  const people: Person[] = useMemo(() => {
    const rows = members.filter((m) => m.status === "active" && m.userId).map((m) => {
      const id = m.userId!;
      const name = getMember(id)?.name?.trim() || m.name?.trim() || m.email;
      const guest = m.role === "guest";
      // guests: the This week column already says "Guest", so this line says where they're from
      const role = m.title?.trim() || (guest ? m.email.split("@")[1] ?? "" : ROLE_META[m.role]?.label || "");
      return { id, name, guest, role: id === currentUserId ? (role ? `${role} · you` : "You") : role };
    });
    if (rows.length) return rows;
    // no member rows (the demo, or a workspace still loading): the people doing the work
    const seen = new Set<string>();
    const out: Person[] = [];
    for (const t of tasks) {
      const id = t.assigneeId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const m = getMember(id);
      if (!m) continue;
      const guest = m.type === "external";
      out.push({ id, name: m.name, guest, role: id === currentUserId ? "You" : guest ? m.email.split("@")[1] || undefined : undefined });
    }
    return out;
  }, [members, tasks, currentUserId]);

  const since = periodStart(period, todayISO);
  const facts = useMemo(() => buildPulse({ tasks, members: people, events: history?.events, today: todayISO, capacities, since, period }),
    [tasks, people, history, todayISO, capacities, since, period]);
  const risks = useMemo(() => computeRisks({ tasks, events: history?.events, eventsSince: history?.since, members: people, capacities, today: todayISO }),
    [tasks, history, people, capacities, todayISO]);
  const sinceWord = period === "week" ? "Monday" : sinceWords(since, todayISO);
  // a switch of period is announced once, with the new lede; realtime changes to the lede aren't
  const [announce, setAnnounce] = useState("");
  const announced = useRef(period);
  useEffect(() => {
    if (announced.current === period) return;
    announced.current = period;
    setAnnounce(pulseSentence(facts));   // (it opens with the period: "This week the team…")
    // (only when the period changes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  /* ---- copy + write it up ---- */
  const copy = async (text: string, what: "slack" | "plain") => {
    const ok = await copyText(what === "slack" ? text : plainText(text));
    if (!toast) return;
    if (ok) toast.success(what === "slack" ? "Copied — paste it into Slack" : "Copied");
    else toast.error("Couldn't copy — select the text and copy it yourself.");
  };
  const [writeUp, setWriteUp] = useState<WriteUp | null>(null);
  const [draft, setDraft] = useState("");   // the text as edited in the sheet (what gets copied)
  const request = useRef(0);
  const ready = (w: Extract<WriteUp, { status: "ready" }>) => { setDraft(w.text); setWriteUp(w); };
  const startWriteUp = async () => {
    const template = pulseMarkdown(facts);
    const id = ++request.current;
    if (!onWriteUp) { ready({ status: "ready", text: template, ai: false, note: "Written from your team's tasks (Kanbo AI is off)" }); return; }
    setWriteUp({ status: "loading" });
    let out: AiOutcome<string> | null = null;
    try { out = await onWriteUp(pulseFactsForAi(facts, risks)); } catch { out = null; }
    if (id !== request.current) return;   // closed, or asked again, meanwhile
    if (out && out.source === "ai" && typeof out.data === "string" && out.data.trim()) {
      ready({ status: "ready", text: out.data.trim(), ai: true });
      return;
    }
    const why = out?.source === "limit" ? "you've reached today's Kanbo AI limit"
      : out?.source === "off" ? "Kanbo AI is off"
      : "Kanbo AI isn't available right now";
    ready({ status: "ready", text: template, ai: false, note: `Written from your team's tasks (${why})` });
  };
  const closeWriteUp = () => { request.current++; setWriteUp(null); };

  if (personal) {
    return (
      <div className="kpulse" data-personal="">
        <style>{PULSE_CSS}</style>
        <EmptyState art="users" size="lg" title="Pulse is for teams"
          body="In a team workspace, Pulse writes the daily standup from what everyone finished, what's on today and what's at risk."
          action={onNewWorkspace ? <Button variant="primary" icon="plus" onClick={onNewWorkspace}>New workspace</Button> : undefined} />
      </div>
    );
  }

  const nTasks = pulseTaskCount(facts);
  const provenance = {
    // "and N changes" only when the history loaded and held some
    summary: `from ${nTasks} ${nTasks === 1 ? "task" : "tasks"}${facts.changes ? ` and ${facts.changes} ${facts.changes === 1 ? "change" : "changes"}` : ""} since ${sinceWord}`,
    details: [
      `${facts.totals.done} finished, ${facts.totals.inFlight} in flight, ${facts.totals.blocked} blocked`,
      `${facts.people.length} ${facts.people.length === 1 ? "person" : "people"} in ${workspaceName}`,
      "This week's load from estimates (1h where there's none) against capacity",
      `${risks.length} ${risks.length === 1 ? "risk" : "risks"} on the Radar`,
    ],
  };
  const doneLabel = period === "week" ? "Done this week" : `Done since ${sinceWord}`;

  return (
    <div className="kpulse">
      <style>{PULSE_CSS}</style>
      <div className="kpulse-grid">
        <div className="kpulse-bar">
          <Segmented<PulsePeriod> ariaLabel="Period" value={period} onChange={setPeriod}
            options={[{ value: "day", label: `Since ${sinceWords(periodStart("day", todayISO), todayISO)}` }, { value: "week", label: "This week" }]} />
          <span className="kpulse-bar-end">
            <Button size="sm" variant="secondary" icon="copy" onClick={() => void copy(pulseMarkdown(facts), "slack")} disabled={loading}>Copy for Slack</Button>
            {/* renders nothing until this workspace has a Slack channel (and never for guests) */}
            {!readOnly && <SlackPostButton workspaceId={workspaceId} kind="standup" getText={() => pulseMarkdown(facts)} disabled={loading} />}
            <Button size="sm" variant="hero" icon="kanbo" onClick={() => void startWriteUp()} disabled={loading}>Write it up</Button>
          </span>
        </div>

        <div className="kpulse-lede-wrap">
          {loading ? (
            <div className="kpulse-lede-skel" aria-hidden="true"><span className="skel" /><span className="skel" /></div>
          ) : (
            <p className="kpulse-lede">
              {pulseSentenceParts(facts).map((p, i) => p.strong ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>)}
            </p>
          )}
          <span className="sr-only" role="status">{announce}</span>
          {failed && (
            <p className="kpulse-note" role="status">
              Couldn't load today's changes — showing what Kanbo knows from task dates.{" "}
              <button type="button" className="kpulse-link" onClick={() => setAttempt((a) => a + 1)}>Try again</button>
            </p>
          )}
        </div>

        <aside className="kpulse-radar" aria-label="Radar">
          <RadarPanel risks={risks} members={people} readOnly={readOnly} tasks={tasks} loading={loading} currentUserId={currentUserId}
            onOpen={onOpen} onNudge={onNudge} onPatch={onPatch} onOpenWorkload={onOpenWorkload}
            action={!readOnly && !loading && risks.length > 0
              ? <SlackPostButton workspaceId={workspaceId} kind="risks" variant="ghost" getText={() => risksSlackText(risks)} />
              : undefined} />
        </aside>

        {!loading && facts.people.length === 0 ? (
          <div className="kpt kpt-empty">
            <EmptyState art="users" size="md" title="Nobody here yet"
              body="Invite your team, and Pulse fills in from what they finish, what's on today and what's blocked."
              action={onOpenPeople && !readOnly ? <Button variant="primary" icon="plus" onClick={onOpenPeople}>Invite people</Button> : undefined} />
          </div>
        ) : (
        <div className="kpt" role="table" aria-label={`Pulse, ${doneLabel.toLowerCase()}`} aria-busy={loading || undefined}>
          <div role="rowgroup">
            <div className="kpt-row kpt-head" role="row">
              <span role="columnheader">Person</span>
              <span role="columnheader">{doneLabel}</span>
              <span role="columnheader">On today</span>
              <span role="columnheader" className="kpt-num" title="This week's estimated hours against capacity (tasks without an estimate count 1h)">This week</span>
            </div>
          </div>
          <div role="rowgroup">
            {loading
              ? [0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="kpt-row" role="row" aria-hidden="true">
                  <span className="kpt-who"><span className="skel" style={{ width: 28, height: 28, borderRadius: 999, flexShrink: 0 }} /><span className="skel" style={{ height: 12, width: 96 - i * 6 }} /></span>
                  <span className="kpt-skel"><span className="skel" style={{ width: `${70 - i * 7}%` }} /></span>
                  <span className="kpt-skel"><span className="skel" style={{ width: `${82 - i * 5}%` }} /><span className="skel" style={{ width: `${56 + i * 4}%` }} /></span>
                  <span className="kpt-skel kpt-num"><span className="skel" style={{ width: 72, marginLeft: "auto" }} /></span>
                </div>
              ))
              : facts.people.map((p) => <PulseRow key={p.id} p={p} tasks={tasks} people={people} doneLabel={doneLabel} onOpen={onOpen} />)}
          </div>
        </div>
        )}
      </div>

      <Sheet open={!!writeUp} onClose={closeWriteUp} label="Write it up" title="Write it up" width={640}
        footer={writeUp?.status === "ready" ? (
          <>
            {!readOnly && <SlackPostButton workspaceId={workspaceId} kind="standup" getText={() => draft} variant="secondary" size="md" disabled={!draft.trim()} />}
            <Button variant="secondary" onClick={() => void copy(draft, "plain")}>Copy</Button>
            <Button variant="primary" icon="copy" onClick={() => void copy(draft, "slack")}>Copy for Slack</Button>
          </>
        ) : undefined}>
        {writeUp?.status === "loading" ? (
          <div className="kpulse-writing" role="status">
            <p className="kpulse-writing-line"><AiMark size={16} thinking />Kanbo is writing the update</p>
            <div aria-hidden="true" className="kpulse-writing-skel"><span className="skel" /><span className="skel" /><span className="skel" /><span className="skel" /></div>
          </div>
        ) : writeUp?.status === "ready" ? (
          writeUp.ai ? (
            <Vellum provenance={provenance}>
              <textarea className="kpulse-text" aria-label="Standup text" rows={rowsFor(draft)} value={draft} onChange={(e) => setDraft(e.target.value)} />
            </Vellum>
          ) : (
            <>
              <textarea className="kpulse-text" data-plain="" aria-label="Standup text" rows={rowsFor(draft)} value={draft} onChange={(e) => setDraft(e.target.value)} />
              {writeUp.note && <p className="kpulse-note">{writeUp.note}</p>}
            </>
          )
        ) : null}
      </Sheet>
    </div>
  );
}

/** One person's row: what they finished, what's on today (blocked work first), and their week. */
function PulseRow({ p, tasks, people, doneLabel, onOpen }: { p: PulsePerson; tasks: Task[]; people: Person[]; doneLabel: string; onOpen: (id: string) => void }) {
  const today = [...p.blocked, ...p.onToday];
  const waitingOn = (t: Task): string => {
    const blocker = (t.dependencies ?? []).map((id) => tasks.find((x) => x.id === id)).find((x) => x && x.status !== "done");
    if (!blocker) return "Blocked";
    const owner = blocker.assigneeId ? (people.find((x) => x.id === blocker.assigneeId)?.name ?? getMember(blocker.assigneeId)?.name) : "";
    return owner ? `Blocked · waiting on ${firstName(owner)}` : `Blocked · waiting on "${blocker.title}"`;
  };
  const tone = loadTone(p.loadHours, p.capacity);
  return (
    <div className="kpt-row" role="row">
      <span className="kpt-who" role="rowheader">
        {getMember(p.id) ? <Avatar id={p.id} size={28} /> : <span className="kpt-initial" aria-hidden="true">{firstName(p.name).charAt(0).toUpperCase()}</span>}
        <span className="kpt-who-text">
          <span className="kpt-name">{p.name}</span>
          {p.role && <span className="kpt-role">{p.role}</span>}
        </span>
      </span>
      <span role="cell" data-label={doneLabel}>
        <ItemList items={p.done} empty="Nothing yet" onOpen={onOpen} />
      </span>
      <span role="cell" data-label="On today">
        <ItemList items={today} empty="Nothing on today" onOpen={onOpen}
          note={(t) => t.status === "blocked" ? { text: waitingOn(t), tone: "signal" }
            : t.status !== "progress" && t.status !== "review" && t.dueDate ? dueNote(t.dueDate) : null} />
      </span>
      <span role="cell" className="kpt-load" data-label="This week">
        {p.guest ? <span className="kpt-guest">Guest</span> : (
          <>
            <span className="kpt-hours" data-tone={tone}>
              <span aria-hidden="true">{p.loadHours}h / {p.capacity}h</span>
              <span className="sr-only">{loadWords(p.loadHours, p.capacity, tone)}</span>
            </span>
            {/* the figures say it all to a screen reader; a progressbar's percentage (of 125% of capacity) would only confuse */}
            <span className="kpt-meter" aria-hidden="true">
              <Meter value={p.loadHours} max={p.capacity * 1.25} marker={p.capacity} width={72} height={4} tone={tone}
                label={`${p.name}: ${p.loadHours} of ${p.capacity} hours this week`} />
            </span>
          </>
        )}
      </span>
    </div>
  );
}

/** "42 of 40 hours this week, over capacity" */
function loadWords(hours: number, capacity: number, tone: "ink" | "warn" | "signal"): string {
  return `${hours} of ${capacity} hours this week${tone === "signal" ? ", over capacity" : tone === "warn" ? ", near capacity" : ""}`;
}

function dueNote(iso: string): { text: string; tone?: "signal" } | null {
  const today = toLocalISO(KANBO_TODAY);
  if (iso < today) { const d = localDay(iso); return { text: `Overdue · due ${d ? fmtDayMonth(d) : iso}`, tone: "signal" }; }
  if (iso === today) return { text: "Due today" };
  return null;
}

/** Up to three tasks, then "+n more" to show the rest. */
function ItemList({ items, empty, onOpen, note }: {
  items: Task[]; empty: string; onOpen: (id: string) => void;
  note?: (t: Task) => { text: string; tone?: "signal" } | null;
}) {
  const [all, setAll] = useState(false);
  if (!items.length) return <span className="kpt-none">{empty}</span>;
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <span className="kpt-items">
      {shown.map((t) => {
        const n = note?.(t);
        return (
          <button key={t.id} type="button" className="kpt-item" onClick={() => onOpen(t.id)}>
            <StatusGlyph status={t.status} size={14} />
            <span className="kpt-item-text">
              <span className="kpt-item-title">{t.title}</span>
              {n && <span className="kpt-item-note" data-tone={n.tone}>{n.text}</span>}
            </span>
          </button>
        );
      })}
      {items.length > SHOWN && (
        <button type="button" className="kpt-more" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `+${items.length - SHOWN} more`}
        </button>
      )}
    </span>
  );
}

const PULSE_CSS = `
.kpulse { flex: 1; min-width: 0; overflow-y: auto; container-type: inline-size; }
.kpulse[data-personal] { padding: 0 var(--gutter, 32px); }
.kpulse[data-personal] { display: grid; place-items: center; }
.kpulse-grid { display: grid; grid-template-columns: minmax(0, 1fr) var(--radar-w, 380px);
  grid-template-areas: "bar radar" "lede radar" "table radar"; grid-template-rows: auto auto 1fr; min-height: 100%;
  padding: 0 0 48px var(--gutter, 32px); box-sizing: border-box; }
.kpulse-bar { grid-area: bar; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 48px; padding: 0 32px 0 0; }
.kpulse-bar-end { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; }
.kpulse-lede-wrap { grid-area: lede; padding: 12px 32px 0 0; }
.kpulse-lede { max-width: var(--read-max, 720px); margin: 0; font: 500 22px/30px var(--font-head); letter-spacing: -0.015em; color: var(--ink); text-wrap: pretty; }
.kpulse-lede b { font-weight: 600; }
.kpulse-lede-skel { display: grid; gap: 10px; max-width: 620px; padding: 4px 0; }
.kpulse-lede-skel .skel { height: 20px; border-radius: var(--r-sm, 6px); }
.kpulse-lede-skel .skel:last-child { width: 62%; }
.kpulse-note { margin: 10px 0 0; font: 500 12px/18px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kpulse-link { padding: 0; border: 0; background: none; color: var(--accent-text, var(--accent)); font: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.kpulse-radar { grid-area: radar; min-width: 0; padding: 0 var(--gutter, 32px) 24px 24px; border-left: 1px solid var(--hairline); }
.kpt { grid-area: table; min-width: 0; margin-top: 24px; padding-right: 32px; }
.kpt-row { display: grid; grid-template-columns: 180px minmax(0, 1fr) minmax(0, 1.35fr) 140px; gap: 0 20px; align-items: start; }
.kpt-head { min-height: 32px; align-items: center; border-bottom: 1px solid var(--hairline); font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kpt [role="rowgroup"] + [role="rowgroup"] > .kpt-row { min-height: 64px; padding: 14px 0; border-bottom: 1px solid var(--hairline); }
.kpt [role="rowgroup"] + [role="rowgroup"] > .kpt-row:last-child { border-bottom: 0; }
.kpt-num { text-align: right; }
.kpt-who { display: flex; align-items: center; gap: 10px; min-width: 0; }
.kpt-who-text { display: flex; flex-direction: column; min-width: 0; }
.kpt-name { font: 600 14px/20px var(--font-ui, var(--font-display)); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kpt-role { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kpt-initial { width: 28px; height: 28px; flex-shrink: 0; border-radius: 999px; display: grid; place-items: center; background: var(--fill-2); color: var(--ink-2); font: 600 12px/1 var(--font-ui, var(--font-display)); }
.kpt-items { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.kpt-item { display: flex; align-items: flex-start; gap: 8px; width: calc(100% + 12px); min-width: 0; margin: -2px -6px; padding: 2px 6px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; color: var(--ink); text-align: left; cursor: pointer; transition: background var(--d-1, 90ms) var(--ease); }
.kpt-item:hover { background: var(--fill-1); }
.kpt-item .kglyph { margin-top: 3px; flex-shrink: 0; }
.kpt-item-text { display: flex; flex-direction: column; min-width: 0; }
.kpt-item-title { font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.kpt-item-note { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kpt-item-note[data-tone="signal"] { color: var(--signal, var(--st-blocked)); }
.kpt-more { align-self: flex-start; margin: 2px 0 0 16px; padding: 0 6px; height: 20px; border: 0; border-radius: var(--r-xs, 4px); background: transparent;
  color: var(--ink-3); font: 500 12px/20px var(--font-ui, var(--font-display)); cursor: pointer; }
.kpt-more:hover { background: var(--fill-1); color: var(--ink-2); }
.kpt-none { font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-4); }
.kpt-load { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; padding-top: 2px; }
.kpt-hours { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-2); white-space: nowrap; }
.kpt-hours[data-tone="signal"] { color: var(--signal, var(--st-blocked)); }
.kpt-meter { display: flex; }
.kpt-load .kmeter-wrap { flex: none; }
.kpt-guest { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kpt-skel { display: grid; gap: 8px; padding-top: 4px; }
.kpt-skel .skel { height: 12px; border-radius: var(--r-xs, 4px); }
.kpt-empty { display: grid; place-items: center; padding: 40px 0 24px; }
.kpulse-text { display: block; width: 100%; min-height: 132px; max-height: 420px; resize: vertical; padding: 0; border: 0; background: transparent; color: var(--ink);
  font: 400 14px/22px var(--font-ui, var(--font-display)); }
@supports (field-sizing: content) { .kpulse-text { field-sizing: content; } }
.kpulse-text:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 2px; }
.kpulse-text[data-plain] { padding: 12px; border-radius: var(--r-md, 8px); border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface)); }
.kpulse-writing { display: grid; gap: 16px; padding: 8px 0 16px; }
.kpulse-writing-line { display: flex; align-items: center; gap: 10px; margin: 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kpulse-writing-skel { display: grid; gap: 10px; }
.kpulse-writing-skel .skel { height: 14px; border-radius: var(--r-xs, 4px); }
.kpulse-writing-skel .skel:nth-child(2) { width: 88%; } .kpulse-writing-skel .skel:nth-child(3) { width: 94%; } .kpulse-writing-skel .skel:nth-child(4) { width: 60%; }
@container (max-width: 1180px) {
  .kpulse-grid { grid-template-columns: minmax(0, 1fr) 320px; }
  .kpt-row { grid-template-columns: 148px minmax(0, 1fr) minmax(0, 1.3fr) 120px; gap: 0 16px; }
}
@container (max-width: 959px) {
  .kpulse-grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: "bar" "lede" "radar" "table"; grid-template-rows: auto; padding-right: var(--gutter, 32px); }
  .kpulse-bar, .kpulse-lede-wrap, .kpt { padding-right: 0; }
  .kpulse-radar { margin-top: 24px; padding: 8px 0 8px; border-left: 0; border-top: 1px solid var(--hairline); border-bottom: 1px solid var(--hairline); }
}
@container (max-width: 700px) {
  .kpt-head { display: none; }
  .kpt [role="rowgroup"] + [role="rowgroup"] > .kpt-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "who load" "done done" "today today"; gap: 12px 16px; padding: 16px 0; }
  .kpt-row > .kpt-who { grid-area: who; }
  .kpt-row > [data-label]:nth-child(2) { grid-area: done; }
  .kpt-row > [data-label]:nth-child(3) { grid-area: today; }
  .kpt-row > .kpt-load { grid-area: load; }
  .kpt-row > [data-label]:not(.kpt-load)::before { content: attr(data-label); display: block; margin-bottom: 4px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
  .kpulse-bar { padding-block: 8px; }
  .kpulse-bar-end { margin-left: 0; width: 100%; flex-wrap: wrap; }
  .kpulse-bar-end .kbtn { flex: 1; }
  .kpulse-bar-end > .kslk-post { flex: 1 1 auto; }
}
@media (max-width: 859px) { .kpulse-grid { padding: 0 16px 32px; } .kpulse[data-personal] { padding: 0 16px; } }
`;

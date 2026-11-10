/* ============================================================
   KANBO — the demo's meetings (0056). Demo mode has no database, so
   meetings live in lib/meetings/sync's in-memory copy, seeded here:
     • Foundrise's last team meeting (three days ago, Maya presented):
       two decisions, a note and five actions, one done, one blocked,
       one due today, one still open and one never made a task (now
       overdue), so the next meeting opens with real states;
     • Courtside Padel's leadership meeting (yesterday, Theo ran it):
       two decisions and three actions;
     • both recaps in Daniel's Inbox (kind "meeting").
   And the teammates act as their browsers would: start a team meeting
   at Foundrise and Maya and Theo join a moment later; hand the agenda
   to one of them and they present, a step every few seconds, so you
   see the room follow the presenter's place. Nothing leaves the browser.
   ============================================================ */
import type { Activity } from "../../data/types";
import { dayOffset, KANBO_TODAY } from "../../data/data";
import { addMemHooks, isDemoMeetings, memAct, setDemoSeeder } from "./sync";
import { meetingDay, type AgendaItem, type Meeting, type MeetingAttendee, type MeetingItem } from "./types";

/** `n` days back, stepped back to a Friday when that lands on a weekend (nobody meets on a Sunday) */
const dayOf = (n: number) => {
  const d = new Date(KANBO_TODAY);
  d.setDate(d.getDate() - n);
  if (d.getDay() === 0) d.setDate(d.getDate() - 2);
  if (d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d;
};
const at = (daysAgo: number, hh: number, mm = 0): string => {
  const d = dayOf(daysAgo);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
};

export const DEMO_TEAM_MEETING = "mtg-demo-foundrise";
export const DEMO_LEAD_MEETING = "mtg-demo-courtside";
const TEAM_TITLE = `Foundrise team meeting, ${meetingDay(dayOf(3))}`;
const LEAD_TITLE = `Courtside Padel leadership, ${meetingDay(dayOf(1))}`;

const agenda = (lede: string, titles: [string, AgendaItem["kind"]][]): AgendaItem[] => [
  { key: "overview", kind: "overview", title: "Where things stand", lede: [{ text: lede }] },
  ...titles.map(([title, kind]): AgendaItem => {
    if (kind === "risks") return { key: "risks", kind, title, risks: [] };
    if (kind === "goals") return { key: "goals", kind, title, goals: [] };
    if (kind === "projects") return { key: "projects", kind, title, projects: [] };
    return { key: `person:${title}`, kind: "person", title, personId: title, done: [], today: [], blocked: [], more: { done: 0, today: 0, blocked: 0 } };
  }),
  { key: "wrap", kind: "wrap", title: "Wrap up" },
];

const item = (meetingId: string, id: string, kind: MeetingItem["kind"], body: string, o: Partial<MeetingItem> & { by: string; when: string }): MeetingItem => ({
  id, meetingId, kind, body, agendaKey: o.agendaKey ?? null, ownerId: o.ownerId ?? null, due: o.due ?? null, taskId: o.taskId ?? null,
  createdBy: o.by, createdAt: o.when,
});

function seed(db: { meetings: Map<string, Meeting>; items: Map<string, MeetingItem[]>; attendees: Map<string, MeetingAttendee[]> }): void {
  const teamEnd = at(3, 10, 25);
  db.meetings.set(DEMO_TEAM_MEETING, {
    id: DEMO_TEAM_MEETING, workspaceId: "ws-foundrise", workspaceIds: ["ws-foundrise"], preset: "team", title: TEAM_TITLE, status: "ended",
    agenda: agenda("The team finished 5 tasks. The launch deck is the critical path, and onboarding is waiting on design tokens.",
      [["Maya Lin", "person"], ["Theo Vance", "person"], ["Sana Rao", "person"], ["Daniel Okai", "person"], ["Radar risks", "risks"]]),
    place: 6, placeKey: "wrap", movedAt: teamEnd, presenterId: "m-1", startedBy: "m-1", startedAt: at(3, 10, 2), endedAt: teamEnd, endedBy: "m-1",
    previousId: null, docId: null, docProjectId: "p-launch",
  });
  const w = (m: number) => at(3, 10, m);
  db.items.set(DEMO_TEAM_MEETING, [
    item(DEMO_TEAM_MEETING, "mi-demo-1", "decision", "Launch stays on the date we picked: the deck is the critical path", { by: "m-1", when: w(6), agendaKey: "overview" }),
    item(DEMO_TEAM_MEETING, "mi-demo-2", "decision", "The design tokens v2 review moves to Wednesday", { by: "m-3", when: w(14), agendaKey: "person:Sana Rao" }),
    item(DEMO_TEAM_MEETING, "mi-demo-3", "note", "Theo has the demo video in hand; first cut by Friday", { by: "m-2", when: w(10), agendaKey: "person:Theo Vance" }),
    item(DEMO_TEAM_MEETING, "mi-demo-4", "action", "Record the product demo video", { by: "m-1", when: w(11), ownerId: "m-2", taskId: "t-24", due: dayOffset(0) }),
    item(DEMO_TEAM_MEETING, "mi-demo-5", "action", "Ship onboarding redesign to staging", { by: "m-1", when: w(9), ownerId: "m-1", taskId: "t-2", due: dayOffset(1) }),
    item(DEMO_TEAM_MEETING, "mi-demo-6", "action", "Send the interview brief", { by: "m-1", when: w(18), ownerId: "m-self", taskId: "t-21", due: dayOffset(0) }),
    item(DEMO_TEAM_MEETING, "mi-demo-7", "action", "Book the venue for the launch party", { by: "m-2", when: w(19), ownerId: "m-2", taskId: "t-26", due: dayOffset(6) }),
    item(DEMO_TEAM_MEETING, "mi-demo-8", "action", "Chase legal on the pricing page copy", { by: "m-1", when: w(20), ownerId: "m-3", due: dayOffset(-2) }),
  ]);
  db.attendees.set(DEMO_TEAM_MEETING, ["m-1", "m-2", "m-3", "m-self"].map((u) => ({ userId: u, invited: true, joinedAt: w(2) })));

  const leadEnd = at(1, 17, 40);
  db.meetings.set(DEMO_LEAD_MEETING, {
    id: DEMO_LEAD_MEETING, workspaceId: "ws-courtside", workspaceIds: ["ws-courtside"], preset: "leadership", title: LEAD_TITLE, status: "ended",
    agenda: agenda("The clubhouse fit-out is off track and its update is missing; the winter league is on pace.",
      [["Goals behind pace", "goals"], ["Projects to look at", "projects"], ["Radar risks", "risks"]]),
    place: 4, placeKey: "wrap", movedAt: leadEnd, presenterId: "m-2", startedBy: "m-2", startedAt: at(1, 17, 0), endedAt: leadEnd, endedBy: "m-2",
    previousId: null, docId: null, docProjectId: "p-clubhouse",
  });
  const l = (m: number) => at(1, 17, m);
  db.items.set(DEMO_LEAD_MEETING, [
    item(DEMO_LEAD_MEETING, "mi-demo-l1", "decision", "Go with the resurfacing contractor who can start in December", { by: "m-2", when: l(12), agendaKey: "projects" }),
    item(DEMO_LEAD_MEETING, "mi-demo-l2", "decision", "The winter league opens with two sponsors, not three", { by: "m-self", when: l(20), agendaKey: "goals" }),
    item(DEMO_LEAD_MEETING, "mi-demo-l3", "action", "Sign the clubhouse lighting order", { by: "m-2", when: l(14), ownerId: "m-self", taskId: "t-36", due: dayOffset(-2) }),
    item(DEMO_LEAD_MEETING, "mi-demo-l4", "action", "Book the electrician's second fix", { by: "m-2", when: l(15), ownerId: "m-2", taskId: "t-37", due: dayOffset(-1) }),
    item(DEMO_LEAD_MEETING, "mi-demo-l5", "action", "Print the league scorecards", { by: "m-self", when: l(22), ownerId: "m-2", taskId: "t-41", due: dayOffset(5) }),
  ]);
  db.attendees.set(DEMO_LEAD_MEETING, ["m-2", "m-self"].map((u) => ({ userId: u, invited: true, joinedAt: l(1) })));
}

/** The recaps in Daniel's Inbox (the store adds them to the demo's activity). */
export function demoMeetingActivity(): Activity[] {
  return [
    { id: "a-demo-mtg-1", taskId: null, taskTitle: TEAM_TITLE, kind: "meeting", detail: "Maya Lin", createdAt: at(3, 10, 25),
      meta: { meetingId: DEMO_TEAM_MEETING, workspaceId: "ws-foundrise", meetingPreset: "team", decisions: 2, actions: 5, projectId: "p-launch" } },
    { id: "a-demo-mtg-2", taskId: null, taskTitle: LEAD_TITLE, kind: "meeting", detail: "Theo Vance", createdAt: at(1, 17, 40),
      meta: { meetingId: DEMO_LEAD_MEETING, workspaceId: "ws-courtside", meetingPreset: "leadership", decisions: 2, actions: 3, projectId: "p-clubhouse" } },
  ];
}

/* ---------- the teammates in the room ---------- */

/** Who comes to a demo meeting at each business (besides you). */
const ROOM: Record<string, { team: string[]; leadership: string[] }> = {
  "ws-foundrise": { team: ["m-1", "m-2"], leadership: [] },
  "ws-reco": { team: ["m-1"], leadership: [] },
  "ws-courtside": { team: ["m-2"], leadership: ["m-2"] },
  "ws-harbour": { team: ["m-3"], leadership: ["m-3"] },
};
/** How long after a meeting starts each teammate joins, and how long a teammate stays on each item. */
export const DEMO_JOIN_MS = [1400, 2800];
export const DEMO_STEP_MS = 5000;

const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
const presenting = new Map<string, { who: string; timer: ReturnType<typeof setInterval> }>();
const joined = new Set<string>();
const clearMeeting = (id: string) => {
  (timers.get(id) ?? []).forEach(clearTimeout);
  timers.delete(id);
  const p = presenting.get(id);
  if (p) { clearInterval(p.timer); presenting.delete(id); }
};

let installed = false;
/** Install the demo: its seeded meetings and its teammates. Idempotent; does nothing with a database. */
export function installDemoMeetings(): void {
  if (installed) return;
  installed = true;
  setDemoSeeder(seed);
  addMemHooks({
    reset: () => { [...timers.keys(), ...presenting.keys()].forEach(clearMeeting); joined.clear(); },
    onChange: (m) => {
      if (m.status !== "live") { clearMeeting(m.id); return; }
      const room = m.workspaceIds.length > 1 ? [] : ROOM[m.workspaceId]?.[m.preset] ?? [];
      // they join once, a moment after it starts
      if (!joined.has(m.id)) {
        joined.add(m.id);
        const list = room.slice(0, DEMO_JOIN_MS.length).map((who, i) => setTimeout(() => memAct(m.id, who, { join: true }), DEMO_JOIN_MS[i]));
        timers.set(m.id, [...(timers.get(m.id) ?? []), ...list]);
      }
      // handed the agenda, a teammate presents: a step every few seconds, up to the wrap-up
      const cur = presenting.get(m.id);
      if (cur && cur.who !== m.presenterId) { clearInterval(cur.timer); presenting.delete(m.id); }
      if (m.presenterId && room.includes(m.presenterId) && !presenting.has(m.id)) {
        const who = m.presenterId;
        let place = m.place;
        const timer = setInterval(() => {
          place += 1;
          const next = memAct(m.id, who, { place: Math.min(place, m.agenda.length - 1) });
          if (!next || next.presenterId !== who || place >= m.agenda.length - 1) { clearInterval(timer); presenting.delete(m.id); }
        }, DEMO_STEP_MS);
        presenting.set(m.id, { who, timer });
      }
    },
  });
}

// (the demo's meetings are there from the first read: the copy is seeded the first time it's used)
if (isDemoMeetings()) installDemoMeetings();

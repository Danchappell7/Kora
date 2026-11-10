/* ============================================================
   KANBO — meetings (0056): the shapes. A meeting is hosted by one
   business, as a team meeting or a leadership meeting (a Group one
   covers several businesses). Its agenda is Kanbo's snapshot, made
   when it starts, so everyone watching reads the same thing; `place`
   is the presenter's place in it. Items are the notes, decisions and
   actions logged in it. Pure types and the agenda's parser.
   ============================================================ */
import type { Status } from "../../data/types";

export type MeetingPreset = "team" | "leadership";
/** The agenda's sections, in the one order both presets share. */
export type MeetingSection = "people" | "risks" | "goals" | "projects" | "actions";
export type MeetingItemKind = "note" | "decision" | "action";
export type Tone = "neutral" | "accent" | "ok" | "warn" | "signal";

/** A task as the agenda shows it (its live status is read again where the viewer has the task). */
export interface AgendaEntry { taskId: string; title: string; status: Status; note?: string; tone?: "signal" }

export interface AgendaRisk {
  id: string; title: string; reason: string; severity: "signal" | "warn" | "neutral";
  memberId?: string; taskIds: string[]; workspaceId?: string | null;
}
export interface AgendaGoal {
  id: string; name: string; pct: number; why: "off_track" | "at_risk" | "overdue" | "pace";
  /** "Behind pace by 12%", "Off track", "Past due at 40%" */
  line: string; ownerId?: string | null; workspaceId?: string | null; due?: string | null;
}
export interface AgendaProject {
  id: string; name: string; emoji?: string; color?: string;
  /** "Update missing", "Off track", "At risk" */
  label: string; detail: string;
  /** the one pill: "Lead says On track" / "Kanbo sees 3 overdue" */
  pill: string; tone: Tone; says: string; sees: string; mismatch: boolean; missing?: boolean;
  workspaceId?: string | null;
}
export interface AgendaAction { itemId: string; body: string; ownerId?: string | null; taskId?: string | null; due?: string | null }

export type AgendaItem =
  | { key: "overview"; kind: "overview"; title: string; lede: { text: string; strong?: boolean }[] }
  | {
      key: string; kind: "person"; title: string; personId: string; role?: string;
      /** "Off today", "Off until Mon" (never the reason) */
      off?: string; offNow?: boolean;
      done: AgendaEntry[]; today: AgendaEntry[]; blocked: AgendaEntry[];
      /** how many more there were than shown */
      more: { done: number; today: number; blocked: number };
      load?: { hours: number; capacity: number };
    }
  | { key: "risks"; kind: "risks"; title: string; risks: AgendaRisk[] }
  | { key: "goals"; kind: "goals"; title: string; goals: AgendaGoal[] }
  | { key: "projects"; kind: "projects"; title: string; projects: AgendaProject[] }
  | { key: "actions"; kind: "actions"; title: string; from: { id: string; title: string; endedAt: string | null } | null; actions: AgendaAction[] }
  | { key: "wrap"; kind: "wrap"; title: string };

export type AgendaKind = AgendaItem["kind"];

export interface Meeting {
  id: string;
  workspaceId: string;
  workspaceIds: string[];
  preset: MeetingPreset;
  title: string;
  status: "live" | "ended";
  agenda: AgendaItem[];
  place: number;
  placeKey: string | null;
  movedAt: string;
  presenterId: string | null;
  startedBy: string | null;
  startedAt: string;
  endedAt: string | null;
  endedBy: string | null;
  previousId: string | null;
  docId: string | null;
  docProjectId: string | null;
}

export interface MeetingItem {
  id: string;
  meetingId: string;
  kind: MeetingItemKind;
  body: string;
  agendaKey: string | null;
  ownerId: string | null;
  due: string | null;
  taskId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface MeetingAttendee { userId: string; invited: boolean; joinedAt: string | null }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Tue 10 Nov" */
export function meetingDay(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/* ---------- reading what another browser stored ---------- */

const str = (v: unknown, max = 400): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const STATUSES = new Set<Status>(["todo", "progress", "review", "blocked", "done"]);
const TONES = new Set<Tone>(["neutral", "accent", "ok", "warn", "signal"]);
const SEVERITIES = new Set(["signal", "warn", "neutral"]);
const WHYS = new Set(["off_track", "at_risk", "overdue", "pace"]);

function entry(raw: unknown): AgendaEntry | null {
  const r = obj(raw);
  const taskId = str(r?.taskId, 64), title = str(r?.title, 200);
  if (!r || !taskId || !title) return null;
  const status = STATUSES.has(r.status as Status) ? (r.status as Status) : "todo";
  return { taskId, title, status, ...(str(r.note, 120) ? { note: str(r.note, 120) } : {}), ...(r.tone === "signal" ? { tone: "signal" as const } : {}) };
}
const entries = (v: unknown) => list(v).map(entry).filter((x): x is AgendaEntry => !!x).slice(0, 12);
const ids = (v: unknown) => list(v).map((x) => str(x, 64)).filter((x): x is string => !!x).slice(0, 20);

/** One stored agenda item, checked; null when it's not one Kanbo would have written. */
export function parseAgendaItem(raw: unknown): AgendaItem | null {
  const r = obj(raw);
  if (!r) return null;
  const title = str(r.title, 140) ?? "";
  switch (r.kind) {
    case "overview":
      return { key: "overview", kind: "overview", title: title || "Overview",
        lede: list(r.lede).map((p) => obj(p)).filter((p): p is Record<string, unknown> => !!p && typeof p.text === "string")
          .slice(0, 40).map((p) => ({ text: String(p.text).slice(0, 300), ...(p.strong === true ? { strong: true } : {}) })) };
    case "person": {
      const personId = str(r.personId, 64), key = str(r.key, 200);
      if (!personId || !key) return null;
      const more = obj(r.more);
      const load = obj(r.load);
      return {
        key, kind: "person", title: title || "Someone", personId,
        ...(str(r.role, 80) ? { role: str(r.role, 80) } : {}),
        ...(str(r.off, 60) ? { off: str(r.off, 60), offNow: r.offNow === true } : {}),
        done: entries(r.done), today: entries(r.today), blocked: entries(r.blocked),
        more: { done: Math.max(0, num(more?.done) ?? 0), today: Math.max(0, num(more?.today) ?? 0), blocked: Math.max(0, num(more?.blocked) ?? 0) },
        ...(load && num(load.hours) !== undefined && num(load.capacity) !== undefined ? { load: { hours: num(load.hours)!, capacity: num(load.capacity)! } } : {}),
      };
    }
    case "risks":
      return { key: "risks", kind: "risks", title: title || "Radar risks", risks: list(r.risks).map((x): AgendaRisk | null => {
        const o = obj(x);
        const id = str(o?.id, 200), t = str(o?.title, 300);
        if (!o || !id || !t) return null;
        return { id, title: t, reason: str(o.reason, 300) ?? "", severity: SEVERITIES.has(String(o.severity)) ? o.severity as AgendaRisk["severity"] : "neutral",
          ...(str(o.memberId, 64) ? { memberId: str(o.memberId, 64) } : {}), taskIds: ids(o.taskIds), workspaceId: str(o.workspaceId, 64) ?? null };
      }).filter((x): x is AgendaRisk => !!x).slice(0, 20) };
    case "goals":
      return { key: "goals", kind: "goals", title: title || "Goals behind pace", goals: list(r.goals).map((x): AgendaGoal | null => {
        const o = obj(x);
        const id = str(o?.id, 64), name = str(o?.name, 200);
        if (!o || !id || !name) return null;
        return { id, name, pct: Math.max(0, Math.min(100, Math.round(num(o.pct) ?? 0))), why: WHYS.has(String(o.why)) ? o.why as AgendaGoal["why"] : "at_risk",
          line: str(o.line, 120) ?? "", ownerId: str(o.ownerId, 64) ?? null, workspaceId: str(o.workspaceId, 64) ?? null, due: str(o.due, 10) ?? null };
      }).filter((x): x is AgendaGoal => !!x).slice(0, 20) };
    case "projects":
      return { key: "projects", kind: "projects", title: title || "Projects to look at", projects: list(r.projects).map((x): AgendaProject | null => {
        const o = obj(x);
        const id = str(o?.id, 64), name = str(o?.name, 200);
        if (!o || !id || !name) return null;
        return { id, name, ...(str(o.emoji, 16) ? { emoji: str(o.emoji, 16) } : {}), ...(str(o.color, 80) ? { color: str(o.color, 80) } : {}),
          label: str(o.label, 60) ?? "", detail: str(o.detail, 200) ?? "", pill: str(o.pill, 60) ?? "", tone: TONES.has(o.tone as Tone) ? o.tone as Tone : "neutral",
          says: str(o.says, 120) ?? "", sees: str(o.sees, 120) ?? "", mismatch: o.mismatch === true, ...(o.missing === true ? { missing: true } : {}),
          workspaceId: str(o.workspaceId, 64) ?? null };
      }).filter((x): x is AgendaProject => !!x).slice(0, 20) };
    case "actions": {
      const from = obj(r.from);
      return { key: "actions", kind: "actions", title: title || "Last meeting's actions",
        from: from && str(from.id, 64) ? { id: str(from.id, 64)!, title: str(from.title, 140) ?? "Last meeting", endedAt: str(from.endedAt, 40) ?? null } : null,
        actions: list(r.actions).map((x): AgendaAction | null => {
          const o = obj(x);
          const itemId = str(o?.itemId, 64), body = str(o?.body, 1000);
          if (!o || !itemId || !body) return null;
          return { itemId, body, ownerId: str(o.ownerId, 64) ?? null, taskId: str(o.taskId, 64) ?? null, due: str(o.due, 10) ?? null };
        }).filter((x): x is AgendaAction => !!x).slice(0, 40) };
    }
    case "wrap":
      return { key: "wrap", kind: "wrap", title: title || "Wrap up" };
    default:
      return null;
  }
}

/** A stored agenda → the items Kanbo can show (anything malformed is left out; keys stay unique). */
export function parseAgenda(raw: unknown): AgendaItem[] {
  const seen = new Set<string>();
  const out: AgendaItem[] = [];
  for (const x of list(raw).slice(0, 200)) {
    const it = parseAgendaItem(x);
    if (!it || seen.has(it.key)) continue;
    seen.add(it.key);
    out.push(it);
  }
  return out;
}

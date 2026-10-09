/* ============================================================
   KANBO — the two 0048 parsers the store needs at sign-in:
   profiles.onboarding → OnboardingState, projects.board_settings →
   BoardSettings. Kept apart from ./rows0048 (which re-exports them) so
   the first download carries only these.          [architect: final]
   ============================================================ */
import type {
  BoardSettings, MomentumPrefs, OnboardingChecklistState, OnboardingSample, OnboardingState, OnboardingTourState,
  SetupItemId, TourRole,
} from "../data/types";

type Row = Record<string, unknown>;
const isObj = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strOr = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v: unknown): boolean => v === true || v === "true";
const strArr = (v: unknown, max = 200): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []);

export const WIP_LIMIT_MAX = 999;
export const ONBOARDING_MAX_BYTES = 16384;
export const BOARD_SETTINGS_MAX_BYTES = 4096;

/* ---------- profiles.onboarding ---------- */

const TOUR_ROLES: readonly TourRole[] = ["owner", "member", "guest"];
const SETUP_ITEMS: readonly SetupItemId[] = ["invite_team", "connect_calendar", "add_domain", "connect_slack", "plan_day", "complete_task", "install_app", "set_notifications"];

/** profiles.onboarding → OnboardingState (unknown keys dropped; never throws). */
export function parseOnboardingState(raw: unknown): OnboardingState {
  if (!isObj(raw)) return {};
  const out: OnboardingState = {};
  if (raw.v === 1) out.v = 1;
  if (isObj(raw.tour)) {
    const t = raw.tour;
    const tour: OnboardingTourState = { step: str(t.step), done: bool(t.done) };
    if (t.skipped !== undefined) tour.skipped = bool(t.skipped);
    if (typeof t.role === "string" && (TOUR_ROLES as readonly string[]).includes(t.role)) tour.role = t.role as TourRole;
    if (str(t.updatedAt)) tour.updatedAt = t.updatedAt as string;
    out.tour = tour;
  }
  if (isObj(raw.checklist)) {
    const c = raw.checklist;
    const list: OnboardingChecklistState = {};
    if (isObj(c.done)) {
      const done: Partial<Record<SetupItemId, string>> = {};
      for (const k of SETUP_ITEMS) { const v = str(c.done[k]); if (v) done[k] = v; }
      list.done = done;
    }
    if (c.dismissedAt !== undefined) list.dismissedAt = str(c.dismissedAt);
    out.checklist = list;
  }
  if (isObj(raw.sample) && str(raw.sample.projectId)) {
    const s = raw.sample;
    const sample: OnboardingSample = { projectId: s.projectId as string, taskIds: strArr(s.taskIds, 50), createdAt: strOr(s.createdAt, "") };
    if (s.docId !== undefined) sample.docId = str(s.docId);
    out.sample = sample;
  }
  if (isObj(raw.momentum)) {
    const m = raw.momentum;
    const mom: MomentumPrefs = {};
    if (m.streakHidden !== undefined) mom.streakHidden = bool(m.streakHidden);
    if (m.recapHidden !== undefined) mom.recapHidden = bool(m.recapHidden);
    if (Array.isArray(m.daysOff)) mom.daysOff = strArr(m.daysOff, 120).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    out.momentum = mom;
  }
  return out;
}

/* ---------- projects.board_settings ---------- */

/** projects.board_settings → BoardSettings, or undefined when nothing is set. */
export function parseBoardSettings(raw: unknown): BoardSettings | undefined {
  if (!isObj(raw)) return undefined;
  const out: BoardSettings = {};
  if (isObj(raw.wip)) {
    const wip: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.wip)) {
      const n = num(v);
      if (k && n !== null && n >= 1) wip[k] = Math.min(Math.round(n), WIP_LIMIT_MAX);
    }
    if (Object.keys(wip).length) out.wip = wip;
  }
  if (raw.covers !== undefined) out.covers = bool(raw.covers);
  return Object.keys(out).length ? out : undefined;
}

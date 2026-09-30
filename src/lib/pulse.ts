/* ============================================================
   KANBO — Pulse: the standup that writes itself. What each person
   finished since the last workday, what's on today, what's blocked.
   W0 stub: buildPulse returns an empty picture; P08 fills it in.
   ============================================================ */
import type { Task, WorkspaceEvent } from "../data/types";
import { todayISO } from "../data/data";

export interface PulsePerson {
  id: string;
  name: string;
  role?: string;
  done: Task[];
  onToday: Task[];
  blocked: Task[];
  loadHours: number;
  capacity: number;
}

export interface PulseFacts {
  /** YYYY-MM-DD: the start of the period the facts cover */
  since: string;
  people: PulsePerson[];
  totals: { done: number; inFlight: number; blocked: number; overCapacity: string[] };
}

export function buildPulse(input: {
  tasks: Task[];
  members: { id: string; name: string; role?: string }[];
  events?: WorkspaceEvent[];
  today?: string;
  capacities?: Record<string, number>;
}): PulseFacts {
  return { since: input.today ?? todayISO(), people: [], totals: { done: 0, inFlight: 0, blocked: 0, overCapacity: [] } };
}

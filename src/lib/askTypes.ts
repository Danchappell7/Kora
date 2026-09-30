/* ============================================================
   KANBO — Ask Kanbo: the shapes shared by the command bar, the
   on-device fallback, the store's AI calls and App's apply step
   ============================================================ */
import type { Task, Priority } from "../data/types";
import type { Route } from "../app-types";

/** The task fields an Ask action may change. */
export type AskField = "status" | "priority" | "dueDate" | "dueTime" | "assigneeId" | "planToday" | "projectId" | "title";
export type AskPatch = Partial<Pick<Task, AskField>>;

/** One change Ask proposes. Nothing is applied until the person presses Apply. */
export type AskAction =
  | { op: "update"; id: string; patch: AskPatch }
  | { op: "create"; task: { title: string } & AskPatch }
  | { op: "open"; taskId?: string; route?: Route };

export interface AskResult {
  /** the one-paragraph answer shown above the proposed changes */
  answer: string;
  actions: AskAction[];
  /** ids of the tasks the answer is based on ("How I got here") */
  cites?: string[];
  source: "ai" | "local";
  usage?: { used: number; limit: number };
}

/** What Ask needs to resolve names and dates, sent with every question. */
export interface AskContext {
  /** YYYY-MM-DD, local */
  today: string;
  /** the signed-in user's id */
  me: string;
  members: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}

/** A task read out of pasted notes, before the person reviews it. */
export interface ExtractedTask {
  title: string;
  assigneeId?: string;
  assigneeName?: string;
  dueDate?: string;
  dueTime?: string;
  priority?: Priority;
  projectId?: string;
  note?: string;
  /** 0..1 */
  confidence?: number;
}

/** An AI call's outcome. `data` is null when the model wasn't used:
 *  "unavailable" (no backend, or it failed), "limit" (the daily cap) or "off"
 *  (the person turned AI off). Callers fall back to on-device rules. */
export type AiOutcome<T> =
  | { data: T; source: "ai"; usage?: { used: number; limit: number } }
  | { data: null; source: "unavailable" | "limit" | "off"; detail?: string };

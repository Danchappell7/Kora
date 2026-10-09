/* ============================================================
   KANBO — the approval chips' data, for every row and card at once.
   App keeps one map (task id → its latest request's summary, from
   lib/approvals listApprovalSummaries, refreshed on realtime) and
   provides it here; rows and cards render <TaskApprovalBadge> beside
   their other chips without the map being threaded through every
   view. Outside a provider (tests, Search) there are no chips.
   ============================================================ */
import { createContext, useContext, type ReactNode } from "react";
import type { ApprovalSummary } from "../../data/types";
import { ApprovalBadge } from "./ApprovalBadge";

const NONE: Readonly<Record<string, ApprovalSummary>> = Object.freeze({});
const ApprovalSummariesContext = createContext<Readonly<Record<string, ApprovalSummary>>>(NONE);

export function ApprovalSummariesProvider({ summaries, children }: { summaries: Readonly<Record<string, ApprovalSummary>>; children: ReactNode }) {
  return <ApprovalSummariesContext.Provider value={summaries}>{children}</ApprovalSummariesContext.Provider>;
}

/** The task's approval chip ("Pending 1/2", "Approved", "Changes requested"); nothing without a request. */
export function TaskApprovalBadge({ taskId, size = "sm" }: { taskId: string; size?: "sm" | "md" }) {
  const summary = useContext(ApprovalSummariesContext)[taskId];
  return summary ? <ApprovalBadge summary={summary} size={size} /> : null;
}

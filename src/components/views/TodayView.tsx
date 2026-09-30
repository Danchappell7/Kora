/* ============================================================
   KANBO — Today › Day: the brief, the Daybeam, the suggested plan
   and the day canvas.
   W0 stub: renders today's Plan my day (PlanView) from these props;
   P04 builds the rest around it.
   ============================================================ */
import { PlanView } from "./PlanView";
import type { Task, ExternalEvent } from "../../data/types";
import type { CaptureOptions } from "../../data/data";

export interface TodayViewProps {
  tasks: Task[];
  allTasks: Task[];
  events: ExternalEvent[];
  calendarConnected: boolean;
  currentUserId: string;
  userName?: string;
  captureDefaults: CaptureOptions;
  /** App applies the plan-state guard inside */
  onUpdate: (id: string, patch: Partial<Task>) => void;
  onCreate: (t: Task) => void;
  onOpen: (id: string) => void;
  onRank: () => Promise<"ai" | "heuristic" | "none">;
  ranking: boolean;
  onStartFocus: (taskId?: string) => void;
  onShutdown: () => void;
  onExtractFromMeeting?: (meetingTitle: string) => void;
  onConnectCalendar?: () => void;
  setup: { label: string; done: boolean; action: () => void }[];
  showSuggestions: boolean;
  riskCount?: number;
  onOpenRisks?: () => void;
  readOnly?: boolean;
}

export function TodayView({ tasks, events, calendarConnected, currentUserId, captureDefaults, onUpdate, onCreate, onOpen }: TodayViewProps) {
  return <PlanView tasks={tasks} onUpdate={onUpdate} onCreate={onCreate} onOpen={onOpen} externalEvents={events}
    calendarConnected={calendarConnected} currentUserId={currentUserId} captureDefaults={captureDefaults} />;
}

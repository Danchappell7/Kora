/* ============================================================
   KANBO — shared domain types
   Mirrors the real Supabase schema + a few forward-looking
   fields: tags, aiScore, aiReason, focusMin, and the
   "Plan my day" scheduling fields (energy, dur, scheduled).
   ============================================================ */

export type MemberType = "self" | "team" | "external";
export type Status = "todo" | "progress" | "review" | "blocked" | "done";
export type Priority = "low" | "medium" | "high" | "urgent";
export type EnergyKind = "deep" | "create" | "collab" | "admin";

export interface Member {
  id: string;
  name: string;
  email: string;
  type: MemberType;
  color: string;
  pronouns?: string;
  avatarUrl?: string | null;
}

export interface Profile {
  id: string;
  firstName: string;
  lastName: string;
  pronouns: string;
  email: string;
  avatarUrl: string | null;
}

export interface Workspace {
  id: string | null;
  name: string;
  kind: "personal" | "team";
  ownerId?: string;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string | null;
  email: string;
  name: string;
  role: "owner" | "member";
  status: "invited" | "active";
}

export type Recurrence = "none" | "daily" | "weekly" | "monthly";

export type Plan = "personal" | "team";
export type SubStatus = "trialing" | "active" | "past_due" | "canceled";

export interface Subscription {
  plan: Plan | null;
  status: SubStatus;
  trialEndsAt: string;          // ISO
  currentPeriodEnd?: string | null;
  seats: number;
}

export interface Project {
  id: string;
  name: string;
  emoji: string;
  color: string;
  workspaceId: string | null;
}

export interface TagDef {
  label: string;
  color: string;
}

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  projectId: string;
  assigneeId: string;
  tags: string[];
  dependencies: string[];
  subtasks: Subtask[];
  focusMin: number;
  comments: number;
  aiScore: number;
  aiReason?: string;
  dueDate?: string;
  originalDueDate?: string;
  completedAt?: string;
  /* "Plan my day" fields */
  energy?: EnergyKind;
  dur?: number;
  scheduled?: number | null;
  planToday?: boolean;
  /* collaboration + recurrence */
  workspaceId?: string | null;
  recurrence?: Recurrence;
  /* manual board ordering — fractional index; lower sorts first within a column */
  position?: number;
}

export interface Comment {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  mentions?: string[];
}

export interface Attachment {
  id: string;
  taskId: string;
  name: string;
  size: number;
  mime: string;
  path: string;
  url?: string;
  createdAt: string;
}

export type ActivityKind = "created" | "status" | "completed" | "reopened" | "comment" | "deleted" | "assigned" | "mention";

export interface Activity {
  id: string;
  taskId: string | null;
  taskTitle: string;
  kind: ActivityKind;
  detail: string;
  createdAt: string;
}

export interface CalEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  kind: "meeting" | "break";
  with?: string[];
}

/* external calendar integration (Google / Microsoft) */
export type CalProvider = "google" | "microsoft";

export interface CalendarConnection {
  provider: CalProvider;
  accountEmail: string;
  createdAt?: string;
}

export interface ExternalEvent {
  id: string;
  title: string;
  start: string;   // ISO datetime (or date for all-day)
  end: string;
  allDay: boolean;
  provider: string;
}

export interface StatusMeta {
  label: string;
  color: string;
}

export interface PriorityMeta {
  label: string;
  color: string;
  rank: number;
}

export interface EnergyMeta {
  label: string;
  color: string;
  icon: IconName;
}

/* Forward declaration — concrete union lives in primitives/Icon.tsx */
export type IconName =
  | "home" | "inbox" | "tasks" | "calendar" | "users" | "chart" | "plus"
  | "search" | "bell" | "logout" | "chevronDown" | "chevronRight" | "chevronLeft"
  | "list" | "board" | "timeline" | "flag" | "lock" | "clock" | "sparkles"
  | "play" | "pause" | "x" | "more" | "arrowUpRight" | "target" | "briefcase"
  | "user" | "sun" | "moon" | "command" | "filter" | "sort" | "link" | "zap"
  | "trendingUp" | "check" | "message" | "folder" | "dot" | "settings" | "circle"
  | "grid" | "arrowRight" | "arrowLeft" | "refresh" | "calendarPlus" | "layers" | "trash" | "menu" | "archive";

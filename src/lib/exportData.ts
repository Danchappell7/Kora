/* ============================================================
   KANBO — Settings › Your data › Export my data: what goes in the
   file. Everything you can see, except in a workspace where you're a
   guest. There it's only your own work: the tasks you created or are
   assigned to, the projects they sit in and your own membership.
   The team's people, goals, portfolios, updates, rules and requests
   stay with the team.
   Pure: no React, no I/O.
   ============================================================ */
import type {
  Activity, AutomationRule, CustomFieldDef, FormDef, Goal, Portfolio, Project, SavedSearch, Section, StatusUpdate, Task,
  TagDef, Workspace, WorkspaceMember,
} from "../data/types";

export interface ExportInput {
  /** the person exporting */
  me: string;
  profile: unknown;
  workspaces: Workspace[];
  members: WorkspaceMember[];
  projects: Project[];
  sections: Section[];
  customFields: CustomFieldDef[];
  tags: Record<string, TagDef>;
  tasks: Task[];
  goals: Goal[];
  portfolios: Portfolio[];
  statusUpdates: StatusUpdate[];
  automationRules: AutomationRule[];
  forms: FormDef[];
  savedSearches: SavedSearch[];
  activity: Activity[];
  /** a member's display name (their profile's, when there is one) */
  nameOf?: (userId: string) => string | undefined;
  now?: Date;
}

/** The workspaces where `me` is an active guest. */
export function guestWorkspaces(members: WorkspaceMember[], me: string): Set<string> {
  return new Set(members.filter((m) => m.userId === me && m.status === "active" && m.role === "guest").map((m) => m.workspaceId));
}

/** The export file's contents, and whether anything was left out because you're a guest somewhere. */
export function buildExport(input: ExportInput): { payload: Record<string, unknown>; limited: boolean } {
  const { me } = input;
  const guestIn = guestWorkspaces(input.members, me);
  const guestHere = (ws: string | null | undefined) => !!ws && guestIn.has(ws);
  const team = <T extends { workspaceId?: string | null }>(rows: T[]) => rows.filter((r) => !guestHere(r.workspaceId));

  const tasks = input.tasks.filter((t) => !guestHere(t.workspaceId) || t.assigneeId === me || t.createdBy === me);
  const kept = new Set(tasks.map((t) => t.id));
  const dropped = new Set(input.tasks.filter((t) => !kept.has(t.id)).map((t) => t.id));
  const ownProjects = new Set(tasks.map((t) => t.projectId));
  const projects = input.projects.filter((p) => !guestHere(p.workspaceId) || ownProjects.has(p.id));
  const members = input.members.filter((m) => !guestHere(m.workspaceId) || m.userId === me);

  const payload: Record<string, unknown> = {
    app: "Kanbo",
    exportedAt: (input.now ?? new Date()).toISOString(),
    profile: input.profile,
    workspaces: input.workspaces,
    members: members.map((m) => ({ workspaceId: m.workspaceId, userId: m.userId, name: (m.userId ? input.nameOf?.(m.userId) : undefined) || m.name, email: m.email, role: m.role, status: m.status })),
    projects,
    sections: team(input.sections),
    customFields: team(input.customFields),
    tags: input.tags,
    tasks,
    goals: team(input.goals),
    portfolios: team(input.portfolios),
    statusUpdates: team(input.statusUpdates),
    automationRules: team(input.automationRules),
    forms: team(input.forms),
    savedSearches: input.savedSearches,
    // your notifications, less those about someone else's task in a workspace where you're a guest
    activity: input.activity.filter((a) => !a.taskId || !dropped.has(a.taskId)),
  };
  if (guestIn.size) payload.note = "In workspaces where you're a guest, this file has only your own tasks and the projects they're in.";
  return { payload, limited: guestIn.size > 0 };
}

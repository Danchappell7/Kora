/* ============================================================
   KANBO — the moves behind a drop on a project or a person (0048).
   moveTasksToProject / reassignTasks: the checks (a team task stays in
   its workspace, a person must be an active member of it, tasks already
   there are skipped), the words ("Moved 3 tasks to Launch") and the
   Undo. The drop targets themselves are lib/dropActions (the Sidebar's
   first download); this loads with the first drop, or when idle.
   ============================================================ */
import type { Member, Project, Section, Task, WorkspaceMember } from "../data/types";

export interface MoveDeps {
  /** the tasks as they are now (to know what Undo puts back) */
  tasks: readonly Task[];
  /** App's bulk update path (optimistic + saved); one patch per task */
  updateTasks: (patches: { id: string; patch: Partial<Task> }[]) => void | Promise<void>;
  /** the app's toast with an Undo action */
  toast: (message: string, undo?: () => void) => void;
  /** the project's sections: a moved task lands in the first one (none given: no section) */
  sections?: readonly Pick<Section, "id" | "projectId" | "position">[];
  /** workspace memberships: reassigning checks the person is an active member of each task's workspace
   *  (none given: the server decides) */
  members?: readonly Pick<WorkspaceMember, "userId" | "workspaceId" | "status">[];
  /** 0058: can this person see the task's project (as it'd be: project access on)? None given: everyone can */
  canSee?: (userId: string, task: Pick<Task, "workspaceId" | "projectId">) => boolean;
  /** 0058: can you change this task (edit rights on its project)? None given: you can */
  canEdit?: (task: Pick<Task, "workspaceId" | "projectId">) => boolean;
  /** a project's name, for what's said about it */
  projectName?: (projectId: string) => string | undefined;
}

export interface MoveOutcome { moved: string[]; skipped: string[]; message: string }

const quote = (s: string) => `“${s.length > 60 ? s.slice(0, 59) + "…" : s}”`;
const tasksWord = (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`;

/** Look the ids up (in order, once each); unknown ids are left out. */
function pick(ids: readonly string[], tasks: readonly Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const out: Task[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (t && !seen.has(id)) { seen.add(id); out.push(t); }
  }
  return out;
}

/** The project's first section (by position, then as listed), if it has any. */
function firstSection(projectId: string, sections: MoveDeps["sections"]): string | undefined {
  const own = (sections ?? []).filter((s) => s.projectId === projectId);
  if (!own.length) return undefined;
  return [...own].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))[0].id;
}

/** Move tasks to a project (its first section; sub-tasks follow their parent). */
export function moveTasksToProject(taskIds: string[], project: Pick<Project, "id" | "name" | "workspaceId">, deps: MoveDeps): MoveOutcome {
  const picked = pick(taskIds, deps.tasks);
  const ids = new Set(picked.map((t) => t.id));
  const pws = project.workspaceId ?? null;
  const moved: Task[] = [];
  const already: Task[] = [];
  const elsewhere: Task[] = [];
  for (const t of picked) {
    // a sub-task whose parent is moving too goes with it (App cascades to descendants)
    if (t.parentId && ids.has(t.parentId)) continue;
    if (t.projectId === project.id) { already.push(t); continue; }
    if ((t.workspaceId ?? null) !== pws || t.archivedAt) { elsewhere.push(t); continue; }
    moved.push(t);
  }
  const skipped = [...already, ...elsewhere].map((t) => t.id);
  const name = project.name || "the project";
  if (!moved.length) {
    const message = already.length && !elsewhere.length
      ? (already.length === 1 ? `${quote(already[0].title)} is already in ${name}` : `Already in ${name}`)
      : elsewhere.length && !already.length
        ? (elsewhere.length === 1 ? `${quote(elsewhere[0].title)} can't move to ${name}: it's in another workspace` : `These tasks can't move to ${name}: they're in another workspace`)
        : picked.length ? `Nothing to move to ${name}` : "";
    if (message) deps.toast(message);
    return { moved: [], skipped, message };
  }
  const section = firstSection(project.id, deps.sections);
  // (0058: one whose assignee can't see the project there comes to you: App's move says so too)
  const yours = moved.filter((t) => !!t.assigneeId && !!deps.canSee && !deps.canSee(t.assigneeId, { workspaceId: pws, projectId: project.id }));
  const before = moved.map((t) => ({ id: t.id, patch: { projectId: t.projectId, sectionId: t.sectionId, workspaceId: t.workspaceId ?? null,
    ...(yours.includes(t) ? { assigneeId: t.assigneeId } : {}) } as Partial<Task> }));
  void deps.updateTasks(moved.map((t) => ({ id: t.id, patch: { projectId: project.id, sectionId: section, workspaceId: pws } })));
  let message = moved.length === 1 ? `Moved ${quote(moved[0].title)} to ${name}` : `Moved ${tasksWord(moved.length)} to ${name}`;
  if (already.length) message += ` · ${already.length} ${already.length === 1 ? "was" : "were"} already there`;
  if (elsewhere.length) message += ` · ${elsewhere.length} in another workspace stayed put`;
  if (yours.length) message += ` · ${yours.length === 1 ? "1 is" : `${yours.length} are`} now yours: ${yours.length === 1 ? "its assignee can't" : "their assignees can't"} see ${name}`;
  deps.toast(message, () => { void deps.updateTasks(before); });
  return { moved: moved.map((t) => t.id), skipped, message };
}

/** Reassign tasks to a person. */
export function reassignTasks(taskIds: string[], person: Pick<Member, "id" | "name">, deps: MoveDeps): MoveOutcome {
  const picked = pick(taskIds, deps.tasks);
  const first = (person.name || "them").split(/\s+/)[0];
  const isMember = (ws: string | null) => !deps.members
    || (ws !== null && deps.members.some((m) => m.workspaceId === ws && m.userId === person.id && m.status === "active"));
  const moved: Task[] = [];
  const already: Task[] = [];
  const outside: Task[] = [];
  const blind: Task[] = [];
  const viewOnly: Task[] = [];
  for (const t of picked) {
    if (t.assigneeId === person.id) { already.push(t); continue; }
    const ws = t.workspaceId ?? null;
    // a personal task has no team to hand it to
    if (ws === null || t.archivedAt || !isMember(ws)) { outside.push(t); continue; }
    // (0058: nor is it yours to hand on when you can only view its project, nor can it go to someone who can't see it)
    if (deps.canEdit && !deps.canEdit(t)) { viewOnly.push(t); continue; }
    if (deps.canSee && !deps.canSee(person.id, t)) { blind.push(t); continue; }
    moved.push(t);
  }
  const skipped = [...already, ...outside, ...viewOnly, ...blind].map((t) => t.id);
  const blindWhere = blind.length ? deps.projectName?.(blind[0].projectId) ?? "that project" : "";
  if (!moved.length) {
    const message = viewOnly.length && !outside.length && !blind.length
      ? viewOnlyWords(viewOnly, deps)
      : blind.length && !outside.length
      ? `${person.name || "They"} can't see ${[...new Set(blind.map((t) => deps.projectName?.(t.projectId) ?? "that project"))].join(" or ")}, so ${blind.length === 1 ? `${quote(blind[0].title)} stays` : "these tasks stay"} with ${blind.length === 1 ? "its assignee" : "their assignees"}`
      : already.length && !outside.length
      ? (already.length === 1 ? `${quote(already[0].title)} is already with ${first}` : `Already with ${first}`)
      : outside.length ? `${person.name || "They"} can't take ${outside.length === 1 ? quote(outside[0].title) : "these tasks"}: ${outside.some((t) => (t.workspaceId ?? null) === null) ? "personal tasks stay yours" : "they're not in that workspace"}`
        : "";
    if (message) deps.toast(message);
    return { moved: [], skipped, message };
  }
  const before = moved.map((t) => ({ id: t.id, patch: { assigneeId: t.assigneeId } as Partial<Task> }));
  void deps.updateTasks(moved.map((t) => ({ id: t.id, patch: { assigneeId: person.id } })));
  let message = moved.length === 1 ? `Assigned ${quote(moved[0].title)} to ${first}` : `Assigned ${tasksWord(moved.length)} to ${first}`;
  if (already.length) message += ` · ${already.length} ${already.length === 1 ? "was" : "were"} already theirs`;
  if (outside.length) message += ` · ${outside.length} stayed put`;
  if (blind.length) message += ` · ${blind.length} stayed put: ${first} can't see ${blind.length === 1 ? blindWhere : "their projects"}`;
  if (viewOnly.length) message += ` · ${viewOnly.length} you can only view stayed put`;
  deps.toast(message, () => { void deps.updateTasks(before); });
  return { moved: moved.map((t) => t.id), skipped, message };
}

/** What's said when every task picked is one you can only view (0058): "You can view Fee review, but not change it". */
function viewOnlyWords(tasks: readonly Pick<Task, "projectId">[], deps: Pick<MoveDeps, "projectName">): string {
  const names = [...new Set(tasks.map((t) => deps.projectName?.(t.projectId) ?? ""))];
  return names.length === 1 && names[0] ? `You can view ${names[0]}, but not change it` : tasks.length === 1 ? "You can view that task, but not change it" : "You can view these tasks, but not change them";
}

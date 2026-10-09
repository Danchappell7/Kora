/* ============================================================
   KANBO — the "Kanbo tour" sample project (0048, u1).
   Loaded on demand (lib/onboarding createTourSample / removeTourSample
   import it when someone asks), so none of this rides in the first
   download.
   The plan is pure: the same every time for the same day, person and
   workspace, dates in working days from `today`. Six tasks:
     1. Start here — the task panel, with three sub-tasks
     2. Draft the plan ┐ a dependency pair: "Share" waits on "Draft"
     3. Share the plan ┘
     4. Get a sign-off — approvals (a real request only in a team
        workspace, with a reviewer and the host's requestApproval)
     5. Read the project doc — links the doc "How this project works"
        (whose checklist lines are the dependency pair, live)
     6. Capture a task with Q
   Made through the host's create paths (TourSampleDeps, like the
   planner's PlanApplyDeps), recorded in profiles.onboarding.sample,
   removed in one click (the project goes to the bin with its tasks and
   doc).
   ============================================================ */
import type { DocBlock, OnboardingSample, OnboardingState, Project, Task } from "../data/types";

/** How the sample project is made and removed (the integrator wires App's create paths, like PlanApplyDeps).  [final] */
export interface TourSampleDeps {
  createProject(input: { name: string; emoji: string; color: string; workspaceId: string | null; description?: string }): Promise<Project>;
  /** store.createTasksBatch semantics (final ids; parentId for sub-tasks) */
  createTasks(tasks: Task[]): Promise<Task[]>;
  addDependency(taskId: string, dependsOn: string): Promise<void>;
  /** a doc in the project (lib/docs saveProjectDoc); optional: skipped when absent */
  createDoc?(projectId: string, title: string, body: DocBlock[]): Promise<{ id: string }>;
  /** an approval request (team workspaces only; lib/approvals requestApproval); optional */
  requestApproval?(taskId: string, reviewerIds: string[], note: string): Promise<void>;
  /** removal: the project goes (to the bin) with its tasks and doc */
  deleteProject(projectId: string): Promise<void>;
}

export interface TourSampleCtx {
  today: Date;
  currentUserId: string;
  /** null = Personal (the default: the sample lives there) */
  workspaceId: string | null;
  /** a team workspace only: who the "Get a sign-off" task is sent to for approval (the first one) */
  reviewerIds?: string[];
}

/** The sample project's content (pure: the same every time, dates relative to `today`). */
export interface TourSamplePlan { project: { name: string; emoji: string; color: string; description: string }; tasks: Task[]; dependencies: [string, string][]; doc: { title: string; body: DocBlock[] } | null }

export const TOUR_SAMPLE_NAME = "Kanbo tour";
export const TOUR_SAMPLE_DOC_TITLE = "How this project works";

/** The plan's own task keys (the plan's ids; createTourSample swaps them for real ones). */
export const SAMPLE_KEYS = {
  start: "tour-start", sub1: "tour-start-1", sub2: "tour-start-2", sub3: "tour-start-3",
  draft: "tour-draft", share: "tour-share", signoff: "tour-signoff", doc: "tour-doc", capture: "tour-capture",
} as const;

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** `n` working days after `from` (Saturdays and Sundays skipped); 0 = that day itself. */
export function addWorkingDays(from: Date, n: number): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12);
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return iso(d);
}

export function tourSamplePlan(ctx: TourSampleCtx): TourSamplePlan {
  const K = SAMPLE_KEYS;
  const team = !!ctx.workspaceId;
  const asksForReal = team && !!ctx.reviewerIds?.length;
  let pos = 0;
  const task = (key: string, title: string, description: string, extra: Partial<Task> = {}): Task => ({
    id: key, title, description, status: "todo", priority: "medium",
    projectId: "", workspaceId: ctx.workspaceId, assigneeId: ctx.currentUserId,
    tags: [], dependencies: [], subtasks: [], comments: 0, followers: [], collaborators: [],
    focusMin: 15, dur: 15, aiScore: 50, scheduled: null, planToday: false, recurrence: "none",
    position: ++pos, ...extra,
  });
  const today = addWorkingDays(ctx.today, 0);
  const tasks: Task[] = [
    task(K.start, "Start here: open this task",
      "This is the task panel: everything about a task lives here, from its details and sub-tasks to files, comments and history.\n\n"
      + "Try it: tick the first sub-task below, then add one of your own.", { priority: "high", dueDate: today, focusMin: 10, dur: 10 }),
    task(K.sub1, "Tick off this sub-task", "Sub-tasks are tasks in their own right: they can have a date, an owner and comments.", { parentId: K.start, focusMin: 5, dur: 5 }),
    task(K.sub2, "Add a sub-task of your own", "Use “Add sub-task…” at the bottom of the list.", { parentId: K.start, focusMin: 5, dur: 5 }),
    task(K.sub3, team ? "Leave a comment and @mention someone" : "Leave yourself a comment",
      team ? "Type @ in a comment to bring someone in: it lands in their Inbox." : "Comments keep the conversation next to the work. In a team, @mention someone to bring them in.",
      { parentId: K.start, focusMin: 5, dur: 5 }),
    task(K.draft, "Draft the plan",
      "“Share the plan” waits on this one: it's a dependency. Finish this and the next task is free to start.",
      { dueDate: addWorkingDays(ctx.today, 1), focusMin: 45, dur: 45 }),
    task(K.share, "Share the plan",
      "Waiting on “Draft the plan”. Dependencies keep work in the right order, and Kanbo checks with you before you finish something out of turn.",
      { dueDate: addWorkingDays(ctx.today, 2), focusMin: 30, dur: 30 }),
    task(K.signoff, "Get a sign-off",
      "Approvals ask someone to sign a task off before it's finished. Open a team task and choose Request approval: pick who reviews and add a note; their decision comes back to your Inbox.\n\n"
      + (asksForReal ? "This one has been sent for approval as an example: the request shows in its panel." : "This sample lives in Personal, where there's no one to ask, so this one just explains."),
      { dueDate: addWorkingDays(ctx.today, 3), focusMin: 15, dur: 15 }),
    task(K.doc, "Read the project doc",
      `This project has a doc, “${TOUR_SAMPLE_DOC_TITLE}”, under its Docs tab. Docs hold notes, plans and decisions next to the work, and a line can become a task that shows its live status.`,
      { dueDate: addWorkingDays(ctx.today, 1), focusMin: 10, dur: 10 }),
    task(K.capture, "Capture a task with Q",
      "Press Q anywhere and type it the way you'd say it, for example “Call Sam tomorrow 3pm 15m”. Kanbo reads the date, the time and how long it takes.",
      { dueDate: today, focusMin: 5, dur: 5 }),
  ];
  let b = 0;
  const id = () => `btour${++b}`;
  const p = (text: string): DocBlock => ({ id: id(), type: "p", spans: [{ text }] });
  const body: DocBlock[] = [
    p("A doc lives next to its project's tasks. Write notes, plans and decisions here: everyone on the project sees the same page."),
    { id: id(), type: "h2", spans: [{ text: "This week" }] },
    { id: id(), type: "todo", checked: true, spans: [{ text: "Open the sample project" }] },
    { id: id(), type: "todo", checked: false, spans: [{ text: "Draft the plan" }], taskId: K.draft },
    { id: id(), type: "todo", checked: false, spans: [{ text: "Share the plan" }], taskId: K.share },
    { id: id(), type: "callout", icon: "💡", spans: [{ text: "Type / for headings, lists, checklists and callouts. Any line can become a task: choose " }, { text: "Make task", marks: ["b"] }, { text: " from its menu." }] },
    { id: id(), type: "divider" },
    { id: id(), type: "h2", spans: [{ text: "When you're done" }] },
    p("Remove this sample from Help (?) › Remove the sample project. It goes to the bin with its tasks and this doc, so you can bring it back."),
  ];
  return {
    project: {
      name: TOUR_SAMPLE_NAME, emoji: "🧭", color: "oklch(0.74 0.14 230)",
      description: "A sample project to explore: sub-tasks, a dependency, approvals and a doc. Remove it from Help (?) when you're done.",
    },
    tasks,
    dependencies: [[K.share, K.draft]],
    doc: { title: TOUR_SAMPLE_DOC_TITLE, body },
  };
}

/** A sample that couldn't be made (nothing is left behind). */
export class TourSampleError extends Error {
  constructor(message: string) { super(message); this.name = "TourSampleError"; }
}

function newUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes); else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Make the sample through the host's paths; answers what to record in profiles.onboarding.sample.
 *  The project and its tasks must land (else it's rolled back and this rejects with TourSampleError);
 *  the dependency, the doc and the approval request are extras: a failure leaves them out. */
export async function buildTourSample(deps: TourSampleDeps, ctx: TourSampleCtx, now = new Date()): Promise<OnboardingSample> {
  const plan = tourSamplePlan(ctx);
  let project: Project;
  try {
    project = await deps.createProject({ ...plan.project, workspaceId: ctx.workspaceId });
  } catch {
    throw new TourSampleError("Couldn't make the sample project. Check your connection and try again.");
  }
  const ws = project.workspaceId ?? ctx.workspaceId ?? null;
  const fresh = new Map(plan.tasks.map((t) => [t.id, newUuid()]));
  const built = plan.tasks.map((t): Task => ({
    ...t, id: fresh.get(t.id)!, projectId: project.id, workspaceId: ws,
    ...(t.parentId ? { parentId: fresh.get(t.parentId) ?? t.parentId } : {}),
  }));
  let saved: Task[];
  try {
    saved = await deps.createTasks(built);
    if (!Array.isArray(saved) || saved.length < built.length) throw new Error("not every task was saved");
  } catch {
    try { await deps.deleteProject(project.id); } catch { /* it stays: the person can delete it */ }
    throw new TourSampleError("Couldn't add the sample tasks, so the sample project was taken away again. Try again in a moment.");
  }
  // the saved copies, matched by id (or by position, if the host gave them new ids)
  const byId = new Map(saved.map((t) => [t.id, t]));
  const finalOf = new Map<string, string>();
  plan.tasks.forEach((t, i) => {
    const b = built[i];
    const s = byId.get(b.id) ?? saved[i];
    if (s) finalOf.set(t.id, s.id);
  });
  const real = (key: string) => finalOf.get(key) ?? key;

  for (const [a, b] of plan.dependencies) {
    try { await deps.addDependency(real(a), real(b)); } catch { /* the pair still reads as one */ }
  }
  let docId: string | null = null;
  if (plan.doc && deps.createDoc) {
    const body = plan.doc.body.map((blk) => (blk.taskId ? { ...blk, taskId: real(blk.taskId) } : blk));
    try { docId = (await deps.createDoc(project.id, plan.doc.title, body)).id; } catch { docId = null; }
  }
  if (ws && deps.requestApproval && ctx.reviewerIds?.length) {
    try {
      await deps.requestApproval(real(SAMPLE_KEYS.signoff), ctx.reviewerIds.slice(0, 1),
        "An example from the Kanbo tour: approve it or ask for changes to see how a decision comes back.");
    } catch { /* the task still explains approvals */ }
  }
  return { projectId: project.id, taskIds: plan.tasks.map((t) => real(t.id)), docId, createdAt: now.toISOString() };
}

/** Is this a delete of something that's already gone? (store.deleteProject: 0 rows → code "not_deleted") */
const alreadyGone = (e: unknown) => {
  const err = e as { code?: unknown; message?: unknown } | null;
  return err?.code === "not_deleted" || /already gone|not found|does not exist/i.test(String(err?.message ?? ""));
};

/** Remove it: the project goes to the bin with its tasks and doc. Already gone counts as removed. */
export async function deleteTourSample(deps: TourSampleDeps, state: OnboardingState): Promise<void> {
  const id = state.sample?.projectId;
  if (!id) return;
  try { await deps.deleteProject(id); } catch (e) { if (!alreadyGone(e)) throw e; }
}

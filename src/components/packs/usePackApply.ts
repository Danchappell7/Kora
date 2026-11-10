/* ============================================================
   KANBO — business packs, the app's side: set one up (lib/packApply
   through the store's creates, which work in the demo too), show
   what it made at once, take it back, and print a form's QR poster.
   Also says what the preview needs to know for a workspace: your role
   there (goals and the update day are for owners and admins), which
   migrations are in (0052 goals, 0053 update days), and the other
   businesses you run (a holding company's list).
   App hands over its state setters (as for useGoalWrites). The work
   itself (lib/packPlan, lib/packApply, docs, the poster) loads the
   first time a pack is used, so the app's first load carries none of it.
   ============================================================ */
import { useCallback, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type {
  AutomationRule, FormDef, Goal, GoalExtras, Portfolio, Project, Role, Section, Task, UpdateRhythm, Workspace, WorkspaceMember, WorkspaceTemplate,
} from "../../data/types";
import { store } from "../../data/store";
import { KANBO_TODAY } from "../../data/data";
import { reportError } from "../../lib/monitoring";
import { businessesYouRun, roleInWorkspace } from "../../lib/businesses";
import { rhythmOn } from "../../lib/updateRhythm";
import type { PackPick } from "../../lib/packPlan";
import type { PackApplyDeps, PackPoster } from "../../lib/packApply";
import { openPosterWindow } from "../../lib/posterWindow";
import type { PackHost, PackOutcome, PackUiContext, PackUndone } from "./packTypes";

type Pending = { id: string; task: Task; until: number | null };

export interface PackAppHost {
  userIdRef: MutableRefObject<string>;
  workspaces: Workspace[];
  members: WorkspaceMember[];
  /** Goals 2.0 is in (the load found 0052's check-ins and links) */
  goalsV2: boolean;
  workspacesRef: MutableRefObject<Workspace[]>;
  projectsRef: MutableRefObject<Project[]>;
  pendingTasksRef: MutableRefObject<Pending[]>;
  noteCreated(id: string): void;
  applyProjects(next: Project[]): void;
  setSections: Dispatch<SetStateAction<Section[]>>;
  setTasks: Dispatch<SetStateAction<Task[] | null>>;
  setForms: Dispatch<SetStateAction<FormDef[]>>;
  setRules: Dispatch<SetStateAction<AutomationRule[]>>;
  setGoals: Dispatch<SetStateAction<Goal[]>>;
  setGoalExtras: Dispatch<SetStateAction<GoalExtras | null>>;
  setPortfolios: Dispatch<SetStateAction<Portfolio[]>>;
  /** the workspace's update day, on screen only (the pack saves it) */
  showRhythm(workspaceId: string, rhythm: UpdateRhythm | null): void;
  /** ask for a fresh snapshot (signed in) */
  requestReload(): void;
  toastError(message: string): void;
  /** true (and says so) when the person is a guest there: guests never set anything up */
  denyGuest?(wsIds: (string | null | undefined)[]): boolean;
}

const runs = (role: Role | null | undefined) => role === "owner" || role === "admin";

const uuid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `doc-${Date.now()}-${Math.round(Math.random() * 1e9)}`);

/** Goals and the update day: who may, and why not. */
export function packContextFor(input: { workspaceId: string | null; role: Role | null | undefined; mode: "workspace" | "project"; goalsV2: boolean; rhythmOn: boolean; businesses: string[]; today: Date }): PackUiContext {
  const team = input.workspaceId !== null || input.mode === "workspace";
  const lead = input.mode === "workspace" || runs(input.role);
  return {
    mode: input.mode,
    today: input.today,
    goalsV2: input.goalsV2,
    // (a company goal is for owners and admins since 0052; before it, and in Personal, anyone's)
    canSetGoals: !team || !input.goalsV2 || lead,
    canSetUpdateDay: team && lead && input.rhythmOn,
    updateDayNote: !team ? "Personal has no update day." : !input.rhythmOn ? "Update days aren't switched on yet." : !lead ? "Only owners and admins set the workspace's update day." : undefined,
    businesses: input.businesses,
  };
}

export function usePackApply(input: PackAppHost) {
  // (the callbacks read the latest setters and lists through this, so they stay the same functions)
  const hostRef = useRef(input); hostRef.current = input;
  const { userIdRef, workspacesRef, projectsRef, pendingTasksRef } = input;

  /** Set a pack up in a workspace; shows what it made at once. Null when nothing could be made. */
  const apply = useCallback(async (pack: WorkspaceTemplate, pick: PackPick, workspaceId: string | null, context: PackUiContext): Promise<PackOutcome | null> => {
    const host = hostRef.current;
    if (host.denyGuest?.([workspaceId])) return null;
    const me = userIdRef.current;
    const before = workspaceId ? workspacesRef.current.find((w) => w.id === workspaceId)?.updateRhythm ?? null : null;
    let plan: PackOutcome["plan"];
    let applied: PackOutcome["applied"];
    try {
      const [{ buildPackPlan }, { applyPackPlan }, { saveProjectDoc }] = await Promise.all([
        import("../../lib/packPlan"), import("../../lib/packApply"), import("../../lib/docs"),
      ]);
      const deps: PackApplyDeps = {
        ...store.templateDeps(me),
        createGoal: (g) => store.createGoal(g, me),
        addGoalLink: (l) => store.addGoalLink(l),
        createPortfolio: (pf) => store.createPortfolio(pf, me),
        updatePortfolio: (id, patch) => store.updatePortfolio(id, patch),
        createDoc: async ({ projectId, title, icon, body }) => {
          const r = await saveProjectDoc({ id: uuid(), projectId, title, body, baseUpdatedAt: null, icon });
          return { id: r.doc.id, projectId, title: r.doc.title, icon: r.doc.icon };
        },
        setUpdateRhythm: (ws, r) => store.setUpdateRhythm(ws, r),
      };
      plan = buildPackPlan(pack, pick, context);
      applied = await applyPackPlan(plan, { workspaceId, me, rhythmBefore: before }, deps);
    } catch (e) {
      reportError(e, { op: "applyBusinessPack" });
      host.toastError(`Couldn't set up ${pack.name}. Check your connection and try again.`);
      return null;
    }
    // a reload already under way doesn't know about any of this yet: keep the projects, and hold the tasks a while
    applied.projects.forEach((p) => host.noteCreated(p.id));
    const until = Date.now() + 30000;
    const made = new Set(applied.tasks.map((t) => t.id));
    pendingTasksRef.current = [...applied.tasks.map((t) => ({ id: t.id, task: t, until })), ...pendingTasksRef.current.filter((p) => !made.has(p.id))];
    const byId = <T extends { id: string }>(add: T[]) => (cur: T[]) => [...cur.filter((x) => !add.some((y) => y.id === x.id)), ...add];
    host.applyProjects(byId(applied.projects)(projectsRef.current));
    host.setSections(byId(applied.sections));
    host.setTasks((ts) => ts && [...applied.tasks.filter((t) => !ts.some((x) => x.id === t.id)), ...ts]);
    host.setForms(byId(applied.forms));
    host.setRules(byId(applied.rules));
    host.setGoals(byId(applied.goals));
    if (applied.links.length) host.setGoalExtras((x) => (x ? { ...x, links: byId(applied.links)(x.links) } : x));
    host.setPortfolios(byId(applied.portfolios));
    if (applied.rhythm) host.showRhythm(applied.rhythm.workspaceId, applied.rhythm.after);
    host.requestReload();
    if (!applied.projects.length && !applied.goals.length && !applied.portfolios.length && !applied.rhythm) {
      host.toastError(`Couldn't set up ${pack.name}. Check your connection and try again.`);
      return null;
    }
    return { pack, plan, applied, workspaceId };
  }, [userIdRef, workspacesRef, projectsRef, pendingTasksRef]);

  /** Take a pack back: off the screen at once, then from the server. */
  const undo = useCallback(async (o: PackOutcome): Promise<PackUndone> => {
    const host = hostRef.current;
    const a = o.applied;
    const ids = (xs: { id: string }[]) => new Set(xs.map((x) => x.id));
    const projects = ids(a.projects), tasks = ids(a.tasks), sections = ids(a.sections), forms = ids(a.forms), rules = ids(a.rules);
    const goals = ids(a.goals), links = ids(a.links), portfolios = ids(a.portfolios);
    pendingTasksRef.current = pendingTasksRef.current.filter((p) => !tasks.has(p.id));
    host.applyProjects(projectsRef.current.filter((p) => !projects.has(p.id)));
    host.setTasks((ts) => ts && ts.filter((t) => !tasks.has(t.id)));
    host.setSections((cur) => cur.filter((x) => !sections.has(x.id)));
    host.setForms((cur) => cur.filter((x) => !forms.has(x.id)));
    host.setRules((cur) => cur.filter((x) => !rules.has(x.id)));
    host.setGoals((cur) => cur.filter((x) => !goals.has(x.id)));
    if (links.size) host.setGoalExtras((x) => (x ? { ...x, links: x.links.filter((l) => !links.has(l.id)) } : x));
    host.setPortfolios((cur) => cur.filter((x) => !portfolios.has(x.id)));
    if (a.rhythm) host.showRhythm(a.rhythm.workspaceId, a.rhythm.before);
    const r = await Promise.all([import("../../lib/packApply"), import("../../lib/docs")])
      .then(([{ undoAppliedPack }, { deleteProjectDoc }]) => undoAppliedPack(a, {
        deleteGoal: (id) => store.deleteGoal(id),
        deletePortfolio: (id) => store.deletePortfolio(id),
        deleteDoc: (id) => deleteProjectDoc(id),
        deleteRule: (id) => store.deleteRule(id),
        deleteForm: (id) => store.deleteForm(id),
        deleteProject: (id) => store.deleteProject(id),
        setUpdateRhythm: (ws, rhythm) => store.setUpdateRhythm(ws, rhythm),
      }))
      .catch((e) => { reportError(e, { op: "undoBusinessPack" }); return { failed: [o.pack.name] }; });
    host.requestReload();
    // (the demo has no recycle bin)
    return { ...r, binned: store.configured };
  }, [projectsRef, pendingTasksRef]);

  /** Switch the form's public link on and print its poster (the window opens inside the click). A message when it couldn't. */
  const printPoster = useCallback(async (poster: PackPoster, o: PackOutcome): Promise<string | null> => {
    const w = openPosterWindow();
    if (!w) return "Your browser blocked the poster's window. Allow pop-ups for Kanbo, then try again.";
    let PublicLinkError: typeof import("../../lib/publicForms").PublicLinkError | null = null;
    try {
      const [forms, { showPoster }] = await Promise.all([import("../../lib/publicForms"), import("../../lib/packPoster")]);
      PublicLinkError = forms.PublicLinkError;
      const { publicFormUrl, setFormPublic } = forms;
      const r = await setFormPublic(poster.formId, true);
      hostRef.current.setForms((cur) => cur.map((f) => (f.id === poster.formId ? { ...f, publicEnabled: r.publicEnabled, publicToken: r.publicToken } : f)));
      if (!r.publicToken) throw new forms.PublicLinkError("failed", "That didn't save. Try again in a moment.");
      const project = o.applied.projects.find((p) => p.id === poster.projectId);
      const ws = o.workspaceId ? workspacesRef.current.find((x) => x.id === o.workspaceId)?.name : undefined;
      showPoster(w, { headline: poster.headline, line: poster.line, formName: poster.formName, projectName: poster.projectName, workspaceName: ws, url: publicFormUrl(r.publicToken), color: project?.color });
      return null;
    } catch (e) {
      try { w.close(); } catch { /* already closed */ }
      const said = !!PublicLinkError && e instanceof PublicLinkError;
      if (!said) reportError(e, { op: "packPoster" });
      return said ? (e as Error).message : "Couldn't switch on the form's link. Try again in a moment.";
    }
  }, [workspacesRef]);

  /** The host props for a workspace (New project: the one you're in, your role there; New workspace:
   *  null until it exists, and yours to run). */
  const { workspaces, members, goalsV2 } = input;
  const hostFor = useCallback((at: { workspaceId: string | null; mode: "workspace" | "project"; open?: PackHost["open"] }): PackHost => {
    const me = userIdRef.current;
    const role = at.mode === "workspace" ? "owner" : roleInWorkspace(members, me, at.workspaceId);
    const others = businessesYouRun(workspaces, members, me).filter((w) => w.id !== at.workspaceId).map((w) => w.name);
    const context = packContextFor({ workspaceId: at.workspaceId, role, mode: at.mode, goalsV2, rhythmOn: rhythmOn(), businesses: others, today: KANBO_TODAY });
    return {
      context,
      ...(at.mode === "project" ? { apply: (pack: WorkspaceTemplate, pick: PackPick) => apply(pack, pick, at.workspaceId, context) } : {}),
      undo, printPoster,
      ...(at.open ? { open: at.open } : {}),
    };
  }, [workspaces, members, goalsV2, userIdRef, apply, undo, printPoster]);

  return useMemo(() => ({ apply, undo, printPoster, hostFor }), [apply, undo, printPoster, hostFor]);
}

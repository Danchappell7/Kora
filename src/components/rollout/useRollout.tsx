/* ============================================================
   KANBO — rolling Kanbo out (0058), the app's side, in one hook so
   App only hands its state over and places what comes back:
   · the first run's team path (TeamStartHost for OnboardingModal):
     make the workspace, open the packs or the import for it (the
     first-run sheet steps aside while they're up), invite the pilot
     group, and remember what the pack and the import made;
   · "Welcome to <workspace>" on Today, for someone who joined lately;
   · Team › People › Workspace health for owners and admins (activity
     loads only while it's on screen), its fixes, and the rollout plan;
   · Kanbo noticed's one next fix for a rollout's leads, and running it
     from Today (Resend all and Ask for updates happen in place);
   · the "Get set up" facts for a team's owners (packs, import, update
     day, first update).
   ============================================================ */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { Goal, GoalExtras, OnboardingState, Project, Role, RolloutPlan, StatusUpdate, Task, Workspace, WorkspaceMember } from "../../data/types";
import type { Route } from "../../app-types";
import { getMember, setReferenceData } from "../../data/data";
import { store, type InviteEmailResult } from "../../data/store";
import { reportError } from "../../lib/monitoring";
import type { AskForUpdate } from "../../lib/updateAsks";
import type { GoalRead } from "../../lib/goalFlow";
import { quarterOf } from "../../lib/goalPeriods";
import { rolloutOn } from "../../lib/rolloutPlan";
import { healthNudge, shouldWelcome, welcomeContent, welcomedNow, workspaceHealth, type TeamKind, type WorkspaceActivity } from "../../lib/rollout";
import type { SetupFacts } from "../../lib/onboarding";
import type { PackHost } from "../packs/packTypes";
import type { TeamStartHost } from "./TeamStart";
import type { ActivityState } from "./WorkspaceHealth";

// the cards come with their own code, the first time one is shown (the app's first load carries neither)
const WelcomeCard = lazy(() => import("./WelcomeCard").then((m) => ({ default: m.WelcomeCard })));
const WorkspaceHealthCard = lazy(() => import("./WorkspaceHealth").then((m) => ({ default: m.WorkspaceHealthCard })));

export interface RolloutAppHost {
  me: string;
  /** the active workspace (null: Personal) and its view */
  workspace: string | null;
  view: Route["view"];
  role: Role | undefined;
  workspaces: Workspace[];
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
  members: WorkspaceMember[];
  projects: Project[];
  /** the active workspace's tasks */
  tasks: Task[];
  statusUpdates: StatusUpdate[];
  goals: Goal[];
  goalExtras: GoalExtras | null;
  goalReads: Map<string, GoalRead>;
  onboarding: OnboardingState;
  changeOnboarding: (next: OnboardingState) => void;
  accountCreatedAt?: string | null;
  today: Date;
  /** the app's modals the first run opens (it steps aside while they're up) */
  newProjectOpen: boolean;
  importOpen: boolean;
  /** the first-run sheet is open; `freshFirstRun`: treat it as a brand-new account's (the demo's /?first-run) */
  firstRunOpen: boolean;
  freshFirstRun?: boolean;
  setRoute: (r: Route) => void;
  openTask: (id: string) => void;
  openGoal: (id: string) => void;
  patchTask: (id: string, patch: Partial<Task>) => void;
  /** make a team workspace (it becomes the active one): its id */
  makeWorkspace: (name: string) => Promise<string | null>;
  /** take projects made outside the app's own create path (shown at once) */
  adoptProjects: (ps: Project[]) => void;
  openPacks: () => void;
  openImport: () => void;
  inviteMember: (workspaceId: string, email: string, role: Role) => Promise<unknown>;
  resendInvite?: (memberId: string) => Promise<InviteEmailResult>;
  askForUpdate?: AskForUpdate;
  toast: (message: string) => void;
  toastAction: (message: string, label: string, run: () => void) => void;
  toastError: (message: string) => void;
}

const nameOf = (m: WorkspaceMember) => (m.userId ? getMember(m.userId)?.name?.trim() : "") || m.name?.trim() || m.email;
const lead = (r: Role | null | undefined) => r === "owner" || r === "admin";

export function useRollout(h: RolloutAppHost) {
  const ref = useRef(h); ref.current = h;
  const ws = h.workspace;
  const wsRow = h.workspaces.find((w) => w.id === ws);
  const isLead = ws !== null && lead(h.role);

  /* ---------------- the first run's team path ---------------- */
  const [aside, setAside] = useState<"pack" | "import" | null>(null);
  const [progress, setProgress] = useState<{ pack?: string | null; imported?: number; invited?: number }>({});
  const [importInto, setImportInto] = useState<string | null>(null);
  // New project opened on its packs (the first run's "Pick a pack", Get set up's "Start from a business pack")
  const [packMode, setPackMode] = useState(false);
  useEffect(() => { if (!h.newProjectOpen) setPackMode(false); }, [h.newProjectOpen]);
  const openPackGallery = useCallback(() => { setPackMode(true); ref.current.openPacks(); }, []);
  const teamStart = useMemo<TeamStartHost>(() => ({
    create: (name: string, _kind: Exclude<TeamKind, "solo">) => ref.current.makeWorkspace(name),
    pickPack: () => { setAside("pack"); openPackGallery(); },
    importWork: async (workspaceId: string) => {
      // the import needs a home in the new workspace: a first project, when there isn't one yet
      const cur = ref.current;
      let home = cur.projects.find((p) => p.workspaceId === workspaceId && !p.archivedAt)?.id ?? null;
      if (!home) {
        try {
          const p = await store.createProject({ name: "Our work", emoji: "📥", color: "oklch(0.74 0.14 230)", workspaceId }, cur.me);
          cur.adoptProjects([p]);
          home = p.id;
        } catch (e) { reportError(e, { op: "firstRunImportProject" }); cur.toastError("Couldn't get the import ready. Try again in a moment."); return; }
      }
      setImportInto(home);
      setAside("import");
      cur.openImport();
    },
    invite: async (workspaceId: string, emails: string[]) => {
      let invited = 0; const failed: string[] = [];
      for (const e of emails) {
        try { await ref.current.inviteMember(workspaceId, e, "member"); invited++; } catch { failed.push(e); }
      }
      if (invited) setProgress((p) => ({ ...p, invited: (p.invited ?? 0) + invited }));
      return { invited, failed };
    },
    progress,
  }), [progress, openPackGallery]);
  // the fork is for someone starting out: not for someone who's already joined a team (decided as the sheet opens)
  const [forkOk, setForkOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (!h.firstRunOpen || forkOk !== null) return;
    setForkOk(!!h.freshFirstRun || !h.members.some((m) => m.userId === h.me && m.status === "active" && !!m.workspaceId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.firstRunOpen]);
  /** the first-run sheet steps aside while the pack or the import it opened is up */
  const onboardingAside = (aside === "pack" && h.newProjectOpen) || (aside === "import" && h.importOpen);
  // closed: the import goes back to its usual default
  useEffect(() => { if (!h.importOpen && aside === "import") setImportInto(null); }, [h.importOpen, aside]);
  /** New project's packs, noting a pack set up from the first run (the same object back for the same packs) */
  const wrapped = useRef<{ from: PackHost; to: PackHost } | null>(null);
  const wrapPacks = useCallback((packs: PackHost): PackHost => {
    if (!packs.apply) return packs;
    if (wrapped.current?.from === packs) return wrapped.current.to;
    const to: PackHost = {
      ...packs,
      apply: async (pack, pick) => {
        const o = await packs.apply!(pack, pick);
        if (o?.applied.projects.length) setProgress((p) => ({ ...p, pack: pack.name }));
        return o;
      },
    };
    wrapped.current = { from: packs, to };
    return to;
  }, []);
  const noteImport = useCallback((n: number) => { if (n > 0) setProgress((p) => ({ ...p, imported: (p.imported ?? 0) + n })); }, []);

  /* ---------------- Welcome to <workspace> ---------------- */
  const membership = h.members.find((m) => m.workspaceId === ws && m.userId === h.me);
  const welcome = shouldWelcome({ me: h.me, workspace: wsRow, membership, welcomed: h.onboarding.welcomed, accountCreatedAt: h.accountCreatedAt, today: h.today });
  const welcomeSlot: ReactNode = welcome && wsRow?.id ? (() => {
    const content = welcomeContent({
      me: h.me, workspace: wsRow as Workspace & { id: string }, role: membership?.role ?? "member", members: h.members, projects: h.projects,
      tasks: h.tasks, goals: h.goals, nameOf, quarter: quarterOf(h.today),
    });
    const read = content.goal ? h.goalReads.get(content.goal.id) : undefined;
    const id = wsRow.id;
    return (
      <Suspense fallback={null}>
        <WelcomeCard workspaceName={wsRow.name} logoUrl={wsRow.logoUrl} content={content}
          goalRead={read ? { pct: read.pct, line: read.pace?.line } : null}
          onOpenProject={(pid) => h.setRoute({ view: "project", projectId: pid })} onOpenTask={h.openTask}
          onOpenGoal={h.goalReads.size ? h.openGoal : undefined} onOpenPeople={() => h.setRoute({ view: "team" })}
          onDismiss={() => ref.current.changeOnboarding({ ...ref.current.onboarding, welcomed: welcomedNow(ref.current.onboarding.welcomed, id) })} />
      </Suspense>
    );
  })() : null;

  /* ---------------- Workspace health ---------------- */
  const showHealth = isLead && h.view === "team";
  const [activity, setActivity] = useState<{ ws: string; state: ActivityState; data: WorkspaceActivity | null } | null>(null);
  const memberKey = h.members.filter((m) => m.workspaceId === ws).map((m) => `${m.id}:${m.status}`).join(",");
  useEffect(() => {
    if (!showHealth || !ws) return;
    let alive = true;
    setActivity((a) => (a?.ws === ws ? a : { ws, state: "loading", data: null }));
    // (the console's and the card's server calls load with the card)
    import("../../lib/rolloutApi").then((m) => m.loadWorkspaceActivity(ws, ref.current.members)).then((r) => {
      if (!alive) return;
      setActivity(r === "off" || r === "failed" ? { ws, state: r, data: null } : { ws, state: "ok", data: r });
    });
    return () => { alive = false; };
  }, [showHealth, ws, memberKey]);

  const goalsOn = !!h.goalExtras;
  const health = useMemo(() => (!ws || !isLead ? null : workspaceHealth({
    workspaceId: ws, members: h.members, tasks: h.tasks, projects: h.projects, statusUpdates: h.statusUpdates, workspaces: h.workspaces,
    goals: goalsOn ? h.goals : null, checkins: h.goalExtras?.checkins ?? null,
    takesCheckin: (g) => h.goalReads.get(g.id)?.progress.source === "manual",
    activity: activity?.ws === ws ? activity.data : null, today: h.today,
  })), [ws, isLead, h.members, h.tasks, h.projects, h.statusUpdates, h.workspaces, h.goals, h.goalExtras, h.goalReads, goalsOn, activity, h.today]);

  const resendAll = useCallback(async () => {
    const cur = ref.current;
    const invited = cur.members.filter((m) => m.workspaceId === cur.workspace && m.status === "invited");
    let sent = 0, failed = 0;
    for (const m of invited) {
      const r = cur.resendInvite ? await cur.resendInvite(m.id).catch((): InviteEmailResult => ({ sent: false, reason: "not_sent" })) : { sent: false, reason: "email_not_configured" as const };
      // (the demo sends no email; an invite emailed a moment ago still has its link)
      if (r.sent || r.reason === "throttled" || (!store.configured && r.reason === "email_not_configured")) sent++; else failed++;
    }
    return { sent, failed };
  }, []);
  const askUpdates = useCallback(async () => {
    const cur = ref.current;
    const missing = health?.missing ?? [];
    if (!cur.askForUpdate) return { asked: 0, note: "Asking for updates isn't switched on yet." };
    let asked = 0; const yours: string[] = [];
    for (const p of missing) {
      if (p.ownerId === cur.me) { yours.push(p.name); continue; }
      if (!cur.askForUpdate.canAsk(p) || cur.askForUpdate.asked(p)) { if (cur.askForUpdate.asked(p)) asked++; continue; }
      try { await cur.askForUpdate.ask(p); asked++; } catch (e) { reportError(e, { op: "askForUpdate" }); }
    }
    const mine = yours.length ? ` ${yours.join(" and ")} ${yours.length === 1 ? "is" : "are"} yours to post.` : "";
    return { asked, note: asked ? `Asked ${asked} ${asked === 1 ? "owner" : "owners"}. They'll find Kanbo's draft waiting.${mine}` : yours.length ? `${yours.join(" and ")} ${yours.length === 1 ? "is" : "are"} yours to post.` : undefined };
  }, [health]);
  const giveToOwners = useCallback((taskIds: string[]) => {
    const cur = ref.current;
    const moves = taskIds.map((id) => cur.tasks.find((t) => t.id === id)).filter((t): t is Task => !!t && !t.assigneeId)
      .map((t) => ({ t, owner: cur.projects.find((p) => p.id === t.projectId)?.ownerId })).filter((x): x is { t: Task; owner: string } => !!x.owner);
    moves.forEach(({ t, owner }) => cur.patchTask(t.id, { assigneeId: owner }));
    if (moves.length) cur.toastAction(`Gave ${moves.length} ${moves.length === 1 ? "task" : "tasks"} to their project owners`, "Undo",
      () => moves.forEach(({ t }) => ref.current.patchTask(t.id, { assigneeId: "" })));
    return moves.length;
  }, []);
  const saveRollout = useCallback((plan: RolloutPlan | null) => {
    const cur = ref.current;
    const id = cur.workspace;
    if (!id) return;
    const before = cur.workspaces;
    const next = before.map((w) => (w.id === id ? { ...w, rollout: plan } : w));
    cur.setWorkspaces(next); setReferenceData({ workspaces: next });
    store.setWorkspaceRollout(id, plan).catch((e) => {
      reportError(e, { op: "setWorkspaceRollout" });
      ref.current.setWorkspaces(before); setReferenceData({ workspaces: before });
      ref.current.toastError("Couldn't save the rollout plan. Change undone.");
    });
  }, []);

  const [focus, setFocus] = useState<{ fix: string; at: number } | null>(null);
  const healthSlot: ReactNode = showHealth && health && wsRow ? (
    <Suspense fallback={null}>
      <WorkspaceHealthCard workspaceName={wsRow.name} health={health} activity={activity?.ws === ws ? activity.state : "loading"}
        members={h.members.filter((m) => m.workspaceId === ws && m.status === "active")} nameOf={nameOf}
        projects={h.projects.filter((p) => p.workspaceId === ws && !p.archivedAt)}
        rollout={wsRow.rollout ?? null} rolloutOn={rolloutOn()} onSaveRollout={saveRollout}
        onResendAll={resendAll} onAskUpdates={askUpdates} onOpenGoals={() => h.setRoute({ view: "goals" })}
        onPatchTask={h.patchTask} onGiveToOwners={giveToOwners} focus={focus} />
    </Suspense>
  ) : null;

  /* ---------------- Kanbo noticed: the one next fix ---------------- */
  const nudge = useMemo(() => (!health || !wsRow ? null : healthNudge(health, { workspaceId: wsRow.id!, workspaceName: wsRow.name, memberName: nameOf, today: h.today })), [health, wsRow, h.today]);
  const onFix = useCallback((fix: string) => {
    const cur = ref.current;
    if (fix === "resend") {
      void resendAll().then((r) => cur.toast(r.failed ? `Sent ${r.sent} of ${r.sent + r.failed} invites. Try the rest in a minute.` : `Sent ${r.sent} fresh ${r.sent === 1 ? "invite" : "invites"}`));
    } else if (fix === "ask") {
      void askUpdates().then((r) => cur.toast(r.note ?? "Nobody else to ask."));
    } else if (fix === "goals") {
      cur.setRoute({ view: "goals" });
    } else {
      // "assign" opens its sheet on the card; "health" just shows the card
      cur.setRoute({ view: "team" });
      setFocus({ fix, at: Date.now() });
    }
  }, [resendAll, askUpdates]);

  /* ---------------- "Get set up" for a team's owners ---------------- */
  const setupFacts: Partial<SetupFacts> = ws === null ? {} : {
    projects: h.projects.filter((p) => p.workspaceId === ws && !p.archivedAt).length,
    tasks: h.tasks.length,
    updateDaySet: !!wsRow?.updateRhythm,
    postedUpdate: h.statusUpdates.some((u) => (u.workspaceId ?? null) === ws && (u.authorId === undefined || u.authorId === h.me)),
  };
  /** the project "Post your first update" opens: one you own here, else the first */
  const updateProject = h.projects.find((p) => p.workspaceId === ws && !p.archivedAt && p.ownerId === h.me)
    ?? h.projects.find((p) => p.workspaceId === ws && !p.archivedAt);

  return {
    teamStart: forkOk ? teamStart : undefined, onboardingAside, wrapPacks, noteImport, importInto, packMode, openPackGallery,
    welcomeSlot, healthSlot,
    today: isLead && nudge ? { noticed: [nudge], onFix } : undefined,
    setupFacts, updateProject,
  };
}

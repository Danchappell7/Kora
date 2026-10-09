/* ============================================================
   KANBO — "Plan a project with Kanbo".
   1 Describe: a goal (+ deadline, people, constraints) with four example
     prompts. 2 Review: the draft grouped by section — rename, delete,
     reassign, change dates, drag to reorder, toggle milestone — a mini
     timeline, and warnings (overloaded people via the Workload model,
     dates past the deadline). 3 Create: the project (emoji + spectrum hue
     suggestion), sections, tasks and dependencies through `deps`, with
     progress and rollback messaging on failure. "append" mode adds tasks
     to an existing project ("Add tasks with Kanbo").
   Kanbo AI drafts the plan when it's on (ai-assist mode "plan"); with it
   off, in demo mode, offline or unavailable, the same plan shape comes
   from lib/projectPlanner fallbackPlan() on the device, and the review
   says so. Nothing is created until Create; closing a drafted plan asks
   first. Guests (read-only) get an explanation instead of the form.
   ============================================================ */
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AiMark, Button, DateChip, Icon, Meter, ProjectChip, ProjectTile, Sheet, Vellum, projectIdentity, projectSpectrum, spectrumColor,
} from "../primitives";
import { IdentityFields } from "../project/IdentityPicker";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { isSupabaseConfigured } from "../../lib/supabase";
import {
  addPlanSection, applyProjectPlan, fallbackPlan, isPlanDay, londonToday, PLAN_LIMITS, PLAN_PROJECT_NAME_MAX, planCategory,
  planCategoryLabel, planDayLabel, planEdgeCount, PLANNER_COPY, PLANNER_EXAMPLES, plannerFailure, plannerResultMessage, plannerRoster,
  planTotals, planWarnings, planWithAi, shiftPlanStart, tasksBySection,
} from "../../lib/projectPlanner";
import { PlanReview } from "./PlanReview";
import { PlanTimeline } from "./PlanTimeline";
import type {
  AppliedProjectPlan, Member, PlanApplyDeps, PlanApplyProgress, PlanDraft, PlannerContext, PlannerFailure, PlannerInput, PlanWarning, Project, Section, Task,
} from "../../data/types";
import "../project/projects.css";
import "./planner.css";

export interface ProjectPlannerProps {
  open: boolean;
  /** new: plan a new project · append: add tasks to `project` */
  mode: "new" | "append";
  workspaceId: string | null;
  workspaceName: string;
  /** append mode: the project to add to */
  project?: Project | null;
  /** append mode: that project's sections */
  sections?: Section[];
  /** the workspace's people: who the plan may assign */
  members: Member[];
  /** which of `members` are guests (assignable; no team capacity) */
  guestIds?: string[];
  /** the workspace's tasks (Workload warnings) */
  tasks: Task[];
  currentUserId: string;
  /** Settings › "Use Kanbo AI" is on and this isn't demo mode; off → the on-device planner */
  aiEnabled: boolean;
  /** prefilled goal (⌘K "Plan a project…" passes what was typed) */
  initialGoal?: string;
  /** the host's create paths (so its state updates as things are made) */
  deps: PlanApplyDeps;
  onClose: () => void;
  /** everything made: the host opens the project and toasts */
  onCreated: (result: AppliedProjectPlan) => void;
}

type Step = "describe" | "drafting" | "review" | "creating" | "failed";
/** "nobody picked" (an empty memberIds would mean everyone): matches no one */
const NOBODY = "\u0000nobody";
/** why the plan came from the device */
type DeviceWhy = "off" | "demo" | "unavailable" | "offline" | "chosen" | "limit";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtH = (h: number) => `${Math.round(h * 10) / 10}h`;
const STEPS: { id: "describe" | "review" | "create"; label: string }[] = [
  { id: "describe", label: "Describe" }, { id: "review", label: "Review" }, { id: "create", label: "Create" },
];
const WARN_ICON: Record<PlanWarning["kind"], "users" | "clock" | "link" | "user" | "alert"> = {
  overloaded: "users", past_deadline: "clock", dependency_order: "link", unassigned: "user", trimmed: "alert",
};
const WARN_TONE: Record<PlanWarning["kind"], "warn" | "neutral"> = {
  overloaded: "warn", past_deadline: "warn", dependency_order: "warn", unassigned: "neutral", trimmed: "neutral",
};

export function ProjectPlanner({
  open, mode, workspaceId, workspaceName, project, sections, members, guestIds, tasks, currentUserId, aiEnabled, initialGoal, deps, onClose, onCreated,
}: ProjectPlannerProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const isPhone = useMediaQuery("(max-width: 859px)");
  const appending = mode === "append" && !!project;
  const readOnly = !!guestIds?.includes(currentUserId);
  const roster = useMemo(() => plannerRoster(members, { guestIds, currentUserId }), [members, guestIds, currentUserId]);
  const team = useMemo(() => roster.filter((r) => !r.guest), [roster]);

  const [step, setStep] = useState<Step>("describe");
  const [goal, setGoal] = useState("");
  const [deadline, setDeadline] = useState<string | undefined>(undefined);
  const [deadlineNote, setDeadlineNote] = useState<string | null>(null);
  const [constraints, setConstraints] = useState("");
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [drafted, setDrafted] = useState<{ goal: string; why: DeviceWhy | null; category: string } | null>(null);
  const [aiProblem, setAiProblem] = useState<{ reason: PlannerFailure; message: string } | null>(null);
  const [progress, setProgress] = useState<PlanApplyProgress | null>(null);
  const [failure, setFailure] = useState<{ message: string; failed: string[] } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [undo, setUndo] = useState<{ before: PlanDraft; label: string } | null>(null);
  const [said, setSaid] = useState("");
  const [flash, setFlash] = useState<{ keys: Set<string>; focus: string | null; seq: number }>({ keys: new Set(), focus: null, seq: 0 });
  const [elapsed, setElapsed] = useState(0);
  const run = useRef(0);
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const reviewHeadRef = useRef<HTMLHeadingElement>(null);
  const failRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  // a fresh start each time it opens (decided while rendering, so the first frame is already right)
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStep("describe"); setGoal((initialGoal ?? "").slice(0, PLAN_LIMITS.goal)); setDeadline(undefined); setDeadlineNote(null); setConstraints("");
      setName(""); setPicked((team.length ? team : roster).map((r) => r.id)); setDraft(null); setDrafted(null); setAiProblem(null);
      setProgress(null); setFailure(null); setConfirmDiscard(false); setIdentityOpen(false); setUndo(null); setSaid("");
      setFlash({ keys: new Set(), focus: null, seq: 0 });
    }
  }
  // a draft still on its way when the sheet closes is dropped
  useEffect(() => { if (!open) run.current++; }, [open]);
  // drafting: count the seconds (shown, not announced)
  useEffect(() => {
    if (step !== "drafting") return;
    setElapsed(0);
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [step]);
  // an Undo offer lasts ten seconds
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 10_000);
    return () => window.clearTimeout(t);
  }, [undo]);

  const today = londonToday();
  const ctx: PlannerContext = useMemo(() => ({
    today, workspaceId, roster, mode: appending ? "append" : "new",
    ...(appending ? {
      existingSections: (sections ?? []).filter((s) => s.projectId === project!.id).map((s) => s.name),
      existingTitles: tasks.filter((t) => t.projectId === project!.id && !t.archivedAt).map((t) => t.title),
    } : {}),
  }), [today, workspaceId, roster, appending, sections, tasks, project]);

  const warnings = useMemo(() => (draft ? planWarnings(draft, { tasks, members, deadline: draft.deadline, guestIds }) : []), [draft, tasks, members, guestIds]);
  const lateKeys = useMemo(() => new Set(warnings.find((w) => w.kind === "past_deadline")?.taskKeys ?? []), [warnings]);
  const totals = draft ? planTotals(draft) : null;
  const identityProject = draft ? { id: "plan-preview", name: draft.name || "New project", emoji: draft.emoji, color: spectrumColor(draft.hue) } : null;

  const focusSoon = (el: () => HTMLElement | null | undefined) => window.setTimeout(() => el()?.focus({ preventScroll: true }), 30);

  /* ---------- 1 → 2: draft the plan ---------- */
  const input = (): PlannerInput => ({
    goal: goal.trim(),
    deadline: deadline ?? null,
    memberIds: picked.length ? picked : [NOBODY],
    constraints: constraints.trim() || null,
    projectName: appending ? project!.name : (name.trim() || null),
  });
  const showDraft = (d: PlanDraft, why: DeviceWhy | null) => {
    setDraft(d);
    setDrafted({ goal: goal.trim(), why, category: planCategoryLabel(planCategory(goal)) });
    setAiProblem(null);
    setUndo(null);
    setStep("review");
    setSaid(`${d.source === "ai" ? "Kanbo drafted" : "Drafted"} ${plural(d.tasks.length, "task")} in ${plural(d.sections.length, "section")}. Check them, then create.`);
    focusSoon(() => reviewHeadRef.current);
  };
  const onDevice = (why: DeviceWhy) => {
    run.current++;
    showDraft(fallbackPlan(input(), ctx), why);
  };
  const draftPlan = async () => {
    if (!goal.trim() || readOnly || step === "drafting") return;
    if (!aiEnabled) { onDevice(isSupabaseConfigured ? "off" : "demo"); return; }
    const id = ++run.current;
    setAiProblem(null);
    setStep("drafting");
    setSaid("Kanbo is drafting your plan.");
    try {
      const d = await planWithAi(input(), ctx);
      if (id !== run.current) return;
      showDraft(d, null);
    } catch (e) {
      if (id !== run.current) return;
      const reason = plannerFailure(e);
      if (reason === "ai_unavailable" || reason === "network") {
        showDraft(fallbackPlan(input(), ctx), typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "unavailable");
        return;
      }
      const message = (e as Error)?.message || PLANNER_COPY.error;
      setAiProblem({ reason, message });
      setStep("describe");
      setSaid(message);
    }
  };
  const cancelDrafting = () => { run.current++; setStep("describe"); setSaid("Stopped."); focusSoon(() => goalRef.current); };

  /* ---------- 2: edits ---------- */
  // Undo puts back a snapshot, so any later change retires the offer (it would undo that change too)
  const edit = (next: PlanDraft, say?: string) => { setDraft(next); setUndo(null); if (say) setSaid(say); };
  const removed = (next: PlanDraft, before: PlanDraft, label: string) => {
    setDraft(next);
    setUndo({ before, label });
    setSaid(`Removed ${label}. Undo is available for ten seconds.`);
  };
  const showWarning = (w: PlanWarning) => {
    const keys = w.taskKeys ?? [];
    setFlash((f) => ({ keys: new Set(keys), focus: keys[0] ?? null, seq: f.seq + 1 }));
    window.setTimeout(() => setFlash((f) => ({ ...f, keys: new Set() })), 2400);
  };

  /* ---------- 3: create ---------- */
  const create = async (retry = false) => {
    if (!draft || readOnly || (step !== "review" && !retry)) return;
    if (!draft.tasks.some((t) => t.title.trim())) { setSaid("There are no tasks to create yet."); return; }
    setStep("creating");
    setFailure(null);
    setConfirmDiscard(false);
    setProgress({ step: appending ? "sections" : "project", done: 0, total: 1 });
    setSaid(appending ? `Adding the tasks to ${project!.name}.` : `Creating ${draft.name || "the project"}.`);
    try {
      const r = await applyProjectPlan(draft, {
        workspaceId: appending ? project!.workspaceId ?? workspaceId : workspaceId, currentUserId,
        project: appending ? project : null, sections: appending ? sections : undefined, goal: appending ? undefined : goal.trim(),
      }, deps, setProgress);
      if (r.rolledBack || !r.tasks.length) {
        const message = plannerResultMessage(r, appending ? "append" : "new").text;
        setFailure({ message, failed: r.failed });
        setStep("failed");
        setSaid(message);
        focusSoon(() => failRef.current);
        return;
      }
      onCreated(r);
      onClose();
    } catch (e) {
      const message = (e as Error)?.message || "Couldn't create the project, so nothing was made.";
      setFailure({ message, failed: [] });
      setStep("failed");
      setSaid(message);
      focusSoon(() => failRef.current);
    }
  };

  /* ---------- closing ---------- */
  const requestClose = () => {
    if (step === "creating") return; // it's making things: let it finish
    if (draft && !confirmDiscard) {
      setConfirmDiscard(true);
      focusSoon(() => keepRef.current);
      return;
    }
    onClose();
  };
  const back = () => { setConfirmDiscard(false); setStep("describe"); focusSoon(() => goalRef.current); };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (step === "describe") void draftPlan();
    else if (step === "review") void create();
  };

  /* ---------- render ---------- */
  const title = appending ? "Add tasks with Kanbo" : "Plan a project with Kanbo";
  const current = step === "describe" || step === "drafting" ? "describe" : step === "review" ? "review" : "create";
  const size = isPhone ? "lg" : "md";
  const n = draft?.tasks.length ?? 0;
  const createLabel = appending ? (n ? `Add ${plural(n, "task")}` : "Add tasks") : "Create project";

  let footer: JSX.Element | null;
  if (readOnly) {
    footer = <div className="kpl-foot"><Button key="close" variant="secondary" size={size} onClick={onClose}>Close</Button></div>;
  } else if (confirmDiscard) {
    footer = (
      <div className="kpl-foot" role="group" aria-label="Discard this plan?">
        <span className="kpl-foot-q">Discard this plan? Nothing has been created.</span>
        <Button key="keep" ref={keepRef} variant="ghost" size={size} onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
        <Button key="discard" variant="danger" size={size} onClick={onClose}>Discard</Button>
      </div>
    );
  } else if (step === "describe" || step === "drafting") {
    footer = (
      <div className="kpl-foot">
        {draft && step === "describe" && <Button className="kpl-foot-start" variant="ghost" size={size} iconRight="arrowRight" onClick={() => { setStep("review"); focusSoon(() => reviewHeadRef.current); }}>Back to the plan</Button>}
        <Button variant="ghost" size={size} onClick={step === "drafting" ? cancelDrafting : requestClose}>{step === "drafting" ? "Stop" : "Cancel"}</Button>
        <Button key="draft" variant="hero" size={size} icon="kanbo" loading={step === "drafting"} disabled={!goal.trim() || readOnly}
          kbd={isPhone ? undefined : "⌘↵"} onClick={() => void draftPlan()}>
          {step === "drafting" ? "Drafting…" : draft ? "Draft again" : "Draft the plan"}
        </Button>
      </div>
    );
  } else if (step === "review") {
    footer = (
      <div className="kpl-foot">
        <Button className="kpl-foot-start" variant="ghost" size={size} icon="arrowLeft" onClick={back}>Back</Button>
        <span className="kpl-foot-sum" aria-hidden="true">{totals ? `${plural(totals.tasks, "task")} · ${fmtH(totals.hours)}` : ""}</span>
        <Button key="create" variant="primary" size={size} icon={appending ? "plus" : "check"} disabled={!n || readOnly}
          kbd={isPhone ? undefined : "⌘↵"} onClick={() => void create()}>{createLabel}</Button>
      </div>
    );
  } else if (step === "failed") {
    footer = (
      <div className="kpl-foot">
        <Button className="kpl-foot-start" variant="ghost" size={size} icon="arrowLeft" onClick={() => { setStep("review"); setFailure(null); }}>Back to the plan</Button>
        <Button key="retry" variant="primary" size={size} icon="refresh" onClick={() => void create(true)}>Try again</Button>
      </div>
    );
  } else footer = null;

  return (
    <Sheet open={open} onClose={requestClose} label={title} title={title} width={960} footer={footer ?? undefined} initialFocus={goalRef}>
      <div className="kpl" onKeyDown={onKey}>
        {!readOnly && <ol className="kpl-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className="kpl-step" aria-current={s.id === current ? "step" : undefined}
              data-done={STEPS.findIndex((x) => x.id === current) > i || undefined}>
              <span className="kpl-step-n" aria-hidden="true">{STEPS.findIndex((x) => x.id === current) > i ? <Icon name="check" size={12} sw={2.25} /> : i + 1}</span>
              <span>{s.label}</span>
            </li>
          ))}
        </ol>}
        <p className="sr-only" role="status" aria-live="polite">{said}</p>

        {readOnly ? (
          <div className="kpl-note" data-tone="neutral">
            <Icon name="lock" size={16} sw={1.75} />
            <p>{PLANNER_COPY.guest}</p>
          </div>
        ) : (step === "describe" || step === "drafting") ? (
          <Describe
            uid={uid} goal={goal} setGoal={setGoal} goalRef={goalRef} busy={step === "drafting"} elapsed={elapsed}
            appending={appending} project={project ?? null} workspaceName={workspaceName}
            name={name} setName={setName} deadline={deadline} today={today}
            setDeadline={(d) => {
              if (d && d < today) { setDeadlineNote("That date has passed. Pick today or later."); return; }
              setDeadline(d); setDeadlineNote(null);
            }}
            deadlineNote={deadlineNote} constraints={constraints} setConstraints={setConstraints}
            roster={roster} picked={picked} setPicked={setPicked} currentUserId={currentUserId} teamIds={team.map((r) => r.id)}
            aiEnabled={aiEnabled} aiProblem={aiProblem}
            onDevice={() => onDevice(aiProblem?.reason === "daily_limit" ? "limit" : "chosen")} onRetry={() => void draftPlan()}
          />
        ) : step === "review" && draft && totals ? (
          <div className="kpl-review">
            <h3 className="sr-only" ref={reviewHeadRef} tabIndex={-1}>Review the plan</h3>
            {appending ? (
              <div className="kpl-target">
                <span className="kpl-target-label">Adding to</span>
                <ProjectChip project={project} size="md" />
              </div>
            ) : (
              <div className="kpl-identity kp" style={identityProject ? (projectIdentity(identityProject).style as CSSProperties) : undefined}>
                <ProjectTile project={identityProject} size={44} />
                <div className="kpl-identity-main">
                  <input className="kpj-field kpl-name" data-size="lg" value={draft.name} maxLength={PLAN_PROJECT_NAME_MAX}
                    aria-label="Project name" placeholder="Project name"
                    onChange={(e) => edit({ ...draft, name: e.target.value })} />
                  <button type="button" className="kpl-linkbtn" aria-expanded={identityOpen} aria-controls={`${uid}-identity`}
                    onClick={() => setIdentityOpen((o) => !o)}>
                    <Icon name="palette" size={14} sw={1.75} />
                    {identityOpen ? "Done" : "Icon and colour"}
                  </button>
                </div>
              </div>
            )}
            {!appending && (
              <div id={`${uid}-identity`} className="kpl-identity-fields" hidden={!identityOpen}>
                {identityOpen && (
                  <IdentityFields name={draft.name} emoji={draft.emoji} color={spectrumColor(draft.hue)}
                    onEmoji={(emoji) => edit({ ...draft, emoji })}
                    onColor={(color) => edit({ ...draft, hue: projectSpectrum({ id: "plan-preview", color }).key })} />
                )}
              </div>
            )}

            <Source draft={draft} drafted={drafted} people={new Set(draft.tasks.map((t) => t.assigneeId).filter(Boolean)).size} />

            <div className="kpl-facts">
              <span className="kpl-fact"><b>{plural(totals.tasks, "task")}</b> in {plural(totals.sections, "section")}</span>
              {totals.milestones > 0 && <span className="kpl-fact">{plural(totals.milestones, "milestone")}</span>}
              {totals.hours > 0 && <span className="kpl-fact"><span className="kpl-mono">{fmtH(totals.hours)}</span> estimated</span>}
              <span className="kpl-fact-dates">
                <span className="kpl-fact-label">Starts</span>
                <DateChip value={draft.startDate} label="Plan starts" tone="plain" size="sm"
                  onChange={(d) => { if (d) edit(shiftPlanStart(draft, d), `The plan now starts ${planDayLabel(shiftPlanStart(draft, d).startDate)}; every date moved with it.`); }} />
                <span className="kpl-fact-label">Deadline</span>
                <DateChip value={draft.deadline ?? undefined} label="Deadline" tone="plain" size="sm" placeholder="None"
                  onChange={(d) => edit({ ...draft, deadline: d && isPlanDay(d) && d >= draft.startDate ? d : null })} />
              </span>
            </div>

            <PlanTimeline draft={draft} onPick={(key) => setFlash((f) => ({ keys: new Set([key]), focus: key, seq: f.seq + 1 }))} />

            {warnings.length > 0 && (
              <ul className="kpl-warns" aria-label="Things to check">
                {warnings.map((w, i) => (
                  <li key={`${w.kind}-${w.memberId ?? i}`} className="kpl-warn" data-tone={WARN_TONE[w.kind]}>
                    <Icon name={WARN_ICON[w.kind]} size={14} sw={1.75} />
                    <span className="kpl-warn-text">{w.message}</span>
                    {!!w.taskKeys?.length && <button type="button" className="kpl-linkbtn" onClick={() => showWarning(w)}>Show</button>}
                  </li>
                ))}
              </ul>
            )}

            {undo && (
              <div className="kpl-undo" role="group" aria-label="Removed">
                <span>Removed {undo.label}.</span>
                <button type="button" className="kpl-linkbtn" onClick={() => { setDraft(undo.before); setUndo(null); setSaid("Put back."); }}>
                  <Icon name="undo" size={14} sw={1.75} />Undo
                </button>
              </div>
            )}

            {draft.tasks.length === 0 && draft.sections.length === 0 ? (
              <div className="kpl-note" data-tone="neutral">
                <Icon name="tasks" size={16} sw={1.75} />
                <p>Nothing left in the plan. Add a section, or go back and draft it again.</p>
              </div>
            ) : (
              <PlanReview draft={draft} onChange={edit} onRemove={removed} roster={roster} currentUserId={currentUserId}
                lateKeys={lateKeys} flashKeys={flash.keys} focusKey={flash.focus} focusSeq={flash.seq} idPrefix={uid} />
            )}
            <div className="kpl-addsec">
              <Button variant="ghost" size="sm" icon="layers" disabled={draft.sections.length >= PLAN_LIMITS.sections}
                onClick={() => {
                  const r = addPlanSection(draft);
                  if (!r) return;
                  edit(r.draft, "Added a section.");
                  window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[aria-labelledby="${uid}-sec-${r.key}"] .kpl-sec-name`)?.select());
                }}>
                {draft.sections.length >= PLAN_LIMITS.sections ? `Up to ${PLAN_LIMITS.sections} sections` : "Add a section"}
              </Button>
              {draft.tasks.length >= PLAN_LIMITS.tasks && <span className="kpl-cap">A plan holds up to {PLAN_LIMITS.tasks} tasks.</span>}
            </div>
          </div>
        ) : step === "creating" && draft ? (
          <Creating draft={draft} progress={progress} appending={appending} projectName={appending ? project!.name : draft.name} />
        ) : step === "failed" && failure ? (
          <div className="kpl-failed" ref={failRef} tabIndex={-1} role="alert">
            <span className="kpl-failed-mark" aria-hidden="true"><Icon name="alert" size={20} sw={1.75} /></span>
            <p className="kpl-failed-title">{appending ? "The tasks weren't added" : "The project wasn't created"}</p>
            <p className="kpl-failed-body">{failure.message}</p>
            {failure.failed.length > 0 && (
              <details className="kpl-failed-list">
                <summary>What couldn't be made ({failure.failed.length})</summary>
                <ul>{failure.failed.slice(0, 12).map((f, i) => <li key={i}>{f}</li>)}</ul>
              </details>
            )}
            <p className="kpl-failed-body">Your plan is still here: go back to change it, or try again.</p>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

/* ---------------- step 1: describe ---------------- */

function Describe({
  uid, goal, setGoal, goalRef, busy, elapsed, appending, project, workspaceName, name, setName, deadline, today, setDeadline, deadlineNote,
  constraints, setConstraints, roster, teamIds, picked, setPicked, currentUserId, aiEnabled, aiProblem, onDevice, onRetry,
}: {
  uid: string;
  goal: string;
  setGoal: (v: string) => void;
  goalRef: React.RefObject<HTMLTextAreaElement>;
  busy: boolean;
  elapsed: number;
  appending: boolean;
  project: Project | null;
  workspaceName: string;
  name: string;
  setName: (v: string) => void;
  deadline?: string;
  today: string;
  setDeadline: (d: string | undefined) => void;
  deadlineNote: string | null;
  constraints: string;
  setConstraints: (v: string) => void;
  roster: ReturnType<typeof plannerRoster>;
  /** the people picked by default: everyone but guests */
  teamIds: string[];
  picked: string[];
  setPicked: (ids: string[]) => void;
  currentUserId: string;
  aiEnabled: boolean;
  aiProblem: { reason: PlannerFailure; message: string } | null;
  onDevice: () => void;
  onRetry: () => void;
}) {
  const left = PLAN_LIMITS.goal - goal.length;
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const all = picked.length === roster.length;
  const theTeam = !all && picked.length === teamIds.length && teamIds.every((id) => picked.includes(id));
  return (
    <div className="kpl-describe" aria-busy={busy || undefined}>
      {busy && (
        <div className="kpl-drafting" role="group" aria-label="Drafting">
          <AiMark size={16} thinking />
          <div className="kpl-drafting-text">
            <p><b>Kanbo is drafting your plan.</b> It reads your goal, the people and the dates, then lays out the work. This can take up to a minute.</p>
            <span className="kpl-mono kpl-drafting-time" aria-hidden="true">{elapsed}s</span>
          </div>
          <span className="kpl-drafting-acts">
            <Button variant="secondary" size="sm" onClick={onDevice}>Plan on this device instead</Button>
          </span>
        </div>
      )}
      {aiProblem && !busy && (
        <div className="kpl-note" data-tone={aiProblem.reason === "daily_limit" || aiProblem.reason === "not_allowed" ? "warn" : "signal"} role="alert">
          <Icon name="alert" size={16} sw={1.75} />
          <p>{aiProblem.message} {aiProblem.reason === "daily_limit" || aiProblem.reason === "not_allowed"
            ? "Kanbo can still draft the plan on this device, from templates."
            : "Try again, or draft it on this device from templates."}</p>
          <span className="kpl-note-acts">
            {aiProblem.reason !== "daily_limit" && aiProblem.reason !== "not_allowed" && <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry}>Try again</Button>}
            <Button variant="secondary" size="sm" onClick={onDevice}>Plan on this device</Button>
          </span>
        </div>
      )}
      <p className="kpl-lede" id={`${uid}-lede`}>
        {appending
          ? <>Say what else <b>{project?.name ?? "this project"}</b> needs. Kanbo drafts tasks, owners and dates that fit around what's already there, for you to check. Nothing is added until you say so.</>
          : <>Say what you want to achieve. Kanbo drafts the sections, tasks, owners and dates for you to check. Nothing is created until you say so.</>}
      </p>
      <div className="kpl-field">
        <label className="kpl-label" htmlFor={`${uid}-goal`}>{appending ? "What should be added?" : "What's the goal?"}</label>
        <textarea id={`${uid}-goal`} ref={goalRef} className="kpj-field kpl-goal" value={goal} maxLength={PLAN_LIMITS.goal} disabled={busy}
          aria-describedby={`${uid}-lede ${uid}-count`} rows={4}
          placeholder={appending ? "The launch-week comms: press release, customer email and a webinar" : "Launch our mobile app in the App Store by 20 November, with a press push"}
          onChange={(e) => setGoal(e.target.value)} />
        <span className="kpl-count kpl-mono" id={`${uid}-count`} aria-live={left < 100 ? "polite" : undefined}>
          {left < 200 ? `${left} characters left` : ""}
        </span>
      </div>
      {!goal.trim() && !busy && (
        <div className="kpl-examples" role="group" aria-label="Examples to start from">
          {PLANNER_EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="kpl-example" onClick={() => { setGoal(ex); goalRef.current?.focus(); }}>
              <Icon name="sparkles" size={14} sw={1.75} /><span>{ex}</span>
            </button>
          ))}
        </div>
      )}
      <div className="kpl-row2">
        <div className="kpl-field">
          <span className="kpl-label" id={`${uid}-dl`}>Deadline <span className="kpl-opt">optional</span></span>
          <span className="kpl-inline" aria-labelledby={`${uid}-dl`}>
            <DateChip value={deadline} label="Deadline" size="md" tone="plain" placeholder="No deadline" onChange={(d) => setDeadline(d)} />
            {deadline && <button type="button" className="kpl-linkbtn" onClick={() => setDeadline(undefined)}>Clear</button>}
          </span>
          {deadlineNote ? <span className="kpl-hint" data-tone="signal" role="alert">{deadlineNote}</span>
            : deadline ? <span className="kpl-hint">Everything is planned to be done by {planDayLabel(deadline)}.</span>
            : <span className="kpl-hint">Planning from {planDayLabel(today)}.</span>}
        </div>
        {!appending && (
          <div className="kpl-field">
            <label className="kpl-label" htmlFor={`${uid}-name`}>Project name <span className="kpl-opt">optional</span></label>
            <input id={`${uid}-name`} className="kpj-field" data-size="lg" value={name} maxLength={PLAN_PROJECT_NAME_MAX} disabled={busy}
              placeholder="Kanbo will suggest one" onChange={(e) => setName(e.target.value)} />
          </div>
        )}
      </div>
      {roster.length > 0 && (
        <div className="kpl-field">
          <span className="kpl-label" id={`${uid}-people`}>
            Who's working on it
            <span className="kpl-opt">{all ? `everyone in ${workspaceName || "this workspace"}` : theTeam ? "everyone but guests" : `${picked.length} of ${roster.length}`}</span>
          </span>
          <div className="kpl-people" role="group" aria-labelledby={`${uid}-people`}>
            {roster.map((r) => {
              const on = picked.includes(r.id);
              return (
                <button key={r.id} type="button" className="kpl-person" aria-pressed={on} disabled={busy} onClick={() => toggle(r.id)}>
                  <span className="kpl-person-check" aria-hidden="true">{on && <Icon name="check" size={12} sw={2.25} />}</span>
                  <span className="kpl-person-name">{r.id === currentUserId ? `${r.name} (me)` : r.name}</span>
                  {r.title && <span className="kpl-person-title">{r.title}</span>}
                  {r.guest && <span className="kpl-person-title">Guest</span>}
                </button>
              );
            })}
          </div>
          {!picked.length && <span className="kpl-hint">Nobody picked: the tasks will be unassigned.</span>}
        </div>
      )}
      <div className="kpl-field">
        <label className="kpl-label" htmlFor={`${uid}-cons`}>Anything Kanbo should know? <span className="kpl-opt">optional</span></label>
        <textarea id={`${uid}-cons`} className="kpj-field kpl-cons" value={constraints} maxLength={PLAN_LIMITS.constraints} disabled={busy} rows={2}
          placeholder="Budget £5k. No launches on Fridays. Theo is off 2–6 November."
          onChange={(e) => setConstraints(e.target.value)} />
      </div>
      {!aiEnabled && (
        <p className="kpl-device">
          <Icon name="check" size={14} sw={2} />
          <span>{isSupabaseConfigured ? "Kanbo AI is off in Settings, so plans are drafted on this device from templates." : "In the demo, plans are drafted on this device from templates."}</span>
        </p>
      )}
    </div>
  );
}

/* ---------------- the source of the draft ---------------- */

function Source({ draft, drafted, people }: { draft: PlanDraft; drafted: { goal: string; why: DeviceWhy | null; category: string } | null; people: number }) {
  if (draft.source === "ai") {
    const details = [
      "Planned by Kanbo from your goal" + (draft.deadline ? `, working back from ${planDayLabel(draft.deadline)}` : ""),
      people ? `Owners chosen from the ${plural(people, "person", "people")} it assigned, by role and spread of work` : "No owners: assign them below",
      `Dates count working days (Monday to Friday) from ${planDayLabel(draft.startDate)}`,
      "Nothing is created until you choose Create",
    ];
    return (
      <Vellum provenance={{ summary: `${plural(draft.tasks.length, "task")} from your goal`, details }}>
        <p className="kpl-source">Kanbo drafted this plan. Check the owners, dates and estimates, then create it.</p>
      </Vellum>
    );
  }
  const why = drafted?.why;
  const reason = why === "off" ? "Kanbo AI is off in Settings"
    : why === "demo" ? "demo mode"
    : why === "offline" ? "you're offline"
    : why === "unavailable" ? "Kanbo AI isn't available right now"
    : why === "limit" ? "today's Kanbo AI limit is reached"
    : null;
  return (
    <p className="kpl-device" data-place="review">
      <Icon name="check" size={14} sw={2} />
      <span><b>Drafted on this device</b> · from the {drafted?.category?.toLowerCase() ?? "general"} template, shaped to your goal{reason ? ` · ${reason}` : ""}</span>
    </p>
  );
}

/* ---------------- step 3: creating ---------------- */

function Creating({ draft, progress, appending, projectName }: { draft: PlanDraft; progress: PlanApplyProgress | null; appending: boolean; projectName: string }) {
  const sections = tasksBySection(draft).filter((g) => g.section && g.tasks.length).length;
  const tasks = draft.tasks.length;
  const links = planEdgeCount(draft);
  const order: PlanApplyProgress["step"][] = ["project", "sections", "tasks", "dependencies", "done"];
  const at = progress ? order.indexOf(progress.step) : 0;
  const state = (s: PlanApplyProgress["step"]) => (order.indexOf(s) < at ? "done" : order.indexOf(s) === at ? "active" : "todo");
  const count = (s: PlanApplyProgress["step"], total: number) => (progress?.step === s ? `${progress.done} of ${progress.total || total}` : state(s) === "done" ? `${total} of ${total}` : `${total}`);
  const rows: { id: PlanApplyProgress["step"]; label: string; detail: string }[] = [
    ...(!appending ? [{ id: "project" as const, label: `The project “${projectName || "New project"}”`, detail: "" }] : []),
    { id: "sections", label: appending ? "New sections" : "Sections", detail: count("sections", sections) },
    { id: "tasks", label: "Tasks", detail: count("tasks", tasks) },
    { id: "dependencies", label: "Dependencies", detail: count("dependencies", links) },
  ];
  // overall: each step a share, the current one by how far through it is
  const shares = rows.length;
  const inStep = progress && progress.total ? progress.done / progress.total : 0;
  const idx = rows.findIndex((r) => r.id === progress?.step);
  const value = progress?.step === "done" ? 100 : Math.round(((Math.max(0, idx) + inStep) / shares) * 100);
  return (
    <div className="kpl-creating">
      <p className="kpl-creating-title">{appending ? `Adding to ${projectName}…` : `Creating ${projectName || "the project"}…`}</p>
      <Meter value={value} label="Progress" height={4} />
      <ol className="kpl-progress">
        {rows.map((r) => {
          const s = state(r.id);
          return (
            <li key={r.id} className="kpl-progress-row" data-state={s}>
              <span className="kpl-progress-mark" aria-hidden="true">{s === "done" ? <Icon name="check" size={12} sw={2.25} /> : s === "active" ? <span className="kspin" /> : null}</span>
              <span className="kpl-progress-label">{r.label}</span>
              {r.detail && <span className="kpl-progress-n kpl-mono">{r.detail}</span>}
              <span className="sr-only">{s === "done" ? "done" : s === "active" ? "in progress" : "waiting"}</span>
            </li>
          );
        })}
      </ol>
      <p className="kpl-hint">Keep this open until it's finished. If anything fails, Kanbo removes what it made, so you're never left with half a plan.</p>
    </div>
  );
}


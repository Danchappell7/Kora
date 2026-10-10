/* ============================================================
   KANBO — Today › "Your week's wins".                           [u10]
   Friday afternoons and Monday mornings (lib/momentum recapWindow): what
   you finished, grouped by project (ProjectChip identity), focus time,
   your streak, two or three collaboration moments; "Share to Slack"
   (SlackPostButton, kind "standup", the recap as text) when connected;
   "Copy"; "Hide" (onboarding.momentum.recapHidden). Warm, never
   boastful; a modest entrance (none with reduced motion).
   What's shared (Slack, Copy) is this workspace's work only: nothing
   from Personal or another workspace, and no one else's notes.
   Mount (integrator): Today, under the brief, through the lazy
   TodayWins (components/momentum/TodayMomentum), which reads the kudos
   and the days you planned.
   Folded (`fold`, Today beside the rail): one row — the title, the week
   in numbers and "Your week in full" (a disclosure) — so the day keeps
   its room; Slack sharing waits for the open card (its code with it).
   ============================================================ */
import { lazy, Suspense, useId, useMemo, useState } from "react";
import type { Kudos, Member, MomentumPrefs, Project, Task } from "../../data/types";
import { Icon, IconButton, ProjectChip, StatusGlyph } from "../primitives";
import { getProject } from "../../data/data";
import { copyText, useOptionalToast } from "../rituals/shared";
import {
  buildWinsRecap, focusLabel, localMoment, mondayOf, rangeLabel, recapHeadline, recapTitle, streakLabel, winsRecapText,
  type ApprovalMoment, type MomentumRecap, type RecapWindow,
} from "../../lib/momentum";
import { nameFrom, useMinuteClock } from "./shared";
import "./momentum.css";

export interface WinsRecapProps {
  now?: Date;
  currentUserId: string;
  /** your tasks (what you finished) */
  tasks: Task[];
  /** every task you can see (your teammates' too): the titles of kudos you gave, and who your work unblocked.
   *  Default: `tasks`. */
  seen?: Task[];
  projects: Project[];
  members: Member[];
  kudos: Kudos[];
  /** local dates you planned your day */
  plannedDays: string[];
  prefs?: MomentumPrefs | null;
  /** for "Share to Slack" (null = Personal: no Slack) */
  workspaceId: string | null;
  onOpenTask?: (taskId: string) => void;
  /** "Hide" — the host saves onboarding.momentum.recapHidden */
  onHide?: () => void;
  /* ---- optional extras ---- */
  /** the person's timezone (default Europe/London) */
  timezone?: string;
  /** focus-timer minutes per day (lib/momentum readFocusLog) */
  focusLog?: Record<string, number>;
  /** approvals you decided this week */
  approvals?: ApprovalMoment[];
  /** show "your week so far" outside the Friday / Monday windows (the demo; a preview) */
  preview?: boolean;
  /** your name, for the shared text's heading ("Daniel's week") */
  userName?: string;
  /** Today's fold (TodayCardFold): folded, the card is one row until it's opened. Without it, the card is whole. */
  fold?: { folded: boolean; onFold: (folded: boolean) => void } | null;
}

// "Share to Slack" (and lib/slack) only comes down with a team's open card, never with Today itself
const SlackPostButton = lazy(() => import("../integrations/SlackPostButton").then((m) => ({ default: m.SlackPostButton })));

const SHOWN_PROJECTS = 4, SHOWN_TASKS = 3;
const MOMENT_ICON: Record<string, string> = { kudos_received: "🎉", kudos_given: "🙌", unblocked: "🔓", helped: "🤝", approval: "✅" };

export function WinsRecap({ now, currentUserId, tasks, seen, projects, members, kudos, plannedDays, prefs, workspaceId, onOpenTask, onHide, timezone, focusLog, approvals, preview, userName, fold }: WinsRecapProps) {
  const at = useMinuteClock(now);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const toast = useOptionalToast();
  const [hidden, setHidden] = useState(false);
  const [allProjects, setAllProjects] = useState(false);
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const nameOf = (id: string) => nameFrom(members, id);
  // a minute's precision is all the window needs (and keeps the memo steady)
  const minute = Math.floor(at.getTime() / 60_000);

  const recap = useMemo((): MomentumRecap | null => {
    if (prefs?.recapHidden) return null;
    const base = { now: at, timezone, currentUserId, tasks, seen, projects, kudos, plannedDays, prefs, nameOf, focusLog, approvals };
    const r = buildWinsRecap(base);
    if (r || !preview) return r;
    // the preview: this week so far (Monday to today)
    const today = localMoment(at, timezone).date;
    const win: RecapWindow = { kind: "friday", from: mondayOf(today), to: today };
    return buildWinsRecap({ ...base, window: win });
    // (the clock to the minute stands in for `at`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minute, timezone, currentUserId, tasks, seen, projects, kudos, plannedDays, prefs, members, focusLog, approvals, preview]);

  if (!recap || hidden) return null;

  /* what's shared: this workspace's finished tasks and kudos only (never Personal, never another team's) */
  const sharedText = () => {
    const ws = workspaceId;
    const scoped = ws
      ? buildWinsRecap({
        now: at, timezone, currentUserId, projects, plannedDays, prefs, nameOf, focusLog,
        tasks: tasks.filter((t) => (t.workspaceId ?? null) === ws), kudos: kudos.filter((k) => k.workspaceId === ws),
        window: { kind: recap.kind, from: recap.from, to: recap.to },
      })
      : recap;
    return scoped ? winsRecapText(scoped, { name: userName, showStreak: !prefs?.streakHidden }) : "";
  };
  const outside = !!workspaceId && recap.byProject.some((p) => p.tasks.some((t) => {
    const task = tasks.find((x) => x.id === t.id);
    return (task?.workspaceId ?? null) !== workspaceId;
  }));
  const copy = async () => {
    const ok = await copyText(sharedText());
    if (!toast) return;
    if (ok) toast.success("Copied — paste it wherever your team keeps its updates");
    else toast.error("Couldn't copy — select the text and copy it yourself.");
  };
  const hide = () => {
    setHidden(true);
    onHide?.();
    toast?.success("Wins hidden. You can show them again in Settings.");
  };

  const projectOf = (id: string) => projects.find((p) => p.id === id) ?? getProject(id) ?? null;
  const groups = allProjects ? recap.byProject : recap.byProject.slice(0, SHOWN_PROJECTS);
  const title = recapTitle(recap);
  const streakShown = !prefs?.streakHidden && recap.streak.days >= 2;
  const folded = !!fold?.folded;
  const bodyId = `${uid}-body`;
  const disclosure = fold && (
    <IconButton icon="chevronDown" size="sm" label="Your week in full" className="kwins-fold" aria-expanded={!folded} aria-controls={bodyId}
      onClick={() => fold.onFold(!folded)} />
  );
  const hideButton = onHide && <IconButton icon="x" size="sm" label={`Hide ${title.toLowerCase()}`} onClick={hide} />;

  if (folded) {
    // one row: the week in numbers (the card's facts, in words), and the way into the rest
    const numbers = [
      recap.total > 0 ? `${recap.total} done` : null,
      recap.focusMinutes > 0 ? `${focusLabel(recap.focusMinutes)} ${recap.focusFrom === "timer" ? "focus" : "of focused work"}` : null,
      streakShown ? streakLabel(recap.streak.days) : null,
      recap.kudosReceived > 0 ? `${recap.kudosReceived} kudos` : null,
    ].filter(Boolean).join(" · ");
    return (
      <section className="kwins" aria-labelledby={`${uid}-h`} data-kind={recap.kind} data-folded="">
        <div className="kwins-head">
          <span className="kwins-lead" aria-hidden="true"><Icon name="sparkles" size={18} sw={1.75} /></span>
          <div className="kwins-heading">
            <h2 id={`${uid}-h`}>{title} <span className="kwins-range">{rangeLabel(recap.from, recap.to)}</span></h2>
            <p className="kwins-sum">{numbers || recapHeadline(recap)}</p>
          </div>
          <span className="kwins-acts">{disclosure}{hideButton}</span>
        </div>
        <div id={bodyId} hidden />
      </section>
    );
  }

  return (
    <section className="kwins" aria-labelledby={`${uid}-h`} data-kind={recap.kind}>
      <div className="kwins-head">
        <h2 id={`${uid}-h`}>{title}</h2>
        <span className="kwins-range">{rangeLabel(recap.from, recap.to)}</span>
        <span className="kwins-acts">
          {workspaceId && (
            <Suspense fallback={null}>
              <SlackPostButton workspaceId={workspaceId} kind="standup" variant="ghost" label="Share to Slack"
                title={userName ? `${userName.trim().split(/\s+/)[0]}'s week` : "My week"} getText={sharedText} />
            </Suspense>
          )}
          <IconButton icon="copy" size="sm" label="Copy as text" onClick={() => void copy()} />
          {disclosure}
          {hideButton}
        </span>
      </div>

      <div id={bodyId} className="kwins-body">
      <p className="kwins-lede">{recapHeadline(recap)}</p>

      <ul className="kwins-facts" aria-label="In numbers">
        {recap.total > 0 && <li className="kwins-fact"><Icon name="check" size={14} sw={2} /><b>{recap.total}</b>{" "}done</li>}
        {recap.focusMinutes > 0 && (
          <li className="kwins-fact" title={recap.focusFrom === "timer" ? "From your focus timer" : "From the time logged on, or estimated for, what you finished"}>
            <Icon name="clock" size={14} sw={1.75} /><b>{focusLabel(recap.focusMinutes)}</b>{recap.focusFrom === "timer" ? " focus" : " of focused work"}
          </li>
        )}
        {streakShown && <li className="kwins-fact"><Icon name="calendar" size={14} sw={1.75} /><b>{recap.streak.days}</b>{` ${streakLabel(recap.streak.days).replace(/^\d+-/, "")}`}</li>}
        {recap.kudosReceived > 0 && <li className="kwins-fact"><span className="kkudos-emoji" aria-hidden="true">🎉</span><b>{recap.kudosReceived}</b>{" "}kudos</li>}
      </ul>

      {recap.byProject.length > 0 && (
        <ul className="kwins-projects" aria-label="Finished, by project">
          {groups.map((g) => {
            const p = projectOf(g.projectId);
            const open = !!openProjects[g.projectId];
            const list = open ? g.tasks : g.tasks.slice(0, SHOWN_TASKS);
            return (
              <li key={g.projectId} className="kwins-proj">
                <div className="kwins-proj-head">
                  <ProjectChip project={p ?? { id: g.projectId, name: recap.projectNames[g.projectId] ?? "Other work", color: "", emoji: "" }} size="md" />
                  <span className="kwins-proj-n" aria-label={`${g.count} finished`}>{g.count}</span>
                </div>
                <ul className="kwins-tasks">
                  {list.map((t) => (
                    <li key={t.id}>
                      {onOpenTask
                        ? <button type="button" className="kwins-task" onClick={() => onOpenTask(t.id)} title={t.title}><span aria-hidden="true" style={{ display: "inline-flex" }}><StatusGlyph status="done" size={14} readOnly /></span><span>{t.title}</span></button>
                        : <span className="kwins-task"><span aria-hidden="true" style={{ display: "inline-flex" }}><StatusGlyph status="done" size={14} readOnly /></span><span>{t.title}</span></span>}
                    </li>
                  ))}
                  {g.tasks.length > SHOWN_TASKS && (
                    <li>
                      <button type="button" className="kwins-more" aria-expanded={open}
                        onClick={() => setOpenProjects((o) => ({ ...o, [g.projectId]: !open }))}>
                        {open ? "Show fewer" : `+${g.tasks.length - SHOWN_TASKS} more`}
                      </button>
                    </li>
                  )}
                </ul>
              </li>
            );
          })}
          {recap.byProject.length > SHOWN_PROJECTS && (
            <li className="kwins-proj">
              <button type="button" className="kwins-more" aria-expanded={allProjects} onClick={() => setAllProjects((v) => !v)}>
                {allProjects ? "Show fewer projects" : `+${recap.byProject.length - SHOWN_PROJECTS} more projects`}
              </button>
            </li>
          )}
        </ul>
      )}

      {recap.moments.length > 0 && (
        <ul className="kwins-moments" aria-label="With your team">
          {recap.moments.map((m, i) => (
            <li key={i} className="kwins-moment">
              <span className="kwins-moment-ico" data-kind={m.kind} aria-hidden="true">{MOMENT_ICON[m.kind] ?? "·"}</span>
              {m.taskId && onOpenTask
                ? <button type="button" className="kwins-moment-text" onClick={() => onOpenTask(m.taskId!)}>{m.text}</button>
                : <span className="kwins-moment-text">{m.text}</span>}
            </li>
          ))}
        </ul>
      )}

      {outside && <p className="kwins-foot">Share and Copy include this workspace's work only.</p>}
      </div>
    </section>
  );
}

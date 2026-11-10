/* ============================================================
   KANBO — "Welcome to <workspace>" on Today (0058). For someone who
   joined a team lately (lib/rollout shouldWelcome): their projects,
   their people, the team's top goal, who to ask and one or two
   starter tasks, so their first minute shows them the team and what
   matters this quarter, not an empty list. Shown once per workspace:
   "Got it" puts it away for good (profiles.onboarding.welcomed).
   One card under the brief, the whole width; a container query
   decides between two columns and one.
   ============================================================ */
import { useId } from "react";
import { Avatar, Button, Icon, IconButton, Meter, ProjectTile } from "../primitives";
import type { Goal, Project, Task } from "../../data/types";
import type { WelcomeContent, WelcomePerson } from "../../lib/rollout";
import { ROLE_META } from "../../lib/permissions";
import { OffChip } from "../availability/OffChip";

export interface WelcomeCardProps {
  workspaceName: string;
  logoUrl?: string;
  /** the workspace: "Off today" beside someone who's away (0055; nothing before it, or for a guest) */
  workspaceId?: string | null;
  content: WelcomeContent;
  /** the team goal's % and its pace line ("On pace", "Behind pace by 12%"), when it has one */
  goalRead?: { pct: number; line?: string } | null;
  onOpenProject: (projectId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenGoal?: (goalId: string) => void;
  onOpenPeople: () => void;
  /** "Got it": shown once, so this puts it away for good */
  onDismiss: () => void;
}

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dueWords = (iso?: string) => {
  if (!iso) return "No date yet";
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `Due ${d} ${MONTHS[(m || 1) - 1]}`;
};

function askLine(p: WelcomePerson & { why: "champion" | "owner" | "admin" }, workspaceName: string): string {
  if (p.why === "champion") return `Ask ${first(p.name)}, the team's Kanbo champion, anything about how things run here.`;
  if (p.why === "owner") return `Ask ${first(p.name)}, who runs ${workspaceName}, anything about how things run here.`;
  return `Ask ${first(p.name)}, who helps run ${workspaceName}, anything about how things run here.`;
}

/** the card's place on Today (one at a time), for the brief's line to bring into view */
export const WELCOME_CARD_ID = "kanbo-welcome";

/** The brief's line for someone new here: the card is under the day, so this says it's there (and,
 *  on a phone, where the brief fills the first screen, takes you to it). */
export function WelcomeLine({ workspaceName }: { workspaceName: string }) {
  const go = () => {
    const card = document.getElementById(WELCOME_CARD_ID);
    card?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    card?.focus({ preventScroll: true });
  };
  return (
    <p className="kwlcl">
      <style>{LINE_CSS}</style>
      <span aria-hidden="true">👋 </span>Welcome to <b>{workspaceName}</b>. Here's who's who and where to start.{" "}
      <button type="button" className="kwlcl-go" onClick={go}>Show me<Icon name="chevronDown" size={14} sw={2} /></button>
    </p>
  );
}
const LINE_CSS = `
.kwlcl { margin: 14px 0 0; max-width: 760px; font: 400 15px/24px var(--font-ui, var(--font-display)); color: var(--ink-2); text-wrap: pretty; }
.kwlcl b { font-weight: 600; color: var(--ink); }
.kwlcl-go { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; cursor: pointer; white-space: nowrap;
  font: 600 14px/24px var(--font-ui, var(--font-display)); color: var(--accent-text, var(--accent)); border-radius: 4px; vertical-align: baseline; }
.kwlcl-go:hover { text-decoration: underline; text-underline-offset: 3px; }
.kwlcl-go > svg { align-self: center; }
@media (max-width: 859px) { .kwlcl { margin-top: 12px; } }
`;

export function WelcomeCard({ workspaceName, logoUrl, workspaceId, content, goalRead, onOpenProject, onOpenTask, onOpenGoal, onOpenPeople, onDismiss }: WelcomeCardProps) {
  const headId = "kwlc" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const { projects, people, morePeople, goal, ask, starters } = content;
  // one person here, and they're who to ask: say it once, under them
  const askWithPeople = !!ask && people.length === 1 && people[0].id === ask.id;
  return (
    <section className="kwlc" aria-labelledby={headId} id={WELCOME_CARD_ID} tabIndex={-1}>
      <style>{WELCOME_CSS}</style>
      <header className="kwlc-head">
        {logoUrl
          ? <img className="kwlc-logo" src={logoUrl} alt="" />
          : <span className="kwlc-logo" aria-hidden="true">{workspaceName.charAt(0).toUpperCase()}</span>}
        <div className="kwlc-heading">
          <h2 id={headId} className="kwlc-title">Welcome to {workspaceName}</h2>
          <p className="kwlc-sub">Here's who you'll be working with and what matters here. It's all in Projects and Team too.</p>
        </div>
        <IconButton icon="x" label={`Put away “Welcome to ${workspaceName}”`} size="sm" className="kwlc-x" onClick={onDismiss} />
      </header>

      <div className="kwlc-grid">
        <div className="kwlc-part">
          <h3 className="kwlc-label">{projects.length === 1 ? "Your project" : "Your projects"}</h3>
          {projects.length ? (
            <ul className="kwlc-projects">
              {projects.map((p: Project) => (
                <li key={p.id}>
                  <button type="button" className="kwlc-project" onClick={() => onOpenProject(p.id)}>
                    <ProjectTile project={p} size={28} />
                    <span className="kwlc-project-name">{p.name}</span>
                    <Icon name="chevronRight" size={14} sw={1.75} />
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="kwlc-none">No projects here yet.</p>}
        </div>

        <div className="kwlc-part">
          <h3 className="kwlc-label">Your people</h3>
          {people.length ? (
            <ul className="kwlc-people">
              {people.map((p) => (
                <li key={p.id} className="kwlc-person">
                  <Avatar id={p.id} size={28} />
                  <span className="kwlc-person-text">
                    <span className="kwlc-person-name">{p.name}</span>
                    <span className="kwlc-person-role">
                      <span className="kwlc-person-rtext">{p.title || ROLE_META[p.role]?.label}</span>
                      <OffChip userId={p.id} workspaceId={workspaceId} size="xs" />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="kwlc-none">It's just you here so far.</p>}
          {askWithPeople && <p className="kwlc-asknote">{askLine(ask!, workspaceName)}</p>}
          <button type="button" className="kwlc-link" onClick={onOpenPeople}>{morePeople > 0 ? `and ${morePeople} more in People` : "See everyone in People"}</button>
        </div>

        {goal && (
          <div className="kwlc-part">
            <h3 className="kwlc-label">The team's goal</h3>
            <GoalRow goal={goal} read={goalRead} onOpen={onOpenGoal} />
          </div>
        )}

        {ask && !askWithPeople && (
          <div className="kwlc-part">
            <h3 className="kwlc-label">Who to ask</h3>
            <p className="kwlc-ask">
              <Avatar id={ask.id} size={28} />
              <span>{askLine(ask, workspaceName)}</span>
            </p>
          </div>
        )}

        <div className="kwlc-part kwlc-wide">
          <h3 className="kwlc-label">{starters.length ? "Start with" : "A good first step"}</h3>
          {starters.length ? (
            <ul className="kwlc-tasks">
              {starters.map((t: Task) => (
                <li key={t.id}>
                  <button type="button" className="kwlc-task" onClick={() => onOpenTask(t.id)}>
                    <span className="kwlc-task-dot" aria-hidden="true" />
                    <span className="kwlc-task-title">{t.title}</span>
                    <span className="kwlc-task-due">{dueWords(t.dueDate)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="kwlc-none">Nothing's on your plate here yet. Open a project above and see what the team is working on.</p>
          )}
        </div>
      </div>

      <div className="kwlc-foot">
        <Button variant="primary" size="sm" icon="check" onClick={onDismiss}>Got it</Button>
        <span className="kwlc-foot-note">You'll only see this once.</span>
      </div>
    </section>
  );
}

function GoalRow({ goal, read, onOpen }: { goal: Goal; read?: { pct: number; line?: string } | null; onOpen?: (id: string) => void }) {
  const tile = { id: goal.id, name: goal.name, color: goal.color ?? "oklch(0.62 0.13 264)", emoji: goal.icon ?? "🎯" };
  const body = (
    <>
      <ProjectTile project={tile} size={28} />
      <span className="kwlc-goal-text">
        <span className="kwlc-goal-name">{goal.name}</span>
        {read && <span className="kwlc-goal-pace">{read.pct}%{read.line ? ` · ${read.line}` : ""}</span>}
      </span>
    </>
  );
  return (
    <div className="kwlc-goal">
      {onOpen ? <button type="button" className="kwlc-goal-open" onClick={() => onOpen(goal.id)}>{body}</button> : <div className="kwlc-goal-open">{body}</div>}
      {read && <Meter value={read.pct} height={4} label={`${goal.name}: ${read.pct}%`} />}
    </div>
  );
}

const WELCOME_CSS = `
.kwlc {
  container-type: inline-size; position: relative; max-width: 920px; margin-top: 16px; padding: 18px 18px 14px 20px; scroll-margin-top: 96px;
  border-radius: var(--r-lg, 12px); background: var(--surface, var(--surface-raised)); box-shadow: var(--e1, 0 0 0 1px var(--hairline));
}
.kwlc::before {
  content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; border-radius: var(--r-lg, 12px) var(--r-lg, 12px) 0 0;
  background: var(--grad, linear-gradient(90deg, #5B7CFA, #8B5CF6 52%, #C24BE0)); opacity: 0.9;
}
.kwlc-head { display: flex; align-items: center; gap: 14px; }
.kwlc-logo {
  display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border-radius: 10px; object-fit: cover;
  background: var(--fill-1); color: var(--ink-2); font: 700 17px/1 var(--font-head); box-shadow: inset 0 0 0 1px var(--hairline);
}
.kwlc-heading { flex: 1; min-width: 0; }
.kwlc-title { margin: 0; font: 600 17px/24px var(--font-head); letter-spacing: -0.01em; color: var(--ink); text-wrap: balance; }
.kwlc-sub { margin: 2px 0 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kwlc-x { align-self: flex-start; flex-shrink: 0; }
.kwlc-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px 28px; margin-top: 14px; }
@container (min-width: 600px) { .kwlc-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kwlc-wide { grid-column: 1 / -1; } }
.kwlc-part { min-width: 0; padding: 10px 0 8px; box-shadow: inset 0 1px 0 var(--hairline); }
.kwlc-label { margin: 0 0 6px; font: 600 11px/16px var(--font-ui, var(--font-display)); letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-3); }
.kwlc-none { margin: 0; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kwlc-projects, .kwlc-people, .kwlc-tasks { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; }
.kwlc-project, .kwlc-task, .kwlc-goal-open {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 4px 8px; margin: 0 -8px; box-sizing: content-box;
  border: 0; border-radius: var(--r-md, 8px); background: transparent; color: var(--ink); text-align: left; cursor: pointer;
  font: 500 14px/20px var(--font-ui, var(--font-display)); transition: background var(--d-1, 90ms) var(--ease);
}
div.kwlc-goal-open { cursor: default; }
.kwlc-project:hover, .kwlc-task:hover, button.kwlc-goal-open:hover { background: var(--fill-1); }
.kwlc-project > svg { margin-left: auto; color: var(--ink-4); flex-shrink: 0; }
.kwlc-project-name, .kwlc-task-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kwlc-people { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 12px; }
.kwlc-person { display: flex; align-items: center; gap: 8px; min-width: 0; }
.kwlc-person-text { display: grid; min-width: 0; }
.kwlc-person-name { font: 600 13px/18px var(--font-ui, var(--font-display)); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kwlc-person-role { display: flex; align-items: center; gap: 6px; min-width: 0; font: 400 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kwlc-person-rtext { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kwlc-link {
  margin: 8px 0 0; padding: 0; border: 0; background: none; cursor: pointer; color: var(--accent-text, var(--accent));
  font: 500 12px/16px var(--font-ui, var(--font-display));
}
.kwlc-link:hover { text-decoration: underline; }
.kwlc-goal { display: grid; gap: 6px; }
.kwlc-goal-text { display: grid; min-width: 0; }
.kwlc-goal-name { font: 600 14px/20px var(--font-ui, var(--font-display)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kwlc-goal-pace { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.kwlc-ask { display: flex; align-items: flex-start; gap: 10px; margin: 0; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); text-wrap: pretty; }
.kwlc-ask > :first-child { flex-shrink: 0; }
/* (focused by the brief's "Show me", for a screen reader: the scroll is what the eye follows) */
.kwlc:focus { outline: none; }
.kwlc-asknote { margin: 8px 0 0; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); text-wrap: pretty; }
.kwlc-task-dot { width: 14px; height: 14px; flex-shrink: 0; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--ink-4); }
.kwlc-task-due { flex-shrink: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.kwlc-foot { display: flex; align-items: center; gap: 12px; margin-top: 10px; padding-top: 12px; box-shadow: inset 0 1px 0 var(--hairline); }
.kwlc-foot-note { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
@media (max-width: 859px) {
  .kwlc { padding: 16px 14px 12px 16px; }
  .kwlc-project, .kwlc-task { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) { .kwlc * { transition: none !important; } }
`;

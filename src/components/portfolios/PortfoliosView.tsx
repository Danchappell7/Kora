/* ============================================================
   KANBO — Portfolios: projects rolled up, as cards to manage them or
   a table to read them at a glance.
   Each project shows ONE status pill (lib/honestStatus): the lead's
   call, marked when Kanbo sees worse in the work ("Lead says / Kanbo
   sees" on hover and focus), and those mismatches come first. Its
   update reads against its update day (lib/updateRhythm, 0053):
   "Update missing" past the day and its follow-ups, "Due today" on
   the day; before 0053, the old 14-day rule. A workspace's owners and
   admins can ask a project's owner for its update from its row.
   0054: each portfolio opens its own page (PortfolioPage), and several
   projects can be added at once from Cards or Table.
   ============================================================ */
import { useMemo, useState } from "react";
import { Avatar, Button, EmptyState, Icon, IconButton, Meter, Pill, ProjectDot, ProjectTile, Segmented } from "../primitives";
import { getProject, getMember, KANBO_TODAY, toLocalISO, WORKSPACES } from "../../data/data";
import { accessOn } from "../../lib/projectAccess";
import type { Task, Project, Portfolio, StatusUpdate, Workspace } from "../../data/types";
import { projectHealth, useStableOrder, type ProjectHealth } from "../views/reportingUtils";
import { DraftInput } from "../project/DraftInput";
import { fmtShortDay, FORMER_MEMBER, indexTasks, isStale, oldestTaskAge, projectUpdates, statusFacts, updateAuthor, type TaskIndex } from "../../lib/statusDraft";
import { combinedProgress, progressOf } from "../../lib/countRules";
import { mergedStatus, pillCounts, type MergedStatus } from "../../lib/honestStatus";
import { projectRhythmState, updateFreshness, type UpdateFreshness } from "../../lib/updateRhythm";
import type { AskForUpdate } from "../../lib/updateAsks";
import { WorkspaceMark } from "../businesses/Businesses";
import { spectrumColor } from "../../lib/projectIdentity";
import { shortName } from "../../lib/businesses";
import { MergedStatusPill } from "../updates/MergedStatusPill";
import { AskForUpdateButton } from "../updates/AskForUpdate";
import { AddProjectsPicker } from "./AddProjectsPicker";
import "../project/projects.css";
import "../updates/updates.css";

/* A Personal portfolio across businesses: each project says which business it's from, a project you can no
   longer see keeps its place (and can be taken out), and the card says who can see it. */
export const ACROSS_CSS = `
.kpj-pf-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.kpj-pf-name > .kpj-pf-open { flex: 0 1 auto; }
.kpj-pf-biz { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 1; min-width: 0; font: 500 12px/16px var(--kpj-font); color: var(--ink-3); white-space: nowrap; }
.kpj-pf-biz > span:last-child { overflow: hidden; text-overflow: ellipsis; }
.kpj-pf-gone { min-width: 0; font: 500 14px/20px var(--kpj-font); color: var(--ink-3); font-style: italic; }
/* stacked (a narrow table): the remove button stays beside the name */
@container (max-width: 599px) { .kpj-exec .kpj-tr[data-gone] .kpj-td:nth-child(5) { grid-column: 2; grid-row: 1; text-align: right; } }
.kpj-pf-only { display: inline-flex; align-items: center; gap: 6px; font: 500 12px/16px var(--kpj-font); color: var(--ink-3); white-space: nowrap; }
.kpj-pf-only > svg { color: var(--icon-quiet, var(--ink-4)); }
.kpj-pick-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; }
.kpj-pick-head { display: inline-flex; align-items: center; gap: 6px; flex-basis: 100%; margin-top: 4px; font: 600 12px/16px var(--kpj-font); color: var(--ink-3); }
.kpj-pick-group:first-child .kpj-pick-head { margin-top: 0; }
.kpj-proj .kpj-pf-biz { grid-column: 2; }
/* (its summary carries one more line: it wraps rather than run off a phone's edge) */
[data-across] .kpj-card-side, [data-across] .kpj-pf-exec-head { flex-wrap: wrap; min-width: 0; row-gap: 6px; }
[data-across] .kpj-card-side { justify-content: flex-end; }
@media (max-width: 859px) {
  .kpj-pf-name { flex-wrap: wrap; row-gap: 0; }
  [data-across] .kpj-card-side { justify-content: flex-start; margin-left: 0; }
  .kpj-pf-only { flex-basis: 100%; }
}
`;
/* the table's Updated cell: its word, and Ask for an update under it */
const PF_CSS = `
.kup-pf-upd { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 2px; }
/* a phone: a card's summary wraps under its name rather than push + Project off the edge */
@media (max-width: 859px) { .kup-pf-card .kpj-card-side { flex-wrap: wrap; min-width: 0; row-gap: 6px; } }
.kup-pf-upd .kbtn { margin-right: -8px; }
@container (max-width: 599px) { .kup-pf-upd { align-items: flex-start; } .kup-pf-upd .kbtn { margin: 0 0 0 -8px; } }
/* the table's head on a phone: its name and counts on one line, + Projects and Open on their own under it */
@media (max-width: 599px) {
  .kup-pf-table .kpj-pf-exec-head { flex-wrap: wrap; align-items: center; row-gap: 4px; min-width: 0; }
  .kup-pf-table .kpj-pf-exec-name { min-width: 0; overflow-wrap: anywhere; }
  .kup-pf-table .kpf-head-acts { flex-basis: 100%; margin-left: -8px; }
}
/* a card's tile opens the portfolio's page */
.kup-pf-tile { display: inline-flex; flex-shrink: 0; padding: 0; border: 0; border-radius: 7px; background: none; cursor: pointer; }
.kup-pf-tile:hover { filter: brightness(0.96); }
.kup-pf-tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* a phone's card row: its whole name on one line, then the pill, its update and the rest under it */
@media (max-width: 599px) {
  .kup-pf-card .kpj-pf-row { grid-template-columns: 10px minmax(0, 1fr); row-gap: 4px; padding: 10px 0; }
  .kup-pf-card .kpj-pf-row > .kpj-pf-open { white-space: normal; overflow-wrap: anywhere; }
  .kup-pf-card .kpj-pf-row > .kpj-pf-side { grid-column: 2; justify-content: flex-start; gap: 6px 10px; }
}
`;
const ONLY_YOU = "It's in your Personal space, so only you can see it. It shows projects from every business you're in, from what you can already see.";

/** A portfolio dressed as a project, for its tile, its page's identity band and the identity sheet (0054). */
export const asIdentity = (pf: Portfolio): Project => ({ id: pf.id, name: pf.name, emoji: pf.emoji || "💼", color: pf.color || spectrumColor("sky"), workspaceId: pf.workspaceId ?? null });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Maya" for Maya Lin; "Former member" stays whole */
const firstName = (name: string) => (name === FORMER_MEMBER ? name : name.split(/\s+/)[0] || name);

/** An inline "add" row: a name field with Add and Cancel. */
function Adder({ label, placeholder, onAdd, onCancel }: { label: string; placeholder: string; onAdd: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const add = () => { const n = name.trim(); if (n) onAdd(n); };
  return (
    <div className="kpj-adder">
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <input autoFocus className="kpj-field" value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} aria-label={label}
        onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} />
      <Button variant="primary" onClick={add} disabled={!name.trim()}>Add</Button>
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

/** One project as a portfolio reads it: its tasks, Kanbo's read, the latest update, the one pill and how fresh its update is. */
export interface PfRow { p: Project; ptasks: Task[]; health: ProjectHealth | null; latest?: StatusUpdate; status: MergedStatus; fresh: UpdateFreshness }

/** The rows of a portfolio, mismatches first (then the worse off, then as they were added). */
export function portfolioRows(projects: Project[], tasks: Task[], idx: TaskIndex, statusUpdates: StatusUpdate[], today: Date, workspaces?: readonly Workspace[]): PfRow[] {
  const todayIso = toLocalISO(today);
  const rows = projects.map((p, i) => {
    const ptasks = idx.byProject.get(p.id) ?? [];
    const f = statusFacts(p, tasks, statusUpdates, today, idx);
    const health = projectHealth(ptasks, today);
    const state = projectRhythmState(p, ptasks, f.latest, today, workspaces);
    const fresh = updateFreshness(state, f.lastUpdateDays, isStale(f, oldestTaskAge(ptasks, p.id, today)), todayIso);
    const status = mergedStatus(p, f.latest, { health: health?.kind ?? null, overdue: f.overdue.length, blocked: f.blocked.length });
    return { row: { p, ptasks, health, latest: f.latest, status, fresh }, i };
  });
  return rows.sort((a, b) => a.row.status.rank - b.row.status.rank || a.i - b.i).map((x) => x.row);
}

type PfView = "cards" | "table";
const readView = (): PfView => { try { return localStorage.getItem("kanbo-portfolio-view") === "table" ? "table" : "cards"; } catch { return "cards"; } };

export function PortfoliosView({ portfolios, projects, seenProjects, me, tasks, statusUpdates = [], onCreate, onUpdate, onDelete, onOpenProject, acrossBusinesses, readOnly = false, asks, onOpenPortfolio }: {
  portfolios: Portfolio[];
  projects: Project[];
  /** 0058: every project of the workspace you can see, archived ones included (one a portfolio holds
   *  that isn't here is counted, never named). Defaults to `projects`. */
  seenProjects?: readonly Pick<Project, "id">[];
  /** you (the workspace's owner sees every project: one that isn't here was deleted) */
  me?: string;
  /** the workspace's tasks, archived projects' included: a finished project that's been
   *  archived keeps its % in the portfolio, as on a goal linked to it */
  tasks: Task[];
  /** project status updates, newest first — adds each project's latest call to its row */
  statusUpdates?: StatusUpdate[];
  /** Personal: portfolios only you can see, whose projects can come from every business you're in. `projects`
   *  and `tasks` are then every workspace's (yours to see); the picker groups them by business. */
  acrossBusinesses?: { workspaces: Workspace[] };
  onCreate: (name: string) => void;
  onUpdate: (id: string, patch: { name?: string; projectIds?: string[] }) => void;
  onDelete: (id: string) => void;
  onOpenProject: (projectId: string) => void;
  /** a guest: the portfolios to read and open, no controls */
  readOnly?: boolean;
  /** 0053: "Ask for an update" on a row whose update is due or missing (owners and admins) */
  asks?: AskForUpdate;
  /** 0054: open a portfolio's own page */
  onOpenPortfolio?: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [view, setViewRaw] = useState<PfView>(readView);
  const setView = (v: PfView) => { setViewRaw(v); try { localStorage.setItem("kanbo-portfolio-view", v); } catch { /* private mode */ } };
  const ordered = useStableOrder(portfolios);
  // the task list grouped by project once per change, not filtered again for every project
  const idx = useMemo(() => indexTasks(tasks), [tasks]);
  const across = acrossBusinesses ?? null;
  // (each project's update day is its workspace's unless it chose one: App keeps WORKSPACES current)
  const workspaces = WORKSPACES;
  const explainer = across
    ? "A portfolio rolls several projects into one view. In Personal it can hold projects from every business you're in, and only you can see it."
    : "A portfolio rolls several projects into one view: their progress, health and latest updates.";
  const findProject = (pid: string) => getProject(pid) ?? projects.find((p) => p.id === pid);
  const bizOf = (p: Project) => (across ? across.workspaces.find((w) => (w.id ?? null) === (p.workspaceId ?? null)) : undefined);
  const biz = (p: Project) => {
    const w = bizOf(p);
    return w ? <span className="kpj-pf-biz"><WorkspaceMark workspace={w} size={16} /><span>{shortName(w.name)}</span></span> : null;
  };
  const onlyYou = across ? <span className="kpj-pf-only" title={ONLY_YOU}><Icon name="lock" size={12} sw={2} />Only you can see this</span> : null;
  // an archived project keeps its row (and its %), and says so
  const openBtn = (p: Project) => (
    <button type="button" className="kpj-pf-open" onClick={() => onOpenProject(p.id)} aria-label={`Open project ${p.name}${p.archivedAt ? " (archived)" : ""}`}>
      {p.name}{p.archivedAt && <span className="kpj-pf-archived"> (archived)</span>}
    </button>
  );
  // asking is for rows whose update is due or missing, and never for a guest
  const askFor = (r: PfRow, compact?: boolean) => !readOnly && (r.fresh.kind === "missing" || r.fresh.kind === "due")
    ? <AskForUpdateButton project={r.p} asks={asks} compact={compact} /> : null;

  return (
    <div className="kpj-page">
      {across && <style>{ACROSS_CSS}</style>}
      <style>{PF_CSS}</style>
      <div className="kpj-wrap">
        {portfolios.length === 0 && readOnly ? (
          <EmptyState art="briefcase" title="Portfolios are for members"
            body={`Members of this workspace group its projects here to see how they're going together. As a guest you can still open ${projects.some((p) => accessOn(workspaces.find((w) => w.id === p.workspaceId))) ? "the projects you're added to" : "every project"}.`} />
        ) : portfolios.length === 0 && !adding ? (
          <EmptyState art="briefcase" title="No portfolios yet" body={explainer}
            action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>New portfolio</Button>} />
        ) : (
          <>
            <div className="kpj-toolbar">
              <p className="kpj-toolbar-note">{readOnly ? "Projects grouped by the workspace's members. As a guest you can read them and open each project." : explainer}</p>
              <Segmented ariaLabel="Portfolio view" value={view} onChange={setView}
                options={[{ value: "cards", label: "Cards" }, { value: "table", label: "Table" }]} />
              {!readOnly && <Button variant="primary" size="sm" icon="plus" onClick={() => setAdding(true)}>New portfolio</Button>}
            </div>
            {adding && <Adder label="New portfolio name" placeholder="Portfolio name, e.g. Q3 initiatives" onAdd={(n) => { onCreate(n); setAdding(false); }} onCancel={() => setAdding(false)} />}
            <div className={view === "cards" ? "kpj-stack" : undefined}>
              {ordered.map((pf) => {
                const inPf = pf.projectIds.map(findProject).filter((p): p is Project => !!p);
                // (Personal, across businesses: a project you can no longer see keeps its place, to be taken out)
                const gone = across ? pf.projectIds.filter((id) => !findProject(id)) : [];
                // 0058: in a workspace with project access on, the ones you can't see are counted, never named
                const pfWs = workspaces.find((w) => w.id === pf.workspaceId);
                const unseen = !across && accessOn(pfWs) && !(me && pfWs?.ownerId === me)
                  ? pf.projectIds.filter((id) => !(seenProjects ?? projects).some((p) => p.id === id)).length : 0;
                const goneRows = (table: boolean) => gone.map((id) => {
                  const remove = <IconButton icon="x" size="sm" label={`Remove the project you can no longer see from ${pf.name}`} onClick={() => onUpdate(pf.id, { projectIds: pf.projectIds.filter((x) => x !== id) })} />;
                  const why = <span className="kpj-card-meta">You've lost access to it, or it was deleted</span>;
                  // in the table: a cell under each column (why under Latest update, remove under Updated)
                  return table ? (
                    <div key={id} className="kpj-tr kpj-exec-tr" role="row" data-gone="">
                      <div role="cell" className="kpj-td"><span className="kpj-proj" style={{ padding: 0 }}><ProjectDot color="oklch(0.62 0 0)" size={10} /><span className="kpj-pf-gone">No longer visible to you</span></span></div>
                      <div role="cell" className="kpj-td">{why}</div>
                      <div role="cell" className="kpj-td" data-empty="true" />
                      <div role="cell" className="kpj-td kpj-exec-ms" />
                      <div role="cell" className="kpj-td kpj-num">{remove}</div>
                    </div>
                  ) : (
                    <div key={id} className="kpj-pf-row" data-gone="">
                      <ProjectDot color="oklch(0.62 0 0)" size={10} />
                      <span className="kpj-pf-gone">No longer visible to you</span>
                      <div className="kpj-pf-side">{why}{remove}</div>
                    </div>
                  );
                });
                const rows = portfolioRows(inPf, tasks, idx, statusUpdates, KANBO_TODAY, workspaces);
                // every top-level task across the portfolio's projects (lib/countRules), so it agrees with each row
                const combined = combinedProgress(rows.flatMap((r) => r.ptasks), inPf.map((p) => p.id)).pct;
                // counted from the pills the rows wear, so the header and the rows say the same thing
                const counts = pillCounts(rows);
                const missingN = rows.filter((r) => r.fresh.kind === "missing").length;
                const summary = (
                  <>
                    {onlyYou}
                    {inPf.length > 0 && <span className="kpj-count">{combined}% · {plural(inPf.length, "project")}</span>}
                    {unseen > 0 && <span className="kpj-card-meta">+{unseen} {unseen === 1 ? "project" : "projects"} you can't see</span>}
                    {counts.off > 0 && <Pill tone="signal">{counts.off} off track</Pill>}
                    {counts.risk > 0 && <Pill tone="warn">{counts.risk} at risk</Pill>}
                    {missingN > 0 && <Pill tone="neutral" title="Past their update day with nothing posted">{plural(missingN, "update")} missing</Pill>}
                    {counts.marked > 0 && <span className="kup-flags" title="Kanbo sees more trouble in the work than these projects' pills say: they carry its mark">
                      <span className="kup-pair-mark" data-tone="warn" aria-hidden="true" />Kanbo flags {counts.marked}</span>}
                  </>
                );

                const available = projects.filter((p) => p.id !== "p-personal" && !pf.projectIds.includes(p.id));
                const picking = pickFor === pf.id;
                // several at once (0054), from Cards or Table
                const picker = picking ? (
                  <AddProjectsPicker portfolioName={pf.name} available={available} workspaces={across?.workspaces}
                    emptyNote={across ? "Every project you can see is already in this portfolio." : "Every project in this workspace is already in this portfolio."}
                    onAdd={(ids) => { onUpdate(pf.id, { projectIds: [...pf.projectIds, ...ids.filter((id) => !pf.projectIds.includes(id))] }); setPickFor(null); }}
                    onCancel={() => setPickFor(null)} />
                ) : null;
                // (nothing left to add: the button says so rather than open an empty picker)
                const addBtn = !readOnly && (
                  <Button variant="ghost" size="sm" icon="plus" aria-expanded={picking} aria-label={`Add projects to ${pf.name}`} disabled={!available.length}
                    title={available.length ? undefined : "Every project is already in this portfolio"} onClick={() => setPickFor((x) => x === pf.id ? null : pf.id)}>Projects</Button>
                );
                const openPage = onOpenPortfolio && (
                  <Button variant="ghost" size="sm" icon="arrowUpRight" aria-label={`Open portfolio ${pf.name}`} onClick={() => onOpenPortfolio(pf.id)}>Open</Button>
                );

                if (view === "table") {
                  return (
                    <section key={pf.id} className="kpj-pf-exec kup-pf-table" aria-label={pf.name} data-across={across ? "" : undefined}>
                      <div className="kpj-pf-exec-head">
                        <h2 className="kpj-pf-exec-name">{pf.name}</h2>
                        {summary}
                        <span className="kpf-head-acts">{addBtn}{openPage}</span>
                      </div>
                      {picker}
                      {rows.length === 0 && gone.length === 0 ? <p className="kpj-card-meta">{readOnly ? "No projects in this portfolio yet." : "No projects in this portfolio yet. Add some with + Projects."}</p> : (
                        <PortfolioTable rows={rows} tasks={tasks} idx={idx} statusUpdates={statusUpdates} label={`${pf.name} projects`} onOpenProject={onOpenProject}
                          bizOf={across ? biz : undefined} extraRows={goneRows(true)} askFor={askFor} />
                      )}
                    </section>
                  );
                }

                return (
                  <article key={pf.id} className="kpj-card kup-pf-card" aria-label={`Portfolio ${pf.name}`} data-across={across ? "" : undefined}>
                    <div className="kpj-card-head">
                      {/* its own tile (0054), which opens its page (a pointer's shortcut: Open is the keyboard's and the screen reader's) */}
                      {onOpenPortfolio ? (
                        <button type="button" className="kup-pf-tile" onClick={() => onOpenPortfolio(pf.id)} tabIndex={-1} aria-hidden="true" title={`Open ${pf.name}`}>
                          <ProjectTile project={asIdentity(pf)} size={20} />
                        </button>
                      ) : <ProjectTile project={asIdentity(pf)} size={20} />}
                      {readOnly ? <h3 className="kpj-name-static" style={{ margin: 0 }}>{pf.name}</h3>
                        : <DraftInput value={pf.name} required label={`Portfolio name: ${pf.name}`} onCommit={(v) => onUpdate(pf.id, { name: v })} className="kpj-name-input" />}
                      <div className="kpj-card-side">
                        {summary}
                        {openPage}
                        {!readOnly && <>
                          {addBtn}
                          <IconButton icon="trash" size="sm" tone="danger" label={`Delete portfolio ${pf.name}`}
                            onClick={() => { if (window.confirm(`Delete portfolio “${pf.name}”? The projects themselves are kept. This can't be undone.`)) onDelete(pf.id); }} />
                        </>}
                      </div>
                    </div>
                    {picker}
                    {rows.length === 0 && gone.length === 0 ? (
                      <p className="kpj-card-meta" style={{ margin: "12px 0 0" }}>{readOnly ? "No projects in this portfolio yet." : "No projects yet. Add some with + Projects."}</p>
                    ) : rows.map((r) => {
                      const { p, ptasks, health, latest, status, fresh } = r;
                      // top-level tasks, the same rule as the Table and the project's own header
                      const { total: count, pct } = progressOf(ptasks);
                      const by = latest ? updateAuthor(latest) : undefined;
                      const ownerName = p.ownerId ? (getMember(p.ownerId)?.name ?? "(former member)") : null;
                      const said = latest ? `Latest update (${fmtShortDay(latest.createdAt, KANBO_TODAY)}${by ? `, ${by}` : ""}): ${latest.summary}` : undefined;
                      return (
                        <div key={p.id} className="kpj-pf-row">
                          <ProjectDot color={p.color} size={10} />
                          {across ? (
                            <span className="kpj-pf-name">
                              {openBtn(p)}
                              {biz(p)}
                            </span>
                          ) : openBtn(p)}
                          <div className="kpj-pf-side">
                            {/* one pill: the lead's call, marked when Kanbo sees worse in the work */}
                            <MergedStatusPill m={status} extra={said} />
                            {fresh.kind === "missing" || fresh.kind === "due" ? <span className="kup-fresh" data-kind={fresh.kind} title={fresh.title}>{fresh.text}</span> : null}
                            {askFor(r, true)}
                            {/* the avatar alone reads as initials: say whose it is */}
                            {ownerName && p.ownerId && getMember(p.ownerId) && (
                              <span className="kpj-owner" role="img" aria-label={`Owner: ${ownerName}`}><Avatar id={p.ownerId} size={20} /></span>
                            )}
                            <span className="kpj-card-meta kpj-mono" style={{ fontSize: 11 }}>
                              {plural(count, "task")}{health && health.overdue > 0 && <span className="kpj-signal"> · {health.overdue} overdue</span>}
                            </span>
                            <span className="kpj-progress" style={{ width: 112 }}>
                              <Meter value={pct} width={72} height={4} label={`${p.name} progress`} />
                              <span className="kpj-mono" aria-hidden="true">{pct}%</span>
                            </span>
                            {!readOnly && <IconButton icon="x" size="sm" label={`Remove ${p.name} from ${pf.name}`} onClick={() => onUpdate(pf.id, { projectIds: pf.projectIds.filter((id) => id !== p.id) })} />}
                          </div>
                        </div>
                      );
                    })}
                    {goneRows(false)}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The exec view of a portfolio: one row per project with its call (one pill), progress,
 *  next milestone and its update against its update day. */
export function PortfolioTable({ rows, tasks, idx, statusUpdates, label, onOpenProject, bizOf, extraRows, askFor }: {
  rows: PfRow[]; tasks: Task[]; idx: TaskIndex; statusUpdates: StatusUpdate[]; label: string; onOpenProject: (id: string) => void;
  /** across businesses: the business a project is from, under its name */
  bizOf?: (p: Project) => React.ReactNode;
  /** rows after the projects (a Personal portfolio's projects you can no longer see) */
  extraRows?: React.ReactNode;
  /** Ask for an update, where it's offered */
  askFor: (r: PfRow) => React.ReactNode;
}) {
  return (
    <div role="table" aria-label={label} className="kpj-table kpj-exec">
      <div role="rowgroup" className="kpj-thead">
        <div role="row" className="kpj-tr kpj-exec-tr">
          <span role="columnheader" className="kpj-th">Project</span>
          <span role="columnheader" className="kpj-th">Latest update</span>
          <span role="columnheader" className="kpj-th">Done</span>
          <span role="columnheader" className="kpj-th kpj-exec-ms">Next milestone</span>
          <span role="columnheader" className="kpj-th kpj-num">Updated</span>
        </div>
      </div>
      <div role="rowgroup" className="kpj-tbody">
        {rows.map((r) => {
          const { p, status, fresh } = r;
          const f = statusFacts(p, tasks, statusUpdates, KANBO_TODAY, idx);
          const latest = f.latest;
          const by = latest ? updateAuthor(latest) : undefined;
          return (
            <div key={p.id} role="row" className="kpj-tr kpj-exec-tr" onClick={() => onOpenProject(p.id)}>
              <div role="cell" className="kpj-td">
                <span className="kpj-proj" style={{ padding: 0 }}>
                  <ProjectDot color={p.color} size={10} />
                  <button type="button" className="kpj-pf-open" aria-label={`Open project ${p.name}${p.archivedAt ? " (archived)" : ""}`} title={p.archivedAt ? `${p.name} (archived)` : undefined}
                    onClick={(e) => { e.stopPropagation(); onOpenProject(p.id); }}>
                    {p.name}{p.archivedAt && <span className="kpj-pf-archived"> (archived)</span>}
                  </button>
                  {bizOf?.(p)}
                </span>
              </div>
              <div role="cell" className="kpj-td">
                <span className="kpj-exec-update">
                  <MergedStatusPill m={status} />
                  {/* who said it, in words (a tooltip alone is out of reach on a phone or the keyboard) */}
                  {latest && by && <span className="kpj-exec-by" data-former={latest.authorId && getMember(latest.authorId) ? undefined : ""}>{firstName(by)}</span>}
                  {latest ? <span className="kpj-exec-summary" title={by ? `${by}: ${latest.summary}` : latest.summary}>{latest.summary}</span>
                    : <span className="kpj-exec-summary">No update yet</span>}
                </span>
              </div>
              <div role="cell" className="kpj-td">
                <span className="kpj-progress">
                  <Meter value={f.pct} width={64} height={4} label={`${p.name} progress`} />
                  <span className="kpj-mono" aria-hidden="true">{f.pct}%<span className="kpj-exec-lbl"> done</span></span>
                </span>
              </div>
              <div role="cell" className="kpj-td kpj-exec-ms">
                {f.nextMilestone ? (
                  <span className="kpj-ms">
                    <span className="kpj-ms-title" title={f.nextMilestone.title}>{f.nextMilestone.title}</span>
                    <span className="kpj-ms-date">{fmtShortDay(f.nextMilestone.dueDate, KANBO_TODAY)}</span>
                  </span>
                ) : <><span className="kpj-dash" aria-hidden="true">—</span><span className="sr-only">No milestone</span></>}
              </div>
              <div role="cell" className="kpj-td kpj-num" data-empty={f.lastUpdateDays == null && fresh.kind !== "missing" && fresh.kind !== "due" ? "true" : undefined}>
                {/* the header row is hidden in the stacked (narrow) layout, so the cell says what it is */}
                {fresh.kind === "missing" || fresh.kind === "due" ? (
                  <span className="kup-pf-upd">
                    <span className="kup-fresh kpj-exec-stale" data-kind={fresh.kind} title={fresh.title}>{fresh.text}</span>
                    {askFor(r)}
                  </span>
                ) : f.lastUpdateDays != null
                  ? <span className="kpj-mono" title={fresh.title}><span className="kpj-exec-lbl">Updated </span>{f.lastUpdateDays <= 0 ? "today" : `${f.lastUpdateDays}d`}{f.lastUpdateDays > 0 && <span className="kpj-exec-lbl"> ago</span>}</span>
                  : <><span className="kpj-dash" aria-hidden="true">—</span><span className="sr-only">No update yet</span></>}
              </div>
            </div>
          );
        })}
        {extraRows}
      </div>
    </div>
  );
}

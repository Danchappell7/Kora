/* ============================================================
   KANBO — the goal panel: one goal, docked beside the page like the
   task panel (≥ 1280px; a sheet on top below that, the whole screen
   on a phone). Everything about the goal lives here: its name and
   identity, owner and quarter, where it stands against its pace line
   (with the status Kanbo would suggest), a chart of its check-ins
   against that line, the check-in composer and history, its key
   results, the work behind it, and its settings. Editing and Delete
   are here too, for whoever may change the goal (lib/goalRules, the
   same rules as the database); everyone else reads it.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, DateChip, Icon, IconButton, Meter, Pill, ProjectTile, Sheet, projectIdentity, projectSpectrum, spectrumColor } from "../primitives";
import { Popover } from "../primitives/Popover";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { KANBO_TODAY, toLocalISO, WORKSPACES } from "../../data/data";
import type { Goal, GoalExtras, GoalLink, GoalLinkKind, GoalPatch, GoalStatus, Project, Role, StatusUpdate, Task, WorkspaceMember } from "../../data/types";
import { goalDescendants, goalTree } from "../views/reportingUtils";
import { DraftInput } from "../project/DraftInput";
import { IdentityFields, IdentityPreview } from "../project/IdentityPicker";
import { checkinsOf, hasWorkBehind, hiddenProjectOf, NEEDS_LINE, projectDot, readGoals, takesCheckins, type GoalRead } from "../../lib/goalFlow";
import { canDeleteGoal, canEditGoal, canHandOverGoal, canMakeCompanyGoal, canPlaceGoal } from "../../lib/goalRules";
import { GOAL_TONE, GoalAdder, GoalCheckins, GoalDetails, GoalLinks, GoalMetaRow, GoalPaceLine, GoalSource, GOAL_STATUS_LABEL, KIND_LABEL, fmtGoalValue, fmtNum, goalTile, linkedOf, numbersLine } from "./GoalParts";
import { GoalSparkline } from "./GoalSparkline";
import "../project/projects.css";
import "./goals.css";

export interface GoalPanelProps {
  goal: Goal;
  /** the goal's workspace's goals that this person can see */
  goals: Goal[];
  /** its workspace's projects (archived ones too: a goal may still read one) */
  projects: Project[];
  /** its workspace's tasks */
  tasks: Task[];
  /** 0052's check-ins and links; null before it's run */
  extras: GoalExtras | null;
  me: string;
  /** their role in the goal's workspace (null in Personal) */
  role: Role | null;
  /** the workspace's active members */
  members: WorkspaceMember[];
  statusUpdates?: StatusUpdate[];
  /** saved views the goal may link */
  views?: { id: string; name: string; emoji?: string | null }[];
  /** a guest: read only */
  readOnly?: boolean;
  /** ≥ 1280px: beside the page, which stays usable */
  docked?: boolean;
  /** open with the check-in composer out (a one-tap check-in) */
  composeFirst?: boolean;
  today?: Date;
  onClose: () => void;
  onOpenGoal: (id: string) => void;
  onOpenGoals?: () => void;
  onOpenTask?: (id: string) => void;
  onOpenProject?: (id: string) => void;
  onOpenView?: (id: string) => void;
  onCreate: (name: string, extra?: GoalPatch) => void;
  onUpdate: (id: string, patch: GoalPatch) => void;
  onDelete: (id: string) => void;
  onCheckin?: (goal: Goal, value: number, confidence: number | null, note: string) => void;
  onDeleteCheckin?: (checkinId: string, goal: Goal) => void;
  onLink?: (goal: Goal, kind: GoalLinkKind, targetId: string) => void;
  onUnlink?: (link: GoalLink) => void;
}

export function GoalPanel(props: GoalPanelProps) {
  const { goal, onClose, docked = false } = props;
  const isMobile = useMediaQuery("(max-width: 859px)");
  const isDocked = docked && !isMobile;
  const trapRef = useFocusTrap<HTMLDivElement>(!isDocked, onClose);
  // docked there's no focus trap to hand focus back: closed, it goes back to whatever opened the
  // panel (a row, a chip), not to the top of the page. (Read while rendering the open: by the
  // time an effect runs, focus may be inside.)
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  const dockedRef = useRef(isDocked); dockedRef.current = isDocked;
  useEffect(() => () => {
    const el = opener.current, now = document.activeElement;
    if (dockedRef.current && el instanceof HTMLElement && el.isConnected && (!now || now === document.body)) el.focus({ preventScroll: true });
  }, []);
  return (
    <>
      {!isDocked && !isMobile && <div className="kgx-scrim" aria-hidden="true" onClick={onClose} />}
      <div ref={trapRef} role="dialog" aria-modal={!isDocked} aria-label={`Goal: ${goal.name}`} tabIndex={-1}
        className="kgx kp" style={projectIdentity(goalTile(goal)).style} data-docked={isDocked || undefined} data-mobile={isMobile || undefined}
        onKeyDown={isDocked ? (e) => {
          // docked there's no focus trap to close it: an Escape nothing inside took closes the panel
          if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
          e.preventDefault(); e.stopPropagation(); onClose();
        } : undefined}>
        <GoalPanelBody key={`${goal.id}${props.composeFirst ? ":checkin" : ""}`} {...props} isMobile={isMobile} />
      </div>
    </>
  );
}

function GoalPanelBody(props: GoalPanelProps & { isMobile: boolean }) {
  const { goal: g, goals, projects, tasks, extras, me, role, members, statusUpdates = [], views, readOnly = false, today = KANBO_TODAY,
    onClose, onOpenGoal, onOpenGoals, onUpdate, onDelete, composeFirst = false, isMobile } = props;
  const v2 = !!extras;
  const who = { me, role };
  const editable = !readOnly && (!v2 || canEditGoal(g, who));
  const canHandOver = !readOnly && v2 && canHandOverGoal(g, who);
  const canAddUnder = !readOnly && v2 && !g.archivedAt && canPlaceGoal(g.workspaceId ?? null, g, who);
  const canTopLevel = !v2 || canMakeCompanyGoal(g.workspaceId ?? null, role);
  const personal = (g.workspaceId ?? null) === null;
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  // (0058: a goal reading its % from a project you can't see has none you can know)
  const hidden = useMemo(() => hiddenProjectOf(projects, WORKSPACES, me), [projects, me]);
  const reads = useMemo(() => readGoals(goals, tasks, today, hidden), [goals, tasks, today, hidden]);
  const read: GoalRead = reads.get(g.id) ?? readGoals([g], tasks, today, hidden).get(g.id)!;
  const prog = read.progress;
  const checkins = useMemo(() => checkinsOf(g.id, extras?.checkins ?? []), [g.id, extras]);
  const links = useMemo(() => (extras?.links ?? []).filter((l) => l.goalId === g.id), [g.id, extras]);
  const parent = g.parentId ? goals.find((x) => x.id === g.parentId) : undefined;
  const children = goals.filter((c) => c.parentId === g.id && c.id !== g.id && !c.archivedAt);
  const linkedProject = linkedOf(g, realProjects);
  const update = (patch: GoalPatch) => onUpdate(g.id, patch);
  const todayIso = toLocalISO(today);
  const overdue = !!g.due && g.due < todayIso && g.status !== "done" && read.pct < 100;
  const meta = GOAL_TONE[g.status] ?? GOAL_TONE.on_track;
  const isAdmin = role === "owner" || role === "admin";
  const ownNumber = prog.source === "manual";
  // with 0052 a goal's own number moves by check-ins only (each one a record of who, when and why)
  const viaCheckins = v2 && !!props.onCheckin;

  const [menuOpen, setMenuOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [addingUnder, setAddingUnder] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // a one-tap check-in lands on the composer
  useEffect(() => {
    if (!composeFirst) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(".kgl-composer");
    el?.scrollIntoView?.({ block: "center" });
  }, [composeFirst]);

  // a goal can't sit under itself or anything nested beneath it (nor, with 0052, under one you can't edit)
  const blocked = goalDescendants(goals, g.id); blocked.add(g.id);
  const ordered = goalTree(goals);
  const parentOptions = ordered.filter((o) => !blocked.has(o.g.id) && !o.g.archivedAt && (o.g.id === g.parentId || !v2 || canPlaceGoal(o.g.workspaceId ?? null, o.g, who)));
  const parentValue = g.parentId && goals.some((x) => x.id === g.parentId) ? g.parentId : "";
  const childCount = goals.filter((x) => x.parentId === g.id && x.id !== g.id).length;
  const numOr0 = (v: string) => { const n = Number(v); return v.trim() === "" || !isFinite(n) ? 0 : n; };
  const numOrNull = (v: string) => (v.trim() === "" || !isFinite(Number(v)) ? null : Number(v));
  const saveNum = (key: "current" | "target", v: string) => {
    const n = numOr0(v);
    if (n !== (g[key] ?? 0)) update(key === "current" ? { current: n } : { target: n });
    return String(n);
  };
  // "From 8 to 5": the numbers say which way is better, so Lower is never left behind a start of 0
  const directionFor = (start: number | null | undefined, target: number | null | undefined): GoalPatch =>
    start == null || target == null || start === target || (start > target ? "lower" : "higher") === (g.direction ?? "higher")
      ? {} : { direction: start > target ? "lower" : "higher" };
  // before its first check-in a goal stands where it started, so its start moves its value with it
  const atStart = !checkins.length && (g.current == null || g.current === (g.startValue ?? 0));
  const saveStart = (v: string) => {
    const n = numOrNull(v);
    if (n !== (g.startValue ?? null)) update({ startValue: n, ...(atStart && n != null ? { current: n } : {}), ...directionFor(n, g.target) });
    return n == null ? "" : String(n);
  };
  const saveTarget = (v: string) => {
    const n = numOrNull(v);
    if (n !== (g.target ?? null) && n != null) update({ target: n, ...directionFor(g.startValue, n) });
    return n == null ? String(g.target ?? "") : String(n);
  };
  const create = (name: string) => {
    const team = !personal;
    props.onCreate(name, { parentId: g.id, kind: "key_result", ...(team ? { ownerId: me } : {}), period: g.period ?? null, periodStart: g.periodStart ?? null, periodEnd: g.periodEnd ?? null });
    setAddingUnder(false);
  };
  // a team goal's key results would become company goals: only owners and admins set those (0052).
  // Before 0052 there are no owners to go by: anyone who writes deletes, as the database allows.
  const deleteBlocked = v2 && !canDeleteGoal(g, childCount, who);
  const remove = () => {
    setMenuOpen(false);
    if (deleteBlocked) return;
    const keep = v2 ? " To keep its check-ins and history, archive it instead." : "";
    const msg = childCount
      ? `Delete goal “${g.name}” and its check-ins? Its ${childCount === 1 ? "key result stays, as a goal" : `${childCount} key results stay, as goals`} of ${childCount === 1 ? "its" : "their"} own. This can't be undone.${keep}`
      : `Delete goal “${g.name}”${v2 ? " and its check-ins" : ""}? This can't be undone.${keep}`;
    if (window.confirm(msg)) { onDelete(g.id); onClose(); }
  };
  const dotOf = (pid: string) => {
    const p = realProjects.find((x) => x.id === pid);
    return p ? projectDot(p, tasks, statusUpdates, today) : null;
  };
  const noWork = v2 && !personal && !hasWorkBehind(g, goals, extras?.links ?? []);
  const expected = read.pace && read.pace.state !== "early" ? read.pace.expected : undefined;
  const meterTone = read.pace?.state === "behind" ? "warn" : read.pace?.state === "late" ? "signal" : read.pace?.state === "done" ? "ok" : "accent";

  return (
    <>
      <div className="kgx-head">
        <nav className="kgx-crumb" aria-label="Where this goal sits">
          {onOpenGoals ? <button type="button" className="kgx-crumb-link" onClick={onOpenGoals}>Goals</button> : <span>Goals</span>}
          {parent && (
            <>
              <Icon name="chevronRight" size={12} sw={2} className="kgx-crumb-sep" />
              <button type="button" className="kgx-crumb-link" onClick={() => onOpenGoal(parent.id)} title={parent.name}>{parent.name}</button>
            </>
          )}
        </nav>
        {editable && (
          <>
            <IconButton ref={menuRef} icon="more" size="sm" label="Goal actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)} />
            <Popover open={menuOpen} anchorRef={menuRef} onClose={() => setMenuOpen(false)} role="menu" label="Goal actions" align="end" minWidth={208}
              className="kpj-pop" style={{ borderRadius: "var(--r-lg, 12px)", border: "none", background: "var(--surface-raised)", boxShadow: "var(--e2, 0 0 0 1px var(--hairline), var(--shadow-lg))", padding: 4 }}>
              {v2 && (
                <button type="button" role="menuitem" className="kpj-menu-item" onClick={() => { setMenuOpen(false); setIdentityOpen(true); }}>
                  <Icon name="palette" size={16} sw={1.75} />Icon and colour…
                </button>
              )}
              {v2 && (
                <button type="button" role="menuitem" className="kpj-menu-item" onClick={() => { setMenuOpen(false); update({ archivedAt: g.archivedAt ? null : new Date().toISOString() }); }}>
                  <Icon name={g.archivedAt ? "undo" : "archive"} size={16} sw={1.75} />{g.archivedAt ? "Restore goal" : "Archive goal"}
                </button>
              )}
              <button type="button" role="menuitem" className="kpj-menu-item kgx-del" data-tone="danger" onClick={remove} disabled={deleteBlocked}
                aria-describedby={deleteBlocked ? "kgx-del-note" : undefined}>
                <Icon name="trash" size={16} sw={1.75} />Delete goal…
              </button>
              {deleteBlocked && <p id="kgx-del-note" className="kgx-menu-note">Its key results would become the business's goals: move them first, or ask an owner or admin.</p>}
            </Popover>
          </>
        )}
        {/* (a sheet on top hands focus here first: never the name, which would raise a phone's keyboard) */}
        <IconButton icon="x" size="sm" label="Close goal" onClick={onClose} data-autofocus="" />
      </div>

      <div className="kgx-body" ref={bodyRef}>
        <div className="kgx-title">
          <ProjectTile project={goalTile(g)} size={44} />
          <div className="kgx-title-text">
            {editable
              ? <DraftInput value={g.name} required multiline label={`Goal name: ${g.name}`} onCommit={(v) => update({ name: v })} className="kpj-name-input kgx-name-input" />
              : <h2 className="kgx-name">{g.name}</h2>}
            {editable ? (
              <DraftInput value={g.description ?? ""} placeholder="Add a description" label={`Description of ${g.name}`} multiline
                onCommit={(v) => update({ description: v })} className="kpj-name-input kpj-goal-desc" />
            ) : g.description ? <p className="kpj-goal-desc-text">{g.description}</p> : null}
          </div>
        </div>
        {v2 && <GoalMetaRow goal={g} members={members} canHandOver={canHandOver} canEdit={editable} today={today} onUpdate={update} />}

        <div className="kgx-status">
          {g.archivedAt && <Pill tone="neutral">Archived</Pill>}
          {editable ? (
            <select className="kpj-field kpj-goal-status" data-size="sm" data-tone={meta.tone} value={g.status}
              onChange={(e) => update({ status: e.target.value as GoalStatus })} aria-label={`Status of ${g.name}`}>
              {(Object.keys(GOAL_TONE) as GoalStatus[]).map((s) => <option key={s} value={s}>{GOAL_STATUS_LABEL[s]}</option>)}
            </select>
          ) : <Pill tone={meta.tone}>{GOAL_STATUS_LABEL[g.status] ?? "On track"}</Pill>}
          {g.due && <DateChip size="sm" label={`Due date for ${g.name}`} value={g.due} tone="plain" readOnly onChange={() => undefined} />}
          {overdue && <Pill tone="signal">Overdue</Pill>}
        </div>
        <GoalPaceLine goal={g} read={read.pace} canEdit={editable} onAccept={(status) => update({ status })} />
        {read.needs && <p className="kgl-pace" data-state="needs"><span className="kgl-pace-line">{NEEDS_LINE[read.needs]}{editable ? " under Settings › Numbers" : ""} to see how it's going.</span></p>}

        <section className="kgx-sec" aria-label="Where it stands">
          <div className="kgx-big">
            {ownNumber
              ? <><span className="kgx-big-num">{unitWord(g.unit) ? fmtNum(g.current ?? g.startValue ?? 0) : fmtGoalValue(g.current ?? g.startValue ?? 0, g.unit)}</span><span className="kgx-big-of">{standsOf(g)}</span></>
              : read.hidden ? <span className="kgx-big-of">Unknown</span>
              : <><span className="kgx-big-num">{read.pct}%</span><span className="kgx-big-of">done</span></>}
          </div>
          {!read.hidden && <div className="kgx-meter">
            <Meter value={read.pct} height={6} tone={meterTone} marker={expected} label={`${g.name} progress`} />
            {/* its own number is above: this % is how far along the way it is ("60% of 80%" is 29% of the way from 52%) */}
            <span className="kpj-mono">{read.pct}%{ownNumber && <span className="kgx-meter-way"> of the way</span>}</span>
          </div>}
          <GoalSource prog={prog} linked={linkedProject} weighted={goals.some((x) => x.parentId === g.id && !x.archivedAt && x.weight != null && x.weight !== 1)} />
          <div style={{ marginTop: 12 }}>
            <GoalSparkline goal={g} checkins={ownNumber ? checkins : []} pct={read.pct} today={today}
              valueLabel={ownNumber && !read.needs ? (unitWord(g.unit) ? fmtNum(g.current ?? g.startValue ?? 0) : fmtGoalValue(g.current ?? g.startValue ?? 0, g.unit)) : undefined} />
          </div>
        </section>

        {v2 && (checkins.length > 0 || (takesCheckins(read) && editable && !!props.onCheckin)) && (
          <section className="kgx-sec" aria-label="Check-ins">
            <h3 className="kgx-h">Check-ins</h3>
            <GoalCheckins goal={g} checkins={checkins} members={members} canEdit={editable} canPost={ownNumber && !!props.onCheckin} today={today} me={me} isAdmin={isAdmin}
              historyOpen composeFirst={composeFirst}
              onPost={(value, confidence, note) => props.onCheckin?.(g, value, confidence, note)}
              onRemove={(c) => props.onDeleteCheckin?.(c.id, g)} />
          </section>
        )}

        {(children.length > 0 || (canAddUnder && g.kind !== "key_result")) && (
          <section className="kgx-sec" aria-label="Key results">
            <h3 className="kgx-h">Key results{children.length > 0 && <span className="kgp-group-n">{children.length}</span>}</h3>
            {children.length > 0 && (
              <ul className="kgx-krs">
                {children.map((c) => {
                  const r = reads.get(c.id);
                  return (
                    <li key={c.id} className="kgx-kr">
                      <ProjectTile project={goalTile(c)} size={20} />
                      <button type="button" className="kgx-kr-name" onClick={() => onOpenGoal(c.id)}>{c.name}</button>
                      <Meter value={r?.pct ?? 0} height={4} width={72} tone={r?.standing === "behind" ? "warn" : "accent"}
                        marker={r?.pace && r.pace.state !== "early" ? r.pace.expected : undefined} label={`${c.name} progress`} />
                      <span className="kgx-kr-pct">{r?.pct ?? 0}%</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {canAddUnder && g.kind !== "key_result" && (addingUnder
              ? <GoalAdder className="kgp-adder" label={`New key result under ${g.name}`} placeholder="Key result, e.g. Cut churn from 8% to 5%" onAdd={create} onCancel={() => setAddingUnder(false)} />
              : <Button size="sm" variant="ghost" icon="plus" onClick={() => setAddingUnder(true)}>Add a key result</Button>)}
          </section>
        )}

        {v2 && (
          <section className="kgx-sec" aria-label="Linked work">
            <h3 className="kgx-h">Linked work</h3>
            <GoalLinks goal={g} links={links} projects={realProjects} tasks={tasks} views={views} canEdit={editable && !!props.onLink} dot={dotOf}
              onLink={(kind, id) => props.onLink?.(g, kind, id)} onUnlink={(l) => props.onUnlink?.(l)}
              onOpen={(kind, id) => (kind === "project" ? props.onOpenProject?.(id) : kind === "task" ? props.onOpenTask?.(id) : props.onOpenView?.(id))} />
            {noWork && (
              <p className="kgx-nowork">
                <Icon name="alert" size={16} sw={1.75} />
                <span>No work behind this. {editable ? "Link the projects and tasks that move it, so everyone can see what's pushing it along." : "Its owner links the projects and tasks that move it."}</span>
              </p>
            )}
          </section>
        )}

        {editable && (
          <section className="kgx-sec" aria-label="Settings">
            <h3 className="kgx-h">Settings</h3>
            <dl className="kgx-fields">
              {ownNumber && viaCheckins && (
                <>
                  <dt>Numbers</dt>
                  <dd>
                    <span className="kpj-goal-nums kgx-nums">
                      <span className="kgx-num-word">From</span>
                      <DraftInput type="number" value={g.startValue ?? ""} placeholder={g.direction === "lower" ? "Where it was" : "0"} label={`Where ${g.name} started`} onCommit={saveStart} className="kpj-field kpj-mono" />
                      <span className="kgx-num-word">to</span>
                      <DraftInput type="number" value={g.target ?? ""} label={`Target for ${g.name}`} onCommit={saveTarget} className="kpj-field kpj-mono" />
                      <DraftInput value={g.unit ?? ""} placeholder="unit" label={`Unit for ${g.name}`} onCommit={(v) => update({ unit: v })} className="kpj-field" />
                    </span>
                    <span className="kgx-num-note">Check-ins move where it stands.</span>
                  </dd>
                </>
              )}
              {ownNumber && !viaCheckins && (
                <>
                  <dt>Numbers</dt>
                  <dd>
                    <span className="kpj-goal-nums">
                      <DraftInput type="number" value={g.current ?? 0} label={`Current value for ${g.name}`} onCommit={(v) => saveNum("current", v)} className="kpj-field kpj-mono" />
                      <span className="kpj-slash" aria-hidden="true">/</span>
                      <DraftInput type="number" value={g.target ?? 0} label={`Target for ${g.name}`} onCommit={(v) => saveNum("target", v)} className="kpj-field kpj-mono" />
                      <DraftInput value={g.unit ?? ""} placeholder="unit" label={`Unit for ${g.name}`} onCommit={(v) => update({ unit: v })} className="kpj-field" />
                    </span>
                  </dd>
                </>
              )}
              <dt>Progress from</dt>
              <dd>
                <select className="kpj-field" data-size="sm" value={g.projectId ?? ""} onChange={(e) => update({ projectId: e.target.value || undefined })} aria-label={`Project linked to ${g.name}`}>
                  <option value="">{children.length ? "Its key results, or its own number" : "Its own number"}</option>
                  {g.projectId && !realProjects.some((p) => p.id === g.projectId) && <option value={g.projectId}>↪ {linkedProject?.name ?? "Archived project"}</option>}
                  {realProjects.filter((p) => !p.archivedAt || p.id === g.projectId).map((p) => <option key={p.id} value={p.id}>↪ {p.name}</option>)}
                </select>
              </dd>
              {goals.length > 1 && (parentOptions.length > 0 || parentValue) && (
                <>
                  <dt>Under</dt>
                  <dd>
                    <select className="kpj-field" data-size="sm" value={parentValue} onChange={(e) => update({ parentId: e.target.value || undefined })} aria-label={`Parent goal of ${g.name}`}>
                      {(canTopLevel || !parentValue) && <option value="">Nothing: a top-level goal</option>}
                      {parentOptions.map((o) => <option key={o.g.id} value={o.g.id}>{"  ".repeat(o.depth)}{o.g.name}</option>)}
                    </select>
                  </dd>
                </>
              )}
              <dt>Due</dt>
              <dd>
                <DateChip size="sm" label={`Due date for ${g.name}`} value={g.due} placeholder="Add a due date" tone="plain" onChange={(d) => update({ due: d || undefined })} />
              </dd>
            </dl>
            {v2 && <GoalDetails goal={g} members={members} canEdit={editable} canHandOver={canHandOver} startInNumbers={ownNumber && viaCheckins} onUpdate={update} />}
          </section>
        )}
        {!editable && ownNumber && (g.target ?? 0) !== 0 && <p className="kgx-source">{numbersLine(g)}{g.kind && g.kind !== "objective" ? ` · ${KIND_LABEL[g.kind]}` : ""}</p>}
        {isMobile && <div style={{ height: 8 }} />}
      </div>
      {identityOpen && <GoalIdentitySheet goal={g} onClose={() => { setIdentityOpen(false); menuRef.current?.focus(); }} onSave={(icon, color) => update({ icon: icon || null, color })} />}
    </>
  );
}

/** a unit that's a word ("users"), not a sign ("%", "£m") */
const unitWord = (unit?: string) => !!unit && !/^[£$€%]/.test(unit);
/** after the big number: "users of 5,000 · from 3,200" · "down to 5% · from 8%" */
function standsOf(g: Goal): string {
  const word = unitWord(g.unit);
  const v = (n: number | null | undefined) => (word ? fmtNum(n) : fmtGoalValue(n, g.unit));
  const to = `${word ? `${g.unit} ` : ""}${g.direction === "lower" ? "down to" : "of"} ${v(g.target)}`;
  return g.startValue != null && g.startValue !== 0 ? `${to} · from ${v(g.startValue)}` : to;
}

/** A goal's icon and colour, as a project's are chosen (the same pickers and the same twelve hues). */
function GoalIdentitySheet({ goal, onClose, onSave }: { goal: Goal; onClose: () => void; onSave: (icon: string, color: string) => void }) {
  const [icon, setIcon] = useState(goal.icon ?? "");
  // the colour it wears now (its own, else the hue its id picks), snapped to the spectrum
  const [color, setColor] = useState(() => spectrumColor(projectSpectrum(goalTile(goal)).key));
  const saveRef = useRef<HTMLButtonElement>(null);
  const changed = icon !== (goal.icon ?? "") || projectSpectrum({ id: goal.id, color }).key !== projectSpectrum(goalTile(goal)).key;
  return (
    <Sheet open onClose={onClose} label={`Icon and colour of ${goal.name}`} title="Icon and colour" width={520} initialFocus={saveRef}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button ref={saveRef} variant="primary" disabled={!changed} onClick={() => { onSave(icon, color); onClose(); }}>Save</Button>
        </>
      )}>
      <div className="kpj-dialog">
        <IdentityPreview name={goal.name} emoji={icon} color={color}>
          <span className="kpj-idp-name">{goal.name}</span>
        </IdentityPreview>
        <IdentityFields name={goal.name} emoji={icon} color={color} onEmoji={setIcon} onColor={setColor} />
      </div>
    </Sheet>
  );
}

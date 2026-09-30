/* ============================================================
   KANBO — Projects › All: the workspace's project directory.
   One row per project: its status, progress, owner, open and
   overdue work, next milestone, how fresh its last update is, and
   Kanbo's one-line read. Draft or post an update from the row.
   Phones (and narrow columns) get one card per project.
   ============================================================ */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { AiMark, Avatar, Button, EmptyState, Icon, Meter, Pill, ProjectDot, Segmented } from "../primitives";
import { Popover } from "../primitives/Popover";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { getMember, KANBO_TODAY } from "../../data/data";
import type { Task, Project, StatusUpdate, StatusKind } from "../../data/types";
import type { AiOutcome } from "../../lib/askTypes";
import { pathOf } from "../../lib/nav";
import { fmtAge, fmtShortDay, isStale, kanbosRead, oldestTaskAge, statusFacts, type StatusFacts } from "../../lib/statusDraft";
import { projectStatusPill } from "../project/ProjectHeader";
import { ComposerPopover, useStatusComposer, type AiStatus, type PostStatus } from "../project/StatusComposer";
import "../project/projects.css";

type Scope = "all" | "mine" | "risk";
type SortKey = "status" | "name" | "progress" | "update";
type Col = "name" | "status" | "progress" | "owner" | "open" | "overdue" | "milestone" | "update" | "risks";

const SORTS: { id: SortKey; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "name", label: "Name" },
  { id: "progress", label: "Progress" },
  { id: "update", label: "Last update" },
];
const SCOPES: { value: Scope; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "risk", label: "At risk" },
];
const COL_W: Record<Col, string> = {
  name: "minmax(180px, 1fr)", status: "88px", progress: "104px", owner: "44px", open: "44px",
  overdue: "60px", milestone: "minmax(112px, 176px)", update: "96px", risks: "44px",
};
const COL_LABEL: Record<Col, string> = {
  name: "Project", status: "Status", progress: "Progress", owner: "Owner", open: "Open",
  overdue: "Overdue", milestone: "Next milestone", update: "Last update", risks: "Risks",
};
const NUMERIC = new Set<Col>(["open", "overdue", "update", "risks"]);
const TONE_RANK = { signal: 0, warn: 1, neutral: 2, accent: 3, ok: 4 } as const;

/** The columns that fit: everything from 1040px; then Owner and Open go, then the milestone. */
export function directoryColumns(width: number, withRisks: boolean): Col[] {
  const all: Col[] = ["name", "status", "progress", "owner", "open", "overdue", "milestone", "update"];
  if (withRisks) all.push("risks");
  if (!width || width >= 1040) return all;
  if (width >= 860) return all.filter((c) => c !== "owner" && c !== "open");
  return all.filter((c) => c !== "owner" && c !== "open" && c !== "milestone");
}

const readPref = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try { const v = localStorage.getItem(key) as T | null; return v && allowed.includes(v) ? v : fallback; } catch { return fallback; }
};
const writePref = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* private mode */ } };

interface Row {
  p: Project;
  facts: StatusFacts;
  pill: ReturnType<typeof projectStatusPill>;
  read: string;
  stale: boolean;
  risks: number;
  mine: boolean;
  atRisk: boolean;
}

export function ProjectsView({ projects, tasks, statusUpdates, members: _members, currentUserId, canCreate, onOpenProject, onNewProject, onPostUpdate, aiStatus, risksByProject }: {
  projects: Project[];
  tasks: Task[];
  statusUpdates: StatusUpdate[];
  members: { id: string; name: string }[];
  currentUserId: string;
  canCreate: boolean;
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
  onPostUpdate?: (projectId: string, summary: string, status: StatusKind) => Promise<boolean> | void;
  aiStatus?: (facts: unknown) => Promise<AiOutcome<{ summary: string; status: StatusKind }>>;
  risksByProject?: Record<string, number>;
}) {
  const phone = useMediaQuery("(max-width: 859px)");
  const [query, setQuery] = useState("");
  const [scope, setScopeRaw] = useState<Scope>(() => readPref("kanbo-projects-scope", ["all", "mine", "risk"] as const, "all"));
  const [sort, setSortRaw] = useState<SortKey>(() => readPref("kanbo-projects-sort", ["status", "name", "progress", "update"] as const, "status"));
  const setScope = (s: Scope) => { setScopeRaw(s); writePref("kanbo-projects-scope", s); };
  const setSort = (s: SortKey) => { setSortRaw(s); writePref("kanbo-projects-sort", s); };
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLButtonElement>(null);

  // measure the column the table sits in (the sidebar and a docked task panel both take room)
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [projects.length === 0]);

  const rows: Row[] = useMemo(() => projects.map((p) => {
    const facts = statusFacts(p, tasks, statusUpdates, KANBO_TODAY);
    const pill = projectStatusPill(p, facts.latest);
    const risks = risksByProject?.[p.id] ?? 0;
    const mine = p.ownerId === currentUserId || (p.contributorIds ?? []).includes(currentUserId)
      || tasks.some((t) => t.projectId === p.id && t.assigneeId === currentUserId && t.status !== "done" && !t.archivedAt);
    const atRisk = pill.tone === "warn" || pill.tone === "signal" || facts.health === "at_risk" || facts.health === "off_track" || risks > 0;
    return { p, facts, pill, read: kanbosRead(facts, { withUpdate: false }), stale: isStale(facts, oldestTaskAge(tasks, p.id, KANBO_TODAY)), risks, mine, atRisk };
  }), [projects, tasks, statusUpdates, risksByProject, currentUserId]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter((r) => (!q || r.p.name.toLowerCase().includes(q))
      && (scope === "all" || (scope === "mine" ? r.mine : r.atRisk)));
    const byName = (a: Row, b: Row) => a.p.name.localeCompare(b.p.name, "en-GB", { sensitivity: "base" });
    const cmp: Record<SortKey, (a: Row, b: Row) => number> = {
      name: byName,
      status: (a, b) => TONE_RANK[a.pill.tone] - TONE_RANK[b.pill.tone] || Number(b.stale) - Number(a.stale) || byName(a, b),
      progress: (a, b) => b.facts.pct - a.facts.pct || byName(a, b),
      update: (a, b) => (a.facts.lastUpdateDays ?? Infinity) - (b.facts.lastUpdateDays ?? Infinity) || byName(a, b),
    };
    return [...list].sort(cmp[sort]);
  }, [rows, query, scope, sort]);

  // the composer: one at a time, anchored to the row button that opened it
  const canPost = !!onPostUpdate;
  const anchorRef = useRef<HTMLElement | null>(null);
  const [composer, setComposer] = useState<{ id: string; open: boolean; mode: "draft" | "post"; seq: number } | null>(null);
  const openComposer = (e: ReactMouseEvent<HTMLElement>, id: string, mode: "draft" | "post") => {
    e.stopPropagation();
    anchorRef.current = e.currentTarget;
    setComposer((c) => ({ id, open: true, mode, seq: (c?.seq ?? 0) + 1 }));
  };
  const composerProject = composer ? projects.find((p) => p.id === composer.id) : undefined;

  const openRow = (id: string) => {
    if (typeof window !== "undefined" && window.getSelection?.()?.toString()) return; // selecting text isn't a click
    onOpenProject(id);
  };
  const onLink = (e: ReactMouseEvent<HTMLAnchorElement>, id: string) => {
    e.stopPropagation();
    // a modified or middle click opens the project in a new tab, as a link should
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpenProject(id);
  };

  if (projects.length === 0) {
    return (
      <div className="kpj-page">
        <div className="kpj-wrap">
          <EmptyState art="layers" size="lg" title="No projects yet"
            body={canCreate ? "Projects keep a piece of work's tasks, updates and people together." : "When your team starts a project, you'll find it here."}
            action={canCreate ? <Button variant="primary" icon="plus" onClick={onNewProject}>New project</Button> : undefined} />
        </div>
      </div>
    );
  }

  const cards = phone || (width > 0 && width < 700);
  const cols = directoryColumns(width, !!risksByProject);
  const template = cols.map((c) => COL_W[c]).join(" ");
  const sortLabel = SORTS.find((s) => s.id === sort)!.label;
  const reset = () => { setQuery(""); setScope("all"); };

  const rowActions = (r: Row) => canPost ? (
    <div className="kpj-rowacts" data-open={composer?.open && composer.id === r.p.id ? "true" : undefined} onClick={(e) => e.stopPropagation()}>
      <Button variant="ghost" size="sm" aria-label={`Draft an update on ${r.p.name}`} aria-haspopup="dialog" onClick={(e) => openComposer(e, r.p.id, "draft")}>
        <span className="kpj-btn-mark"><AiMark size={14} />Draft update</span>
      </Button>
      <Button variant="secondary" size="sm" aria-label={`Post an update on ${r.p.name}`} aria-haspopup="dialog" onClick={(e) => openComposer(e, r.p.id, "post")}>Post update</Button>
    </div>
  ) : null;

  const cell = (c: Col, r: Row): ReactNode => {
    const f = r.facts;
    switch (c) {
      case "name": return (
        <div className="kpj-proj">
          <ProjectDot color={r.p.color} size={10} />
          <a href={pathOf({ view: "project", projectId: r.p.id })} className="kpj-proj-name" onClick={(e) => onLink(e, r.p.id)}>
            {r.p.emoji && <span className="kpj-emoji" aria-hidden="true">{r.p.emoji}</span>}{r.p.name}
          </a>
          <span className="kpj-read" title={r.read}><span className="sr-only">Kanbo's read: </span>{r.read}</span>
        </div>
      );
      case "status": return <Pill tone={r.pill.tone} title={r.pill.title}>{r.pill.label}</Pill>;
      case "progress": return (
        <span className="kpj-progress">
          <Meter value={f.pct} width={56} height={4} label={`${r.p.name} progress`} />
          <span className="kpj-mono" aria-hidden="true">{f.pct}%</span>
        </span>
      );
      case "owner": return r.p.ownerId && getMember(r.p.ownerId) ? <Avatar id={r.p.ownerId} size={24} /> : <span className="kpj-dash" aria-label="No owner">—</span>;
      case "open": return f.open;
      case "overdue": return <span className={f.overdue.length ? "kpj-signal" : "kpj-muted"}>{f.overdue.length}</span>;
      case "milestone": return f.nextMilestone ? (
        <span className="kpj-ms">
          <span className="kpj-ms-title" title={f.nextMilestone.title}>{f.nextMilestone.title}</span>
          <span className="kpj-ms-date">{fmtShortDay(f.nextMilestone.dueDate, KANBO_TODAY)}</span>
        </span>
      ) : <span className="kpj-dash" aria-label="None">—</span>;
      case "update": return <UpdateAge facts={f} stale={r.stale} />;
      case "risks": return r.risks ? <span className="kpj-signal">{r.risks}</span> : <span className="kpj-dash" aria-label="None">—</span>;
    }
  };

  return (
    <div className="kpj-page">
      <div className="kpj-wrap" ref={wrapRef}>
        <div className="kpj-toolbar">
          <label className="kpj-search">
            <Icon name="search" size={16} sw={1.75} />
            <input className="kpj-field" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
              placeholder="Filter projects" aria-label="Filter projects" autoComplete="off" spellCheck={false} />
          </label>
          <Segmented ariaLabel="Show" options={SCOPES} value={scope} onChange={setScope} />
          <span className="kpj-spacer" />
          <span className="kpj-count" aria-live="polite">
            {shown.length === projects.length ? `${projects.length} ${projects.length === 1 ? "project" : "projects"}` : `${shown.length} of ${projects.length}`}
          </span>
          <Button ref={sortRef} variant="ghost" size="sm" icon="sort" iconRight="chevronDown" aria-haspopup="menu" aria-expanded={sortOpen}
            aria-label={`Sort projects: ${sortLabel}`} onClick={() => setSortOpen((v) => !v)}>{sortLabel}</Button>
          <Popover open={sortOpen} anchorRef={sortRef} onClose={() => setSortOpen(false)} role="menu" label="Sort projects by" align="end" minWidth={180}
            className="kpj-pop" style={{ padding: 4, borderRadius: "var(--r-lg, 12px)", boxShadow: "var(--e2, var(--shadow-lg))", background: "var(--surface-raised)" }}>
            {SORTS.map((s) => (
              <button key={s.id} type="button" role="menuitemradio" aria-checked={sort === s.id} className="kpj-menu-item"
                onClick={() => { setSort(s.id); setSortOpen(false); }}>
                {s.label}{sort === s.id && <Icon name="check" size={16} sw={1.75} className="kpj-menu-check" />}
              </button>
            ))}
          </Popover>
        </div>

        {shown.length === 0 ? (
          <EmptyState size="sm" art={scope === "risk" && !query ? "target" : "search"}
            title={query ? "No projects match" : scope === "risk" ? "Nothing's at risk" : "None of these are yours yet"}
            body={query ? `Nothing here is called “${query.trim()}”.` : scope === "risk" ? "Every project is on track, with nothing overdue or blocked." : "Projects you own, help with or have open tasks in show up here."}
            action={<Button variant="ghost" size="sm" onClick={reset}>Show all projects</Button>} />
        ) : cards ? (
          <ul className="kpj-cards" aria-label="Projects">
            {shown.map((r) => (
              <li key={r.p.id}>
                <a href={pathOf({ view: "project", projectId: r.p.id })} className="kpj-pcard" onClick={(e) => onLink(e, r.p.id)}>
                  <span className="kpj-pcard-name">
                    <ProjectDot color={r.p.color} size={10} />
                    <span>{r.p.emoji && <span className="kpj-emoji" aria-hidden="true">{r.p.emoji}</span>}{r.p.name}</span>
                  </span>
                  <Pill tone={r.pill.tone} title={r.pill.title}>{r.pill.label}</Pill>
                  <span className="kpj-pcard-bar">
                    <Meter value={r.facts.pct} height={4} label={`${r.p.name} progress`} />
                    <span className="kpj-mono" aria-hidden="true">{r.facts.pct}%</span>
                  </span>
                  <span className="kpj-pcard-meta">
                    {r.facts.open} open
                    {r.facts.overdue.length > 0 && <> · <span className="kpj-signal">{r.facts.overdue.length} overdue</span></>}
                    {" · "}<UpdateAge facts={r.facts} stale={r.stale} long />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div role="table" aria-label="Projects" aria-rowcount={shown.length + 1} className="kpj-table">
            <div role="rowgroup" className="kpj-thead">
              <div role="row" className="kpj-tr" style={{ gridTemplateColumns: template }}>
                {cols.map((c) => (
                  <span key={c} role="columnheader" className={`kpj-th${NUMERIC.has(c) ? " kpj-num" : ""}`}>{COL_LABEL[c]}</span>
                ))}
              </div>
            </div>
            <div role="rowgroup" className="kpj-tbody">
              {shown.map((r) => (
                <div key={r.p.id} role="row" className="kpj-tr" style={{ gridTemplateColumns: template }} onClick={() => openRow(r.p.id)}>
                  {cols.map((c, i) => (
                    <div key={c} role="cell" className={`kpj-td${NUMERIC.has(c) ? " kpj-num" : ""}`}>
                      {cell(c, r)}
                      {i === cols.length - 1 && rowActions(r)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {composer && composerProject && (
        <RowComposer project={composerProject} tasks={tasks} statusUpdates={statusUpdates} onPost={onPostUpdate} aiStatus={aiStatus}
          request={composer} anchorRef={anchorRef} onClose={() => setComposer((c) => (c ? { ...c, open: false } : c))} />
      )}
    </div>
  );
}

/** "2d" · "today" · "16d · stale" (warn) · "none · stale" (warn); `long` reads as a sentence for cards. */
function UpdateAge({ facts, stale, long }: { facts: StatusFacts; stale: boolean; long?: boolean }) {
  const d = facts.lastUpdateDays;
  if (d == null) {
    return stale
      ? <span className="kpj-warn" title="No status update posted yet">{long ? "No update yet" : "none · stale"}</span>
      : <span className="kpj-muted" title="No status update posted yet">{long ? "No update yet" : "none"}</span>;
  }
  const age = fmtAge(d);
  const text = long ? (d === 0 ? "Updated today" : `Updated ${age} ago`) : age;
  return stale
    ? <span className="kpj-warn" title={`Last update ${d} days ago: stale after 14 days`}>{text} · stale</span>
    : <span title={d === 0 ? "Last update today" : `Last update ${d} ${d === 1 ? "day" : "days"} ago`}>{text}</span>;
}

/** The directory's composer. It stays mounted once opened, so each project's draft survives a close. */
function RowComposer({ project, tasks, statusUpdates, onPost, aiStatus, request, anchorRef, onClose }: {
  project: Project;
  tasks: Task[];
  statusUpdates: StatusUpdate[];
  onPost?: PostStatus;
  aiStatus?: AiStatus;
  request: { id: string; open: boolean; mode: "draft" | "post"; seq: number };
  anchorRef: React.RefObject<HTMLElement>;
  onClose: () => void;
}) {
  const c = useStatusComposer({ project, tasks, statusUpdates, onPost, aiStatus, onPosted: onClose });
  useEffect(() => {
    if (request.open && request.mode === "draft" && !c.text.trim() && !c.drafting) c.draft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.seq]);
  return <ComposerPopover open={request.open} anchorRef={anchorRef} onClose={onClose} c={c} />;
}

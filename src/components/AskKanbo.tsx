/* ============================================================
   KANBO — Ask Kanbo: the answer card inside the ⌘K palette.
   The answer, how Kanbo got there, exactly what would change (old
   struck through → new), what that knocks on, and one Apply. Nothing
   changes until Apply; Edit leaves rows out; "Keep it" drops one.
   Model-written answers sit on vellum; on-device answers don't
   (vellum is only ever for the model's own words).
   ============================================================ */
import { forwardRef, useImperativeHandle, useMemo, useState, type ReactNode } from "react";
import { AiMark, Button, Check, Icon, Kbd, Pill, Provenance, StatusGlyph, Vellum } from "./primitives";
import { GO_TARGETS, titleOf } from "../lib/nav";
import { validateActions, diffRows, headsUps, fmtDay, GUEST_REASON, type DiffRow } from "../lib/askActions";
import type { AskAction, AskContext, AskResult } from "../lib/askTypes";
import type { Route } from "../app-types";
import type { Task } from "../data/types";

/** Why an answer came from where it did. */
export type AskVia = "ai" | "off" | "unavailable" | "limit";

export interface AskView {
  question: string;
  phase: "loading" | "done";
  /** the tasks the question was asked about (what Kanbo read) */
  sent: Task[];
  result?: AskResult;
  via?: AskVia;
  /** the daily AI limit, when `via` is "limit" */
  limit?: number;
}

export interface AskKanboHandle {
  /** Enter in the palette: apply the included changes, else follow the
   *  first "open". False when there's nothing to do. */
  submit: () => boolean;
}

const ASK_CSS = `
.kask { padding: 0 0 4px; font-family: var(--font-ui, var(--font-display)); }
.kask-head { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kask-head-count { margin-left: auto; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
/* loading: the card's shape, quietly, while Kanbo reads (no shimmer: only the mark moves) */
.kask-reading { display: flex; align-items: center; gap: 10px; margin: 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kask-skel { display: grid; gap: 10px; margin-top: 16px; }
.kask-skel span { display: block; height: 10px; border-radius: var(--r-sm, 6px); background: var(--fill-2); }
.kask-skel span:nth-child(1) { width: 92%; }
.kask-skel span:nth-child(2) { width: 64%; }
.kask-skel span:nth-child(3) { width: 100%; height: 36px; margin-top: 6px; border-radius: var(--r-md, 8px); background: var(--fill-1); }
.kask-card { position: relative; margin: 0 4px; padding: 16px 20px 18px; border-radius: var(--r-lg, 12px);
  background: var(--bg); border: 1px solid var(--hairline); }
.kask .kvellum { margin: 0 4px; padding: 16px 20px 18px; }
.kask-answer { margin: 0; font: 400 15px/24px var(--font-ui, var(--font-display)); color: var(--ink); text-wrap: pretty; white-space: pre-line; }
.kask .kprov { margin-top: 8px; }

/* the diff: what would change, old → new */
.kask-diff { list-style: none; margin: 16px 0 0; padding: 0; border-radius: var(--r-md, 8px); border: 1px solid var(--hairline);
  background: var(--surface-raised); overflow: hidden; }
.kask .kvellum .kask-diff { background: var(--bg); }
.kask-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; column-gap: 10px; align-items: start; padding: 0 12px; border-top: 1px solid var(--hairline); }
.kask-row :is(.kask-glyph, .kask-title, .kask-changes) { transition: opacity var(--d-1, 90ms) var(--ease); }
.kask-row:first-child { border-top: 0; }
.kask-row[data-out="true"] :is(.kask-glyph, .kask-title, .kask-changes) { opacity: 0.5; }
.kask-row[data-out="true"] .kask-title, .kask-row[data-out="true"] .kask-new { text-decoration: line-through; text-decoration-color: var(--ink-4); }
.kask-lead { display: flex; align-items: center; gap: 10px; height: 36px; }
.kask-glyph { display: inline-flex; }
.kask-lead .kcheck { margin-right: 2px; }
.kask-title { min-width: 0; height: 36px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 500 13px/36px var(--font-ui, var(--font-display)); color: var(--ink); }
.kask-title .kpill { margin-left: 8px; vertical-align: 1px; }
.kask-changes { display: grid; }
.kask-change { display: grid; grid-template-columns: 64px 104px 14px 104px; column-gap: 8px; align-items: center; height: 36px; }
.kask-field { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); white-space: nowrap; }
.kask-old, .kask-new { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 12px/16px var(--font-ui, var(--font-display)); }
.kask-old { text-align: right; color: var(--ink-3); text-decoration: line-through; text-decoration-color: var(--ink-4); font-weight: 500; }
.kask-new { color: var(--accent-text, var(--accent)); }
.kask-old[data-mono="true"], .kask-new[data-mono="true"] { font-family: var(--font-mono); font-size: 11px; font-variant-numeric: tabular-nums; }
.kask-arrow { color: var(--icon-quiet, var(--ink-4)); }
.kask-change[data-new="true"] .kask-old, .kask-change[data-new="true"] .kask-arrow { visibility: hidden; }

/* heads-ups */
.kask-heads { list-style: none; display: grid; gap: 8px; margin: 10px 0 0; padding: 0; }
.kask-heads li { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 6px 6px 12px; border-radius: var(--r-md, 8px);
  border: 1px solid var(--hairline); background: var(--surface-raised); }
.kask .kvellum .kask-heads li { background: var(--bg); }
.kask-warn { flex-shrink: 0; color: var(--warn, var(--st-review)); }
.kask-heads p { flex: 1; min-width: 0; margin: 0; font: 500 12px/18px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kask-heads b { font-weight: 600; color: var(--ink); }

/* footer */
.kask-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; }
.kask-undo { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kask-undo svg { color: var(--icon-quiet, var(--ink-4)); }
.kask-undo-key { display: inline-flex; align-items: center; gap: 6px; }

/* answer-only: the tasks it's about, one click away */
.kask-cites { list-style: none; display: grid; gap: 2px; margin: 14px -8px 0; padding: 0; }
.kask-cite { display: flex; align-items: center; gap: 10px; width: 100%; height: 36px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; color: var(--ink); text-align: left; cursor: pointer; font: 500 13px/20px var(--font-ui, var(--font-display));
  transition: background var(--d-1, 90ms) var(--ease); }
.kask-cite:hover { background: var(--fill-1); }
.kask-cite-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kask-cite-meta { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kask-cite-meta[data-tone="overdue"] { color: var(--signal, var(--st-blocked)); }
.kask-cite-go { flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); opacity: 0;
  transition: opacity var(--d-1, 90ms) var(--ease); }
.kask-cite:hover .kask-cite-go, .kask-cite:focus-visible .kask-cite-go { opacity: 1; color: var(--accent-text, var(--accent)); }
.kask-more { margin: 4px 0 0; padding-left: 8px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }

/* notes under the card */
.kask-notes { display: grid; gap: 4px; margin: 10px 4px 0; padding: 0 4px; }
.kask-note { margin: 0; display: flex; align-items: flex-start; gap: 6px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kask-note svg { flex-shrink: 0; margin-top: 1px; color: var(--icon-quiet, var(--ink-4)); }

@media (max-width: 639px) {
  .kask-card, .kask .kvellum { padding: 14px 14px 16px; }
  .kask-row { grid-template-columns: auto minmax(0, 1fr); }
  .kask-changes { grid-column: 2 / -1; padding-bottom: 8px; }
  .kask-change { grid-template-columns: 48px auto 14px auto; justify-content: start; height: 24px; }
  .kask-old { text-align: left; }
  .kask-foot .kask-undo { margin-left: 0; flex-basis: 100%; }
  .kask-cite-go { display: none; }
}
@media (hover: none) { .kask-cite-go { opacity: 1; } }
/* no keyboard to press them with */
@media (hover: none) and (pointer: coarse) { .kask .kkbd, .kask-undo-key { display: none; } }
`;

/** A small warning triangle (heads-ups). */
function WarnGlyph() {
  return (
    <svg className="kask-warn" width={16} height={16} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9 1.8 18.2a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

const sameRoute = (a: Route, b: Route) => a.view === b.view && (a.tab ?? "") === (b.tab ?? "") && (a.list ?? "") === (b.list ?? "") && (a.projectId ?? "") === (b.projectId ?? "");
/** "Today", "My tasks › Overdue", or a project's name. */
function routeLabel(route: Route, ctx: AskContext): string {
  if (route.view === "project") return ctx.projects.find((p) => p.id === route.projectId)?.name ?? "the project";
  const target = GO_TARGETS.find((g) => sameRoute(g.route, route));
  const place = titleOf(route);
  if (!target) return place;
  return target.label === place ? place : `${place} › ${target.label}`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const AskKanbo = forwardRef<AskKanboHandle, {
  view: AskView;
  ctx: AskContext;
  /** may this person change tasks here (and can the app apply them)? */
  canAct: boolean;
  /** a guest: explain why nothing can change */
  guest?: boolean;
  onApply?: (actions: AskAction[]) => void;
  onOpenTask?: (id: string) => void;
  onGo?: (route: Route) => void;
}>(function AskKanbo({ view, ctx, canAct, guest, onApply, onOpenTask, onGo }, ref) {
  const { result, sent } = view;
  const byId = useMemo(() => new Map(sent.map((t) => [t.id, t])), [sent]);
  const { valid, rejected } = useMemo(
    () => (result ? validateActions(result.actions, sent, ctx, canAct && !!onApply) : { valid: [], rejected: [] }),
    [result, sent, ctx, canAct, onApply],
  );
  const rows = useMemo(() => diffRows(valid, byId, ctx), [valid, byId, ctx]);
  const heads = useMemo(() => headsUps(valid, sent, ctx.me, ctx.members), [valid, sent, ctx]);
  const opens = valid.filter((a): a is Extract<AskAction, { op: "open" }> => a.op === "open");
  const [excluded, setExcluded] = useState<Set<number>>(() => new Set());
  const [editing, setEditing] = useState(false);
  const included = rows.filter((r) => !excluded.has(r.index));
  const selected = included.map((r) => valid[r.index]);

  const follow = (a: Extract<AskAction, { op: "open" }>) => {
    if (a.taskId) onOpenTask?.(a.taskId);
    else if (a.route) onGo?.(a.route);
  };
  const apply = () => { if (selected.length && onApply) onApply(selected); };
  useImperativeHandle(ref, () => ({
    submit: () => {
      if (view.phase !== "done") return false;
      if (rows.length) { if (!selected.length || !onApply) return false; apply(); return true; }
      if (opens.length) { follow(opens[0]); return true; }
      return false;
    },
  }));

  const toggle = (i: number) => setExcluded((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const leaveOut = (indices: number[]) => setExcluded((s) => new Set([...s, ...indices]));

  if (view.phase === "loading" || !result) {
    const n = sent.length;
    return (
      <div className="kask" aria-busy="true">
        <style>{ASK_CSS}</style>
        <div className="kask-head"><AiMark size={14} />Ask Kanbo</div>
        <div className="kask-card">
          <p className="kask-reading"><AiMark size={16} thinking />Kanbo is reading {n} {plural(n, "task", "tasks")}…</p>
          <div className="kask-skel" aria-hidden="true"><span /><span /><span /></div>
        </div>
      </div>
    );
  }

  const cites = (result.cites ?? []).map((id) => byId.get(id)).filter((t): t is Task => !!t);
  const provenance = {
    summary: `from ${cites.length || sent.length} ${plural(cites.length || sent.length, "task", "tasks")}`,
    details: cites.length ? [...cites.slice(0, 12).map((t) => t.title), ...(cites.length > 12 ? [`and ${cites.length - 12} more`] : [])] : undefined,
  };
  const proposed = result.actions.some((a) => a?.op === "update" || a?.op === "create");   // raw, before validation
  const leftOut = [...new Set(rejected.filter((r) => r.reason !== GUEST_REASON && r.reason !== "Nothing would change").map((r) => r.reason))];
  const leftOutCount = rejected.filter((r) => r.reason !== GUEST_REASON && r.reason !== "Nothing would change").length;
  const shownRows = editing ? rows : rows.filter((r) => !excluded.has(r.index));
  const shownHeads = heads.filter((h) => !h.indices.every((i) => excluded.has(i)));
  const n = selected.length;
  const today = ctx.today;

  const body: ReactNode = (
    <>
      <p className="kask-answer">{result.answer}</p>
      <Provenance summary={provenance.summary} details={provenance.details} />

      {rows.length > 0 && (
        <ul className="kask-diff" aria-label="Proposed changes">
          {shownRows.map((row) => <DiffLine key={row.index} row={row} editing={editing} out={excluded.has(row.index)} onToggle={() => toggle(row.index)} />)}
        </ul>
      )}

      {rows.length > 0 && shownHeads.length > 0 && (
        <ul className="kask-heads" aria-label="Heads-up">
          {shownHeads.map((h) => (
            <li key={h.id}>
              <WarnGlyph />
              <p><b>{h.lead}</b> {h.text}</p>
              <Button size="sm" variant="secondary" aria-label={`${h.keep}: ${h.lead}`} onClick={() => leaveOut(h.indices)}>{h.keep}</Button>
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 ? (
        <div className="kask-foot">
          <Button variant="hero" kbd="⏎" disabled={!n} onClick={apply}>
            {n ? `Apply ${n} ${plural(n, "change", "changes")}` : "Nothing to apply"}
          </Button>
          <Button variant="secondary" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>{editing ? "Done" : "Edit"}</Button>
          <span className="kask-undo"><Icon name="clock" size={14} sw={1.75} />You can undo for 10 seconds<span className="kask-undo-key">· <Kbd>⌘Z</Kbd></span></span>
        </div>
      ) : opens.length > 0 ? (
        <div className="kask-foot">
          {opens.slice(0, 2).map((a, i) => (
            <Button key={i} variant={i === 0 ? "primary" : "secondary"} iconRight="arrowRight" kbd={i === 0 ? "⏎" : undefined} onClick={() => follow(a)}>
              {a.taskId ? "Open the task" : `Go to ${routeLabel(a.route!, ctx)}`}
            </Button>
          ))}
        </div>
      ) : cites.length > 0 ? (
        <>
          <ul className="kask-cites" aria-label="Tasks in this answer">
            {cites.slice(0, 6).map((t) => {
              const overdue = !!t.dueDate && t.dueDate < today && t.status !== "done";
              return (
                <li key={t.id}>
                  <button type="button" className="kask-cite" onClick={() => onOpenTask?.(t.id)}>
                    <span aria-hidden="true"><StatusGlyph status={t.status} size={14} /></span>
                    <span className="kask-cite-title">{t.title}</span>
                    {t.dueDate && <span className="kask-cite-meta" data-tone={overdue ? "overdue" : undefined}>{fmtDay(t.dueDate, today)}</span>}
                    <span className="kask-cite-go" aria-hidden="true">Open<Icon name="arrowRight" size={14} sw={1.75} /></span>
                    <span className="sr-only">, open</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {cites.length > 6 && <p className="kask-more">and {cites.length - 6} more</p>}
        </>
      ) : null}
    </>
  );

  return (
    <div className="kask">
      <style>{ASK_CSS}</style>
      <div className="kask-head">
        <AiMark size={14} />Ask Kanbo
        {rows.length > 0 && (
          <span className="kask-head-count">{n === rows.length ? `${n} ${plural(n, "change", "changes")}` : `${n} of ${rows.length} changes`}</span>
        )}
      </div>
      {result.source === "ai" ? <Vellum>{body}</Vellum> : <div className="kask-card">{body}</div>}
      <div className="kask-notes">
        {guest && proposed && <p className="kask-note"><Icon name="lock" size={14} sw={1.75} />Guests can ask, not change.</p>}
        {leftOut.length > 0 && (
          <p className="kask-note"><Icon name="x" size={14} sw={1.75} />
            Kanbo left out {leftOutCount} {plural(leftOutCount, "change", "changes")}: {leftOut.join("; ")}.
          </p>
        )}
        {view.via === "limit"
          ? <p className="kask-note">You've used today's {view.limit ?? 200} AI requests — on-device answers until midnight.</p>
          : result.source === "local" && <p className="kask-note">Answered on-device — Kanbo AI is {view.via === "unavailable" ? "unavailable" : "off"}.</p>}
      </div>
    </div>
  );
});

function DiffLine({ row, editing, out, onToggle }: { row: DiffRow; editing: boolean; out: boolean; onToggle: () => void }) {
  return (
    <li className="kask-row" data-out={out || undefined}>
      <span className="kask-lead">
        {editing && <Check size={16} done={!out} onToggle={onToggle} name={`Include “${row.title}”`} />}
        <span className="kask-glyph" aria-hidden="true"><StatusGlyph status={row.status} size={14} /></span>
      </span>
      <span className="kask-title" title={row.title}>
        {row.title}
        {row.op === "create" && <Pill tone="accent">New task</Pill>}
      </span>
      <span className="kask-changes">
        {row.changes.map((c) => (
          <span key={c.field} className="kask-change" data-new={c.from == null || undefined}>
            <span className="kask-field">{c.label}</span>
            <span className="kask-old" data-mono={c.mono || undefined} title={c.from ?? undefined}>
              {c.from != null && <><span className="sr-only">from </span>{c.from}</>}
            </span>
            <Icon name="arrowRight" size={14} sw={1.75} className="kask-arrow" />
            <span className="kask-new" data-mono={c.mono || undefined} title={c.to}><span className="sr-only">to </span>{c.to}</span>
          </span>
        ))}
        {!row.changes.length && <span className="kask-change" data-new="true"><span className="kask-field" /></span>}
      </span>
    </li>
  );
}

/* ============================================================
   KANBO — Today's voice: the brief card, "Kanbo noticed" and the
   after-hours "Tomorrow" preview. TodayView supplies the words
   (lib/brief.ts composeTodayBrief, lib/noticed.ts) and the actions;
   these draw them.
   · BriefCard: Kanbo's provenance line and "How I got here", the
     headline with the day's one big thing in gradient (it opens the
     task), a few sentences with the people, tasks and times as
     chips, the day's numbers as pills that narrow the rail, and
     "Plan my day for me" · "Just show me the list".
   · NoticedCard: at most three things, each with one or two actions
     and "Not now".
   · TomorrowCard: once the working day is over, tomorrow's first
     meeting and the three things to start it with.
   ============================================================ */
import { useId, useState, type ReactNode } from "react";
import { AiMark, Avatar, Button, Collapse, Icon, Kbd, ProjectChip, ProjectTile, StatusGlyph } from "../primitives";
import { getProject } from "../../data/data";
import type { IconName, Task } from "../../data/types";
import type { BriefEntity, BriefFact, BriefFactKind, BriefSpan, TodayBrief, TomorrowPreview } from "../../lib/brief";
import type { Noticed, NoticedAction } from "../../lib/noticed";
import { dayLong, fmtDuration, fmtTime, durOf, parseDay } from "./planCanvas";

export type RailFocus = "due" | "overdue" | "slipping" | "team";

export const BRIEF_CSS = `
/* the brief: a vellum card (the raised surface with a faint gradient hairline along its top) */
.kbrief {
  position: relative; isolation: isolate; max-width: 920px; padding: 28px 32px 28px; border-radius: 20px;
  background: var(--bg-raised, var(--surface-raised)); box-shadow: var(--e1, 0 0 0 1px var(--hairline));
}
.kbrief::before {
  content: ""; position: absolute; top: 0; left: 24px; right: 24px; height: 1px; border-radius: 1px; pointer-events: none;
  background: var(--grad); opacity: 0.55;
}
.kbrief::after { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none; background: var(--vellum-wash, none); }
.kbrief-meta { display: flex; align-items: center; gap: 8px; min-height: 28px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kbrief-meta .kaimark-wrap { display: inline-flex; }
.kbrief-who { font-weight: 600; color: var(--ink-2); }
.kbrief-mono { font: 500 12px/16px var(--font-mono); font-variant-numeric: tabular-nums; }
.kbrief-dot { width: 3px; height: 3px; border-radius: 50%; background: var(--ink-4); flex-shrink: 0; }
.kbrief-why-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; margin: 0 -10px 0 auto; padding: 0 10px; border: 0; border-radius: var(--r-sm, 6px);
  background: none; cursor: pointer; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); white-space: nowrap;
  transition: background var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease);
}
.kbrief-why-btn:hover { background: var(--fill-1); color: var(--ink); }
.kbrief-why-btn > svg { transition: transform var(--d-2, 160ms) var(--ease); }
.kbrief-why-btn[aria-expanded="true"] > svg { transform: rotate(180deg); }
.kbrief-head { margin: 14px 0 0; max-width: 820px; font: 600 36px/42px var(--font-head); letter-spacing: -0.026em; color: var(--ink); text-wrap: balance; }
/* the day's one big thing: gradient text (every stop AA), and it opens the task */
.kbrief-focus {
  display: inline; margin: 0; padding: 0; border: 0; background: none; font: inherit; letter-spacing: inherit; text-align: inherit; cursor: pointer;
  color: var(--accent-text, var(--accent)); border-radius: 6px; -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .kbrief-focus { background: var(--grad-text); -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-fill-color: transparent; }
}
.kbrief-focus:hover { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 6px; text-decoration-color: color-mix(in oklab, var(--accent) 45%, transparent); }
.kbrief-prose { margin: 12px 0 0; max-width: 760px; font: 400 17px/28px var(--font-ui, var(--font-display)); color: var(--ink-2); text-wrap: pretty; }
.kbrief-ent {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 26px; margin: 0 1px; padding: 0 8px 0 6px; vertical-align: 1px;
  border: 0; border-radius: 8px; background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline);
  font: 600 15px/20px var(--font-ui, var(--font-display)); color: var(--ink); text-align: left; white-space: nowrap;
}
.kbrief-ent > .kbrief-ent-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
button.kbrief-ent { cursor: pointer; transition: background var(--d-1, 90ms) var(--ease); }
button.kbrief-ent:hover { background: var(--fill-2); }
.kbrief-ent[data-kind="person"] { padding-left: 3px; border-radius: 999px; }
.kbrief-ent > span[aria-hidden="true"] { display: inline-flex; }
/* the project the day's big thing belongs to: its chip (tile + name), set into the sentence */
.kbrief-prose .kbrief-proj { height: 26px; margin: 0 1px; padding: 0 8px 0 5px; border-radius: 8px; vertical-align: 1px;
  background: var(--p-tint); color: var(--ink); font: 600 15px/20px var(--font-ui, var(--font-display)); }
.kbrief-time { font: 600 15px/20px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink); white-space: nowrap; }
.kbrief-risks { display: inline; margin: 0; padding: 0; border: 0; background: none; font: inherit; color: var(--signal, var(--st-blocked)); cursor: pointer;
  text-decoration: underline dotted; text-underline-offset: 4px; text-decoration-thickness: 1px; }
.kbrief-facts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.kbrief-fact {
  display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 12px 0 10px; border: 0; border-radius: 999px;
  background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline); font: 500 13px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); white-space: nowrap;
}
.kbrief-fact > svg { color: var(--icon-quiet, var(--ink-4)); }
.kbrief-fact-n { font: 600 13px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.kbrief-fact[data-tone="warn"] > svg, .kbrief-fact[data-tone="warn"] .kbrief-fact-n { color: var(--warn); }
.kbrief-fact[data-tone="signal"] > svg, .kbrief-fact[data-tone="signal"] .kbrief-fact-n { color: var(--signal); }
button.kbrief-fact { cursor: pointer; transition: background var(--d-1, 90ms) var(--ease), box-shadow var(--d-1, 90ms) var(--ease); }
button.kbrief-fact:hover { background: var(--fill-2); color: var(--ink); }
button.kbrief-fact[aria-pressed="true"] { background: var(--bg-selected, var(--accent-dim)); box-shadow: inset 0 0 0 1px var(--accent-line, var(--accent)); color: var(--ink); }
.kbrief-why { margin-top: 18px; padding: 16px 18px; border-radius: var(--r-md, 8px); background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline); }
.kbrief-why dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 28px; margin: 0; }
.kbrief-why dt { margin-bottom: 3px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kbrief-why dd { margin: 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); overflow-wrap: anywhere; }
.kbrief-why-foot { margin: 12px 0 0; padding-top: 10px; border-top: 1px solid var(--hairline); font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kbrief-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 22px; }
.kbrief-ask {
  display: inline-flex; align-items: center; gap: 6px; min-height: 32px; margin-left: 6px; padding: 0 6px; border: 0; border-radius: var(--r-sm, 6px);
  background: none; cursor: pointer; font: 500 13px/18px var(--font-ui, var(--font-display)); color: var(--ink-3); text-align: left;
}
.kbrief-ask:hover { color: var(--ink); background: var(--fill-1); }
.kbrief-ask .kkbd { height: 18px; }
@media (hover: none) { .kbrief-ask .kkbd { display: none; } }
@media (max-width: 859px) {
  .kbrief { padding: 20px 18px 20px; border-radius: 16px; }
  .kbrief::before { left: 16px; right: 16px; }
  .kbrief-head { margin-top: 10px; font-size: 28px; line-height: 34px; letter-spacing: -0.024em; }
  .kbrief-prose { font-size: 16px; line-height: 26px; }
  .kbrief-why dl { grid-template-columns: 1fr; }
  .kbrief-facts { flex-wrap: nowrap; overflow-x: auto; margin: 14px -18px 0; padding: 0 18px 2px; scrollbar-width: none; }
  .kbrief-facts::-webkit-scrollbar { display: none; }
  .kbrief-fact { flex: none; height: 28px; font-size: 12px; }
  .kbrief-actions { margin-top: 16px; }
  .kbrief-actions > .kbtn { flex: 1 1 100%; height: var(--h-touch, 44px); }
  .kbrief-actions > .kbtn .kkbd { display: none; }
  .kbrief-ask { margin-left: 0; }
  .kbrief-fresh { display: none; }
}

/* Kanbo noticed (the rail, above Unplanned) */
.knoticed { margin: 0 0 8px; }
.knoticed-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.knoticed-head h2 { margin: 0; font: 600 14px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.knoticed-n { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--fill-2);
  font: 500 11px/1 var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-2); }
.knoticed-sub { margin: 0 0 10px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.knoticed-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.knoticed-item { display: grid; grid-template-columns: 28px minmax(0, 1fr); column-gap: 12px; padding: 14px 14px 12px; border-radius: var(--r-lg, 12px);
  background: var(--surface, var(--surface-raised)); box-shadow: var(--e1, 0 0 0 1px var(--hairline)); }
.knoticed-ico { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--fill-1); color: var(--ink-3); }
.knoticed-ico[data-tone="signal"] { color: var(--signal); background: color-mix(in oklch, var(--signal) 12%, transparent); }
.knoticed-ico[data-tone="warn"] { color: var(--warn); background: color-mix(in oklch, var(--warn) 12%, transparent); }
.knoticed-ico[data-tone="accent"] { color: var(--accent-text, var(--accent)); background: var(--accent-tint, var(--accent-dim)); }
.knoticed-item h3 { margin: 2px 0 2px; font: 600 14px/20px var(--font-ui, var(--font-display)); letter-spacing: 0; color: var(--ink); text-wrap: pretty; }
.knoticed-item p { margin: 0; font: 400 13px/19px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.knoticed-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }

/* after hours: tomorrow, in brief (in place of the day's empty grid) */
.ktmr { max-width: 640px; padding: 20px 22px; border-radius: var(--r-lg, 12px); background: var(--surface, var(--surface-raised)); box-shadow: var(--e1, 0 0 0 1px var(--hairline)); }
.ktmr-head { display: flex; align-items: baseline; gap: 10px; }
.ktmr-head h3 { margin: 0; font: 600 17px/24px var(--font-head); letter-spacing: -0.01em; color: var(--ink); }
.ktmr-day { font: 500 12px/16px var(--font-mono); color: var(--ink-3); }
.ktmr-first { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.ktmr-first > svg { color: var(--icon-quiet, var(--ink-4)); flex-shrink: 0; }
.ktmr-first b { font-weight: 600; color: var(--ink); }
.ktmr-list { margin: 14px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--hairline); }
.ktmr-row { display: flex; align-items: center; gap: 10px; min-height: 40px; border-bottom: 1px solid var(--hairline); }
.ktmr-open { flex: 1; min-width: 0; padding: 0; border: 0; background: none; cursor: pointer; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 500 14px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.ktmr-open:hover { color: var(--accent-text, var(--accent)); }
.ktmr-meta { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.ktmr-note { margin: 12px 0 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
@media (prefers-reduced-motion: reduce) { .kbrief-why-btn > svg { transition: none; } }
`;

const FACT_ICON: Record<BriefFactKind, IconName> = {
  meetings: "calendar", free: "clock", due: "flag", overdue: "alert", slipping: "hourglass", team: "users",
};

function Entity({ e, onOpen, onOpenRisks, glue }: { e: BriefEntity; onOpen: (id: string) => void; onOpenRisks?: () => void; glue?: string }) {
  switch (e.kind) {
    case "focus":
      return (
        <button type="button" className="kbrief-focus" onClick={() => onOpen(e.taskId)} title="Open this task">
          {e.text}{glue && <span aria-hidden="true">{glue}</span>}
        </button>
      );
    case "task":
      return (
        <button type="button" className="kbrief-ent" data-kind="task" onClick={() => onOpen(e.taskId)} title="Open this task">
          <StatusGlyph status={e.status} size={14} readOnly /><span className="kbrief-ent-text">{e.text}</span>
        </button>
      );
    case "project": {
      const p = getProject(e.projectId);
      return <ProjectChip project={p ?? { id: e.projectId, color: "", name: e.text }} size="md" className="kbrief-proj" />;
    }
    case "person":
      return <span className="kbrief-ent" data-kind="person"><span aria-hidden="true"><Avatar id={e.memberId} size={20} /></span>{e.text}</span>;
    case "time":
      return <span className="kbrief-time">{e.text}</span>;
    case "risks":
      return onOpenRisks ? <button type="button" className="kbrief-risks" onClick={onOpenRisks}>{e.text}</button> : <>{e.text}</>;
  }
}

/** The spans as text and chips. A full stop (or comma) right after the focus phrase joins
 *  it, inside its gradient, so a wrapped headline never ends on a lone "." line. */
const spans = (list: BriefSpan[], onOpen: (id: string) => void, onOpenRisks?: () => void) => {
  const out: ReactNode[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (typeof s === "string") { out.push(<span key={i}>{s}</span>); continue; }
    const next = list[i + 1];
    const glue = s.kind === "focus" && typeof next === "string" ? /^[.,;:!?…]+/.exec(next)?.[0] ?? "" : "";
    if (glue) {
      out.push(<Entity key={i} e={s} onOpen={onOpen} onOpenRisks={onOpenRisks} glue={glue} />);
      const rest = (next as string).slice(glue.length);
      if (rest) out.push(<span key={i + "r"}>{rest}</span>);
      i++;
    } else out.push(<Entity key={i} e={s} onOpen={onOpen} onOpenRisks={onOpenRisks} />);
  }
  return out;
};

/** The brief card. `hero` is the one action ("Plan my day for me", or "Shut down my day" after hours). */
export function BriefCard({ brief, nowMin, railFocus, onFact, onOpen, onOpenRisks, hero, onShowList, onAsk }: {
  brief: TodayBrief;
  nowMin: number;
  railFocus: RailFocus | null;
  onFact: (f: BriefFact) => void;
  onOpen: (id: string) => void;
  onOpenRisks?: () => void;
  hero?: ReactNode;
  onShowList?: () => void;
  onAsk?: () => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [why, setWhy] = useState(false);
  return (
    <article className="kbrief" aria-labelledby={`${uid}-h`}>
      <div className="kbrief-meta">
        <AiMark size={14} />
        <span className="kbrief-who">Kanbo</span>
        <span className="kbrief-dot" aria-hidden="true" />
        <span className="kbrief-mono">{fmtTime(Math.floor(nowMin))}</span>
        <span className="kbrief-dot kbrief-fresh" aria-hidden="true" />
        <span className="kbrief-fresh">Written for you just now</span>
        <button type="button" className="kbrief-why-btn" aria-expanded={why} aria-controls={`${uid}-why`} onClick={() => setWhy((v) => !v)}>
          How I got here<Icon name="chevronDown" size={14} sw={2} />
        </button>
      </div>
      <h2 className="kbrief-head" id={`${uid}-h`}>
        <span>{brief.greeting} </span>{spans(brief.headline, onOpen, onOpenRisks)}
      </h2>
      {brief.prose.length > 0 && <p className="kbrief-prose">{spans(brief.prose, onOpen, onOpenRisks)}</p>}
      {brief.facts.length > 0 && (
        <div className="kbrief-facts" role="group" aria-label="Today at a glance">
          {brief.facts.map((f) => {
            const inner = <><Icon name={FACT_ICON[f.kind]} size={14} sw={1.75} /><span className="kbrief-fact-n">{f.value}</span>{f.label}</>;
            // meetings are what they are; the others narrow the rail (or, for free time, outline it)
            return f.kind === "meetings"
              ? <span key={f.kind} className="kbrief-fact" data-kind={f.kind}>{inner}</span>
              : (
                <button key={f.kind} type="button" className="kbrief-fact" data-kind={f.kind} data-tone={f.tone}
                  aria-pressed={f.kind === "free" ? undefined : railFocus === f.kind}
                  title={f.kind === "free" ? "Show the free time on your day" : "Show just these in the list"} onClick={() => onFact(f)}>
                  {inner}
                </button>
              );
          })}
        </div>
      )}
      <div id={`${uid}-why`}>
        <Collapse open={why}>
          <div className="kbrief-why">
            <dl>
              {brief.why.map((w) => (
                <div key={w.label}><dt>{w.label}</dt><dd>{w.items.join(" · ")}</dd></div>
              ))}
            </dl>
            <p className="kbrief-why-foot">Built from your tasks, who's waiting on them and your calendar. Nothing changes until you say so.</p>
          </div>
        </Collapse>
      </div>
      <div className="kbrief-actions">
        {hero}
        {onShowList && <Button variant="secondary" size="lg" onClick={onShowList}>Just show me the list</Button>}
        {onAsk && (
          <button type="button" className="kbrief-ask" onClick={onAsk} aria-keyshortcuts="Meta+K Control+K">
            or tell Kanbo what's different today<span aria-hidden="true" style={{ display: "inline-flex", gap: 2 }}><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
          </button>
        )}
      </div>
    </article>
  );
}

/** Kanbo noticed: at most three, each with its actions and "Not now". */
export function NoticedCard({ items, onAction, onDismiss }: {
  items: Noticed[];
  onAction: (n: Noticed, a: NoticedAction) => void;
  onDismiss: (n: Noticed) => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  if (!items.length) return null;
  return (
    <section className="knoticed" aria-labelledby={`${uid}-h`}>
      <div className="knoticed-head">
        <AiMark size={16} />
        <h2 id={`${uid}-h`}>Kanbo noticed</h2>
        <span className="knoticed-n" aria-label={`${items.length} ${items.length === 1 ? "thing" : "things"}`}>{items.length}</span>
      </div>
      <p className="knoticed-sub">Things I'd want to know if I were you.</p>
      <ul className="knoticed-list">
        {items.map((n) => (
          <li key={n.id} className="knoticed-item">
            <span className="knoticed-ico" data-tone={n.tone} aria-hidden="true"><Icon name={n.icon} size={16} sw={1.75} /></span>
            <div>
              <h3>{n.title}</h3>
              <p>{n.body}</p>
              <div className="knoticed-acts">
                {n.actions.slice(0, 2).map((a, i) => (
                  <Button key={a.kind + i} size="sm" variant={i === 0 ? "secondary" : "ghost"} onClick={() => onAction(n, a)}>{a.label}</Button>
                ))}
                <Button size="sm" variant="ghost" aria-label={`Not now: hide “${n.title}” for today`} onClick={() => onDismiss(n)}>Not now</Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** After hours: tomorrow's first meeting and the three things to start it with. */
export function TomorrowCard({ preview, onOpen }: { preview: TomorrowPreview; onOpen: (id: string) => void }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const d = parseDay(preview.day);
  const dueLabel = (t: Task) => {
    if (!t.dueDate) return fmtDuration(durOf(t));
    const due = t.dueDate.slice(0, 10);
    // (read tonight: "Due today" is today's, still open)
    return `${due === preview.day ? "Due tomorrow" : due === preview.today ? "Due today" : "Overdue"} · ${fmtDuration(durOf(t))}`;
  };
  return (
    <section className="ktmr" aria-labelledby={`${uid}-h`}>
      <div className="ktmr-head">
        <h3 id={`${uid}-h`}>Tomorrow</h3>
        {d && <span className="ktmr-day">{dayLong(d)}</span>}
      </div>
      <p className="ktmr-first">
        <Icon name="calendar" size={16} sw={1.75} />
        {preview.firstMeeting
          ? <span>First meeting: <b>{preview.firstMeeting.title}</b> at <span className="kbrief-mono">{fmtTime(preview.firstMeeting.start)}</span>{preview.meetings > 1 ? `, then ${preview.meetings - 1} more` : ""}</span>
          : <span>No meetings yet: a clear run at it.</span>}
      </p>
      {preview.top.length > 0 ? (
        <ol className="ktmr-list" aria-label="Kanbo would start with">
          {preview.top.map((t) => {
            const p = getProject(t.projectId);
            return (
              <li key={t.id} className="ktmr-row">
                <StatusGlyph status={t.status} size={16} readOnly />
                <button type="button" className="ktmr-open" onClick={() => onOpen(t.id)}>{t.title}</button>
                {p && <ProjectTile project={p} size={16} title={p.name} />}
                <span className="ktmr-meta">{dueLabel(t)}</span>
              </li>
            );
          })}
        </ol>
      ) : <p className="ktmr-note">Nothing's lined up yet. Capture it tonight and it'll be here in the morning.</p>}
      <p className="ktmr-note">Kanbo drafts tomorrow's plan from 08:00. Nothing changes until you say so.</p>
    </section>
  );
}

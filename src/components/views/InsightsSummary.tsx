/* ============================================================
   KANBO — Insights: the weekly summary, plus the chrome Overview
   (AnalyticsView) and Trends (ReportsView) share: the 48px top row
   (Overview · Trends, Me · Team, Ask Kanbo), the card, the Me/Team
   scope and the page's stylesheet.
   The stylesheet lives with the component, like the Sidebar's: every
   rule is scoped under .kin, and reads Paper & Navy tokens with a
   fallback to today's, so it looks right before and after the token pass.
   ============================================================ */
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AiMark, Button, Segmented, Vellum } from "../primitives";
import { renderRich } from "../../lib/richtext";
import type { AiOutcome } from "../../lib/askTypes";
import type { Task } from "../../data/types";
import {
  fmtDayMonth, plainSummary, summaryInput, weeklySummaryDetails, weeklySummaryText,
  type InsightsScope, type Phrase, type WeeklyFacts,
} from "./reportingUtils";

/* ---------------- the props both views take (brief §4.3) ---------------- */

export interface InsightsNavProps {
  /** Me · Team. Controlled when given; otherwise the view keeps its own (Team first). */
  scope?: InsightsScope;
  onScopeChange?: (scope: InsightsScope) => void;
  /** who "me" is: without it there's no Me scope */
  currentUserId?: string;
  /** opens ⌘K on its Ask row */
  onAsk?: () => void;
  onOpenTrends?: () => void;
  onOpenOverview?: () => void;
  /** Trends' "Write this week's summary". It's called with the tasks to send
   *  (the week's finished work and the open work, at most 120), which is what
   *  "How I got here" describes. Without it Trends asks Kanbo itself (when AI
   *  is on and the backend is there), else writes it on-device. */
  aiSummary?: (tasks: Task[]) => Promise<AiOutcome<string>>;
  /** a Personal workspace: everything is yours, so there's no Me · Team */
  personal?: boolean;
}

/** The Me/Team scope, controlled or not. A Personal workspace is always "me".
 *  Without `currentUserId` there's no "me" to filter by, so the view is the
 *  team's, and says so, whatever `scope` asks for. */
export function useInsightsScope({ scope, onScopeChange, currentUserId, personal }: InsightsNavProps) {
  const [own, setOwn] = useState<InsightsScope>("team");
  const value: InsightsScope = personal ? "me" : currentUserId ? (scope ?? own) : "team";
  const setScope = (s: InsightsScope) => {
    if (s === value) return;
    if (scope === undefined) setOwn(s);
    onScopeChange?.(s);
  };
  /** filter to the viewer's tasks (a Personal workspace is already all theirs) */
  const filterMine = value === "me" && !personal;
  return {
    scope: value,
    setScope,
    /** Me · Team is offered in team workspaces, once we know who "me" is */
    showScope: !personal && !!currentUserId,
    filterMine,
    /** the voice follows what's actually shown: yours, or the team's */
    who: (personal || filterMine ? "you" : "team") as "you" | "team",
  };
}

/* ---------------- the stylesheet ---------------- */

const INSIGHTS_CSS = `
.kin { container-type: inline-size; flex: 1; min-height: 0; overflow-y: auto; }
.kin-page { max-width: var(--list-max, 1120px); margin: 0 auto; padding: 12px var(--gutter, 32px) 48px; }
@container (max-width: 640px) { .kin-page { padding: 8px 16px 40px; } }

.kin-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 48px; }
.kin-bar-end { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.kin-ask { display: inline-flex; align-items: center; gap: 6px; }

/* the KPI sentence: --t-display (Sora 500 28/36, -0.02em); 22/30 on phones */
.kin-kpi {
  max-width: 820px; margin: 20px 0 32px;
  font: 500 var(--t-display, 28px)/var(--lh-display, 36px) var(--font-head); letter-spacing: -0.02em; color: var(--ink); text-wrap: pretty;
}
.kin-kpi b, .kin-lead b { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--ink); }
.kin-kpi b[data-tone="signal"], .kin-lead b[data-tone="signal"] { color: var(--signal, var(--st-blocked)); }
.kin-lead b[data-tone="ok"] { color: var(--ok, var(--st-done)); }
@container (max-width: 640px) { .kin-kpi { margin: 12px 0 24px; font-size: 22px; line-height: 30px; letter-spacing: -0.015em; } }

.kin-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0 0 20px; }
.kin-filters-end { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.kin-select {
  height: var(--h-sm, 28px); max-width: 220px; padding: 0 28px 0 10px; border-radius: var(--r-sm, 6px);
  border: 1px solid var(--field-border, var(--hairline-strong)); background-color: var(--field-bg, var(--surface));
  font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); text-overflow: ellipsis;
  transition: border-color var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease);
}
.kin-select:hover { color: var(--ink); }

.kin-grid {
  display: grid; gap: 16px; margin-bottom: 16px;
  /* two columns at most (cards come in pairs), one below ~736px */
  grid-template-columns: repeat(auto-fit, minmax(min(100%, max(360px, calc((100% - 16px) / 2))), 1fr));
}
.kin-grid > [data-wide] { grid-column: 1 / -1; }

.kin-card {
  position: relative; display: flex; flex-direction: column; min-width: 0; padding: 16px 20px;
  border-radius: var(--r-lg, 12px); background: var(--surface);
  box-shadow: var(--e1, 0 0 0 1px var(--hairline), 0 1px 2px oklch(0.2 0.03 268 / 0.06));
}
.kin-card-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-height: 28px; }
.kin-card-title {
  display: inline-flex; align-items: baseline; gap: 8px; min-width: 0; margin: 0;
  font: 600 15px/20px var(--font-ui, var(--font-display)); letter-spacing: -0.005em; color: var(--ink); text-wrap: nowrap;
}
.kin-card-meta { font: 500 12px/16px var(--font-ui, var(--font-display)); letter-spacing: 0; color: var(--ink-3); }
.kin-card-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-left: auto; }
.kin-lead { margin: 4px 0 0; max-width: 640px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kin-card-body { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; margin-top: 16px; }
.kin-sub { margin: 20px 0 4px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kin-foot { margin: 12px 0 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kin-empty { margin: 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); max-width: 420px; }

.kin-mono { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); white-space: nowrap; }
.kin-row {
  display: flex; align-items: center; gap: 12px; min-height: 32px; width: calc(100% + 16px); margin: 0 -8px; padding: 0 8px;
  border: 0; border-radius: var(--r-sm, 6px); background: transparent; text-align: left;
  font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2);
}
button.kin-row { cursor: pointer; transition: background var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease); }
button.kin-row:hover { background: var(--fill-1); color: var(--ink); }
button.kin-row:active { background: var(--fill-2); }
.kin-row-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kin-row-side { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 1; min-width: 0; max-width: 40%; overflow: hidden; }
.kin-row-side > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.kin-legend { display: grid; gap: 0; margin: 16px 0 0; padding: 0; list-style: none; }
.kin-legend li { display: flex; align-items: center; gap: 8px; min-height: 28px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kin-legend .kin-mono { margin-left: auto; color: var(--ink-2); }
.kin-legend li[data-empty] { color: var(--ink-4); }
.kin-legend li[data-empty] .kin-mono { color: var(--ink-4); }

.kin-table-wrap { overflow-x: auto; margin: 0 -20px; padding: 0 20px; }
.kin-table { width: 100%; border-collapse: collapse; }
.kin-table th {
  height: 32px; padding: 0 12px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--hairline);
  font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3);
}
.kin-table td {
  height: 40px; padding: 0 12px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--hairline);
  font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3);
}
.kin-table :is(th, td):first-child { padding-left: 0; text-align: left; }
.kin-table :is(th, td):last-child { padding-right: 0; }
.kin-table tbody tr:last-child td { border-bottom: 0; }
.kin-table .kin-td-name { max-width: 260px; overflow: hidden; text-overflow: ellipsis; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kin-table .kin-td-name > span { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; }
.kin-table .kin-td-name > span > span:last-child { overflow: hidden; text-overflow: ellipsis; }
.kin-td-meter { display: inline-flex; align-items: center; gap: 8px; }
@container (max-width: 600px) {
  .kin-narrow-hide { display: none; }
  .kin-table :is(th, td) { padding: 0 8px; }
  .kin-table .kin-td-name { white-space: normal; line-height: 18px; padding-top: 8px; padding-bottom: 8px; }
  .kin-table .kin-td-name > span { align-items: baseline; }
  .kin-td-meter > [aria-hidden="true"] { display: none; }
  .kin-card-actions { margin-left: 0; width: 100%; }
}

.kin-summary { margin-bottom: 16px; }
.kin-summary-body { outline: none; transition: opacity var(--d-2, 160ms) var(--ease); }
.kin-summary-body[data-busy] { opacity: 0.5; }
.kin-summary-body .kvellum { padding: 16px 20px; }
@container (max-width: 640px) { .kin-summary-body .kvellum { padding: 12px 16px; } }
.kin-summary-text { font: 400 15px/24px var(--font-ui, var(--font-display)); color: var(--ink); text-wrap: pretty; }
.kin-summary-text ul { margin: 0 !important; }
.kin-summary-text li + li { margin-top: 4px; }
.kin-summary-text li::marker { color: var(--ink-4); }
.kin-summary-text strong { font-weight: 600; }
.kin-teaser { margin: 0 0 16px; max-width: 560px; font: 400 15px/24px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kin-check { display: inline-flex; align-items: center; gap: 8px; min-height: 28px; cursor: pointer; user-select: none; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kin-check input { width: 16px; height: 16px; margin: 0; cursor: pointer; accent-color: var(--accent); }

.kin-rate { display: inline-flex; align-items: center; gap: 8px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kin-rate-field {
  display: inline-flex; align-items: center; height: var(--h-sm, 28px); padding: 0 0 0 8px; border-radius: var(--r-sm, 6px);
  border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface));
  font: 500 11px/16px var(--font-mono); color: var(--ink-3);
}
.kin-rate-field:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.kin-rate-field:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
.kin-rate-field input {
  width: 64px; height: 100%; padding: 0 8px 0 2px; border: 0; background: transparent; outline: none !important;
  font: 500 12px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink);
}
`;

export function InsightsStyles() {
  return <style>{INSIGHTS_CSS}</style>;
}

/* ---------------- the top row ---------------- */

/** 48px: Overview · Trends, Me · Team, and Ask Kanbo on the right. Each part
 *  shows only when it can do something, so the row is never empty chrome. */
export function InsightsBar({ view, onOpenTrends, onOpenOverview, scope, onScope, showScope, onAsk, compact }: {
  view: "overview" | "trends";
  onOpenTrends?: () => void;
  onOpenOverview?: () => void;
  scope: InsightsScope;
  onScope: (s: InsightsScope) => void;
  showScope: boolean;
  onAsk?: () => void;
  /** phones: no ⌘K hint */
  compact?: boolean;
}) {
  const go = view === "overview" ? onOpenTrends : onOpenOverview;
  if (!go && !showScope && !onAsk) return null;
  return (
    <div className="kin-bar">
      {go && (
        <Segmented ariaLabel="Insights view" value={view} onChange={(v) => { if (v !== view) go(); }}
          options={[{ value: "overview", label: "Overview" }, { value: "trends", label: "Trends" }]} />
      )}
      {showScope && (
        <Segmented ariaLabel="Scope" value={scope} onChange={onScope}
          options={[{ value: "me", label: "Me" }, { value: "team", label: "Team" }]} />
      )}
      {onAsk && (
        <div className="kin-bar-end">
          <Button variant="ghost" size="sm" kbd={compact ? undefined : "⌘K"} onClick={onAsk} aria-label="Ask Kanbo">
            <span className="kin-ask"><AiMark size={14} />{compact ? "Ask" : "Ask Kanbo"}</span>
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------------- the card ---------------- */

/** A dashboard card: a 15/600 title with quiet meta, optional actions on the
 *  right, an optional one-line lead (figures in bold) and the body. */
export function InsightsCard({ title, meta, lead, actions, children, wide }: {
  title: string;
  meta?: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** spans both columns of the grid */
  wide?: boolean;
}) {
  const id = useId();
  return (
    <section className="kin-card" data-wide={wide || undefined} aria-labelledby={id}>
      <div className="kin-card-head">
        <h3 className="kin-card-title" id={id}>{title}{meta != null && <span className="kin-card-meta">{meta}</span>}</h3>
        {actions && <div className="kin-card-actions">{actions}</div>}
      </div>
      {lead && <p className="kin-lead">{lead}</p>}
      {children != null && children !== false && <div className="kin-card-body">{children}</div>}
    </section>
  );
}

/** A phrase with its figures set in bold (signal-toned where they need
 *  attention). A figure never ends a line: the space after it doesn't break. */
export function Figures({ phrase }: { phrase: Phrase }) {
  return (
    <>
      {phrase.map((p, i) => {
        if (typeof p !== "string") return <b key={i} data-tone={p.tone}>{p.n}</b>;
        const after = i > 0 && typeof phrase[i - 1] !== "string";
        return <Fragment key={i}>{after ? p.replace(/^ /, "\u00a0") : p}</Fragment>;
      })}
    </>
  );
}

/* ---------------- the weekly summary ---------------- */

export interface WrittenSummary {
  /** markdown bullets */
  text: string;
  /** "ai" = written by Kanbo's model (shown on vellum, with provenance) · "local" = built on this device */
  source: "ai" | "local";
  /** why a request for Kanbo's version fell back to the local one */
  note?: string;
  /** Kanbo's version: how many tasks it was sent, and "How I got here", as they were when it wrote it */
  sent?: number;
  provenance?: { summary: string; details: string[] };
}

function fallbackNote(out: AiOutcome<string>): string {
  if (out.source === "ai") return "";
  if (out.source === "limit") return out.detail || "You've used today's Kanbo requests, so this one is built from the numbers on this device.";
  if (out.source === "off") return "Writing with Kanbo is turned off in Settings, so this one is built from the numbers on this device.";
  return out.detail || "Kanbo couldn't write it just now, so this one is built from the numbers on this device.";
}

/** Trends' first card: "Weekly summary". Before it's written it offers one
 *  action, the page's hero. Kanbo's version sits on vellum with "How I got
 *  here" (exactly what it was sent); the on-device version (no AI, AI off, or
 *  a failed request) is plain text saying where it came from. The card is one
 *  element throughout, its actions stay put while Kanbo writes (so keyboard
 *  focus is never dropped), and a single status region announces each step.
 *  The written summary is lifted (`value`) so the PDF can include what's on
 *  screen. */
export function InsightsSummary({ facts, tasks, projectName, value, onValue, aiSummary, include, onInclude, who, resetKey }: {
  facts: WeeklyFacts;
  /** the tasks in view (scope and filters applied): what Kanbo's input is taken from */
  tasks: Task[];
  projectName: (id: string) => string | undefined;
  value: WrittenSummary | null;
  onValue: (v: WrittenSummary | null) => void;
  /** asks Kanbo, with the tasks to send */
  aiSummary?: (tasks: Task[]) => Promise<AiOutcome<string>>;
  include: boolean;
  onInclude: (v: boolean) => void;
  who: "you" | "team";
  /** changes when the scope or filters change: an answer still in flight for the old scope is dropped */
  resetKey?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /** what the status region says: writing, written, fell back, copied */
  const [status, setStatus] = useState("");
  const req = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** the first write replaces the button that asked for it: focus moves to the summary instead */
  const focusBody = useRef(false);
  const titleId = useId();
  useEffect(() => { req.current++; focusBody.current = false; setBusy(false); setStatus(""); }, [resetKey]);
  useEffect(() => () => { req.current++; }, []);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);
  useEffect(() => {
    if (!value || !focusBody.current) return;
    focusBody.current = false;
    bodyRef.current?.focus({ preventScroll: true });
  }, [value]);

  const range = `${fmtDayMonth(facts.from)} – ${fmtDayMonth(facts.to)}`;
  const whose = who === "you" ? "your" : "the team's";
  const local = () => weeklySummaryText(facts, projectName);
  const write = async () => {
    const id = ++req.current;
    focusBody.current = !value;
    if (!aiSummary) {
      onValue({ text: local(), source: "local" });
      setStatus("Weekly summary written on this device.");
      return;
    }
    const input = summaryInput(tasks, facts);
    setBusy(true);
    setStatus(`Kanbo is writing up ${whose} week…`);
    let out: AiOutcome<string>;
    try { out = await aiSummary(input.tasks); } catch { out = { data: null, source: "unavailable" }; }
    if (id !== req.current) return; // the scope changed, or the view left
    setBusy(false);
    if (out.data) {
      const n = input.tasks.length;
      onValue({
        text: out.data, source: "ai", sent: n,
        provenance: { summary: `from ${n} task${n === 1 ? "" : "s"}, ${range}`, details: weeklySummaryDetails(facts, input) },
      });
      setStatus("Kanbo wrote this week's summary.");
    } else {
      const note = fallbackNote(out);
      onValue({ text: local(), source: "local", note });
      setStatus(note);
    }
  };
  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(plainSummary(value.text));
      setCopied(true);
      setStatus("Summary copied.");
    } catch { /* no clipboard (http, old browser) */ }
  };

  const text = value && <div className="kin-summary-text">{renderRich(value.text)}</div>;
  return (
    <section className="kin-card kin-summary" aria-labelledby={titleId}>
      <div className="kin-card-head">
        <h3 className="kin-card-title" id={titleId}>Weekly summary<span className="kin-card-meta">{range}</span></h3>
        <div className="kin-card-actions">
          <label className="kin-check">
            <input type="checkbox" checked={include} onChange={(e) => onInclude(e.target.checked)} />
            Include in PDF
          </label>
          {value && (
            <>
              <Button variant="ghost" size="sm" icon={copied ? "check" : "copy"} onClick={copy} disabled={busy}>{copied ? "Copied" : "Copy"}</Button>
              {aiSummary && (
                <Button variant="secondary" size="sm" icon="refresh" loading={busy} onClick={write}>
                  {value.source === "ai" ? "Rewrite" : "Try Kanbo again"}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      <div className="kin-card-body kin-summary-body" ref={bodyRef} tabIndex={-1} data-busy={(busy && !!value) || undefined}>
        {!value ? (
          <>
            <p className="kin-teaser">
              A short write-up of {whose} past 7 days: what finished, what's under way, what needs attention and what's due next.
            </p>
            <div>
              <Button variant="hero" size="sm" icon="kanbo" loading={busy} onClick={write}>
                {busy ? `Writing up ${whose} week…` : "Write this week's summary"}
              </Button>
            </div>
          </>
        ) : value.source === "ai" ? (
          <Vellum provenance={value.provenance}>{text}</Vellum>
        ) : (
          <>
            {text}
            <p className="kin-foot">{value.note ?? "Built on this device from the past 7 days' tasks."}</p>
          </>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
    </section>
  );
}

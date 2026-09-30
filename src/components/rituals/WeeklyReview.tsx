/* ============================================================
   KANBO — Weekly review: four short steps.
   1 · Wins (this week's logbook, and Kanbo's summary when offered)
   2 · Carried over (re-date what's left, in bulk)
   3 · Next week's Big 3 (shown on Today)
   4 · Share (copy a summary; nothing is sent on its own)
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import { AiMark, Button, Icon, ProjectDot, SectionLabel, Sheet, StatusGlyph, Vellum } from "../primitives";
import { useToast } from "../Toast";
import { getProject, todayISO } from "../../data/data";
import type { Task } from "../../data/types";
import { pushUndo } from "../../lib/undoStack";
import {
  addDaysISO, beforeMove, carriedOver, dayLabel, finishedThisWeek, isoWeek, movePatch, nextMondayISO, readBig3, writeBig3,
  type LeftoverMove,
} from "../../lib/rituals";

type Step = 1 | 2 | 3 | 4;
const WINS_SHOWN = 8;
const PRIORITY_RANK: Record<Task["priority"], number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function useOptionalToast() {
  try { return useToast(); } catch { return null; }
}
async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  return false;
}
const weekOf = (iso: string) => isoWeek(new Date(`${iso}T00:00:00`));

export interface WeeklyReviewProps {
  open: boolean;
  onClose: () => void;
  tasks: Task[];
  allTasks: Task[];
  currentUserId: string;
  onPatch: (id: string, patch: Partial<Task>) => void;
  /** Kanbo's summary of the week (model-written); null when it can't */
  onSummarise?: () => Promise<string | null>;
}

export function WeeklyReview({ open, onClose, tasks, currentUserId, onPatch, onSummarise }: WeeklyReviewProps): JSX.Element | null {
  const toast = useOptionalToast();
  const [step, setStep] = useState<Step>(1);
  const [day, setDay] = useState(todayISO);
  const [winIds, setWinIds] = useState<string[]>([]);
  const [carryIds, setCarryIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [moved, setMoved] = useState<Record<string, LeftoverMove>>({});
  const originals = useRef<Record<string, Pick<Task, "dueDate" | "planToday" | "scheduled">>>({});
  const [big3, setBig3] = useState<string[]>([]);
  const [summary, setSummary] = useState<{ state: "idle" | "busy" | "done" | "none"; text?: string }>({ state: "idle" });
  const [copied, setCopied] = useState(false);
  const headRef = useRef<HTMLHeadingElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const nextMonday = nextMondayISO(day);
  const nextWeek = weekOf(nextMonday);

  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const today = todayISO();
      setDay(today);
      setStep(1);
      setWinIds(finishedThisWeek(tasks, today).map((t) => t.id));
      setCarryIds(carriedOver(tasks, today).map((t) => t.id));
      setSelected(new Set());
      setMoved({});
      originals.current = {};
      setBig3(readBig3(currentUserId, weekOf(nextMondayISO(today))));
      setSummary({ state: "idle" });
      setCopied(false);
    }
  }

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const wins = winIds.map((id) => byId.get(id)).filter((t): t is Task => !!t);
  const carry = carryIds.map((id) => byId.get(id)).filter((t): t is Task => !!t);
  const candidates = useMemo(() => {
    const end = addDaysISO(nextMonday, 6);
    const open_ = tasks.filter((t) => t.status !== "done" && !t.archivedAt);
    const score = (t: Task) => (t.dueDate && t.dueDate <= end ? 0 : 10) + PRIORITY_RANK[t.priority];
    return open_.sort((a, b) => score(a) - score(b) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.title.localeCompare(b.title)).slice(0, 12);
  }, [tasks, nextMonday]);

  useEffect(() => {
    if (!open || step === 1) return;
    headRef.current?.focus({ preventScroll: true });
  }, [step, open]);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  /* ---------- carried over: bulk re-date, one Undo at the end ---------- */
  const moveSelected = (to: LeftoverMove) => {
    const ids = [...selected];
    for (const id of ids) {
      const t = byId.get(id);
      if (!t) continue;
      if (!(id in originals.current)) originals.current[id] = beforeMove(t);
      onPatch(id, movePatch(to, day));
    }
    setMoved((m) => ({ ...m, ...Object.fromEntries(ids.map((id) => [id, to])) }));
    setSelected(new Set());
  };
  const finish = () => {
    const ids = Object.keys(moved);
    if (ids.length) {
      const before = ids.map((id) => [id, originals.current[id]] as const).filter(([, o]) => !!o);
      let undone = false;
      const revert = () => { if (undone) return; undone = true; for (const [id, o] of before) onPatch(id, { ...o }); };
      const label = ids.length === 1 ? "1 task" : `${ids.length} tasks`;
      const remove = pushUndo(`Weekly review: re-dated ${label}`, revert);
      toast?.action(`Re-dated ${label}`, "Undo", () => { remove(); revert(); }, { onExpire: remove });
    }
    onClose();
  };

  const toggleBig3 = (id: string) => {
    setBig3((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 3 ? cur : [...cur, id];
      writeBig3(currentUserId, next, nextWeek);
      return next;
    });
  };

  const summarise = async () => {
    if (!onSummarise || summary.state === "busy") return;
    setSummary({ state: "busy" });
    let text: string | null = null;
    try { text = await onSummarise(); } catch { text = null; }
    if (!mounted.current) return;
    setSummary(text ? { state: "done", text } : { state: "none" });
  };

  const shareText = () => {
    const lines = [`Week ${weekOf(day).split("-W")[1].replace(/^0/, "")} review · w/c ${dayLabel(addDaysISO(nextMonday, -7))}`];
    lines.push("", `Wins (${wins.length})`, ...(wins.length ? wins.map((t) => `• ${t.title}`) : ["• A quiet week"]));
    const m = Object.keys(moved).length;
    if (carry.length) lines.push("", m ? `Carried over: ${carry.length}, ${m} re-dated` : `Carried over: ${carry.length}`);
    const picks = big3.map((id) => byId.get(id)?.title).filter(Boolean) as string[];
    if (picks.length) lines.push("", "Next week's Big 3", ...picks.map((t, i) => `${i + 1}. ${t}`));
    return lines.join("\n");
  };
  const copy = async () => {
    const ok = await copyText(shareText());
    if (!mounted.current) return;
    if (ok) setCopied(true); else toast?.error("Couldn't copy. Your browser blocked the clipboard.");
  };

  const stepper = (
    <div className="kweek-steps" role="img" aria-label={`Step ${step} of 4`}>
      {[1, 2, 3, 4].map((n) => <span key={n} data-on={n <= step || undefined} />)}
    </div>
  );
  const heading = (text: string) => <h3 ref={headRef} tabIndex={-1} className="kweek-h">{text}</h3>;
  const back = (to: Step) => <span className="kweek-foot-start"><Button variant="ghost" icon="arrowLeft" onClick={() => setStep(to)}>Back</Button></span>;
  const nextBtn = (to: Step) => <Button ref={to === 2 ? nextRef : undefined} variant="primary" iconRight="arrowRight" onClick={() => setStep(to)}>Next</Button>;

  let body: JSX.Element;
  let footer: JSX.Element;
  if (step === 1) {
    body = (
      <>
        {stepper}
        {heading("This week's wins")}
        <p className="kweek-count"><span className="kweek-num">{wins.length}</span> <span className="kweek-unit">{wins.length === 1 ? "task finished" : "tasks finished"}</span></p>
        {wins.length ? (
          <ul className="kweek-list">
            {wins.slice(0, WINS_SHOWN).map((t) => {
              const p = getProject(t.projectId);
              return (
                <li key={t.id} className="kweek-item">
                  <StatusGlyph status="done" size={14} />
                  <span className="kweek-title truncate">{t.title}</span>
                  {p && <ProjectDot color={p.color} size={8} title={p.name} />}
                </li>
              );
            })}
            {wins.length > WINS_SHOWN && <li className="kweek-more">and {wins.length - WINS_SHOWN} more</li>}
          </ul>
        ) : <p className="kweek-lede">A quieter week. Carry what matters forward and pick three things for next week.</p>}
        {onSummarise && (summary.state === "done" && summary.text ? (
          <Vellum provenance={{ summary: `from ${wins.length} finished ${wins.length === 1 ? "task" : "tasks"} this week` }}>
            <p className="kweek-summary">{summary.text}</p>
          </Vellum>
        ) : (
          <div className="kweek-ai">
            <Button variant="ghost" size="sm" loading={summary.state === "busy"} onClick={summarise}>
              {summary.state !== "busy" && <AiMark size={14} />}Summarise my week
            </Button>
            {summary.state === "none" && <span className="kweek-note">Kanbo couldn't write a summary just now.</span>}
          </div>
        ))}
      </>
    );
    footer = nextBtn(2);
  } else if (step === 2) {
    const allOn = carry.length > 0 && carry.every((t) => selected.has(t.id));
    body = (
      <>
        {stepper}
        {heading("Carried over")}
        {carry.length ? (
          <>
            <p className="kweek-lede">Still open and due this week. Pick some and give them a new date.</p>
            <SectionLabel count={carry.length}
              action={<Button variant="ghost" size="sm" onClick={() => setSelected(allOn ? new Set() : new Set(carry.map((t) => t.id)))}>{allOn ? "Select none" : "Select all"}</Button>}>
              Due this week
            </SectionLabel>
            <ul className="kweek-picks">
              {carry.map((t) => {
                const on = selected.has(t.id);
                const where = moved[t.id];
                return (
                  <li key={t.id}>
                    <button type="button" role="checkbox" aria-checked={on} aria-label={t.title} className="kweek-pick" data-done={where ? true : undefined}
                      onClick={() => setSelected((s) => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })}>
                      <span className="kweek-box" aria-hidden="true">{on && <Icon name="check" size={12} sw={2.5} />}</span>
                      <span className="kweek-title truncate">{t.title}</span>
                      <span className="kweek-due" data-late={!where && !!t.dueDate && t.dueDate < day ? true : undefined}>
                        {where ? `→ ${t.dueDate ? dayLabel(t.dueDate) : "Someday"}` : t.dueDate ? dayLabel(t.dueDate) : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="kweek-bulk" aria-live="polite">
              <span className="kweek-note">{selected.size ? `${selected.size} selected` : "Nothing selected"}</span>
              <Button variant="ghost" size="sm" disabled={!selected.size} onClick={() => moveSelected("someday")}>Someday</Button>
              <Button variant="secondary" size="sm" icon="calendar" disabled={!selected.size} onClick={() => moveSelected("nextweek")}>Move to {dayLabel(nextMonday)}</Button>
            </div>
          </>
        ) : (
          <p className="kweek-lede">Nothing carried over. A clean week.</p>
        )}
      </>
    );
    footer = <>{back(1)}{nextBtn(3)}</>;
  } else if (step === 3) {
    body = (
      <>
        {stepper}
        {heading("Next week's Big 3")}
        <p className="kweek-lede">Pick up to three things that would make next week a good one. They sit at the top of Today all week.</p>
        {candidates.length ? (
          <ul className="kweek-picks" aria-label="Candidates">
            {candidates.map((t) => {
              const n = big3.indexOf(t.id);
              const full = big3.length >= 3 && n < 0;
              return (
                <li key={t.id}>
                  <button type="button" role="checkbox" aria-checked={n >= 0} aria-label={t.title} className="kweek-pick" disabled={full}
                    onClick={() => toggleBig3(t.id)}>
                    <span className="kweek-box" data-rank={n >= 0 ? n + 1 : undefined} aria-hidden="true">{n >= 0 ? n + 1 : null}</span>
                    <span className="kweek-title truncate">{t.title}</span>
                    {getProject(t.projectId) && <ProjectDot color={getProject(t.projectId)!.color} size={8} />}
                    <span className="kweek-due">{t.dueDate ? dayLabel(t.dueDate) : ""}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : <p className="kweek-lede">Nothing open yet. Add a few tasks and come back.</p>}
        <p className="kweek-note" aria-live="polite">{big3.length ? `${big3.length} of 3 picked · saved for the week of ${dayLabel(nextMonday)}` : "None picked yet"}</p>
      </>
    );
    footer = <>{back(2)}{nextBtn(4)}</>;
  } else {
    body = (
      <>
        {stepper}
        {heading("Share")}
        <p className="kweek-lede">Copy your week as plain text for a standup or a note to yourself. Nothing is sent anywhere.</p>
        <pre className="kweek-share">{shareText()}</pre>
      </>
    );
    footer = (
      <>
        {back(3)}
        <Button variant="secondary" icon={copied ? "check" : "copy"} onClick={copy}>{copied ? "Copied" : "Copy summary"}</Button>
        <Button variant="primary" onClick={finish}>Done</Button>
      </>
    );
  }

  return (
    <Sheet open={open} onClose={finish} label="Weekly review" title="Weekly review" width={600} initialFocus={nextRef}
      footer={<div className="kweek-foot" key={step}>{footer}</div>}>
      <style>{WEEK_CSS}</style>
      <div className="kweek">{body}</div>
    </Sheet>
  );
}

const WEEK_CSS = `
.kweek { display: flex; flex-direction: column; gap: 16px; padding-top: 4px; }
.kweek-steps { display: flex; gap: 4px; }
.kweek-steps > span { width: 24px; height: 2px; border-radius: 2px; background: var(--hairline-strong); }
.kweek-steps > span[data-on="true"] { background: var(--grad, linear-gradient(90deg, #5B7CFA 0%, #8B5CF6 52%, #C24BE0 100%)); }
.kweek-h { margin: -4px 0 0; font: 600 15px/24px var(--font-ui, var(--font-display)); color: var(--ink); }
.kweek-h:focus, .kweek-h:focus-visible { outline: none; }
.kweek-lede { margin: -8px 0 0; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kweek-count { display: flex; align-items: baseline; gap: 10px; margin: -8px 0 0; }
.kweek-num { font: 500 var(--t-display, 28px)/var(--lh-display, 36px) var(--font-head); letter-spacing: -0.02em; color: var(--ink); font-variant-numeric: tabular-nums; }
.kweek-unit { font: 500 15px/24px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kweek-list, .kweek-picks { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.kweek-item { display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 0 4px; }
.kweek-title { flex: 1 1 auto; min-width: 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); text-align: left; }
.kweek-more { padding: 4px 4px 0 32px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kweek-ai { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.kweek-ai .kbtn .kaimark-wrap { margin-right: 2px; }
.kweek-summary { margin: 0; font: 400 15px/24px var(--font-ui, var(--font-display)); color: var(--ink); }
.kweek-note { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); margin: 0; }
.kweek-pick {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left;
  transition: background var(--d-1, 90ms) var(--ease);
}
.kweek-pick:hover:not(:disabled) { background: var(--fill-1); }
.kweek-pick:disabled { cursor: not-allowed; opacity: 0.45; }
.kweek-pick[aria-checked="true"] { background: var(--bg-selected, var(--accent-dim)); }
.kweek-pick[aria-checked="true"] .kweek-title { color: var(--ink); }
.kweek-pick[data-done="true"] .kweek-title { color: var(--ink-3); }
.kweek-box {
  display: grid; place-items: center; flex-shrink: 0; width: 16px; height: 16px; border-radius: var(--r-xs, 4px);
  border: 1.5px solid var(--control-border, var(--hairline-strong)); color: var(--on-accent);
  font: 600 11px/1 var(--font-mono);
}
.kweek-pick[aria-checked="true"] .kweek-box { background: var(--accent-fill, var(--accent)); border-color: transparent; }
.kweek-due { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kweek-due[data-late="true"] { color: var(--signal, var(--st-blocked)); }
.kweek-bulk { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; padding-top: 4px; }
.kweek-bulk .kweek-note { margin-right: auto; }
.kweek-share {
  margin: 0; padding: 12px 16px; border-radius: var(--r-md, 8px); background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline);
  font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 280px; overflow: auto;
}
.kweek-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; }
.kweek-foot-start { display: inline-flex; align-items: center; margin-right: auto; }
`;

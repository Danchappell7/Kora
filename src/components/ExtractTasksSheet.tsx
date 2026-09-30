/* ============================================================
   KANBO — Paste notes → tasks.
   Meeting notes, an email or a scrappy list go in; Kanbo picks out
   the actions and lays them out for review — who owns each one, when
   it's due, how urgent — and nothing is created until you say so.
     Step 1 · the notes (prefilled from a paste or a meeting block)
     Step 2 · the review: tick what to keep, fix owners and dates,
              choose the project, "Create 4 tasks"
   Kanbo's AI reads the notes when it's available (the header then
   carries the vellum and "How I got here"); otherwise the same notes
   go through lib/extractHeuristic on the device, and the header says
   "Found on-device". Names that aren't in the workspace are flagged
   rather than guessed.
   ============================================================ */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button, Check, DateChip, EmptyState, Icon, PriorityGlyph, ProjectDot, Sheet, Vellum } from "./primitives";
import { useToast } from "./Toast";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { KANBO_TODAY, PRIORITY_META } from "../data/data";
import { extractTasks } from "../lib/extractHeuristic";
import { matchMember, parseDateText } from "../lib/nlp";
import type { AiOutcome, ExtractedTask } from "../lib/askTypes";
import type { Priority, Project, Task } from "../data/types";

export interface ExtractTasksSheetProps {
  open: boolean;
  onClose: () => void;
  initialText?: string;
  /** what the notes are from, e.g. a meeting's title */
  context?: string;
  projects: Project[];
  members: { id: string; name: string }[];
  defaultProjectId?: string;
  currentUserId: string;
  onExtractAI?: (text: string, context?: string) => Promise<AiOutcome<ExtractedTask[]>>;
  onCreate: (tasks: Array<Partial<Task> & { title: string }>) => void;
}

/** one action under review */
interface Row {
  key: string;
  include: boolean;
  title: string;
  assigneeId?: string;
  /** a name from the notes that isn't anyone in this workspace */
  unknownName?: string;
  dueDate?: string;
  dueTime?: string;
  priority: Priority;
  /** the line it came from */
  note?: string;
}

type Found = {
  rows: Row[];
  source: "ai" | "device";
  /** why the device did the reading, when Kanbo's AI was asked but couldn't */
  reason?: "limit" | "off" | "unavailable";
  lines: number;
};

const MAX_TITLE = 200;
const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

const countLines = (text: string) => text.split(/\r?\n/).filter((l) => l.trim()).length;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// the sheet can render outside a ToastProvider (tests, embeds): toasts are then a no-op
function useOptionalToast() {
  try { return useToast(); } catch { return null; }
}

/** What came back (from the AI or the device) → rows to review: titles
 *  trimmed, owners resolved against this workspace, dates and times checked,
 *  duplicates dropped. Anything malformed is quietly left out. */
export function toRows(found: ExtractedTask[], members: { id: string; name: string }[]): Row[] {
  const out: Row[] = [];
  const seen = new Set<string>();
  found.forEach((t, i) => {
    const title = String(t.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE).trim();
    if (!title || seen.has(title.toLowerCase())) return;
    seen.add(title.toLowerCase());
    const byId = t.assigneeId ? members.find((m) => m.id === t.assigneeId) : undefined;
    const byName = !byId && t.assigneeName ? matchMember(t.assigneeName, members) : undefined;
    const who = byId ?? byName;
    const unknownName = !who ? (t.assigneeName?.trim() || undefined) : undefined;
    out.push({
      key: `x${i}`,
      include: true,
      title,
      ...(who ? { assigneeId: who.id } : {}),
      ...(unknownName && unknownName.toLowerCase() !== "me" ? { unknownName } : {}),
      ...(t.dueDate && ISO_DAY.test(t.dueDate) ? { dueDate: t.dueDate } : {}),
      ...(t.dueTime && HH_MM.test(t.dueTime) && t.dueDate && ISO_DAY.test(t.dueDate) ? { dueTime: t.dueTime } : {}),
      priority: t.priority && PRIORITIES.includes(t.priority) ? t.priority : "medium",
      ...(t.note ? { note: t.note } : {}),
    });
  });
  return out;
}

export function ExtractTasksSheet({
  open, onClose, initialText, context, projects, members, defaultProjectId, currentUserId, onExtractAI, onCreate,
}: ExtractTasksSheetProps): JSX.Element | null {
  const [step, setStep] = useState<"notes" | "review">("notes");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const findRef = useRef<HTMLButtonElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const run = useRef(0);
  const toast = useOptionalToast();
  const isPhone = useMediaQuery("(max-width: 859px)");
  const uid = useId();

  // A fresh start each time it opens, decided while rendering so the sheet's
  // first frame already holds the notes (prefilled notes put focus on "Find tasks").
  const [wasOpen, setWasOpen] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const start = initialText ?? "";
      setText(start); setStep("notes"); setBusy(false); setFound(null); setRows([]);
      setProjectId(defaultProjectId && projects.some((p) => p.id === defaultProjectId) ? defaultProjectId : (projects[0]?.id ?? ""));
      setPrefilled(!!start.trim());
    }
  }
  // a reading still in flight when the sheet closes is dropped
  useEffect(() => { if (!open) run.current++; }, [open]);

  const lines = countLines(text);
  const title = `Notes → tasks${context ? ` · ${context}` : ""}`;
  const chosen = rows.filter((r) => r.include);
  const project = projects.find((p) => p.id === projectId);

  const find = async () => {
    const notes = text;
    if (!notes.trim() || busy) return;
    const id = ++run.current;
    setBusy(true);
    let result: ExtractedTask[] | null = null;
    let reason: Found["reason"];
    if (onExtractAI) {
      try {
        const r = await onExtractAI(notes, context);
        if (r.source === "ai" && Array.isArray(r.data)) result = r.data;
        else reason = r.source === "limit" || r.source === "off" ? r.source : "unavailable";
      } catch {
        reason = "unavailable";
      }
    }
    if (id !== run.current) return; // closed, or asked again, while it was reading
    const source: Found["source"] = result ? "ai" : "device";
    if (!result) result = extractTasks(notes, { members, today: new Date(KANBO_TODAY), me: currentUserId });
    const next = toRows(result, members);
    setFound({ rows: next, source, reason, lines: countLines(notes) });
    setRows(next);
    setBusy(false);
    setStep("review");
    window.setTimeout(() => reviewRef.current?.focus({ preventScroll: true }), 0);
  };

  const back = () => {
    run.current++;
    setBusy(false);
    setStep("notes");
    window.setTimeout(() => notesRef.current?.focus(), 0);
  };

  const create = () => {
    if (!chosen.length) return;
    onCreate(chosen.map((r) => ({
      title: r.title.trim() || "Untitled task",
      status: "todo" as const,
      priority: r.priority,
      ...(projectId ? { projectId } : {}),
      ...(r.assigneeId ? { assigneeId: r.assigneeId } : {}),
      ...(r.dueDate ? { dueDate: r.dueDate } : {}),
      ...(r.dueTime ? { dueTime: r.dueTime } : {}),
    })));
    toast?.success(`Created ${plural(chosen.length, "task")}${project ? ` in ${project.name}` : ""}`);
    onClose();
  };

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const allOn = rows.length > 0 && rows.every((r) => r.include);

  const onNotesKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void find(); }
  };
  const onReviewKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); create(); }
  };

  const size = isPhone ? "lg" : "md";
  const footer = step === "notes" ? (
    <div className="kext-foot">
      <span className="kext-count mono" aria-hidden="true">{lines ? plural(lines, "line") : ""}</span>
      <Button variant="ghost" size={size} onClick={onClose}>Cancel</Button>
      <Button ref={findRef} variant="hero" size={size} icon="kanbo" loading={busy} disabled={!text.trim()}
        kbd={isPhone ? undefined : "⌘↵"} onClick={() => void find()}>
        {busy ? "Finding tasks…" : "Find tasks"}
      </Button>
    </div>
  ) : rows.length === 0 ? (
    <div className="kext-foot">
      <Button variant="ghost" size={size} onClick={onClose}>Close</Button>
    </div>
  ) : (
    <div className="kext-foot">
      <Button variant="ghost" size={size} icon="arrowLeft" onClick={back}>Back to notes</Button>
      <Button variant="primary" size={size} disabled={!chosen.length} kbd={isPhone ? undefined : "⌘↵"} onClick={create}>
        {chosen.length ? `Create ${plural(chosen.length, "task")}` : "Create tasks"}
      </Button>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} label={title} title={title} width={720} footer={footer} initialFocus={prefilled ? findRef : notesRef}>
      <style>{EXTRACT_CSS}</style>
      {step === "notes" ? (
        <div className="kext">
          <p className="kext-lede" id={`${uid}-lede`}>
            Paste meeting notes, an email or a list. Kanbo picks out the actions for you to check. Nothing is created until you say so.
          </p>
          <textarea ref={notesRef} className="kext-notes" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onNotesKey}
            aria-label="Notes" aria-describedby={`${uid}-lede`} spellCheck={false} disabled={busy}
            placeholder={"Sana to send the brief by Fri\nTODO: book the venue for the launch party\n- [ ] Theo: update the pricing FAQ tomorrow"} />
          <p className="kext-hint">
            Kanbo looks for lines like <q>Sana to …</q>, <q>@maya …</q>, <q>TODO:</q>, <q>Action:</q>, checkboxes, and anything under an <q>Actions</q> or <q>Next steps</q> heading.
          </p>
        </div>
      ) : (
        <div className="kext" ref={reviewRef} tabIndex={-1} onKeyDown={onReviewKey} role="group" aria-label="Review the tasks Kanbo found">
          {found && rows.length > 0 && <FoundHeader found={found} members={members.length} />}
          {rows.length === 0 ? (
            <EmptyState art="tasks" size="sm" title="Kanbo didn't find any actions."
              body={<>Try lines like <q>Sana to send the brief by Fri</q>.</>}
              action={<Button variant="secondary" size="md" icon="arrowLeft" onClick={back}>Back to notes</Button>} />
          ) : (
            <>
              <div className="kext-bar">
                <label className="kext-proj">
                  <span className="kext-proj-label">Add to</span>
                  {project && <ProjectDot color={project.color} />}
                  <select className="kext-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project for these tasks">
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <span className="kext-picked" aria-live="polite">{chosen.length} of {rows.length} selected</span>
                <Button variant="ghost" size="sm" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, include: !allOn })))}>
                  {allOn ? "Select none" : "Select all"}
                </Button>
              </div>
              <ul className="kext-rows" aria-label="Tasks found">
                {rows.map((r, i) => (
                  <ReviewRow key={r.key} row={r} index={i} members={members} currentUserId={currentUserId}
                    onChange={(p) => patch(r.key, p)} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

/** "Kanbo found 5 actions" — in the vellum when the AI read the notes, a quiet line when the device did. */
function FoundHeader({ found, members }: { found: Found; members: number }) {
  const n = found.rows.length;
  const facts = plural(n, "action");
  if (found.source === "ai") {
    return (
      <Vellum style={{ marginBottom: 16 }} provenance={{
        summary: `From ${plural(found.lines, "line")} of notes`,
        details: [
          `Read by Kanbo from ${plural(found.lines, "line")} of notes`,
          `Owners matched against ${plural(members, "person", "people")} in this workspace`,
          "Dates read the UK way (03/10 is 3 October)",
          "Nothing is created until you choose Create",
        ],
      }}>
        <p className="kext-found">Kanbo found {facts}. Check who owns each one, then create them.</p>
      </Vellum>
    );
  }
  const why = found.reason === "limit" ? " · today's Kanbo limit is reached"
    : found.reason === "off" ? " · Kanbo AI is off in Settings" : "";
  return (
    <p className="kext-device">
      <Icon name="check" size={14} sw={2} />
      <span><b>Found on-device</b> · {facts} in {plural(found.lines, "line")}{why}</span>
    </p>
  );
}

function ReviewRow({ row, index, members, currentUserId, onChange }: {
  row: Row;
  index: number;
  members: { id: string; name: string }[];
  currentUserId: string;
  onChange: (p: Partial<Row>) => void;
}) {
  const name = row.title.trim() || `Task ${index + 1}`;
  const flagId = useId();
  return (
    <li className="kext-row" data-off={!row.include || undefined} title={row.note}>
      <span className="kext-check">
        <Check done={row.include} size={16} name={`Include “${name}”`} onToggle={() => onChange({ include: !row.include })} />
      </span>
      <div className="kext-main">
        <input className="kext-title" value={row.title} maxLength={MAX_TITLE} aria-label={`Title of task ${index + 1}`}
          onChange={(e) => onChange({ title: e.target.value })} />
        <div className="kext-meta">
          <span className="kext-field">
            <Icon name="user" size={14} sw={1.75} />
            <select className="kext-select" value={row.assigneeId ?? ""} aria-label={`Assignee for “${name}”`}
              aria-describedby={row.unknownName && !row.assigneeId ? flagId : undefined}
              onChange={(e) => onChange({ assigneeId: e.target.value || undefined })}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.id === currentUserId ? `${m.name} (me)` : m.name}</option>)}
            </select>
          </span>
          {row.unknownName && !row.assigneeId && (
            <span className="kext-flag" id={flagId}>{row.unknownName} · Not in this workspace</span>
          )}
          <DateChip value={row.dueDate} time={row.dueTime} withTime size="sm" label={`Due date for “${name}”`}
            placeholder="Add date" parse={(s) => parseDateText(s)}
            onChange={(date, time) => onChange({ dueDate: date, dueTime: date ? time : undefined })} />
          <span className="kext-field">
            <PriorityGlyph priority={row.priority} />
            <select className="kext-select" value={row.priority} aria-label={`Priority for “${name}”`}
              onChange={(e) => onChange({ priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
            </select>
          </span>
        </div>
      </div>
    </li>
  );
}

/* Kept beside the component (as the capture sheet does), with fallbacks to
   today's tokens so it reads right before and after the token pass. */
const EXTRACT_CSS = `
.kext { display: flex; flex-direction: column; min-width: 0; outline: none; }
.kext-lede { margin: 0 0 12px; font: 400 15px/24px var(--font-ui, var(--font-display)); color: var(--ink-2); max-width: 60ch; }
.kext-notes {
  display: block; width: 100%; min-height: 240px; max-height: 50vh; box-sizing: border-box; resize: vertical;
  padding: 12px 14px; border-radius: var(--r-md, 8px); border: 1px solid var(--field-border, var(--hairline-strong));
  background: var(--field-bg, var(--surface)); color: var(--ink);
  font: 400 14px/22px var(--font-ui, var(--font-display)); tab-size: 2;
  transition: border-color var(--d-1, 90ms) var(--ease);
}
.kext-notes:hover:not(:disabled) { border-color: var(--field-border-hover, var(--hairline-strong)); }
.kext-notes::placeholder { color: var(--ink-4); opacity: 1; }
.kext-notes:disabled { opacity: 0.6; }
.kext-hint { margin: 12px 0 0; font: 500 12px/18px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kext q { quotes: "“" "”"; color: var(--ink-2); }

.kext-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; min-width: 0; }
.kext-foot > .kbtn:first-child:not(:only-child) { margin-right: auto; }
.kext-count { margin-right: auto; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }

.kext-found { margin: 0; font: 400 15px/24px var(--font-ui, var(--font-display)); color: var(--ink); }
.kext-device { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kext-device b { font-weight: 600; color: var(--ink-2); }
.kext-device svg { flex-shrink: 0; color: var(--ok, var(--st-done)); }

.kext-bar { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 0 8px; border-bottom: 1px solid var(--hairline); }
.kext-proj { display: inline-flex; align-items: center; gap: 8px; min-width: 0; margin-right: auto; }
.kext-proj-label { font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); white-space: nowrap; }
.kext-picked { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); white-space: nowrap; }

.kext-select {
  min-width: 0; max-width: 220px; height: 28px; padding: 0 28px 0 8px; box-sizing: border-box;
  border-radius: var(--r-sm, 6px); border: 1px solid var(--field-border, var(--hairline-strong));
  background-color: var(--field-bg, var(--surface)); color: var(--ink);
  font: 500 12px/16px var(--font-ui, var(--font-display)); text-overflow: ellipsis;
}
.kext-proj .kext-select { height: 32px; font-size: 13px; }

.kext-rows { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.kext-row { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--hairline); }
.kext-row:last-child { border-bottom: 0; }
.kext-check { display: grid; place-items: center; width: 16px; height: 32px; flex-shrink: 0; }
.kext-main { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
.kext-title {
  width: 100%; height: 32px; box-sizing: border-box; margin: 0 0 0 -8px; padding: 0 8px; width: calc(100% + 8px);
  border: 1px solid transparent; border-radius: var(--r-sm, 6px); background: transparent;
  font: 500 14px/20px var(--font-ui, var(--font-display)); color: var(--ink);
  transition: border-color var(--d-1, 90ms) var(--ease), background var(--d-1, 90ms) var(--ease);
}
.kext-title:hover { background: var(--fill-1); }
.kext-title:focus { background: var(--field-bg, var(--surface)); border-color: var(--field-border, var(--hairline-strong)); }
.kext-row[data-off] .kext-title { color: var(--ink-3); }
.kext-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-width: 0; }
.kext-field { display: inline-flex; align-items: center; gap: 2px; min-width: 0; }
/* the row's own controls stay quiet until you reach for them */
.kext-meta .kext-select { border-color: transparent; background-color: transparent; color: var(--ink-2); field-sizing: content; }
.kext-meta .kext-select:hover { background-color: var(--fill-1); color: var(--ink); }
.kext-meta .kext-select:focus-visible { background-color: var(--field-bg, var(--surface)); color: var(--ink); }
.kext-field > svg, .kext-field > .kprio { flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); }
.kext-flag { display: inline-flex; align-items: center; gap: 4px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--warn, var(--st-review)); }
.kext-meta .kdate-wrap { flex-direction: row; }

@media (max-width: 859px) {
  .kext-notes { min-height: 200px; font-size: 15px; }
  .kext-bar { flex-wrap: wrap; row-gap: 4px; }
  .kext-proj { flex-basis: 100%; }
  .kext-proj .kext-select { flex: 1; max-width: none; }
  .kext-foot { flex-direction: column-reverse; align-items: stretch; gap: 4px; }
  .kext-foot .kbtn { width: 100%; height: var(--h-touch, 44px); justify-content: center; margin-right: 0; }
  .kext-count { display: none; }
  .kext-row { padding: 12px 0 8px; }
  .kext-meta { gap: 0 8px; }
  .kext-meta .kext-select, .kext-meta .kdate { height: 36px; }
}
`;

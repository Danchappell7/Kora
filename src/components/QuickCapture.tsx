/* ============================================================
   KANBO — Quick capture.
   Press "q" anywhere (or New task ▾ › Quick capture, or the phone's
   centre +) for a centre sheet with one field that reads a whole task
   as you type — "call Sana fri 3pm ~30m #launch" — highlighting each
   token it understood and confirming it as a chip underneath.
   ⏎ adds · ⇧⏎ adds and keeps the sheet open for the next one.
   Paste several lines and it offers to create them all (indented
   lines become sub-tasks), or to hand them to Kanbo as meeting notes.
   ============================================================ */
import {
  forwardRef, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ClipboardEvent, type KeyboardEvent, type ReactNode,
} from "react";
import { Icon, Avatar, Button, IconButton, AiMark, DateChip, PriorityGlyph, ProjectDot, Sheet, Kbd } from "./primitives";
import { Popover } from "./primitives/Popover";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { getMember, todayISO, KANBO_TODAY, TAGS } from "../data/data";
import { parseTask, parseDateText, segments, splitLines, stripTokens, fmtMinutes, dayLabel, type NlpSpan, type NlpKind, type ParsedTask } from "../lib/nlp";
import { IMPORT_LIMIT, type ImportRow } from "../lib/importTasks";
import type { Task, Status, TagDef } from "../data/types";

/* ============================== TokenField ============================== */

type FieldEl = HTMLInputElement | HTMLTextAreaElement;

export interface TokenFieldProps {
  value: string;
  onValueChange: (value: string) => void;
  /** what the grammar recognised (lib/nlp parseTask().spans), highlighted in place */
  spans: NlpSpan[];
  /** accessible name */
  label: string;
  /** a growing textarea (pasted lists) instead of a one-line input */
  multiline?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  describedBy?: string;
  invalid?: boolean;
  /** textarea only: grow up to this height, then scroll */
  maxHeight?: number;
  /** "none" for a hero field that IS its dialog (the app-wide convention, as in ⌘K) */
  focusRing?: "none" | "inline";
  onKeyDown?: (e: KeyboardEvent<FieldEl>) => void;
  onPaste?: (e: ClipboardEvent<FieldEl>) => void;
}

/**
 * A text field that highlights the natural-language tokens it holds. The
 * field's own text is transparent; an aligned mirror underneath draws the same
 * text with the tokens marked, so the caret, selection, IME and screen readers
 * all work on a plain input. Marks never change a glyph's width (colour and a
 * box-shadow halo only), so the two layers can't drift apart.
 */
export const TokenField = forwardRef<FieldEl, TokenFieldProps>(function TokenField(
  { value, onValueChange, spans, label, multiline, placeholder, id, className, describedBy, invalid, maxHeight = 240, focusRing, onKeyDown, onPaste },
  forwarded,
) {
  const own = useRef<FieldEl | null>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const setRef = (el: FieldEl | null) => {
    own.current = el;
    if (typeof forwarded === "function") forwarded(el);
    else if (forwarded) (forwarded as { current: FieldEl | null }).current = el;
  };
  const sync = () => {
    const f = own.current, m = mirror.current;
    if (!f || !m) return;
    m.scrollTop = f.scrollTop;
    m.scrollLeft = f.scrollLeft;
  };
  // a textarea grows with what's typed or pasted (up to maxHeight, then scrolls)
  useLayoutEffect(() => {
    const f = own.current;
    if (!multiline || !(f instanceof HTMLTextAreaElement)) return;
    f.style.height = "auto";
    const h = f.scrollHeight;
    if (h > 0) {
      f.style.height = `${Math.min(h, maxHeight)}px`;
      f.style.overflowY = h > maxHeight ? "auto" : "hidden";
    }
    sync();
  }, [value, multiline, maxHeight]);

  const common = {
    id, value, placeholder, spellCheck: false, autoComplete: "off",
    "aria-label": label, "aria-describedby": describedBy, "aria-invalid": invalid || undefined,
    className: "ktok-field", "data-focus-ring": focusRing,
    onKeyDown, onPaste,
    onScroll: sync, onSelect: sync, onKeyUp: sync,
  };
  return (
    <div className={"ktok" + (className ? " " + className : "")} data-single={multiline ? undefined : "true"}>
      <div ref={mirror} className="ktok-mirror" aria-hidden="true">
        {segments(value, spans).map((s, i) => (s.span
          ? <mark key={i} className="ktok-mark" data-kind={s.span.kind}>{s.text}</mark>
          : <span key={i}>{s.text}</span>))}
        {multiline && "​"}
      </div>
      {multiline
        ? <textarea {...common} ref={setRef as (el: HTMLTextAreaElement | null) => void} rows={1}
            onChange={(e) => onValueChange(e.target.value)} />
        : <input {...common} ref={setRef as (el: HTMLInputElement | null) => void} type="text"
            onChange={(e) => onValueChange(e.target.value)} />}
    </div>
  );
});

/** The parsed facts as quiet read-only chips ("Fri 2 Oct 15:00", "30m estimate", …). */
export function TokenChips({ parsed, projects, members, tags, skip = [] }: {
  parsed: ParsedTask;
  projects: { id: string; name: string; color?: string }[];
  members: { id: string; name: string }[];
  tags?: Record<string, TagDef>;
  skip?: NlpKind[];
}) {
  const chips = factChips(parsed, projects, members, tags ?? TAGS).filter((c) => !skip.includes(c.kind));
  if (!chips.length) return null;
  return (
    <ul className="kcap-facts" aria-label="Read from the title">
      {chips.map((c) => <li key={c.key} className="kcap-chip" data-kind={c.kind}>{c.icon}<span className="kcap-chip-text">{c.text}</span></li>)}
    </ul>
  );
}

type Fact = { key: string; kind: NlpKind; icon: ReactNode; text: ReactNode; words: string };
const mono = (s: string) => <span className="mono">{s}</span>;

/** One chip per thing the grammar read, in reading order. */
function factChips(p: ParsedTask, projects: { id: string; name: string; color?: string }[], members: { id: string; name: string }[], tags: Record<string, TagDef>): Fact[] {
  const out: Fact[] = [];
  const kinds = new Set(p.spans.map((s) => s.kind));
  if (p.dueDate && (kinds.has("date") || kinds.has("time"))) {
    const when = `${dayLabel(p.dueDate)}${p.dueTime ? ` · ${p.dueTime}` : ""}`;
    out.push({ key: "due", kind: "date", icon: <Icon name="calendar" size={14} sw={1.75} />, text: mono(when), words: `Due ${when}` });
  }
  if (p.recurrence) {
    const label = p.spans.find((s) => s.kind === "repeat")?.label ?? "Repeats";
    out.push({ key: "repeat", kind: "repeat", icon: <Icon name="refresh" size={14} sw={1.75} />, text: label, words: label });
  }
  if (p.startDate) {
    const s = `Starts ${dayLabel(p.startDate)}`;
    out.push({ key: "start", kind: "start", icon: <Icon name="arrowRight" size={14} sw={1.75} />, text: s, words: s });
  }
  if (p.effortHours) {
    const s = fmtMinutes(Math.round(p.effortHours * 60));
    out.push({ key: "est", kind: "estimate", icon: <Icon name="hourglass" size={14} sw={1.75} />, text: <>{mono(s)}<span className="kcap-chip-sub">estimate</span></>, words: `${s} estimate` });
  }
  if (p.focusMin) {
    const s = fmtMinutes(p.focusMin);
    out.push({ key: "dur", kind: "duration", icon: <Icon name="clock" size={14} sw={1.75} />, text: <>{mono(s)}<span className="kcap-chip-sub">focus</span></>, words: `${s} of focus` });
  }
  if (p.priority) {
    const s = `${p.priority[0].toUpperCase()}${p.priority.slice(1)}`;
    out.push({ key: "prio", kind: "priority", icon: <PriorityGlyph priority={p.priority} />, text: s, words: `${s} priority` });
  }
  if (p.projectId) {
    const proj = projects.find((x) => x.id === p.projectId);
    if (proj) out.push({ key: "proj", kind: "project", icon: <ProjectDot color={proj.color ?? ""} />, text: proj.name, words: `In ${proj.name}` });
  }
  if (p.assigneeId) {
    const who = members.find((m) => m.id === p.assigneeId);
    if (who) out.push({ key: "who", kind: "person", icon: <PersonMark id={who.id} name={who.name} />, text: who.name, words: `For ${who.name}` });
  }
  for (const id of p.tags ?? []) {
    const t = tags[id];
    if (t) out.push({ key: `tag-${id}`, kind: "tag", icon: <span className="kcap-tagdot" style={{ background: t.color }} aria-hidden="true" />, text: t.label, words: `Tagged ${t.label}` });
  }
  if (p.energy) out.push({ key: "energy", kind: "energy", icon: <Icon name="zap" size={14} sw={1.75} />, text: "Deep work", words: "Deep work" });
  return out;
}

/** a face beside a name that's already written out: decoration for screen readers */
export function PersonMark({ id, name }: { id: string; name: string }) {
  if (getMember(id)) return <span className="kcap-face" aria-hidden="true"><Avatar id={id} size={18} /></span>;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
  return <span className="kcap-initials" aria-hidden="true">{initials}</span>;
}

/* ============================== QuickCapture ============================== */

type Due = { date?: string; time?: string } | null;
interface Picks { due?: Due; assigneeId?: string; projectId?: string }

export function QuickCapture({ open, onClose, projects, members, defaultProjectId, onCreate, onPasteNotes, onImportRows, onOpenImport, tags, initialText }: {
  open: boolean;
  onClose: () => void;
  projects: { id: string; name: string; color?: string }[];
  members: { id: string; name: string }[];
  defaultProjectId?: string;
  onCreate: (partial: Partial<Task> & { title: string }) => void;
  /** "Turn notes into tasks with Kanbo" — hands a multi-line paste to the notes review sheet */
  onPasteNotes?: (text: string) => void;
  /** creates a multi-line paste in one go (parentIndex = sub-task of that row). Without it, rows go through onCreate one by one, flat. */
  onImportRows?: (rows: ImportRow[]) => void;
  /** a paste longer than Quick capture takes (IMPORT_LIMIT lines) goes to Import tasks, prefilled with it */
  onOpenImport?: (text: string) => void;
  /** tags "+design" can match (defaults to the live tag dictionary) */
  tags?: Record<string, TagDef>;
  /** text to open with (e.g. a ⌘K query turned into a task) */
  initialText?: string;
}) {
  const [text, setText] = useState("");
  const [picks, setPicks] = useState<Picks>({});
  const [added, setAdded] = useState<string | null>(null);
  const [menu, setMenu] = useState<"project" | "person" | null>(null);
  const fieldRef = useRef<FieldEl>(null);
  const projectBtn = useRef<HTMLButtonElement>(null);
  const personBtn = useRef<HTMLButtonElement>(null);
  const isPhone = useMediaQuery("(max-width: 859px)");
  const uid = useId();

  useEffect(() => {
    if (!open) return;
    setText(initialText ?? ""); setPicks({}); setAdded(null); setMenu(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!added) return;
    const t = window.setTimeout(() => setAdded(null), 4000);
    return () => window.clearTimeout(t);
  }, [added]);

  const projs = projects;
  const tagDict = tags ?? TAGS;
  // `today` keeps "today"/"fri" right in a sheet left open past midnight
  const today = todayISO();
  const ctx = useMemo(() => ({ today: new Date(KANBO_TODAY), projects: projs, members, tags: tagDict }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projs, members, tagDict, today]);
  const lines = useMemo(() => splitLines(text), [text]);
  const multi = lines.length > 1;
  // more lines than one batch takes: nothing is parsed, the paste is handed to Import
  const tooMany = lines.length > IMPORT_LIMIT;
  // a paste is read line by line (below); the whole text is only ever one task
  const parsed = useMemo(() => (multi ? NOTHING_READ : parseTask(text, ctx)), [multi, text, ctx]);

  // highlight every line of a paste, not just the first
  const spans = useMemo(() => {
    if (!multi) return parsed.spans;
    if (tooMany) return [];
    const out: NlpSpan[] = [];
    let at = 0;
    for (const line of text.split("\n")) {
      for (const s of parseTask(line, ctx).spans) out.push({ ...s, start: s.start + at, end: s.end + at });
      at += line.length + 1;
    }
    return out;
  }, [multi, tooMany, parsed, text, ctx]);

  // what will be created: typed tokens win, then what was picked from a chip
  const dateTyped = parsed.spans.some((s) => s.kind === "date" || s.kind === "time");
  const due: { date?: string; time?: string } = dateTyped
    ? { date: parsed.dueDate, time: parsed.dueTime }
    : picks.due === null ? {} : picks.due ?? { date: parsed.dueDate, time: parsed.dueTime };
  const assigneeId = parsed.assigneeId ?? picks.assigneeId;
  const projectId = parsed.projectId ?? picks.projectId ?? defaultProjectId;
  const project = projs.find((p) => p.id === projectId);
  const assignee = assigneeId ? members.find((m) => m.id === assigneeId) : undefined;

  const rows = useMemo<ImportRow[]>(() => {
    if (!multi || tooMany) return [];
    const stack: { depth: number; index: number }[] = [];
    return lines.map((line, i) => {
      while (stack.length && stack[stack.length - 1].depth >= line.depth) stack.pop();
      const parentIndex = stack[stack.length - 1]?.index;
      stack.push({ depth: line.depth, index: i });
      const p = parseTask(line.title, ctx);
      const row: ImportRow = { title: p.title || line.title, status: "todo", priority: p.priority ?? "medium" };
      const pid = p.projectId ?? picks.projectId ?? defaultProjectId;
      if (pid) row.projectId = pid;
      const who = p.assigneeId ?? picks.assigneeId;
      if (who) row.assigneeId = who;
      if (p.dueDate) row.dueDate = p.dueDate;
      if (p.dueTime) row.dueTime = p.dueTime;
      if (p.startDate) row.startDate = p.startDate;
      if (p.recurrence) row.recurrence = p.recurrence;
      if (p.focusMin) { row.focusMin = p.focusMin; row.dur = p.focusMin; }
      if (p.effortHours) row.effortHours = p.effortHours;
      if (p.tags?.length) row.tags = p.tags;
      if (p.energy) row.energy = p.energy;
      if (parentIndex !== undefined && onImportRows) row.parentIndex = parentIndex;
      return row;
    });
  }, [multi, tooMany, lines, ctx, picks.projectId, picks.assigneeId, defaultProjectId, onImportRows]);
  const subCount = rows.filter((r) => r.parentIndex !== undefined).length;
  const createLabel = `Create ${rows.length} tasks${subCount ? ` (${subCount} sub-task${subCount === 1 ? "" : "s"})` : ""}`;

  const reset = () => { setText(""); setPicks({}); setMenu(null); };
  const refocus = () => window.setTimeout(() => fieldRef.current?.focus(), 0);

  const submit = (keepOpen: boolean) => {
    if (tooMany) { toImport(); return; }
    if (multi) { createRows(keepOpen); return; }
    const title = parsed.title.trim();
    if (!title) return;
    const partial: Partial<Task> & { title: string } = { title, priority: parsed.priority ?? "medium", status: "todo" as Status };
    if (due.date) partial.dueDate = due.date;
    if (due.time) partial.dueTime = due.time;
    if (assigneeId) partial.assigneeId = assigneeId;
    if (projectId) partial.projectId = projectId;
    if (parsed.startDate) partial.startDate = parsed.startDate;
    if (parsed.recurrence) partial.recurrence = parsed.recurrence;
    if (parsed.focusMin) partial.focusMin = parsed.focusMin;
    if (parsed.effortHours) partial.effortHours = parsed.effortHours;
    if (parsed.tags?.length) partial.tags = parsed.tags;
    if (parsed.energy) partial.energy = parsed.energy;
    if (parsed.planToday) partial.planToday = true;
    onCreate(partial);
    if (keepOpen) { reset(); setAdded(title); refocus(); } else onClose();
  };
  const createRows = (keepOpen: boolean) => {
    if (!rows.length) return;
    if (onImportRows) onImportRows(rows); else rows.forEach((r) => onCreate(r));
    if (keepOpen) { reset(); setAdded(`${rows.length} tasks`); refocus(); } else onClose();
  };
  const toKanbo = () => { if (!onPasteNotes) return; onPasteNotes(text); onClose(); };
  const toImport = () => { if (!onOpenImport) return; onOpenImport(text); onClose(); };
  const lineCount = lines.length.toLocaleString("en-GB");
  const limit = IMPORT_LIMIT.toLocaleString("en-GB");

  const onKeyDown = (e: KeyboardEvent<FieldEl>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); submit(e.shiftKey); return; }
    // an empty field has nothing to lose: Escape closes straight away
    // (with text in it, the sheet's focus trap leaves the field first)
    if (e.key === "Escape" && !text.trim()) { e.preventDefault(); onClose(); }
  };

  /** a chip took over from what was typed: drop those tokens from the text */
  const dropTyped = (kinds: NlpKind[]) => {
    if (parsed.spans.some((s) => kinds.includes(s.kind))) setText(stripTokens(text, parsed.spans, kinds));
  };
  const pickDue = (date: string | undefined, time?: string) => {
    dropTyped(["date", "time"]);
    setPicks((p) => ({ ...p, due: date || time ? { date, time } : null }));
  };
  const pickProject = (id: string) => { dropTyped(["project"]); setPicks((p) => ({ ...p, projectId: id })); setMenu(null); refocus(); };
  const pickPerson = (id: string | undefined) => { dropTyped(["person"]); setPicks((p) => ({ ...p, assigneeId: id })); setMenu(null); refocus(); };

  const facts = factChips(parsed, projs, members, tagDict).filter((f) => f.kind !== "date" && f.kind !== "project" && f.kind !== "person");
  const summary = tooMany
    ? `${lineCount} lines is more than Quick capture adds at once.${onOpenImport ? " Open them in Import instead." : ""}`
    : multi
    ? `${createLabel}.`
    : [due.date ? `Due ${dayLabel(due.date)}${due.time ? ` at ${due.time}` : ""}` : null, ...facts.map((f) => f.words),
      project ? `In ${project.name}` : null, assignee ? `For ${assignee.name}` : null].filter(Boolean).join(" · ");

  const tipId = `${uid}-tip`;
  const tip = onPasteNotes
    ? "Paste meeting notes and Kanbo turns each action into a task, for you to review first."
    : "Paste a list to add several tasks at once; indented lines become sub-tasks.";

  const footer = tooMany ? (
    onOpenImport ? (
      <div className="kcap-foot" data-multi="true">
        <Button variant="primary" size={isPhone ? "lg" : "md"} kbd={isPhone ? undefined : "↵"} icon="arrowUpRight" onClick={toImport}>Open in Import</Button>
      </div>
    ) : null
  ) : multi ? (
    <div className="kcap-foot" data-multi="true">
      {onPasteNotes && (
        <Button variant="ghost" size={isPhone ? "lg" : "md"} onClick={toKanbo} className="kcap-kanbo">
          <AiMark size={14} />Turn notes into tasks with Kanbo
        </Button>
      )}
      <Button variant="primary" size={isPhone ? "lg" : "md"} kbd={isPhone ? undefined : "↵"} onClick={() => createRows(false)}>{createLabel}</Button>
    </div>
  ) : (
    <div className="kcap-foot">
      <span className="kcap-keys" aria-hidden="true"><Kbd>⇧</Kbd><Kbd>↵</Kbd> add and keep going</span>
      <Button variant={isPhone ? "hero" : "primary"} size={isPhone ? "lg" : "md"} kbd={isPhone ? undefined : "↵"}
        disabled={!parsed.title.trim()} onClick={() => submit(false)}>Add task</Button>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} label="Quick capture" width={600} initialFocus={fieldRef as React.RefObject<HTMLElement>} footer={footer}>
      <style>{CAPTURE_CSS}</style>
      <div className="kcap">
        <div className="kcap-head">
          <span>New task</span>
          {project && !multi && <span className="kcap-head-where"><ProjectDot color={project.color ?? ""} size={8} />{project.name}</span>}
          <IconButton icon="x" label="Close" size="sm" onClick={onClose} />
        </div>
        <TokenField ref={fieldRef} multiline value={text} onValueChange={(v) => { setText(v); if (added) setAdded(null); }}
          spans={spans} label="Quick capture a task" className="kcap-input" describedBy={multi ? undefined : tipId} focusRing="none"
          placeholder={"Add a task — “call Sana fri 3pm ~30m”"} onKeyDown={onKeyDown} />
        <p className="sr-only" aria-live="polite">{summary}</p>

        {tooMany ? (
          <div className="kcap-multi">
            <p className="kcap-over">
              <Icon name="list" size={16} sw={1.75} />
              <span>
                <b>{lineCount} lines</b> is more than Quick capture adds at once.{" "}
                {onOpenImport
                  ? <>Import takes up to {limit} at a time, with a preview first.</>
                  : <>Add up to {limit} at a time, or use Import tasks for a longer list.</>}
              </span>
            </p>
          </div>
        ) : multi ? (
          <div className="kcap-multi">
            <p className="kcap-multi-head">
              <span>{rows.length} tasks</span>
              {subCount > 0 && <span className="kcap-multi-sub">· {subCount} sub-task{subCount === 1 ? "" : "s"}</span>}
              <span className="kcap-multi-hint">One per line; indented lines go under the line above.</span>
            </p>
            <ol className="kcap-rows" aria-label="Tasks to create">
              {rows.slice(0, 8).map((r, i) => {
                const depth = depthOf(rows, i);
                return (
                  <li key={i} style={depth ? { paddingLeft: depth * 20 } : undefined}>
                    {depth > 0 && <span className="kcap-elbow" aria-hidden="true" />}
                    <span className="kcap-ring" aria-hidden="true" />
                    <span className="kcap-row-title">{r.title}</span>
                    {r.priority && r.priority !== "medium" && <PriorityGlyph priority={r.priority} />}
                    {r.dueDate && <span className="mono kcap-row-meta">{dayLabel(r.dueDate)}{r.dueTime ? ` ${r.dueTime}` : ""}</span>}
                    {r.assigneeId && members.find((m) => m.id === r.assigneeId) && <span className="kcap-row-meta">{members.find((m) => m.id === r.assigneeId)!.name.split(" ")[0]}</span>}
                  </li>
                );
              })}
              {rows.length > 8 && <li className="kcap-more">+ {rows.length - 8} more</li>}
            </ol>
          </div>
        ) : (
          <div className="kcap-chips" role="group" aria-label="Task details">
            <DateChip value={due.date} time={due.time} withTime size="md" label="Due date" placeholder="Date"
              parse={(s) => parseDateText(s)} onChange={pickDue} />
            {facts.map((f) => <span key={f.key} className="kcap-chip" data-kind={f.kind}>{f.icon}<span className="kcap-chip-text">{f.text}</span></span>)}
            <button ref={projectBtn} type="button" className="kcap-chip" data-empty={project ? undefined : "true"} aria-haspopup="menu" aria-expanded={menu === "project"}
              aria-label={project ? `Project: ${project.name}` : "Project"} onClick={() => setMenu(menu === "project" ? null : "project")}>
              {project ? <ProjectDot color={project.color ?? ""} /> : <Icon name="folder" size={14} sw={1.75} />}
              <span className="kcap-chip-text">{project ? project.name : "Project"}</span>
            </button>
            <button ref={personBtn} type="button" className="kcap-chip" data-empty={assignee ? undefined : "true"} aria-haspopup="menu" aria-expanded={menu === "person"}
              aria-label={assignee ? `Assignee: ${assignee.name}` : "Assign"} onClick={() => setMenu(menu === "person" ? null : "person")}>
              {assignee ? <PersonMark id={assignee.id} name={assignee.name} /> : <Icon name="plus" size={14} sw={1.75} />}
              <span className="kcap-chip-text">{assignee ? assignee.name : "Assign"}</span>
            </button>
          </div>
        )}
        {!multi && (
          <p className="kcap-tip" id={tipId} data-added={added ? "true" : undefined}>
            {added
              ? <><Icon name="check" size={16} sw={2} /><span>Added “{added}”. Type the next one.</span></>
              : <><Icon name="notes" size={16} sw={1.75} /><span>{tip}</span></>}
          </p>
        )}
      </div>

      <Popover open={menu === "project"} anchorRef={projectBtn} onClose={() => setMenu(null)} label="Project" minWidth={220} maxHeight={280} className="kcap-menu">
        {projs.map((p) => (
          <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === projectId} onClick={() => pickProject(p.id)}>
            <ProjectDot color={p.color ?? ""} /><span>{p.name}</span>{p.id === projectId && <Icon name="check" size={14} sw={2} />}
          </button>
        ))}
      </Popover>
      <Popover open={menu === "person"} anchorRef={personBtn} onClose={() => setMenu(null)} label="Assignee" minWidth={220} maxHeight={280} className="kcap-menu">
        {assigneeId && (
          <button type="button" role="menuitem" onClick={() => pickPerson(undefined)}>
            <Icon name="x" size={14} sw={1.75} /><span>No assignee</span>
          </button>
        )}
        {members.map((m) => (
          <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === assigneeId} onClick={() => pickPerson(m.id)}>
            <PersonMark id={m.id} name={m.name} /><span>{m.name}</span>{m.id === assigneeId && <Icon name="check" size={14} sw={2} />}
          </button>
        ))}
      </Popover>
    </Sheet>
  );
}

/** what a paste reads as while it's read line by line instead */
const NOTHING_READ: ParsedTask = { title: "", spans: [] };

/** how deep row i sits (its parent chain's length) */
function depthOf(rows: ImportRow[], i: number): number {
  let d = 0;
  for (let p = rows[i].parentIndex, hops = 0; p !== undefined && hops < rows.length; p = rows[p].parentIndex, hops++) d++;
  return d;
}

/* The token field (shared with New task) and the capture sheet. Kept here,
   with the components, and read with fallbacks to today's tokens. */
export const CAPTURE_CSS = `
.ktok { position: relative; display: block; min-width: 0; }
.ktok-mirror, .ktok-field {
  margin: 0; border: 0; box-sizing: border-box; padding: var(--ktok-pad, 0);
  font: inherit; letter-spacing: inherit; text-align: left; text-transform: none; tab-size: 4;
  white-space: pre-wrap; overflow-wrap: break-word; word-break: normal;
}
.ktok[data-single] .ktok-mirror, .ktok[data-single] .ktok-field { white-space: pre; overflow-wrap: normal; }
.ktok-mirror { position: absolute; inset: 0; overflow: hidden; color: var(--ink); pointer-events: none; }
.ktok-field {
  position: relative; display: block; width: 100%; resize: none; outline: none; overflow: hidden;
  background: transparent; color: transparent; -webkit-text-fill-color: transparent; caret-color: var(--ink);
}
.ktok-field::placeholder { color: var(--ink-4); -webkit-text-fill-color: var(--ink-4); opacity: 1; }
.ktok-mark {
  color: var(--accent-text, var(--accent)); background: var(--accent-tint, var(--accent-dim)); border-radius: var(--r-xs, 4px);
  /* a 1px halo either side: widths never change, and two tokens a space apart still read as two */
  box-shadow: -1px 0 0 var(--accent-tint, var(--accent-dim)), 1px 0 0 var(--accent-tint, var(--accent-dim));
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
}

.kcap { display: flex; flex-direction: column; min-width: 0; }
.kcap-head { display: flex; align-items: center; gap: 8px; min-height: 28px; margin: -12px -12px 8px 0;
  font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kcap-head-where { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-weight: 500; color: var(--ink-4); }
.kcap-head-where::before { content: "·"; margin-right: 2px; color: var(--ink-4); }
.kcap-head .kibtn { margin-left: auto; }
.kcap-input { font: 500 18px/28px var(--font-ui, var(--font-display)); letter-spacing: -0.005em; color: var(--ink); }
.kcap-input .ktok-field { min-height: 28px; }

.kcap-chips, .kcap-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 16px 0 0; padding: 0; list-style: none; }
.kcap-facts { margin-top: 8px; }
.kcap-chip, .kcap-chips .kdate {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; max-width: 260px; padding: 0 10px; box-sizing: border-box;
  border-radius: var(--r-sm, 6px); border: 1px solid var(--hairline); background: var(--fill-1);
  font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); white-space: nowrap;
}
.kcap-chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.kcap-chip .mono, .kcap-chips .kdate { font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
.kcap-chip-sub { margin-left: 4px; color: var(--ink-3); font-family: var(--font-ui, var(--font-display)); }
.kcap-chip svg { flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); }
.kcap-chip[data-kind] { color: var(--ink); }
button.kcap-chip { cursor: pointer; transition: background var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease), border-color var(--d-1, 90ms) var(--ease); }
button.kcap-chip:hover, .kcap-chips .kdate:hover { background: var(--fill-2); color: var(--ink); }
button.kcap-chip[aria-expanded="true"] { background: var(--fill-2); border-color: var(--hairline-strong); }
.kcap-chip[data-empty="true"], .kcap-chips .kdate[data-empty="true"] {
  background: transparent; border-style: dashed; border-color: var(--hairline-strong); color: var(--ink-3);
  font-family: var(--font-ui, var(--font-display));
}
.kcap-chip[data-empty="true"]:hover, .kcap-chips .kdate[data-empty="true"]:hover { color: var(--ink); border-color: var(--field-border-hover, var(--hairline-strong)); }
.kcap-chips .kdate-wrap { flex-direction: row; }
.kcap-chips .kdate[data-tone="overdue"] { color: var(--signal, var(--st-blocked)); }
.kcap-chips .kdate[data-tone="now"] { color: var(--accent-text, var(--accent)); }
.kcap-tagdot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.kcap-face { display: inline-flex; flex-shrink: 0; }
.kcap-initials { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
  font: 600 10px/1 var(--font-ui, var(--font-display)); color: var(--ink-2); background: var(--fill-2); }

.kcap-multi { margin-top: 16px; }
.kcap-multi-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; margin: 0 0 8px;
  font: 600 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kcap-multi-sub { font-weight: 500; color: var(--ink-2); }
.kcap-multi-hint { margin-left: auto; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kcap-rows { display: grid; gap: 2px; max-height: 208px; overflow-y: auto; margin: 0; padding: 8px; list-style: none;
  border-radius: var(--r-md, 8px); background: var(--fill-1); }
.kcap-rows li { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 24px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
/* a sub-task hangs off the line above (the same elbow as the import preview) */
.kcap-elbow { flex-shrink: 0; width: 8px; height: 9px; margin: -9px -2px 0 -12px; box-sizing: border-box;
  border-left: 1.5px solid var(--hairline-strong); border-bottom: 1.5px solid var(--hairline-strong); border-bottom-left-radius: 4px; }
.kcap-rows .kprio { flex-shrink: 0; }
.kcap-ring { width: 12px; height: 12px; flex-shrink: 0; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--st-todo-fill, var(--st-todo)); }
.kcap-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kcap-row-meta { flex-shrink: 0; font-size: 11px; color: var(--ink-3); }
.kcap-rows .kcap-more { font-size: 12px; color: var(--ink-3); padding-left: 20px; }
.kcap-over { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 12px; border-radius: var(--r-md, 8px);
  background: var(--fill-1); font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kcap-over b { font-weight: 600; color: var(--ink); }
.kcap-over svg { flex-shrink: 0; margin-top: 2px; color: var(--icon-quiet, var(--ink-4)); }

.kcap-tip { display: flex; align-items: flex-start; gap: 8px; margin: 16px 0 0; min-height: 16px;
  font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kcap-tip svg { flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); }
.kcap-tip[data-added="true"] { color: var(--ink-2); }
.kcap-tip[data-added="true"] svg { color: var(--ok, var(--st-done)); }

.kcap-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; min-width: 0; }
.kcap-keys { display: inline-flex; align-items: center; gap: 4px; margin-right: auto; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); white-space: nowrap; }
.kcap-keys .kkbd:last-of-type { margin-right: 4px; }
.kcap-kanbo .kbtn-label { display: inline-flex; align-items: center; gap: 8px; }

.kcap-menu button { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); text-align: left; cursor: pointer; }
.kcap-menu button span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kcap-menu button > svg:last-child { color: var(--accent-text, var(--accent)); }
.kcap-menu button[aria-checked="true"] { color: var(--ink); font-weight: 600; }

@media (max-width: 859px) {
  /* the sheet's sides are 16px here: keep Close 12px in, as a titled sheet's is */
  .kcap-head { margin: -4px -4px 8px 0; }
  .kcap-input { font-size: 17px; }
  /* phone: the actions stack full width at touch height, the main one first */
  .kcap-foot { flex-direction: column-reverse; align-items: stretch; gap: 4px; }
  .kcap-foot .kbtn { width: 100%; height: var(--h-touch, 44px); justify-content: center; }
  .kcap-keys { display: none; }
  .kcap-multi-hint { margin-left: 0; flex-basis: 100%; }
}
@media (hover: none) { .kcap-keys { display: none; } }
`;

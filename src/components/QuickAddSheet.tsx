/* ============================================================
   KANBO — the phone's quick add.                                  [u7]
   A bottom sheet opened from the phone bar's centre + button: a big
   input with live highlighting of what the natural-language parser
   understood (lib/nlp parseTask + segments: dates, times, people,
   projects, priority, estimate — tap a token to undo it), chips for your
   recent projects, a voice-friendly layout (works with the keyboard's
   dictation: no time-outs, punctuation tolerated), Add / Add and keep
   going. Keyboard: Enter adds, Escape closes; labelled dialog; focus
   returns. Reduced motion: no slide. Read-only people never see it.

   • "Tap a token to undo it": each thing read shows as a chip under the
     field; tapping one keeps those words in the title instead (and a
     dashed chip offers to read them again).
   • A draft you close without adding is still there next time (this
     session), so a slip of the thumb never costs a dictated sentence.
   • The integrator lazy-loads this module (it's not in the first
     download) and mounts it for people who can write.
   • "/" for a template, as Quick capture: the picker under the field
     (or "From a template", for a thumb), the chosen title with its
     first {placeholder} selected, a strip saying what it adds; Add
     makes the task with its sub-tasks and checklist (onApplyTemplate).
   ============================================================ */
import { forwardRef, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon, Avatar, Button, PriorityGlyph, ProjectTile, Sheet } from "./primitives";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { getMember, todayISO, KANBO_TODAY, TAGS } from "../data/data";
import { segments, stripTokens, type NlpKind, type NlpSpan } from "../lib/nlp";
import {
  parseQuickAdd, quickAddTask, oneLine, liveKept, projectChips, readingSummary, tidyDictation,
  tokenWords, TOKEN_NOUN, type KeptToken,
} from "./phone/quickAdd";
import { captureTemplatePlan, type AppliedTemplatePlan } from "../lib/templatePlan";
import { CaptureTemplatePicker, CaptureTemplateStrip } from "./templates/CaptureTemplate";
import type { LibraryTemplate, Member, Project, TagDef, Task } from "../data/types";

export interface QuickAddSheetProps {
  open: boolean;
  onClose: () => void;
  /** (ownerId: a template's "project owner" sub-tasks go to them) */
  projects: (Pick<Project, "id" | "name" | "color" | "emoji" | "workspaceId"> & { ownerId?: string | null })[];
  members: Pick<Member, "id" | "name">[];
  /** newest first, at most 5 shown */
  recentProjectIds?: string[];
  defaultProjectId?: string;
  currentUserId: string;
  /** the same contract as QuickCapture's onCreate */
  onCreate: (partial: Partial<Task> & { title: string }) => void;
  /** "/" for a template (QuickCapture's contract): the task as typed, the template filling the rest, its sub-tasks
   *  and checklist. Without it, "/" is just a character. */
  onApplyTemplate?: (plan: AppliedTemplatePlan, template: LibraryTemplate) => void;
  /** the workspace this is in: whose template library, and whether a template's roles apply (null = Personal) */
  workspaceId?: string | null;
  /** the workspace's tags (a template's tags are matched against them) */
  tags?: Record<string, TagDef>;
}

/* ---------- this session's memory: the unsent draft, and the projects picked here ---------- */
interface Draft { text: string; kept: KeptToken[]; picked?: string; tpl?: LibraryTemplate | null }
let draft: Draft = { text: "", kept: [] };
let sessionPicks: string[] = [];
/** (tests) forget the draft and the picks */
export function resetQuickAddMemory(): void { draft = { text: "", kept: [] }; sessionPicks = []; }

export function QuickAddSheet({ open, onClose, projects, members, recentProjectIds, defaultProjectId, currentUserId, onCreate, onApplyTemplate, workspaceId, tags }: QuickAddSheetProps) {
  const [text, setText] = useState(draft.text);
  const [kept, setKept] = useState<KeptToken[]>(draft.kept);
  const [picked, setPicked] = useState<string | undefined>(draft.picked);
  const [added, setAdded] = useState<string | null>(null);
  const [allProjects, setAllProjects] = useState(false);
  // "/" for a template: the one chosen, and whether the picker was set aside (until the "/" goes)
  const [tpl, setTpl] = useState<LibraryTemplate | null>(draft.tpl ?? null);
  const [pickerOff, setPickerOff] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const isPhone = useMediaQuery("(max-width: 859px)");
  const uid = useId();
  const fieldId = `kqa-${uid.replace(/[^a-zA-Z0-9_-]/g, "")}-field`;

  // each opening starts from the unsent draft (if any)
  useEffect(() => {
    if (!open) return;
    setText(draft.text); setKept(draft.kept); setPicked(draft.picked); setTpl(draft.tpl ?? null); setPickerOff(false); setAdded(null); setAllProjects(false);
  }, [open]);
  useEffect(() => { if (open) draft = { text, kept, picked, tpl }; }, [open, text, kept, picked, tpl]);
  const slash = text.startsWith("/");
  const picking = !!onApplyTemplate && open && !tpl && !pickerOff && slash;
  useEffect(() => { if (!slash && pickerOff) setPickerOff(false); }, [slash, pickerOff]);

  // `today` keeps "today" / "fri" right in a sheet left open past midnight
  const today = todayISO();
  const ctx = useMemo(() => ({ today: new Date(KANBO_TODAY), projects, members, tags: TAGS }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, members, today]);
  const keptNow = useMemo(() => liveKept(text, kept), [text, kept]);
  const reading = useMemo(() => parseQuickAdd(text, ctx, keptNow), [text, ctx, keptNow]);

  const exists = (id: string) => projects.some((p) => p.id === id);
  // a typed #project wins; then a chip; then the project you're in
  const projectId = reading.projectId ?? (picked && exists(picked) ? picked : undefined) ?? (defaultProjectId && exists(defaultProjectId) ? defaultProjectId : undefined);
  const project = projects.find((p) => p.id === projectId);
  const assigneeId = reading.assigneeId;
  const person = assigneeId ? members.find((m) => m.id === assigneeId) : undefined;
  const chips = useMemo(() => projectChips({ defaultId: defaultProjectId, picked: sessionPicks, recent: recentProjectIds }, exists),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [defaultProjectId, recentProjectIds, projects, open]);
  const others = projects.filter((p) => !chips.includes(p.id));
  const title = picking ? "" : tidyDictation(reading.title);
  // what will be made, for screen readers (the chips say it to the eye)
  const tplSubs = tpl?.body.subtasks?.length ?? 0;
  const summary = title
    ? `${tpl ? `From the template ${tpl.name}${tplSubs ? `, with ${tplSubs} sub-task${tplSubs === 1 ? "" : "s"}` : ""}. ` : ""}${readingSummary(reading, { project: project?.name, person: person?.name, you: assigneeId === currentUserId })}`
    : "";

  const refocus = () => window.setTimeout(() => fieldRef.current?.focus({ preventScroll: true }), 0);
  const submit = (keepGoing: boolean) => {
    // (the picker has the keys while it's open: with nothing to pick, Enter waits for a match or Escape)
    if (picking) return;
    const partial = quickAddTask(reading, projectId);
    if (!partial) return;
    if (tpl && onApplyTemplate) {
      // what was typed wins (a date moves the sub-tasks with it); the template fills the rest
      const home = project ?? null;
      const plan = captureTemplatePlan(tpl, partial, {
        today: new Date(KANBO_TODAY), currentUserId, projectId, projectOwnerId: home?.ownerId ?? null,
        workspaceId: home && home.workspaceId !== undefined ? home.workspaceId ?? null : workspaceId ?? null, tags: tags ?? TAGS,
        typed: { priority: reading.priority, focusMin: reading.focusMin }, ...(reading.dueDate ? { dueDate: reading.dueDate } : {}),
      });
      onApplyTemplate(plan, tpl);
    } else onCreate(partial);
    if (projectId) sessionPicks = [projectId, ...sessionPicks.filter((id) => id !== projectId)].slice(0, 5);
    setText(""); setKept([]); setTpl(null);
    if (keepGoing) { setAdded(partial.title); refocus(); }
    else { draft = { text: "", kept: [], picked }; onClose(); }
  };
  const pickTemplate = (t: LibraryTemplate, [a, b]: [number, number]) => {
    setTpl(t); setPickerOff(false); setKept([]); setAdded(null);
    setText(oneLine(t.body.title));
    // the first {placeholder} is selected, ready to type (or say) over
    window.setTimeout(() => { const el = fieldRef.current; if (!el) return; el.focus({ preventScroll: true }); el.setSelectionRange(a, b); }, 0);
  };
  const removeTemplate = () => {
    if (tpl && text === oneLine(tpl.body.title)) setText("");
    setTpl(null);
    refocus();
  };
  /** "From a template": the picker, for a thumb ("/" in an empty field) */
  const startTemplate = () => { setText("/"); setPickerOff(false); refocus(); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); submit(e.shiftKey); return; }
    // Escape closes at once: nothing is lost (the draft waits for next time)
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  /** tap a token: those words stay in the title */
  const keepAsWords = (sp: NlpSpan) => {
    setKept((k) => [...k, { text: text.slice(sp.start, sp.end), kind: sp.kind }]);
    refocus();
  };
  const readAgain = (k: KeptToken) => { setKept((all) => all.filter((x) => !(x.kind === k.kind && x.text.toLowerCase() === k.text.toLowerCase()))); refocus(); };
  const pickProject = (id: string) => {
    // a chip takes over from a typed #project
    if (reading.spans.some((s) => s.kind === "project")) setText(stripTokens(text, reading.spans, ["project"]));
    setPicked((cur) => (cur === id && !reading.projectId ? undefined : id));
    setAllProjects(false);
  };

  const tipId = `${uid}-tip`;
  // a tap on a chip or "keep going" leaves the caret (and the phone's keyboard) in the field
  const keepFocus = (e: React.MouseEvent) => { if (document.activeElement === fieldRef.current) e.preventDefault(); };
  const footer = (
    <div className="kqa-foot">
      <Button variant="secondary" size={isPhone ? "lg" : "md"} icon="plus" disabled={!title} onMouseDown={keepFocus} onClick={() => submit(true)}>Add and keep going</Button>
      <Button variant={isPhone ? "hero" : "primary"} size={isPhone ? "lg" : "md"} kbd={isPhone ? undefined : "↵"} disabled={!title} onClick={() => submit(false)}>Add task</Button>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} side="bottom" label="Quick add a task" title="New task" width={560} initialFocus={fieldRef as React.RefObject<HTMLElement>} footer={footer}>
      <style>{QUICK_ADD_CSS}</style>
      <div className="kqa">
        <QuickAddField ref={fieldRef} id={fieldId} value={text} spans={picking ? [] : reading.spans} kept={picking ? [] : reading.kept} describedBy={tipId}
          onValueChange={(v) => { setText(oneLine(v)); if (added) setAdded(null); }} onKeyDown={onKeyDown} />
        <p className="sr-only" aria-live="polite">{summary}</p>

        {picking && (
          <CaptureTemplatePicker text={text} inputId={fieldId} workspaceId={workspaceId ?? null} currentUserId={currentUserId}
            onPick={pickTemplate} onClose={() => setPickerOff(true)} />
        )}
        {tpl && <CaptureTemplateStrip template={tpl} onRemove={removeTemplate} />}
        {onApplyTemplate && !tpl && !text && (
          <div className="kqa-chips" role="group" aria-label="Start from">
            <button type="button" className="kqa-chip" data-more="true" onMouseDown={keepFocus} onClick={startTemplate}>
              <Icon name="layers" size={14} sw={1.75} /><span>From a template</span>
            </button>
          </div>
        )}

        {!picking && (reading.spans.length > 0 || keptNow.length > 0) && (
          <div className="kqa-sec" role="group" aria-label="What Kanbo read">
            <ul className="kqa-toks">
              {reading.spans.map((sp) => {
                const words = text.slice(sp.start, sp.end);
                return (
                  <li key={`${sp.kind}-${sp.start}`}>
                    <button type="button" className="kqa-tok" data-kind={sp.kind} onMouseDown={keepFocus} onClick={() => keepAsWords(sp)}
                      aria-label={`${tokenWords(sp)}. Keep “${words}” as words instead`}>
                      <TokenIcon span={sp} projects={projects} members={members} />
                      <span className="kqa-tok-text">{sp.label}</span>
                      <Icon name="x" size={12} sw={2} className="kqa-tok-x" />
                    </button>
                  </li>
                );
              })}
              {keptNow.map((k) => (
                <li key={`kept-${k.kind}-${k.text}`}>
                  <button type="button" className="kqa-tok" data-kept="true" onMouseDown={keepFocus} onClick={() => readAgain(k)}
                    aria-label={`“${k.text}” stays as words. Read it as ${TOKEN_NOUN[k.kind]} again`}>
                    <Icon name="undo" size={12} sw={1.75} /><span className="kqa-tok-text">“{k.text}” as words</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {projects.length > 0 && (
          <div className="kqa-sec" role="group" aria-labelledby={`${uid}-proj`}>
            <h3 id={`${uid}-proj`} className="kqa-label">Project{reading.projectId ? <span className="kqa-label-note"> · from #{project?.name ?? "project"}</span> : null}</h3>
            <div className="kqa-chips">
              {chips.map((id) => {
                const p = projects.find((x) => x.id === id)!;
                return (
                  <button key={id} type="button" className="kqa-chip" aria-pressed={projectId === id} onMouseDown={keepFocus} onClick={() => pickProject(id)}>
                    <ProjectTile project={p} size={16} /><span>{p.name}</span>
                  </button>
                );
              })}
              {project && !chips.includes(project.id) && (
                <button type="button" className="kqa-chip" aria-pressed="true" onClick={() => pickProject(project.id)}>
                  <ProjectTile project={project} size={16} /><span>{project.name}</span>
                </button>
              )}
              {others.length > 0 && (
                <button type="button" className="kqa-chip" data-more="true" aria-expanded={allProjects} aria-controls={`${uid}-all`} onClick={() => setAllProjects((v) => !v)}>
                  <Icon name={allProjects ? "chevronDown" : "folder"} size={14} sw={1.75} /><span>{allProjects ? "Fewer" : `All projects`}</span>
                </button>
              )}
            </div>
            {allProjects && (
              <div id={`${uid}-all`} className="kqa-all" role="group" aria-label="All projects">
                {others.map((p) => (
                  <button key={p.id} type="button" className="kqa-row" aria-pressed={projectId === p.id} onClick={() => pickProject(p.id)}>
                    <ProjectTile project={p} size={20} /><span>{p.name}</span>
                    {projectId === p.id && <Icon name="check" size={16} sw={2.2} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="kqa-tip" id={tipId} data-added={added ? "true" : undefined} role={added ? "status" : undefined}>
          {added
            ? <><Icon name="check" size={16} sw={2} /><span>Added “{added}”. Say or type the next one.</span></>
            : <><Icon name="message" size={16} sw={1.75} /><span>Type it or use your keyboard’s microphone: “Call Sana tomorrow at 3pm #launch”. Tap anything read wrongly to keep it as words.</span></>}
        </p>
      </div>
    </Sheet>
  );
}

/* ---------- the field: transparent text over an aligned mirror that marks the tokens ---------- */

const QuickAddField = forwardRef<HTMLTextAreaElement, {
  id?: string;
  value: string;
  spans: NlpSpan[];
  kept: { start: number; end: number }[];
  describedBy?: string;
  onValueChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}>(function QuickAddField({ id, value, spans, kept, describedBy, onValueChange, onKeyDown }, ref) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const setRef = (el: HTMLTextAreaElement | null) => {
    own.current = el;
    if (typeof ref === "function") ref(el); else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = el;
  };
  const sync = () => { const f = own.current, m = mirror.current; if (f && m) { m.scrollTop = f.scrollTop; m.scrollLeft = f.scrollLeft; } };
  // grows with what's said (up to four lines, then scrolls)
  useLayoutEffect(() => {
    const f = own.current;
    if (!f) return;
    f.style.height = "auto";
    const h = f.scrollHeight;
    if (h > 0) { f.style.height = `${Math.min(h, 4 * 28 + 2)}px`; f.style.overflowY = h > 4 * 28 + 2 ? "auto" : "hidden"; }
    sync();
  }, [value]);
  // the phone keyboard's return key reads "done", and nothing second-guesses a dictated sentence
  useEffect(() => { own.current?.setAttribute("enterkeyhint", "done"); }, []);
  const marks: NlpSpan[] = useMemo(() => [...spans, ...kept.map((k) => ({ ...k, kind: "kept" as unknown as NlpKind, label: "" }))], [spans, kept]);
  return (
    <div className="kqa-field">
      <div ref={mirror} className="kqa-mirror" aria-hidden="true">
        {segments(value, marks).map((s, i) => (s.span
          ? <mark key={i} className="kqa-mark" data-kind={s.span.kind}>{s.text}</mark>
          : <span key={i}>{s.text}</span>))}
        {"​"}
      </div>
      <textarea ref={setRef} id={id} rows={1} value={value} aria-label="Task, in your own words" aria-describedby={describedBy}
        placeholder="What needs doing?" autoCapitalize="sentences" spellCheck={false} autoComplete="off" inputMode="text"
        className="kqa-text" data-focus-ring="none"
        onChange={(e) => onValueChange(e.target.value)} onKeyDown={onKeyDown} onScroll={sync} onSelect={sync} onKeyUp={sync} />
    </div>
  );
});

function TokenIcon({ span, projects, members }: { span: NlpSpan; projects: QuickAddSheetProps["projects"]; members: QuickAddSheetProps["members"] }): ReactNode {
  switch (span.kind) {
    case "date": case "start": return <Icon name="calendar" size={14} sw={1.75} />;
    case "time": case "duration": return <Icon name="clock" size={14} sw={1.75} />;
    case "repeat": return <Icon name="refresh" size={14} sw={1.75} />;
    case "estimate": return <Icon name="hourglass" size={14} sw={1.75} />;
    case "energy": return <Icon name="zap" size={14} sw={1.75} />;
    case "priority": {
      const p = (["urgent", "high", "medium", "low"] as const).find((x) => span.label.toLowerCase().startsWith(x));
      return p ? <PriorityGlyph priority={p} /> : <Icon name="flag" size={14} sw={1.75} />;
    }
    case "project": {
      const p = projects.find((x) => x.name === span.label);
      return p ? <ProjectTile project={p} size={16} /> : <Icon name="folder" size={14} sw={1.75} />;
    }
    case "person": {
      const m = members.find((x) => x.name === span.label);
      return m && getMember(m.id) ? <Avatar id={m.id} size={16} /> : <Icon name="user" size={14} sw={1.75} />;
    }
    case "tag": return <span className="kqa-tagdot" aria-hidden="true" />;
    default: return null;
  }
}

/* Read with fallbacks to today's tokens; the field mirrors Quick capture's (colour + halo only, so the
   two layers never drift). Phones: the actions stack full width at touch height, the main one first. */
export const QUICK_ADD_CSS = `
.kqa { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.kqa-field { position: relative; display: block; min-width: 0; font: 500 20px/28px var(--font-ui, var(--font-display)); letter-spacing: -0.01em; color: var(--ink); }
.kqa-mirror, .kqa-text {
  margin: 0; border: 0; box-sizing: border-box; padding: 0; font: inherit; letter-spacing: inherit; text-align: left; text-transform: none;
  white-space: pre-wrap; overflow-wrap: break-word; word-break: normal;
}
.kqa-mirror { position: absolute; inset: 0; overflow: hidden; color: var(--ink); pointer-events: none; }
.kqa-text {
  position: relative; display: block; width: 100%; min-height: 56px; resize: none; outline: none; overflow: hidden;
  background: transparent; color: transparent; -webkit-text-fill-color: transparent; caret-color: var(--accent-text, var(--accent));
}
.kqa-text::placeholder { color: var(--ink-4); -webkit-text-fill-color: var(--ink-4); opacity: 1; }
.kqa-mark {
  color: var(--accent-text, var(--accent)); background: var(--accent-tint, var(--accent-dim)); border-radius: var(--r-xs, 4px);
  box-shadow: -1px 0 0 var(--accent-tint, var(--accent-dim)), 1px 0 0 var(--accent-tint, var(--accent-dim));
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
/* words kept as words: quiet, so you can see the tap took */
.kqa-mark[data-kind="kept"] { color: var(--ink); background: none; box-shadow: none; text-decoration: underline dashed var(--hairline-strong); text-underline-offset: 4px; }

.kqa-sec { display: grid; gap: 8px; min-width: 0; }
.kqa-label { margin: 0; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kqa-label-note { font-weight: 500; color: var(--ink-4); }
.kqa-toks { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.kqa-tok, .kqa-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 36px; max-width: 100%; padding: 0 12px; box-sizing: border-box;
  border-radius: var(--r-md, 8px); border: 1px solid var(--hairline-strong); background: transparent; cursor: pointer;
  font: 600 13px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); white-space: nowrap;
  transition: background var(--d-1, 90ms) var(--ease), border-color var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease);
  -webkit-tap-highlight-color: transparent;
}
.kqa-tok { border-color: var(--accent-line, color-mix(in oklab, var(--accent) 45%, transparent)); background: var(--accent-tint, var(--accent-dim)); color: var(--accent-text, var(--accent)); }
.kqa-tok svg, .kqa-chip svg { flex-shrink: 0; }
.kqa-tok .kqa-tok-x { color: currentColor; opacity: 0.7; }
.kqa-tok[data-kept="true"] { border-style: dashed; border-color: var(--hairline-strong); background: transparent; color: var(--ink-3); font-weight: 500; }
.kqa-tok-text, .kqa-chip > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.kqa-tok:active, .kqa-chip:active, .kqa-row:active { background: var(--fill-2); }
.kqa-tagdot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
/* recent projects: one row that scrolls sideways on a phone */
.kqa-chips { display: flex; gap: 6px; overflow-x: auto; margin: 0 -24px; padding: 2px 24px 4px; scrollbar-width: none; overscroll-behavior-x: contain; }
.kqa-chips::-webkit-scrollbar { display: none; }
.kqa-chip { flex-shrink: 0; max-width: 220px; }
.kqa-chip:hover { background: var(--fill-1); color: var(--ink); }
.kqa-chip[aria-pressed="true"] {
  border-color: var(--accent-line, color-mix(in oklab, var(--accent) 45%, transparent));
  background: var(--accent-tint, var(--accent-dim)); color: var(--accent-text, var(--accent));
}
.kqa-chip[data-more="true"] { border-style: dashed; font-weight: 500; color: var(--ink-3); }
.kqa-all { display: grid; gap: 2px; max-height: 232px; overflow-y: auto; margin: 0 -8px; padding: 0 0 2px; overscroll-behavior: contain; }
.kqa-row {
  display: flex; align-items: center; gap: 12px; width: 100%; min-height: 44px; padding: 0 8px; border: 0; border-radius: var(--r-md, 8px);
  background: transparent; color: var(--ink); cursor: pointer; text-align: left; font: 500 15px/22px var(--font-ui, var(--font-display));
}
.kqa-row > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kqa-row > svg { color: var(--accent-text, var(--accent)); }
.kqa-row[aria-pressed="true"] { font-weight: 600; }
.kqa-row:hover { background: var(--fill-1); }
.kqa-tip { display: flex; align-items: flex-start; gap: 8px; margin: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kqa-tip svg { flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); }
.kqa-tip[data-added="true"] { color: var(--ink-2); }
.kqa-tip[data-added="true"] svg { color: var(--ok, var(--st-done)); }
.kqa-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; min-width: 0; }
@media (max-width: 859px) {
  .kqa-chips { margin: 0 -16px; padding-left: 16px; padding-right: 16px; }
  .kqa-foot { flex-direction: column-reverse; align-items: stretch; gap: 4px; }
  .kqa-foot .kbtn { width: 100%; height: var(--h-touch, 44px); justify-content: center; }
}
@media (prefers-reduced-motion: reduce) {
  .kqa-tok, .kqa-chip { transition: none; }
}
`;

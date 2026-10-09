/* ============================================================
   KANBO — "Save as template" (TaskDetail ⋯ menu).              [u9]
   A small sheet prefilled from the task (lib/templates templateFromTask):
   name, icon, what it keeps (title, description, priority, estimate,
   tags; sub-tasks with relative days and roles; checklist) — sub-tasks,
   checklist and dates can each be left out — "Share with <workspace>"
   for writers; Save → the library. People and dates stay with the task:
   sub-tasks go to roles (whoever uses it, the project owner or nobody)
   and dates become days after it's used.
   ============================================================ */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, EmojiPicker, Icon, Sheet, Toggle } from "../primitives";
import { Popover } from "../primitives/Popover";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  TEMPLATE_LIMITS, createLibraryTemplate, templateDayLabel, templateFailure, templateFromTask, templateRoleLabel,
} from "../../lib/templates";
import type { LibraryTemplate, TagDef, Task, TaskTemplateBody } from "../../data/types";
import { TemplateTile, safeId, useOptionalToast } from "./parts";
import { failureText } from "./failureText";
import "./templates.css";

export interface SaveAsTemplateProps {
  open: boolean;
  task: Task;
  /** the task's sub-tasks (tasks whose parentId is it) */
  subtasks: Task[];
  workspaceId: string | null;
  workspaceName?: string;
  canShare: boolean;
  onClose: () => void;
  onSaved?: (template: LibraryTemplate) => void;
  /** whose sub-tasks become "whoever uses it" (default: the task's assignee) */
  currentUserId?: string;
  /** whose become "the project owner" */
  projectOwnerId?: string | null;
  /** the workspace's tags: kept by label, so they're found wherever it's used */
  tags?: Record<string, TagDef>;
  /** "today" for the relative dates (pin it in tests) */
  today?: Date;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function SaveAsTemplate({ open, task, subtasks, workspaceId, workspaceName, canShare, onClose, onSaved, currentUserId, projectOwnerId, tags, today }: SaveAsTemplateProps) {
  const uid = safeId(useId());
  const id = (k: string) => `ktpl-save-${uid}-${k}`;
  const isPhone = useMediaQuery("(max-width: 859px)");
  const toast = useOptionalToast();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState<string | null>(null);
  const [keepSubs, setKeepSubs] = useState(true);
  const [keepList, setKeepList] = useState(true);
  const [keepDates, setKeepDates] = useState(true);
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const emojiBtn = useRef<HTMLButtonElement>(null);
  const ws = workspaceName || "the workspace";
  const shareable = canShare && workspaceId !== null;

  const full = useMemo(() => templateFromTask(task, subtasks, { today: today ?? new Date(), currentUserId, projectOwnerId, tags }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task, subtasks, currentUserId, projectOwnerId, tags]);

  useEffect(() => {
    if (!open) return;
    setName(task.title.replace(/\s+/g, " ").trim().slice(0, TEMPLATE_LIMITS.name));
    setEmoji(null); setKeepSubs(true); setKeepList(true); setKeepDates(true); setShared(false);
    setBusy(false); setError(null); setNameError(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task.id]);

  const subs = full.subtasks ?? [];
  const items = full.checklist ?? [];
  const hasDates = typeof full.dueOffsetDays === "number" || subs.some((s) => typeof s.offsetDays === "number");

  const body = (): TaskTemplateBody => {
    const b: TaskTemplateBody = { ...full };
    if (!keepSubs) delete b.subtasks;
    if (!keepList) delete b.checklist;
    if (!keepDates) {
      delete b.dueOffsetDays;
      if (b.subtasks) b.subtasks = b.subtasks.map(({ offsetDays: _o, ...s }) => s);
    }
    return b;
  };

  const save = () => {
    if (busy) return;
    const n = name.trim();
    if (!n || n.length > TEMPLATE_LIMITS.name) { setNameError(true); nameRef.current?.focus(); return; }
    setBusy(true); setError(null);
    createLibraryTemplate({ workspaceId, name: n, emoji, body: body(), shared: shareable && shared }).then((t) => {
      const text = t.shared ? `Saved “${t.name}” and shared it with ${ws}` : `Saved “${t.name}” to your templates`;
      toast?.success(text);
      onSaved?.(t);
      onClose();
    }, (e) => { setError(failureText(templateFailure(e))); setBusy(false); });
  };

  const size = isPhone ? "lg" : "md";
  const footer = (
    <div className="ktpl-save-foot">
      <Button variant="ghost" size={size} onClick={onClose} disabled={busy}>Cancel</Button>
      <Button variant="primary" size={size} icon="layers" loading={busy} onClick={save}>Save template</Button>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} label="Save as template" title="Save as template" width={560} footer={footer} initialFocus={nameRef as React.RefObject<HTMLElement>}>
      <form className="ktpl-save" onSubmit={(e) => { e.preventDefault(); save(); }} noValidate>
        {error && <p className="ktpl-msg" data-tone="signal" role="alert">{error}</p>}
        <div className="ktpl-ed-ident">
          <button ref={emojiBtn} type="button" className="ktpl-ed-icon" aria-haspopup="dialog" aria-expanded={emojiOpen}
            aria-label={emoji ? `Icon: ${emoji}. Change icon` : "Choose an icon"} onClick={() => setEmojiOpen((v) => !v)}>
            <TemplateTile template={{ id: "save-" + task.id, name: name || task.title, emoji }} size={44} />
          </button>
          <div className="ktpl-ed-field ktpl-ed-grow">
            <label htmlFor={id("name")}>Template name</label>
            <input ref={nameRef} id={id("name")} className="kfield" value={name} autoComplete="off"
              onChange={(e) => { setName(e.target.value); if (nameError) setNameError(false); }}
              aria-invalid={nameError || undefined} aria-describedby={nameError ? id("name-err") : undefined} />
            {nameError && <span id={id("name-err")} className="ktpl-ed-hint" data-tone="signal">{name.trim() ? `Keep it to ${TEMPLATE_LIMITS.name} characters.` : "Give the template a name."}</span>}
          </div>
        </div>
        <Popover open={emojiOpen} anchorRef={emojiBtn} onClose={() => setEmojiOpen(false)} role="dialog" label="Choose an icon" minWidth={268} style={{ padding: 0 }}>
          <EmojiPicker onPick={(e) => { setEmoji(e); setEmojiOpen(false); }} />
          {emoji && (
            <div className="ktpl-ed-noicon">
              <Button size="sm" variant="ghost" icon="x" onClick={() => { setEmoji(null); setEmojiOpen(false); }}>No icon</Button>
            </div>
          )}
        </Popover>

        <div className="ktpl-save-keeps">
          <p className="ktpl-save-k">It keeps</p>
          <p className="ktpl-save-base"><Icon name="check" size={14} sw={2} /><span>The title, description, priority, focus time and tags</span></p>
          {subs.length > 0 && (
            <label className="ktpl-save-opt">
              <input type="checkbox" checked={keepSubs} onChange={(e) => setKeepSubs(e.target.checked)} />
              <span>{plural(subs.length, "sub-task")}<span className="ktpl-save-sub"> and who each one goes to</span></span>
            </label>
          )}
          {items.length > 0 && (
            <label className="ktpl-save-opt">
              <input type="checkbox" checked={keepList} onChange={(e) => setKeepList(e.target.checked)} />
              <span>The checklist ({plural(items.length, "item")})</span>
            </label>
          )}
          {hasDates && (
            <label className="ktpl-save-opt">
              <input type="checkbox" checked={keepDates} onChange={(e) => setKeepDates(e.target.checked)} />
              <span>Due dates<span className="ktpl-save-sub">, as days after it's used</span></span>
            </label>
          )}
        </div>

        {keepSubs && subs.length > 0 && (
          <ol className="ktpl-pv-subs ktpl-save-subs" aria-label="Sub-tasks it keeps">
            {subs.slice(0, 8).map((s, i) => (
              <li key={i}>
                <span className="ktpl-ring" aria-hidden="true" />
                <span className="ktpl-pv-subtitle">{s.title}</span>
                {keepDates && typeof s.offsetDays === "number" && <span className="ktpl-pv-when">{templateDayLabel(s.offsetDays)}</span>}
                <span className="ktpl-pv-role" data-role={s.assigneeRole ?? "me"}><Icon name="user" size={12} sw={2} />{templateRoleLabel(s.assigneeRole)}</span>
              </li>
            ))}
            {subs.length > 8 && <li className="ktpl-more">and {subs.length - 8} more</li>}
          </ol>
        )}

        {shareable && (
          <div className="ktpl-ed-share">
            <Toggle checked={shared} onChange={setShared} label={`Share with ${ws}`}
              description={`Everyone in ${ws} can use it; owners and admins can edit it too.`} />
          </div>
        )}
        <p className="ktpl-pv-note">
          <Icon name="layers" size={14} sw={1.75} />
          <span>Find it under Templates, or type / in a new task's title.</span>
        </p>
        <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
      </form>
    </Sheet>
  );
}

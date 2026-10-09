/* ============================================================
   KANBO — the template editor (the library's "New template",
   "Edit" and "Make a copy").                                  [u9]
   Name and icon; the task it makes (title with {placeholders},
   description, priority, focus time, due day, tags); its sub-tasks
   (title, due day, who it goes to) and checklist, each reordered with
   Move up / Move down — there's no dragging to learn; sharing with the
   workspace for writers. Days are "days after it's used". Problems are
   listed at the top (role="alert") and marked on their fields.
   ============================================================ */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, EmojiPicker, Icon, IconButton, Toggle } from "../primitives";
import { Popover } from "../primitives/Popover";
import { PRIORITY_META } from "../../data/data";
import { TEMPLATE_LIMITS, templateBodyBytes, templateRoleLabel } from "../../lib/templates";
import type { Priority, TaskTemplateBody, TemplateAssigneeRole, TemplateSubtask } from "../../data/types";
import { TemplateTile, safeId } from "./parts";
import "./templates.css";

export interface TemplateDraft {
  name: string;
  emoji: string | null;
  body: TaskTemplateBody;
  shared: boolean;
}

export interface TemplateEditorProps {
  mode: "new" | "edit";
  initial: TemplateDraft;
  /** an id for the tile's colour (the template's, or "new") */
  tileId: string;
  /** offer "Share with <workspace>" */
  canShareHere: boolean;
  workspaceName?: string;
  busy?: boolean;
  /** a save that failed, in words */
  error?: string | null;
  onSave: (draft: TemplateDraft) => void;
  onCancel: () => void;
  /** the draft differs from what it started as (the host asks before throwing it away) */
  onDirtyChange?: (dirty: boolean) => void;
}

const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];
const FOCUS_STEPS = [15, 30, 45, 60, 90, 120, 180, 240];
const fmtMin = (m: number) => (m < 60 ? `${m}m` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);
const ROLES: TemplateAssigneeRole[] = ["me", "project_owner", "unassigned"];

/* rows carry a key that survives reordering */
interface SubRow { key: number; title: string; days: string; role: TemplateAssigneeRole }
interface ItemRow { key: number; text: string }
let rowSeq = 0;
const nextKey = () => ++rowSeq;

const daysText = (n: number | undefined) => (typeof n === "number" ? String(n) : "");
const readDays = (s: string): number | undefined => {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? Math.min(365, Math.max(0, Math.round(n))) : undefined;
};

type Problem = { field: string; text: string };

export function TemplateEditor({ mode, initial, tileId, canShareHere, workspaceName, busy, error, onSave, onCancel, onDirtyChange }: TemplateEditorProps) {
  const uid = safeId(useId());
  const id = (k: string) => `ktpl-ed-${uid}-${k}`;
  const [name, setName] = useState(initial.name);
  const [emoji, setEmoji] = useState<string | null>(initial.emoji);
  const [title, setTitle] = useState(initial.body.title);
  const [description, setDescription] = useState(initial.body.description ?? "");
  const [priority, setPriority] = useState<Priority>(initial.body.priority ?? "medium");
  const [estimate, setEstimate] = useState<number>(initial.body.estimate ?? 30);
  const [due, setDue] = useState(daysText(initial.body.dueOffsetDays));
  const [tags, setTags] = useState<string[]>(initial.body.tags ?? []);
  const [tagText, setTagText] = useState("");
  const [subs, setSubs] = useState<SubRow[]>(() => (initial.body.subtasks ?? []).map((s) => ({ key: nextKey(), title: s.title, days: daysText(s.offsetDays), role: s.assigneeRole ?? "me" })));
  const [items, setItems] = useState<ItemRow[]>(() => (initial.body.checklist ?? []).map((text) => ({ key: nextKey(), text })));
  const [shared, setShared] = useState(initial.shared);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [announce, setAnnounce] = useState("");
  const emojiBtn = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => { nameRef.current?.focus({ preventScroll: true }); }, []);

  const body = useMemo<TaskTemplateBody>(() => {
    const b: TaskTemplateBody = { title: title.trim() };
    if (description.trim()) b.description = description.replace(/\s+$/, "");
    b.priority = priority;
    b.estimate = estimate;
    const d = readDays(due);
    if (d !== undefined) b.dueOffsetDays = d;
    if (tags.length) b.tags = tags;
    const st = subs.filter((s) => s.title.trim()).map((s): TemplateSubtask => {
      const x: TemplateSubtask = { title: s.title.trim(), assigneeRole: s.role };
      const n = readDays(s.days);
      if (n !== undefined) x.offsetDays = n;
      return x;
    });
    if (st.length) b.subtasks = st;
    const cl = items.map((i) => i.text.trim()).filter(Boolean);
    if (cl.length) b.checklist = cl;
    return b;
  }, [title, description, priority, estimate, due, tags, subs, items]);

  const draft: TemplateDraft = { name: name.trim(), emoji, body, shared: canShareHere ? shared : initial.shared };
  // dirty = differs from the draft as it first rendered (the same shape, so no false alarms)
  const json = JSON.stringify(draft);
  const firstJson = useRef<string | null>(null);
  if (firstJson.current === null) firstJson.current = json;
  const dirty = json !== firstJson.current;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const check = (): Problem[] => {
    const out: Problem[] = [];
    if (!name.trim()) out.push({ field: "name", text: "Give the template a name." });
    else if (name.trim().length > TEMPLATE_LIMITS.name) out.push({ field: "name", text: `Keep the name to ${TEMPLATE_LIMITS.name} characters.` });
    if (!title.trim()) out.push({ field: "title", text: "Say what the task is called." });
    else if (title.trim().length > TEMPLATE_LIMITS.title) out.push({ field: "title", text: `Keep the task's title to ${TEMPLATE_LIMITS.title} characters.` });
    if (subs.length > TEMPLATE_LIMITS.subtasks) out.push({ field: "subs", text: `A template takes up to ${TEMPLATE_LIMITS.subtasks} sub-tasks.` });
    if (items.length > TEMPLATE_LIMITS.checklist) out.push({ field: "items", text: `A template takes up to ${TEMPLATE_LIMITS.checklist} checklist items.` });
    if (!out.length && templateBodyBytes(body) > TEMPLATE_LIMITS.bodyBytes) out.push({ field: "description", text: "This template is too big to save. Shorten the description or remove some items." });
    return out;
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const found = check();
    setProblems(found);
    if (found.length) {
      window.setTimeout(() => formRef.current?.querySelector<HTMLElement>(`[data-field="${found[0].field}"]`)?.focus(), 0);
      return;
    }
    onSave(draft);
  };
  const bad = (field: string) => problems.some((p) => p.field === field);
  const errId = id("problems");

  /* ---- lists ---- */
  const moveIn = <T,>(list: T[], i: number, by: number): T[] => {
    const j = i + by;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };
  const focusRow = (prefix: string, key: number, part: string) =>
    window.setTimeout(() => document.getElementById(`${id(prefix)}-${key}-${part}`)?.focus(), 0);
  const addSub = () => {
    if (subs.length >= TEMPLATE_LIMITS.subtasks) return;
    const key = nextKey();
    setSubs((s) => [...s, { key, title: "", days: "", role: "me" }]);
    focusRow("sub", key, "title");
  };
  const moveSub = (i: number, by: number) => {
    const row = subs[i];
    const next = moveIn(subs, i, by);
    if (next === subs) return;
    setSubs(next);
    setAnnounce(`Moved “${row.title || "untitled"}” to position ${i + by + 1} of ${subs.length}.`);
    focusRow("sub", row.key, by < 0 ? "up" : "down");
  };
  const removeSub = (i: number) => {
    const row = subs[i];
    const next = subs.filter((_, j) => j !== i);
    setSubs(next);
    setAnnounce(`Removed “${row.title || "untitled"}”.`);
    const neighbour = next[i] ?? next[i - 1];
    if (neighbour) focusRow("sub", neighbour.key, "title");
    else window.setTimeout(() => document.getElementById(id("add-sub"))?.focus(), 0);
  };
  const addItem = () => {
    if (items.length >= TEMPLATE_LIMITS.checklist) return;
    const key = nextKey();
    setItems((s) => [...s, { key, text: "" }]);
    focusRow("item", key, "text");
  };
  const moveItem = (i: number, by: number) => {
    const row = items[i];
    const next = moveIn(items, i, by);
    if (next === items) return;
    setItems(next);
    setAnnounce(`Moved “${row.text || "untitled"}” to position ${i + by + 1} of ${items.length}.`);
    focusRow("item", row.key, by < 0 ? "up" : "down");
  };
  const removeItem = (i: number) => {
    const row = items[i];
    const next = items.filter((_, j) => j !== i);
    setItems(next);
    setAnnounce(`Removed “${row.text || "untitled"}”.`);
    const neighbour = next[i] ?? next[i - 1];
    if (neighbour) focusRow("item", neighbour.key, "text");
    else window.setTimeout(() => document.getElementById(id("add-item"))?.focus(), 0);
  };
  // Enter in a row's text adds the next row (a list is typed top to bottom)
  const enterAdds = (add: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); add(); }
  };

  /* ---- tags ---- */
  const addTags = (raw: string) => {
    const words = raw.split(",").map((w) => w.trim()).filter(Boolean);
    if (!words.length) return;
    setTags((ts) => {
      const have = new Set(ts.map((t) => t.toLowerCase()));
      const add = words.filter((w) => { const k = w.toLowerCase(); if (have.has(k)) return false; have.add(k); return true; });
      return [...ts, ...add].slice(0, 20);
    });
    setTagText("");
  };
  const onTagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === ",") && !e.nativeEvent.isComposing) {
      if (!tagText.trim()) { if (e.key === "Enter") e.preventDefault(); return; }
      e.preventDefault(); addTags(tagText);
    } else if (e.key === "Backspace" && !tagText && tags.length) {
      setTags((ts) => ts.slice(0, -1));
    }
  };

  const look = { id: tileId, name: name || "New template", emoji };
  const descCount = description.length;

  return (
    <form ref={formRef} className="ktpl-ed" onSubmit={submit} noValidate aria-describedby={problems.length ? errId : undefined}>
      {problems.length > 0 && (
        <div id={errId} className="ktpl-ed-problems" role="alert">
          <Icon name="alert" size={16} sw={1.75} />
          <ul>{problems.map((p) => <li key={p.field + p.text}>{p.text}</li>)}</ul>
        </div>
      )}
      {error && <p className="ktpl-msg" data-tone="signal" role="alert">{error}</p>}

      <div className="ktpl-ed-ident">
        <button ref={emojiBtn} type="button" className="ktpl-ed-icon" aria-haspopup="dialog" aria-expanded={emojiOpen}
          aria-label={emoji ? `Icon: ${emoji}. Change icon` : "Choose an icon"} onClick={() => setEmojiOpen((v) => !v)}>
          <TemplateTile template={look} size={44} />
        </button>
        <div className="ktpl-ed-field ktpl-ed-grow">
          <label htmlFor={id("name")}>Template name</label>
          <input ref={nameRef} id={id("name")} data-field="name" className="kfield" value={name} maxLength={TEMPLATE_LIMITS.name + 20}
            onChange={(e) => setName(e.target.value)} aria-invalid={bad("name") || undefined} placeholder="e.g. Client onboarding" autoComplete="off" />
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

      <fieldset className="ktpl-ed-set">
        <legend>The task it makes</legend>
        <div className="ktpl-ed-field">
          <label htmlFor={id("title")}>Title</label>
          <input id={id("title")} data-field="title" className="kfield" value={title} onChange={(e) => setTitle(e.target.value)}
            aria-invalid={bad("title") || undefined} aria-describedby={id("title-hint")} placeholder="e.g. Onboard {client}" autoComplete="off" />
          <span id={id("title-hint")} className="ktpl-ed-hint">Put words to fill in between braces, like {"{client}"}: they're selected for typing over when the template's used.</span>
        </div>
        <div className="ktpl-ed-field">
          <label htmlFor={id("desc")}>Description</label>
          <textarea id={id("desc")} data-field="description" className="kfield ktpl-ed-desc" value={description} rows={4}
            onChange={(e) => setDescription(e.target.value)} aria-invalid={bad("description") || undefined}
            placeholder="Headings with **bold**, lists with -" />
          {descCount > 4000 && <span className="ktpl-ed-hint mono">{descCount.toLocaleString("en-GB")} characters</span>}
        </div>
        <div className="ktpl-ed-grid">
          <div className="ktpl-ed-field">
            <label htmlFor={id("prio")}>Priority</label>
            <select id={id("prio")} className="kfield" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
            </select>
          </div>
          <div className="ktpl-ed-field">
            <label htmlFor={id("focus")}>Focus time</label>
            <select id={id("focus")} className="kfield" value={estimate} onChange={(e) => setEstimate(Number(e.target.value))}>
              {[...new Set([...FOCUS_STEPS, estimate])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{fmtMin(m)}</option>)}
            </select>
          </div>
          <div className="ktpl-ed-field">
            <label htmlFor={id("due")}>Due</label>
            <span className="ktpl-ed-days">
              <input id={id("due")} className="kfield" type="number" inputMode="numeric" min={0} max={365} value={due}
                onChange={(e) => setDue(e.target.value)} placeholder="–" aria-describedby={id("due-hint")} />
              <span id={id("due-hint")}>days after it's used</span>
            </span>
          </div>
        </div>
        <div className="ktpl-ed-field">
          <label htmlFor={id("tags")}>Tags</label>
          <div className="ktpl-ed-tags">
            {tags.map((t) => (
              <span key={t} className="ktpl-tag">
                {t}
                <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setTags((ts) => ts.filter((x) => x !== t))}>
                  <Icon name="x" size={12} sw={2} />
                </button>
              </span>
            ))}
            <input id={id("tags")} className="ktpl-ed-tagin" value={tagText} onChange={(e) => setTagText(e.target.value)} onKeyDown={onTagKey}
              onBlur={() => addTags(tagText)} placeholder={tags.length ? "Add another" : "Type a tag and press Enter"} aria-describedby={id("tags-hint")} autoComplete="off" />
          </div>
          <span id={id("tags-hint")} className="ktpl-ed-hint">Matched by name in the workspace it's used in; a tag it doesn't have is left off.</span>
        </div>
      </fieldset>

      <fieldset className="ktpl-ed-set" data-field="subs" tabIndex={-1}>
        <legend>Sub-tasks <span className="ktpl-ed-count">{subs.length}</span></legend>
        {subs.length > 0 && (
          <ol className="ktpl-ed-rows" data-kind="subs">
            {subs.map((s, i) => {
              const n = i + 1;
              const rid = `${id("sub")}-${s.key}`;
              return (
                <li key={s.key} className="ktpl-ed-row">
                  <input id={`${rid}-title`} className="kfield ktpl-ed-rowtitle" value={s.title} aria-label={`Sub-task ${n}`}
                    onChange={(e) => setSubs((xs) => xs.map((x) => (x.key === s.key ? { ...x, title: e.target.value } : x)))}
                    onKeyDown={enterAdds(addSub)} placeholder="What needs doing" autoComplete="off" />
                  <span className="ktpl-ed-days" data-compact="">
                    <input id={`${rid}-days`} className="kfield" type="number" inputMode="numeric" min={0} max={365} value={s.days}
                      aria-label={`Sub-task ${n} due, days after it's used`} placeholder="–"
                      onChange={(e) => setSubs((xs) => xs.map((x) => (x.key === s.key ? { ...x, days: e.target.value } : x)))} />
                    <span aria-hidden="true">days</span>
                  </span>
                  <select className="kfield ktpl-ed-role" value={s.role} aria-label={`Sub-task ${n} goes to`}
                    onChange={(e) => setSubs((xs) => xs.map((x) => (x.key === s.key ? { ...x, role: e.target.value as TemplateAssigneeRole } : x)))}>
                    {ROLES.map((r) => <option key={r} value={r}>{r === "me" ? "Whoever uses it" : templateRoleLabel(r)}</option>)}
                  </select>
                  <span className="ktpl-ed-rowacts">
                    <IconButton id={`${rid}-up`} icon="chevronDown" className="ktpl-up" size="sm" label={`Move sub-task ${n} up`} disabled={i === 0} onClick={() => moveSub(i, -1)} />
                    <IconButton id={`${rid}-down`} icon="chevronDown" size="sm" label={`Move sub-task ${n} down`} disabled={i === subs.length - 1} onClick={() => moveSub(i, 1)} />
                    <IconButton icon="x" size="sm" tone="danger" label={`Remove sub-task ${n}`} onClick={() => removeSub(i)} />
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <Button id={id("add-sub")} type="button" size="sm" variant="ghost" icon="plus" onClick={addSub} disabled={subs.length >= TEMPLATE_LIMITS.subtasks}>Add sub-task</Button>
      </fieldset>

      <fieldset className="ktpl-ed-set" data-field="items" tabIndex={-1}>
        <legend>Checklist <span className="ktpl-ed-count">{items.length}</span></legend>
        {items.length > 0 && (
          <ul className="ktpl-ed-rows" data-kind="items">
            {items.map((it, i) => {
              const n = i + 1;
              const rid = `${id("item")}-${it.key}`;
              return (
                <li key={it.key} className="ktpl-ed-row" data-kind="item">
                  <span className="ktpl-box" aria-hidden="true" />
                  <input id={`${rid}-text`} className="kfield ktpl-ed-rowtitle" value={it.text} aria-label={`Checklist item ${n}`}
                    onChange={(e) => setItems((xs) => xs.map((x) => (x.key === it.key ? { ...x, text: e.target.value } : x)))}
                    onKeyDown={enterAdds(addItem)} placeholder="Something to tick off" autoComplete="off" />
                  <span className="ktpl-ed-rowacts">
                    <IconButton id={`${rid}-up`} icon="chevronDown" className="ktpl-up" size="sm" label={`Move checklist item ${n} up`} disabled={i === 0} onClick={() => moveItem(i, -1)} />
                    <IconButton id={`${rid}-down`} icon="chevronDown" size="sm" label={`Move checklist item ${n} down`} disabled={i === items.length - 1} onClick={() => moveItem(i, 1)} />
                    <IconButton icon="x" size="sm" tone="danger" label={`Remove checklist item ${n}`} onClick={() => removeItem(i)} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <Button id={id("add-item")} type="button" size="sm" variant="ghost" icon="plus" onClick={addItem} disabled={items.length >= TEMPLATE_LIMITS.checklist}>Add checklist item</Button>
      </fieldset>

      {canShareHere && (
        <div className="ktpl-ed-share">
          <Toggle checked={shared} onChange={setShared} label={`Share with ${workspaceName || "the workspace"}`}
            description={`Everyone in ${workspaceName || "the workspace"} can use it; owners and admins can edit it too.`} />
        </div>
      )}

      <p className="sr-only" aria-live="polite">{announce}</p>
      <div className="ktpl-ed-foot">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" icon={mode === "new" ? "plus" : "check"} loading={busy}>
          {mode === "new" ? "Create template" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

/* ============================================================
   KANBO — the meeting's notes, beside the stage: what's been logged on
   this agenda item (or the whole meeting), and a one-line composer.
   A line is a note, a decision or an action (an action has an owner
   and a day). Every line can become a task with an owner through
   Extract tasks ("Make task"); one that has, shows its task's status.
   Everyone in the room writes here, and sees the others' lines as
   they're added.
   ============================================================ */
import { useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { DateChip, Icon, IconButton, StatusGlyph } from "../primitives";
import type { Task } from "../../data/types";
import { KANBO_TODAY, toLocalISO } from "../../data/data";
import { actionState } from "../../lib/meetings/agenda";
import { actionTail } from "../../lib/meetings/notes";
import type { ItemInput } from "../../lib/meetings/sync";
import type { MeetingItem, MeetingItemKind } from "../../lib/meetings/types";

export const KIND_WORD: Record<MeetingItemKind, string> = { note: "Note", decision: "Decision", action: "Action" };
const PLACEHOLDER: Record<MeetingItemKind, string> = {
  note: "Add a note",
  decision: "What did you decide?",
  action: "What needs doing?",
};

/** One logged line: its kind, its words, an action's owner and day, and its task (or Make task). */
export function NoteLine({ it, nameOf, taskById, onOpenTask, onMakeTask, onDelete, where }: {
  it: MeetingItem;
  nameOf: (id: string) => string | undefined;
  taskById: ReadonlyMap<string, Task>;
  onOpenTask: (id: string) => void;
  onMakeTask?: (it: MeetingItem) => void;
  onDelete?: (it: MeetingItem) => void;
  /** the agenda item it was logged on, when the list spans the meeting */
  where?: string;
}) {
  const task = it.taskId ? taskById.get(it.taskId) : undefined;
  const tail = it.kind === "action" ? actionTail(it, nameOf) : "";
  // (where its task stands now: "Done", "Blocked", "Overdue · due 6 Nov", "Open · due 16 Nov")
  const state = task ? actionState({ taskId: task.id, due: it.due }, task, toLocalISO(KANBO_TODAY)) : null;
  return (
    <li className="kmtg-line" data-kind={it.kind}>
      <span className="kmtg-line-kind" data-kind={it.kind}>{KIND_WORD[it.kind]}</span>
      <span className="kmtg-line-body">
        <span className="kmtg-line-text">{it.body}</span>
        {(tail || where) && <span className="kmtg-line-meta">{[tail, where].filter(Boolean).join(" · ")}</span>}
        {task ? (
          <button type="button" className="kmtg-line-task" data-state={state?.state} onClick={() => onOpenTask(task.id)} aria-label={`Open the task: ${state?.label ?? "Task"}`}>
            <StatusGlyph status={task.status} size={14} /><span>{state?.label ?? "Task"}</span>
          </button>
        ) : it.taskId ? <span className="kmtg-line-meta">Task made</span>
          : onMakeTask ? <button type="button" className="kmtg-line-make" onClick={() => onMakeTask(it)}><Icon name="plus" size={12} />Make task</button> : null}
      </span>
      {onDelete && <IconButton icon="x" size="sm" label={`Remove “${it.body}”`} className="kmtg-line-del" onClick={() => onDelete(it)} />}
    </li>
  );
}

export function RoomNotes({ items, agendaKey, agendaTitle, people, canWrite, onAdd, onDelete, onMakeTask, nameOf, taskById, onOpenTask, composerRef, scope, onScope }: {
  items: readonly MeetingItem[];
  /** the item on the stage (null: the wrap-up, where lines are logged at large) */
  agendaKey: string | null;
  agendaTitle: (key: string | null) => string | undefined;
  people: { id: string; name: string }[];
  canWrite: boolean;
  onAdd: (input: ItemInput) => Promise<boolean>;
  onDelete?: (it: MeetingItem) => void;
  onMakeTask?: (it: MeetingItem) => void;
  nameOf: (id: string) => string | undefined;
  taskById: ReadonlyMap<string, Task>;
  onOpenTask: (id: string) => void;
  composerRef?: RefObject<HTMLInputElement>;
  scope: "item" | "all";
  onScope: (s: "item" | "all") => void;
}) {
  const [kind, setKind] = useState<MeetingItemKind>("note");
  const [text, setText] = useState("");
  const [owner, setOwner] = useState<string>("");
  const [due, setDue] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const shown = scope === "all" ? items : items.filter((i) => (i.agendaKey ?? null) === agendaKey);
  const here = agendaTitle(agendaKey);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    const ok = await onAdd({ kind, body, agendaKey, ownerId: kind === "action" && owner ? owner : null, due: kind === "action" ? due ?? null : null, taskId: null });
    setBusy(false);
    if (ok) { setText(""); setDue(undefined); }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && text === "") { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); }
  };

  return (
    <div className="kmtg-notes-in">
      <div className="kmtg-notes-head">
        <h2 className="kmtg-notes-h">Notes</h2>
        <div className="kmtg-scope" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" aria-checked={scope === "item"} onClick={() => onScope("item")}>This item</button>
          <button type="button" role="radio" aria-checked={scope === "all"} onClick={() => onScope("all")}>All · {items.length}</button>
        </div>
      </div>
      {shown.length ? (
        <ul className="kmtg-lines" aria-live="polite">
          {shown.map((it) => (
            <NoteLine key={it.id} it={it} nameOf={nameOf} taskById={taskById} onOpenTask={onOpenTask}
              onMakeTask={canWrite ? onMakeTask : undefined} onDelete={canWrite ? onDelete : undefined}
              where={scope === "all" && it.agendaKey && it.agendaKey !== agendaKey ? agendaTitle(it.agendaKey) : undefined} />
          ))}
        </ul>
      ) : (
        <p className="kmtg-notes-empty">{scope === "all" ? "Nothing logged yet." : `Nothing logged on ${here ?? "this item"} yet.`}</p>
      )}
      {canWrite && (
        <form className="kmtg-compose" onSubmit={(e) => void submit(e)}>
          <div className="kmtg-kinds" role="radiogroup" aria-label="Kind of line">
            {(["note", "decision", "action"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} data-kind={k} onClick={() => setKind(k)}>{KIND_WORD[k]}</button>
            ))}
          </div>
          <input ref={composerRef} className="kmtg-compose-in" value={text} maxLength={1000} placeholder={PLACEHOLDER[kind]}
            aria-label={`${KIND_WORD[kind]}${here ? ` on ${here}` : ""}`} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
          {kind === "action" && (
            <div className="kmtg-compose-row">
              <select className="kmtg-select" aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">No owner yet</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <DateChip value={due} onChange={(d) => setDue(d)} label="Due" placeholder="Due" />
            </div>
          )}
          <button type="submit" className="kmtg-compose-go" disabled={!text.trim() || busy}>
            <Icon name="plus" size={14} />Add {KIND_WORD[kind].toLowerCase()}
          </button>
        </form>
      )}
    </div>
  );
}

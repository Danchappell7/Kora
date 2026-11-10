/* ============================================================
   KANBO — the end of a meeting. RoomWrap: the agenda's last item,
   with every decision and action logged, Turn into tasks (Extract
   tasks over the lines that aren't tasks yet), the notes doc, and End
   meeting (the recap goes to everyone asked or there). RoomRecap: a
   meeting once it's ended, as the Inbox opens it: what was decided,
   each action and where it stands now, the notes, and the doc.
   ============================================================ */
import { Button, Icon } from "../primitives";
import type { Task } from "../../data/types";
import { itemsLine, meetingDay } from "../../lib/meetings/agenda";
import type { Meeting, MeetingItem } from "../../lib/meetings/types";
import { NoteLine } from "./RoomNotes";

const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface WrapContext {
  nameOf: (id: string) => string | undefined;
  taskById: ReadonlyMap<string, Task>;
  onOpenTask: (id: string) => void;
  onMakeTask?: (it: MeetingItem) => void;
  onDelete?: (it: MeetingItem) => void;
  agendaTitle: (key: string | null) => string | undefined;
}

/** "3 decisions and 4 actions, 2 of them tasks with an owner." */
export function wrapSentence(items: readonly MeetingItem[]): string {
  const d = items.filter((i) => i.kind === "decision").length;
  const acts = items.filter((i) => i.kind === "action");
  const owned = acts.filter((i) => i.taskId).length;
  if (!d && !acts.length) return "Nothing logged yet. Add decisions and actions as you go, or leave it there.";
  const head = [d ? plural(d, "decision") : "", acts.length ? plural(acts.length, "action") : ""].filter(Boolean).join(" and ");
  if (!acts.length) return `${head}.`;
  return owned === acts.length ? `${head}, every one a task with an owner.`
    : owned ? `${head}: ${owned} ${owned === 1 ? "is a task" : "are tasks"}, ${acts.length - owned} still ${acts.length - owned === 1 ? "isn't" : "aren't"}.`
    : `${head}, none a task yet.`;
}

function Lines({ title, items, ctx, empty }: { title: string; items: readonly MeetingItem[]; ctx: WrapContext; empty: string }) {
  return (
    <section className="kmtg-wrap-sec">
      <h3 className="kmtg-col-h">{title}<span className="kmtg-col-n">{items.length}</span></h3>
      {items.length ? (
        <ul className="kmtg-lines">
          {items.map((it) => (
            <NoteLine key={it.id} it={it} nameOf={ctx.nameOf} taskById={ctx.taskById} onOpenTask={ctx.onOpenTask} onMakeTask={ctx.onMakeTask} onDelete={ctx.onDelete}
              where={it.agendaKey && it.agendaKey !== "wrap" && it.agendaKey !== "overview" ? ctx.agendaTitle(it.agendaKey) : undefined} />
          ))}
        </ul>
      ) : <p className="kmtg-none">{empty}</p>}
    </section>
  );
}

export function RoomWrap({ items, ctx, live, canEnd, recipients, shared, docLabel, hasDoc, docBusy, ending, onSaveDoc, onOpenDoc, onExtract, onEnd }: {
  items: readonly MeetingItem[];
  ctx: WrapContext;
  live: boolean;
  canEnd: boolean;
  /** who the recap goes to (names) */
  recipients: string[];
  /** 0056 is on: the recap really goes (before it, nobody else is told) */
  shared: boolean;
  /** "Q3 Product Launch" (where the notes doc goes), or nothing when there's no project */
  docLabel?: string;
  hasDoc: boolean;
  docBusy: boolean;
  ending: boolean;
  onSaveDoc?: () => void;
  onOpenDoc?: () => void;
  onExtract?: () => void;
  onEnd?: () => void;
}) {
  const decisions = items.filter((i) => i.kind === "decision");
  const actions = items.filter((i) => i.kind === "action");
  const openLines = actions.some((a) => !a.taskId) || items.some((i) => i.kind !== "action");
  const who = recipients.map(firstName);
  return (
    <div className="kmtg-item" data-kind="wrap">
      <h2 className="kmtg-h">Wrap up</h2>
      <p className="kmtg-lede kmtg-lede-sm">{wrapSentence(items)}</p>
      <div className="kmtg-wrap-grid">
        <Lines title="Decisions" items={decisions} ctx={ctx} empty="No decisions logged." />
        <Lines title="Actions" items={actions} ctx={ctx} empty="No actions logged." />
      </div>
      <div className="kmtg-wrap-acts">
        {onExtract && openLines && <Button variant="secondary" icon="sparkles" onClick={onExtract}>Turn into tasks</Button>}
        {hasDoc ? (onOpenDoc && <Button variant="secondary" icon="notes" onClick={onOpenDoc}>Open notes doc</Button>)
          : onSaveDoc && docLabel && <Button variant="secondary" icon="notes" onClick={onSaveDoc} loading={docBusy}>Save notes to {docLabel}</Button>}
      </div>
      {live && canEnd && onEnd && (
        <div className="kmtg-end">
          <p className="kmtg-end-line">
            {shared
              ? who.length ? `The recap goes to ${listWords(who)}${who.length === 1 ? "'s Inbox" : "'s Inboxes"}${docLabel && !hasDoc ? `, and the notes into a doc in ${docLabel}` : ""}.` : `Nobody else was asked, so the recap is just for the record${docLabel && !hasDoc ? `; the notes go into a doc in ${docLabel}` : ""}.`
              : `This meeting ran on your screen only, so nobody else is told${docLabel && !hasDoc ? `. The notes go into a doc in ${docLabel}` : ""}.`}
          </p>
          <Button variant="hero" icon="check" onClick={onEnd} loading={ending}>{shared && who.length ? "End and send recap" : "End meeting"}</Button>
        </div>
      )}
    </div>
  );
}

/** A meeting once it's ended: the recap. */
export function RoomRecap({ meeting, items, ctx, ranBy, docLabel, hasDoc, docBusy, onSaveDoc, onOpenDoc, onExtract, onOpenPrevious }: {
  meeting: Meeting;
  items: readonly MeetingItem[];
  ctx: WrapContext;
  ranBy?: string;
  docLabel?: string;
  hasDoc: boolean;
  docBusy: boolean;
  onSaveDoc?: () => void;
  onOpenDoc?: () => void;
  onExtract?: () => void;
  onOpenPrevious?: () => void;
}) {
  const ended = meeting.endedAt ? new Date(meeting.endedAt) : null;
  const mins = ended ? Math.max(1, Math.round((ended.getTime() - new Date(meeting.startedAt).getTime()) / 60000)) : 0;
  const clock = ended ? ended.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
  const decisions = items.filter((i) => i.kind === "decision");
  const actions = items.filter((i) => i.kind === "action");
  const notes = items.filter((i) => i.kind === "note");
  return (
    <div className="kmtg-recap">
      <p className="kmtg-eyebrow"><Icon name="notes" size={14} /> Recap</p>
      <h2 className="kmtg-h">{meeting.title}</h2>
      <p className="kmtg-sub">
        {ended ? `Ended ${meetingDay(ended)} at ${clock} · ${plural(mins, "minute")}` : "Ended"}{ranBy ? ` · run by ${ranBy}` : ""} · {itemsLine(decisions.length, actions.length)}
      </p>
      <p className="kmtg-lede kmtg-lede-sm">{wrapSentence(items)}</p>
      <div className="kmtg-wrap-grid">
        <Lines title="Decisions" items={decisions} ctx={ctx} empty="No decisions logged." />
        <Lines title="Actions" items={actions} ctx={ctx} empty="No actions logged." />
      </div>
      {notes.length > 0 && <Lines title="Notes" items={notes} ctx={ctx} empty="" />}
      <div className="kmtg-wrap-acts">
        {hasDoc ? (onOpenDoc && <Button variant="secondary" icon="notes" onClick={onOpenDoc}>Open notes doc</Button>)
          : onSaveDoc && docLabel && <Button variant="secondary" icon="notes" onClick={onSaveDoc} loading={docBusy}>Save notes to {docLabel}</Button>}
        {onExtract && (actions.some((a) => !a.taskId) || notes.length > 0 || decisions.length > 0) && <Button variant="secondary" icon="sparkles" onClick={onExtract}>Turn into tasks</Button>}
        {onOpenPrevious && <Button variant="ghost" icon="arrowLeft" onClick={onOpenPrevious}>The meeting before</Button>}
      </div>
      <section className="kmtg-wrap-sec">
        <h3 className="kmtg-col-h">On the agenda</h3>
        <ol className="kmtg-plan kmtg-plan-quiet">
          {meeting.agenda.filter((a) => a.kind !== "wrap").map((a, i) => (
            <li key={a.key}><span className="kmtg-plan-row" data-static=""><span className="kmtg-plan-n">{i + 1}</span><span className="kmtg-plan-t">{a.title}</span></span></li>
          ))}
        </ol>
      </section>
    </div>
  );
}

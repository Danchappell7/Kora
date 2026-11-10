/* ============================================================
   KANBO — one project update in its history, with its conversation
   (0054). Who posted it and when ("edited" once its author changed
   it), the words, its optional sections (Highlights / Risks / Asks /
   Next; an Ask says who it's for), a plan to recover (0053), then one
   quiet line: reactions, "Seen by 6" and its replies. Its author edits
   or deletes it; the workspace's owners and admins can delete any.
   Anyone who reads it (guests too) reacts and replies; you edit or
   delete your own replies, and leads remove any.
   ============================================================ */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Avatar, Button, DateChip, Icon, IconButton, Pill, Segmented } from "../primitives";
import { Popover } from "../primitives/Popover";
import { getMember, KANBO_TODAY, timeAgo } from "../../data/data";
import type { StatusKind, StatusUpdate, UpdateComment, UpdateSections } from "../../data/types";
import { fmtShortDay, updateAuthor } from "../../lib/statusDraft";
import { STATUS_TONES, STATUS_WORDS } from "../../lib/honestStatus";
import { hasSections, SECTION_HINTS, SECTION_KEYS, SECTION_LABELS, SECTION_MAX } from "../../lib/updateSections";
import {
  addUpdateComment, COMMENT_MAX, deleteUpdateComment, editUpdateComment, seenByNames, toggleUpdateReaction, UPDATE_REACTIONS,
  type UpdateThread,
} from "../../lib/updateConversation";
import { resolveMentions } from "../taskDetailHelpers";
import { PLAN_MAX, POP_STYLE, STATUS_OPTIONS, takesPlan } from "../project/StatusComposer";
import { UpdatePlanNote } from "./UpdateDay";
import "../project/projects.css";
import "./conversation.css";
import "./updates.css";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** What an edit saves: the call, the words, the sections, the plan to recover and new date (At risk and Off track
 *  only: moving the call elsewhere drops them), and who its Asks are for. */
export interface UpdateEditPatch {
  summary: string; status: StatusKind; sections: UpdateSections | null;
  recoveryPlan: string | null; targetDate: string | null; askUserIds: string[];
}

/** An update's sections as a short list (Asks say who they're for). */
export function UpdateSectionsList({ sections, askUserIds, me }: { sections?: UpdateSections; askUserIds?: string[]; me?: string }) {
  if (!hasSections(sections)) return null;
  const who = (askUserIds ?? []).map((id) => ({ id, name: getMember(id)?.name })).filter((p): p is { id: string; name: string } => !!p.name);
  return (
    <dl className="kuc-secs">
      {SECTION_KEYS.filter((k) => sections?.[k]?.trim()).map((k) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{SECTION_LABELS[k]}</dt>
          <dd data-key={k}>
            {sections![k]}
            {k === "asks" && who.length > 0 && (
              <span className="kuc-for" aria-label={`For ${who.map((p) => p.name).join(", ")}`}>
                {who.map((p) => <span key={p.id} data-me={p.id === me ? "" : undefined}>{p.id === me ? "You" : firstName(p.name)}</span>)}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The author's editor: the call, the words, the sections and who an Ask is for, and an At risk or Off track
 *  update's plan to recover and new date. */
function UpdateEditor({ update, people, onSave, onCancel }: {
  update: StatusUpdate; people: { id: string; name: string }[]; onSave: (p: UpdateEditPatch) => Promise<boolean>; onCancel: () => void;
}) {
  const [summary, setSummary] = useState(update.summary);
  const [status, setStatus] = useState<StatusKind>(update.status);
  const [sections, setSections] = useState<UpdateSections>(update.sections ?? {});
  const [plan, setPlan] = useState(update.recoveryPlan ?? "");
  const [target, setTarget] = useState<string | null>(update.targetDate ?? null);
  const [asks, setAsks] = useState<string[]>(update.askUserIds ?? []);
  const [saving, setSaving] = useState(false);
  const withPlan = takesPlan(status);
  const asking = !!sections.asks?.trim();
  const save = async () => {
    if (!summary.trim() || saving) return;
    setSaving(true);
    const ok = await onSave({
      summary: summary.trim(), status, sections: hasSections(sections) ? sections : null,
      recoveryPlan: withPlan ? plan.trim().slice(0, PLAN_MAX) || null : null, targetDate: withPlan ? target : null,
      askUserIds: asking ? asks : [],
    });
    setSaving(false);
    if (ok) onCancel();
  };
  return (
    <div className="kuc-edit kpj-composer" role="group" aria-label="Edit the update">
      <Segmented ariaLabel="Project status" options={STATUS_OPTIONS} value={status} onChange={setStatus} />
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <textarea autoFocus className="kpj-field" rows={3} value={summary} aria-label="Update" onChange={(e) => setSummary(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } else if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} />
      <fieldset className="kuc-sec">
        {SECTION_KEYS.map((k) => (
          <label key={k} className="kuc-sec-row">
            <span className="kuc-sec-label">{SECTION_LABELS[k]}</span>
            <textarea className="kpj-field kuc-sec-field" rows={1} maxLength={SECTION_MAX} value={sections[k] ?? ""} placeholder={SECTION_HINTS[k]}
              onChange={(e) => setSections((s) => ({ ...s, [k]: e.target.value }))} />
          </label>
        ))}
        {people.length > 0 && asking && (
          <div className="kuc-sec-who" role="group" aria-label="Who the asks are for">
            <span className="kuc-sec-who-label">Ask</span>
            {people.map((p) => (
              <button key={p.id} type="button" className="kuc-chip" aria-pressed={asks.includes(p.id)}
                onClick={() => setAsks((xs) => (xs.includes(p.id) ? xs.filter((x) => x !== p.id) : [...xs, p.id].slice(0, 20)))}>{firstName(p.name)}</button>
            ))}
            <span className="kuc-sec-who-note">Anyone you add here hears about it under Needs your reply.</span>
          </div>
        )}
      </fieldset>
      {withPlan && (
        <div className="kup-plan">
          <label className="kup-plan-label">
            <span>Plan to recover <span className="kup-opt">optional</span></span>
            <textarea className="kpj-field kup-plan-field" rows={2} value={plan} maxLength={PLAN_MAX} onChange={(e) => setPlan(e.target.value)}
              placeholder="What will get it back on track, and who's doing it?" />
          </label>
          <div className="kup-plan-date">
            <span className="kup-plan-label-text" aria-hidden="true">New target date <span className="kup-opt">optional</span></span>
            <DateChip size="sm" tone="plain" label="New target date" value={target ?? undefined} placeholder="Add a date" onChange={(d) => setTarget(d ?? null)} />
          </div>
        </div>
      )}
      <div className="kuc-edit-foot">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={!summary.trim() || saving} loading={saving}>Save</Button>
      </div>
    </div>
  );
}

/** One reply: who, when ("edited"), the words; yours to edit or delete, a lead's to remove. */
function Reply({ c, me, lead, onError }: { c: UpdateComment; me: string; lead: boolean; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.body);
  const mine = !!me && c.authorId === me;
  const known = c.authorId ? getMember(c.authorId) : undefined;
  const save = () => editUpdateComment(c, text).then(() => setEditing(false), (e: Error) => onError(e.message));
  const remove = () => {
    if (!window.confirm(mine ? "Delete your reply? This can't be undone." : `Remove ${firstName(c.authorName)}'s reply? This can't be undone.`)) return;
    deleteUpdateComment(c).catch((e: Error) => onError(e.message));
  };
  return (
    <li className="kuc-c">
      <span className="kuc-c-av">{known ? <Avatar id={c.authorId!} size={22} /> : <span className="kuc-c-initial" aria-hidden="true">{c.authorName.slice(0, 1).toUpperCase()}</span>}</span>
      <div>
        <div className="kuc-c-head">
          <b>{mine ? "You" : c.authorName}</b>
          <span title={new Date(c.createdAt).toLocaleString("en-GB")}>{timeAgo(c.createdAt)}</span>
          {c.editedAt && <span className="kuc-edited" title={`Edited ${new Date(c.editedAt).toLocaleString("en-GB")}`}>· edited</span>}
          {!editing && (mine || lead) && (
            <span className="kuc-c-acts">
              {mine && <Button variant="ghost" size="sm" onClick={() => { setText(c.body); setEditing(true); }}>Edit</Button>}
              <Button variant="ghost" size="sm" onClick={remove} aria-label={mine ? "Delete your reply" : `Remove ${c.authorName}'s reply`}>{mine ? "Delete" : "Remove"}</Button>
            </span>
          )}
        </div>
        {editing ? (
          <div className="kuc-reply">
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <textarea autoFocus className="kpj-field" rows={2} maxLength={COMMENT_MAX} value={text} aria-label="Edit your reply" onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } else if (e.key === "Escape") { e.stopPropagation(); setEditing(false); } }} />
            <div className="kuc-reply-foot">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => void save()} disabled={!text.trim()}>Save</Button>
            </div>
          </div>
        ) : <p className="kuc-c-body">{c.body}</p>}
      </div>
    </li>
  );
}

export function UpdateCard({ update, me, canWrite, lead, thread, conversation, people = [], onEdit, onDelete, actions, defaultOpen = false }: {
  update: StatusUpdate;
  /** the signed-in person */
  me: string;
  /** may write in the update's workspace (not a guest): an author edits only then */
  canWrite: boolean;
  /** an owner or admin of the update's workspace: may delete any update, remove any reply */
  lead: boolean;
  thread: UpdateThread;
  /** 0054 is in: reactions, seen by and replies */
  conversation: boolean;
  /** who a reply can @mention (people who can read the update) */
  people?: { id: string; name: string }[];
  onEdit?: (u: StatusUpdate, patch: UpdateEditPatch) => Promise<boolean>;
  onDelete?: (u: StatusUpdate) => void;
  /** e.g. Share to Slack on the latest */
  actions?: ReactNode;
  /** open its replies, and bring it into view with the reply box ready (arriving from the Inbox) */
  defaultOpen?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  // arriving from the Inbox: the update that asked you, in view, its reply box ready (once its thread is in)
  const brought = useRef(false);
  useEffect(() => {
    if (!defaultOpen || !conversation || brought.current) return;
    const el = replyRef.current;
    if (!el) return;
    brought.current = true;
    el.closest("li")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    el.focus({ preventScroll: true });
  }, [defaultOpen, conversation]);
  const by = updateAuthor(update);
  const mine = !!me && update.authorId === me;
  const canEdit = mine && canWrite && !!onEdit;
  const canDelete = !!onDelete && ((mine && canWrite) || lead);
  const replies = thread.comments;
  const seen = thread.seenBy.filter((id) => id !== update.authorId);
  const reactions = UPDATE_REACTIONS.filter((e) => (thread.reactions[e] ?? []).length > 0);
  const react = (emoji: string) => { setPickOpen(false); toggleUpdateReaction(update.id, emoji, me).catch((e: Error) => setErr(e.message)); };
  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true); setErr(null);
    try {
      await addUpdateComment(update.id, body, resolveMentions(body, [], people.filter((p) => p.id !== me)), me);
      setDraft("");
    } catch (e) { setErr((e as Error).message); }
    setSending(false);
  };
  const remove = () => {
    setMenuOpen(false);
    if (window.confirm(mine ? "Delete this update? Its replies go with it. This can't be undone." : `Delete ${by ?? "this person"}'s update? Its replies go with it. This can't be undone.`)) onDelete?.(update);
  };

  return (
    <>
      <div className="kpj-history-meta">
        <Pill tone={STATUS_TONES[update.status] ?? "neutral"}>{STATUS_WORDS[update.status] ?? update.status}</Pill>
        {by && (
          <span className="kpj-history-by" data-former={update.authorId && getMember(update.authorId) ? undefined : ""}>
            {update.authorId && getMember(update.authorId) && <Avatar id={update.authorId} size={18} />}
            {by}
          </span>
        )}
        <span className="kpj-mono" title={new Date(update.createdAt).toLocaleString("en-GB")}>{fmtShortDay(update.createdAt, KANBO_TODAY)}</span>
        {update.editedAt && <span className="kuc-edited" title={`Edited ${new Date(update.editedAt).toLocaleString("en-GB")}`}>· edited</span>}
        {(actions || canEdit || canDelete) && (
          <span className="kuc-more">
            {actions}
            {(canEdit || canDelete) && !editing && (
              <IconButton ref={moreRef} icon="more" size="sm" label="Update actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)} />
            )}
          </span>
        )}
        <Popover open={menuOpen} anchorRef={moreRef} onClose={() => setMenuOpen(false)} role="menu" label="Update actions" align="end" minWidth={180}
          className="kpj-pop" style={{ ...POP_STYLE, padding: 4 }}>
          {canEdit && (
            <button type="button" role="menuitem" className="kpj-menu-item" onClick={() => { setMenuOpen(false); setEditing(true); }}>
              <Icon name="notes" size={16} sw={1.75} />Edit update
            </button>
          )}
          {canDelete && (
            <button type="button" role="menuitem" className="kpj-menu-item" data-tone="danger" onClick={remove}>
              <Icon name="trash" size={16} sw={1.75} />Delete update
            </button>
          )}
        </Popover>
      </div>
      {editing && onEdit ? (
        <UpdateEditor update={update} people={people.filter((p) => p.id !== me && p.name.trim())} onSave={(p) => onEdit(update, p)} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <p className="kpj-history-text">{update.summary}</p>
          <UpdateSectionsList sections={update.sections} askUserIds={update.askUserIds} me={me} />
        </>
      )}
      {/* (while it's being edited, the editor holds the plan) */}
      {!editing && <UpdatePlanNote update={update} />}
      {conversation && (
        <div className="kuc-foot">
          <span className="kuc-reacts">
            {reactions.map((e) => {
              const who = thread.reactions[e] ?? [];
              const on = who.includes(me);
              return (
                <button key={e} type="button" className="kuc-react" aria-pressed={on} disabled={!me}
                  title={who.map((id) => (id === me ? "You" : getMember(id)?.name ?? "Someone")).join(", ")}
                  aria-label={`${e} ${who.length}${on ? ", including you" : ""}`} onClick={() => react(e)}>
                  <span aria-hidden="true">{e}</span><span aria-hidden="true">{who.length}</span>
                </button>
              );
            })}
            {me && (
              <IconButton ref={pickRef} icon="plus" size="sm" label="React" aria-haspopup="menu" aria-expanded={pickOpen} onClick={() => setPickOpen((v) => !v)} />
            )}
          </span>
          <Popover open={pickOpen} anchorRef={pickRef} onClose={() => setPickOpen(false)} role="menu" label="React" minWidth={0} className="kpj-pop" style={{ ...POP_STYLE, padding: 0 }}>
            <div className="kuc-pick">
              {UPDATE_REACTIONS.map((e) => (
                <button key={e} type="button" role="menuitemcheckbox" aria-checked={(thread.reactions[e] ?? []).includes(me)} aria-pressed={(thread.reactions[e] ?? []).includes(me)}
                  aria-label={e} onClick={() => react(e)}>{e}</button>
              ))}
            </div>
          </Popover>
          {seen.length > 0 && (
            <span className="kuc-seen" title={`Seen by ${seenByNames(seen)}`} aria-label={`Seen by ${seenByNames(seen)}`}>Seen by {seen.length}</span>
          )}
          <span className="kuc-replies">
            <Button variant="ghost" size="sm" icon="message" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {replies.length ? plural(replies.length, "reply", "replies") : "Reply"}
            </Button>
          </span>
        </div>
      )}
      {conversation && open && (
        <div className="kuc-thread">
          {replies.length > 0 && (
            <ol style={{ display: "contents", listStyle: "none" }} aria-label="Replies">
              {replies.map((c) => <Reply key={c.id} c={c} me={me} lead={lead} onError={setErr} />)}
            </ol>
          )}
          {me && (
            <div className="kuc-reply">
              <textarea ref={replyRef} className="kpj-field" rows={2} maxLength={COMMENT_MAX} value={draft} aria-label={`Reply to ${by ?? "this update"}`}
                placeholder={people.length ? "Reply… @mention someone to ask them" : "Reply…"} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
              <div className="kuc-reply-foot">
                {by && !mine && <span className="kuc-reply-note">{firstName(by)} hears about it.</span>}
                <Button variant="primary" size="sm" onClick={() => void send()} disabled={!draft.trim() || sending} loading={sending}>Reply</Button>
              </div>
            </div>
          )}
        </div>
      )}
      {err && <p className="kuc-err" role="alert">{err}</p>}
    </>
  );
}

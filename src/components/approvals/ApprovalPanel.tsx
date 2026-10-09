/* ============================================================
   KANBO — TaskDetail › Approval.                              [0047 · w4]
   Request approval (pick reviewers from the workspace's people — guests
   included and labelled — a note, anyone/everyone, optionally one of the
   task's files); the open request's status chip, each reviewer's
   decision with avatar and comment, Approve / Request changes for
   reviewers, Cancel for the requester (and owners/admins); earlier
   requests folded below. Data: lib/approvals.
   Renders nothing for personal tasks, before 0047, and for a guest on a
   task nobody has asked about. A task with no request yet shows one
   quiet "Request approval" button (like "Add dependency").
   Keys: ⌘/Ctrl+↵ sends the request; Escape inside the form closes it
   (and never the task panel); the reviewer picker is a list you move
   through with ↑/↓ (Enter or Space picks, Enter in the search picks the
   first match).
   Mount (integrator): in TaskDetail after Files / Notion, before
   Activity, for team tasks —
     <ApprovalPanel task={task} members={workspacePeople} guestIds={guests}
       currentUserId={me} readOnly={readOnly} attachments={files}
       refreshKey={approvalTick} onChange={() => refreshBadgesAndInbox()} />
   ============================================================ */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { Approval, ApprovalDecision, ApprovalRule, Attachment, Member, Task } from "../../data/types";
import { Button, Icon, Pill, Segmented } from "../primitives";
import { Popover } from "../primitives/Popover";
import { getProject } from "../../data/data";
import {
  APPROVAL_LIMITS, APPROVAL_RULE_LABEL, approvalErrorText, approvalFailure, approvalSummary, cancelApproval, decideApproval,
  firstNameOf, listTaskApprovals, nameList, rememberApprovalTask, requestApproval,
} from "../../lib/approvals";
import { ApprovalBadge } from "./ApprovalBadge";
import { PersonMark, When, autoGrow, useAnnounce } from "./parts";
import "./approvals.css";

export interface ApprovalPanelProps {
  task: Task;
  /** the task's workspace's active people (the reviewer picker) */
  members: Member[];
  /** which of `members` are guests (they can review; they can't request) */
  guestIds?: string[];
  currentUserId: string;
  /** a guest here: can't request or cancel, can still decide their own review */
  readOnly?: boolean;
  /** the task's files ("approve this file") */
  attachments?: Attachment[];
  /** bump when realtime reports a change to this task's approvals or reviews */
  refreshKey?: number;
  /** after any change (the host refreshes badges / the Inbox group) */
  onChange?: (approval: Approval) => void;
}

interface Person { id: string; name: string; guest: boolean }

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
const newestFirst = (a: Approval, b: Approval) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
const isText = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);

export function ApprovalPanel({ task, members, guestIds = [], currentUserId, readOnly = false, attachments = [], refreshKey = 0, onChange }: ApprovalPanelProps) {
  const ids = "kapv" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const workspaceId = task.workspaceId ?? getProject(task.projectId)?.workspaceId ?? null;
  const [list, setList] = useState<Approval[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "unavailable">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const [ask, setAsk] = useState(0);
  const { say, message } = useAnnounce();
  const startRef = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<"start" | "head" | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // the people: guests labelled, never yourself, team first then guests, by name
  const guests = useMemo(() => new Set(guestIds), [guestIds]);
  const people: Person[] = useMemo(() => members
    .filter((m) => m.id && m.id !== currentUserId)
    .map((m) => ({ id: m.id, name: (m.name || m.email || "Someone").trim(), guest: guests.has(m.id) }))
    .sort((a, b) => Number(a.guest) - Number(b.guest) || a.name.localeCompare(b.name)), [members, currentUserId, guests]);
  const nameOf = (id: string | null, fallback: string | null) =>
    (id && members.find((m) => m.id === id)?.name) || fallback || "Someone";

  // a new task: start afresh
  useEffect(() => {
    setList(null); setState("loading"); setLoadError(null); setComposing(false); setShowOlder(false);
  }, [task.id]);

  // demo mode: the fakes learn about a task made in this session
  useEffect(() => {
    rememberApprovalTask({ id: task.id, title: task.title, projectId: task.projectId, status: task.status, workspaceId, dueDate: task.dueDate ?? null });
  }, [task.id, task.title, task.projectId, task.status, task.dueDate, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    listTaskApprovals(task.id).then(
      (l) => { if (live) { setList([...l].sort(newestFirst)); setState("ready"); setLoadError(null); } },
      (e) => {
        if (!live) return;
        if (approvalFailure(e) === "unavailable") { setState("unavailable"); return; }
        setState("error"); setLoadError(approvalErrorText(e, "load"));
      },
    );
    return () => { live = false; };
  }, [task.id, workspaceId, refreshKey, ask]);

  useEffect(() => {
    const f = focusAfter.current;
    if (!f) return;
    focusAfter.current = null;
    (f === "start" ? startRef.current : headRef.current)?.focus({ preventScroll: false });
  });

  if (!workspaceId || state === "unavailable") return null;

  const all = list ?? [];
  const pending = all.find((a) => a.status === "pending") ?? null;
  const current = pending ?? all[0] ?? null;
  const older = all.filter((a) => a !== current);
  const canRequest = !readOnly && !pending && state !== "error";
  const live = <p className="sr-only" role="status" aria-live="polite">{message}</p>;

  const applied = (a: Approval) => {
    setList((l) => [a, ...(l ?? []).filter((x) => x.id !== a.id)].sort(newestFirst));
    onChangeRef.current?.(a);
  };
  const refresh = () => setAsk((n) => n + 1);
  const openForm = () => { setComposing(true); };
  const closeForm = () => { setComposing(false); focusAfter.current = all.length ? "head" : "start"; };

  // a guest with nothing to see, or the first load (writers keep the button's place)
  if (!list && state === "loading") {
    return readOnly ? null : <div className="kapv-start" aria-busy="true"><span style={{ display: "block", height: 28 }} /></div>;
  }
  if (!all.length && !composing && state === "ready") {
    if (!canRequest) return null;
    return (
      <div className="kapv-start">
        <Button ref={startRef} variant="ghost" size="sm" icon="check" onClick={openForm}>Request approval</Button>
        {live}
      </div>
    );
  }

  const again = current && current.status !== "pending" ? current : null;
  return (
    <section className="ktd-sec kapv" aria-labelledby={`${ids}-h`}>
      <div className="ksection">
        <h3 className="ksection-title" id={`${ids}-h`}>
          Approval{all.length > 1 && <span className="ksection-count" title="Requests">{all.length}</span>}
        </h3>
        {canRequest && !composing && all.length > 0 && (
          <div className="ksection-action">
            <Button ref={startRef} variant="ghost" size="sm" icon="check" onClick={openForm} style={{ color: "var(--ink-2)" }}>Request again</Button>
          </div>
        )}
      </div>
      {state === "error" && (
        <p className="kapv-err" role="alert">
          {loadError}
          <Button variant="ghost" size="sm" icon="refresh" onClick={refresh}>Try again</Button>
        </p>
      )}
      {composing && (
        <RequestForm taskId={task.id} people={people} attachments={attachments}
          initial={again ? { reviewerIds: again.reviewers.map((r) => r.userId).filter((id) => people.some((p) => p.id === id)), rule: again.rule, attachmentId: again.attachmentId } : null}
          onCancel={closeForm} onStale={refresh}
          onSent={(a) => {
            setComposing(false);
            applied(a);
            focusAfter.current = "head";
            say(`Asked ${nameList(a.reviewers.map((r) => firstNameOf(nameOf(r.userId, r.name))))} to approve`);
          }} />
      )}
      {current && (
        <ApprovalCard approval={current} headRef={headRef} nameOf={nameOf} guests={guests} attachments={attachments}
          currentUserId={currentUserId} readOnly={readOnly} onStale={refresh}
          onDecided={(a, d) => {
            applied(a);
            focusAfter.current = "head";
            say(d === "changes_requested" ? "You asked for changes" : a.status === "approved" ? "Approved" : "Approved. Still waiting on the others");
          }}
          onCancelled={(a) => {
            applied(a);
            focusAfter.current = readOnly ? "head" : "start";
            say("Request cancelled", "info");
          }} />
      )}
      {older.length > 0 && (
        <div className="kapv-older">
          <button type="button" className="kapv-more" aria-expanded={showOlder} aria-controls={`${ids}-older`} onClick={() => setShowOlder((v) => !v)}>
            <Icon name="chevronRight" size={14} sw={2} />
            Earlier requests<span className="ksection-count">{older.length}</span>
          </button>
          <div id={`${ids}-older`} hidden={!showOlder}>
            {showOlder && older.map((a) => (
              <ApprovalCard key={a.id} approval={a} compact nameOf={nameOf} guests={guests} attachments={attachments}
                currentUserId={currentUserId} readOnly onStale={refresh} onDecided={() => {}} onCancelled={() => {}} />
            ))}
          </div>
        </div>
      )}
      {live}
    </section>
  );
}

/* ============================================================ the request form */

function RequestForm({ taskId, people, attachments, initial, onCancel, onSent, onStale }: {
  taskId: string;
  people: Person[];
  attachments: Attachment[];
  /** "Request again": the last request's reviewers, rule and file */
  initial: { reviewerIds: string[]; rule: ApprovalRule; attachmentId: string | null } | null;
  onCancel: () => void;
  onSent: (a: Approval) => void;
  onStale: () => void;
}) {
  const ids = "kapvf" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [chosen, setChosen] = useState<string[]>(() => (initial?.reviewerIds ?? []).slice(0, APPROVAL_LIMITS.reviewers));
  const [rule, setRule] = useState<ApprovalRule>(initial?.rule ?? "any");
  const [fileId, setFileId] = useState<string>(() => (initial?.attachmentId && attachments.some((f) => f.id === initial.attachmentId) ? initial.attachmentId : ""));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // straight to choosing people (or, asking again, to the note)
  useEffect(() => {
    if (!people.length) return;
    if (chosen.length) noteRef.current?.focus({ preventScroll: true });
    else setPicking(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => autoGrow(noteRef.current), [note]);

  const byId = new Map(people.map((p) => [p.id, p]));
  const picked = chosen.map((id) => byId.get(id)).filter((p): p is Person => !!p);
  const over = note.trim().length > APPROVAL_LIMITS.note;
  const toggle = (id: string) => {
    setErr(null);
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= APPROVAL_LIMITS.reviewers ? c : [...c, id]));
  };
  const send = async () => {
    if (busy) return;
    if (!picked.length) { setErr("Choose at least one person to review it."); addRef.current?.focus(); return; }
    if (over) { setErr(`The note is too long (${APPROVAL_LIMITS.note.toLocaleString("en-GB")} characters at most).`); noteRef.current?.focus(); return; }
    setBusy(true); setErr(null);
    try {
      const a = await requestApproval({
        taskId, reviewerIds: picked.map((p) => p.id), rule: picked.length > 1 ? rule : "any", note: note.trim() || null, attachmentId: fileId || null,
      });
      if (alive.current) onSent(a);
    } catch (e) {
      if (!alive.current) return;
      setBusy(false);
      setErr(approvalErrorText(e, "request"));
      if (approvalFailure(e) === "already_pending") onStale();
    }
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); void send(); return; }
    if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
    // Escape belongs to the form here: it never closes the task panel. With a note
    // written it only steps out of the text (Cancel is right there); else it closes.
    e.preventDefault(); e.stopPropagation();
    if (note.trim()) { if (isText(e.target)) cancelRef.current?.focus(); return; }
    onCancel();
  };

  return (
    <div className="kapv-form" role="group" aria-labelledby={`${ids}-t`} onKeyDown={onKeyDown}>
      <p className="sr-only" id={`${ids}-t`}>Request approval</p>
      <div className="kapv-field">
        <p className="kapv-label" id={`${ids}-who`}>Who should approve it?</p>
        {people.length === 0 ? (
          <p className="kapv-hint">There's no one else in this workspace to ask yet. Invite teammates from Team.</p>
        ) : (
          <ul className="kapv-chosen" aria-labelledby={`${ids}-who`}>
            {picked.map((p) => (
              <li key={p.id} className="kapv-chip">
                <PersonMark id={p.id} name={p.name} size={20} />
                <span>{p.name}</span>
                {p.guest && <span className="kapv-guest">Guest</span>}
                <button type="button" className="kibtn" data-size="sm" data-variant="ghost" aria-label={`Remove ${p.name}`} onClick={() => toggle(p.id)}>
                  <Icon name="x" size={12} sw={2} />
                </button>
              </li>
            ))}
            <li>
              <Button ref={addRef} variant="ghost" size="sm" icon="plus" className="kapv-add" aria-haspopup="dialog" aria-expanded={picking}
                onClick={() => setPicking((v) => !v)}>{picked.length ? "Add or remove" : "Choose people"}</Button>
            </li>
          </ul>
        )}
      </div>
      {picked.length > 1 && (
        <div className="kapv-field">
          <p className="kapv-label" id={`${ids}-rule`}>How many need to approve?</p>
          <Segmented<ApprovalRule> ariaLabel="How many need to approve" value={rule} onChange={setRule}
            options={[{ value: "any", label: "Anyone" }, { value: "all", label: "Everyone" }]} />
          <p className="kapv-hint">
            {rule === "any" ? "The first approval decides it." : `It's approved once all ${picked.length} have approved.`} One “Request changes” sends it back either way.
          </p>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="kapv-field">
          <label className="kapv-label" htmlFor={`${ids}-file`}>About</label>
          <select id={`${ids}-file`} className="kapv-select" value={fileId} onChange={(e) => setFileId(e.target.value)}>
            <option value="">The whole task</option>
            {attachments.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
      )}
      <div className="kapv-field">
        <div className="kapv-label-row">
          <label className="kapv-label" htmlFor={`${ids}-note`}>Note <span style={{ fontWeight: 500, color: "var(--ink-3)" }}>(optional)</span></label>
          {note.length > APPROVAL_LIMITS.note - 200 && (
            <span className="kapv-count" data-over={over || undefined} aria-live="polite">{note.trim().length.toLocaleString("en-GB")} / {APPROVAL_LIMITS.note.toLocaleString("en-GB")}</span>
          )}
        </div>
        <textarea ref={noteRef} id={`${ids}-note`} className="kapv-text" rows={2} value={note} disabled={busy}
          placeholder="What should they look at?" aria-invalid={over || undefined}
          onChange={(e) => { setNote(e.target.value); setErr(null); }} />
      </div>
      {err && <p className="kapv-err" role="alert">{err}</p>}
      <div className="kapv-actions">
        <Button ref={cancelRef} variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="primary" size="sm" icon="send" kbd={isMac ? "⌘↵" : "Ctrl ↵"} loading={busy}
          disabled={!picked.length || over} aria-keyshortcuts="Meta+Enter Control+Enter" onClick={() => void send()}>Send request</Button>
      </div>
      {picking && people.length > 0 && (
        <ReviewerPicker anchorRef={addRef} people={people} chosen={chosen} onToggle={toggle} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}

/* The reviewer picker: a search box over a multi-select list (↑/↓ move, Enter or Space picks, Enter in
   the search picks the first match), at most APPROVAL_LIMITS.reviewers people. */
function ReviewerPicker({ anchorRef, people, chosen, onToggle, onClose }: {
  anchorRef: RefObject<HTMLButtonElement>;
  people: Person[];
  chosen: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
}) {
  const ids = "kapvp" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const needle = q.trim().toLowerCase();
  const shown = needle ? people.filter((p) => p.name.toLowerCase().includes(needle)) : people;
  const full = chosen.length >= APPROVAL_LIMITS.reviewers;
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [searchRef.current, ...Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].filter((x): x is HTMLElement => !!x);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === "Enter" && e.target === searchRef.current && shown[0]) {
      e.preventDefault();
      const p = shown[0];
      if (chosen.includes(p.id) || !full) onToggle(p.id);
      setQ("");
    }
  };
  return (
    <Popover open anchorRef={anchorRef} onClose={onClose} role="dialog" label="Choose reviewers" minWidth={280} maxHeight={420}
      initialFocus={searchRef} className="kapv-pick" align="start">
      <div onKeyDown={onKeyDown}>
        {people.length > 5 && (
          <input ref={searchRef} className="kapv-pick-search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Find someone…" aria-label="Find someone" aria-controls={`${ids}-list`} autoComplete="off" spellCheck={false} />
        )}
        <div ref={listRef} role="listbox" id={`${ids}-list`} aria-label="Reviewers" aria-multiselectable="true">
          {shown.map((p) => {
            const on = chosen.includes(p.id);
            const off = !on && full;
            return (
              <button key={p.id} type="button" role="option" aria-selected={on} aria-disabled={off || undefined} className="kapv-opt"
                onClick={() => { if (!off) onToggle(p.id); }}>
                <PersonMark id={p.id} name={p.name} size={20} />
                <span className="kapv-opt-name">{p.name}</span>
                {p.guest && <span className="kapv-guest">Guest</span>}
                <span className="kapv-opt-check" aria-hidden="true">{on && <Icon name="check" size={12} sw={2.5} />}</span>
              </button>
            );
          })}
          {shown.length === 0 && <div className="kapv-pick-note">No one matches “{q.trim()}”.</div>}
        </div>
        {full && <p className="kapv-pick-note" role="status">That's the most: {APPROVAL_LIMITS.reviewers} reviewers.</p>}
        <div className="kapv-pick-foot">
          <span className="kapv-pick-note" style={{ marginRight: "auto", padding: "6px 4px" }}>{chosen.length ? `${chosen.length} chosen` : "Guests can review too"}</span>
          <Button variant="primary" size="sm" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Popover>
  );
}

/* ============================================================ one request */

function ApprovalCard({ approval: a, compact, headRef, nameOf, guests, attachments, currentUserId, readOnly, onDecided, onCancelled, onStale }: {
  approval: Approval;
  compact?: boolean;
  headRef?: RefObject<HTMLDivElement>;
  nameOf: (id: string | null, fallback: string | null) => string;
  guests: Set<string>;
  attachments: Attachment[];
  currentUserId: string;
  readOnly: boolean;
  onDecided: (a: Approval, d: ApprovalDecision) => void;
  onCancelled: (a: Approval) => void;
  onStale: () => void;
}) {
  const ids = "kapvc" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) keepRef.current?.focus(); }, [confirming]);
  const open = a.status === "pending";
  const mine = a.requestedBy === currentUserId;
  const asker = mine ? "You" : nameOf(a.requestedBy, a.requestedByName);
  const file = a.attachmentId ? attachments.find((f) => f.id === a.attachmentId) ?? null : null;
  const cancel = async () => {
    setBusy(true); setErr(null);
    try { onCancelled(await cancelApproval(a.id)); }
    catch (e) {
      setErr(approvalErrorText(e, "cancel"));
      const r = approvalFailure(e);
      if (r === "closed" || r === "not_found") onStale();
    } finally { setBusy(false); setConfirming(false); }
  };
  const resolvedWords = a.status === "approved" ? "Approved" : a.status === "changes_requested" ? "Changes requested" : a.status === "cancelled" ? "Cancelled" : null;

  return (
    <article className="kapv-card" data-compact={compact || undefined} data-status={a.status} aria-labelledby={`${ids}-h`}>
      <div className="kapv-card-head" ref={headRef} tabIndex={headRef ? -1 : undefined} id={`${ids}-h`}>
        {a.status === "cancelled"
          ? <Pill tone="neutral" icon="x">Cancelled</Pill>
          : <ApprovalBadge summary={approvalSummary(a)} size="md" />}
        {a.reviewers.length > 1 && <span className="kapv-rule">{APPROVAL_RULE_LABEL[a.rule]}</span>}
        {a.canCancel && !readOnly && !compact && !confirming && (
          <span className="kapv-card-end">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>Cancel request</Button>
          </span>
        )}
      </div>
      <p className="kapv-who">
        <b>{asker}</b> asked <When iso={a.createdAt} />
        {resolvedWords && a.resolvedAt && <> · {resolvedWords.toLowerCase()} <When iso={a.resolvedAt} /></>}
        {a.attachmentId && (
          <> · about {file
            ? <a className="kapv-file" href={file.url} target="_blank" rel="noopener noreferrer" title={file.name}>
                <Icon name="folder" size={12} sw={2} /><span>{file.name}</span><span className="sr-only"> (opens in a new tab)</span>
              </a>
            : <span>a file that has since been removed</span>}</>
        )}
      </p>
      {a.note && <p className="kapv-quote">{a.note}</p>}
      <ul className="kapv-revs" aria-label="Reviewers">
        {a.reviewers.map((r) => {
          const name = nameOf(r.userId, r.name);
          const word = r.decision === "approved" ? "Approved" : r.decision === "changes_requested" ? "Changes requested" : open ? "Waiting" : "No decision";
          return (
            <li key={r.userId} className="kapv-rev">
              <PersonMark id={r.userId} name={name} size={24} />
              <span className="kapv-rev-name">
                <span>{name}{r.userId === currentUserId ? " (you)" : ""}</span>
                {guests.has(r.userId) && <span className="kapv-guest">Guest</span>}
              </span>
              <span className="kapv-dec" data-decision={r.decision ?? (open ? "waiting" : "none")}>
                {(r.decision || open) && <Icon name={r.decision === "approved" ? "check" : r.decision === "changes_requested" ? "refresh" : "hourglass"} size={14} sw={2} />}
                {word}
                {r.decidedAt && <When iso={r.decidedAt} />}
              </span>
              {r.comment && <p className="kapv-rev-comment">{r.comment}</p>}
            </li>
          );
        })}
      </ul>
      {a.canDecide && !compact && (
        <DecideBox approval={a} currentUserId={currentUserId} asker={asker} onDecided={onDecided} onStale={onStale} />
      )}
      {confirming && (
        <div className="kapv-confirm" role="group" aria-label="Cancel this request?"
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setConfirming(false); } }}>
          <span className="kapv-confirm-q">Cancel this request? Reviewers won't be asked any more.</span>
          <Button ref={keepRef} variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>Keep it</Button>
          <Button variant="danger" size="sm" loading={busy} onClick={() => void cancel()}>Cancel request</Button>
        </div>
      )}
      {err && <p className="kapv-err" role="alert">{err}</p>}
    </article>
  );
}

/* A reviewer's say: a comment (optional), Request changes / Approve. Until it resolves they can change their mind. */
function DecideBox({ approval: a, currentUserId, asker, onDecided, onStale }: {
  approval: Approval;
  currentUserId: string;
  asker: string;
  onDecided: (a: Approval, d: ApprovalDecision) => void;
  onStale: () => void;
}) {
  const ids = "kapvd" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const mine = a.reviewers.find((r) => r.userId === currentUserId)?.decision ?? null;
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => autoGrow(ref.current), [comment]);
  const over = comment.trim().length > APPROVAL_LIMITS.comment;
  const decide = async (d: ApprovalDecision) => {
    if (busy || over) return;
    setBusy(d); setErr(null);
    try {
      const r = await decideApproval(a.id, d, comment);
      if (!alive.current) return;
      setComment("");
      onDecided(r, d);
    } catch (e) {
      if (!alive.current) return;
      setErr(approvalErrorText(e, "decide"));
      const r = approvalFailure(e);
      if (r === "closed" || r === "not_found") onStale();
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  return (
    <div className="kapv-decide" role="group" aria-labelledby={`${ids}-h`}>
      <p className="kapv-decide-note" id={`${ids}-h`}>
        {mine === "approved" ? "You approved this. You can change your mind until everyone has decided."
          : mine === "changes_requested" ? "You asked for changes."
          : `${asker} asked you to review this.`}
      </p>
      <textarea ref={ref} className="kapv-text" rows={1} value={comment} disabled={!!busy}
        placeholder={mine ? "Say why (optional)" : "Add a comment (optional)"} aria-label="Comment with your review (optional)"
        aria-invalid={over || undefined} aria-describedby={over ? `${ids}-over` : undefined}
        onChange={(e) => { setComment(e.target.value); setErr(null); }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && comment) { e.preventDefault(); e.stopPropagation(); setComment(""); }
        }} />
      {over && <p className="kapv-err" id={`${ids}-over`}>The comment is too long ({APPROVAL_LIMITS.comment.toLocaleString("en-GB")} characters at most).</p>}
      {err && <p className="kapv-err" role="alert">{err}</p>}
      <div className="kapv-actions">
        {mine !== "changes_requested" && (
          <Button variant="secondary" size="sm" icon="refresh" loading={busy === "changes_requested"} disabled={!!busy || over}
            onClick={() => void decide("changes_requested")}>{mine ? "Request changes instead" : "Request changes"}</Button>
        )}
        {mine !== "approved" && (
          <Button variant="primary" size="sm" icon="check" loading={busy === "approved"} disabled={!!busy || over}
            onClick={() => void decide("approved")}>{mine ? "Approve instead" : "Approve"}</Button>
        )}
      </div>
    </div>
  );
}

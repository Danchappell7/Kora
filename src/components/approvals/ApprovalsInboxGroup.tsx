/* ============================================================
   KANBO — Inbox › "Approvals for you".                        [0047 · w4]
   Open requests waiting on your decision, newest first: who asked, the
   task, its project, their note, the file, the rule ("Everyone must
   approve · 1 of 2"); Approve / Request changes (with an optional
   comment). Rows look and move like the Inbox's own.
   Keys, only while a row in this group has focus (so the Inbox's own A =
   "Add to Today" is untouched elsewhere): J/K or ↑/↓ move, A approve,
   C request changes (opens a comment; ⌘/Ctrl+↵ sends, Escape puts it
   away), Enter opens the task. The Inbox's other letters (R, D, H, E)
   do nothing here rather than act on a row elsewhere.
   Data: lib/approvals. Renders nothing while nothing waits on you; once
   you've cleared it on this visit it says so (and keeps your place).
   Mount (integrator): InboxView, above the triage groups (segment Inbox) —
     <ApprovalsInboxGroup approvals={my.toReview} projects={projects}
       members={members} currentUserId={me} onOpenTask={openTask}
       onDecided={() => { refreshMyApprovals(); refreshBadges(); }} />
   ============================================================ */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Approval, ApprovalDecision, ApprovalWithTask, Member, Project } from "../../data/types";
import { Button, Icon, Kbd, ProjectTile, SectionLabel } from "../primitives";
import { APPROVAL_LIMITS, approvalActivityVerb, approvalErrorText, approvalFailure, decideApproval } from "../../lib/approvals";
import { PersonMark, When, autoGrow, useAnnounce } from "./parts";
import "./approvals.css";

export interface ApprovalsInboxGroupProps {
  /** lib/approvals listMyApprovals().toReview */
  approvals: ApprovalWithTask[];
  projects: Project[];
  members: Member[];
  currentUserId: string;
  onOpenTask: (taskId: string) => void;
  /** after a decision (the host drops it from the group and refreshes badges) */
  onDecided?: (approval: Approval) => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
/** the Inbox's own one-key actions: never let them act on another row while this group has focus */
const INBOX_KEYS = new Set(["r", "d", "h", "e"]);
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable);

export function ApprovalsInboxGroup({ approvals, projects, members, currentUserId, onOpenTask, onDecided }: ApprovalsInboxGroupProps) {
  const ids = "kapvi" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  // decided (or found closed) on this visit: gone at once, whatever the host's list says until it refreshes
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [composing, setComposing] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<{ id: string; decision: ApprovalDecision } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState(0);
  const { say, message } = useAnnounce();
  const mainRefs = useRef(new Map<string, HTMLButtonElement>());
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const doneRef = useRef<HTMLParagraphElement>(null);
  const focusNext = useRef<string | "done" | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const rows = approvals.filter((a) => a.status === "pending" && a.canDecide !== false && !gone.has(a.id));
  const cursorOn = cursor && rows.some((a) => a.id === cursor) ? cursor : null;

  useEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    focusNext.current = null;
    if (f === "done") doneRef.current?.focus({ preventScroll: true });
    else mainRefs.current.get(f)?.focus({ preventScroll: true });
  });

  if (!rows.length && !cleared) return null;

  const nameOf = (id: string | null, fallback: string | null) => (id && members.find((m) => m.id === id)?.name) || fallback || "Someone";
  const titleOf = (a: ApprovalWithTask) => a.task?.title || a.title || "a task";
  const neighbour = (id: string) => {
    const i = rows.findIndex((a) => a.id === id);
    return (rows[i + 1] ?? rows[i - 1])?.id ?? null;
  };
  const moveTo = (id: string | null) => {
    if (!id) return;
    setCursor(id);
    mainRefs.current.get(id)?.focus({ preventScroll: true });
    rowRefs.current.get(id)?.scrollIntoView?.({ block: "nearest" });
  };
  const open = (a: ApprovalWithTask) => { if (a.task) onOpenTask(a.task.id); };
  const drop = (a: ApprovalWithTask) => {
    const next = neighbour(a.id);
    focusNext.current = next ?? "done";
    setGone((g) => new Set(g).add(a.id));
    setCleared((n) => n + 1);
    setComposing((c) => (c === a.id ? null : c));
    setDrafts((d) => { const { [a.id]: _, ...rest } = d; return rest; });
    if (next) setCursor(next);
  };
  const decide = async (a: ApprovalWithTask, d: ApprovalDecision) => {
    if (busy) return;
    // The draft belongs to "Request changes" only. One put away with Escape stays for next time, but it
    // never rides along on an Approve: the requester would read criticism beside "Approved" (and so would
    // the email, push and webhooks). This group has no approval comment; the task's panel has one, in view.
    const comment = d === "changes_requested" ? (drafts[a.id] ?? "").trim() : "";
    if (comment.length > APPROVAL_LIMITS.comment) {
      setErrors((e) => ({ ...e, [a.id]: `The comment is too long (${APPROVAL_LIMITS.comment.toLocaleString("en-GB")} characters at most).` }));
      return;
    }
    setBusy({ id: a.id, decision: d });
    setErrors((e) => { const { [a.id]: _, ...rest } = e; return rest; });
    try {
      const r = await decideApproval(a.id, d, comment || null);
      if (!alive.current) return;
      drop(a);
      say(d === "approved" ? `Approved “${titleOf(a)}”` : `Asked for changes on “${titleOf(a)}”`);
      onDecided?.(r);
    } catch (e) {
      if (!alive.current) return;
      const reason = approvalFailure(e);
      if (reason === "closed" || reason === "not_found") {
        drop(a);
        say(approvalErrorText(e, "decide"), "info");
      } else {
        setErrors((x) => ({ ...x, [a.id]: approvalErrorText(e, "decide") }));
      }
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  const startChanges = (a: ApprovalWithTask) => { setCursor(a.id); setComposing(a.id); };
  const stopChanges = (a: ApprovalWithTask) => {
    setComposing(null);
    window.setTimeout(() => mainRefs.current.get(a.id)?.focus({ preventScroll: true }), 0);
  };

  /* keys while focus is inside a row (the composer handles its own) */
  const onRowKey = (a: ApprovalWithTask) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    const i = rows.findIndex((x) => x.id === a.id);
    if (k === "j" || k === "ArrowDown") { handled(); moveTo(rows[Math.min(rows.length - 1, i + 1)]?.id ?? null); return; }
    if (k === "k" || k === "ArrowUp") { handled(); moveTo(rows[Math.max(0, i - 1)]?.id ?? null); return; }
    if (k === "a") { handled(); if (!e.repeat) void decide(a, "approved"); return; }
    if (k === "c") { handled(); if (!e.repeat) startChanges(a); return; }
    if (k === "Enter" && e.target === mainRefs.current.get(a.id)) { handled(); open(a); return; }
    if (INBOX_KEYS.has(k)) { e.stopPropagation(); return; }
  };

  const renderRow = (a: ApprovalWithTask) => {
    const title = titleOf(a);
    const asker = nameOf(a.requestedBy, a.requestedByName);
    const proj = a.task ? projects.find((p) => p.id === a.task!.projectId) : undefined;
    const isCursor = cursorOn === a.id;
    const isComposing = composing === a.id;
    const working = busy?.id === a.id;
    const approved = a.reviewers.filter((r) => r.decision === "approved").length;
    const subId = `${ids}-${a.id}`;
    const ruleWords = a.rule === "all" && a.reviewers.length > 1 ? `Everyone must approve · ${approved} of ${a.reviewers.length}` : null;
    const describedBy = [proj && `${subId}-p`, a.note && `${subId}-n`, a.attachmentId && `${subId}-f`, ruleWords && `${subId}-r`, `${subId}-w`].filter(Boolean).join(" ");
    return (
      <div key={a.id} role="listitem" className="kapv-irow" data-cursor={isCursor || undefined} data-open={isComposing || undefined}
        ref={(el) => { if (el) rowRefs.current.set(a.id, el); else rowRefs.current.delete(a.id); }}
        onFocus={() => { if (cursorOn !== a.id) setCursor(a.id); }} onKeyDown={onRowKey(a)}>
        <PersonMark id={a.requestedBy} name={asker} size={28} />
        <div className="kapv-ibody">
          <button type="button" className="kapv-imain" aria-describedby={describedBy} aria-keyshortcuts="A C Enter"
            aria-disabled={a.task ? undefined : true} title={a.task ? undefined : "You can't open this task"}
            ref={(el) => { if (el) mainRefs.current.set(a.id, el); else mainRefs.current.delete(a.id); }}
            onClick={() => open(a)}>
            <span className="kapv-isay"><strong>{asker}</strong> {approvalActivityVerb({ event: "requested" })} <strong>{title}</strong></span>
          </button>
          <div className="kapv-isub">
            {proj && <span className="kapv-iproj" id={`${subId}-p`}><ProjectTile project={proj} size={16} /><span>{proj.name}</span></span>}
            {a.note && <span className="kapv-inote" id={`${subId}-n`} title={a.note}>“{a.note}”</span>}
            {a.attachmentId && <span className="kapv-imark" id={`${subId}-f`}><Icon name="folder" size={12} sw={2} /> A file</span>}
            {ruleWords && <span className="kapv-imark" id={`${subId}-r`}>{ruleWords}</span>}
          </div>
          {isComposing && (
            <ChangesComposer approval={a} value={drafts[a.id] ?? ""} busy={working}
              onChange={(v) => { setDrafts((d) => ({ ...d, [a.id]: v })); setErrors((e) => { const { [a.id]: _, ...rest } = e; return rest; }); }}
              onSend={() => void decide(a, "changes_requested")} onCancel={() => stopChanges(a)} />
          )}
          {errors[a.id] && <p className="kapv-err" role="alert">{errors[a.id]}</p>}
        </div>
        <div className="kapv-iside">
          <span id={`${subId}-w`}><When iso={a.createdAt} /></span>
          {!isComposing && (
            <span className="kapv-iacts">
              <Button variant="ghost" size="sm" icon="refresh" data-act="changes" aria-keyshortcuts="C" data-tip="Request changes · C"
                aria-label={`Request changes on “${title}”`} disabled={!!busy} onClick={() => startChanges(a)}
                tabIndex={isCursor ? 0 : -1}>Changes</Button>
              <Button variant="secondary" size="sm" icon="check" data-act="approve" aria-keyshortcuts="A" data-tip="Approve · A"
                aria-label={`Approve “${title}”`} loading={working && busy?.decision === "approved"} disabled={!!busy && !working}
                onClick={() => void decide(a, "approved")} tabIndex={isCursor ? 0 : -1}>Approve</Button>
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className="kinbox-group kapv-inbox" aria-labelledby={`${ids}-h`}>
      <SectionLabel id={`${ids}-h`} count={rows.length || undefined}>Approvals for you</SectionLabel>
      {rows.length > 0 ? (
        <div role="list" className="kapv-irows">{rows.map(renderRow)}</div>
      ) : (
        <p className="kapv-done" ref={doneRef} tabIndex={-1}>
          <Icon name="check" size={14} sw={2} style={{ verticalAlign: "-2px", marginRight: 6, color: "var(--ok)" }} />
          You're all caught up on approvals.
        </p>
      )}
      {rows.length > 0 && (
        <div className="kapv-keys" aria-hidden="true">
          <span><Kbd>A</Kbd> approve</span>
          <span><Kbd>C</Kbd> request changes</span>
          <span><Kbd>↵</Kbd> open</span>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">{message}</p>
    </section>
  );
}

/* "Request changes": a comment that grows as you write. ⌘/Ctrl+↵ sends, Escape puts it away (the draft
   stays for the next C, and is never sent with an Approve). */
function ChangesComposer({ approval: a, value, busy, onChange, onSend, onCancel }: {
  approval: ApprovalWithTask;
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange?.(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => autoGrow(ref.current), [value]);
  const asker = a.requestedByName?.split(/\s+/)[0] || "them";
  const over = value.trim().length > APPROVAL_LIMITS.comment;
  return (
    <div className="kapv-icompose">
      <textarea ref={ref} className="kapv-text" rows={2} value={value} disabled={busy}
        placeholder={`What needs to change? ${asker} will see this.`} aria-label={`What needs to change? ${asker} will see this.`}
        aria-invalid={over || undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); onSend(); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }} />
      <div className="kapv-icompose-foot">
        <span className="kapv-hint" style={{ color: over ? "var(--signal)" : undefined } as CSSProperties}>
          {over ? `${value.trim().length.toLocaleString("en-GB")} / ${APPROVAL_LIMITS.comment.toLocaleString("en-GB")} characters` : "A comment is optional"}
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="primary" size="sm" icon="refresh" kbd={isMac ? "⌘↵" : "Ctrl ↵"} loading={busy} disabled={over} onClick={onSend}>Request changes</Button>
      </div>
    </div>
  );
}

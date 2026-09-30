/* ============================================================
   KANBO — the status-update composer: a status, the words (Kanbo
   drafts them on request) and Post update. The project header and
   the directory open it as a popover; the Updates tab keeps it at
   the top of the history. Every one of them edits the same draft
   per project, so closing a popover or switching tabs never throws
   typed words away.
   ============================================================ */
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { AiMark, Button, Provenance, Segmented } from "../primitives";
import { Popover } from "../primitives/Popover";
import { KANBO_TODAY, todayISO } from "../../data/data";
import type { Project, StatusKind, StatusUpdate, Task } from "../../data/types";
import type { AiOutcome } from "../../lib/askTypes";
import { draftStatusLocal, factLines, statusFacts, statusFactsForAi, statusFromHealth, type StatusFacts } from "../../lib/statusDraft";
import "./projects.css";

export type PostStatus = (projectId: string, summary: string, status: StatusKind) => Promise<boolean> | void;
export type AiStatus = (facts: unknown) => Promise<AiOutcome<{ summary: string; status: StatusKind }>>;

export const STATUS_OPTIONS: { value: StatusKind; label: string }[] = [
  { value: "on_track", label: "On track" },
  { value: "at_risk", label: "At risk" },
  { value: "off_track", label: "Off track" },
];
const KINDS = new Set<string>(STATUS_OPTIONS.map((o) => o.value));

export const PLACEHOLDER = "What's the latest? Wins, risks, next steps…";

/* ---------------- the drafts: one per project, shared by every composer ----------------
   The header popover, the Updates tab and a directory row all read and write
   the same draft, and it outlives each of them (switching tab unmounts the
   Updates tab). Kept in memory only: signing out reloads the page, so nothing
   is left behind for the next person at this desk. */
interface Draft {
  text: string;
  /** null: not chosen yet, so it follows the latest update (or the project's health) */
  kind: StatusKind | null;
  /** what wrote the words: Kanbo's AI, the on-device template, or you (null) */
  source: "ai" | "template" | null;
  note: string | null;
  /** you've changed Kanbo's words, so they're yours now */
  edited: boolean;
}
interface Entry { draft?: Draft; drafting?: { seq: number; typed: boolean }; posting?: boolean }
const EMPTY: Draft = { text: "", kind: null, source: null, note: null, edited: false };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let draftSeq = 0;
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const patchEntry = (pid: string, patch: Partial<Entry>) => {
  entries.set(pid, { ...entries.get(pid), ...patch });
  listeners.forEach((fn) => fn());
};
const writeDraft = (pid: string, patch: Partial<Draft>) => patchEntry(pid, { draft: { ...(entries.get(pid)?.draft ?? EMPTY), ...patch } });

/** Forget every draft (tests start from a clean slate). */
export function clearStatusDrafts(): void {
  entries.clear();
  listeners.forEach((fn) => fn());
}

export interface Composer {
  project: Project;
  facts: StatusFacts;
  text: string;
  setText: (v: string) => void;
  kind: StatusKind;
  setKind: (k: StatusKind) => void;
  /** what wrote the words: Kanbo's AI, the on-device template, or you */
  source: Draft["source"];
  note: string | null;
  drafting: boolean;
  /** fill the words: Kanbo's AI when it's on, else the on-device template */
  draft: (how?: "best" | "template") => void;
  /** Draft update: Kanbo writes it, unless there are words worth keeping (yours, or its own) */
  ensureDraft: () => void;
  /** Post update: an empty field to write in. Kanbo's untouched words go; yours stay. */
  startFresh: () => void;
  canDraftAi: boolean;
  canPost: boolean;
  posting: boolean;
  post: () => void;
}

/** Why the on-device draft stood in for Kanbo's (the interface never says "AI", §2.3). */
const why = (out: AiOutcome<unknown> | null): string =>
  out?.source === "limit" ? "You've used today's Kanbo drafts, so this one was written on this device."
  : out?.source === "off" ? "Kanbo's drafting is turned off, so this one was written on this device."
  : "Kanbo couldn't draft this one just now, so it was written on this device.";

/**
 * A composer for one project. Its draft is shared with every other composer
 * on the same project and survives unmounting. `onPosted` runs once the
 * update is saved; a failed save keeps the words (the caller shows the error).
 */
export function useStatusComposer({ project, tasks, statusUpdates, onPost, aiStatus, onPosted }: {
  project: Project;
  tasks: Task[];
  statusUpdates: StatusUpdate[];
  onPost?: PostStatus;
  aiStatus?: AiStatus;
  onPosted?: () => void;
}): Composer {
  // the facts read today's date, so they recompute when the day rolls over in a tab left open
  const today = todayISO();
  const facts = useMemo(() => statusFacts(project, tasks, statusUpdates, KANBO_TODAY), [project, tasks, statusUpdates, today]);
  const id = project.id;
  const entry = useSyncExternalStore(subscribe, () => entries.get(id));
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const onPostedRef = useRef(onPosted);
  onPostedRef.current = onPosted;

  const cur = entry?.draft ?? EMPTY;
  const kind = cur.kind ?? facts.latest?.status ?? statusFromHealth(facts.health);
  const drafting = !!entry?.drafting;
  const posting = !!entry?.posting;

  const draft = (how: "best" | "template" = "best") => {
    const pid = id;
    const local = draftStatusLocal(facts);
    if (!aiStatus || how === "template") {
      patchEntry(pid, { drafting: undefined, draft: { text: local.summary, kind: local.status, source: "template", note: null, edited: false } });
      return;
    }
    const seq = ++draftSeq;
    patchEntry(pid, { drafting: { seq, typed: false } });
    // the draft lands even if this composer has gone (it's shared), unless it was superseded
    const settle = (out: AiOutcome<{ summary: string; status: StatusKind }> | null) => {
      const pending = entries.get(pid)?.drafting;
      if (pending?.seq !== seq) return;
      patchEntry(pid, { drafting: undefined });
      if (pending.typed) return; // your words win over a late draft
      const summary = out?.source === "ai" ? out.data?.summary?.trim() : "";
      if (out?.source === "ai" && summary) {
        const k = KINDS.has(out.data.status) ? out.data.status : local.status;
        writeDraft(pid, { text: summary, kind: k, source: "ai", note: null, edited: false });
      } else {
        writeDraft(pid, { text: local.summary, kind: local.status, source: "template", note: why(out), edited: false });
      }
    };
    let pending: Promise<AiOutcome<{ summary: string; status: StatusKind }>>;
    try { pending = aiStatus(statusFactsForAi(facts)); } catch { settle(null); return; }
    pending.then(settle, () => settle(null));
  };

  const hasText = !!cur.text.trim();
  const ensureDraft = () => {
    if (drafting) return;
    // an untouched on-device draft is replaced by Kanbo's AI when it's on (unless the AI just fell back to it)
    const redraft = !hasText || (cur.source === "template" && !cur.edited && !cur.note && !!aiStatus);
    if (redraft) draft();
  };
  const startFresh = () => {
    if (drafting) patchEntry(id, { drafting: undefined });
    if (hasText && cur.source && !cur.edited) writeDraft(id, { ...EMPTY });
  };

  const post = () => {
    const v = cur.text.trim();
    if (!v || posting || !onPost) return;
    const pid = id;
    const done = () => {
      // words typed while it was saving are kept
      const now = entries.get(pid)?.draft;
      patchEntry(pid, { posting: false, ...(now && now.text.trim() !== v ? {} : { draft: EMPTY }) });
      if (alive.current) onPostedRef.current?.();
    };
    const r = onPost(pid, v, kind);
    if (r && typeof (r as Promise<boolean>).then === "function") {
      patchEntry(pid, { posting: true });
      (r as Promise<boolean>).then(
        (ok) => { if (ok) done(); else patchEntry(pid, { posting: false }); },
        () => patchEntry(pid, { posting: false }),
      );
    } else done();
  };

  return {
    project, facts,
    text: cur.text,
    setText: (v) => {
      if (entry?.drafting) patchEntry(id, { drafting: { ...entry.drafting, typed: true } });
      writeDraft(id, v.trim() ? { text: v, edited: true } : { text: v, source: null, note: null, edited: false });
    },
    kind,
    setKind: (k) => writeDraft(id, { kind: k }),
    source: hasText ? cur.source : null,
    note: hasText ? cur.note : null,
    drafting,
    draft,
    ensureDraft,
    startFresh,
    canDraftAi: !!aiStatus,
    canPost: !!onPost,
    posting,
    post,
  };
}

/** A P11 popover's panel: raised surface, r-lg and --e2, whose own 1px ring is the
 *  edge (so no border on top of it; before the Paper & Navy tokens, the fallback
 *  draws that ring itself). */
export const POP_STYLE = {
  borderRadius: "var(--r-lg, 12px)", border: "none", background: "var(--surface-raised)",
  boxShadow: "var(--e2, 0 0 0 1px var(--hairline), var(--shadow-lg))",
} as const;

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl ";
const FOCUSABLE = 'button:not([disabled]),textarea:not([disabled]),input:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';

/** The composer's body: status, the words, and its buttons. */
export function ComposerPanel({ c, onCancel, textRef, title }: {
  c: Composer;
  onCancel?: () => void;
  textRef?: RefObject<HTMLTextAreaElement>;
  /** a heading line (the popover names the project) */
  title?: string;
}) {
  const { facts } = c;
  const empty = !c.text.trim();
  // the field grows with the words (up to a point), so a drafted update is readable without scrolling
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = textRef ?? ownRef;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight + 2, c.source === "ai" ? 72 : 104), 280)}px`;
  }, [c.text, c.source, ref]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); c.post(); }
  };
  const field = (
    <textarea ref={ref} value={c.text} onChange={(e) => c.setText(e.target.value)} onKeyDown={onKeyDown}
      placeholder={c.drafting ? "Kanbo is drafting…" : PLACEHOLDER} aria-label="Update" rows={4}
      aria-busy={c.drafting || undefined} className={c.source === "ai" ? undefined : "kpj-field"}
      // inside the vellum card the card itself shows focus (a ring round the card, not a box inside it)
      data-focus-ring={c.source === "ai" ? "none" : undefined} />
  );
  const changes = facts.changes === 1 ? "1 change" : `${facts.changes} changes`;
  return (
    <div className="kpj-composer">
      {title && (
        <div className="kpj-composer-head">
          <span className="kpj-composer-title">{title}</span>
        </div>
      )}
      <Segmented ariaLabel="Project status" options={STATUS_OPTIONS} value={c.kind} onChange={c.setKind} />
      {/* one wrapper either way, so the field never remounts (and never drops focus) as Kanbo's words arrive or go */}
      <div className={c.source === "ai" ? "kvellum" : "kpj-draft"}>
        {field}
        {c.source === "ai" && <Provenance summary={`from this week's ${changes}`} details={factLines(facts)} />}
      </div>
      {c.source === "template" && (
        <p className="kpj-composer-note">{c.note ?? `Drafted on this device from this week's ${changes}.`} Edit it before you post.</p>
      )}
      <div className="kpj-composer-foot">
        <Button variant="ghost" size="sm" onClick={() => { if (!c.drafting) c.draft(); }} aria-busy={c.drafting || undefined}>
          <span className="kpj-btn-mark"><AiMark size={14} thinking={c.drafting} />{c.drafting ? "Drafting" : empty ? "Draft it for me" : "Redraft"}</span>
        </Button>
        <span className="kpj-spacer" />
        {onCancel && <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
        {c.canPost && (
          <Button variant="primary" size="sm" onClick={c.post} disabled={empty || c.posting} loading={c.posting} kbd={`${MOD}↵`}>Post update</Button>
        )}
      </div>
    </div>
  );
}

/** The composer as a 400px popover under its trigger (header "Draft update" / "Post update", directory rows). */
export function ComposerPopover({ open, anchorRef, onClose, c }: {
  open: boolean;
  anchorRef: RefObject<HTMLElement>;
  onClose: () => void;
  c: Composer;
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  // a small dialog: Tab cycles inside it (Popover leaves Tab alone for dialogs)
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const els = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex >= 0);
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const n = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i === els.length - 1 ? 0 : i + 1);
    e.preventDefault();
    els[n].focus();
  };
  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} role="dialog" label={`Post an update on ${c.project.name}`}
      align="end" minWidth={320} initialFocus={textRef} className="kpj-pop"
      style={{ ...POP_STYLE, width: 400, padding: 0 }}>
      <div onKeyDown={onKeyDown}>
        <ComposerPanel c={c} onCancel={onClose} textRef={textRef} title={`Update on ${c.project.name}`} />
      </div>
    </Popover>
  );
}

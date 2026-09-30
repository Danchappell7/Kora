/* ============================================================
   KANBO — the status-update composer: a status, the words (Kanbo
   drafts them on request) and Post update. The project header and
   the directory open it as a popover; the Updates tab keeps it at
   the top of the history. The draft lives in useStatusComposer, so
   closing the popover never throws typed words away.
   ============================================================ */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { AiMark, Button, Segmented, Vellum } from "../primitives";
import { Popover } from "../primitives/Popover";
import { KANBO_TODAY } from "../../data/data";
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

interface Draft { text: string; kind: StatusKind; source: "ai" | "template" | null; note: string | null }

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
  canDraftAi: boolean;
  canPost: boolean;
  posting: boolean;
  post: () => void;
}

const why = (out: AiOutcome<unknown> | null): string | null =>
  out?.source === "limit" ? "You've used today's Kanbo AI allowance, so this was drafted on this device."
  : "Kanbo's AI couldn't draft this one, so it was drafted on this device.";

/**
 * One composer's state, per project (switching projects keeps each draft).
 * `onPosted` runs once the update is saved; a failed save keeps the words
 * (the caller shows the error).
 */
export function useStatusComposer({ project, tasks, statusUpdates, onPost, aiStatus, onPosted }: {
  project: Project;
  tasks: Task[];
  statusUpdates: StatusUpdate[];
  onPost?: PostStatus;
  aiStatus?: AiStatus;
  onPosted?: () => void;
}): Composer {
  const facts = useMemo(() => statusFacts(project, tasks, statusUpdates, KANBO_TODAY), [project, tasks, statusUpdates]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [draftingFor, setDraftingFor] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const seq = useRef(0);
  const typedWhileDrafting = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const onPostedRef = useRef(onPosted);
  onPostedRef.current = onPosted;

  const id = project.id;
  const fallbackKind = facts.latest?.status ?? statusFromHealth(facts.health);
  const cur: Draft = drafts[id] ?? { text: "", kind: fallbackKind, source: null, note: null };
  const write = (pid: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [pid]: { ...(d[pid] ?? { text: "", kind: fallbackKind, source: null, note: null }), ...patch } }));

  const draft = (how: "best" | "template" = "best") => {
    const pid = id;
    const local = draftStatusLocal(facts);
    const n = ++seq.current;
    if (!aiStatus || how === "template") {
      setDraftingFor(null);
      write(pid, { text: local.summary, kind: local.status, source: "template", note: null });
      return;
    }
    typedWhileDrafting.current = false;
    setDraftingFor(pid);
    const settle = (out: AiOutcome<{ summary: string; status: StatusKind }> | null) => {
      if (!alive.current || n !== seq.current) return;
      setDraftingFor(null);
      if (typedWhileDrafting.current) return; // your words win over a late draft
      const summary = out?.source === "ai" ? out.data?.summary?.trim() : "";
      if (out?.source === "ai" && summary) {
        const kind = KINDS.has(out.data.status) ? out.data.status : local.status;
        write(pid, { text: summary, kind, source: "ai", note: null });
      } else {
        write(pid, { text: local.summary, kind: local.status, source: "template", note: why(out) });
      }
    };
    let pending: Promise<AiOutcome<{ summary: string; status: StatusKind }>>;
    try { pending = aiStatus(statusFactsForAi(facts)); } catch { settle(null); return; }
    pending.then(settle, () => settle(null));
  };

  const post = () => {
    const v = cur.text.trim();
    if (!v || posting || !onPost) return;
    const pid = id;
    const done = () => { write(pid, { text: "", source: null, note: null }); onPostedRef.current?.(); };
    const r = onPost(pid, v, cur.kind);
    if (r && typeof (r as Promise<boolean>).then === "function") {
      setPosting(true);
      (r as Promise<boolean>).then(
        (ok) => { if (!alive.current) return; setPosting(false); if (ok) done(); },
        () => { if (alive.current) setPosting(false); },
      );
    } else done();
  };

  return {
    project, facts,
    text: cur.text,
    setText: (v) => { if (draftingFor === id) typedWhileDrafting.current = true; write(id, { text: v, ...(v.trim() ? {} : { source: null, note: null }) }); },
    kind: cur.kind,
    setKind: (k) => write(id, { kind: k }),
    source: cur.text.trim() ? cur.source : null,
    note: cur.text.trim() ? cur.note : null,
    drafting: draftingFor === id,
    draft,
    canDraftAi: !!aiStatus,
    canPost: !!onPost,
    posting,
    post,
  };
}

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
      aria-busy={c.drafting || undefined} className={c.source === "ai" ? undefined : "kpj-field"} />
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
      {c.source === "ai"
        ? <Vellum provenance={{ summary: `from this week's ${changes}`, details: factLines(facts) }}>{field}</Vellum>
        : field}
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
      style={{ width: 400, padding: 0, borderRadius: "var(--r-lg, 12px)", boxShadow: "var(--e2, var(--shadow-lg))", background: "var(--surface-raised)" }}>
      <div onKeyDown={onKeyDown}>
        <ComposerPanel c={c} onCancel={onClose} textRef={textRef} title={`Update on ${c.project.name}`} />
      </div>
    </Popover>
  );
}

/* ============================================================
   KANBO — project docs: autosave with optimistic concurrency.  [0047, w5]
   touch() after every change: the doc saves after 2 s of quiet (and at
   once on flush(), which the editor calls on blur and when it closes).
   Each save sends the updatedAt it last loaded or saved as its base; the
   server answers 'conflict' with the other person's copy when someone
   saved in between — autosave stops until the editor resolves it
   (reload theirs, or keep mine = save again on their updatedAt, as a
   version of its own so theirs stays in the history).
   Offline / network failures retry with backoff (and when the browser
   comes back online); a refusal (too large, not allowed) waits for the
   next change. Edits made while a save is in flight go in the next one.
   Changes that can't be saved yet are handed to deps.keep (the editor
   keeps them in this tab and offers them back when the doc opens again);
   deps.forget once the server has everything.
   Closing (dispose) stops the timers and every callback to the editor,
   but never drops words: a save in flight finishes, the one queued
   behind it (what was typed meanwhile) still goes, and whatever can't be
   saved then is kept.
   ============================================================ */
import type { DocBlock, DocFailure, DocSaveResult, DocSaveState, ProjectDoc } from "../../data/types";
import { docKey, mentionsIn } from "../../lib/docBlocks";
import { DOC_AUTOSAVE_MS, docFailure, type DocSaveRequest } from "../../lib/docs";

export interface DocSaverDeps {
  docId: string;
  projectId: string;
  save: (input: DocSaveRequest) => Promise<DocSaveResult>;
  /** what the editor holds now */
  draft: () => { title: string; body: DocBlock[] };
  onState: (state: DocSaveState) => void;
  onSaved: (doc: ProjectDoc) => void;
  onConflict: (theirs: ProjectDoc) => void;
  /** the doc was deleted (or its project went to the bin) while it was open */
  onGone: () => void;
  /** a refusal or failure that needs the person (not offline) */
  onError: (why: DocFailure, error: unknown) => void;
  /** changes that can't be saved now (offline, refused, a conflict waiting, or the editor closed first) */
  keep?: (draft: { title: string; body: DocBlock[]; base: string }) => void;
  /** the server holds everything now: what keep() kept can go */
  forget?: () => void;
  delayMs?: number;
}

export interface DocSaver {
  /** the contents changed: save after a quiet spell */
  touch(): void;
  /** save now if there's anything to save; resolves when nothing's left to send (saved, or stopped:
   *  offline, a conflict, a refusal, gone) */
  flush(): Promise<void>;
  /** keep mine after a conflict: save again on top of their copy (as a version of its own) */
  keepMine(theirsUpdatedAt: string): Promise<void>;
  /** reload theirs after a conflict (or a quiet update while nothing's unsaved): put their copy in the
   *  editor first, then adopt its updatedAt as the base */
  adopt(updatedAt: string): void;
  /** stop autosaving for now (a conflict noticed by realtime) */
  hold(): void;
  /** the next save is a version of its own (a restore): what the doc said before stays in Version history */
  checkpoint(): void;
  /** the doc was deleted while open (realtime): nothing more can be saved */
  markGone(): void;
  readonly base: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly held: boolean;
  readonly gone: boolean;
  readonly state: DocSaveState;
  /** the editor closed: no more timers or callbacks to it. Saves already asked for still finish (and the
   *  one queued behind a save in flight); what can't be saved is kept (deps.keep). */
  dispose(): void;
  /** undo dispose (React StrictMode unmounts and mounts again) */
  revive(): void;
}

const RETRY_MS = [2000, 5000, 15000, 30000];

export function createDocSaver(initialBase: string, deps: DocSaverDeps): DocSaver {
  const delay = deps.delayMs ?? DOC_AUTOSAVE_MS;
  let base = initialBase;
  let dirty = false;
  let saving: Promise<void> | null = null;
  let again = false;
  let held = false;
  let gone = false;
  /** the editor has closed: no timers, no callbacks to it */
  let closed = false;
  /** the state changed while closed (revive tells the editor) */
  let missed = false;
  let checkpointNext = false;
  let state: DocSaveState = "idle";
  let timer = 0;
  let retries = 0;
  /** what the server holds (as far as we know): the contents we loaded, then each save */
  let savedKey: string | null = (() => { const d = deps.draft(); return docKey(d.title, d.body); })();

  const setState = (s: DocSaveState) => {
    if (state === s) return;
    state = s;
    if (closed) missed = true; else deps.onState(s);
  };
  const clear = () => { if (timer) { window.clearTimeout(timer); timer = 0; } };
  const schedule = (ms: number) => {
    clear();
    if (closed) return;
    timer = window.setTimeout(() => { timer = 0; void flush(); }, ms);
  };
  /** hand what can't be saved to the editor's keeper (nothing when it's what the server has, or the doc's gone) */
  const keepDraft = () => {
    if (gone || !deps.keep) return;
    const d = deps.draft();
    if (docKey(d.title, d.body) === savedKey) return;
    deps.keep({ title: d.title, body: d.body, base });
  };
  const onOnline = () => { if (dirty && !held && !gone && !closed && state === "offline") void flush(); };
  if (typeof window !== "undefined") window.addEventListener("online", onOnline);

  async function run(): Promise<void> {
    const draft = deps.draft();
    const key = docKey(draft.title, draft.body);
    if (key === savedKey) { dirty = false; checkpointNext = false; setState("saved"); deps.forget?.(); return; }
    setState("saving");
    const checkpoint = checkpointNext;
    let result: DocSaveResult;
    try {
      result = await deps.save({
        id: deps.docId, projectId: deps.projectId, title: draft.title, body: draft.body,
        baseUpdatedAt: base, mentions: mentionsIn(draft.body), ...(checkpoint ? { checkpoint: true } : {}),
      });
    } catch (e) {
      const why = docFailure(e);
      if (why === "not_found") {
        gone = true; clear(); setState("error");
        if (!closed) deps.onGone();
        return;
      }
      if (why === "network") {
        setState("offline");
        keepDraft();
        schedule(RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)]);
        return;
      }
      setState("error");
      keepDraft();
      if (!closed) deps.onError(why, e);
      return;
    }
    retries = 0;
    if (result.status === "conflict") {
      held = true;
      clear();
      setState("conflict");
      keepDraft();
      if (!closed) deps.onConflict(result.doc);
      return;
    }
    if (checkpoint) checkpointNext = false;
    base = result.doc.updatedAt;
    savedKey = key;
    const now = deps.draft();
    if (docKey(now.title, now.body) === key) { dirty = false; setState("saved"); deps.forget?.(); }
    else if (!again) schedule(Math.min(delay, 600)); // more came in while it saved
    if (!closed) deps.onSaved(result.doc);
  }

  const stopped = () => held || gone || state === "offline" || state === "error";

  function flush(): Promise<void> {
    clear();
    if (saving) {
      // the one in flight read the doc before these changes: another save follows it
      if (dirty && !held && !gone) again = true;
      return saving;
    }
    if (gone || held || !dirty) return Promise.resolve();
    saving = (async () => {
      try {
        do {
          again = false;
          // (an answer it can't read is a failure like any other, never an unhandled rejection)
          await run().catch((e: unknown) => { setState("error"); keepDraft(); if (!closed) deps.onError(docFailure(e), e); });
        } while (again && dirty && !stopped());
      } finally {
        again = false;
        saving = null;
      }
    })();
    return saving;
  }

  return {
    touch() {
      if (gone) return;
      dirty = true;
      if (held) return;
      if (state !== "offline" && state !== "error") setState("saving");
      schedule(delay);
    },
    flush,
    async keepMine(theirsUpdatedAt: string) {
      base = theirsUpdatedAt;
      held = false;
      savedKey = null;
      dirty = true;
      checkpointNext = true;
      await flush();
    },
    adopt(updatedAt: string) {
      // (the editor has already put their copy in: it's what the server holds now)
      base = updatedAt;
      held = false;
      dirty = false;
      checkpointNext = false;
      const d = deps.draft();
      savedKey = docKey(d.title, d.body);
      clear();
      setState("saved");
      deps.forget?.();
    },
    hold() { held = true; clear(); setState("conflict"); keepDraft(); },
    checkpoint() { checkpointNext = true; },
    markGone() { gone = true; clear(); setState("error"); },
    get base() { return base; },
    get dirty() { return dirty; },
    get saving() { return !!saving; },
    get held() { return held; },
    get gone() { return gone; },
    get state() { return state; },
    dispose() {
      if (closed) return;
      closed = true;
      clear();
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
      // (kept in case the tab closes before a save under way lands; a save that lands forgets it)
      if (dirty) keepDraft();
    },
    revive() {
      if (!closed) return;
      closed = false;
      if (typeof window !== "undefined") window.addEventListener("online", onOnline);
      if (missed) { missed = false; deps.onState(state); }
      if (dirty && !held && !gone) schedule(delay);
    },
  };
}

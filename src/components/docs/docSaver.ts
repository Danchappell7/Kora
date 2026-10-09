/* ============================================================
   KANBO — project docs: autosave with optimistic concurrency.  [0047, w5]
   touch() after every change: the doc saves after 2 s of quiet (and at
   once on flush(), which the editor calls on blur and when it closes).
   Each save sends the updatedAt it last loaded or saved as its base; the
   server answers 'conflict' with the other person's copy when someone
   saved in between — autosave stops until the editor resolves it
   (reload theirs, or keep mine = save again on their updatedAt).
   Offline / network failures retry with backoff (and when the browser
   comes back online); a refusal (too large, not allowed) waits for the
   next change. Edits made while a save is in flight go in the next one.
   ============================================================ */
import type { DocBlock, DocFailure, DocSaveInput, DocSaveResult, DocSaveState, ProjectDoc } from "../../data/types";
import { docKey, mentionsIn } from "../../lib/docBlocks";
import { DOC_AUTOSAVE_MS, docFailure } from "../../lib/docs";

export interface DocSaverDeps {
  docId: string;
  projectId: string;
  save: (input: DocSaveInput) => Promise<DocSaveResult>;
  /** what the editor holds now */
  draft: () => { title: string; body: DocBlock[] };
  onState: (state: DocSaveState) => void;
  onSaved: (doc: ProjectDoc) => void;
  onConflict: (theirs: ProjectDoc) => void;
  /** the doc was deleted (or its project went to the bin) while it was open */
  onGone: () => void;
  /** a refusal or failure that needs the person (not offline) */
  onError: (why: DocFailure, error: unknown) => void;
  delayMs?: number;
}

export interface DocSaver {
  /** the contents changed: save after a quiet spell */
  touch(): void;
  /** save now if there's anything to save (resolves when it's done) */
  flush(): Promise<void>;
  /** keep mine after a conflict: save again on top of their copy */
  keepMine(theirsUpdatedAt: string): Promise<void>;
  /** reload theirs after a conflict (or a quiet update while nothing's unsaved): put their copy in the
   *  editor first, then adopt its updatedAt as the base */
  adopt(updatedAt: string): void;
  /** stop autosaving for now (a conflict noticed by realtime) */
  hold(): void;
  readonly base: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly held: boolean;
  readonly state: DocSaveState;
  /** stop: no more timers or callbacks (a save in flight still lands on the server) */
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
  let disposed = false;
  let state: DocSaveState = "idle";
  let timer = 0;
  let retries = 0;
  /** what the server holds (as far as we know): the contents we loaded, then each save */
  let savedKey: string | null = (() => { const d = deps.draft(); return docKey(d.title, d.body); })();

  const setState = (s: DocSaveState) => {
    if (state === s || disposed) return;
    state = s;
    deps.onState(s);
  };
  const clear = () => { if (timer) { window.clearTimeout(timer); timer = 0; } };
  const schedule = (ms: number) => {
    clear();
    timer = window.setTimeout(() => { timer = 0; void flush(); }, ms);
  };
  const onOnline = () => { if (dirty && !held && !gone && state === "offline") void flush(); };
  if (typeof window !== "undefined") window.addEventListener("online", onOnline);

  async function run(): Promise<void> {
    const draft = deps.draft();
    const key = docKey(draft.title, draft.body);
    if (key === savedKey) { dirty = false; setState("saved"); return; }
    setState("saving");
    let result: DocSaveResult;
    try {
      result = await deps.save({
        id: deps.docId, projectId: deps.projectId, title: draft.title, body: draft.body,
        baseUpdatedAt: base, mentions: mentionsIn(draft.body),
      });
    } catch (e) {
      if (disposed) return;
      const why = docFailure(e);
      if (why === "network") {
        setState("offline");
        schedule(RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)]);
        return;
      }
      if (why === "not_found") { gone = true; clear(); setState("error"); deps.onGone(); return; }
      setState("error");
      deps.onError(why, e);
      return;
    }
    if (disposed) return;
    retries = 0;
    if (result.status === "conflict") {
      held = true;
      clear();
      setState("conflict");
      deps.onConflict(result.doc);
      return;
    }
    base = result.doc.updatedAt;
    savedKey = key;
    const now = deps.draft();
    if (docKey(now.title, now.body) === key) { dirty = false; setState("saved"); }
    else schedule(Math.min(delay, 600)); // more came in while it saved
    deps.onSaved(result.doc);
  }

  async function flush(): Promise<void> {
    clear();
    if (disposed || gone || held || !dirty) return saving ?? undefined;
    if (saving) { again = true; return saving; }
    saving = run().finally(() => {
      saving = null;
      if (again && !disposed) { again = false; if (dirty && !held && !gone) void flush(); }
    });
    return saving;
  }

  return {
    touch() {
      if (disposed || gone) return;
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
      await flush();
    },
    adopt(updatedAt: string) {
      // (the editor has already put their copy in: it's what the server holds now)
      base = updatedAt;
      held = false;
      dirty = false;
      const d = deps.draft();
      savedKey = docKey(d.title, d.body);
      clear();
      setState("saved");
    },
    hold() { held = true; clear(); setState("conflict"); },
    get base() { return base; },
    get dirty() { return dirty; },
    get saving() { return !!saving; },
    get held() { return held; },
    get state() { return state; },
    dispose() {
      disposed = true;
      clear();
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
    },
    revive() {
      if (!disposed) return;
      disposed = false;
      if (typeof window !== "undefined") window.addEventListener("online", onOnline);
      if (dirty && !held && !gone) schedule(delay);
    },
  };
}

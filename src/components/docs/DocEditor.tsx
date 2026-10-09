/* ============================================================
   KANBO — the block editor for project docs.                 [0047, w5]
   Blocks: heading 1/2/3, paragraph, bulleted/numbered list, checklist,
   quote, divider, callout. "/" slash menu; Markdown shortcuts (#, -,
   [], >, ---); ⌘B / ⌘I / ⌘E / ⌘K for bold, italic, code, link; @mention
   members; "Make task" on any line (a backlink chip with the task's live
   status); paste of plain text / Markdown; arrow keys between blocks;
   autosave after 2 s idle and on blur (Saving… / Saved); the conflict
   banner ("Sana edited this — Reload / Keep mine"); version history
   drawer with restore. Read-only for guests. No new dependencies.

   How it works: each text block is its own contenteditable element
   (BlockText) holding spans (lib/docBlocks); the editor owns the block
   list, reads what the browser typed back out after every input, and
   does every structural edit (Enter, Backspace at a start, paste, marks,
   shortcuts) itself, then puts the caret back by plain-text offset
   (docDom). It keeps its own undo history (⌘Z / ⌘⇧Z). Esc selects the
   block you're in (arrows move, Shift extends, ⌫ deletes, ⌘C copies as
   Markdown, ⌘⇧↑/↓ moves, Enter edits). One tab stop: Tab indents a list
   item and otherwise leaves the editor; task chips are links in between.
   Data: lib/docs (saveProjectDoc via docSaver, subscribeProjectDocs).
   ============================================================ */
import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { DocBlock, DocBlockType, DocMark, DocSaveState, DocSpan, Member, ProjectDoc, Task } from "../../data/types";
import { Avatar, Button, EmojiPicker, Icon, IconButton, Kbd } from "../primitives";
import { Popover } from "../primitives/Popover";
import { getMember } from "../../data/data";
import {
  BLOCK_LABEL, blockPlainText, blockText, changeBlockType, cleanLinkInput, concatSpans, deleteRange, docKey, emptyBlock,
  ensureEditable, filterMembers, filterSlashCommands, hasMark, indentBlock, insertSpans, insertText, isBlockEmpty, isListType,
  linkAt, listNumber, markdownShortcut, mergeBlocks, newBlockId, setLink, sliceSpans, spansLength, spansText, splitBlock,
  toggleMark, withSpans, type SlashCommand,
} from "../../lib/docBlocks";
import { blocksToMarkdown, docErrorText, getProjectDoc, markdownToBlocks, saveProjectDoc, subscribeProjectDocs } from "../../lib/docs";
import { copyText } from "../rituals/shared";
import { caretOnEdgeLine, caretRect, getSelectionOffsets, readSpans, renderSpans, setSelectionOffsets } from "./docDom";
import { createDocSaver, type DocSaver } from "./docSaver";
import { DocBlocksView, TaskChip } from "./DocView";
import { VersionHistory } from "./VersionHistory";
import "./docs.css";

/** "Make task" on a line: the host creates the task in the doc's project; resolves to its id (null: not made). */
export type DocMakeTask = (input: { title: string; projectId: string; docId: string; blockId: string }) => Promise<string | null>;

export interface DocEditorProps {
  /** the doc as loaded (its updatedAt is the first save's base) */
  doc: ProjectDoc;
  /** the project's people (@mentions) */
  members: Member[];
  /** tasks in view (a Make-task line shows its task's live status) */
  tasks: Task[];
  currentUserId: string;
  /** guests, or you can't edit the project */
  readOnly: boolean;
  onSaved?: (doc: ProjectDoc) => void;
  onSaveState?: (state: DocSaveState) => void;
  onMakeTask: DocMakeTask;
  onOpenTask: (taskId: string) => void;
}

/** What a host (DocPage) can ask of the editor. */
export interface DocEditorHandle {
  /** save now if anything's unsaved */
  flush(): Promise<void>;
  openHistory(): void;
  /** the doc as it is now, as Markdown */
  markdown(): string;
  content(): { title: string; body: DocBlock[] };
  /** unsaved changes (or a save in flight) */
  readonly pending: boolean;
}

/* ------------------------------------------------------------ small helpers */

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const MOD = isMac ? "⌘" : "Ctrl";
const modKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey) || e.metaKey || e.ctrlKey;

type Caret = { id: string; start: number; end?: number };
type Snap = { title: string; blocks: DocBlock[]; caret: Caret | null };
type Menu = { kind: "slash" | "mention"; blockId: string; from: number; query: string; active: number };
type Bubble = { blockId: string; start: number; end: number; top: number; left: number; link: { start: number; end: number; href: string } | null };
type LinkEdit = { blockId: string; start: number; end: number; value: string; top: number; left: number; error: string | null; existing: boolean };

const PLACEHOLDER: Partial<Record<DocBlockType, string>> = {
  h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", bullet: "List", numbered: "List", todo: "To-do", quote: "Quote", callout: "Type something…",
};

/** The word around an offset (for ⌘B with nothing selected). */
function wordAt(text: string, at: number): [number, number] | null {
  const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_'’-]/u.test(c);
  let a = at, b = at;
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  return b > a ? [a, b] : null;
}

/** A block's row, for querySelector (ids come from stored docs: quote them safely). */
const rowSel = (id: string) => `[data-block="${id.replace(/["\\]/g, "\\$&")}"]`;

/** Show a link the way people say it: "acme.com/spec", "sana@acme.com". */
const linkLabel = (href: string) => href.replace(/^mailto:/i, "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");

/* ------------------------------------------------------------ one text block */

interface BlockTextProps {
  block: DocBlock;
  editable: boolean;
  label: string;
  placeholder: string;
  nameKey: string;
  nameOf: (id: string) => string | undefined;
  tabbable: boolean;
  register: (id: string, el: HTMLElement | null) => void;
  onInput: (id: string, spans: DocSpan[], e: InputEvent) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>, id: string) => void;
  onFocus: (id: string) => void;
  onPaste: (e: ReactClipboardEvent<HTMLDivElement>, id: string) => void;
  composing: { current: boolean };
}

const BlockText = memo(function BlockText({ block, editable, label, placeholder, nameKey, nameOf, tabbable, register, onInput, onKeyDown, onFocus, onPaste, composing }: BlockTextProps) {
  const ref = useRef<HTMLDivElement>(null);
  const painted = useRef<string | null>(null);
  const key = JSON.stringify(block.spans ?? []) + "|" + nameKey;
  // paint only when the spans differ from what's on screen (typing never repaints, so the caret stays put)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (painted.current !== key) { renderSpans(el, block.spans, nameOf); painted.current = key; }
    el.dataset.empty = String(!spansText(block.spans));
  });
  useLayoutEffect(() => {
    register(block.id, ref.current);
    return () => register(block.id, null);
  }, [block.id, register]);
  return (
    <div ref={ref} className="kdoc-text" contentEditable={editable} suppressContentEditableWarning
      role="textbox" aria-multiline="true" aria-label={label} aria-readonly={!editable || undefined}
      data-placeholder={placeholder} data-focus-ring="none" spellCheck tabIndex={tabbable ? 0 : -1}
      onInput={(e) => {
        const el = e.currentTarget;
        const spans = readSpans(el);
        painted.current = JSON.stringify(spans) + "|" + nameKey;
        el.dataset.empty = String(!spansText(spans));
        onInput(block.id, spans, e.nativeEvent as InputEvent);
      }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(e) => {
        composing.current = false;
        const el = e.currentTarget;
        const spans = readSpans(el);
        painted.current = JSON.stringify(spans) + "|" + nameKey;
        onInput(block.id, spans, new InputEvent("input", { data: e.data, inputType: "insertCompositionText" }));
      }}
      onKeyDown={(e) => onKeyDown(e, block.id)}
      onFocus={() => onFocus(block.id)}
      onPaste={(e) => onPaste(e, block.id)}
      onDrop={(e) => e.preventDefault()}
      onDragOver={(e) => e.preventDefault()} />
  );
});

/* ------------------------------------------------------------ the editor */

export const DocEditor = forwardRef<DocEditorHandle, DocEditorProps>(function DocEditor(
  { doc, members, tasks, currentUserId, readOnly, onSaved, onSaveState, onMakeTask, onOpenTask }, ref,
) {
  const editable = !readOnly && doc.canEdit;
  const [content, setContent] = useState<{ title: string; blocks: DocBlock[] }>(() => ({ title: doc.title, blocks: ensureEditable(doc.body) }));
  const contentRef = useRef(content);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const pendingCaret = useRef<Caret | null>(null);
  const lastCaret = useRef<Caret | null>(null);
  const composing = useRef(false);
  const history = useRef({ past: [] as Snap[], future: [] as Snap[], lastKind: "", lastBlock: "", lastAt: 0 });

  const [focusId, setFocusId] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef<Menu | null>(null);
  menuRef.current = menu;
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [linkEdit, setLinkEdit] = useState<LinkEdit | null>(null);
  const [blockMenu, setBlockMenu] = useState<{ id: string; page: "main" | "turn" } | null>(null);
  const blockMenuAnchor = useRef<HTMLElement | null>(null);
  const [calloutPick, setCalloutPick] = useState<string | null>(null);
  const calloutAnchor = useRef<HTMLElement | null>(null);
  const [selection, setSelection] = useState<{ anchor: string; focus: string } | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: number; top: number } | null>(null);
  const [making, setMaking] = useState<ReadonlySet<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saveState, setSaveState] = useState<DocSaveState>("idle");
  const [conflict, setConflict] = useState<ProjectDoc | null>(null);
  const [gone, setGone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  // (the same words twice still get read out: they differ by a trailing no-break space)
  const announce = useCallback((msg: string) => setNotice((prev) => (prev === msg ? msg + "\u00a0" : msg)), []);

  /* ---- people, names, tasks ---- */
  const nameOf = useCallback((id: string) => members.find((m) => m.id === id)?.name ?? getMember(id)?.name, [members]);
  const nameKey = useMemo(() => members.map((m) => m.id + ":" + m.name).join(","), [members]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const mentionable = useMemo(() => {
    const others = members.filter((m) => m.id !== currentUserId);
    const me = members.find((m) => m.id === currentUserId);
    return me ? [...others, me] : others;
  }, [members, currentUserId]);

  /* ---- autosave ---- */
  const cb = useRef({ onSaved, onSaveState });
  cb.current = { onSaved, onSaveState };
  const saverRef = useRef<DocSaver | null>(null);
  if (!saverRef.current) {
    saverRef.current = createDocSaver(doc.updatedAt, {
      docId: doc.id,
      projectId: doc.projectId,
      save: saveProjectDoc,
      draft: () => ({ title: contentRef.current.title, body: contentRef.current.blocks }),
      onState: (s) => { setSaveState(s); cb.current.onSaveState?.(s); if (s === "saved") setFailure(null); },
      onSaved: (d) => cb.current.onSaved?.(d),
      onConflict: (theirs) => setConflict(theirs),
      onGone: () => setGone(true),
      onError: (_why, e) => setFailure(docErrorText(e)),
    });
  }
  const saver = saverRef.current;
  // (StrictMode mounts twice: the second mount revives what the first unmount put away)
  useEffect(() => { saver.revive(); return () => { void saver.flush(); saver.dispose(); }; }, [saver]);
  // leaving the page with unsaved words: save what we can, and let the browser ask
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (!saver.dirty && !saver.saving) return;
      void saver.flush();
      e.preventDefault();
      e.returnValue = "";
    };
    const onHide = () => { if (document.visibilityState === "hidden") void saver.flush(); };
    window.addEventListener("beforeunload", onLeave);
    document.addEventListener("visibilitychange", onHide);
    return () => { window.removeEventListener("beforeunload", onLeave); document.removeEventListener("visibilitychange", onHide); };
  }, [saver]);

  /* ---- someone else's save (realtime ping) ---- */
  useEffect(() => {
    let live = true;
    const off = subscribeProjectDocs(doc.projectId, (c) => {
      if (!live || c.docId !== doc.id) return;
      if (c.type === "DELETE") { setGone(true); saver.hold(); return; }
      if (c.updatedBy === currentUserId || (c.updatedAt && new Date(c.updatedAt).getTime() === new Date(saver.base).getTime())) return;
      if (saver.saving) return; // its answer will say
      getProjectDoc(doc.id).then((theirs) => {
        if (!live || !theirs) return;
        if (new Date(theirs.updatedAt).getTime() === new Date(saver.base).getTime()) return;
        if (!saver.dirty) {
          // nothing unsaved here: take their copy quietly, keeping the caret where it was
          const caret = lastCaret.current;
          const next = { title: theirs.title, blocks: ensureEditable(theirs.body) };
          contentRef.current = next;
          setContent(next);
          saver.adopt(theirs.updatedAt);
          if (caret && next.blocks.some((b) => b.id === caret.id) && document.activeElement && rootRef.current?.contains(document.activeElement)) pendingCaret.current = caret;
          announce(`Updated with ${theirs.updatedByName ?? nameOf(theirs.updatedBy ?? "") ?? "someone"}'s changes.`);
        } else {
          saver.hold();
          setConflict(theirs);
        }
      }, () => { /* the next save will tell */ });
    });
    return () => { live = false; off(); };
  }, [doc.id, doc.projectId, currentUserId, saver, announce, nameOf]);

  /* ---- the caret ---- */
  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) els.current.set(id, el); else els.current.delete(id);
  }, []);
  const selIn = (id: string) => {
    const el = els.current.get(id);
    return el ? getSelectionOffsets(el) : null;
  };
  const currentCaret = (): Caret | null => {
    for (const [id, el] of els.current) {
      const s = getSelectionOffsets(el);
      if (s) return { id, start: s.start, end: s.end };
    }
    return lastCaret.current;
  };
  useLayoutEffect(() => {
    const c = pendingCaret.current;
    if (!c) return;
    pendingCaret.current = null;
    const el = els.current.get(c.id);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      const len = el.textContent?.length ?? 0;
      setSelectionOffsets(el, Math.min(c.start, len), Math.min(c.end ?? c.start, len));
    }
    lastCaret.current = c;
    el.scrollIntoView?.({ block: "nearest" }); // at once: typing never waits for a scroll to finish
  });

  /* ---- committing a change (undo history + autosave) ---- */
  const commit = useCallback((next: { title: string; blocks: DocBlock[] }, opts: { caret?: Caret | null; kind?: "type" | "title" | "edit"; blockId?: string } = {}) => {
    const prev = contentRef.current;
    if (prev === next) return;
    const h = history.current;
    const now = Date.now();
    const kind = opts.kind ?? "edit";
    const coalesce = (kind === "type" || kind === "title") && h.lastKind === kind && h.lastBlock === (opts.blockId ?? "") && now - h.lastAt < 1200;
    if (!coalesce) {
      h.past.push({ title: prev.title, blocks: prev.blocks, caret: lastCaret.current });
      if (h.past.length > 200) h.past.shift();
    }
    h.future = [];
    h.lastKind = kind; h.lastBlock = opts.blockId ?? ""; h.lastAt = now;
    contentRef.current = next;
    setContent(next);
    if (opts.caret) pendingCaret.current = opts.caret;
    saver.touch();
  }, [saver]);

  const setBlocks = useCallback((blocks: DocBlock[], opts: { caret?: Caret | null; kind?: "type" | "edit"; blockId?: string } = {}) => {
    commit({ title: contentRef.current.title, blocks: blocks.length ? blocks : [emptyBlock()] }, opts);
  }, [commit]);

  const undoRedo = useCallback((dir: "undo" | "redo") => {
    if (!editable) return;
    const h = history.current;
    const from = dir === "undo" ? h.past : h.future;
    const to = dir === "undo" ? h.future : h.past;
    const snap = from.pop();
    if (!snap) { announce(dir === "undo" ? "Nothing to undo." : "Nothing to redo."); return; }
    const cur = contentRef.current;
    to.push({ title: cur.title, blocks: cur.blocks, caret: currentCaret() });
    h.lastKind = "";
    contentRef.current = { title: snap.title, blocks: snap.blocks };
    setContent(contentRef.current);
    const caret = snap.caret && snap.blocks.some((b) => b.id === snap.caret!.id) ? snap.caret : { id: snap.blocks[0].id, start: 0 };
    pendingCaret.current = caret;
    saver.touch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, saver, announce]);

  /* ---- block helpers ---- */
  const blocks = content.blocks;
  const indexOf = (id: string) => contentRef.current.blocks.findIndex((b) => b.id === id);
  const replaceAt = (i: number, ...items: DocBlock[]) => {
    const list = contentRef.current.blocks;
    return [...list.slice(0, i), ...items, ...list.slice(i + 1)];
  };
  const focusBlock = (id: string, at: "start" | "end" | number = "end") => {
    const b = contentRef.current.blocks.find((x) => x.id === id);
    if (!b) return;
    const len = b.type === "divider" ? 0 : spansLength(b.spans);
    const start = at === "start" ? 0 : at === "end" ? len : Math.min(at, len);
    pendingCaret.current = { id, start };
    setContent((c) => ({ ...c })); // a render to place it
  };

  /* ---- menus (slash and @) ---- */
  const closeMenu = useCallback(() => { setMenu(null); setMenuPos(null); }, []);
  const slashItems = useMemo(() => (menu?.kind === "slash" ? filterSlashCommands(menu.query, { canMention: mentionable.length > 0 }) : []), [menu, mentionable.length]);
  const mentionItems = useMemo(() => (menu?.kind === "mention" ? filterMembers(mentionable, menu.query, 6) : []), [menu, mentionable]);
  const menuCount = menu?.kind === "slash" ? slashItems.length : mentionItems.length;

  const placeAt = (el: HTMLElement | null) => {
    const root = rootRef.current;
    if (!el || !root) return null;
    const rect = caretRect(el);
    const rr = root.getBoundingClientRect();
    if (!rect) return { top: 28, left: 0, up: false };
    const below = window.innerHeight - rect.bottom;
    const up = below < 300 && rect.top > below;
    return { top: (up ? rect.top - rr.top - 6 : rect.bottom - rr.top + 6), left: Math.max(0, Math.min(rect.left - rr.left, rr.width - 280)), up };
  };
  useLayoutEffect(() => {
    if (!menu) return;
    setMenuPos(placeAt(els.current.get(menu.blockId) ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu?.blockId, menu?.from, menu?.kind]);

  const updateMenus = (id: string, block: DocBlock, typed: string | null) => {
    const s = selIn(id);
    const m = menuRef.current;
    if (!s || s.start !== s.end) { if (m) closeMenu(); return; }
    const text = blockText(block);
    const caret = s.start;
    if (m && m.blockId === id) {
      const trig = m.kind === "slash" ? "/" : "@";
      if (caret <= m.from || text[m.from] !== trig) { closeMenu(); return; }
      const query = text.slice(m.from + 1, caret);
      const tooLong = query.length > 32 || /\n/.test(query) || (m.kind === "mention" ? query.split(" ").length > 3 : /\s\s/.test(query));
      const none = m.kind === "slash" ? !filterSlashCommands(query).length : !filterMembers(mentionable, query).length;
      if (tooLong || (none && /\s$/.test(query))) { closeMenu(); return; }
      setMenu({ ...m, query, active: query === m.query ? m.active : 0 });
      return;
    }
    if (m) closeMenu();
    if ((typed === "/" || typed === "@") && text[caret - 1] === typed && (caret === 1 || /\s/.test(text[caret - 2]))) {
      if (typed === "@" && !mentionable.length) return;
      setMenu({ kind: typed === "/" ? "slash" : "mention", blockId: id, from: caret - 1, query: "", active: 0 });
    }
  };

  /* ---- typing ---- */
  const onInput = (id: string, spans: DocSpan[], ev: InputEvent) => {
    if (!editable) return;
    const i = indexOf(id);
    if (i < 0) return;
    const b = contentRef.current.blocks[i];
    const nb = withSpans(b, spans);
    const s = selIn(id);
    if (s) lastCaret.current = { id, start: s.start, end: s.end };
    commit({ title: contentRef.current.title, blocks: replaceAt(i, nb) }, { kind: "type", blockId: id });
    if (composing.current) return;
    // Markdown shortcuts: right after the space that completes one (or the third dash of ---)
    const typed = ev?.data ?? null;
    if (ev?.inputType === "insertText" && s && s.start === s.end && (typed === " " || (typed === "-" && blockText(nb) === "---"))) {
      const sc = markdownShortcut(nb);
      if (sc && (sc.block.type === "divider" || s.start === sc.removed)) {
        closeMenu();
        if (sc.block.type === "divider") {
          const after = emptyBlock("p");
          setBlocks(replaceAt(i, sc.block, after), { caret: { id: after.id, start: 0 } });
        } else {
          setBlocks(replaceAt(i, sc.block), { caret: { id, start: Math.max(0, s.start - sc.removed) } });
        }
        return;
      }
    }
    updateMenus(id, nb, typed);
  };

  /* ---- structural edits ---- */
  const enter = (id: string) => {
    const i = indexOf(id);
    const b = contentRef.current.blocks[i];
    const s = selIn(id) ?? { start: spansLength(b.spans), end: spansLength(b.spans) };
    const spans = s.end > s.start ? deleteRange(b.spans, s.start, s.end) : b.spans ?? [];
    const block = withSpans(b, spans);
    if (!spansText(spans) && (isListType(b.type) || b.type === "quote" || b.type === "callout")) {
      // an empty list item: Enter steps out (one level at a time)
      const out = isListType(b.type) && (b.indent ?? 0) > 0 ? indentBlock(block, -1) : changeBlockType(block, "p");
      setBlocks(replaceAt(i, out), { caret: { id, start: 0 } });
      return;
    }
    const [left, right] = splitBlock(block, s.start);
    setBlocks(replaceAt(i, left, right), { caret: left.id === b.id ? { id: right.id, start: 0 } : { id: b.id, start: 0 } });
  };

  const insertAtCaret = (id: string, ins: DocSpan[]) => {
    const i = indexOf(id);
    const b = contentRef.current.blocks[i];
    const s = selIn(id) ?? { start: spansLength(b.spans), end: spansLength(b.spans) };
    const base = deleteRange(b.spans, s.start, s.end);
    const len = spansLength(ins);
    setBlocks(replaceAt(i, withSpans(b, insertSpans(base, s.start, ins))), { caret: { id, start: s.start + len } });
  };

  const backspaceAtStart = (id: string): boolean => {
    const list = contentRef.current.blocks;
    const i = indexOf(id);
    const b = list[i];
    if (b.type !== "p") {
      const out = isListType(b.type) && (b.indent ?? 0) > 0 ? indentBlock(b, -1) : changeBlockType(b, "p");
      setBlocks(replaceAt(i, out), { caret: { id, start: 0 } });
      return true;
    }
    if (i === 0) {
      if (isBlockEmpty(b) && list.length > 1) {
        const next = list[1];
        setBlocks(list.slice(1), { caret: { id: next.id, start: 0 } });
        return true;
      }
      return false;
    }
    const prev = list[i - 1];
    if (prev.type === "divider") {
      setBlocks([...list.slice(0, i - 1), ...list.slice(i)], { caret: { id, start: 0 } });
      return true;
    }
    const at = spansLength(prev.spans);
    setBlocks([...list.slice(0, i - 1), mergeBlocks(prev, b), ...list.slice(i + 1)], { caret: { id: prev.id, start: at } });
    return true;
  };

  const deleteAtEnd = (id: string): boolean => {
    const list = contentRef.current.blocks;
    const i = indexOf(id);
    const b = list[i];
    const next = list[i + 1];
    if (!next) return false;
    const at = spansLength(b.spans);
    if (next.type === "divider") { setBlocks([...list.slice(0, i + 1), ...list.slice(i + 2)], { caret: { id, start: at } }); return true; }
    setBlocks([...list.slice(0, i), mergeBlocks(b, next), ...list.slice(i + 2)], { caret: { id, start: at } });
    return true;
  };

  const moveBlocks = (ids: string[], dir: -1 | 1) => {
    const list = contentRef.current.blocks;
    const idx = ids.map((id) => list.findIndex((b) => b.id === id)).filter((i) => i >= 0).sort((a, b) => a - b);
    if (!idx.length) return;
    const lo = idx[0], hi = idx[idx.length - 1];
    if ((dir < 0 && lo === 0) || (dir > 0 && hi === list.length - 1)) return;
    const chunk = list.slice(lo, hi + 1);
    const rest = [...list.slice(0, lo), ...list.slice(hi + 1)];
    const at = dir < 0 ? lo - 1 : lo + 1;
    const next = [...rest.slice(0, at), ...chunk, ...rest.slice(at)];
    const caret = selection ? null : currentCaret();
    setBlocks(next, { caret });
    announce(dir < 0 ? "Moved up." : "Moved down.");
  };

  const moveBlockTo = (id: string, to: number) => {
    const list = contentRef.current.blocks;
    const from = list.findIndex((b) => b.id === id);
    if (from < 0) return;
    let target = to > from ? to - 1 : to;
    target = Math.max(0, Math.min(list.length - 1, target));
    if (target === from) return;
    const rest = list.filter((b) => b.id !== id);
    setBlocks([...rest.slice(0, target), list[from], ...rest.slice(target)]);
    announce(`Moved to line ${target + 1} of ${list.length}.`);
  };

  const duplicate = (ids: string[]) => {
    const list = contentRef.current.blocks;
    const set = new Set(ids);
    const last = Math.max(...ids.map((id) => list.findIndex((b) => b.id === id)));
    const copies = list.filter((b) => set.has(b.id)).map((b) => { const c = { ...b, id: newBlockId() }; delete c.taskId; return c; });
    setBlocks([...list.slice(0, last + 1), ...copies, ...list.slice(last + 1)], { caret: copies[0]?.type === "divider" ? null : { id: copies[copies.length - 1].id, start: spansLength(copies[copies.length - 1].spans) } });
  };

  const removeBlocks = (ids: string[]) => {
    const list = contentRef.current.blocks;
    const set = new Set(ids);
    const first = list.findIndex((b) => set.has(b.id));
    const rest = list.filter((b) => !set.has(b.id));
    if (!rest.length) {
      const fresh = emptyBlock();
      setBlocks([fresh], { caret: { id: fresh.id, start: 0 } });
      return;
    }
    const near = rest[Math.max(0, first - 1)];
    setBlocks(rest, { caret: { id: near.id, start: near.type === "divider" ? 0 : spansLength(near.spans) } });
    announce(ids.length === 1 ? "Deleted the block." : `Deleted ${ids.length} blocks.`);
  };

  const turnInto = (id: string, type: DocBlockType) => {
    const list = contentRef.current.blocks;
    const i = indexOf(id);
    if (i < 0) return;
    const b = list[i];
    if (type === "divider") {
      const div: DocBlock = { id: newBlockId(), type: "divider" };
      if (isBlockEmpty(b)) {
        const after = list[i + 1];
        if (after && after.type !== "divider") setBlocks(replaceAt(i, div), { caret: { id: after.id, start: 0 } });
        else { const p = emptyBlock(); setBlocks(replaceAt(i, div, p), { caret: { id: p.id, start: 0 } }); }
      } else {
        const p = emptyBlock();
        setBlocks(replaceAt(i, b, div, p), { caret: { id: p.id, start: 0 } });
      }
      return;
    }
    const s = selIn(id);
    setBlocks(replaceAt(i, changeBlockType(b, type)), { caret: { id, start: s?.start ?? spansLength(b.spans) } });
  };

  const toggleChecked = (id: string) => {
    const i = indexOf(id);
    const b = contentRef.current.blocks[i];
    if (!b || b.type !== "todo" || !editable) return;
    setBlocks(replaceAt(i, { ...b, checked: !b.checked }));
    announce(!b.checked ? `Ticked: ${blockPlainText(b, nameOf) || "item"}.` : `Unticked: ${blockPlainText(b, nameOf) || "item"}.`);
  };

  const makeTask = async (id: string) => {
    const b = contentRef.current.blocks.find((x) => x.id === id);
    if (!b || b.type === "divider") return;
    if (b.taskId) { onOpenTask(b.taskId); return; }
    const title = blockPlainText(b, nameOf).slice(0, 200);
    if (!title) { announce("Write something on the line first, then make it a task."); return; }
    if (making.has(id)) return;
    setMaking((s) => new Set(s).add(id));
    try {
      const taskId = await onMakeTask({ title, projectId: doc.projectId, docId: doc.id, blockId: id });
      if (!taskId) return;
      const i = indexOf(id);
      if (i < 0) { announce(`Made the task “${title}”.`); return; }
      setBlocks(replaceAt(i, { ...contentRef.current.blocks[i], taskId }), { caret: null });
      announce(`Made the task “${title}”. It's linked from this line.`);
    } catch {
      announce("Couldn't make the task. Try again.");
    } finally {
      setMaking((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const unlinkTask = (id: string) => {
    const i = indexOf(id);
    const b = contentRef.current.blocks[i];
    if (!b?.taskId) return;
    const out = { ...b };
    delete out.taskId;
    setBlocks(replaceAt(i, out));
    announce("Unlinked the task. The task itself is still there.");
  };

  /* ---- marks and links ---- */
  const applyMark = (id: string, mark: DocMark, range?: { start: number; end: number }) => {
    const i = indexOf(id);
    const b = contentRef.current.blocks[i];
    if (!b || b.type === "divider") return;
    const s = range ?? selIn(id);
    if (!s) return;
    let { start, end } = s;
    if (start === end) {
      const w = wordAt(blockText(b), start);
      if (!w) return;
      [start, end] = w;
    }
    const on = !hasMark(b.spans, start, end, mark);
    setBlocks(replaceAt(i, withSpans(b, toggleMark(b.spans, start, end, mark))), { caret: { id, start: s.start, end: s.end } });
    announce(`${mark === "b" ? "Bold" : mark === "i" ? "Italic" : "Code"} ${on ? "on" : "off"}.`);
  };

  const placeAbove = (id: string) => {
    const root = rootRef.current, el = els.current.get(id);
    const sel = document.getSelection();
    if (!root || !el || !sel || !sel.rangeCount) return { top: 0, left: 0 };
    const r = sel.getRangeAt(0).getBoundingClientRect?.();
    const rr = root.getBoundingClientRect();
    const box = r && (r.width || r.height) ? r : el.getBoundingClientRect();
    return { top: box.top - rr.top, left: Math.max(8, Math.min(box.left - rr.left + box.width / 2, rr.width - 8)) };
  };

  const openLink = (id: string, range?: { start: number; end: number }) => {
    const b = contentRef.current.blocks.find((x) => x.id === id);
    if (!b || b.type === "divider") return;
    const s = range ?? selIn(id) ?? { start: spansLength(b.spans), end: spansLength(b.spans) };
    const existing = linkAt(b.spans, s.start === s.end ? s.start : s.start + 1);
    const r = s.start === s.end && existing ? existing : { start: s.start, end: s.end };
    const pos = placeAbove(id);
    setBubble(null);
    setLinkEdit({ blockId: id, start: r.start, end: r.end, value: existing?.href ?? "", top: pos.top, left: pos.left, error: null, existing: !!existing });
  };

  const applyLink = (le: LinkEdit, remove = false) => {
    const i = indexOf(le.blockId);
    const b = contentRef.current.blocks[i];
    if (!b) { setLinkEdit(null); return; }
    if (remove) {
      setBlocks(replaceAt(i, withSpans(b, setLink(b.spans, le.start, le.end, null))), { caret: { id: b.id, start: le.end } });
      setLinkEdit(null);
      announce("Link removed.");
      return;
    }
    const href = cleanLinkInput(le.value);
    if (!href) { setLinkEdit({ ...le, error: "Use a web address (https://…) or an email address." }); return; }
    if (le.start === le.end) {
      const text = linkLabel(href);
      setBlocks(replaceAt(i, withSpans(b, insertSpans(b.spans, le.start, [{ text, href }]))), { caret: { id: b.id, start: le.start + text.length } });
    } else {
      setBlocks(replaceAt(i, withSpans(b, setLink(b.spans, le.start, le.end, href))), { caret: { id: b.id, start: le.end } });
    }
    setLinkEdit(null);
    announce("Link added.");
  };

  /* ---- paste ---- */
  const onPaste = (e: ReactClipboardEvent<HTMLDivElement>, id: string) => {
    if (!editable) return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    closeMenu();
    const list = contentRef.current.blocks;
    const i = indexOf(id);
    const b = list[i];
    const s = selIn(id) ?? { start: spansLength(b.spans), end: spansLength(b.spans) };
    const base = deleteRange(b.spans, s.start, s.end);
    const parsed = markdownToBlocks(text);
    if (!parsed.length) { insertAtCaret(id, [{ text: text.replace(/\n+/g, " ") }]); return; }
    const before = sliceSpans(base, 0, s.start);
    const after = sliceSpans(base, s.start);
    const currentEmpty = !spansText(base);
    if (parsed.length === 1 && (parsed[0].type === "p" || !currentEmpty) && parsed[0].type !== "divider") {
      const ins = parsed[0].spans ?? [];
      setBlocks(replaceAt(i, withSpans(b, concatSpans(before, ins, after))), { caret: { id, start: s.start + spansLength(ins) }, kind: "edit" });
      return;
    }
    const first = parsed[0];
    const out: DocBlock[] = [];
    if (currentEmpty) out.push(first.type === "divider" ? first : { ...first, id: b.id });
    else out.push(withSpans(b, concatSpans(before, first.type === "divider" ? [] : first.spans)));
    if (!currentEmpty && first.type === "divider") out.push(first);
    out.push(...parsed.slice(1));
    let last = out[out.length - 1];
    let caretAt = last.type === "divider" ? 0 : spansLength(last.spans);
    if (spansText(after)) {
      if (last.type === "divider") { last = emptyBlock(); out.push(last); caretAt = 0; }
      out[out.length - 1] = withSpans(last, concatSpans(last.spans, after));
    } else if (last.type === "divider") {
      last = emptyBlock(); out.push(last); caretAt = 0;
    }
    setBlocks(replaceAt(i, ...out), { caret: { id: out[out.length - 1].id, start: caretAt } });
    announce(`Pasted ${parsed.length} blocks.`);
  };

  /* ---- keys in a text block ---- */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, id: string) => {
    if (!editable) return;
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    const m = menuRef.current;
    if (m && m.blockId === id && menuCount > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setMenu({ ...m, active: (m.active + d + menuCount) % menuCount });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (m.kind === "slash") pickSlash(slashItems[Math.min(m.active, slashItems.length - 1)]);
        else pickMention(mentionItems[Math.min(m.active, mentionItems.length - 1)]);
        return;
      }
    }
    if (m && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
    const i = indexOf(id);
    const b = contentRef.current.blocks[i];
    if (!b) return;
    const el = els.current.get(id)!;
    const len = spansLength(b.spans);
    const s = selIn(id);
    if (s) lastCaret.current = { id, start: s.start, end: s.end };
    const mod = modKey(e);

    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "b" || k === "i" || k === "e") { e.preventDefault(); applyMark(id, k === "b" ? "b" : k === "i" ? "i" : "code"); return; }
      if (k === "k") { e.preventDefault(); openLink(id); return; }
      if (k === "z") { e.preventDefault(); undoRedo(e.shiftKey ? "redo" : "undo"); return; }
      if (k === "y" && !isMac) { e.preventDefault(); undoRedo("redo"); return; }
      if (k === "d") { e.preventDefault(); duplicate([id]); return; }
      if (k === "/") { e.preventDefault(); openBlockMenu(id); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        if (b.type === "todo") toggleChecked(id);
        else if (b.taskId) onOpenTask(b.taskId);
        return;
      }
      if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); moveBlocks([id], e.key === "ArrowUp" ? -1 : 1); return; }
      if (k === "a" && s && ((s.start === 0 && s.end === len) || len === 0)) {
        e.preventDefault();
        const list = contentRef.current.blocks;
        selectBlocks(list[0].id, list[list.length - 1].id);
        return;
      }
      return;
    }
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        if (e.shiftKey) insertAtCaret(id, [{ text: "\n" }]);
        else enter(id);
        return;
      case "Backspace":
        if (s && s.start === 0 && s.end === 0 && backspaceAtStart(id)) e.preventDefault();
        return;
      case "Delete":
        if (s && s.start === len && s.end === len && deleteAtEnd(id)) e.preventDefault();
        return;
      case "Tab":
        if (isListType(b.type)) { e.preventDefault(); setBlocks(replaceAt(i, indentBlock(b, e.shiftKey ? -1 : 1)), { caret: s ? { id, start: s.start, end: s.end } : null }); }
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (linkEdit) { setLinkEdit(null); return; }
        selectBlocks(id, id);
        return;
      case "ArrowUp":
      case "ArrowLeft": {
        if (e.shiftKey || e.altKey || !s || s.start !== s.end) return;
        const atEdge = e.key === "ArrowLeft" ? s.start === 0 : caretOnEdgeLine(el, "first", s.start, len);
        if (!atEdge) return;
        e.preventDefault();
        if (i === 0) { titleRef.current?.focus(); const t = titleRef.current; if (t) t.setSelectionRange(t.value.length, t.value.length); return; }
        focusBlock(contentRef.current.blocks[i - 1].id, "end");
        return;
      }
      case "ArrowDown":
      case "ArrowRight": {
        if (e.shiftKey || e.altKey || !s || s.start !== s.end) return;
        const atEdge = e.key === "ArrowRight" ? s.start >= len : caretOnEdgeLine(el, "last", s.start, len);
        if (!atEdge) return;
        const next = contentRef.current.blocks[i + 1];
        if (!next) return;
        e.preventDefault();
        focusBlock(next.id, "start");
        return;
      }
    }
  };

  /* ---- picking from the menus ---- */
  const pickSlash = (cmd: SlashCommand | undefined) => {
    const m = menuRef.current;
    if (!m || !cmd) return;
    const i = indexOf(m.blockId);
    const b = contentRef.current.blocks[i];
    const s = selIn(m.blockId);
    const end = s ? Math.max(s.start, m.from + 1) : m.from + 1 + m.query.length;
    const spans = deleteRange(b.spans, m.from, end);
    const cleaned = withSpans(b, spans);
    closeMenu();
    // the typed "/query" goes, as one undo step with what follows
    contentRef.current = { ...contentRef.current, blocks: replaceAt(i, cleaned) };
    if (cmd.type) { turnInto(b.id, cmd.type); if (cmd.type !== "divider") pendingCaret.current = { id: b.id, start: m.from }; return; }
    if (cmd.action === "mention") {
      setBlocks(replaceAt(i, withSpans(cleaned, insertSpans(spans, m.from, [{ text: "@" }]))), { caret: { id: b.id, start: m.from + 1 } });
      window.setTimeout(() => setMenu({ kind: "mention", blockId: b.id, from: m.from, query: "", active: 0 }), 0);
      return;
    }
    if (cmd.action === "task") {
      setBlocks(replaceAt(i, cleaned), { caret: { id: b.id, start: m.from } });
      void makeTask(b.id);
    }
  };

  const pickMention = (person: Member | undefined) => {
    const m = menuRef.current;
    if (!m || !person) return;
    const i = indexOf(m.blockId);
    const b = contentRef.current.blocks[i];
    const s = selIn(m.blockId);
    const end = s ? Math.max(s.start, m.from + 1) : m.from + 1 + m.query.length;
    const base = deleteRange(b.spans, m.from, end);
    const text = `@${person.name}`;
    const nextChar = spansText(base)[m.from];
    const ins: DocSpan[] = [{ text, mention: person.id }, ...(nextChar === " " ? [] : [{ text: " " }])];
    closeMenu();
    setBlocks(replaceAt(i, withSpans(b, insertSpans(base, m.from, ins))), { caret: { id: b.id, start: m.from + text.length + 1 } });
    if (person.id !== currentUserId) announce(`${person.name} will get a notice in their Inbox when this saves.`);
  };

  /* ---- block selection (Esc) ---- */
  const selectBlocks = (anchor: string, focus: string) => {
    closeMenu();
    setBubble(null);
    setSelection({ anchor, focus });
    const sel = document.getSelection();
    sel?.removeAllRanges();
    rootRef.current?.focus({ preventScroll: true });
    const list = contentRef.current.blocks;
    const a = list.findIndex((b) => b.id === anchor), f = list.findIndex((b) => b.id === focus);
    const n = Math.abs(a - f) + 1;
    announce(n === 1 ? `${BLOCK_LABEL[list[f]?.type ?? "p"]} selected. Arrows move, Enter edits, Delete removes.` : `${n} blocks selected.`);
  };
  const selectedIds = (): string[] => {
    if (!selection) return [];
    const list = contentRef.current.blocks;
    const a = list.findIndex((b) => b.id === selection.anchor), f = list.findIndex((b) => b.id === selection.focus);
    if (a < 0 || f < 0) return [];
    const [lo, hi] = a <= f ? [a, f] : [f, a];
    return list.slice(lo, hi + 1).map((b) => b.id);
  };
  const selectedSet = useMemo(() => new Set(selectedIds()), [selection, blocks]); // eslint-disable-line react-hooks/exhaustive-deps

  const onRootKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== rootRef.current || !selection) return;
    const list = contentRef.current.blocks;
    const f = list.findIndex((b) => b.id === selection.focus);
    const ids = selectedIds();
    const mod = modKey(e);
    if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); setSelection({ anchor: list[0].id, focus: list[list.length - 1].id }); return; }
    if (mod && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
      e.preventDefault();
      const md = blocksToMarkdown("", list.filter((b) => ids.includes(b.id)), { memberName: nameOf, taskDone: (t) => taskById.get(t)?.status === "done" });
      void copyText(md).then((ok) => announce(ok ? `Copied ${ids.length === 1 ? "the block" : `${ids.length} blocks`} as Markdown.` : "Couldn't copy."));
      if (e.key.toLowerCase() === "x" && editable) { removeBlocks(ids); setSelection(null); }
      return;
    }
    if (mod && e.key.toLowerCase() === "z" && editable) { e.preventDefault(); setSelection(null); undoRedo(e.shiftKey ? "redo" : "undo"); return; }
    if (mod && e.key.toLowerCase() === "d" && editable) { e.preventDefault(); duplicate(ids); setSelection(null); return; }
    if (mod && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && editable) {
      e.preventDefault();
      moveBlocks(ids, e.key === "ArrowUp" ? -1 : 1);
      window.setTimeout(() => rootRef.current?.focus({ preventScroll: true }), 0);
      return;
    }
    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault();
        const g = Math.max(0, Math.min(list.length - 1, f + (e.key === "ArrowUp" ? -1 : 1)));
        setSelection(e.shiftKey ? { anchor: selection.anchor, focus: list[g].id } : { anchor: list[g].id, focus: list[g].id });
        rootRef.current?.querySelector(rowSel(list[g].id))?.scrollIntoView?.({ block: "nearest" });
        return;
      }
      case "Enter": {
        e.preventDefault();
        const b = list[f];
        setSelection(null);
        if (b.type === "divider" && editable) {
          const p = emptyBlock();
          setBlocks([...list.slice(0, f + 1), p, ...list.slice(f + 1)], { caret: { id: p.id, start: 0 } });
        } else if (b.type !== "divider") focusBlock(b.id, "end");
        return;
      }
      case "Backspace":
      case "Delete":
        if (!editable) return;
        e.preventDefault();
        setSelection(null);
        removeBlocks(ids);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        setSelection(null);
        announce("Selection cleared.");
        return;
    }
  };

  /* ---- the block menu (handle / ⌘/) ---- */
  const openBlockMenu = (id: string) => {
    blockMenuAnchor.current = handles.current.get(id) ?? els.current.get(id) ?? null;
    closeMenu();
    setBlockMenu({ id, page: "main" });
  };

  /* ---- the + button: a new line with the slash menu open ---- */
  const addBelow = (id: string) => {
    const list = contentRef.current.blocks;
    const i = list.findIndex((b) => b.id === id);
    const b = list[i];
    if (b && b.type === "p" && isBlockEmpty(b)) {
      setBlocks(replaceAt(i, withSpans(b, [{ text: "/" }])), { caret: { id: b.id, start: 1 } });
      setMenu({ kind: "slash", blockId: b.id, from: 0, query: "", active: 0 });
      return;
    }
    const nb = withSpans(emptyBlock(), [{ text: "/" }]);
    setBlocks([...list.slice(0, i + 1), nb, ...list.slice(i + 1)], { caret: { id: nb.id, start: 1 } });
    setMenu({ kind: "slash", blockId: nb.id, from: 0, query: "", active: 0 });
  };

  /* ---- dragging a block by its handle ---- */
  const dragRef = useRef<{ id: string; y: number; moved: boolean; pointer: number } | null>(null);
  const onHandleDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0 || !editable) return;
    dragRef.current = { id, y: e.clientY, moved: false, pointer: e.pointerId };
    // follow the pointer even when it leaves the little handle
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const dropIndexAt = (y: number): { over: number; top: number } => {
    const root = rootRef.current!;
    const rr = root.getBoundingClientRect();
    const list = contentRef.current.blocks;
    for (let i = 0; i < list.length; i++) {
      const row = root.querySelector<HTMLElement>(rowSel(list[i].id));
      if (!row) continue;
      const r = row.getBoundingClientRect();
      if (y < r.top + r.height / 2) return { over: i, top: r.top - rr.top };
    }
    const lastRow = root.querySelector<HTMLElement>(rowSel(list[list.length - 1].id));
    return { over: list.length, top: lastRow ? lastRow.getBoundingClientRect().bottom - rr.top : 0 };
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientY - d.y) < 4) return;
    d.moved = true;
    const at = dropIndexAt(e.clientY);
    setDrag({ id: d.id, ...at });
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.moved) { openBlockMenu(id); return; }
    e.currentTarget.releasePointerCapture?.(d.pointer);
    const at = dropIndexAt(e.clientY);
    setDrag(null);
    moveBlockTo(d.id, at.over);
  };

  /* ---- the selection bubble (format / link) ---- */
  useEffect(() => {
    if (!editable) return;
    let raf = 0;
    // (a short timer, not a frame: selectionchange fires in bursts while dragging, and frames pause in background tabs)
    const later = (fn: () => void) => window.setTimeout(fn, 16);
    const cancel = (id: number) => window.clearTimeout(id);
    const onSel = () => {
      cancel(raf);
      raf = later(() => {
        const sel = document.getSelection();
        if (!sel || !sel.rangeCount) { setBubble(null); return; }
        const r = sel.getRangeAt(0);
        let host: [string, HTMLElement] | null = null;
        for (const [id, el] of els.current) if (el.contains(r.startContainer) && el.contains(r.endContainer)) { host = [id, el]; break; }
        if (!host) { setBubble(null); return; }
        const [id, el] = host;
        const s = getSelectionOffsets(el);
        if (!s) { setBubble(null); return; }
        lastCaret.current = { id, start: s.start, end: s.end };
        const b = contentRef.current.blocks.find((x) => x.id === id);
        const link = b && s.start === s.end ? linkAt(b.spans, s.start) : null;
        if (s.start === s.end && !(link && s.start > link.start && s.start < link.end)) { setBubble(null); return; }
        if (menuRef.current) { setBubble(null); return; }
        const pos = placeAbove(id);
        setBubble({ blockId: id, start: s.start, end: s.end, top: pos.top, left: pos.left, link: s.start === s.end ? link : null });
      });
    };
    document.addEventListener("selectionchange", onSel);
    return () => { cancel(raf); document.removeEventListener("selectionchange", onSel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable]);

  /* ---- leaving the editor: save now ---- */
  const onBlurCapture = (e: React.FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && rootRef.current?.contains(next)) return;
    if (next && (next as HTMLElement).closest?.("[data-kpop], .ksheet-layer")) return; // our own menus
    closeMenu();
    void saver.flush();
  };

  /* ---- the title ---- */
  useLayoutEffect(() => {
    const t = titleRef.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  }, [content.title]);

  /* ---- conflict / gone ---- */
  const reloadTheirs = () => {
    if (!conflict) return;
    const next = { title: conflict.title, blocks: ensureEditable(conflict.body) };
    contentRef.current = next;
    setContent(next);
    history.current = { past: [], future: [], lastKind: "", lastBlock: "", lastAt: 0 };
    saver.adopt(conflict.updatedAt);
    setConflict(null);
    announce("Showing their version.");
  };
  const keepMine = () => {
    if (!conflict) return;
    const at = conflict.updatedAt;
    setConflict(null);
    void saver.keepMine(at).then(() => announce("Saved your version. Theirs is in Version history."));
  };

  /* ---- what the host can ask ---- */
  const markdownNow = () => blocksToMarkdown(contentRef.current.title, contentRef.current.blocks, { memberName: nameOf, taskDone: (t) => (taskById.has(t) ? taskById.get(t)!.status === "done" : undefined) });
  useImperativeHandle(ref, () => ({
    flush: () => saver.flush(),
    openHistory: () => setHistoryOpen(true),
    markdown: markdownNow,
    content: () => ({ title: contentRef.current.title, body: contentRef.current.blocks }),
    get pending() { return saver.dirty || saver.saving; },
  }));

  const restoreVersion = (v: { title: string; body: DocBlock[]; savedAt: string }) => {
    const next = { title: v.title, blocks: ensureEditable(v.body) };
    commit(next, { kind: "edit", caret: null });
    void saver.flush();
    const when = new Date(v.savedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    announce(`Restored the version from ${when}.`);
  };

  /* stable wrappers, so BlockText (memo) doesn't re-render on every keystroke */
  const onFocusBlock = (id: string) => { setFocusId(id); if (selection) setSelection(null); };
  const handlersRef = useRef({ onInput, onKeyDown, onFocus: onFocusBlock, onPaste });
  handlersRef.current = { onInput, onKeyDown, onFocus: onFocusBlock, onPaste };
  const onInputStable = useCallback((id: string, spans: DocSpan[], e: InputEvent) => handlersRef.current.onInput(id, spans, e), []);
  const onKeyDownStable = useCallback((e: ReactKeyboardEvent<HTMLDivElement>, id: string) => handlersRef.current.onKeyDown(e, id), []);
  const onFocusStable = useCallback((id: string) => handlersRef.current.onFocus(id), []);
  const onPasteStable = useCallback((e: ReactClipboardEvent<HTMLDivElement>, id: string) => handlersRef.current.onPaste(e, id), []);

  /* ================================ render ================================ */

  const conflictName = conflict ? (conflict.updatedBy === currentUserId ? "You" : conflict.updatedByName ?? nameOf(conflict.updatedBy ?? "") ?? "Someone") : "";
  const showOwnIndicator = !onSaveState;
  const firstEmpty = blocks.length === 1 && isBlockEmpty(blocks[0]) && blocks[0].type === "p";

  if (!editable) {
    return (
      <div className="kdoc-editor" data-readonly="true" ref={rootRef}>
        <h2 className="kdoc-title" data-readonly="true">{content.title || "Untitled"}</h2>
        <DocBlocksView blocks={blocks} nameOf={nameOf} tasks={taskById} onOpenTask={onOpenTask}
          emptyText={readOnly ? "Nothing written here yet." : "Nothing written yet."} />
        <VersionHistory open={historyOpen} onClose={() => setHistoryOpen(false)} docId={doc.id} members={members} nameOf={nameOf}
          tasks={taskById} canRestore={false} onRestore={() => {}} />
      </div>
    );
  }

  const menuItemsId = `kdoc-menu-${doc.id}`;
  const activeId = menu && menuCount ? `${menuItemsId}-${Math.min(menu.active, menuCount - 1)}` : undefined;
  const tabStop = focusId && blocks.some((b) => b.id === focusId) ? focusId : blocks[0]?.id;

  return (
    <div ref={rootRef} className="kdoc-editor" tabIndex={-1} data-focus-ring="none" data-selecting={selection ? "true" : undefined}
      aria-label={selection ? "Doc blocks" : undefined} onKeyDown={onRootKeyDown} onBlurCapture={onBlurCapture}
      onMouseDown={(e) => { if (selection && e.target === rootRef.current) setSelection(null); }}>
      {conflict && (
        <div className="kdoc-banner" data-tone="warn" role="alert">
          <Icon name="alert" size={16} sw={1.9} />
          <p>{conflict.updatedBy === currentUserId
            ? <><b>You saved this somewhere else</b> (another tab or device) while you were writing here. Reload to see that version, or keep this one (the other stays in Version history).</>
            : <><b>{conflictName} edited this</b> while you were writing. Reload to see their version, or keep yours (theirs stays in Version history).</>}</p>
          <span className="kdoc-banner-acts">
            <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>See theirs</Button>
            <Button size="sm" onClick={reloadTheirs}>Reload</Button>
            <Button size="sm" variant="primary" onClick={keepMine}>Keep mine</Button>
          </span>
        </div>
      )}
      {gone && (
        <div className="kdoc-banner" data-tone="signal" role="alert">
          <Icon name="alert" size={16} sw={1.9} />
          <p><b>This doc was deleted</b>, or its project went to the recycle bin. Your changes can't be saved here; copy anything you need.</p>
          <span className="kdoc-banner-acts">
            <Button size="sm" icon="copy" onClick={() => void copyText(markdownNow()).then((ok) => announce(ok ? "Copied the doc as Markdown." : "Couldn't copy."))}>Copy as Markdown</Button>
          </span>
        </div>
      )}
      {failure && !gone && !conflict && (
        <div className="kdoc-banner" data-tone="signal" role="alert">
          <Icon name="alert" size={16} sw={1.9} />
          <p><b>Not saved.</b> {failure}</p>
          <span className="kdoc-banner-acts"><Button size="sm" onClick={() => { setFailure(null); saver.touch(); void saver.flush(); }}>Try again</Button></span>
        </div>
      )}

      <div className="kdoc-title-row">
        <textarea ref={titleRef} className="kdoc-title" rows={1} value={content.title} placeholder="Untitled" aria-label="Title" maxLength={200}
          data-focus-ring="none" spellCheck
          onChange={(e) => commit({ title: e.target.value.replace(/\n/g, " "), blocks: contentRef.current.blocks }, { kind: "title" })}
          onKeyDown={(e) => {
            const t = e.currentTarget;
            if (modKey(e) && e.key.toLowerCase() === "z") { e.preventDefault(); undoRedo(e.shiftKey ? "redo" : "undo"); return; }
            if (e.key === "Enter") { e.preventDefault(); focusBlock(contentRef.current.blocks[0].id, "start"); return; }
            if ((e.key === "ArrowDown" && t.selectionStart === t.value.length) || (e.key === "ArrowRight" && t.selectionStart === t.value.length && t.selectionEnd === t.value.length)) {
              e.preventDefault(); focusBlock(contentRef.current.blocks[0].id, "start");
            }
          }} />
        {showOwnIndicator && <DocSaveIndicator state={saveState} />}
      </div>

      <div className="kdoc-blocks" role="group" aria-label="Doc" aria-describedby={`${menuItemsId}-help`}>
        {blocks.map((b, i) => {
          const selected = selectedSet.has(b.id);
          const common = { "data-block": b.id, "data-type": b.type, "data-indent": b.indent ?? 0, "data-selected": selected || undefined, "data-focus": focusId === b.id || undefined };
          const gutter = (
            <span className="kdoc-gutter" contentEditable={false}>
              <button type="button" className="kdoc-gbtn" tabIndex={-1} aria-label="Add a block below" title="Add a block below"
                onMouseDown={(e) => e.preventDefault()} onClick={() => addBelow(b.id)}>
                <Icon name="plus" size={14} sw={1.9} />
              </button>
              <button type="button" className="kdoc-gbtn kdoc-handle" tabIndex={-1} aria-label="Block actions (drag to move)" title={`Drag to move · click for actions (${MOD}/)`}
                ref={(el) => { if (el) handles.current.set(b.id, el); else handles.current.delete(b.id); }}
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={(e) => onHandleDown(e, b.id)} onPointerMove={onHandleMove} onPointerUp={(e) => onHandleUp(e, b.id)}
                onPointerCancel={() => { dragRef.current = null; setDrag(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openBlockMenu(b.id); } }}>
                <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true"><g fill="currentColor">{[2, 7, 12].map((y) => <g key={y}><circle cx="2.5" cy={y} r="1.3" /><circle cx="7.5" cy={y} r="1.3" /></g>)}</g></svg>
              </button>
            </span>
          );
          if (b.type === "divider") {
            return (
              <div key={b.id} {...common} className="kdoc-block kdoc-row">
                {gutter}
                <div className="kdoc-divider" role="separator" tabIndex={tabStop === b.id ? 0 : -1} aria-label="Divider"
                  ref={(el) => register(b.id, el)} onFocus={() => setFocusId(b.id)}
                  onKeyDown={(e) => {
                    const list = contentRef.current.blocks;
                    const at = list.findIndex((x) => x.id === b.id);
                    if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); removeBlocks([b.id]); }
                    else if (e.key === "ArrowUp" && at > 0) { e.preventDefault(); focusBlock(list[at - 1].id, "end"); }
                    else if (e.key === "ArrowDown" && at < list.length - 1) { e.preventDefault(); focusBlock(list[at + 1].id, "start"); }
                    else if (e.key === "Enter") { e.preventDefault(); const p = emptyBlock(); setBlocks([...list.slice(0, at + 1), p, ...list.slice(at + 1)], { caret: { id: p.id, start: 0 } }); }
                    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); selectBlocks(b.id, b.id); }
                    else if (modKey(e) && e.key === "/") { e.preventDefault(); openBlockMenu(b.id); }
                  }} />
              </div>
            );
          }
          const task = b.taskId ? taskById.get(b.taskId) : undefined;
          const placeholder = i === 0 && firstEmpty ? "Start writing, or press / for blocks" : PLACEHOLDER[b.type] ?? (focusId === b.id ? "Type / for blocks, @ to mention" : "");
          return (
            <div key={b.id} {...common} className="kdoc-block kdoc-row" data-checked={b.type === "todo" ? !!b.checked : undefined}
              data-task={task?.status === "done" ? "done" : undefined}>
              {gutter}
              {b.type === "bullet" && <span className="kdoc-marker" data-kind="bullet" aria-hidden="true" contentEditable={false} />}
              {b.type === "numbered" && <span className="kdoc-marker" data-kind="number" aria-hidden="true" contentEditable={false}>{listNumber(blocks, i)}.</span>}
              {b.type === "todo" && (
                <button type="button" role="checkbox" aria-checked={!!b.checked} className="kdoc-marker kdoc-check" data-kind="check" data-checked={!!b.checked}
                  tabIndex={-1} aria-label={`Done: ${blockPlainText(b, nameOf) || "checklist item"}`} title={`Tick (${MOD}↵)`}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => toggleChecked(b.id)} contentEditable={false}>
                  {b.checked && <Icon name="check" size={12} sw={2.6} />}
                </button>
              )}
              {b.type === "callout" && (
                <button type="button" className="kdoc-callout-icon" tabIndex={-1} aria-label={`Callout icon ${b.icon || "💡"}: change`} contentEditable={false}
                  onMouseDown={(e) => e.preventDefault()} onClick={(e) => { calloutAnchor.current = e.currentTarget; setCalloutPick(b.id); }}>
                  {b.icon || "💡"}
                </button>
              )}
              <BlockText block={b} editable={editable} label={BLOCK_LABEL[b.type] + (b.type === "numbered" ? ` ${listNumber(blocks, i)}` : "")}
                placeholder={placeholder} nameKey={nameKey} nameOf={nameOf} tabbable={tabStop === b.id} register={register}
                onInput={onInputStable} onKeyDown={onKeyDownStable} onFocus={onFocusStable} onPaste={onPasteStable} composing={composing} />
              {b.taskId && <TaskChip taskId={b.taskId} task={task} onOpen={onOpenTask} />}
              {making.has(b.id) && <span className="kdoc-task" data-status="making" contentEditable={false}><span className="kspin" aria-hidden="true" />Making task…</span>}
            </div>
          );
        })}
        <div className="kdoc-tail" aria-hidden="true"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const list = contentRef.current.blocks;
            const last = list[list.length - 1];
            if (last.type === "p" && isBlockEmpty(last)) focusBlock(last.id, "start");
            else { const p = emptyBlock(); setBlocks([...list, p], { caret: { id: p.id, start: 0 } }); }
          }} />
        {drag && <div className="kdoc-drop" style={{ top: drag.top } as CSSProperties} aria-hidden="true" />}
      </div>

      <p id={`${menuItemsId}-help`} className="sr-only">
        Type / for blocks and @ to mention someone. {MOD}+B, {MOD}+I, {MOD}+E and {MOD}+K format the selection. Escape selects the block; Tab indents a list item.
      </p>

      {menu && menuPos && menuCount > 0 && (
        <div className="kdoc-pop" data-up={menuPos.up || undefined} style={{ top: menuPos.top, left: menuPos.left } as CSSProperties}
          role="listbox" id={menuItemsId} aria-label={menu.kind === "slash" ? "Blocks" : "People to mention"}
          onMouseDown={(e) => e.preventDefault()}>
          {menu.kind === "slash" && <div className="kmenu-label">{menu.query ? `Blocks matching “${menu.query}”` : "Blocks"}</div>}
          {menu.kind === "mention" && <div className="kmenu-label">Mention</div>}
          {menu.kind === "slash" && slashItems.map((c, i) => (
            <div key={c.id} id={`${menuItemsId}-${i}`} role="option" aria-selected={i === menu.active} className="kdoc-opt" data-active={i === menu.active || undefined}
              onMouseEnter={() => setMenu((m) => (m ? { ...m, active: i } : m))} onClick={() => pickSlash(c)}>
              <span className="kdoc-opt-ico" aria-hidden="true">{slashGlyph(c)}</span>
              <span className="kdoc-opt-main"><span className="kdoc-opt-label">{c.label}</span><span className="kdoc-opt-hint">{c.hint}</span></span>
              {c.shortcut && <Kbd>{c.shortcut}</Kbd>}
            </div>
          ))}
          {menu.kind === "mention" && mentionItems.map((p, i) => (
            <div key={p.id} id={`${menuItemsId}-${i}`} role="option" aria-selected={i === menu.active} className="kdoc-opt" data-active={i === menu.active || undefined}
              onMouseEnter={() => setMenu((m) => (m ? { ...m, active: i } : m))} onClick={() => pickMention(p)}>
              <Avatar id={p.id} size={20} />
              <span className="kdoc-opt-main"><span className="kdoc-opt-label">{p.name}{p.id === currentUserId ? " (you)" : ""}</span></span>
              {p.type === "external" && <span className="kdoc-opt-hint">Guest</span>}
            </div>
          ))}
          {menu.kind === "mention" && <div className="kdoc-pop-note">They'll get a notice in their Inbox.</div>}
        </div>
      )}
      {/* the list is announced through the focused block */}
      {menu && <span className="sr-only" aria-live="polite">{menuCount ? `${menuCount} ${menu.kind === "slash" ? "blocks" : "people"}. Up and down to choose, Enter to pick.` : "No matches."}</span>}
      <ActiveDescendant blockEl={menu ? els.current.get(menu.blockId) ?? null : null} listId={menu && menuCount ? menuItemsId : undefined} activeId={activeId} />

      {bubble && !linkEdit && (
        <div className="kdoc-bubble" style={{ top: bubble.top, left: bubble.left } as CSSProperties} role="toolbar" aria-label="Format"
          onMouseDown={(e) => e.preventDefault()}>
          {bubble.link ? (
            <>
              <a className="kdoc-bubble-link" href={bubble.link.href} target="_blank" rel="noopener noreferrer nofollow" title={bubble.link.href}>
                <Icon name="arrowUpRight" size={14} sw={1.9} /><span>{linkLabel(bubble.link.href)}</span>
              </a>
              <button type="button" className="kdoc-bbtn" onClick={() => openLink(bubble.blockId, { start: bubble.link!.start, end: bubble.link!.end })}>Edit</button>
              <button type="button" className="kdoc-bbtn" onClick={() => applyLink({ blockId: bubble.blockId, start: bubble.link!.start, end: bubble.link!.end, value: "", top: 0, left: 0, error: null, existing: true }, true)}>Remove</button>
            </>
          ) : (
            <>
              {(["b", "i", "code"] as DocMark[]).map((mk) => {
                const b = blocks.find((x) => x.id === bubble.blockId);
                const on = !!b && hasMark(b.spans, bubble.start, bubble.end, mk);
                const name = mk === "b" ? "Bold" : mk === "i" ? "Italic" : "Code";
                const key = mk === "b" ? "B" : mk === "i" ? "I" : "E";
                return (
                  <button key={mk} type="button" className="kdoc-bbtn" data-mark={mk} aria-pressed={on} aria-label={`${name} (${MOD}${key})`} title={`${name} · ${MOD}${key}`}
                    onClick={() => applyMark(bubble.blockId, mk, { start: bubble.start, end: bubble.end })}>
                    {mk === "b" ? <b>B</b> : mk === "i" ? <i>I</i> : <code>{"</>"}</code>}
                  </button>
                );
              })}
              <span className="kdoc-bsep" aria-hidden="true" />
              <button type="button" className="kdoc-bbtn" aria-label={`Link (${MOD}K)`} title={`Link · ${MOD}K`} onClick={() => openLink(bubble.blockId, { start: bubble.start, end: bubble.end })}>
                <Icon name="link" size={14} sw={1.9} />
              </button>
              <button type="button" className="kdoc-bbtn" aria-label="Make task from this line" title="Make task from this line" onClick={() => void makeTask(bubble.blockId)}>
                <Icon name="tasks" size={14} sw={1.9} />
              </button>
            </>
          )}
        </div>
      )}

      {linkEdit && (
        <LinkEditor le={linkEdit} onChange={setLinkEdit} onApply={() => applyLink(linkEdit)} onRemove={() => applyLink(linkEdit, true)}
          onCancel={() => { const le = linkEdit; setLinkEdit(null); pendingCaret.current = { id: le.blockId, start: le.start, end: le.end }; setContent((c) => ({ ...c })); }} />
      )}

      <Popover open={!!blockMenu} anchorRef={blockMenuAnchor} onClose={() => setBlockMenu(null)} label="Block actions" minWidth={220}>
        {blockMenu && <BlockMenu id={blockMenu.id} page={blockMenu.page} block={blocks.find((x) => x.id === blockMenu.id)} index={blocks.findIndex((x) => x.id === blockMenu.id)} count={blocks.length}
          onPage={(page) => setBlockMenu({ ...blockMenu, page })}
          onDo={(act, type) => {
            const id = blockMenu.id;
            setBlockMenu(null);
            if (act === "turn" && type) turnInto(id, type);
            else if (act === "task") void makeTask(id);
            else if (act === "unlink") unlinkTask(id);
            else if (act === "duplicate") duplicate([id]);
            else if (act === "up") moveBlocks([id], -1);
            else if (act === "down") moveBlocks([id], 1);
            else if (act === "delete") removeBlocks([id]);
            if (!pendingCaret.current && act !== "task" && contentRef.current.blocks.some((x) => x.id === id)) {
              const b = contentRef.current.blocks.find((x) => x.id === id)!;
              pendingCaret.current = { id, start: b.type === "divider" ? 0 : spansLength(b.spans) };
              setContent((c) => ({ ...c }));
            } else if (act === "task") {
              pendingCaret.current = { id, start: spansLength(contentRef.current.blocks.find((x) => x.id === id)?.spans) };
              setContent((c) => ({ ...c }));
            }
          }} />}
      </Popover>

      <Popover open={!!calloutPick} anchorRef={calloutAnchor} onClose={() => setCalloutPick(null)} role="dialog" label="Callout icon" minWidth={268}>
        {calloutPick && <EmojiPicker onPick={(emoji) => {
          const i = indexOf(calloutPick);
          if (i >= 0) setBlocks(replaceAt(i, { ...contentRef.current.blocks[i], icon: emoji }), { caret: { id: calloutPick, start: spansLength(contentRef.current.blocks[i].spans) } });
          setCalloutPick(null);
        }} />}
      </Popover>

      <VersionHistory open={historyOpen} onClose={() => setHistoryOpen(false)} docId={doc.id} members={members} nameOf={nameOf}
        tasks={taskById} canRestore={editable && !gone} onRestore={restoreVersion} />

      <p className="sr-only" role="status" aria-live="polite">{notice}</p>
    </div>
  );
});

/* ------------------------------------------------------------ bits */

function slashGlyph(c: SlashCommand): string {
  switch (c.id) {
    case "p": return "Aa";
    case "h1": return "H1";
    case "h2": return "H2";
    case "h3": return "H3";
    case "bullet": return "•";
    case "numbered": return "1.";
    case "todo": return "☐";
    case "quote": return "“";
    case "callout": return "💡";
    case "divider": return "—";
    case "task": return "✓";
    case "mention": return "@";
    default: return "";
  }
}

/** Points the focused block at the menu's active option (aria-activedescendant), without re-rendering the block. */
function ActiveDescendant({ blockEl, listId, activeId }: { blockEl: HTMLElement | null; listId?: string; activeId?: string }) {
  useLayoutEffect(() => {
    if (!blockEl) return;
    if (listId && activeId) {
      blockEl.setAttribute("aria-controls", listId);
      blockEl.setAttribute("aria-activedescendant", activeId);
      blockEl.setAttribute("aria-autocomplete", "list");
      blockEl.setAttribute("aria-expanded", "true");
    }
    return () => {
      blockEl.removeAttribute("aria-controls");
      blockEl.removeAttribute("aria-activedescendant");
      blockEl.removeAttribute("aria-autocomplete");
      blockEl.removeAttribute("aria-expanded");
    };
  }, [blockEl, listId, activeId]);
  return null;
}

function LinkEditor({ le, onChange, onApply, onRemove, onCancel }: { le: LinkEdit; onChange: (le: LinkEdit) => void; onApply: () => void; onRemove: () => void; onCancel: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  return (
    <div className="kdoc-linkbox" style={{ top: le.top, left: le.left } as CSSProperties} role="dialog" aria-label={le.existing ? "Edit link" : "Add a link"}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      <form onSubmit={(e) => { e.preventDefault(); onApply(); }}>
        <label className="sr-only" htmlFor={`kdoc-link-${le.blockId}`}>Link address</label>
        <input id={`kdoc-link-${le.blockId}`} ref={inputRef} className="kfield" data-size="sm" value={le.value} placeholder="Paste or type a link"
          aria-invalid={!!le.error || undefined} aria-describedby={le.error ? `kdoc-link-err-${le.blockId}` : undefined}
          onChange={(e) => onChange({ ...le, value: e.target.value, error: null })} />
        <Button type="submit" size="sm" variant="primary">{le.existing ? "Update" : "Link"}</Button>
        {le.existing && <IconButton icon="trash" size="sm" label="Remove link" tone="danger" onClick={onRemove} />}
        <IconButton icon="x" size="sm" label="Cancel" onClick={onCancel} />
      </form>
      {le.error && <p id={`kdoc-link-err-${le.blockId}`} className="kdoc-linkbox-err" role="alert">{le.error}</p>}
    </div>
  );
}

type BlockAct = "turn" | "task" | "unlink" | "duplicate" | "up" | "down" | "delete";
const TURN_TYPES: DocBlockType[] = ["p", "h1", "h2", "h3", "bullet", "numbered", "todo", "quote", "callout"];

function BlockMenu({ block, page, index, count, onPage, onDo }: {
  id: string; block?: DocBlock; page: "main" | "turn"; index: number; count: number;
  onPage: (p: "main" | "turn") => void; onDo: (act: BlockAct, type?: DocBlockType) => void;
}) {
  if (!block) return null;
  if (page === "turn") {
    return (
      <>
        <button type="button" className="kmenu-item" onClick={() => onPage("main")}><Icon name="chevronLeft" size={16} sw={1.75} />Turn into</button>
        <hr className="kmenu-sep" />
        {TURN_TYPES.map((t) => (
          <button key={t} type="button" role="menuitemradio" aria-checked={block.type === t} className="kmenu-item" onClick={() => onDo("turn", t)}>
            <span className="kdoc-opt-ico" aria-hidden="true">{slashGlyph({ id: t } as SlashCommand)}</span>{BLOCK_LABEL[t]}
            {block.type === t && <Icon name="check" size={14} sw={2} className="kmenu-check" />}
          </button>
        ))}
      </>
    );
  }
  const text = block.type !== "divider";
  return (
    <>
      {text && !block.taskId && <button type="button" className="kmenu-item" onClick={() => onDo("task")}><Icon name="tasks" size={16} sw={1.75} />Make task</button>}
      {block.taskId && <button type="button" className="kmenu-item" onClick={() => onDo("task")}><Icon name="arrowUpRight" size={16} sw={1.75} />Open task</button>}
      {block.taskId && <button type="button" className="kmenu-item" onClick={() => onDo("unlink")}><Icon name="link" size={16} sw={1.75} />Unlink task</button>}
      {text && <button type="button" className="kmenu-item" onClick={() => onPage("turn")}><Icon name="refresh" size={16} sw={1.75} />Turn into<Icon name="chevronRight" size={14} sw={1.75} className="kmenu-check" /></button>}
      <button type="button" className="kmenu-item" onClick={() => onDo("duplicate")}><Icon name="copy" size={16} sw={1.75} />Duplicate<Kbd>{MOD}D</Kbd></button>
      <button type="button" className="kmenu-item" disabled={index <= 0} onClick={() => onDo("up")}><Icon name="arrowLeft" size={16} sw={1.75} style={{ transform: "rotate(90deg)" }} />Move up<Kbd>{MOD}⇧↑</Kbd></button>
      <button type="button" className="kmenu-item" disabled={index >= count - 1} onClick={() => onDo("down")}><Icon name="arrowRight" size={16} sw={1.75} style={{ transform: "rotate(90deg)" }} />Move down<Kbd>{MOD}⇧↓</Kbd></button>
      <hr className="kmenu-sep" />
      <button type="button" className="kmenu-item" data-tone="danger" onClick={() => onDo("delete")}><Icon name="trash" size={16} sw={1.75} />Delete</button>
    </>
  );
}

/* ------------------------------------------------------------ save indicator */

/** Saving… / Saved / Offline / Not saved, quietly (screen readers hear only the problems). */
export function DocSaveIndicator({ state }: { state: DocSaveState }) {
  const text = state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "offline" ? "Offline · will save" : state === "conflict" ? "Not saved" : state === "error" ? "Not saved" : "";
  const loud = state === "offline" || state === "conflict" || state === "error";
  return (
    <span className="kdoc-save" data-state={state}>
      {state === "saving" && <span className="kspin" aria-hidden="true" />}
      {state === "saved" && <Icon name="check" size={14} sw={2} />}
      {loud && <Icon name="alert" size={14} sw={1.9} />}
      <span aria-hidden={!loud || undefined}>{text}</span>
      {loud && <span className="sr-only" role="status">{state === "offline" ? "You're offline. Your changes will save when you're back online." : "Your latest changes aren't saved."}</span>}
    </span>
  );
}

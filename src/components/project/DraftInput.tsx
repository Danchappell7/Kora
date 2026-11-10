/* ============================================================
   KANBO — DraftInput: a field that edits a local draft and saves
   once (on blur or Enter; Escape reverts). Shared by Goals,
   Portfolios, Rules, Requests and a project's About tab.
   ============================================================ */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

/** Browsers that size a textarea to its text from CSS (field-sizing: content) need no help. */
const sizesItself = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");

/** Saving on every keystroke sent ~25 UPDATEs per name, and a realtime
 *  reload in between could revert the field mid-word. Only a value the user
 *  actually typed is ever saved: focusing a field and leaving it never
 *  writes, so a teammate's change that arrives meanwhile shows up and is kept. */
export function DraftInput({ value, onCommit, label, style, className, type = "text", placeholder, required = false, min, max, title, disabled, multiline = false }: {
  value: string | number | undefined;
  /** save the typed value. Return false to reject it (the field shows the
   *  saved value again), or a string to show the value as it was stored. */
  onCommit: (v: string) => void | string | false;
  label: string;
  style?: CSSProperties;
  className?: string;
  type?: "text" | "number";
  placeholder?: string;
  /** an empty value reverts instead of saving (names can't be blank) */
  required?: boolean;
  min?: number;
  max?: number;
  title?: string;
  disabled?: boolean;
  /** a few lines of text (a goal's description): wraps and grows instead of cutting off.
   *  Enter still saves; it's a line or two, not a document. */
  multiline?: boolean;
}) {
  const external = value == null ? "" : String(value);
  const [draft, setDraft] = useState(external);
  // true once the user has typed; until then the field keeps following `value`
  const dirty = useRef(false);
  const cancelled = useRef(false);
  // follow outside changes (another tab, a teammate) — but never over unsaved typing
  useEffect(() => { if (!dirty.current) setDraft(external); }, [external]);
  // a multi-line field is as tall as its text, so nothing is hidden behind a scroll
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el || sizesItself) return;
    const fit = () => { el.style.height = "auto"; if (el.scrollHeight) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`; };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [draft, multiline]);
  const commit = () => {
    const typed = dirty.current, escaped = cancelled.current;
    dirty.current = false; cancelled.current = false;
    if (!typed || escaped) { setDraft(external); return; }
    const v = type === "text" ? draft.trim() : draft;
    if ((required && !v) || v === external) { setDraft(external); return; }
    const shown = onCommit(v);
    setDraft(shown === false ? external : typeof shown === "string" ? shown : v);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
    else if (e.key === "Escape") { e.stopPropagation(); cancelled.current = true; e.currentTarget.blur(); }
  };
  if (multiline) return (
    <textarea ref={areaRef} rows={1} value={draft} title={title} placeholder={placeholder} aria-label={label}
      style={style} className={className} disabled={disabled}
      onChange={(e) => { dirty.current = true; setDraft(e.target.value.replace(/\s*\n\s*/g, " ")); }}
      onBlur={commit} onKeyDown={onKeyDown} />
  );
  return (
    <input type={type} value={draft} min={min} max={max} title={title} placeholder={placeholder} aria-label={label}
      style={style} className={className} disabled={disabled}
      onChange={(e) => { dirty.current = true; setDraft(e.target.value); }}
      onBlur={commit} onKeyDown={onKeyDown} />
  );
}

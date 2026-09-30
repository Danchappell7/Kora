/* ============================================================
   KANBO — tag manager: rename, recolour, merge and delete tags.
   TagManagerPanel is the manager itself (Settings › Tags renders it
   inline); TagManagerModal wraps it in a dialog for the places that
   still open it on its own.
   ============================================================ */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Icon, IconButton, Button, EmptyState, projectPaint } from "./primitives";
import { Popover } from "./primitives/Popover";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { TagDef } from "../data/types";

const PALETTE: { c: string; name: string }[] = [
  { c: "oklch(0.74 0.14 230)", name: "blue" }, { c: "oklch(0.74 0.16 305)", name: "purple" }, { c: "oklch(0.75 0.13 155)", name: "green" },
  { c: "oklch(0.78 0.15 70)", name: "amber" }, { c: "oklch(0.66 0.2 20)", name: "red" }, { c: "oklch(0.78 0.1 45)", name: "peach" },
  { c: "oklch(0.7 0.02 260)", name: "grey" },
];
const TAG_MAX = 40;
const FILTER_FROM = 8; // show a filter box once the list gets long
const norm = (s: string) => s.trim().toLowerCase();
const plural = (n: number) => `${n} task${n === 1 ? "" : "s"}`;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const colourName = (c: string) => PALETTE.find((p) => p.c === c)?.name ?? "custom";

const TAGS_CSS = `
.ktm { display: flex; flex-direction: column; gap: 16px; min-height: 0; outline: none; }
.ktm-list { list-style: none; margin: 0; padding: 4px 0; background: var(--surface); border-radius: var(--r-lg, 12px); box-shadow: var(--e1, var(--shadow)); }
.ktm-row { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 0 8px 0 10px; }
.ktm-row + .ktm-row { box-shadow: inset 0 1px 0 var(--hairline); }
.ktm-swatch { display: grid; place-items: center; width: 28px; height: 28px; flex-shrink: 0; padding: 0; border: 0; border-radius: var(--r-sm, 6px); background: transparent; cursor: pointer; transition: background var(--d-1, 90ms) var(--ease); }
.ktm-swatch:hover, .ktm-swatch[aria-expanded="true"] { background: var(--fill-1); }
.ktm-dot { display: block; width: 10px; height: 10px; border-radius: 50%; }
.ktm-name {
  flex: 1 1 140px; min-width: 0; height: 32px; padding: 0 8px; border-radius: var(--r-sm, 6px);
  border: 1px solid transparent; background: transparent; color: var(--ink);
  font: 500 14px/20px var(--font-ui, var(--font-display)); transition: border-color var(--d-1, 90ms) var(--ease), background var(--d-1, 90ms) var(--ease);
}
.ktm-name:hover { border-color: var(--field-border, var(--hairline-strong)); }
.ktm-name:focus { border-color: var(--field-border-hover, var(--hairline-strong)); background: var(--field-bg, var(--surface)); }
.ktm-count { flex-shrink: 0; min-width: 56px; text-align: right; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-4); }
.ktm-acts { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.ktm-select, .ktm-input {
  min-width: 0; border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface)); color: var(--ink);
  font: 500 13px/20px var(--font-ui, var(--font-display)); border-radius: var(--r-sm, 6px);
}
.ktm-select { height: 28px; max-width: 180px; padding: 0 6px; }
.ktm-input { height: 32px; padding: 0 10px; }
.ktm-input:hover:not(:focus) { border-color: var(--field-border-hover, var(--hairline-strong)); }
.ktm-input::placeholder { color: var(--ink-4); opacity: 1; }
.ktm-input[aria-invalid="true"] { border-color: var(--signal, var(--prio-urgent)); }
.ktm-new { display: flex; flex-direction: column; gap: 6px; }
.ktm-new-row { display: flex; gap: 8px; }
.ktm-new-row .ktm-input { flex: 1; }
.ktm-err { margin: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--signal, var(--prio-urgent)); }
.ktm-none { margin: 0; padding: 12px 2px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.ktm-opt {
  display: flex; width: 100%; align-items: center; gap: 10px; height: 32px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; color: var(--ink-2); cursor: pointer; text-align: left; font: 500 13px/20px var(--font-ui, var(--font-display));
}
.ktm-opt[aria-checked="true"] { color: var(--ink); font-weight: 600; }
.ktm-opt-check { margin-left: auto; color: var(--accent-text, var(--accent)); }
.ktm-dialog { max-height: min(720px, 100%); }
@media (max-width: 859px) {
  .ksheet.ktm-dialog { max-height: 92%; }
  /* 16px stops iOS zooming into a field on focus */
  .ktm-input, .ktm-name { font-size: 16px; }
  .ktm-row { flex-wrap: wrap; padding: 6px 6px 6px 8px; row-gap: 2px; }
  .ktm-count { min-width: 0; }
}
`;

export interface TagManagerPanelProps {
  tags: Record<string, TagDef>;
  taskCounts: Record<string, number>;
  onUpdate: (id: string, patch: { label?: string; color?: string }) => void;
  onDelete: (id: string) => void;
  onMerge: (fromId: string, intoId: string) => void;
  /** optional: when provided, the manager can also create tags */
  onCreate?: (label: string, color: string) => void;
  /** where focus rests after a merge or delete when there's no filter box (the dialog's Close) */
  homeRef?: RefObject<HTMLElement>;
  /** focus the filter box (or `homeRef`) on mount — a dialog opening; Settings leaves focus on its nav */
  autoFocus?: boolean;
}

/** The tag manager without any dialog chrome. Escape backs out one level at a
 *  time — merge picker → unsaved rename (reverted, never saved) → typed filter
 *  or new tag name (while you're in that box) — and is left for the host
 *  dialog once there's nothing to back out of. Focus never moves on the way,
 *  so no blur can commit a half-typed rename. */
export function TagManagerPanel({ tags, taskCounts, onUpdate, onDelete, onMerge, onCreate, homeRef, autoFocus }: TagManagerPanelProps) {
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newError, setNewError] = useState("");
  const [colourFor, setColourFor] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const mergeBtns = useRef<Record<string, HTMLButtonElement | null>>({});
  const swatchBtns = useRef<Record<string, HTMLButtonElement | null>>({});
  const colourAnchor = useRef<HTMLButtonElement | null>(null);
  // the resting focus: the filter box when there is one, else the host's (Close), else the panel
  const focusHome = () => window.setTimeout(() => (filterRef.current ?? homeRef?.current ?? rootRef.current)?.focus(), 0);
  const revert = (id: string) => setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });

  useEffect(() => {
    if (!autoFocus) return;
    const t = window.setTimeout(() => (filterRef.current ?? homeRef?.current)?.focus(), 30);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** true when Escape was used up backing out of something */
  const backOut = (): boolean => {
    if (mergeFrom) { const id = mergeFrom; setMergeFrom(null); window.setTimeout(() => mergeBtns.current[id]?.focus(), 0); return true; }
    if (editing && drafts[editing] !== undefined) { revert(editing); return true; }
    if (filter && document.activeElement === filterRef.current) { setFilter(""); return true; }
    if (newLabel && document.activeElement === newRef.current) { setNewLabel(""); setNewError(""); return true; }
    return false;
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
    // marked handled, so the dialog around us (its focus trap) leaves it alone
    if (backOut()) { e.preventDefault(); e.stopPropagation(); }
  };

  const all = Object.entries(tags).sort((a, b) => a[1].label.localeCompare(b[1].label));
  // keep the box while a filter is typed, even if a merge/delete takes the list
  // back under the threshold — otherwise the list stays filtered with no way to clear it
  const showFilter = all.length > FILTER_FROM || filter !== "";
  const q = norm(filter);
  const entries = q ? all.filter(([, t]) => t.label.toLowerCase().includes(q)) : all;
  const labelOf = (id: string) => tags[id]?.label ?? "";
  const countOf = (id: string) => taskCounts[id] || 0;

  const commitRename = (id: string) => {
    const draft = drafts[id];
    if (draft === undefined) return;
    const v = draft.trim().slice(0, TAG_MAX);
    const cur = labelOf(id);
    revert(id);
    if (!v || v === cur) return;
    const clash = all.find(([oid, ot]) => oid !== id && norm(ot.label) === norm(v));
    if (clash) {
      if (window.confirm(`A tag called “${clash[1].label}” already exists.\n\nMerge “${cur}” into it? ${countOf(id) ? `${plural(countOf(id))} will be re-tagged and ` : ""}“${cur}” will be deleted.`)) {
        onMerge(id, clash[0]);
        focusHome();
      }
      return;
    }
    onUpdate(id, { label: v });
  };

  const merge = (fromId: string, intoId: string) => {
    setMergeFrom(null);
    const from = labelOf(fromId), into = labelOf(intoId), n = countOf(fromId);
    const detail = n ? `${plural(n)} tagged “${from}” will be tagged “${into}” instead, and “${from}” will be deleted.` : `“${from}” will be deleted.`;
    if (window.confirm(`Merge “${from}” into “${into}”?\n\n${detail}`)) { onMerge(fromId, intoId); focusHome(); }
    else window.setTimeout(() => mergeBtns.current[fromId]?.focus(), 0);
  };

  const remove = (id: string) => {
    const n = countOf(id);
    if (window.confirm(`Delete tag “${labelOf(id)}” from every task?${n ? ` It's used on ${plural(n)}.` : ""}`)) { onDelete(id); focusHome(); }
  };

  const create = () => {
    const v = newLabel.trim().slice(0, TAG_MAX);
    if (!v || !onCreate) return;
    if (all.some(([, t]) => norm(t.label) === norm(v))) { setNewError(`A tag called “${v}” already exists.`); return; }
    onCreate(v, PALETTE[all.length % PALETTE.length].c);
    setNewLabel(""); setNewError("");
  };

  const colourTag = colourFor ? tags[colourFor] : undefined;

  return (
    <div ref={rootRef} className="ktm" tabIndex={-1} onKeyDown={onKeyDown}>
      <style>{TAGS_CSS}</style>
      {showFilter && (
        <input ref={filterRef} type="search" className="ktm-input" value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${all.length} tags…`} aria-label="Filter tags" />
      )}

      {all.length === 0 ? (
        <EmptyState size="sm" title="No tags yet"
          body={onCreate ? "Create your first one below. Tags cut across projects, so you can find related work anywhere." : "Add a tag from any task and it will appear here."} />
      ) : entries.length === 0 ? (
        <p className="ktm-none">No tags match “{filter.trim()}”.</p>
      ) : (
        <ul aria-label="Tags" className="ktm-list">
          {entries.map(([id, t]) => {
            const n = countOf(id);
            return (
              <li key={id} className="ktm-row">
                {/* colour: the tag's dot opens the palette */}
                <button ref={(el) => { swatchBtns.current[id] = el; }} type="button" className="ktm-swatch"
                  aria-haspopup="menu" aria-expanded={colourFor === id}
                  aria-label={`Colour for ${t.label}: ${cap(colourName(t.color))}. Change colour`} data-tip="Change colour"
                  onClick={() => { colourAnchor.current = swatchBtns.current[id]; setColourFor((cur) => (cur === id ? null : id)); }}>
                  <span className="ktm-dot" style={{ background: projectPaint(t.color).solid }} />
                </button>
                {/* label */}
                <input className="ktm-name" value={drafts[id] ?? t.label} maxLength={TAG_MAX} aria-label={`Rename tag ${t.label}`}
                  onChange={(e) => { const v = e.target.value; setDrafts((d) => ({ ...d, [id]: v })); }}
                  onFocus={() => setEditing(id)}
                  onBlur={() => { commitRename(id); setEditing((cur) => (cur === id ? null : cur)); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); commitRename(id); } }} />
                <span className="ktm-count">{plural(n)}</span>
                <div className="ktm-acts">
                  {/* merge */}
                  {mergeFrom === id ? (
                    <select autoFocus className="ktm-select" value="" onChange={(e) => { if (e.target.value) merge(id, e.target.value); else setMergeFrom(null); }}
                      onBlur={() => setMergeFrom((cur) => (cur === id ? null : cur))} aria-label={`Merge ${t.label} into`}>
                      <option value="">Merge into…</option>
                      {all.filter(([oid]) => oid !== id).map(([oid, ot]) => <option key={oid} value={oid}>{ot.label}</option>)}
                    </select>
                  ) : (
                    <IconButton ref={(el) => { mergeBtns.current[id] = el; }} icon="layers" size="sm" label={`Merge tag ${t.label} into another tag`}
                      onClick={() => setMergeFrom(id)} disabled={all.length < 2} />
                  )}
                  <IconButton icon="trash" size="sm" tone="danger" label={`Delete tag ${t.label}`} onClick={() => remove(id)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {colourFor && colourTag && (
        <Popover open anchorRef={colourAnchor} onClose={() => setColourFor(null)} label={`Colour for ${colourTag.label}`} minWidth={168}>
          {PALETTE.map(({ c, name }) => {
            const on = colourTag.color === c;
            return (
              <button key={c} type="button" role="menuitemradio" aria-checked={on} className="ktm-opt"
                onClick={() => { if (!on) onUpdate(colourFor, { color: c }); setColourFor(null); }}>
                <span className="ktm-dot" aria-hidden="true" style={{ background: projectPaint(c).solid }} />
                {cap(name)}
                {on && <Icon name="check" size={16} sw={2} className="ktm-opt-check" />}
              </button>
            );
          })}
        </Popover>
      )}

      {onCreate && (
        <form className="ktm-new" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <div className="ktm-new-row">
            <input ref={newRef} className="ktm-input" value={newLabel} maxLength={TAG_MAX} onChange={(e) => { setNewLabel(e.target.value); if (newError) setNewError(""); }}
              placeholder="New tag name…" aria-label="New tag name" aria-invalid={!!newError} aria-describedby={newError ? "kanbo-tagmgr-err" : undefined} />
            <Button type="submit" variant="primary" icon="plus" disabled={!newLabel.trim()}>Add tag</Button>
          </div>
          {newError && <p id="kanbo-tagmgr-err" role="alert" className="ktm-err">{newError}</p>}
        </form>
      )}
    </div>
  );
}

export function TagManagerModal({ open, onClose, tags, taskCounts, onUpdate, onDelete, onMerge, onCreate }: {
  open: boolean;
  onClose: () => void;
} & Omit<TagManagerPanelProps, "homeRef" | "autoFocus">) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const downOnScrim = useRef(false);
  // The panel backs Escape out in stages itself; whatever reaches the trap
  // closes the dialog — straight from a field too (fieldEscape: "dialog"),
  // with focus left where it is so no blur commits a half-typed rename.
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose, { fieldEscape: "dialog" });

  if (!open) return null;
  return (
    <div className="kbackdrop ksheet-layer" data-side="center"
      onMouseDown={(e) => { downOnScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnScrim.current && e.target === e.currentTarget) onClose(); downOnScrim.current = false; }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="kanbo-tagmgr-title" className="ksheet ktm-dialog"
        style={{ "--sheet-w": "560px" } as React.CSSProperties}>
        <span className="ksheet-handle" aria-hidden="true" />
        <div className="ksheet-head">
          <h2 id="kanbo-tagmgr-title" className="ksheet-title">Manage tags</h2>
          <IconButton ref={closeRef} icon="x" label="Close" onClick={onClose} />
        </div>
        <div className="ksheet-body">
          <TagManagerPanel tags={tags} taskCounts={taskCounts} onUpdate={onUpdate} onDelete={onDelete} onMerge={onMerge} onCreate={onCreate}
            homeRef={closeRef} autoFocus />
        </div>
      </div>
    </div>
  );
}

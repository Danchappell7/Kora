/* ============================================================
   KANBO — tag manager: rename, recolour, merge and delete tags.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { Icon } from "./primitives";
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

export function TagManagerModal({ open, onClose, tags, taskCounts, onUpdate, onDelete, onMerge, onCreate }: {
  open: boolean;
  onClose: () => void;
  tags: Record<string, TagDef>;
  taskCounts: Record<string, number>;
  onUpdate: (id: string, patch: { label?: string; color?: string }) => void;
  onDelete: (id: string) => void;
  onMerge: (fromId: string, intoId: string) => void;
  /** optional: when provided, the manager can also create tags */
  onCreate?: (label: string, color: string) => void;
}) {
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newError, setNewError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const mergeBtns = useRef<Record<string, HTMLButtonElement | null>>({});
  // the dialog's resting focus: the filter box when there is one, else Close
  const focusHome = () => window.setTimeout(() => (filterRef.current ?? closeRef.current)?.focus(), 0);
  const revert = (id: string) => setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });

  // Escape backs out one level at a time: merge picker → unsaved rename → dialog
  const onEscape = () => {
    if (mergeFrom) { const id = mergeFrom; setMergeFrom(null); window.setTimeout(() => mergeBtns.current[id]?.focus(), 0); return; }
    if (editing && drafts[editing] !== undefined) { revert(editing); return; }
    onClose();
  };
  const trapRef = useFocusTrap<HTMLDivElement>(open, onEscape);

  useEffect(() => {
    if (!open) return;
    setMergeFrom(null); setDrafts({}); setEditing(null); setFilter(""); setNewLabel(""); setNewError("");
    const t = window.setTimeout(() => (filterRef.current ?? closeRef.current)?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const all = Object.entries(tags).sort((a, b) => a[1].label.localeCompare(b[1].label));
  const showFilter = all.length > FILTER_FROM;
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

  const iconBtn = { border: "none", width: 28, height: 28, flexShrink: 0 } as const;

  return (
    <>
      <div onClick={onClose} className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 90, background: "color-mix(in oklch, var(--bg-deep) 55%, transparent)", backdropFilter: "blur(3px)" }} />
      <div ref={trapRef} role="dialog" aria-modal="true" aria-labelledby="kanbo-tagmgr-title" className="glass anim-scalein" style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 91, width: 560, maxWidth: "calc(100vw - 24px)", maxHeight: "88vh", padding: 22, borderRadius: 20, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="tasks" size={17} style={{ color: "var(--accent)" }} />
          <div id="kanbo-tagmgr-title" role="heading" aria-level={2} style={{ flex: 1, fontSize: 16, fontWeight: 600 }}>Manage tags</div>
          <button ref={closeRef} type="button" className="btn-icon" onClick={onClose} aria-label="Close" style={{ border: "none" }}><Icon name="x" size={18} /></button>
        </div>

        {showFilter && (
          <input ref={filterRef} type="search" value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${all.length} tags…`} aria-label="Filter tags"
            style={{ height: 34, padding: "0 11px", borderRadius: 9, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5 }} />
        )}

        {all.length === 0 ? (
          <p style={{ fontSize: 13.5, color: "var(--ink-4)", margin: "8px 0" }}>
            {onCreate ? "No tags yet — create your first one below." : "No tags yet — add tags from a task to manage them here."}
          </p>
        ) : entries.length === 0 ? (
          <p style={{ fontSize: 13.5, color: "var(--ink-4)", margin: "8px 0" }}>No tags match “{filter.trim()}”.</p>
        ) : (
          <ul aria-label="Tags" style={{ listStyle: "none", margin: 0, padding: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            {entries.map(([id, t]) => {
              const n = countOf(id);
              return (
                <li key={id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, rowGap: 8, padding: "8px 10px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)" }}>
                  {/* colour */}
                  <div role="group" aria-label={`Colour for ${t.label}`} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    {PALETTE.map(({ c, name }) => {
                      const on = t.color === c;
                      return (
                        <button key={c} type="button" onClick={() => { if (!on) onUpdate(id, { color: c }); }} aria-pressed={on} aria-label={`Set ${t.label} colour to ${name}`} title={name[0].toUpperCase() + name.slice(1)}
                          style={{ width: 15, height: 15, borderRadius: 4, background: c, border: on ? "2px solid var(--ink)" : "1px solid var(--hairline)", cursor: "pointer", padding: 0 }} />
                      );
                    })}
                  </div>
                  {/* label */}
                  <input value={drafts[id] ?? t.label} maxLength={TAG_MAX} aria-label={`Rename tag ${t.label}`}
                    onChange={(e) => { const v = e.target.value; setDrafts((d) => ({ ...d, [id]: v })); }}
                    onFocus={() => setEditing(id)}
                    onBlur={() => { commitRename(id); setEditing((cur) => (cur === id ? null : cur)); }}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); commitRename(id); } }}
                    style={{ flex: "1 1 140px", minWidth: 0, height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface-2)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5 }} />
                  <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)", minWidth: 48, textAlign: "right" }}>{plural(n)}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: "auto" }}>
                    {/* merge */}
                    {mergeFrom === id ? (
                      <select autoFocus value="" onChange={(e) => { if (e.target.value) merge(id, e.target.value); else setMergeFrom(null); }} onBlur={() => setMergeFrom((cur) => (cur === id ? null : cur))} aria-label={`Merge ${t.label} into`}
                        style={{ height: 30, maxWidth: 170, borderRadius: 8, border: "1px solid var(--accent)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12.5 }}>
                        <option value="">Merge into…</option>
                        {all.filter(([oid]) => oid !== id).map(([oid, ot]) => <option key={oid} value={oid}>{ot.label}</option>)}
                      </select>
                    ) : (
                      <button ref={(el) => { mergeBtns.current[id] = el; }} type="button" onClick={() => setMergeFrom(id)} title="Merge into another tag" aria-label={`Merge tag ${t.label} into another tag`} disabled={all.length < 2} className="btn-icon" style={{ ...iconBtn, color: "var(--ink-4)", opacity: all.length < 2 ? 0.4 : 1 }}><Icon name="layers" size={15} /></button>
                    )}
                    <button type="button" onClick={() => remove(id)} title="Delete tag" aria-label={`Delete tag ${t.label}`} className="btn-icon" style={{ ...iconBtn, color: "var(--prio-urgent)" }}><Icon name="trash" size={15} /></button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {onCreate && (
          <form onSubmit={(e) => { e.preventDefault(); create(); }} style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 12, borderTop: "1px solid var(--hairline)" }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={newLabel} maxLength={TAG_MAX} onChange={(e) => { setNewLabel(e.target.value); if (newError) setNewError(""); }}
                placeholder="New tag name…" aria-label="New tag name" aria-invalid={!!newError} aria-describedby={newError ? "kanbo-tagmgr-err" : undefined}
                style={{ flex: 1, minWidth: 0, height: 34, padding: "0 11px", borderRadius: 9, border: `1px solid ${newError ? "var(--prio-urgent)" : "var(--hairline)"}`, background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5 }} />
              <button type="submit" className="btn btn-accent" disabled={!newLabel.trim()} style={{ padding: "6px 13px", fontSize: 12.5, opacity: newLabel.trim() ? 1 : 0.5 }}>
                <Icon name="plus" size={13} /> Add tag
              </button>
            </div>
            {newError && <span id="kanbo-tagmgr-err" role="alert" style={{ fontSize: 12, color: "var(--prio-urgent)" }}>{newError}</span>}
          </form>
        )}
      </div>
    </>
  );
}

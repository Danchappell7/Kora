/* ============================================================
   KANBO — tag manager: rename, recolour, merge and delete tags.
   ============================================================ */
import { useState } from "react";
import { Icon } from "./primitives";
import type { TagDef } from "../data/types";

const PALETTE = ["oklch(0.74 0.14 230)", "oklch(0.74 0.16 305)", "oklch(0.75 0.13 155)", "oklch(0.78 0.15 70)", "oklch(0.66 0.2 20)", "oklch(0.78 0.1 45)", "oklch(0.7 0.02 260)"];

export function TagManagerModal({ open, onClose, tags, taskCounts, onUpdate, onDelete, onMerge }: {
  open: boolean;
  onClose: () => void;
  tags: Record<string, TagDef>;
  taskCounts: Record<string, number>;
  onUpdate: (id: string, patch: { label?: string; color?: string }) => void;
  onDelete: (id: string) => void;
  onMerge: (fromId: string, intoId: string) => void;
}) {
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  if (!open) return null;
  const entries = Object.entries(tags).sort((a, b) => a[1].label.localeCompare(b[1].label));

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 90, background: "color-mix(in oklch, var(--bg-deep) 55%, transparent)", backdropFilter: "blur(3px)" }} />
      <div role="dialog" aria-modal="true" aria-label="Manage tags" className="glass anim-scalein" style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 91, width: 520, maxWidth: "94vw", maxHeight: "88vh", padding: 22, borderRadius: 20, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="tasks" size={17} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1, fontSize: 16, fontWeight: 600 }}>Manage tags</div>
          <button className="btn-icon" onClick={onClose} aria-label="Close" style={{ border: "none" }}><Icon name="x" size={18} /></button>
        </div>

        {entries.length === 0 ? (
          <p style={{ fontSize: 13.5, color: "var(--ink-4)", margin: "8px 0" }}>No tags yet — add tags from a task to manage them here.</p>
        ) : (
          <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            {entries.map(([id, t]) => (
              <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)" }}>
                {/* colour */}
                <div style={{ position: "relative", display: "inline-flex" }}>
                  <span style={{ width: 14, height: 14, borderRadius: 4, background: t.color, flexShrink: 0 }} />
                  <select value="" onChange={(e) => { if (e.target.value) onUpdate(id, { color: e.target.value }); }} aria-label="Tag colour"
                    style={{ position: "absolute", inset: 0, opacity: 0, width: 14, cursor: "pointer" }}>
                    <option value="">colour</option>
                    {PALETTE.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", gap: 3 }}>
                  {PALETTE.map((c) => <button key={c} onClick={() => onUpdate(id, { color: c })} aria-label="Set colour" style={{ width: 15, height: 15, borderRadius: 4, background: c, border: t.color === c ? "2px solid var(--ink)" : "1px solid var(--hairline)", cursor: "pointer", padding: 0 }} />)}
                </div>
                {/* label */}
                <input defaultValue={t.label} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.label) onUpdate(id, { label: v }); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} aria-label="Tag name"
                  style={{ flex: 1, minWidth: 80, height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface-2)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, outline: "none" }} />
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)", width: 48, textAlign: "right" }}>{taskCounts[id] || 0} task{(taskCounts[id] || 0) === 1 ? "" : "s"}</span>
                {/* merge */}
                {mergeFrom === id ? (
                  <select autoFocus value="" onChange={(e) => { if (e.target.value) { onMerge(id, e.target.value); setMergeFrom(null); } else setMergeFrom(null); }} onBlur={() => setMergeFrom(null)} aria-label="Merge into"
                    style={{ height: 30, borderRadius: 8, border: "1px solid var(--accent)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12.5, outline: "none" }}>
                    <option value="">merge into…</option>
                    {entries.filter(([oid]) => oid !== id).map(([oid, ot]) => <option key={oid} value={oid}>{ot.label}</option>)}
                  </select>
                ) : (
                  <button onClick={() => setMergeFrom(id)} title="Merge into another tag" disabled={entries.length < 2} className="btn-icon" style={{ border: "none", width: 28, height: 28, color: "var(--ink-4)", opacity: entries.length < 2 ? 0.4 : 1 }}><Icon name="layers" size={15} /></button>
                )}
                <button onClick={() => { if (window.confirm(`Delete tag "${t.label}"? It's removed from all tasks.`)) onDelete(id); }} title="Delete tag" className="btn-icon" style={{ border: "none", width: 28, height: 28, color: "var(--prio-urgent)" }}><Icon name="trash" size={15} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

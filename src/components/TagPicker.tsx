/* ============================================================
   KORA — tag picker with inline create + per-tag delete
   ============================================================ */
import { useState } from "react";
import { Icon } from "./primitives";
import type { TagDef } from "../data/types";

const TAG_COLORS = [
  "oklch(0.74 0.16 305)", "oklch(0.74 0.14 230)", "oklch(0.75 0.13 155)",
  "oklch(0.78 0.15 70)", "oklch(0.66 0.2 20)", "oklch(0.7 0.02 240)",
];

export function TagPicker({ tags, selected, onToggle, onCreate, onDelete, small }: {
  tags: Record<string, TagDef>;
  selected: string[];
  onToggle: (id: string) => void;
  onCreate: (label: string, color: string) => void;
  onDelete: (id: string) => void;
  small?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState(TAG_COLORS[0]);

  const create = () => {
    const v = label.trim();
    if (!v) return;
    onCreate(v, color);
    setLabel(""); setColor(TAG_COLORS[0]); setAdding(false);
  };

  const entries = Object.entries(tags);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
        {entries.map(([id, def]) => {
          const active = selected.includes(id);
          return (
            <span key={id} className="tagchip" style={{ position: "relative", display: "inline-flex" }}>
              <button onClick={() => onToggle(id)} title={active ? "Click to remove" : "Click to add"}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer",
                  fontFamily: "var(--font-mono)", fontSize: small ? 10 : 11, fontWeight: 500,
                  padding: small ? "1px 7px" : "2px 8px", borderRadius: 6,
                  color: def.color, opacity: active ? 1 : 0.4, transition: "opacity .14s",
                  border: `1px solid color-mix(in oklch, ${def.color} 30%, transparent)`,
                  background: `color-mix(in oklch, ${def.color} 12%, transparent)`,
                }}>{def.label}</button>
              <button className="tagchip-del" title="Delete tag"
                onClick={(e) => { e.stopPropagation(); onDelete(id); }}>
                <Icon name="x" size={9} sw={2.5} />
              </button>
            </span>
          );
        })}
        {!adding && (
          <button onClick={() => setAdding(true)} className="iadd" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: small ? 10 : 11, fontWeight: 500, padding: "2px 8px", borderRadius: 6, color: "var(--ink-3)", background: "var(--surface-2)", border: "1px dashed var(--hairline-strong)", cursor: "pointer" }}>
            <Icon name="plus" size={11} /> New tag
          </button>
        )}
        {entries.length === 0 && !adding && (
          <span style={{ fontSize: 12, color: "var(--ink-4)" }}>No tags yet — create one.</span>
        )}
      </div>
      {adding && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); if (e.key === "Escape") setAdding(false); }}
            placeholder="Tag name…" style={{ height: 30, padding: "0 10px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none", width: 130 }} />
          <div style={{ display: "flex", gap: 5 }}>
            {TAG_COLORS.map((c) => (
              <button key={c} onClick={() => setColor(c)} style={{ width: 20, height: 20, borderRadius: 99, cursor: "pointer", background: c, border: "none", boxShadow: color === c ? "0 0 0 2px var(--bg), 0 0 0 3.5px var(--accent)" : "none" }} />
            ))}
          </div>
          <button onClick={create} className="btn btn-accent" style={{ padding: "4px 11px", fontSize: 12 }}>Add</button>
          <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

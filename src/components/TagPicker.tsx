/* ============================================================
   KANBO — tag picker with inline create + per-tag delete
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "./primitives";
import type { TagDef } from "../data/types";

const TAG_COLORS: { c: string; name: string }[] = [
  { c: "oklch(0.74 0.16 305)", name: "purple" }, { c: "oklch(0.74 0.14 230)", name: "blue" }, { c: "oklch(0.75 0.13 155)", name: "green" },
  { c: "oklch(0.78 0.15 70)", name: "amber" }, { c: "oklch(0.66 0.2 20)", name: "red" }, { c: "oklch(0.7 0.02 240)", name: "grey" },
];
const TAG_MAX = 40;
/** optimistic tags carry a temporary id until the server confirms them */
const isPendingTag = (id: string) => id.startsWith("tmp-");
const norm = (s: string) => s.trim().toLowerCase();

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
  const [color, setColor] = useState(TAG_COLORS[0].c);
  const [focusedChip, setFocusedChip] = useState<string | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const refocusAdd = useRef(false);
  // a tag we just asked to create: once its real (server) id shows up, select it
  const pending = useRef<{ label: string; before: Set<string>; until: number } | null>(null);

  useEffect(() => {
    if (!adding && refocusAdd.current) { refocusAdd.current = false; addBtnRef.current?.focus(); }
  }, [adding]);

  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    if (Date.now() > p.until) { pending.current = null; return; }
    const hit = Object.entries(tags).find(([id, def]) => !p.before.has(id) && !isPendingTag(id) && norm(def.label) === p.label);
    if (hit) {
      pending.current = null;
      if (!selected.includes(hit[0])) onToggle(hit[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags]);

  const close = (refocus: boolean) => {
    setLabel(""); setColor(TAG_COLORS[0].c); setAdding(false);
    refocusAdd.current = refocus;
  };

  const create = () => {
    const v = label.trim().slice(0, TAG_MAX);
    if (!v) return;
    // re-use an existing tag with the same name instead of making a look-alike
    const existing = Object.entries(tags).find(([, def]) => norm(def.label) === norm(v));
    if (existing && !isPendingTag(existing[0])) {
      if (!selected.includes(existing[0])) onToggle(existing[0]);
    } else {
      // new (or still being saved) — select it as soon as the server id arrives
      pending.current = { label: norm(v), before: new Set(Object.keys(tags)), until: Date.now() + 15000 };
      if (!existing) onCreate(v, color);
    }
    close(true);
  };

  // Escape must close ONLY the new-tag box: handled in the capture phase and
  // stopped there, so it never reaches the dialog's focus trap or the app's
  // global Escape handler (which would close the whole modal and lose the draft).
  const onBoxKeyDownCapture = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  };

  const remove = (id: string, def: TagDef) => {
    if (!window.confirm(`Delete tag “${def.label}” from every task?`)) return;
    onDelete(id);
    setFocusedChip(null);
    addBtnRef.current?.focus();
  };

  const entries = Object.entries(tags);
  const chipFont = small ? 10 : 11;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div role="group" aria-label="Tags" style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
        {entries.map(([id, def]) => {
          const active = selected.includes(id);
          const saving = isPendingTag(id);
          return (
            <span key={id} className="tagchip" style={{ position: "relative", display: "inline-flex" }}
              onFocus={() => setFocusedChip(id)}
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedChip((f) => (f === id ? null : f)); }}>
              <button type="button" onClick={() => onToggle(id)} disabled={saving} aria-pressed={active}
                aria-label={saving ? `${def.label} (saving…)` : def.label}
                title={saving ? "Saving…" : active ? "Remove tag" : "Add tag"}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5, cursor: saving ? "progress" : "pointer",
                  fontFamily: "var(--font-mono)", fontSize: chipFont, fontWeight: 500,
                  padding: small ? "1px 7px" : "2px 8px", borderRadius: 6,
                  color: def.color, opacity: active ? 1 : saving ? 0.45 : 0.55, transition: "opacity .14s",
                  border: `1px ${saving ? "dashed" : "solid"} color-mix(in oklch, ${def.color} 30%, transparent)`,
                  background: `color-mix(in oklch, ${def.color} 12%, transparent)`,
                }}>
                {active && <Icon name="check" size={small ? 9 : 10} sw={2.5} />}
                {def.label}
              </button>
              {!saving && (
                <button type="button" className="tagchip-del" aria-label={`Delete tag ${def.label}`} title={`Delete tag “${def.label}”`}
                  onClick={(e) => { e.stopPropagation(); remove(id, def); }}
                  // keyboard users: reveal the (hover-only) delete while the chip has focus
                  style={focusedChip === id ? { opacity: 1 } : undefined}>
                  <Icon name="x" size={9} sw={2.5} />
                </button>
              )}
            </span>
          );
        })}
        {!adding && (
          <button ref={addBtnRef} type="button" onClick={() => setAdding(true)} className="iadd" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: chipFont, fontWeight: 500, padding: "2px 8px", borderRadius: 6, color: "var(--ink-3)", background: "var(--surface-2)", border: "1px dashed var(--hairline-strong)", cursor: "pointer" }}>
            <Icon name="plus" size={11} /> New tag
          </button>
        )}
        {entries.length === 0 && !adding && (
          <span style={{ fontSize: 12, color: "var(--ink-4)" }}>No tags yet — create one.</span>
        )}
      </div>
      {adding && (
        <div role="group" aria-label="New tag" onKeyDownCapture={onBoxKeyDownCapture} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <input autoFocus value={label} maxLength={TAG_MAX} aria-label="New tag name"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); create(); } }}
            placeholder="Tag name…" style={{ height: 30, padding: "0 10px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13, width: 130 }} />
          <div role="group" aria-label="Tag colour" style={{ display: "flex", gap: 5 }}>
            {TAG_COLORS.map(({ c, name }) => (
              <button key={c} type="button" aria-pressed={color === c} aria-label={`Colour ${name}`} onClick={() => setColor(c)}
                style={{ width: 20, height: 20, borderRadius: 99, cursor: "pointer", background: c, border: "none", boxShadow: color === c ? "0 0 0 2px var(--bg), 0 0 0 3.5px var(--accent)" : "none" }} />
            ))}
          </div>
          <button type="button" onClick={create} disabled={!label.trim()} className="btn btn-accent" style={{ padding: "4px 11px", fontSize: 12, opacity: label.trim() ? 1 : 0.5 }}>Add</button>
          <button type="button" onClick={() => close(true)} className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

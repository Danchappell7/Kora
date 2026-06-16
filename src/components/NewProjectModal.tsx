/* ============================================================
   KANBO — create-project modal
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { Icon } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { NewProject } from "../data/store";

const EMOJI = ["📁", "🚀", "🎨", "⚙️", "📈", "🧪", "💡", "📊", "🛠️", "🌱", "🔮", "📦"];
const COLORS = [
  "oklch(0.74 0.14 230)", "oklch(0.74 0.16 305)", "oklch(0.75 0.13 155)",
  "oklch(0.78 0.15 70)", "oklch(0.66 0.2 20)", "oklch(0.78 0.1 45)",
];

export function NewProjectModal({ open, onClose, onCreate, workspaceId }: {
  open: boolean;
  onClose: () => void;
  onCreate: (p: NewProject) => void;
  workspaceId: string | null;
}) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState(EMOJI[0]);
  const [color, setColor] = useState(COLORS[0]);
  const inputRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);

  useEffect(() => {
    if (open) { setName(""); setEmoji(EMOJI[0]); setColor(COLORS[0]); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate({ name: trimmed, emoji, color, workspaceId });
    onClose();
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 110, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "14vh" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="New project" onClick={(e) => e.stopPropagation()} className="glass anim-scalein" style={{ width: 440, maxWidth: "92vw", borderRadius: 18, overflow: "hidden", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <Icon name="folder" size={18} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>New project</span>
          <button className="btn-icon" onClick={onClose} style={{ marginLeft: "auto", border: "none", width: 30, height: 30 }}><Icon name="x" size={17} /></button>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <span style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, display: "grid", placeItems: "center", fontSize: 22, background: `color-mix(in oklch, ${color} 18%, transparent)`, border: `1px solid color-mix(in oklch, ${color} 32%, transparent)` }}>{emoji}</span>
            <input ref={inputRef} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="Project name…"
              style={{ flex: 1, height: 44, padding: "0 14px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 500, outline: "none" }} />
          </div>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-4)", marginBottom: 8 }}>Icon</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {EMOJI.map((e) => (
                <button key={e} onClick={() => setEmoji(e)} style={{ width: 34, height: 34, borderRadius: 9, cursor: "pointer", fontSize: 17, background: emoji === e ? "var(--surface-2)" : "transparent", border: emoji === e ? "1px solid var(--accent)" : "1px solid var(--hairline)" }}>{e}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-4)", marginBottom: 8 }}>Color</div>
            <div style={{ display: "flex", gap: 8 }}>
              {COLORS.map((c) => (
                <button key={c} onClick={() => setColor(c)} style={{ width: 28, height: 28, borderRadius: 99, cursor: "pointer", background: c, border: "none", boxShadow: color === c ? "0 0 0 2px var(--bg), 0 0 0 4px var(--accent)" : "none" }} />
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 18px", borderTop: "1px solid var(--hairline)" }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-accent" onClick={submit} disabled={!name.trim()} style={{ opacity: name.trim() ? 1 : 0.5 }}><Icon name="plus" size={15} /> Create</button>
        </div>
      </div>
    </div>
  );
}

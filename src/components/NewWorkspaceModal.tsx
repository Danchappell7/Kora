/* ============================================================
   KORA — create-workspace modal
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { Icon } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";

export function NewWorkspaceModal({ open, onClose, onCreate }: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);

  useEffect(() => {
    if (open) { setName(""); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const v = name.trim();
    if (!v) return;
    onCreate(v);
    onClose();
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 110, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "16vh" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="New workspace" onClick={(e) => e.stopPropagation()} className="glass anim-scalein" style={{ width: 420, maxWidth: "92vw", borderRadius: 18, overflow: "hidden", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <Icon name="briefcase" size={18} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>New workspace</span>
          <button className="btn-icon" onClick={onClose} aria-label="Close" style={{ marginLeft: "auto", border: "none", width: 30, height: 30 }}><Icon name="x" size={17} /></button>
        </div>
        <div style={{ padding: 18 }}>
          <input ref={inputRef} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="Workspace name — e.g. Acme Inc"
            style={{ width: "100%", height: 44, padding: "0 14px", borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 500, outline: "none" }} />
          <p style={{ margin: "12px 0 0", fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-4)" }}>
            A workspace is a shared space for a team — invite people from the Team page and everyone sees its projects and tasks.
          </p>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 18px", borderTop: "1px solid var(--hairline)" }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-accent" onClick={submit} disabled={!name.trim()} style={{ opacity: name.trim() ? 1 : 0.5 }}><Icon name="plus" size={15} /> Create workspace</button>
        </div>
      </div>
    </div>
  );
}

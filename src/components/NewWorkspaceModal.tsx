/* ============================================================
   KANBO — create-workspace dialog (the kit's Sheet: scrim with no
   blur, 56px header, 64px footer; a bottom sheet on phones)
   ============================================================ */
import { useState, useEffect, useRef, useId } from "react";
import { Button, Sheet } from "./primitives";

const FIELD_CSS = `
.knws-field {
  width: 100%; height: var(--h-lg, 40px); padding: 0 12px; border-radius: var(--r-md, 8px);
  border: 1px solid var(--field-border); background: var(--field-bg); color: var(--ink);
  font: 500 14px/20px var(--font-ui, var(--font-display));
  transition: border-color var(--d-1, 90ms) var(--ease);
}
.knws-field::placeholder { color: var(--ink-4); }
.knws-field:hover { border-color: var(--field-border-hover); }
`;

export function NewWorkspaceModal({ open, onClose, onCreate }: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => { if (open) setName(""); }, [open]);

  const v = name.trim();
  const submit = () => {
    if (!v) return;
    onCreate(v);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} label="New workspace" title="New workspace" initialFocus={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="plus" onClick={submit} disabled={!v}>Create workspace</Button>
        </>
      }>
      <style>{FIELD_CSS}</style>
      <label htmlFor={`${id}-name`} style={{ display: "block", marginBottom: 8, font: "600 13px/20px var(--font-ui, var(--font-display))", color: "var(--ink)" }}>
        Workspace name
      </label>
      <input ref={inputRef} id={`${id}-name`} className="knws-field" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
        placeholder="e.g. Acme Inc" autoComplete="off" aria-describedby={`${id}-help`} />
      <p id={`${id}-help`} style={{ margin: "12px 0 0", font: "400 13px/20px var(--font-ui, var(--font-display))", color: "var(--ink-3)" }}>
        A shared space for a team. Invite people from Team › People, and everyone in it sees its projects and tasks.
      </p>
    </Sheet>
  );
}

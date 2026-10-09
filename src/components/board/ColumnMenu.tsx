/* ============================================================
   KANBO — a board column's options (its header's ⋯, or its count):
   the WIP limit edited in place (a number with − / + and Save; empty
   = no limit), what that means right now ("4 of 3: 1 over"), where
   it's kept (shared on a project board, this device on My tasks), and
   the column's actions (Add task, Collapse). Rendered inside the
   board's anchored dialog popover (focus trapped, Escape closes).
   ============================================================ */
import { useId, useState } from "react";
import { Button, Icon } from "../primitives";
import { parseWipLimit, wipState } from "../tasks/otherViewsLogic";

export interface ColumnMenuProps {
  column: string;
  count: number;
  limit?: number;
  /** where the limit is kept, said under the field */
  scopeNote: string;
  canEditWip: boolean;
  onSaveLimit: (n: number | null) => void;
  onClose: () => void;
  onCollapse: () => void;
  onAdd?: () => void;
}

const plural = (n: number) => `${n} card${n === 1 ? "" : "s"}`;

/** "4 of 3: 1 over the limit" — the column against a limit (the draft one while editing). */
export function wipSummary(count: number, limit: number | null | undefined): string {
  if (!limit) return `${plural(count)} now, no limit.`;
  const s = wipState(count, limit);
  if (s === "over") return `${count} of ${limit}: ${count - limit} over the limit.`;
  if (s === "at") return `${count} of ${limit}: at the limit.`;
  return `${count} of ${limit}: room for ${limit - count} more.`;
}

export function ColumnMenu({ column, count, limit, scopeNote, canEditWip, onSaveLimit, onClose, onCollapse, onAdd }: ColumnMenuProps) {
  const [draft, setDraft] = useState(limit != null ? String(limit) : "");
  const [error, setError] = useState("");
  const id = useId();
  const parsed = parseWipLimit(draft);
  const preview = parsed === "invalid" ? limit : parsed;
  const step = (d: number) => {
    const cur = typeof parsed === "number" ? parsed : 0;
    const n = Math.max(1, Math.min(999, cur + d));
    setDraft(String(n)); setError("");
  };
  const submit = () => {
    if (parsed === "invalid") { setError("Enter a whole number from 1 to 999, or leave it blank."); return; }
    onSaveLimit(parsed); onClose();
  };
  const tone = preview ? wipState(count, preview) : "ok";
  return (
    <div className="kbd-colmenu">
      {canEditWip ? (
        <form noValidate onSubmit={(e) => { e.preventDefault(); submit(); }} className="kbd-wipform">
          <label htmlFor={`${id}-wip`} className="kbd-wiplabel">WIP limit for {column}</label>
          <div className="kbd-wiprow">
            <button type="button" className="kbd-step" aria-label="One fewer" onClick={() => step(-1)} disabled={typeof parsed !== "number" || parsed <= 1}>−</button>
            <input id={`${id}-wip`} data-autofocus type="number" inputMode="numeric" min={1} max={999} value={draft} className="kdp-field kbd-wipinput"
              placeholder="None" aria-invalid={!!error} aria-describedby={`${id}-help ${id}-note`}
              onChange={(e) => { setDraft(e.target.value); setError(""); }} />
            <button type="button" className="kbd-step" aria-label="One more" onClick={() => step(1)}>+</button>
            <Button variant="primary" size="sm" type="submit">Save</Button>
          </div>
          <p id={`${id}-help`} className="kbd-wiphelp" role={error ? "alert" : undefined} data-tone={error ? "error" : tone}>
            {error || wipSummary(count, preview)}
          </p>
          <p id={`${id}-note`} className="kbd-wipnote">The count turns amber when the column holds more than this. {scopeNote}</p>
          {limit != null && (
            <Button variant="ghost" size="sm" onClick={() => { onSaveLimit(null); onClose(); }} className="kbd-wipremove">Remove limit</Button>
          )}
        </form>
      ) : (
        <p className="kbd-wipnote" style={{ padding: "6px 8px" }}>{limit ? wipSummary(count, limit) : `${plural(count)}, no WIP limit.`}</p>
      )}
      <div className="ktv-msep" role="separator" />
      {onAdd && <button type="button" className="ktv-mi" onClick={() => { onClose(); onAdd(); }}><Icon name="plus" size={16} /> Add task to {column}</button>}
      <button type="button" className="ktv-mi" onClick={() => { onClose(); onCollapse(); }}><Icon name="chevronLeft" size={16} /> Collapse column</button>
    </div>
  );
}

/* ============================================================
   KANBO — "Start from a template" (New task's Template button).  [u9]
   A popover with a search field and the same list the "/" picker
   shows (TemplatePicker, bound to this field): type to narrow it,
   ↑/↓ and Enter, or click; "Browse all templates" opens the library.
   ============================================================ */
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Button, Icon } from "../primitives";
import { Popover } from "../primitives/Popover";
import type { LibraryTemplate } from "../../data/types";
import { TemplatePicker } from "./TemplatePicker";
import { safeId } from "./parts";
import "./templates.css";

export interface TemplateChooserProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  templates: readonly LibraryTemplate[];
  loading?: boolean;
  currentUserId?: string;
  onPick: (template: LibraryTemplate) => void;
  /** "Browse all templates" (the library); hidden without it */
  onBrowse?: () => void;
}

export function TemplateChooser({ open, anchorRef, onClose, templates, loading, currentUserId, onPick, onBrowse }: TemplateChooserProps) {
  const inputId = `ktpl-choose-${safeId(useId())}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => { if (open) setQuery(""); }, [open]);
  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} role="dialog" label="Start from a template" minWidth={340} maxHeight={460}
      initialFocus={inputRef} className="ktpl-chooser">
      <label className="ktpl-search ktpl-chooser-search">
        <Icon name="search" size={16} sw={1.75} />
        <span className="sr-only">Find a template</span>
        <input ref={inputRef} id={inputId} type="text" className="kfield" value={query} placeholder="Find a template" autoComplete="off"
          onChange={(e) => setQuery(e.target.value)} />
      </label>
      {open && (
        <TemplatePicker query={query} templates={templates} inputId={inputId} loading={loading} currentUserId={currentUserId}
          onPick={(t) => { onClose(); onPick(t); }} onClose={onClose} />
      )}
      {onBrowse && (
        <div className="ktpl-chooser-foot">
          <Button size="sm" variant="ghost" icon="layers" onClick={() => { onClose(); onBrowse(); }}>Browse all templates</Button>
        </div>
      )}
    </Popover>
  );
}

/* ============================================================
   KANBO — the "/" template picker.                             [u9]
   A listbox under the QuickCapture / NewTaskModal title field while the
   text starts with "/" or "/template": fuzzy matches (lib/templates
   matchTemplates), ↑/↓ to move, Enter to apply, Escape to close (the
   text stays). aria-activedescendant on the input; announced count.

   It belongs to its input (`inputId`): while it's showing it listens to
   that field's keys itself — ahead of the host's own Enter-to-create and
   the dialog's Escape — and sets the field's aria-controls,
   aria-autocomplete and aria-activedescendant (taking them off again
   when it goes). Focus never leaves the field; the pointer works too
   (a press on an option doesn't blur the field).
   ============================================================ */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "../primitives";
import { matchTemplates, templateMeta } from "../../lib/templatePlan";
import type { LibraryTemplate } from "../../data/types";
import { KIND_LABEL, TemplateTile, safeId, templateKind } from "./parts";
import "./templates.css";

export interface TemplatePickerProps {
  /** the text after "/" (or "/template ") */
  query: string;
  templates: readonly LibraryTemplate[];
  /** the input it belongs to (for aria-controls / activedescendant) */
  inputId: string;
  onPick: (template: LibraryTemplate) => void;
  onClose: () => void;
  /** the library is still loading (says so instead of "no templates") */
  loading?: boolean;
  /** whose templates are "Yours" (the label beside each option) */
  currentUserId?: string;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function TemplatePicker({ query, templates, inputId, onPick, onClose, loading, currentUserId = "" }: TemplatePickerProps) {
  const uid = safeId(useId());
  const listId = `ktpl-pick-${uid}`;
  const optionId = (i: number) => `${listId}-o${i}`;
  const matches = useMemo(() => matchTemplates(query, templates), [query, templates]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  // a new query (or list) starts at the best match
  useEffect(() => { setActive(0); }, [query, templates]);
  const current = matches.length ? Math.min(active, matches.length - 1) : -1;

  // the latest of everything the key handler needs (it's attached once)
  const latest = useRef({ matches, current, onPick, onClose });
  latest.current = { matches, current, onPick, onClose };

  useLayoutEffect(() => {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", listId);
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const { matches: m, current: c } = latest.current;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!m.length) return;
        e.preventDefault(); e.stopPropagation();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive(((c < 0 ? 0 : c) + step + m.length) % m.length);
      } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (c < 0) return; // nothing to pick: Enter does what it always does
        e.preventDefault(); e.stopPropagation();
        latest.current.onPick(m[c]);
      } else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        latest.current.onClose();
      }
    };
    input.addEventListener("keydown", onKey);
    return () => {
      input.removeEventListener("keydown", onKey);
      input.removeAttribute("aria-autocomplete");
      input.removeAttribute("aria-controls");
      input.removeAttribute("aria-activedescendant");
    };
  }, [inputId, listId]);

  useLayoutEffect(() => {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (current >= 0) input.setAttribute("aria-activedescendant", optionId(current));
    else input.removeAttribute("aria-activedescendant");
    const el = current >= 0 ? listRef.current?.children[current] as HTMLElement | undefined : undefined;
    el?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, inputId, matches]);

  const q = query.trim();
  const announce = loading && !templates.length
    ? "Loading templates…"
    : matches.length
      ? `${plural(matches.length, "template")}${q ? ` match “${q}”` : ""}. Up and down to choose, Enter to use, Escape to close.`
      : q ? `No templates match “${q}”.` : "No templates yet.";

  return (
    <div className="ktpl-pick">
      <ul ref={listRef} id={listId} role="listbox" aria-label="Templates" className="ktpl-pick-list">
        {matches.map((t, i) => {
          const kind = templateKind(t, currentUserId);
          return (
            <li key={t.id} id={optionId(i)} role="option" aria-selected={i === current} className="ktpl-pick-opt"
              onMouseDown={(e) => e.preventDefault()} onMouseMove={() => { if (i !== current) setActive(i); }}
              onClick={() => onPick(t)}>
              <TemplateTile template={t} size={20} />
              <span className="ktpl-pick-text">
                <span className="ktpl-pick-name">{t.name}</span>
                <span className="ktpl-pick-meta">{templateMeta(t.body)}</span>
              </span>
              {kind !== "yours" && <span className="ktpl-pick-kind">{KIND_LABEL[kind]}</span>}
            </li>
          );
        })}
      </ul>
      {!matches.length && (
        <p className="ktpl-pick-empty">
          {loading && !templates.length ? "Loading templates…" : q ? <>No templates match “{q}”.</> : "No templates yet."}
        </p>
      )}
      <p className="ktpl-pick-foot" aria-hidden="true">
        <span><Kbd>↑</Kbd><Kbd>↓</Kbd> choose</span>
        <span><Kbd>↵</Kbd> use</span>
        <span><Kbd>esc</Kbd> close</span>
      </p>
      <p className="sr-only" aria-live="polite">{announce}</p>
    </div>
  );
}

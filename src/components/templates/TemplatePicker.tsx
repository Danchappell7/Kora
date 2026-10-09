/* ============================================================
   KANBO — the "/" template picker.                      [0048 stub → u9]
   A listbox under the QuickCapture / NewTaskModal title field while the
   text starts with "/" or "/template": fuzzy matches (lib/templates
   matchTemplates), ↑/↓ to move, Enter to apply, Escape to close (the
   text stays). aria-activedescendant on the input; announced count.
   Renders nothing until package u9 builds it.
   ============================================================ */
import type { LibraryTemplate } from "../../data/types";

export interface TemplatePickerProps {
  /** the text after "/" (or "/template ") */
  query: string;
  templates: readonly LibraryTemplate[];
  /** the input it belongs to (for aria-controls / activedescendant) */
  inputId: string;
  onPick: (template: LibraryTemplate) => void;
  onClose: () => void;
}

export function TemplatePicker(_props: TemplatePickerProps) {
  return null;
}

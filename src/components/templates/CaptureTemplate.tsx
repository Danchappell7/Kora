/* ============================================================
   KANBO — "/" for a template in the small capture fields.       [0048]
   Today's capture field and the phone's quick add take a template the
   way Quick capture does: "/" (or "/template") opens the picker under
   the field (TemplatePicker: ↑/↓, Enter, Escape; focus stays in the
   field), choosing one puts its title in the field with its first
   {placeholder} selected, and a strip says what it adds, with Remove.
   The host makes the task from it (lib/templatePlan
   captureTemplatePlan): what was typed wins, the template fills the
   rest, and its sub-tasks and checklist come too.
   Today loads this through ./lazyCapture, so it's never in the first
   download; the quick add sheet (a chunk of its own) imports it.
   ============================================================ */
import type { LibraryTemplate } from "../../data/types";
import { templatePlaceholders, templateQueryOf } from "../../lib/templatePlan";
import { TemplatePicker } from "./TemplatePicker";
import { TemplateTile } from "./parts";
import { useLibraryTemplates } from "./useLibraryTemplates";
import "./templates.css";

export interface CaptureTemplatePickerProps {
  /** the field's text: the picker shows while it starts with "/" */
  text: string;
  /** the field's id (the picker drives its aria-activedescendant and listens to its keys) */
  inputId: string;
  /** whose library: the workspace the capture is in (null = Personal) */
  workspaceId: string | null;
  /** whose templates are "Yours" */
  currentUserId?: string;
  /** a template was chosen: put its title in the field and select `select` (its first placeholder, else the end) */
  onPick: (template: LibraryTemplate, select: [number, number]) => void;
  /** Escape: the picker steps aside (the text stays) */
  onClose: () => void;
}

export function CaptureTemplatePicker({ text, inputId, workspaceId, currentUserId, onPick, onClose }: CaptureTemplatePickerProps) {
  const lib = useLibraryTemplates(workspaceId, true);
  const query = templateQueryOf(text);
  if (query === null) return null;
  return (
    <TemplatePicker query={query} templates={lib.templates} inputId={inputId} loading={lib.status !== "ready" && lib.status !== "error"}
      currentUserId={currentUserId || lib.viewerId || ""} onClose={onClose}
      onPick={(t) => {
        const title = t.body.title, ph = templatePlaceholders(title)[0];
        onPick(t, ph ? [ph.start, ph.end] : [title.length, title.length]);
      }} />
  );
}

export interface CaptureTemplateStripProps {
  template: Pick<LibraryTemplate, "id" | "name" | "emoji" | "body">;
  /** Remove: back to a plain task (the host clears the title if it's still the template's) */
  onRemove: () => void;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

/** What the chosen template adds: "From “Bug report” + 3 sub-tasks · 2 checklist items", and Remove. */
export function CaptureTemplateStrip({ template, onRemove }: CaptureTemplateStripProps) {
  const subs = template.body.subtasks?.length ?? 0, checks = template.body.checklist?.length ?? 0;
  const meta = [subs ? `+ ${plural(subs, "sub-task")}` : "", checks ? plural(checks, "checklist item") : ""].filter(Boolean).join(" · ");
  return (
    <div className="ktpl-applied ktpl-applied-cap" role="group" aria-label={`Template: ${template.name}`}>
      <TemplateTile template={template} size={20} />
      <span className="ktpl-applied-text">
        <span className="ktpl-applied-name">From “{template.name}”</span>
        {meta && <span className="ktpl-applied-meta">{meta}</span>}
      </span>
      {/* (a press doesn't take focus from the field, so the keyboard stays up on a phone) */}
      <button type="button" className="ktpl-applied-x" onMouseDown={(e) => e.preventDefault()} onClick={onRemove}
        aria-label={`Remove template “${template.name}”`}>Remove</button>
    </div>
  );
}

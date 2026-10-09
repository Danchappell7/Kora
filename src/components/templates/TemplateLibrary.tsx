/* ============================================================
   KANBO — the template library.                          [0048 stub → u9]
   A sheet: search, filter (All · Mine · Shared · Built-in), a grid of
   template cards (emoji, name, "3 sub-tasks · 2 days"), preview pane
   (title, description, sub-tasks with their offsets and roles,
   checklist), Use template, Edit (your own; owners/admins for shared),
   Share with the workspace (writers), Duplicate, Delete (confirm + Undo).
   "New template" opens the editor. Built-ins can be duplicated, not
   edited. Data: lib/templates (listLibraryTemplates…). Demo: works with
   fake data. Keyboard and screen-reader complete.
   Renders nothing until package u9 builds it.
   ============================================================ */
import type { LibraryTemplate } from "../../data/types";

export interface TemplateLibraryProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string | null;
  workspaceName?: string;
  currentUserId: string;
  /** writers in a team workspace */
  canShare: boolean;
  /** owners/admins: may edit / delete shared templates they didn't make */
  canManageShared?: boolean;
  /** "Use template": the host applies it (lib/templates planTemplate → its create paths) */
  onApply: (template: LibraryTemplate) => void;
}

export function TemplateLibrary(_props: TemplateLibraryProps) {
  return null;
}

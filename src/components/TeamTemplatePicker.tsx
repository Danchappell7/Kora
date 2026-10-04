/* ============================================================
   KANBO — team template gallery.                          [f10-templates-plans]
   Cards for lib/templates WORKSPACE_TEMPLATES, each with a cover / tile
   preview of its projects (ProjectCover / ProjectTile from the
   primitives), the projects and task counts, and "Start with this";
   plus "Start empty". Inline content (no Sheet of its own): the host
   puts it in a step of NewWorkspaceModal ("workspace") or in Projects ›
   New project › "From a team template" ("project").
   CONTRACT STUB — f10 replaces the body, keeps the name and props.
   ============================================================ */
import type { WorkspaceTemplate } from "../data/types";

export interface TeamTemplatePickerProps {
  /** "workspace": set up a new workspace; "project": add a template's projects to the current one */
  mode: "workspace" | "project";
  /** chosen; `projectKeys` = the template's projects to create (omitted = all) */
  onPick: (template: WorkspaceTemplate, projectKeys?: string[]) => void;
  /** "Start empty" (omit to hide the button) */
  onStartEmpty?: () => void;
  /** applying: buttons show progress and are disabled */
  busy?: boolean;
}

export function TeamTemplatePicker(props: TeamTemplatePickerProps) {
  void props;
  return null;
}

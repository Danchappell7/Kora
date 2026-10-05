/* ============================================================
   KANBO — team template gallery.                          [f10-templates-plans]
   Cards for lib/templates WORKSPACE_TEMPLATES: the template's cover with
   its tile, a sentence on what it's for, its projects (each a tile, a
   name and its starter-task count, ticked to include), what it sets up,
   and "Start with this"; plus "Start empty". Inline content (no Sheet of
   its own): the host puts it in a step of NewWorkspaceModal ("workspace")
   or in Projects › New project › "From a team template" ("project").
   ============================================================ */
import { useEffect, useId, useMemo, useState } from "react";
import { Button, ProjectCover, ProjectTile, spectrumColor } from "./primitives";
import { WORKSPACE_TEMPLATES, templateStats } from "../lib/templates";
import type { TemplateProject, WorkspaceTemplate } from "../data/types";
import "./teamTemplates.css";

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

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** "3 projects · 21 tasks" (each project's request form and rule are named on its row) */
export function templateSummaryLine(template: Pick<WorkspaceTemplate, "projects">, keys?: readonly string[]): string {
  const s = templateStats(template, keys);
  return `${plural(s.projects, "project")} · ${plural(s.tasks, "task")}`;
}

/** "Request form and a rule" under a project's name, when it comes with either. */
function extrasOf(p: TemplateProject): string {
  if (p.form && p.rule) return "Request form and a rule";
  if (p.form) return "Request form";
  if (p.rule) return `Rule: ${p.rule.name.charAt(0).toLowerCase()}${p.rule.name.slice(1)}`;
  return "";
}

/** The template itself, as a project-shaped thing its cover and tile can wear. */
const asProject = (t: WorkspaceTemplate) => ({ id: "tpl-" + t.id, name: t.name, emoji: t.emoji, color: spectrumColor(t.hue) });

export function TeamTemplatePicker({ mode, onPick, onStartEmpty, busy = false }: TeamTemplatePickerProps) {
  const uid = useId();
  // which projects each card will set up (all, until someone unticks one)
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  // the card whose "Start with this" was pressed, while the host applies it
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => { if (!busy) setPicked(null); }, [busy]);

  const keysOf = (t: WorkspaceTemplate) => chosen[t.id] ?? t.projects.map((p) => p.key);
  const toggle = (t: WorkspaceTemplate, key: string, on: boolean) => {
    const cur = keysOf(t);
    // kept in the template's order, whatever order they're ticked in
    const next = t.projects.map((p) => p.key).filter((k) => (k === key ? on : cur.includes(k)));
    setChosen((c) => ({ ...c, [t.id]: next }));
  };
  const start = (t: WorkspaceTemplate) => {
    if (busy) return;
    const keys = keysOf(t);
    if (!keys.length) return;
    setPicked(t.id);
    onPick(t, keys.length === t.projects.length ? undefined : keys);
  };
  const pickedName = useMemo(() => WORKSPACE_TEMPLATES.find((t) => t.id === picked)?.name, [picked]);

  return (
    <div className="ktt" data-mode={mode} aria-busy={busy || undefined}>
      <ul className="ktt-grid" aria-label="Team templates">
        {WORKSPACE_TEMPLATES.map((t) => {
          const keys = keysOf(t);
          const none = keys.length === 0;
          const nameId = `${uid}-${t.id}-name`, metaId = `${uid}-${t.id}-meta`;
          const loading = busy && picked === t.id;
          return (
            <li key={t.id} className="ktt-card" data-picked={loading || undefined}>
              <ProjectCover project={asProject(t)} size="card" height={64} tile={44} surface="surface" />
              <div className="ktt-body">
                <h3 className="ktt-name" id={nameId}>{t.name}</h3>
                <p className="ktt-summary">{t.summary}</p>
                <fieldset className="ktt-projects" disabled={busy}>
                  <legend className="sr-only">Projects to {mode === "workspace" ? "set up" : "add"} from {t.name}</legend>
                  {t.projects.map((p) => {
                    const on = keys.includes(p.key);
                    const extra = extrasOf(p);
                    return (
                      <label key={p.key} className="ktt-proj" data-off={on ? undefined : "true"}>
                        <input type="checkbox" checked={on} onChange={(e) => toggle(t, p.key, e.target.checked)} />
                        <ProjectTile project={{ id: `tpl-${t.id}-${p.key}`, name: p.name, emoji: p.emoji, color: spectrumColor(p.hue) }} size={20} />
                        <span className="ktt-proj-text">
                          <span className="ktt-proj-name">{p.name}</span>
                          {extra && <span className="ktt-proj-extra"><span className="sr-only">, </span>{extra}</span>}
                        </span>
                        <span className="ktt-proj-meta">{p.tasks.length}<span className="sr-only"> {p.tasks.length === 1 ? "task" : "tasks"}</span></span>
                      </label>
                    );
                  })}
                </fieldset>
                <div className="ktt-foot">
                  <span className="ktt-meta" id={metaId} data-warn={none || undefined}>
                    {none ? "Tick at least one project" : templateSummaryLine(t, keys)}
                  </span>
                  <Button size="sm" variant="secondary" loading={loading} disabled={(busy && !loading) || none}
                    aria-describedby={`${nameId} ${metaId}`} onClick={() => start(t)}>
                    {loading ? "Setting up…" : "Start with this"}
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {onStartEmpty && (
        <div className="ktt-empty">
          <p className="ktt-empty-text">
            {mode === "workspace" ? "Rather set it up yourself? Start with no projects and add your own." : "Rather set it up yourself? Start with one blank project."}
          </p>
          <Button size="sm" variant="ghost" icon="plus" disabled={busy} onClick={() => { if (!busy) onStartEmpty(); }}>Start empty</Button>
        </div>
      )}

      <p className="ktt-note">
        Starter tasks are assigned to you, with due dates counted from today. Rename, move or delete anything afterwards.
      </p>
      <p className="sr-only" role="status">{busy && pickedName ? `Setting up ${pickedName}…` : ""}</p>
    </div>
  );
}

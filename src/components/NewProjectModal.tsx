/* ============================================================
   KANBO — create-project dialog. "From a team template" swaps the
   sheet for the team template gallery (TeamTemplatePicker): a
   template's projects, each with sections, starter tasks, a request
   form and a rule, added to this workspace. Back returns to the form.
   "Plan it with Kanbo" hands over to the AI project planner (App).
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { Button, Sheet, spectrumColor } from "./primitives";
import { getProjectTemplates, storeProjectTemplate, type ProjectTemplate } from "../lib/templates";
import { TeamTemplatePicker } from "./TeamTemplatePicker";
import { IdentityFields, IdentityPreview, freshSpectrum } from "./project/IdentityPicker";
import type { NewProject } from "../data/store";
import type { Project, WorkspaceTemplate } from "../data/types";
import "./project/projects.css";

export function NewProjectModal({ open, onClose, onCreate, workspaceId, projects, onApplyTemplate, onPlanWithKanbo }: {
  open: boolean;
  onClose: () => void;
  /** templateId: the template it was started from, if any — a built-in one
   *  carries sections and starter tasks for the caller to create */
  onCreate: (p: NewProject & { templateId?: string }) => void;
  workspaceId: string | null;
  /** the workspace's projects: a new one starts in a hue none of them wears yet */
  projects?: Pick<Project, "id" | "color">[];
  /** "From a team template" (omit to hide it): adds the template's projects (all, or
   *  `keys`); the sheet shows progress until it resolves, then closes */
  onApplyTemplate?: (template: WorkspaceTemplate, keys?: string[]) => Promise<void>;
  /** "Plan it with Kanbo" (omit to hide it): this sheet closes and the planner opens, with the name typed so far as its goal */
  onPlanWithKanbo?: (typedName: string) => void;
}) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [color, setColor] = useState(() => spectrumColor(freshSpectrum(projects)));
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  // "Save as template" answers in place: saved, or this device's storage refused it
  const [saved, setSaved] = useState<null | "saved" | "failed">(null);
  const [mode, setMode] = useState<"blank" | "team">("blank");
  const [applying, setApplying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const teamRef = useRef<HTMLDivElement>(null);
  const teamButtonRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // every opening starts on the form (reset while rendering, so the gallery never flashes)
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) { setWasOpen(open); if (open) { setMode("blank"); setApplying(false); } }

  useEffect(() => {
    if (!open) return;
    setName(""); setEmoji(""); setColor(spectrumColor(freshSpectrum(projects))); setTemplateId(""); setSaved(null); setTemplates(getProjectTemplates());
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(null), saved === "failed" ? 4000 : 1500);
    return () => window.clearTimeout(t);
  }, [saved]);

  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed) return;
    onCreate({ name: trimmed, emoji, color, workspaceId, templateId: templateId || undefined });
    onClose();
  };
  const builtins = templates.filter((t) => t.id.startsWith("builtin-"));
  const mine = templates.filter((t) => !t.id.startsWith("builtin-"));

  // switching between the form and the gallery keeps focus inside the sheet
  const switchTo = (to: "blank" | "team") => {
    setMode(to);
    window.setTimeout(() => (to === "team" ? teamRef.current : teamButtonRef.current ?? inputRef.current)?.focus({ preventScroll: true }), 30);
  };

  const applyTeam = async (template: WorkspaceTemplate, keys?: string[]) => {
    if (!onApplyTemplate || applying) return;
    setApplying(true);
    try { await onApplyTemplate(template, keys); }
    finally { if (alive.current) setApplying(false); }
    onClose();
  };

  if (mode === "team" && onApplyTemplate) {
    return (
      <Sheet open={open} onClose={onClose} label="From a team template" title="From a team template" width={720}
        footer={<Button variant="ghost" icon="arrowLeft" onClick={() => switchTo("blank")} disabled={applying}>Back</Button>}>
        <div ref={teamRef} tabIndex={-1} className="kpj-team-step" aria-label="Team templates for this workspace">
          <TeamTemplatePicker mode="project" busy={applying} onPick={(t, keys) => { void applyTeam(t, keys); }} onStartEmpty={() => switchTo("blank")} />
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} label="New project" title="New project" width={480} initialFocus={inputRef}
      footer={(
        <>
          <Button variant="ghost" icon={saved === "saved" ? "check" : saved === "failed" ? "refresh" : "layers"} disabled={!trimmed} style={{ marginRight: "auto" }}
            onClick={() => { if (trimmed) setSaved(storeProjectTemplate({ name: trimmed, emoji, color }) ? "saved" : "failed"); }}>
            {saved === "saved" ? "Saved as a template" : saved === "failed" ? "Couldn't save: try again" : "Save as template"}
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="plus" onClick={submit} disabled={!trimmed}>Create</Button>
        </>
      )}>
      <div className="kpj-dialog">
        {(onApplyTemplate || onPlanWithKanbo) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignSelf: "flex-start" }}>
            {onApplyTemplate && (
              <Button ref={teamButtonRef} variant="ghost" size="sm" icon="layers" onClick={() => switchTo("team")}>
                From a team template
              </Button>
            )}
            {onPlanWithKanbo && (
              <Button variant="ghost" size="sm" icon="kanbo" onClick={() => { const typed = trimmed; onClose(); onPlanWithKanbo(typed); }}>
                Plan it with Kanbo
              </Button>
            )}
          </div>
        )}
        {templates.length > 0 && (
          <select className="kpj-field" value={templateId} aria-label="Start from template"
            onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); setTemplateId(t ? t.id : ""); if (t) { setName(t.name); setEmoji(t.emoji); setColor(t.color); } }}>
            <option value="">Start from template…</option>
            <optgroup label="Kanbo templates">{builtins.map((t) => <option key={t.id} value={t.id}>{t.emoji} {t.name}</option>)}</optgroup>
            {mine.length > 0 && <optgroup label="Your templates">{mine.map((t) => <option key={t.id} value={t.id}>{t.emoji} {t.name}</option>)}</optgroup>}
          </select>
        )}
        <IdentityPreview name={name} emoji={emoji} color={color}>
          <input ref={inputRef} className="kpj-field" data-size="lg" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
            placeholder="Project name" aria-label="Project name" />
        </IdentityPreview>
        <IdentityFields name={name} emoji={emoji} color={color} onEmoji={setEmoji} onColor={setColor} />
      </div>
    </Sheet>
  );
}

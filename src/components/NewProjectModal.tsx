/* ============================================================
   KANBO — create-project dialog
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { Button, Sheet, spectrumColor } from "./primitives";
import { getProjectTemplates, storeProjectTemplate, type ProjectTemplate } from "../lib/templates";
import { IdentityFields, IdentityPreview, freshSpectrum } from "./project/IdentityPicker";
import type { NewProject } from "../data/store";
import type { Project } from "../data/types";
import "./project/projects.css";

export function NewProjectModal({ open, onClose, onCreate, workspaceId, projects }: {
  open: boolean;
  onClose: () => void;
  /** templateId: the template it was started from, if any — a built-in one
   *  carries sections and starter tasks for the caller to create */
  onCreate: (p: NewProject & { templateId?: string }) => void;
  workspaceId: string | null;
  /** the workspace's projects: a new one starts in a hue none of them wears yet */
  projects?: Pick<Project, "id" | "color">[];
}) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [color, setColor] = useState(() => spectrumColor(freshSpectrum(projects)));
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  // "Save as template" answers in place: saved, or this device's storage refused it
  const [saved, setSaved] = useState<null | "saved" | "failed">(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

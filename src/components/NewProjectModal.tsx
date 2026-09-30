/* ============================================================
   KANBO — create-project dialog
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { Button, EmojiPicker, Sheet, projectPaint } from "./primitives";
import { getProjectTemplates, saveProjectTemplate, type ProjectTemplate } from "../lib/templates";
import { PROJECT_COLOURS } from "./project/ProjectHeader";
import type { NewProject } from "../data/store";
import "./project/projects.css";

const EMOJI = ["📁", "🚀", "🎨", "⚙️", "📈", "🧪", "💡", "📊", "🛠️", "🌱", "🔮", "📦"];
const COLORS = PROJECT_COLOURS.map((c) => c.value);

export function NewProjectModal({ open, onClose, onCreate, workspaceId }: {
  open: boolean;
  onClose: () => void;
  /** templateId: the template it was started from, if any — a built-in one
   *  carries sections and starter tasks for the caller to create */
  onCreate: (p: NewProject & { templateId?: string }) => void;
  workspaceId: string | null;
}) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState(EMOJI[0]);
  const [color, setColor] = useState(COLORS[0]);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [saved, setSaved] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(""); setEmoji(EMOJI[0]); setColor(COLORS[0]); setTemplateId(""); setSaved(false); setPickerOpen(false); setTemplates(getProjectTemplates());
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(false), 1500);
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
          <Button variant="ghost" icon={saved ? "check" : "layers"} disabled={!trimmed} style={{ marginRight: "auto" }}
            onClick={() => { if (trimmed) { saveProjectTemplate({ name: trimmed, emoji, color }); setSaved(true); } }}>
            {saved ? "Saved as a template" : "Save as template"}
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
        <div className="kpj-np-name">
          <span className="kpj-np-tile" aria-hidden="true" style={{ boxShadow: `inset 0 0 0 1px ${projectPaint(color).edge}`, background: projectPaint(color).tint }}>{emoji}</span>
          <input ref={inputRef} className="kpj-field" data-size="lg" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
            placeholder="Project name" aria-label="Project name" />
        </div>
        <div>
          <p className="kpj-dialog-label" id="kpj-np-icon">Icon</p>
          <div className="kpj-np-emoji" role="group" aria-labelledby="kpj-np-icon">
            {EMOJI.map((e) => (
              <button key={e} type="button" className="kpj-np-emoji-btn" aria-pressed={emoji === e} onClick={() => setEmoji(e)}>{e}</button>
            ))}
            <button type="button" className="kpj-np-emoji-btn" aria-expanded={pickerOpen} aria-label="More icons" title="More icons"
              aria-pressed={!EMOJI.includes(emoji) || undefined} onClick={() => setPickerOpen((v) => !v)}>{EMOJI.includes(emoji) ? "＋" : emoji}</button>
          </div>
          {pickerOpen && <div style={{ marginTop: 8 }}><EmojiPicker onPick={(e) => { setEmoji(e); setPickerOpen(false); }} /></div>}
        </div>
        <div>
          <p className="kpj-dialog-label" id="kpj-np-colour">Colour</p>
          <div className="kpj-swatches" role="group" aria-labelledby="kpj-np-colour">
            {PROJECT_COLOURS.map((c) => (
              <button key={c.value} type="button" className="kpj-swatch" aria-label={c.name} title={c.name} aria-pressed={color === c.value}
                style={{ background: projectPaint(c.value).solid }} onClick={() => setColor(c.value)} />
            ))}
            {!COLORS.includes(color) && (
              <span className="kpj-swatch" role="img" aria-label="The template's colour" style={{ background: projectPaint(color).solid, boxShadow: "0 0 0 2px var(--bg), 0 0 0 4px var(--ink-2)" }} />
            )}
          </div>
        </div>
      </div>
    </Sheet>
  );
}

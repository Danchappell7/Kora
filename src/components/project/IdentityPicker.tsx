/* ============================================================
   KANBO — a project's identity: its icon and its colour.
   IdentityFields is the pair of pickers (a curated grid of work
   emoji, or any emoji typed in, or the name's initial; and the
   twelve spectrum hues as a named, arrow-key radio group), used by
   New project. IdentityPreview is the live cover-and-tile the
   choice paints. EditIdentitySheet is "Edit identity" from a
   project's ⋯ menu. Nothing is migrated: the colour is stored in
   `project.color` as the spectrum fill (spectrumColor), the icon
   in `project.emoji`.
   ============================================================ */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button, ProjectCover, Sheet, SPECTRUM, projectIdentity, projectSpectrum, spectrumColor, type SpectrumKey } from "../primitives";
import { firstGrapheme, projectGlyph } from "../../lib/projectIdentity";
import type { Project } from "../../data/types";
import "./projects.css";

/** Forty-seven icons for work (with the initial, four rows of twelve): making,
 *  planning, money and people, energy. */
export const WORK_EMOJI: readonly string[] = [
  "📁", "🚀", "🎨", "⚙️", "📈", "🧪", "💡", "📊", "🛠️", "🌱", "🔮",
  "📦", "🎯", "🏆", "🏁", "💼", "🧩", "📐", "📋", "📝", "🗂️", "📅", "🧭",
  "🗺️", "💰", "📣", "💬", "🤝", "👥", "🎓", "🏠", "🏗️", "🖥️", "📱", "🔒",
  "🔥", "⚡", "⭐", "✨", "🌍", "✈️", "🎬", "🎧", "📷", "🧠", "❤️", "☕",
];

/** The spectrum hue a new project should wear: the first one no project here wears yet
 *  (so a workspace's projects stay distinct), else the least worn. */
export function freshSpectrum(projects: Pick<Project, "id" | "color">[] = []): SpectrumKey {
  const worn = new Map<SpectrumKey, number>();
  for (const p of projects) { const k = projectSpectrum(p).key; worn.set(k, (worn.get(k) ?? 0) + 1); }
  let best = SPECTRUM[0].key, n = Infinity;
  for (const s of SPECTRUM) { const c = worn.get(s.key) ?? 0; if (c < n) { best = s.key; n = c; } }
  return best;
}

/** The live cover and tile a choice paints, with the name beside the tile. */
export function IdentityPreview({ name, emoji, color, children }: { name: string; emoji: string; color: string; children?: React.ReactNode }) {
  const project = { id: "preview", name: name.trim() || "New project", emoji, color };
  return (
    <div className="kpj-idp">
      <ProjectCover project={project} size="card" height={72} tile={44} surface="raised" radius={12} tileInset={16} />
      <div className="kpj-idp-side">{children}</div>
    </div>
  );
}

/** The icon and colour pickers. `name` gives the initial offered when there's no emoji. */
export function IdentityFields({ name, emoji, color, onEmoji, onColor }: {
  name: string;
  emoji: string;
  color: string;
  onEmoji: (emoji: string) => void;
  onColor: (color: string) => void;
}) {
  const ids = useId();
  const custom = !!emoji && !WORK_EMOJI.includes(emoji);
  const initial = projectGlyph({ name }).text || "A";
  const current = projectSpectrum({ id: "picker", color }).key;
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // arrow keys move through the hues and choose as they go, like any radio group
  const onSwatchKey = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = SPECTRUM.length - 1;
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i === last ? 0 : i + 1)
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i === 0 ? last : i - 1)
      : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (to == null) return;
    e.preventDefault();
    onColor(spectrumColor(SPECTRUM[to].key));
    swatchRefs.current[to]?.focus();
  };

  return (
    <>
      <div>
        <p className="kpj-dialog-label" id={`${ids}-icon`}>Icon</p>
        <div className="kpj-idf-emoji" role="group" aria-labelledby={`${ids}-icon`}>
          <button type="button" className="kpj-idf-emoji-btn" data-initial="true" aria-pressed={!emoji}
            aria-label="No icon: use the initial" title="Use the initial" onClick={() => onEmoji("")}>{initial}</button>
          {WORK_EMOJI.map((e) => (
            <button key={e} type="button" className="kpj-idf-emoji-btn" aria-pressed={emoji === e} onClick={() => onEmoji(e)}>{e}</button>
          ))}
        </div>
        <label className="kpj-idf-any">
          <span>Or any emoji</span>
          <input className="kpj-field" data-size="sm" value={custom ? emoji : ""} placeholder="Type or paste one"
            aria-label="Any emoji" autoComplete="off" spellCheck={false}
            onChange={(e) => onEmoji(firstGrapheme(e.target.value))} />
        </label>
      </div>
      <div>
        <p className="kpj-dialog-label" id={`${ids}-colour`}>Colour</p>
        <div className="kpj-idf-hues" role="radiogroup" aria-labelledby={`${ids}-colour`}>
          {SPECTRUM.map((s, i) => {
            const on = s.key === current;
            return (
              <button key={s.key} ref={(el) => { swatchRefs.current[i] = el; }} type="button" role="radio" aria-checked={on}
                tabIndex={on ? 0 : -1} aria-label={s.name} title={s.name} className="kpj-idf-hue kp"
                style={projectIdentity({ id: s.key, color: spectrumColor(s.key) }).style}
                onClick={() => onColor(spectrumColor(s.key))} onKeyDown={(e) => onSwatchKey(e, i)} />
            );
          })}
        </div>
      </div>
    </>
  );
}

/** "Edit identity": a project's icon and colour, saved together. */
export function EditIdentitySheet({ project, open, onClose, onSave }: {
  project: Project;
  open: boolean;
  onClose: () => void;
  onSave: (patch: { emoji: string; color: string }) => void;
}) {
  const [emoji, setEmoji] = useState(project.emoji ?? "");
  // the stored colour, snapped to the spectrum hue it already reads as
  const [color, setColor] = useState(() => spectrumColor(projectSpectrum(project).key));
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    setEmoji(project.emoji ?? "");
    setColor(spectrumColor(projectSpectrum(project).key));
    // (opening again starts from the project as it is now)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.id]);
  const changed = emoji !== (project.emoji ?? "") || projectSpectrum({ id: project.id, color }).key !== projectSpectrum(project).key;
  return (
    <Sheet open={open} onClose={onClose} label={`Edit identity of ${project.name}`} title="Edit identity" width={520} initialFocus={saveRef}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button ref={saveRef} variant="primary" disabled={!changed} onClick={() => { onSave({ emoji, color }); onClose(); }}>Save</Button>
        </>
      )}>
      <div className="kpj-dialog">
        <IdentityPreview name={project.name} emoji={emoji} color={color}>
          <span className="kpj-idp-name">{project.name}</span>
        </IdentityPreview>
        <IdentityFields name={project.name} emoji={emoji} color={color} onEmoji={setEmoji} onColor={setColor} />
      </div>
    </Sheet>
  );
}

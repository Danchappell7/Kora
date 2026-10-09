/* ============================================================
   KANBO — TaskDetail › Cover.                                 [u8]
   Pick one of the task's image files as its board-card cover (a small
   grid of thumbnails, "None", and "Upload an image" handed back to the
   host's file input), or show that the project's cover is used when
   "Show project covers" is on. Saves tasks.cover_attachment_id (the
   database refuses a file that isn't an image on this task). Keyboard:
   the grid is a radio group — arrow keys move and choose (saved a
   moment after you stop, so arrowing past three images is one save),
   Space / Enter / a click save at once. Read-only for guests: it shows
   the cover and nothing to change. The demo's seeded covers join the
   task's own files here, as they do on the board.
   ============================================================ */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button, Icon, ProjectCover, type ProjectLike } from "../primitives";
import { demoCoverAttachments, effectiveCoverId } from "../board/boardDemo";
import type { Attachment, Task } from "../../data/types";
import "../board/coverPicker.css";

export interface CoverPickerProps {
  task: Pick<Task, "id" | "title" | "coverAttachmentId">;
  /** the task's files (only images are offered) — with signed `url`s for thumbnails */
  attachments: Attachment[];
  /** the project shows its identity cover on cards without one */
  projectCovers?: boolean;
  readOnly?: boolean;
  /** null = no cover */
  onChange: (attachmentId: string | null) => void;
  /** "Upload an image": the host opens its file picker (the new file can then be chosen) */
  onUpload?: () => void;
  /** the task's project, to preview its cover on the "no image" choice (optional) */
  project?: ProjectLike;
}

/** how long arrowing through the choices waits before saving the one it stopped on */
export const COVER_KEY_SAVE_MS = 600;

const isImage = (a: Attachment) => !!a.mime && a.mime.startsWith("image/");

export function CoverPicker({ task, attachments, projectCovers, readOnly, onChange, onUpload, project }: CoverPickerProps) {
  const id = useId();
  const saved = effectiveCoverId(task);
  const images = (() => {
    const seen = new Set<string>();
    const out: Attachment[] = [];
    for (const a of [...demoCoverAttachments(task.id), ...attachments]) if (isImage(a) && !seen.has(a.id)) { seen.add(a.id); out.push(a); }
    return out;
  })();
  const options: { id: string | null; name: string; url?: string }[] = [
    { id: null, name: projectCovers ? "Project cover" : "None" },
    ...images.map((a) => ({ id: a.id, name: a.name, url: a.url })),
  ];
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  const shown = pending !== undefined ? pending : saved;
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const [said, setSaid] = useState("");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ pending, saved, onChange });
  latest.current = { pending, saved, onChange };

  const nameOf = (cover: string | null) => cover == null ? (projectCovers ? "the project's cover" : "no cover") : options.find((o) => o.id === cover)?.name ?? "an image";
  // what was last handed to onChange (until the task comes back with it), so a choice is saved once
  const sent = useRef<string | null | undefined>(undefined);
  useEffect(() => { sent.current = undefined; }, [saved]);
  const commit = (cover: string | null) => {
    window.clearTimeout(timer.current); timer.current = undefined;
    if (cover !== latest.current.saved && cover !== sent.current) {
      sent.current = cover;
      latest.current.onChange(cover);
      setSaid(cover == null ? (projectCovers ? "Cover removed: the card shows the project's cover." : "Cover removed.") : `Cover set to ${nameOf(cover)}.`);
    }
    // from here the task says what's chosen (so a save the host undoes shows as undone)
    setPending(undefined);
  };
  // leaving with a choice still waiting saves it
  useEffect(() => () => {
    if (timer.current === undefined) return;
    window.clearTimeout(timer.current);
    const { pending: p, saved: s, onChange: save } = latest.current;
    if (p !== undefined && p !== s) save(p);
  }, []);

  const pick = (cover: string | null, now: boolean) => {
    setPending(cover);
    if (now) { commit(cover); return; }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(cover), COVER_KEY_SAVE_MS);
  };
  const at = Math.max(0, options.findIndex((o) => o.id === shown));
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const n = options.length;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (at + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (at - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    // (Space / Enter are the focused radio's own click: it saves at once)
    if (next < 0) return;
    e.preventDefault();
    pick(options[next].id, false);
    refs.current[next]?.focus();
  };

  const thumb = (o: { id: string | null; name: string; url?: string }) => {
    if (o.id == null) {
      return projectCovers && project
        ? <ProjectCover project={project} surface="raised" className="kcov-pc" />
        : <Icon name={projectCovers ? "palette" : "x"} size={16} sw={1.75} />;
    }
    return o.url && !broken.has(o.id)
      ? <img src={o.url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken((s) => new Set(s).add(o.id!))} />
      : <Icon name="folder" size={16} sw={1.75} />;
  };

  const savedOpt = options.find((o) => o.id === saved);
  return (
    <section className="kcov" aria-labelledby={`${id}-h`}>
      <div className="ksection">
        <h3 className="ksection-title" id={`${id}-h`}>Cover</h3>
        {!readOnly && onUpload && (
          <div className="ksection-action">
            <Button variant="ghost" size="sm" icon="plus" onClick={onUpload} style={{ color: "var(--ink-2)" }}>Upload an image</Button>
          </div>
        )}
      </div>
      {readOnly ? (
        <div className="kcov-static">
          {saved && savedOpt
            ? <span className="kcov-thumb" data-kind="image">{thumb(savedOpt)}</span>
            : <span className="kcov-thumb" data-kind="none">{thumb(options[0])}</span>}
          <span className="kcov-note">{saved && savedOpt ? savedOpt.name : projectCovers ? "The project's cover shows on this task's card." : "No cover."}</span>
        </div>
      ) : images.length === 0 ? (
        <p className="kcov-note">Add an image to this task to use it as the cover on its board card.{projectCovers ? " Until then, the project's cover shows." : ""}</p>
      ) : (
        <>
          <div role="radiogroup" aria-labelledby={`${id}-h`} aria-describedby={`${id}-d`} className="kcov-grid" onKeyDown={onKey}>
            {options.map((o, i) => {
              const on = shown === o.id;
              return (
                <button key={o.id ?? "none"} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={on}
                  tabIndex={i === at ? 0 : -1} className="kcov-opt" data-kind={o.id ? "image" : "none"}
                  aria-label={o.id ? o.name : projectCovers ? "Project cover" : "No cover"} title={o.name}
                  onClick={() => pick(o.id, true)}>
                  <span className="kcov-thumb" data-kind={o.id ? "image" : "none"}>
                    {thumb(o)}
                    {on && <span className="kcov-check" aria-hidden="true"><Icon name="check" size={11} sw={3} /></span>}
                  </span>
                  <span className="kcov-name">{o.name}</span>
                </button>
              );
            })}
          </div>
          <p id={`${id}-d`} className="kcov-note">Shown at the top of this task's card on the board.{projectCovers ? " With none, the project's cover shows." : ""}</p>
        </>
      )}
      <span role="status" aria-live="polite" className="sr-only">{said}</span>
    </section>
  );
}

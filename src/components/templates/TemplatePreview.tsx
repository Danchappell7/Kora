/* ============================================================
   KANBO — a template, read before it's used (the library's right-hand
   pane; the whole sheet on a phone).                          [u9]
   Who it's from, the task it makes (placeholders marked), its
   description, sub-tasks with their days and who they go to, and its
   checklist; then what this person may do with it: Use, Edit, Make a
   copy, Share (or share a copy), Delete — which asks first, in place.
   ============================================================ */
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, Icon, PriorityGlyph, SectionLabel, Toggle } from "../primitives";
import { PRIORITY_META } from "../../data/data";
import { renderRich } from "../../lib/richtext";
import {
  isLocalTemplateId, templateDayLabel, templatePlaceholders, templateRecurrence, templateRepeatLabel, templateRights, templateRoleLabel,
  type TemplateViewer,
} from "../../lib/templates";
import type { LibraryTemplate, TagDef } from "../../data/types";
import { TemplateTile, safeId, templateKind } from "./parts";
import "./templates.css";

export interface TemplatePreviewProps {
  template: LibraryTemplate;
  viewer: TemplateViewer;
  workspaceName?: string;
  memberName: (userId: string) => string | undefined;
  tags?: Record<string, TagDef>;
  canApply: boolean;
  /** which action is under way ("share", "delete", …) */
  busy: string | null;
  headingRef?: RefObject<HTMLHeadingElement>;
  onUse: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onToggleShare: (shared: boolean) => void;
  onShareCopy: () => void;
  onDelete: () => void;
}

const fmtMin = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

/** the title with its {placeholders} marked */
export function TitleWithPlaceholders({ title }: { title: string }) {
  const marks = templatePlaceholders(title);
  if (!marks.length) return <>{title}</>;
  const out: ReactNode[] = [];
  let at = 0;
  marks.forEach((m, i) => {
    if (m.start > at) out.push(title.slice(at, m.start));
    out.push(<mark key={i} className="ktpl-ph"><span className="sr-only">(fill in: </span>{m.name}<span className="sr-only">)</span></mark>);
    at = m.end;
  });
  if (at < title.length) out.push(title.slice(at));
  return <>{out}</>;
}

export function byLine(t: LibraryTemplate, viewer: TemplateViewer, workspaceName: string | undefined, memberName: (id: string) => string | undefined): string {
  const ws = workspaceName || "the workspace";
  if (t.builtin) return "Built-in · made by Kanbo";
  if (isLocalTemplateId(t.id)) return "Yours · kept in this browser";
  const kind = templateKind(t, viewer.userId);
  if (kind === "yours") {
    if (t.shared) return t.workspaceId === viewer.workspaceId ? `Yours · shared with ${ws}` : "Yours · shared in another workspace";
    return "Yours · only you can see it";
  }
  return `Shared by ${memberName(t.userId) ?? "a teammate"} · ${ws}`;
}

export function TemplatePreview({ template: t, viewer, workspaceName, memberName, tags, canApply, busy, headingRef, onUse, onEdit, onCopy, onToggleShare, onShareCopy, onDelete }: TemplatePreviewProps) {
  const uid = safeId(useId());
  const nameId = `ktpl-pv-${uid}`;
  const rights = templateRights(t, viewer);
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setConfirming(false); }, [t.id]);
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);
  const cancelConfirm = () => { setConfirming(false); window.setTimeout(() => deleteRef.current?.focus(), 0); };

  const b = t.body;
  const subs = b.subtasks ?? [];
  const items = b.checklist ?? [];
  const repeat = templateRecurrence(b);
  const ws = workspaceName || "the workspace";
  const tagLabel = (x: string) => tags?.[x]?.label ?? x;
  const tagColour = (x: string) => tags?.[x]?.color ?? Object.values(tags ?? {}).find((d) => d.label.toLowerCase() === x.toLowerCase())?.color;

  return (
    <article className="ktpl-pv" aria-labelledby={nameId}>
      <header className="ktpl-pv-head">
        <TemplateTile template={t} size={44} />
        <div className="ktpl-pv-id">
          <h3 ref={headingRef} id={nameId} className="ktpl-pv-name" tabIndex={-1}>{t.name}</h3>
          <p className="ktpl-pv-by">{byLine(t, viewer, workspaceName, memberName)}</p>
        </div>
      </header>

      <div className="ktpl-pv-acts">
        {canApply && <Button variant="primary" icon="plus" onClick={onUse} disabled={!!busy}>Use template</Button>}
        {rights.edit && <Button icon="sliders" onClick={onEdit} disabled={!!busy}>Edit</Button>}
        <Button icon="copy" onClick={onCopy} disabled={!!busy}>{t.builtin ? "Make a copy to edit" : "Make a copy"}</Button>
        {rights.delete && !confirming && (
          <Button ref={deleteRef} variant="ghost" icon="trash" className="ktpl-del" onClick={() => setConfirming(true)} disabled={!!busy}>Delete</Button>
        )}
      </div>

      {confirming && (
        <div className="ktpl-confirm" role="group" aria-label="Delete this template?">
          <p>
            <b>Delete “{t.name}”?</b>{" "}
            {t.shared && t.workspaceId ? `It's shared, so it goes for everyone in ${ws}. Tasks already made from it stay.` : "Tasks already made from it stay."}
          </p>
          <div className="ktpl-confirm-acts">
            <Button ref={confirmRef} size="sm" variant="danger" icon="trash" loading={busy === "delete"} onClick={onDelete}>Delete</Button>
            <Button size="sm" variant="ghost" onClick={cancelConfirm} disabled={busy === "delete"}>Keep it</Button>
          </div>
        </div>
      )}

      {rights.share && (
        <div className="ktpl-pv-share">
          <Toggle checked={t.shared} disabled={!!busy} onChange={onToggleShare} label={`Share with ${ws}`}
            description={t.shared ? `Everyone in ${ws} can use it.` : "Only you can see it."} />
        </div>
      )}
      {rights.shareCopy && (
        <div className="ktpl-pv-share" data-copy="">
          <p>Made outside {ws}, so it can't be shared here. You can share a copy.</p>
          <Button size="sm" icon="users" onClick={onShareCopy} loading={busy === "share-copy"} disabled={!!busy && busy !== "share-copy"}>Share a copy with {ws}</Button>
        </div>
      )}

      <dl className="ktpl-pv-facts">
        <div><dt>Task</dt><dd className="ktpl-pv-title"><TitleWithPlaceholders title={b.title} /></dd></div>
        <div><dt>Priority</dt><dd><PriorityGlyph priority={b.priority ?? "medium"} />{PRIORITY_META[b.priority ?? "medium"].label}</dd></div>
        <div><dt>Focus time</dt><dd className="mono">{fmtMin(b.estimate ?? 30)}</dd></div>
        <div><dt>Due</dt><dd>{typeof b.dueOffsetDays === "number" ? templateDayLabel(b.dueOffsetDays) : "No due date"}</dd></div>
        {repeat && <div><dt>Repeats</dt><dd>{templateRepeatLabel(repeat)}</dd></div>}
        {(b.tags?.length ?? 0) > 0 && (
          <div><dt>Tags</dt><dd className="ktpl-pv-tags">{b.tags!.map((x) => (
            <span key={x} className="ktpl-tag" data-static="">
              <span className="ktpl-tagdot" style={{ background: tagColour(x) ?? "var(--icon-quiet)" }} aria-hidden="true" />{tagLabel(x)}
            </span>
          ))}</dd></div>
        )}
      </dl>

      {b.description && <div className="ktpl-pv-desc">{renderRich(b.description)}</div>}

      {subs.length > 0 && (
        <section className="ktpl-pv-sec" aria-label={`Sub-tasks, ${subs.length}`}>
          <SectionLabel count={subs.length}>Sub-tasks</SectionLabel>
          <ol className="ktpl-pv-subs">
            {subs.map((s, i) => (
              <li key={i}>
                <span className="ktpl-ring" aria-hidden="true" />
                <span className="ktpl-pv-subtitle">{s.title}</span>
                <span className="ktpl-pv-when">{templateDayLabel(s.offsetDays)}</span>
                <span className="ktpl-pv-role" data-role={s.assigneeRole ?? "me"}>
                  <Icon name="user" size={12} sw={2} />{templateRoleLabel(s.assigneeRole)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {items.length > 0 && (
        <section className="ktpl-pv-sec" aria-label={`Checklist, ${items.length} items`}>
          <SectionLabel count={items.length}>Checklist</SectionLabel>
          <ul className="ktpl-pv-check">
            {items.map((c, i) => <li key={i}><span className="ktpl-box" aria-hidden="true" />{c}</li>)}
          </ul>
        </section>
      )}

      <p className="ktpl-pv-note">
        <Icon name="calendar" size={14} sw={1.75} />
        <span>Dates count from the day it's used and move with the task's due date if you change it. Weekend dates move to a weekday.</span>
      </p>
    </article>
  );
}

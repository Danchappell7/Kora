/* ============================================================
   KANBO — one project doc (/p/:id/docs/:docId).              [0047, w5]
   Loads the doc, shows its icon, who edited it last and when, the
   editor (DocEditor), Export as Markdown, Version history, Archive and
   Delete. A doc that's gone (deleted, or its project in the bin) says so
   and offers the way back. An archived doc reads only until it's
   unarchived. Guests read (the editor renders it read only).
   Data: lib/docs.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DocSaveState, Member, Project, ProjectDoc, Task } from "../../data/types";
import { Button, EmojiPicker, EmptyState, Icon, IconButton, Sheet } from "../primitives";
import { Popover } from "../primitives/Popover";
import { getMember } from "../../data/data";
import {
  deleteProjectDoc, docAgo, docErrorText, docFailure, docFileName, downloadMarkdown, getProjectDoc, setProjectDocProps, subscribeProjectDocs,
} from "../../lib/docs";
import { copyText, useOptionalToast } from "../rituals/shared";
import { DocEditor, DocSaveIndicator, type DocEditorHandle, type DocMakeTask } from "./DocEditor";
import "../project/projects.css";
import "./docs.css";

export interface DocPageProps {
  project: Project;
  docId: string;
  members: Member[];
  tasks: Task[];
  currentUserId: string;
  readOnly: boolean;
  /** back to the Docs list */
  onBack: () => void;
  onMakeTask: DocMakeTask;
  onOpenTask: (taskId: string) => void;
}

type Load = { state: "loading" } | { state: "ready"; doc: ProjectDoc } | { state: "gone" } | { state: "problem"; why: ReturnType<typeof docFailure>; message: string };

/** "Edited 2 hours ago by Sana Rao" · "Edited just now by you". */
export function editedLine(doc: Pick<ProjectDoc, "updatedAt" | "updatedBy" | "updatedByName">, currentUserId: string, nameOf: (id: string) => string | undefined, now = Date.now()): string {
  const when = docAgo(doc.updatedAt, now);
  const who = !doc.updatedBy ? null : doc.updatedBy === currentUserId ? "you" : doc.updatedByName ?? nameOf(doc.updatedBy) ?? null;
  return `Edited ${when}${who ? ` by ${who}` : ""}`;
}

export function DocPage({ project, docId, members, tasks, currentUserId, readOnly, onBack, onMakeTask, onOpenTask }: DocPageProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [live, setLive] = useState<ProjectDoc | null>(null);
  const [saveState, setSaveState] = useState<DocSaveState>("idle");
  const [menuOpen, setMenuOpen] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<"archive" | "delete" | "icon" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [, setTick] = useState(0);
  const editorRef = useRef<DocEditorHandle>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const iconRef = useRef<HTMLButtonElement>(null);
  const toast = useOptionalToast();
  const nameOf = useCallback((id: string) => members.find((m) => m.id === id)?.name ?? getMember(id)?.name, [members]);

  useEffect(() => {
    let alive = true;
    setLoad({ state: "loading" });
    setDeleted(false);
    getProjectDoc(docId).then(
      (d) => {
        if (!alive) return;
        if (!d || d.projectId !== project.id) { setLoad({ state: "gone" }); return; }
        setLoad({ state: "ready", doc: d });
        setLive(d);
      },
      (e) => { if (alive) setLoad({ state: "problem", why: docFailure(e), message: docErrorText(e) }); },
    );
    return () => { alive = false; };
  }, [docId, project.id, reloadKey]);

  // someone else changed its icon, archived it or deleted it (the editor handles its contents)
  useEffect(() => {
    let alive = true;
    const off = subscribeProjectDocs(project.id, (c) => {
      if (!alive || c.docId !== docId) return;
      if (c.type === "DELETE") { setDeleted(true); return; }
      const patch = (d: Pick<ProjectDoc, "icon" | "archivedAt" | "position" | "updatedAt" | "updatedBy">) => setLive((cur) => (cur ? {
        ...cur, icon: d.icon, archivedAt: d.archivedAt, position: d.position, updatedAt: d.updatedAt,
        updatedBy: d.updatedBy, updatedByName: d.updatedBy === cur.updatedBy ? cur.updatedByName : null,
      } : cur));
      // the message usually carries the row (no body needed here); a big one doesn't: fetch it
      if (c.item) patch(c.item);
      else getProjectDoc(docId).then((d) => { if (alive && d) patch(d); }, () => {});
    });
    return () => { alive = false; off(); };
  }, [project.id, docId]);

  // "Edited 3 minutes ago" keeps up while the page is open
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 60000);
    return () => window.clearInterval(t);
  }, []);

  if (load.state === "loading") {
    return (
      <div className="kpj-page kdoc-page"><div className="kpj-wrap kpj-readw" aria-busy="true" aria-label="Loading the doc">
        <div className="kdoc-head"><div className="kskel" style={{ width: 80, height: 28 }} /></div>
        <div className="kskel" style={{ width: 48, height: 48, margin: "8px 0" }} />
        <div className="kskel" style={{ width: "60%", height: 32, marginBottom: 20 }} />
        {[92, 100, 84, 70].map((w, i) => <div key={i} className="kskel" style={{ width: `${w}%`, height: 16, marginBottom: 12 }} />)}
      </div></div>
    );
  }
  if (load.state === "gone" || load.state === "problem") {
    const unavailable = load.state === "problem" && load.why === "unavailable";
    return (
      <div className="kpj-page kdoc-page"><div className="kpj-wrap kpj-readw kdoc-gone">
        <div className="kdoc-head"><Button variant="ghost" size="sm" icon="arrowLeft" onClick={onBack}>Docs</Button></div>
        {load.state === "gone"
          ? <EmptyState art="folder" title="This doc isn't here any more" body="It may have been deleted, or its project moved to the recycle bin." action={<Button onClick={onBack}>Back to Docs</Button>} />
          : <EmptyState art="folder" title={unavailable ? "Docs aren't switched on yet" : "Couldn't open this doc"} body={load.message}
              action={unavailable ? <Button onClick={onBack}>Back</Button> : <Button icon="refresh" onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>} />}
      </div></div>
    );
  }

  const doc = live ?? load.doc;
  const archived = !!doc.archivedAt;
  const canEdit = !readOnly && load.doc.canEdit && !deleted;
  const editing = canEdit && !archived;

  const exportMd = () => {
    const md = editorRef.current?.markdown() ?? "";
    downloadMarkdown(docFileName(editorRef.current?.content().title ?? doc.title), md);
    toast?.success("Exported as Markdown.");
  };
  const copyMd = async () => {
    const ok = await copyText(editorRef.current?.markdown() ?? "");
    if (ok) toast?.success("Copied as Markdown."); else toast?.error("Couldn't copy. Try Export instead.");
  };
  const setArchived = async (on: boolean) => {
    setBusy("archive");
    setProblem(null);
    try {
      if (on) await editorRef.current?.flush();
      const d = await setProjectDocProps(doc.id, { archived: on });
      setLive((cur) => ({ ...(cur ?? d), archivedAt: d.archivedAt }));
      toast?.success(on ? "Archived. It's read only until you unarchive it." : "Unarchived.");
    } catch (e) {
      setProblem(docErrorText(e));
    } finally { setBusy(null); }
  };
  const setIcon = async (icon: string) => {
    setIconOpen(false);
    setBusy("icon");
    setProblem(null);
    const before = doc.icon;
    setLive((cur) => (cur ? { ...cur, icon: icon || null } : cur));
    try {
      const d = await setProjectDocProps(doc.id, { icon });
      setLive((cur) => (cur ? { ...cur, icon: d.icon } : cur));
    } catch (e) {
      setLive((cur) => (cur ? { ...cur, icon: before } : cur));
      setProblem(docErrorText(e));
    } finally { setBusy(null); }
  };
  const remove = async () => {
    setBusy("delete");
    setProblem(null);
    try {
      await deleteProjectDoc(doc.id);
      setConfirmDelete(false);
      toast?.success(`Deleted “${doc.title || "Untitled"}”.`);
      onBack();
    } catch (e) {
      setProblem(docErrorText(e));
      setConfirmDelete(false);
    } finally { setBusy(null); }
  };

  return (
    <div className="kpj-page kdoc-page">
      <div className="kpj-wrap kpj-readw">
        <div className="kdoc-head">
          <Button variant="ghost" size="sm" icon="arrowLeft" onClick={onBack} aria-label={`Back to ${project.name}'s docs`}>Docs</Button>
          <span className="kdoc-head-meta">
            <span title={new Date(doc.updatedAt).toLocaleString("en-GB")}>{editedLine(doc, currentUserId, nameOf)}</span>
            {editing && <DocSaveIndicator state={saveState} />}
          </span>
          <span className="kdoc-head-acts">
            <IconButton icon="clock" label="Version history" onClick={() => editorRef.current?.openHistory()} />
            <IconButton ref={moreRef} icon="more" label="More for this doc" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)} />
          </span>
        </div>
        <Popover open={menuOpen} anchorRef={moreRef} onClose={() => setMenuOpen(false)} align="end" label="More for this doc" minWidth={220}>
          <button type="button" className="kmenu-item" onClick={() => { setMenuOpen(false); exportMd(); }}><Icon name="arrowUpRight" size={16} sw={1.75} />Export as Markdown</button>
          <button type="button" className="kmenu-item" onClick={() => { setMenuOpen(false); void copyMd(); }}><Icon name="copy" size={16} sw={1.75} />Copy as Markdown</button>
          <button type="button" className="kmenu-item" onClick={() => { setMenuOpen(false); editorRef.current?.openHistory(); }}><Icon name="clock" size={16} sw={1.75} />Version history</button>
          {canEdit && <hr className="kmenu-sep" />}
          {canEdit && (
            <button type="button" className="kmenu-item" disabled={busy === "archive"} onClick={() => { setMenuOpen(false); void setArchived(!archived); }}>
              <Icon name="archive" size={16} sw={1.75} />{archived ? "Unarchive" : "Archive"}
            </button>
          )}
          {canEdit && <button type="button" className="kmenu-item" data-tone="danger" onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}><Icon name="trash" size={16} sw={1.75} />Delete…</button>}
        </Popover>

        {problem && <p className="kdocs-note" role="alert">{problem}</p>}
        {archived && (
          <div className="kdoc-archived" role="status">
            <Icon name="archive" size={16} sw={1.75} />
            <p>This doc is archived{canEdit ? ", so it's read only." : "."}</p>
            {canEdit && <Button size="sm" loading={busy === "archive"} onClick={() => void setArchived(false)}>Unarchive</Button>}
          </div>
        )}

        {editing ? (
          <button ref={iconRef} type="button" className="kdoc-iconpick" data-empty={!doc.icon || undefined} aria-label={doc.icon ? `Doc icon ${doc.icon}: change` : "Add an icon"}
            aria-haspopup="dialog" aria-expanded={iconOpen} onClick={() => setIconOpen(true)} disabled={busy === "icon"}>
            {doc.icon ? doc.icon : <><Icon name="plus" size={14} sw={1.9} />Add icon</>}
          </button>
        ) : doc.icon ? <span className="kdoc-iconpick" aria-hidden="true">{doc.icon}</span> : null}
        <Popover open={iconOpen} anchorRef={iconRef} onClose={() => setIconOpen(false)} role="dialog" label="Doc icon" minWidth={268}>
          <EmojiPicker onPick={(e) => void setIcon(e)} />
          {doc.icon && <><hr className="kmenu-sep" /><button type="button" className="kmenu-item" onClick={() => void setIcon("")}><Icon name="x" size={16} sw={1.75} />Remove icon</button></>}
        </Popover>

        <DocEditor key={load.doc.id} ref={editorRef} doc={load.doc} members={members} tasks={tasks} currentUserId={currentUserId}
          readOnly={!editing} onSaveState={setSaveState}
          onSaved={(d) => setLive((cur) => ({ ...(cur ?? d), title: d.title, updatedAt: d.updatedAt, updatedBy: d.updatedBy, updatedByName: d.updatedByName, mentions: d.mentions }))}
          onMakeTask={onMakeTask} onOpenTask={onOpenTask} />
      </div>

      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} label="Delete this doc" title="Delete this doc?" width={440}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" loading={busy === "delete"} onClick={() => void remove()}>Delete doc</Button>
        </>}>
        <p className="kdoc-confirm">
          “{doc.title || "Untitled"}” and its version history will be deleted for everyone. This can't be undone. To keep it out of the way instead, archive it.
        </p>
      </Sheet>
    </div>
  );
}

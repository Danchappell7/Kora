/* ============================================================
   KANBO — a project's Docs tab (/p/:id/docs).                [0047, w5]
   The project's docs with their icons (drag to reorder — or the row's
   grip with ↑/↓, or Move up/down in its menu — and archive), New doc from
   templates (Blank, Project brief, Meeting notes, Decision log, Retro);
   opening one shows DocPage (/p/:id/docs/:docId). Archived docs fold
   away under the list. Read-only for guests. Live: someone else's new
   doc, rename or delete shows up without a reload. Data: lib/docs.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { DocTemplateId, Member, Project, ProjectDocListItem, Task } from "../../data/types";
import { Button, EmptyState, Icon, IconButton, Sheet } from "../primitives";
import { Popover } from "../primitives/Popover";
import { getMember, todayISO } from "../../data/data";
import { pathOf } from "../../lib/nav";
import {
  deleteProjectDoc, docAgo, docErrorText, docFailure, docTemplate, DOC_COPY, DOC_LIMITS, DOC_TEMPLATES, listProjectDocs, saveProjectDoc,
  setProjectDocProps, subscribeProjectDocs,
} from "../../lib/docs";
import { useOptionalToast } from "../rituals/shared";
import type { DocMakeTask } from "./DocEditor";
import { DocPage } from "./DocPage";
import "../project/projects.css";
import "./docs.css";

export interface DocsTabProps {
  project: Project;
  members: Member[];
  tasks: Task[];
  currentUserId: string;
  readOnly: boolean;
  /** the open doc (from the address), or null for the list */
  docId: string | null;
  /** open a doc (null: back to the list) — the host updates the address */
  onOpenDoc: (docId: string | null) => void;
  onMakeTask: DocMakeTask;
  onOpenTask: (taskId: string) => void;
}

/** What each template is for (the New doc menu and the empty state). */
export const TEMPLATE_HINT: Readonly<Record<DocTemplateId, string>> = {
  blank: "Start from nothing",
  brief: "Why, what done looks like, who's involved",
  meeting: "Agenda, notes, decisions, actions",
  decisions: "What was decided, why, and by whom",
  retro: "What went well, what didn't, what's next",
};

/** A fresh uuid (the server takes the app's id for a new doc). */
export function newDocId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Where a doc moved to (index `to` in the list without it) gets its new position: between its neighbours.
 *  When the neighbours have no room (or no positions), every doc is renumbered 1…n. */
export function reorderPositions(list: readonly Pick<ProjectDocListItem, "id" | "position">[], id: string, to: number): { id: string; position: number }[] {
  const from = list.findIndex((d) => d.id === id);
  if (from < 0) return [];
  const rest = list.filter((d) => d.id !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  const before = rest[at - 1]?.position, after = rest[at]?.position;
  const ok = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
  let pos: number | null = null;
  if (at === 0 && ok(after)) pos = after - 1;
  else if (at === rest.length && ok(before)) pos = before + 1;
  else if (ok(before) && ok(after) && after - before > 1e-6) pos = (before + after) / 2;
  if (pos !== null && (at === 0 || ok(before)) && (at === rest.length || ok(after))) return [{ id, position: pos }];
  const order = [...rest.slice(0, at), list[from], ...rest.slice(at)];
  return order.map((d, i) => ({ id: d.id, position: i + 1 })).filter((d) => list.find((x) => x.id === d.id)?.position !== d.position);
}

type Load = { state: "loading" } | { state: "ready" } | { state: "problem"; why: ReturnType<typeof docFailure>; message: string };

export function DocsTab(props: DocsTabProps) {
  if (props.docId) {
    return (
      <DocPage project={props.project} docId={props.docId} members={props.members} tasks={props.tasks} currentUserId={props.currentUserId}
        readOnly={props.readOnly} onBack={() => props.onOpenDoc(null)} onMakeTask={props.onMakeTask} onOpenTask={props.onOpenTask} />
    );
  }
  return <DocsList {...props} />;
}

function DocsList({ project, members, currentUserId, readOnly, onOpenDoc }: DocsTabProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [docs, setDocs] = useState<ProjectDocListItem[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [creating, setCreating] = useState<DocTemplateId | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ProjectDocListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [drag, setDrag] = useState<{ id: string; over: string | null; where: "before" | "after" } | null>(null);
  const [live, setLive] = useState("");
  const newRef = useRef<HTMLButtonElement>(null);
  const rowMenuAnchor = useRef<HTMLElement | null>(null);
  const gripDown = useRef<string | null>(null);
  const toast = useOptionalToast();
  const canEdit = !readOnly;

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoad({ state: "loading" });
    try {
      const list = await listProjectDocs(project.id);
      setDocs(list);
      setLoad({ state: "ready" });
    } catch (e) {
      if (!quiet) setLoad({ state: "problem", why: docFailure(e), message: docErrorText(e) });
    }
  }, [project.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  // someone else's change: a quiet refetch (a DELETE names any doc, so check it's one of ours)
  const docsRef = useRef(docs);
  docsRef.current = docs;
  useEffect(() => {
    let t = 0;
    const off = subscribeProjectDocs(project.id, (c) => {
      if (c.type === "DELETE" && !docsRef.current.some((d) => d.id === c.docId)) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => void refresh(true), 150);
    });
    return () => { window.clearTimeout(t); off(); };
  }, [project.id, refresh]);

  const active = useMemo(() => docs.filter((d) => !d.archivedAt), [docs]);
  const archived = useMemo(() => docs.filter((d) => !!d.archivedAt), [docs]);
  const q = filter.trim().toLowerCase();
  const shown = q ? active.filter((d) => (d.title || "untitled").toLowerCase().includes(q)) : active;
  const nameOf = (id: string | null) => (id ? (id === currentUserId ? "you" : members.find((m) => m.id === id)?.name ?? getMember(id)?.name ?? null) : null);
  const say = (msg: string) => setLive((prev) => (prev === msg ? msg + "\u00a0" : msg));

  /* ---- new doc ---- */
  const create = async (tpl: DocTemplateId) => {
    if (creating) return;
    setNewOpen(false);
    setCreating(tpl);
    setNote(null);
    const id = newDocId();
    const t = docTemplate(tpl, { projectName: project.name, today: todayISO() });
    try {
      const r = await saveProjectDoc({ id, projectId: project.id, title: t.title, body: t.body, baseUpdatedAt: null, icon: t.icon, mentions: [] });
      const { body: _b, mentions: _m, createdByName: _c, updatedByName: _u, canEdit: _e, ...item } = r.doc;
      setDocs((list) => (list.some((d) => d.id === id) ? list : [...list, item]));
      onOpenDoc(id);
    } catch (e) {
      setNote(docErrorText(e));
    } finally {
      setCreating(null);
    }
  };

  /* ---- reorder ---- */
  const moveTo = async (id: string, to: number) => {
    const changes = reorderPositions(active, id, to);
    if (!changes.length) return;
    const before = docs;
    const pos = new Map(changes.map((c) => [c.id, c.position]));
    const next = docs.map((d) => (pos.has(d.id) ? { ...d, position: pos.get(d.id)! } : d))
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.createdAt.localeCompare(b.createdAt));
    setDocs(next);
    const moved = next.filter((d) => !d.archivedAt).findIndex((d) => d.id === id);
    say(`Moved to position ${moved + 1} of ${active.length}.`);
    try {
      for (const c of changes) await setProjectDocProps(c.id, { position: c.position });
    } catch (e) {
      setDocs(before);
      setNote(docErrorText(e));
    }
  };
  const moveBy = (id: string, delta: number) => {
    const i = active.findIndex((d) => d.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= active.length) return;
    void moveTo(id, j);
  };

  /* ---- archive / delete ---- */
  const setArchived = async (d: ProjectDocListItem, on: boolean) => {
    setNote(null);
    const before = docs;
    setDocs((list) => list.map((x) => (x.id === d.id ? { ...x, archivedAt: on ? new Date().toISOString() : null } : x)));
    try {
      await setProjectDocProps(d.id, { archived: on });
      toast?.action(on ? `Archived “${d.title || "Untitled"}”.` : `Unarchived “${d.title || "Untitled"}”.`, "Undo", () => void setArchived({ ...d, archivedAt: on ? new Date().toISOString() : null }, !on));
      if (!toast) say(on ? "Archived." : "Unarchived.");
    } catch (e) {
      setDocs(before);
      setNote(docErrorText(e));
    }
  };
  const remove = async () => {
    if (!confirm) return;
    setDeleting(true);
    try {
      await deleteProjectDoc(confirm.id);
      setDocs((list) => list.filter((x) => x.id !== confirm.id));
      toast?.success(`Deleted “${confirm.title || "Untitled"}”.`);
      say("Deleted.");
      setConfirm(null);
    } catch (e) {
      setNote(docErrorText(e));
      setConfirm(null);
    } finally {
      setDeleting(false);
    }
  };

  /* ---- drag ---- */
  const onDragStart = (e: DragEvent<HTMLLIElement>, id: string) => {
    if (!canEdit || gripDown.current !== id) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", id); } catch { /* some browsers refuse custom data */ }
    setDrag({ id, over: null, where: "before" });
  };
  const onDragOver = (e: DragEvent<HTMLLIElement>, id: string) => {
    if (!drag) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const where = e.clientY < r.top + r.height / 2 ? "before" : "after";
    if (drag.over !== id || drag.where !== where) setDrag({ ...drag, over: id, where });
  };
  const onDrop = (e: DragEvent<HTMLLIElement>, id: string) => {
    e.preventDefault();
    const d = drag;
    setDrag(null);
    gripDown.current = null;
    if (!d || d.id === id) return;
    const rest = active.filter((x) => x.id !== d.id);
    const at = rest.findIndex((x) => x.id === id) + (d.where === "after" ? 1 : 0);
    void moveTo(d.id, at);
  };

  const openDoc = (e: ReactMouseEvent<HTMLAnchorElement>, id: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // a new tab: let the browser
    e.preventDefault();
    onOpenDoc(id);
  };

  const gripKey = (e: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); moveBy(id, e.key === "ArrowUp" ? -1 : 1); }
  };

  const row = (d: ProjectDocListItem, i: number, isArchived: boolean) => {
    const who = nameOf(d.updatedBy);
    const meta = `Edited ${docAgo(d.updatedAt)}${who ? ` by ${who}` : ""}`;
    const href = pathOf({ view: "project", projectId: project.id, tab: "docs", docId: d.id });
    const dropAt = drag && drag.over === d.id && drag.id !== d.id ? drag.where : undefined;
    return (
      <li key={d.id} className="kdocs-row" data-archived={isArchived || undefined} data-dragging={drag?.id === d.id || undefined} data-drop={dropAt}
        draggable={canEdit && !isArchived && !q} onDragStart={(e) => onDragStart(e, d.id)} onDragOver={(e) => onDragOver(e, d.id)}
        onDrop={(e) => onDrop(e, d.id)} onDragEnd={() => { setDrag(null); gripDown.current = null; }}>
        {canEdit && !isArchived && !q ? (
          <button type="button" className="kdocs-grip" aria-label={`Reorder “${d.title || "Untitled"}” (up and down arrows), position ${i + 1} of ${active.length}`}
            title="Drag to reorder" onPointerDown={() => { gripDown.current = d.id; }} onPointerUp={() => { gripDown.current = null; }}
            onKeyDown={(e) => gripKey(e, d.id)}>
            <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true"><g fill="currentColor">{[2, 7, 12].map((y) => <g key={y}><circle cx="2.5" cy={y} r="1.3" /><circle cx="7.5" cy={y} r="1.3" /></g>)}</g></svg>
          </button>
        ) : <span className="kdocs-grip-space" aria-hidden="true" />}
        <span className="kdocs-icon" aria-hidden="true">{d.icon || "📄"}</span>
        <span className="kdocs-main">
          <a className="kdocs-title" href={href} data-untitled={!d.title || undefined} onClick={(e) => openDoc(e, d.id)}>{d.title || "Untitled"}</a>
          <span className="kdocs-meta" title={new Date(d.updatedAt).toLocaleString("en-GB")}>{isArchived ? `Archived · ${meta.toLowerCase()}` : meta}</span>
        </span>
        <span className="kdocs-acts">
          {canEdit && (
            <IconButton icon="more" size="sm" label={`More for “${d.title || "Untitled"}”`} aria-haspopup="menu" aria-expanded={rowMenu === d.id}
              onClick={(e) => { rowMenuAnchor.current = e.currentTarget; setRowMenu(rowMenu === d.id ? null : d.id); }} />
          )}
        </span>
      </li>
    );
  };

  const menuDoc = rowMenu ? docs.find((d) => d.id === rowMenu) : null;
  const menuIndex = menuDoc ? active.findIndex((d) => d.id === menuDoc.id) : -1;
  const atLimit = docs.length >= DOC_LIMITS.perProject;

  const newButton = canEdit && (
    <Button ref={newRef} variant="primary" size="sm" icon="plus" iconRight="chevronDown" loading={!!creating} disabled={atLimit}
      aria-haspopup="menu" aria-expanded={newOpen} onClick={() => setNewOpen((v) => !v)}
      title={atLimit ? DOC_COPY.too_many : undefined}>New doc</Button>
  );

  return (
    <div className="kpj-page">
      <div className="kpj-wrap kpj-narrow kdocs">
        <div className="kdocs-toolbar">
          <h2 className="kdocs-toolbar-title">Docs{load.state === "ready" && active.length > 0 && <span className="kpj-count">{active.length}</span>}</h2>
          <span className="kdocs-spacer" />
          {active.length >= 8 && (
            <input className="kfield kdocs-filter" data-size="sm" type="search" value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a doc" aria-label="Find a doc by title" />
          )}
          {newButton}
        </div>
        <Popover open={newOpen} anchorRef={newRef} onClose={() => setNewOpen(false)} align="end" label="New doc from a template" minWidth={280}>
          <div className="kmenu-label">New doc</div>
          {DOC_TEMPLATES.map((t) => (
            <button key={t.id} type="button" className="kmenu-item" style={{ height: "auto", minHeight: 40, padding: "4px 8px" }} onClick={() => void create(t.id)}>
              <span className="kdocs-tmenu-icon" aria-hidden="true">{t.icon}</span>
              <span className="kdoc-opt-main"><span>{t.label}</span><span className="kdoc-opt-hint">{TEMPLATE_HINT[t.id]}</span></span>
            </button>
          ))}
        </Popover>
        {note && <p className="kdocs-note" role="alert">{note}</p>}

        {load.state === "loading" && (
          <div className="kdocs-skel" aria-busy="true" aria-label="Loading docs">
            {[0, 1, 2].map((i) => <div key={i} className="kskel" style={{ height: 48 }} />)}
          </div>
        )}
        {load.state === "problem" && (
          load.why === "unavailable"
            ? <EmptyState art="folder" title="Docs aren't switched on yet" body={load.message} />
            : <EmptyState art="folder" title="Couldn't load docs" body={load.message} action={<Button icon="refresh" onClick={() => void refresh()}>Try again</Button>} />
        )}
        {load.state === "ready" && active.length === 0 && (
          <EmptyState art="folder" title={archived.length ? "No docs in use" : "No docs yet"}
            body={canEdit
              ? "Keep the brief, meeting notes and decisions next to the work. Start from a template:"
              : "When the team writes docs for this project, they'll be here."}
            action={canEdit ? (
              <div className="kdocs-templates">
                {DOC_TEMPLATES.map((t) => (
                  <button key={t.id} type="button" className="kdocs-template" disabled={!!creating} aria-busy={creating === t.id || undefined} onClick={() => void create(t.id)}>
                    <span className="kdocs-template-icon" aria-hidden="true">{t.icon}</span>{t.label}
                  </button>
                ))}
              </div>
            ) : undefined} />
        )}
        {load.state === "ready" && active.length > 0 && (
          shown.length
            ? <ul className="kdocs-list" aria-label={`${project.name}: docs`}>{shown.map((d, i) => row(d, i, false))}</ul>
            : <EmptyState size="sm" art="search" title="No docs match" body={`Nothing called “${filter.trim()}”.`} action={<Button size="sm" onClick={() => setFilter("")}>Clear</Button>} />
        )}
        {load.state === "ready" && archived.length > 0 && (
          <section className="kdocs-archived" aria-label="Archived docs">
            <button type="button" className="kdocs-archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
              <Icon name="chevronRight" size={14} sw={1.9} />Archived <span className="kpj-count">{archived.length}</span>
            </button>
            {showArchived && <ul className="kdocs-list">{archived.map((d, i) => row(d, i, true))}</ul>}
          </section>
        )}
      </div>

      <Popover open={!!menuDoc} anchorRef={rowMenuAnchor} onClose={() => setRowMenu(null)} align="end" label={menuDoc ? `More for “${menuDoc.title || "Untitled"}”` : "More"} minWidth={200}>
        {menuDoc && (
          <>
            <button type="button" className="kmenu-item" onClick={() => { setRowMenu(null); onOpenDoc(menuDoc.id); }}><Icon name="arrowRight" size={16} sw={1.75} />Open</button>
            {!menuDoc.archivedAt && !q && (
              <>
                <button type="button" className="kmenu-item" disabled={menuIndex <= 0} onClick={() => { setRowMenu(null); moveBy(menuDoc.id, -1); }}>
                  <Icon name="arrowLeft" size={16} sw={1.75} style={{ transform: "rotate(90deg)" }} />Move up
                </button>
                <button type="button" className="kmenu-item" disabled={menuIndex >= active.length - 1} onClick={() => { setRowMenu(null); moveBy(menuDoc.id, 1); }}>
                  <Icon name="arrowRight" size={16} sw={1.75} style={{ transform: "rotate(90deg)" }} />Move down
                </button>
              </>
            )}
            <button type="button" className="kmenu-item" onClick={() => { setRowMenu(null); void setArchived(menuDoc, !menuDoc.archivedAt); }}>
              <Icon name="archive" size={16} sw={1.75} />{menuDoc.archivedAt ? "Unarchive" : "Archive"}
            </button>
            <hr className="kmenu-sep" />
            <button type="button" className="kmenu-item" data-tone="danger" onClick={() => { setRowMenu(null); setConfirm(menuDoc); }}><Icon name="trash" size={16} sw={1.75} />Delete…</button>
          </>
        )}
      </Popover>

      <Sheet open={!!confirm} onClose={() => setConfirm(null)} label="Delete this doc" title="Delete this doc?" width={440}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant="danger" loading={deleting} onClick={() => void remove()}>Delete doc</Button>
        </>}>
        <p className="kdoc-confirm">“{confirm?.title || "Untitled"}” and its version history will be deleted for everyone. This can't be undone. To keep it out of the way instead, archive it.</p>
      </Sheet>
      <p className="sr-only" role="status" aria-live="polite">{live}</p>
    </div>
  );
}

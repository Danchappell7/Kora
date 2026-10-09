/* ============================================================
   KANBO — the template library.                                [u9]
   A sheet: search, filter (All · Yours · Shared · Built-in), the
   templates down the left (each with its emoji tile, name and "6
   sub-tasks · 14 days"), the chosen one previewed on the right
   (TemplatePreview), with Use template, Edit (your own; owners and
   admins for shared ones), Share with the workspace (writers), Make a
   copy, and Delete (asks first, then Undo). "New template" and Edit
   open the editor (TemplateEditor) in the right-hand pane. Built-ins
   can be copied, not edited. On a phone the list and the template take
   turns, with Back between them.
   Keyboard: ↑/↓ (Home/End) move through the list and show each one;
   Enter uses it (when you can create tasks); Tab reaches its actions.
   Data: lib/templates (listLibraryTemplates…). Demo: in memory.
   ============================================================ */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, EmptyState, Icon, IconButton, Segmented, Sheet } from "../primitives";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { getMember } from "../../data/data";
import {
  createLibraryTemplate, deleteLibraryTemplate, matchTemplates, templateFailure, templateMeta, updateLibraryTemplate,
  type TemplateViewer,
} from "../../lib/templates";
import type { LibraryTemplate, TagDef } from "../../data/types";
import { useLibraryTemplates } from "./useLibraryTemplates";
import { TemplatePreview } from "./TemplatePreview";
import { TemplateEditor, type TemplateDraft } from "./TemplateEditor";
import { KIND_LABEL, TemplateTile, safeId, templateKind, useOptionalToast, type TemplateKind } from "./parts";
import { failureText } from "./failureText";
import "./templates.css";

export interface TemplateLibraryProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string | null;
  workspaceName?: string;
  currentUserId: string;
  /** writers in a team workspace */
  canShare: boolean;
  /** owners/admins: may edit / delete shared templates they didn't make */
  canManageShared?: boolean;
  /** "Use template": the host applies it (lib/templates planTemplate → its create paths). The library closes after. */
  onApply: (template: LibraryTemplate) => void;
  /** false for people who can't create tasks here (guests): no "Use template". Default true. */
  canApply?: boolean;
  /** open on this template, or "new" for a blank editor */
  initialTemplateId?: string;
  /** names for "Shared by …" (default: the app's member list) */
  members?: { id: string; name: string }[];
  /** the workspace's tags, to show a template's tags in their colours */
  tags?: Record<string, TagDef>;
}

type Filter = "all" | TemplateKind;
/* the editor holds the template it opened on (as previewed — a just-saved one may not be in
   the list until the library's reload lands), so Edit and Save never wait on that reload */
type Pane = { kind: "preview" } | { kind: "edit"; template: LibraryTemplate } | { kind: "new"; from?: LibraryTemplate };
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" }, { value: "yours", label: "Yours" }, { value: "shared", label: "Shared" }, { value: "builtin", label: "Built-in" },
];
const GROUP_LABEL: Record<TemplateKind, (ws: string) => string> = {
  yours: () => "Yours", shared: (ws) => `Shared in ${ws}`, builtin: () => "Built-in",
};
const BLANK: TemplateDraft = { name: "", emoji: null, body: { title: "" }, shared: false };

export function TemplateLibrary({
  open, onClose, workspaceId, workspaceName, currentUserId, canShare, canManageShared = false, onApply,
  canApply = true, initialTemplateId, members, tags,
}: TemplateLibraryProps) {
  const uid = safeId(useId());
  const isPhone = useMediaQuery("(max-width: 859px)");
  const toast = useOptionalToast();
  const { templates, status, failure, reload } = useLibraryTemplates(workspaceId, open);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>({ kind: "preview" });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "signal" | "ok"; text: string; undo?: () => void } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [phoneDetail, setPhoneDetail] = useState(false);
  // a template just saved here, shown as saved until the library's reload has it
  const [recent, setRecent] = useState<LibraryTemplate | null>(null);
  useEffect(() => { setRecent(null); }, [templates]);
  const dirtyRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ws = workspaceName || (workspaceId ? "this workspace" : "Personal");
  const viewer: TemplateViewer = { userId: currentUserId, workspaceId, canShare, canManageShared };

  // every opening starts fresh (on the template asked for, if any)
  useEffect(() => {
    if (!open) return;
    setQuery(""); setFilter("all"); setBusy(null); setMessage(null); setEditError(null); dirtyRef.current = false;
    if (initialTemplateId === "new") { setPane({ kind: "new" }); setSelectedId(null); setPhoneDetail(true); }
    else { setPane({ kind: "preview" }); setSelectedId(initialTemplateId ?? null); setPhoneDetail(!!initialTemplateId); }
  }, [open, initialTemplateId]);

  // opened on a template: once it's loaded, its heading takes focus (screen readers hear which)
  const arrivedRef = useRef(false);
  useEffect(() => { if (!open) arrivedRef.current = false; }, [open]);
  useEffect(() => {
    if (!open || arrivedRef.current || !initialTemplateId || initialTemplateId === "new" || status !== "ready") return;
    arrivedRef.current = true;
    window.setTimeout(() => headingRef.current?.focus(), 0);
  }, [open, initialTemplateId, status]);

  const nameOf = useCallback((id: string) => members?.find((m) => m.id === id)?.name ?? getMember(id)?.name, [members]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: templates.length, yours: 0, shared: 0, builtin: 0 };
    for (const t of templates) c[templateKind(t, currentUserId)]++;
    return c;
  }, [templates, currentUserId]);
  const shown = useMemo(() => {
    const inFilter = filter === "all" ? templates : templates.filter((t) => templateKind(t, currentUserId) === filter);
    return query.trim() ? matchTemplates(query, inFilter) : inFilter;
  }, [templates, filter, query, currentUserId]);
  // grouped (Yours · Shared · Built-in) unless a search ranks them
  const groups = useMemo(() => {
    if (query.trim()) return [{ kind: null as TemplateKind | null, items: shown }];
    const order: TemplateKind[] = ["yours", "shared", "builtin"];
    return order.map((k) => ({ kind: k as TemplateKind | null, items: shown.filter((t) => templateKind(t, currentUserId) === k) })).filter((g) => g.items.length);
  }, [shown, query, currentUserId]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const selected = (recent && recent.id === selectedId ? recent : null) ?? templates.find((t) => t.id === selectedId) ?? null;
  // on a wide screen something's always previewed: the first one shown, if nothing (or something hidden) is chosen
  useEffect(() => {
    if (!open || isPhone || pane.kind !== "preview") return;
    if (!flat.length || (recent && recent.id === selectedId)) return;
    if (!selectedId || !flat.some((t) => t.id === selectedId)) setSelectedId(flat[0].id);
  }, [open, isPhone, pane.kind, flat, selectedId, recent]);

  const requestClose = () => {
    if ((pane.kind === "edit" || pane.kind === "new") && dirtyRef.current && !window.confirm("Discard your changes to this template?")) return;
    onClose();
  };

  const focusCard = (id: string | null) => window.setTimeout(() => {
    const el = id ? [...(listRef.current?.querySelectorAll<HTMLElement>("[data-id]") ?? [])].find((x) => x.dataset.id === id) : null;
    (el ?? searchRef.current)?.focus();
  }, 0);
  const focusHeading = () => window.setTimeout(() => headingRef.current?.focus(), 0);

  const choose = (id: string, opts: { open?: boolean } = {}) => {
    if (pane.kind !== "preview" && dirtyRef.current && !window.confirm("Discard your changes to this template?")) return;
    setSelectedId(id); setPane({ kind: "preview" }); setEditError(null); dirtyRef.current = false;
    if (isPhone && opts.open) { setPhoneDetail(true); focusHeading(); }
  };
  const use = (t: LibraryTemplate) => { if (!canApply) return; onApply(t); onClose(); };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!flat.length) return;
    const i = Math.max(0, flat.findIndex((t) => t.id === selectedId));
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(flat.length - 1, i + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, i - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = flat.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const t = flat[i];
      if (!t) return;
      if (isPhone) choose(t.id, { open: true });
      else if (e.key === "Enter" && canApply) use(t);
      else focusHeading();
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    choose(flat[next].id);
    focusCard(flat[next].id);
  };

  /* ---- actions ---- */
  const fail = (e: unknown) => setMessage({ tone: "signal", text: failureText(templateFailure(e)) });
  const run = async (key: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(key); setMessage(null);
    try { await work(); } catch (e) { fail(e); } finally { setBusy(null); }
  };

  const save = (draft: TemplateDraft) => {
    if (busy) return;
    setBusy("save"); setEditError(null);
    const editing = pane.kind === "edit" ? pane.template : undefined;
    const work = editing
      ? updateLibraryTemplate(editing.id, {
        name: draft.name, emoji: draft.emoji, body: draft.body,
        ...(editing.userId === currentUserId && editing.workspaceId === workspaceId && workspaceId !== null && canShare ? { shared: draft.shared } : {}),
      })
      : createLibraryTemplate({ workspaceId, name: draft.name, emoji: draft.emoji, body: draft.body, shared: !!workspaceId && canShare && draft.shared });
    work.then((t) => {
      dirtyRef.current = false;
      setRecent(t); setSelectedId(t.id); setPane({ kind: "preview" }); setFilter((f) => (f === "builtin" ? "all" : f));
      const text = editing ? `Saved “${t.name}”` : t.shared ? `Created “${t.name}” and shared it with ${ws}` : `Created “${t.name}”`;
      if (toast) toast.success(text); else setMessage({ tone: "ok", text });
      focusHeading();
    }, (e) => setEditError(failureText(templateFailure(e)))).finally(() => setBusy(null));
  };

  const toggleShare = (t: LibraryTemplate, next: boolean) => run("share", async () => {
    setRecent(await updateLibraryTemplate(t.id, { shared: next }));
    const text = next ? `Shared “${t.name}” with ${ws}` : `“${t.name}” is only yours now`;
    if (toast) toast.success(text); else setMessage({ tone: "ok", text });
  });
  const shareCopy = (t: LibraryTemplate) => run("share-copy", async () => {
    const copy = await createLibraryTemplate({ workspaceId, name: t.name, emoji: t.emoji, body: t.body, shared: true });
    setRecent(copy); setSelectedId(copy.id);
    const text = `Shared a copy of “${t.name}” with ${ws}`;
    if (toast) toast.success(text); else setMessage({ tone: "ok", text });
    focusHeading();
  });
  const remove = (t: LibraryTemplate) => run("delete", async () => {
    const i = flat.findIndex((x) => x.id === t.id);
    await deleteLibraryTemplate(t.id);
    const neighbour = flat[i + 1] ?? flat[i - 1] ?? null;
    setSelectedId(neighbour?.id ?? null);
    if (isPhone) setPhoneDetail(false);
    // Undo makes it again (a new copy, with what it had; shared again if it was)
    const restore = () => {
      createLibraryTemplate({ workspaceId: t.workspaceId, name: t.name, emoji: t.emoji, body: t.body, shared: t.shared && !!t.workspaceId })
        .then((back) => { setRecent(back); setSelectedId(back.id); setMessage(null); }, fail);
    };
    const text = `Deleted “${t.name}”`;
    if (toast) toast.action(text, "Undo", restore);
    else setMessage({ tone: "ok", text, undo: restore });
    focusCard(neighbour?.id ?? null);
  });

  const startEdit = (t: LibraryTemplate) => { setEditError(null); dirtyRef.current = false; setPane({ kind: "edit", template: t }); };
  const startNew = (from?: LibraryTemplate) => {
    if (pane.kind !== "preview" && dirtyRef.current && !window.confirm("Discard your changes to this template?")) return;
    setEditError(null); dirtyRef.current = false; setPane({ kind: "new", from }); if (isPhone) setPhoneDetail(true);
  };
  const cancelEdit = () => {
    if (dirtyRef.current && !window.confirm("Discard your changes to this template?")) return;
    const wasNew = pane.kind === "new";
    dirtyRef.current = false; setPane({ kind: "preview" }); setEditError(null);
    if (wasNew && isPhone && !selectedId) setPhoneDetail(false);
    if (selectedId) focusHeading(); else focusCard(null);
  };
  const back = () => { setPhoneDetail(false); focusCard(selectedId); };

  /* ---- what the right-hand pane shows ---- */
  const editing = pane.kind === "edit" ? pane.template : undefined;
  const draftFor = (): TemplateDraft => {
    if (editing) return { name: editing.name, emoji: editing.emoji, body: editing.body, shared: editing.shared };
    if (pane.kind === "new" && pane.from) return { name: `${pane.from.name} (copy)`.slice(0, 80), emoji: pane.from.emoji, body: pane.from.body, shared: false };
    return BLANK;
  };
  const canShareNew = canShare && workspaceId !== null;
  const editorShare = pane.kind === "edit"
    ? !!editing && editing.userId === currentUserId && editing.workspaceId === workspaceId && canShareNew
    : canShareNew;

  const loading = status === "loading" || status === "idle";
  const showList = !isPhone || !phoneDetail;
  const showPane = !isPhone || phoneDetail;
  const listLabelId = `ktpl-list-${uid}`;

  const paneBody = pane.kind === "edit" || pane.kind === "new" ? (
    <TemplateEditor key={pane.kind === "edit" ? pane.template.id : `new-${pane.from?.id ?? ""}`} mode={pane.kind === "edit" ? "edit" : "new"}
      initial={draftFor()} tileId={pane.kind === "edit" ? pane.template.id : "new"} canShareHere={editorShare} workspaceName={ws}
      busy={busy === "save"} error={editError} onSave={save} onCancel={cancelEdit} onDirtyChange={(d) => { dirtyRef.current = d; }} />
  ) : selected ? (
    <TemplatePreview template={selected} viewer={viewer} workspaceName={ws} memberName={nameOf} tags={tags} canApply={canApply}
      busy={busy} headingRef={headingRef} onUse={() => use(selected)} onEdit={() => startEdit(selected)} onCopy={() => startNew(selected)}
      onToggleShare={(next) => toggleShare(selected, next)} onShareCopy={() => shareCopy(selected)} onDelete={() => remove(selected)} />
  ) : loading ? null : (
    <EmptyState art="layers" size="sm" title="Pick a template" body="Choose one on the left to see what it makes." />
  );

  return (
    <Sheet open={open} onClose={requestClose} label="Template library" title="Templates" width={1000}
      initialFocus={searchRef as React.RefObject<HTMLElement>}>
      <div className="ktpl" data-phone={isPhone || undefined}>
        {showList && (
          <div className="ktpl-bar">
            <label className="ktpl-search">
              <Icon name="search" size={16} sw={1.75} />
              <span className="sr-only">Search templates</span>
              <input ref={searchRef} type="search" className="kfield" value={query} placeholder="Search templates" autoComplete="off"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
                  else if (e.key === "ArrowDown" && flat.length) { e.preventDefault(); choose(flat[0].id); focusCard(flat[0].id); }
                }} />
            </label>
            <Segmented<Filter> ariaLabel="Show" value={filter} onChange={setFilter}
              options={FILTERS.map((f) => ({ value: f.value, label: f.value === "all" || !counts[f.value] ? f.label : `${f.label} ${counts[f.value]}` }))} />
            <span className="ktpl-spacer" />
            <Button variant="primary" icon="plus" onClick={() => startNew()} disabled={busy === "save"}
              aria-label={isPhone ? "New template" : undefined}>{isPhone ? null : "New template"}</Button>
          </div>
        )}

        {message && (
          <p className="ktpl-msg" data-tone={message.tone} role={message.tone === "signal" ? "alert" : "status"}>
            <span>{message.text}</span>
            {message.undo && <Button size="sm" variant="ghost" icon="undo" onClick={message.undo}>Undo</Button>}
            <IconButton icon="x" size="sm" label="Dismiss" onClick={() => setMessage(null)} />
          </p>
        )}

        <div className="ktpl-main">
          {showList && (
            <div className="ktpl-listcol">
              <p id={listLabelId} className="sr-only">
                Templates{query.trim() ? ` matching “${query.trim()}”` : ""}, {flat.length}. Up and down to look through them{canApply ? ", Enter to use one" : ""}.
              </p>
              {loading && !templates.length ? (
                <div className="ktpl-skel" aria-busy="true" aria-label="Loading templates">
                  {Array.from({ length: 6 }, (_, i) => <span key={i} className="ktpl-skel-row" />)}
                </div>
              ) : status === "error" && !templates.length ? (
                <EmptyState art="layers" size="sm" title="Couldn't load templates" body={failureText(failure ?? "error")}
                  action={<Button size="sm" icon="refresh" onClick={reload}>Try again</Button>} />
              ) : !flat.length ? (
                query.trim() ? (
                  <EmptyState art="search" size="sm" title={`No templates match “${query.trim()}”`} body="Try fewer letters, or another filter."
                    action={<Button size="sm" variant="ghost" onClick={() => { setQuery(""); setFilter("all"); searchRef.current?.focus(); }}>Clear search</Button>} />
                ) : filter === "yours" ? (
                  <EmptyState art="layers" size="sm" title="None of your own yet"
                    body="Save any task as a template from its ⋯ menu, or make one from scratch."
                    action={<Button size="sm" icon="plus" onClick={() => startNew()}>New template</Button>} />
                ) : filter === "shared" ? (
                  <EmptyState art="users" size="sm" title={workspaceId ? `Nothing shared in ${ws} yet` : "Nothing's shared in Personal"}
                    body={workspaceId ? "Templates you share here show up for everyone in the workspace." : "Switch to a team workspace to share templates with it."} />
                ) : (
                  <EmptyState art="layers" size="sm" title="No templates" />
                )
              ) : (
                <div ref={listRef} role="listbox" aria-labelledby={listLabelId} className="ktpl-list" onKeyDown={onListKey}>
                  {groups.map((g) => (
                    <div key={g.kind ?? "results"} role="group" aria-label={g.kind ? GROUP_LABEL[g.kind](ws) : "Results"} className="ktpl-group">
                      {g.kind && groups.length > 0 && <div className="ktpl-group-label" aria-hidden="true">{GROUP_LABEL[g.kind](ws)}<span>{g.items.length}</span></div>}
                      {g.items.map((t) => {
                        const on = t.id === (selectedId ?? flat[0]?.id);
                        const kind = templateKind(t, currentUserId);
                        return (
                          <div key={t.id} role="option" aria-selected={on} data-id={t.id}
                            tabIndex={on ? 0 : -1} className="ktpl-card" data-current={t.id === selectedId || undefined}
                            onClick={() => choose(t.id, { open: true })} onDoubleClick={() => { if (!isPhone) use(t); }}>
                            <TemplateTile template={t} size={28} />
                            <span className="ktpl-card-text">
                              <span className="ktpl-card-name">{t.name}</span>
                              <span className="ktpl-card-meta">
                                {query.trim() && kind !== "yours" ? `${KIND_LABEL[kind]} · ` : ""}
                                {t.shared && kind === "yours" ? "Shared · " : ""}{templateMeta(t.body)}
                              </span>
                            </span>
                            {isPhone && <Icon name="chevronRight" size={16} sw={1.75} />}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {showPane && (
            <section className="ktpl-pane" aria-label={pane.kind === "preview" ? "Template" : pane.kind === "new" ? "New template" : "Edit template"}>
              {isPhone && (
                <div className="ktpl-back">
                  <Button size="sm" variant="ghost" icon="chevronLeft" onClick={pane.kind === "preview" ? back : cancelEdit}>
                    {pane.kind === "preview" ? "All templates" : "Cancel"}
                  </Button>
                </div>
              )}
              {pane.kind !== "preview" && <h3 className="ktpl-pane-title">{pane.kind === "new" ? (pane.from ? `Copy of ${pane.from.name}` : "New template") : "Edit template"}</h3>}
              {paneBody}
            </section>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/* ============================================================
   KANBO — save / edit a view.
   SavedViewEditor: a small sheet — name, emoji (the primitives'
   EmojiPicker), "Pin to sidebar", "Share with <workspace>" (writers only;
   explains that everyone in the workspace will see it, read-only for
   guests), what it shows (a readable summary of the filters, grouping and
   sort), Save / Delete (with confirm). SaveViewButton: the toolbar button
   that appears in list / board / search toolbars when filters are active
   ("Save view"), opening the editor prefilled — or, with the view the page
   is showing (`appliedView`) and changed filters, a menu: "Update “…”" /
   "Save as a new view…". Both through lib/views (createSavedView /
   updateSavedView / stageDeleteSavedView); a delete has Undo. Keyboard and
   screen-reader complete (labels, live errors, focus kept in the sheet);
   demo mode works (in memory). Lazy: never in the first download.
   ============================================================ */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, EmojiPicker, Icon, Sheet, Toggle } from "../primitives";
import { Popover } from "../primitives/Popover";
import { useToast } from "../Toast";
import { getMember } from "../../data/data";
import type { SavedView, SavedViewKind, SavedViewQuery } from "../../data/types";
import {
  createSavedView, updateSavedView, stageDeleteSavedView, savedViewFailure, isLegacyView, SAVED_VIEW_LIMITS,
} from "../../lib/views";
import { describeView } from "../../lib/savedViews/describe";
import { savedViewMessage } from "../../lib/savedViews/messages";
import { viewIcon } from "../savedViews/ViewGlyph";
import "../savedViews/savedViews.css";

export interface SavedViewEditorProps {
  open: boolean;
  /** editing this view; absent = a new one from `draft` */
  view?: SavedView | null;
  /** a new view: what it saves */
  draft?: { kind: SavedViewKind; query: SavedViewQuery; name?: string; emoji?: string | null } | null;
  /** the scope it's saved in (null = Personal) and its name ("Share with Foundrise") */
  workspaceId: string | null;
  workspaceName?: string;
  /** writers in a team workspace (lib/views canShareViews) */
  canShare: boolean;
  /** owner/admin editing someone else's shared view, or your own (lib/views canEditView) */
  canEdit?: boolean;
  onClose: () => void;
  onSaved?: (view: SavedView) => void;
  onDeleted?: (id: string) => void;
  /** who is editing (says "Made by Sana" on someone else's shared view) */
  currentUserId?: string;
  /** open with the icon picker showing (the sidebar's "Change icon…") */
  pickIcon?: boolean;
}

/** Same query? (key order ignored) */
export function sameViewQuery(a: SavedViewQuery | undefined, b: SavedViewQuery | undefined): boolean {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, norm(x)]));
    }
    return v;
  };
  return JSON.stringify(norm(a ?? { v: 1 })) === JSON.stringify(norm(b ?? { v: 1 }));
}

export function SavedViewEditor({ open, view, draft, workspaceId, workspaceName, canShare, canEdit = true, onClose, onSaved, onDeleted, currentUserId, pickIcon }: SavedViewEditorProps) {
  const toast = useToast();
  const ids = useId();
  const editing = !!view;
  const legacy = !!view && isLegacyView(view.id);
  const kind: SavedViewKind = view?.kind ?? draft?.kind ?? "my_tasks";
  const query: SavedViewQuery = view?.query ?? draft?.query ?? { v: 1 };
  const scope = view ? view.workspaceId : workspaceId;
  const wsName = workspaceName || "your workspace";
  const shareHere = canShare && scope !== null && !legacy;

  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true);
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [picking, setPicking] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // every opening starts from the view (or the draft), decided while rendering so nothing stale flashes
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setName(view?.name ?? draft?.name ?? "");
      setEmoji(view ? view.emoji : draft?.emoji ?? null);
      setPinned(view ? view.pinned : true);
      setShared(view ? view.shared : false);
      setBusy(false); setError(null); setConfirming(false);
      setPicking(!!pickIcon && (!view || canEdit) && !(view && isLegacyView(view.id)));
    }
  }

  const desc = useMemo(() => describeView(kind, query, { viewer: currentUserId, workspaceName: (id) => (id === scope ? workspaceName : undefined) }), [kind, query, currentUserId, scope, workspaceName]);
  const trimmed = name.trim();
  const tooLong = trimmed.length > SAVED_VIEW_LIMITS.name;
  const maker = view && currentUserId && view.userId !== currentUserId ? getMember(view.userId)?.name ?? "a teammate" : null;
  const readOnly = editing && !canEdit;

  const fail = (e: unknown, action: "save" | "change" | "delete") => {
    if (!alive.current) return;
    setBusy(false);
    setError(savedViewMessage(savedViewFailure(e), action));
  };

  const save = async () => {
    if (busy || readOnly) return;
    if (!trimmed || tooLong) { setError(!trimmed ? "Give the view a name." : `Keep the name under ${SAVED_VIEW_LIMITS.name + 1} characters.`); nameRef.current?.focus(); return; }
    setBusy(true); setError(null);
    try {
      if (view) {
        const patch: Parameters<typeof updateSavedView>[1] = {};
        if (trimmed !== view.name) patch.name = trimmed;
        if (!legacy && (emoji || null) !== (view.emoji || null)) patch.emoji = emoji || null;
        if (!legacy && pinned !== view.pinned) patch.pinned = pinned;
        if (shareHere && shared !== view.shared) patch.shared = shared;
        const saved = Object.keys(patch).length ? await updateSavedView(view.id, patch) : view;
        if (!alive.current) return;
        onSaved?.(saved);
      } else {
        const saved = await createSavedView({ workspaceId, name: trimmed, emoji: emoji || null, kind, query, pinned, shared: shareHere && shared });
        if (!alive.current) return;
        toast.success(pinned ? `Saved “${saved.name}” to your sidebar` : `Saved “${saved.name}”`);
        onSaved?.(saved);
      }
      setBusy(false);
      onClose();
    } catch (e) { fail(e, view ? "change" : "save"); }
  };

  const remove = () => {
    if (!view || readOnly) return;
    const staged = stageDeleteSavedView(view.id);
    const label = view.name;
    toast.action(`Deleted “${label}”`, "Undo", staged.undo, {
      onExpire: () => { staged.commit().catch((e: unknown) => toast.error(`Couldn't delete “${label}”. ${savedViewMessage(savedViewFailure(e), "delete")}`)); },
    });
    onDeleted?.(view.id);
    onClose();
  };

  const title = readOnly ? "View" : editing ? "Edit view" : "Save view";
  const footer = readOnly ? (
    <Button variant="primary" onClick={onClose}>Done</Button>
  ) : (
    <>
      {editing && (confirming ? (
        <span className="ksv-confirm" role="group" aria-label="Confirm delete">
          <span>{view!.shared ? `Delete it for everyone in ${wsName}?` : "Delete this view?"}</span>
          <Button variant="danger" size="sm" onClick={remove}>Delete</Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Keep</Button>
        </span>
      ) : (
        <Button variant="ghost" icon="trash" style={{ marginRight: "auto" }} onClick={() => setConfirming(true)} disabled={busy}>Delete</Button>
      ))}
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon={editing ? "check" : "plus"} loading={busy} onClick={() => { void save(); }} disabled={!trimmed}>
        {editing ? "Save" : "Save view"}
      </Button>
    </>
  );

  return (
    <Sheet open={open} onClose={onClose} label={title} title={title} width={480} initialFocus={nameRef} footer={footer}>
      <form className="ksv" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div>
          <div className="ksv-name">
            <button ref={emojiRef} type="button" className="ksv-emoji" disabled={readOnly || legacy}
              aria-label={emoji ? `Icon ${emoji}. Change the icon` : "Choose an icon"} aria-haspopup="dialog" aria-expanded={picking}
              onClick={() => setPicking((v) => !v)}>
              {emoji || <Icon name={viewIcon({ kind, query })} size={16} sw={1.75} />}
            </button>
            <input ref={nameRef} id={`${ids}-name`} className="kfield" data-size="lg" value={name} readOnly={readOnly}
              onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); } }}
              placeholder="Name this view" aria-label="View name" aria-invalid={tooLong || undefined}
              aria-describedby={tooLong ? `${ids}-count` : undefined} autoComplete="off" spellCheck />
          </div>
          {trimmed.length > SAVED_VIEW_LIMITS.name - 20 && (
            <p id={`${ids}-count`} className="ksv-count" data-tone={tooLong ? "signal" : undefined}>
              {trimmed.length} / {SAVED_VIEW_LIMITS.name}
            </p>
          )}
          <Popover open={picking} anchorRef={emojiRef} onClose={() => setPicking(false)} role="dialog" label="Choose an icon" minWidth={268} style={{ padding: 4 }}>
            <div className="ksv-picker">
              <button type="button" className="ksv-picker-none" aria-pressed={!emoji} onClick={() => { setEmoji(null); setPicking(false); }}>
                <Icon name={viewIcon({ kind, query })} size={16} sw={1.75} />No icon
              </button>
              <EmojiPicker onPick={(e) => { setEmoji(e); setPicking(false); }} />
            </div>
          </Popover>
        </div>

        <section aria-labelledby={`${ids}-shows`}>
          <h3 id={`${ids}-shows`} className="ksv-label">What it shows</h3>
          <p className="ksv-where"><Icon name={viewIcon({ kind, query })} size={16} sw={1.75} />{desc.where}</p>
          {desc.parts.length ? (
            <ul className="ksv-parts" aria-label="Filters, grouping and sort">
              {desc.parts.map((p) => <li key={p}>{p}</li>)}
            </ul>
          ) : (
            <p className="ksv-quiet">No filters: everything in this list.</p>
          )}
        </section>

        <div className="ksv-toggles">
          <Toggle label="Pin to sidebar" checked={pinned} onChange={setPinned} disabled={readOnly || legacy}
            description={view?.shared ? "Pinned shared views show in everyone's sidebar, with a live count." : "Shows under My tasks with a live count."} />
          {shareHere && (
            <Toggle label={`Share with ${wsName}`} checked={shared} onChange={setShared} disabled={readOnly}
              description={`Everyone in ${wsName} can open it. Guests can use it but not change it.`} />
          )}
          {legacy ? (
            <p className="ksv-note"><Icon name="alert" size={14} sw={1.75} />An older saved search: you can rename it here. Icons, pinning and sharing arrive once your workspace is updated.</p>
          ) : maker ? (
            <p className="ksv-note"><Icon name="users" size={14} sw={1.75} />Made by {maker}. {readOnly ? `Shared with ${wsName}.` : `Your changes apply for everyone in ${wsName}.`}</p>
          ) : scope === null ? (
            <p className="ksv-note"><Icon name="lock" size={14} sw={1.75} />Personal views are only for you.</p>
          ) : !canShare && !readOnly ? (
            <p className="ksv-note"><Icon name="lock" size={14} sw={1.75} />Only you will see this view.</p>
          ) : null}
        </div>

        {error && <p id={`${ids}-err`} className="ksv-error" role="alert"><Icon name="alert" size={14} sw={1.75} />{error}</p>}
      </form>
    </Sheet>
  );
}

export interface SaveViewButtonProps {
  kind: SavedViewKind;
  /** the toolbar's current filters / grouping / sort as a view query */
  query: SavedViewQuery;
  /** show only when something is filtered (the host decides; false renders nothing) */
  active: boolean;
  workspaceId: string | null;
  workspaceName?: string;
  canShare: boolean;
  /** suggested name ("Blocked in Launch") */
  suggestedName?: string;
  size?: "sm" | "md";
  onSaved?: (view: SavedView) => void;
  /** the saved view the page is showing (route.savedViewId): with changed filters, offer to update it */
  appliedView?: SavedView | null;
  /** may this person change `appliedView`? (lib/views canEditView) */
  canEditApplied?: boolean;
  currentUserId?: string;
}

export function SaveViewButton({ kind, query, active, workspaceId, workspaceName, canShare, suggestedName, size = "sm", onSaved, appliedView, canEditApplied, currentUserId }: SaveViewButtonProps) {
  const toast = useToast();
  const [editor, setEditor] = useState(false);
  const [menu, setMenu] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const draft = useMemo(() => ({ kind, query, name: suggestedName }), [kind, query, suggestedName]);
  const canUpdate = !!appliedView && !!canEditApplied && appliedView.kind === kind && !isLegacyView(appliedView.id) && !sameViewQuery(appliedView.query, query);
  if (!active && !editor) return null;

  const update = () => {
    setMenu(false);
    if (!appliedView) return;
    updateSavedView(appliedView.id, { query })
      .then((v) => { toast.success(`Updated “${v.name}”`); onSaved?.(v); })
      .catch((e: unknown) => toast.error(savedViewMessage(savedViewFailure(e), "change")));
  };

  return (
    <>
      {active && (
        <Button ref={btnRef} variant="ghost" size={size} icon="plus" iconRight={canUpdate ? "chevronDown" : undefined}
          aria-haspopup={canUpdate ? "menu" : "dialog"} aria-expanded={canUpdate ? menu : editor}
          onClick={() => (canUpdate ? setMenu((v) => !v) : setEditor(true))}>
          Save view
        </Button>
      )}
      {canUpdate && (
        <Popover open={menu} anchorRef={btnRef} onClose={() => setMenu(false)} label="Save view" minWidth={220} align="end">
          <button type="button" className="kmenu-item" onClick={update}>
            <Icon name="refresh" size={16} sw={1.75} /><span className="truncate">Update “{appliedView!.name}”</span>
          </button>
          <button type="button" className="kmenu-item" onClick={() => { setMenu(false); setEditor(true); }}>
            <Icon name="plus" size={16} sw={1.75} />Save as a new view…
          </button>
        </Popover>
      )}
      <SavedViewEditor open={editor} draft={draft} workspaceId={workspaceId} workspaceName={workspaceName} canShare={canShare}
        currentUserId={currentUserId} onClose={() => setEditor(false)} onSaved={onSaved} />
    </>
  );
}

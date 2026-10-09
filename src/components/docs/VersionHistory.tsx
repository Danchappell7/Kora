/* ============================================================
   KANBO — a doc's version history (a right-hand sheet).      [0047, w5]
   The last 50 versions, newest first (one per ten minutes of one
   person's editing; someone else saving starts a new one). Pick one to
   read it; Restore puts its title and contents back as a new edit, so
   nothing is lost — the version you had stays in the list.
   ============================================================ */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DocBlock, Member, ProjectDocVersion, Task } from "../../data/types";
import { Avatar, Button, EmptyState, Sheet } from "../primitives";
import { getMember } from "../../data/data";
import { docAgo, docErrorText, getDocVersion, listDocVersions } from "../../lib/docs";
import { DocBlocksView, type NameOf } from "./DocView";

/** "Today, 14:32" · "Yesterday, 09:05" · "Mon 6 Oct, 16:40" · "6 Oct 2025, 16:40". */
export function versionWhen(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (t: Date) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const diff = Math.round((day(new Date(now)) - day(d)) / 86400000);
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString("en-GB", sameYear ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  return `${date}, ${time}`;
}

type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "problem"; message: string };

export function VersionHistory({ open, onClose, docId, members, nameOf, tasks, canRestore, onRestore }: {
  open: boolean;
  onClose: () => void;
  docId: string;
  members: Member[];
  nameOf: NameOf;
  tasks: ReadonlyMap<string, Task>;
  /** guests and archived docs can look but not restore */
  canRestore: boolean;
  onRestore: (v: { title: string; body: DocBlock[]; savedAt: string }) => void;
}) {
  const [list, setList] = useState<Load<ProjectDocVersion[]>>({ state: "loading" });
  const [picked, setPicked] = useState<string | null>(null);
  const [preview, setPreview] = useState<Load<ProjectDocVersion | null> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, "");

  useEffect(() => {
    if (!open) return;
    let live = true;
    setList({ state: "loading" });
    setPicked(null);
    setPreview(null);
    listDocVersions(docId).then(
      (v) => { if (live) { setList({ state: "ready", value: v }); if (v[0]) setPicked(v[0].id); } },
      (e) => { if (live) setList({ state: "problem", message: docErrorText(e) }); },
    );
    return () => { live = false; };
  }, [open, docId, reloadKey]);

  useEffect(() => {
    if (!picked) return;
    let live = true;
    setPreview({ state: "loading" });
    getDocVersion(picked).then(
      (v) => { if (live) setPreview({ state: "ready", value: v }); },
      (e) => { if (live) setPreview({ state: "problem", message: docErrorText(e) }); },
    );
    return () => { live = false; };
  }, [picked]);

  const versions = list.state === "ready" ? list.value : [];
  const who = (id: string | null) => (id ? members.find((m) => m.id === id)?.name ?? getMember(id)?.name ?? "Someone" : "Someone");
  const current = versions[0]?.id ?? null;
  const shown = preview?.state === "ready" ? preview.value : null;
  const isCurrent = picked === current;

  // arrow keys move through the list (a listbox: one tab stop)
  const onListKey = (e: React.KeyboardEvent) => {
    if (!versions.length) return;
    const i = Math.max(0, versions.findIndex((v) => v.id === picked));
    const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? versions.length - 1 : null;
    if (next == null) return;
    e.preventDefault();
    const v = versions[Math.max(0, Math.min(versions.length - 1, next))];
    setPicked(v.id);
    listRef.current?.querySelector<HTMLElement>(`[data-version="${v.id}"]`)?.scrollIntoView?.({ block: "nearest" });
  };

  const words = useMemo(() => (shown?.body ? shown.body.reduce((n, b) => n + (b.spans ?? []).reduce((m, s) => m + s.text.split(/\s+/).filter(Boolean).length, 0), 0) : 0), [shown]);

  return (
    <Sheet open={open} onClose={onClose} label="Version history" title="Version history" side="right" width={520}
      footer={
        <>
          <span className="kdoc-vh-foot-note">{isCurrent ? "This is the current version." : shown ? `Restoring keeps the current version in this list.` : ""}</span>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {canRestore && (
            <Button variant="primary" icon="undo" disabled={!shown || isCurrent || !shown.body}
              onClick={() => { if (shown?.body) { onRestore({ title: shown.title, body: shown.body, savedAt: shown.savedAt }); onClose(); } }}>
              Restore this version
            </Button>
          )}
        </>
      }>
      <div className="kdoc-vh">
        {list.state === "loading" && (
          <div className="kdoc-vh-list" aria-busy="true" aria-label="Loading versions">
            {[0, 1, 2].map((i) => <div key={i} className="kskel" style={{ height: 44 }} />)}
          </div>
        )}
        {list.state === "problem" && (
          <EmptyState size="sm" title="Couldn't load the history" body={list.message}
            action={<Button size="sm" onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>} />
        )}
        {list.state === "ready" && !versions.length && (
          <EmptyState size="sm" art="layers" title="No versions yet" body="A version is kept each time someone saves, one per ten minutes of their editing." />
        )}
        {list.state === "ready" && versions.length > 0 && (
          <>
            <div ref={listRef} className="kdoc-vh-list" role="listbox" aria-label="Versions, newest first" tabIndex={0}
              aria-activedescendant={picked ? `${uid}-${picked}` : undefined} onKeyDown={onListKey}>
              {versions.map((v, i) => (
                <div key={v.id} id={`${uid}-${v.id}`} data-version={v.id} role="option" aria-selected={v.id === picked}
                  className="kdoc-vh-row" onClick={() => setPicked(v.id)}>
                  {v.savedBy ? <Avatar id={v.savedBy} size={24} /> : <span className="kdoc-vh-dot" aria-hidden="true" />}
                  <span className="kdoc-vh-main">
                    <span className="kdoc-vh-when">{versionWhen(v.savedAt)}</span>
                    <span className="kdoc-vh-who">{who(v.savedBy)}{i === 0 ? " · current" : ` · ${docAgo(v.savedAt)}`}</span>
                  </span>
                </div>
              ))}
            </div>
            <section className="kdoc-vh-preview" aria-label="The version you picked" aria-busy={preview?.state === "loading" || undefined}>
              {preview?.state === "loading" && <div className="kskel" style={{ height: 120 }} />}
              {preview?.state === "problem" && <p className="kdoc-vh-note" role="alert">{preview.message}</p>}
              {preview?.state === "ready" && !shown && <p className="kdoc-vh-note">That version has gone (only the last 50 are kept).</p>}
              {shown && (
                <>
                  <p className="kdoc-vh-meta">{words === 1 ? "1 word" : `${words.toLocaleString("en-GB")} words`}</p>
                  <h2 className="kdoc-vh-title">{shown.title || "Untitled"}</h2>
                  <DocBlocksView blocks={shown.body ?? []} nameOf={nameOf} tasks={tasks} emptyText="This version was empty." />
                </>
              )}
            </section>
          </>
        )}
      </div>
    </Sheet>
  );
}

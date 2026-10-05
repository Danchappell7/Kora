/* ============================================================
   KANBO — Notion pages linked to a task (TaskDetail).            [0046 · a3]
   One chip per linked page (icon, title, "edited 2h ago", opens Notion
   in a new tab; a synced page says so), plus "Link a page" (paste a URL)
   for people who can edit the task when the workspace has Notion
   connected. Personal tasks, and workspaces without Notion and with no
   links: renders nothing. Links stay visible after Notion is disconnected
   (read from the cache); they just can't be added to.
   Data: lib/notion (links stream over realtime; a chip whose page details
   are missing or over an hour old asks the notion function once).
   Mount (integrator): in TaskDetail after the Files section —
     <NotionLinkChip taskId={task.id} workspaceId={workspaceOfTask} canEdit={!readOnly} />
   ============================================================ */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { NotionLink, NotionStatus } from "../data/types";
import { Button, Icon, IconButton } from "./primitives";
import { timeAgo } from "../data/data";
import {
  NOTION_COPY, NotionError, linkNotionPage, listTaskNotionLinks, loadNotionStatus, notionPageUrl, parseNotionId,
  refreshNotionPage, subscribeTaskNotionLinks, unlinkNotionPage,
} from "../lib/notion";
import "./notionLink.css";

export interface NotionLinkChipProps {
  taskId: string;
  /** the task's workspace (null = personal task → nothing) */
  workspaceId: string | null;
  /** may this person change the task (not a guest) */
  canEdit: boolean;
}

const STALE_MS = 60 * 60_000;

/** An emoji, or an image from Notion (its links expire: a broken one falls back). */
function PageIcon({ icon }: { icon: string | null }) {
  const [broken, setBroken] = useState(false);
  if (icon && /^https:\/\//.test(icon) && !broken) {
    return <img className="knl-ico" src={icon} alt="" width={16} height={16} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return <span className="knl-ico" aria-hidden="true">{icon && !/^https:/.test(icon) ? icon : "📄"}</span>;
}

export function NotionLinkChip({ taskId, workspaceId, canEdit }: NotionLinkChipProps) {
  const ids = "knl" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [status, setStatus] = useState<NotionStatus | null>(null);
  const [links, setLinks] = useState<NotionLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [ask, setAsk] = useState(0);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const refreshed = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // status (once per workspace) and the task's links (again whenever they change)
  useEffect(() => {
    if (!workspaceId) return;
    let on = true;
    loadNotionStatus(workspaceId).then((s) => { if (on) setStatus(s); }).catch(() => { if (on) setStatus(null); });
    return () => { on = false; };
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceId) return;
    let on = true;
    listTaskNotionLinks(taskId, workspaceId)
      .then((l) => { if (on) { setLinks(l); setLoaded(true); } })
      .catch(() => { if (on) setLoaded(true); });
    return () => { on = false; };
  }, [taskId, workspaceId, ask]);
  useEffect(() => (workspaceId ? subscribeTaskNotionLinks(taskId, () => setAsk((n) => n + 1)) : undefined), [taskId, workspaceId]);
  useEffect(() => { setAdding(false); setUrl(""); setError(null); refreshed.current.clear(); }, [taskId]);

  // pages never fetched, or not for an hour: ask once (best effort; the chip shows what it has meanwhile)
  useEffect(() => {
    if (!workspaceId || !status?.connected) return;
    for (const l of links) {
      const fetched = l.page?.fetchedAt ? Date.parse(l.page.fetchedAt) : NaN;
      if (refreshed.current.has(l.pageId) || (Number.isFinite(fetched) && Date.now() - fetched < STALE_MS)) continue;
      refreshed.current.add(l.pageId);
      refreshNotionPage(workspaceId, l.pageId).then((page) => {
        if (!page || !alive.current) return;
        setLinks((xs) => xs.map((x) => (x.pageId === l.pageId ? { ...x, page } : x)));
      }).catch(() => { /* keep what we have */ });
    }
  }, [links, status?.connected, workspaceId]);

  useEffect(() => { if (adding) inputRef.current?.focus(); }, [adding]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => alive.current && setNote(null), 5000);
    return () => clearTimeout(t);
  }, [note]);

  if (!workspaceId || !loaded) return null;
  const canLink = canEdit && !!status?.connected && status.canLink;
  if (!links.length && !canLink) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const u = url.trim();
    if (!u) { setError("Paste a link to a Notion page."); inputRef.current?.focus(); return; }
    if (!parseNotionId(u)) { setError(NOTION_COPY.invalidLink); inputRef.current?.focus(); return; }
    setBusy(true); setError(null);
    try {
      const link = await linkNotionPage(taskId, u, workspaceId);
      if (!alive.current) return;
      setLinks((xs) => (xs.some((x) => x.id === link.id) ? xs.map((x) => (x.id === link.id ? link : x)) : [...xs, link]));
      refreshed.current.add(link.pageId);
      setUrl(""); setAdding(false);
      setNote(`Linked ${link.page?.title ?? "the page"}.`);
      window.setTimeout(() => addRef.current?.focus(), 0);
    } catch (err) {
      if (alive.current) { setError(err instanceof NotionError ? err.message : NOTION_COPY.failed); inputRef.current?.focus(); }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const remove = async (l: NotionLink) => {
    if (removing) return;
    setRemoving(l.id);
    try {
      await unlinkNotionPage(l.id);
      if (!alive.current) return;
      setLinks((xs) => xs.filter((x) => x.id !== l.id));
      setNote(`Removed the link to ${l.page?.title ?? "the page"}. The page itself is untouched.`);
      window.setTimeout(() => addRef.current?.focus(), 0);
    } catch (err) {
      if (alive.current) setNote(err instanceof NotionError ? err.message : NOTION_COPY.failed);
    } finally {
      if (alive.current) setRemoving(null);
    }
  };

  return (
    <section className="ktd-sec knl" aria-labelledby={`${ids}-h`}>
      <div className="ksection">
        <h3 className="ksection-title" id={`${ids}-h`}>Notion{links.length > 0 && <span className="ksection-count">{links.length}</span>}</h3>
        {canLink && !adding && (
          <div className="ksection-action">
            <Button ref={addRef} variant="ghost" size="sm" icon="link" onClick={() => { setAdding(true); setError(null); }} style={{ color: "var(--ink-2)" }}>Link a page</Button>
          </div>
        )}
      </div>
      {links.length > 0 && (
        <ul className="knl-list">
          {links.map((l) => {
            const title = l.page?.title || "Notion page";
            const href = l.page?.url && /^https:\/\//i.test(l.page.url) ? l.page.url : notionPageUrl(l.pageId);
            const edited = l.page?.lastEditedTime ? `edited ${timeAgo(l.page.lastEditedTime)}` : null;
            const canRemove = canEdit && (l.kind === "reference" || !!status?.canManage);
            const meta = [l.kind === "synced" ? "synced" : null, l.page?.archived ? "archived in Notion" : edited].filter(Boolean).join(" · ");
            return (
              <li key={l.id} className="knl-chip" data-archived={l.page?.archived || undefined}>
                <a className="knl-link" href={href} target="_blank" rel="noopener noreferrer" title={title}>
                  <PageIcon icon={l.page?.icon ?? null} />
                  <span className="knl-title">{title}</span>
                  {meta && <span className="knl-meta">{l.kind === "synced" && <Icon name="refresh" size={12} sw={2} />}{meta}</span>}
                  <span className="sr-only">, Notion page (opens in a new tab)</span>
                </a>
                {canRemove && (
                  <IconButton className="knl-del" icon="x" size="sm" tone="danger" disabled={removing === l.id}
                    label={l.kind === "synced" ? `Unlink ${title} (stops syncing it with this task)` : `Unlink ${title}`} onClick={() => void remove(l)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {adding && (
        <form className="knl-form" onSubmit={(e) => void submit(e)} noValidate aria-label="Link a Notion page">
          <input ref={inputRef} type="url" inputMode="url" className="knl-input" placeholder="https://www.notion.so/…" aria-label="Notion page link"
            autoComplete="off" spellCheck={false} maxLength={2000} value={url} disabled={busy}
            onChange={(e) => { setUrl(e.target.value); if (error) setError(null); }}
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setAdding(false); window.setTimeout(() => addRef.current?.focus(), 0); } }}
            aria-invalid={error ? true : undefined} aria-describedby={error ? `${ids}-err` : `${ids}-hint`} />
          <Button type="submit" size="sm" variant="primary" loading={busy}>{busy ? "Linking…" : "Link"}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setError(null); window.setTimeout(() => addRef.current?.focus(), 0); }} disabled={busy}>Cancel</Button>
          {error
            ? <p id={`${ids}-err`} className="knl-err" role="alert">{error}</p>
            : <p id={`${ids}-hint`} className="knl-hint">In Notion: Share › Copy link. The page must be shared with your Kanbo integration.</p>}
        </form>
      )}
      <p className="knl-note" role="status">{note}</p>
    </section>
  );
}

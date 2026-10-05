/* ============================================================
   KANBO — Settings › Calendar & integrations › Notion.            [0046 · a3]
   Connect (paste an internal integration secret, with the steps to make
   one at notion.so/profile/integrations and share pages with it), test,
   replace, disconnect; the workspace's syncs (database → project,
   direction, last run, last error, pause / resume, sync now, remove); and
   the "Import a Notion database" wizard: pick a database → preview 5 rows
   and map the fields → choose a project (or a new one with its identity)
   → import, optionally keeping it in sync. Owners/admins manage; members
   and guests see the status and the syncs. Personal: explains Notion is
   per team workspace. Demo: lib/notion's in-memory Notion workspace.

   The secret is never shown again once saved (the field clears; owners
   and admins see its last four characters). Before migration 0046 / the
   notion function are live the panel says Notion isn't switched on yet.
   Mount (integrator): beside SlackSettingsPanel, with the active workspace.
   ============================================================ */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { NotionDatabaseSchema, NotionDatabaseSummary, NotionPreviewRow, NotionStatus, NotionSync, NotionSyncDirection, Project, Role, Status } from "../../data/types";
import type { NotionFieldMapping } from "../../../supabase/functions/_shared/notion.ts";
import { Button, Icon, Pill, ProjectDot, Segmented, Sheet, Toggle, spectrumColor } from "../primitives";
import { IdentityFields, IdentityPreview, freshSpectrum } from "../project/IdentityPicker";
import { SetGroup, SetIntro, SetNote, SetRow } from "../integrations/settingsBits";
import { timeAgo } from "../../data/data";
import {
  NOTION_COPY, NOTION_INTEGRATIONS_URL, NotionError, NOTION_TOKEN_RE, connectNotion, deleteNotionSync, disconnectNotion,
  getNotionDatabaseSchema, importNotionDatabase, listNotionDatabases, listNotionSyncs, loadNotionStatus, previewNotionDatabase,
  guessKanboStatus, runNotionSyncNow, setNotionSyncEnabled, subscribeNotionSyncs, suggestNotionMapping, takeOverNotionSync, testNotion,
  type NotionImportSummary,
} from "../../lib/notion";
import "./notion.css";

export interface NotionPanelProps {
  /** the active workspace (null = Personal) */
  workspaceId: string | null;
  workspaceName?: string;
  /** your role there (null in Personal) */
  role: Role | null;
  /** the workspace's projects, for "Import into…" */
  projects: Array<Pick<Project, "id" | "name" | "emoji" | "color" | "archivedAt">>;
  /** after an import: open the project it filled */
  onOpenProject?: (projectId: string) => void;
}

type Msg = { tone: "ok" | "signal"; text: string } | null;
const notionIcon = <Icon name="notes" size={16} sw={1.75} />;
const errMsg = (e: unknown) => (e instanceof NotionError ? e.message : NOTION_COPY.failed);
const STATUS_LABEL: Record<Status, string> = { todo: "To do", progress: "In progress", review: "In review", blocked: "Blocked", done: "Done" };
const STATUSES = Object.keys(STATUS_LABEL) as Status[];

function msgLine(m: Msg) {
  return m && (
    <p className="knt-msg knt-in" data-tone={m.tone}>
      <Icon name={m.tone === "ok" ? "check" : "alert"} size={14} sw={2} />
      <span>{m.text}</span>
    </p>
  );
}

/* ------------------------------------------------------------ the status */

function useNotionStatus(workspaceId: string | null) {
  const [state, setState] = useState<{ status: NotionStatus | null; problem: NotionError | null; loading: boolean }>({ status: null, problem: null, loading: !!workspaceId });
  const [ask, setAsk] = useState(0);
  useEffect(() => {
    if (!workspaceId) { setState({ status: null, problem: null, loading: false }); return; }
    let live = true;
    setState((s) => ({ ...s, loading: true, problem: null }));
    loadNotionStatus(workspaceId)
      .then((status) => { if (live) setState({ status, problem: null, loading: false }); })
      .catch((e) => { if (live) setState({ status: null, problem: e instanceof NotionError ? e : new NotionError("error", NOTION_COPY.failed), loading: false }); });
    return () => { live = false; };
  }, [workspaceId, ask]);
  const reload = useCallback(() => setAsk((n) => n + 1), []);
  const set = useCallback((status: NotionStatus) => setState({ status, problem: null, loading: false }), []);
  return { ...state, reload, set };
}

export function NotionPanel({ workspaceId, workspaceName, role, projects, onOpenProject }: NotionPanelProps) {
  const { status, problem, loading, reload, set } = useNotionStatus(workspaceId);

  if (!workspaceId) {
    return (
      <div className="knt">
        <SetGroup title="Notion">
          <SetRow icon={notionIcon} label="Notion is for team workspaces"
            desc="Switch to a team workspace to import Notion databases into projects, keep them in sync and link Notion pages to tasks." />
        </SetGroup>
      </div>
    );
  }
  if (!status) {
    let body;
    if (loading) body = <SetRow icon={notionIcon} label="Notion" desc={<span className="knt-checking" role="status"><span className="kspin" aria-hidden="true" />Checking the connection…</span>} />;
    else if (problem?.reason === "unavailable") body = <SetRow icon={notionIcon} label="Not switched on yet" desc="Kanbo's Notion connection hasn't been set up yet. Once it has, owners and admins can connect Notion here." />;
    else if (problem) body = (
      <SetRow icon={notionIcon} label="Couldn't check Notion" desc={problem.reason === "network" ? problem.message : "Something went wrong reading the Notion connection."}>
        <Button size="sm" icon="refresh" onClick={reload}>Try again</Button>
      </SetRow>
    );
    else return null;   // not a member of this workspace
    return <div className="knt"><SetGroup title="Notion">{body}</SetGroup></div>;
  }
  return (
    <NotionBody key={workspaceId} workspaceId={workspaceId} wsName={workspaceName?.trim() || "this workspace"} status={status} role={role}
      projects={projects} onOpenProject={onOpenProject} onStatus={set} />
  );
}

/* ------------------------------------------------------------ connected / not */

function NotionBody({ workspaceId, wsName, status, role, projects, onOpenProject, onStatus }: {
  workspaceId: string; wsName: string; status: NotionStatus; role: Role | null;
  projects: NotionPanelProps["projects"]; onOpenProject?: (id: string) => void; onStatus: (s: NotionStatus) => void;
}) {
  const ids = "knt" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const canManage = status.canManage && (role == null || role === "owner" || role === "admin");
  const [busy, setBusy] = useState<null | "connect" | "test" | "disconnect">(null);
  const [editing, setEditing] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [token, setToken] = useState("");
  const [reveal, setReveal] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [wizard, setWizard] = useState(false);
  const tokenRef = useRef<HTMLInputElement>(null);
  const testRef = useRef<HTMLButtonElement>(null);
  const offRef = useRef<HTMLButtonElement>(null);
  const cancelOffRef = useRef<HTMLButtonElement>(null);
  const importRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<null | "token" | "test" | "off" | "cancelOff">(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    ({ token: tokenRef, test: testRef, off: offRef, cancelOff: cancelOffRef }[want].current)?.focus();
  });
  useEffect(() => {
    if (msg?.tone !== "ok") return;
    const t = setTimeout(() => alive.current && setMsg(null), 6000);
    return () => clearTimeout(t);
  }, [msg]);

  const showForm = canManage && (!status.connected || editing);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const t = token.trim();
    setFormError(null);
    if (!t) { setTokenError("Paste the secret from your Notion integration."); tokenRef.current?.focus(); return; }
    if (!NOTION_TOKEN_RE.test(t)) { setTokenError(NOTION_COPY.invalidToken); tokenRef.current?.focus(); return; }
    setTokenError(null);
    setBusy("connect");
    try {
      const s = await connectNotion(workspaceId, t);
      if (!alive.current) return;
      setToken(""); setEditing(false); setReveal(false);
      onStatus(s);
      setMsg({ tone: "ok", text: `Connected to ${s.workspaceName || "Notion"}. Now share the pages and databases Kanbo should see with your integration.` });
      focusNext.current = "test";
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof NotionError && err.reason === "invalid_token") { setTokenError(err.message); focusNext.current = "token"; }
      else setFormError(errMsg(err));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const runTest = async () => {
    if (busy) return;
    setBusy("test"); setMsg(null);
    const r = await testNotion(workspaceId);
    if (!alive.current) return;
    setBusy(null);
    setMsg(r.ok ? { tone: "ok", text: `Kanbo can reach ${r.workspaceName || "your Notion workspace"}.` } : { tone: "signal", text: r.message });
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy("disconnect"); setMsg(null);
    try {
      const s = await disconnectNotion(workspaceId);
      if (!alive.current) return;
      setConfirmOff(false);
      onStatus(s);
      focusNext.current = "token";
    } catch (err) {
      if (alive.current) setMsg({ tone: "signal", text: errMsg(err) });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const form = showForm && (
    <form className="knt-form knt-in" onSubmit={(e) => void submit(e)} noValidate aria-label={editing ? "Replace the Notion secret" : "Connect Notion"}>
      <div className="kset-field">
        <label htmlFor={`${ids}-tok`}>Internal Integration Secret</label>
        <div className="kset-input-wrap">
          <input ref={tokenRef} id={`${ids}-tok`} name="notion-secret" type={reveal ? "text" : "password"} className="kset-input knt-token"
            autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={220}
            placeholder="ntn_…" value={token} disabled={busy === "connect"}
            onChange={(e) => { setToken(e.target.value); if (tokenError) setTokenError(null); }}
            aria-invalid={tokenError ? true : undefined} aria-describedby={`${ids}-tok-hint`} />
          <button type="button" className="kset-reveal" onClick={() => setReveal((v) => !v)} aria-pressed={reveal}
            aria-label={reveal ? "Hide the secret" : "Show the secret"}>{reveal ? "Hide" : "Show"}</button>
        </div>
        <p id={`${ids}-tok-hint`} className="kset-hint" data-tone={tokenError ? "signal" : undefined}>
          {tokenError ?? "Kept on Kanbo's server and never shown again, to anyone."}
        </p>
      </div>
      <details className="knt-help" open={!status.connected || undefined}>
        <summary><Icon name="chevronRight" size={14} sw={2} />How to connect Notion</summary>
        <ol className="knt-steps">
          <li>Open <a href={NOTION_INTEGRATIONS_URL} target="_blank" rel="noopener noreferrer">Notion's integrations page<span className="sr-only"> (opens in a new tab)</span></a> and choose <strong>New integration</strong>. Name it Kanbo, pick your Notion workspace and keep the type <strong>Internal</strong>.</li>
          <li>Under <strong>Capabilities</strong>, tick <strong>Read content</strong>, <strong>Update content</strong> and <strong>Read user information including email addresses</strong> (so Notion people match Kanbo members). Save.</li>
          <li>Copy the <strong>Internal Integration Secret</strong> (it starts with <code>ntn_</code>) and paste it above.</li>
          <li>In Notion, open each database or page Kanbo should see and choose <strong>•••</strong> › <strong>Connections</strong> › <strong>Kanbo</strong>. Sharing a parent page shares everything inside it.</li>
        </ol>
      </details>
      {formError && <p className="kset-err" role="alert">{formError}</p>}
      <div className="knt-acts">
        {editing && <Button variant="ghost" onClick={() => { setEditing(false); setToken(""); setTokenError(null); setFormError(null); }} disabled={busy === "connect"}>Cancel</Button>}
        <Button type="submit" variant="primary" icon={editing ? "refresh" : "link"} loading={busy === "connect"}>
          {busy === "connect" ? "Checking with Notion…" : editing ? "Replace secret" : "Connect"}
        </Button>
      </div>
    </form>
  );

  const by = [status.connectedByName ? `by ${status.connectedByName}` : null, status.connectedAt ? timeAgo(status.connectedAt) : null].filter(Boolean).join(" · ");

  return (
    <div className="knt">
      {!status.connected && canManage && (
        <SetIntro>Bring a Notion database into a project, keep the two in sync both ways, and link Notion pages to tasks.</SetIntro>
      )}
      <SetGroup title="Notion">
        {status.connected ? (
          <div>
            <SetRow icon={notionIcon} label={status.workspaceName || "Notion workspace"}
              desc={<><span className="kset-ok">Connected</span>{by ? ` ${by}` : ""}{canManage && status.tokenHint ? ` · secret ${status.tokenHint}` : ""}</>}>
              {canManage && (
                <Button ref={testRef} size="sm" icon="refresh" onClick={() => void runTest()} loading={busy === "test"} disabled={!!busy && busy !== "test"}>
                  {busy === "test" ? "Testing…" : "Test"}
                </Button>
              )}
            </SetRow>
            <div role="status" className="knt-live">{msgLine(msg)}</div>
          </div>
        ) : (
          <div>
            <SetRow icon={notionIcon} label="Not connected"
              desc={canManage ? "Paste the secret of a Notion integration to connect." : `An owner or admin of ${wsName} can connect Notion.`} />
            <div role="status" className="knt-live">{msgLine(msg)}</div>
            {form}
          </div>
        )}
        {status.connected && canManage && (
          <div>
            <SetRow label="Integration secret" desc="Saved on Kanbo's server. Replace it if you made a new one in Notion.">
              {!editing && !confirmOff && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(true); setConfirmOff(false); setMsg(null); focusNext.current = "token"; }} disabled={!!busy}>Replace</Button>
                  <Button ref={offRef} size="sm" className="knt-off" onClick={() => { setConfirmOff(true); setEditing(false); focusNext.current = "cancelOff"; }} disabled={!!busy}>Disconnect</Button>
                </>
              )}
            </SetRow>
            {editing && form}
            {confirmOff && (
              <div role="group" aria-labelledby={`${ids}-off`} className="kset-panel knt-in" data-tone="signal">
                <p id={`${ids}-off`} className="kset-panel-title">Disconnect Notion?</p>
                <p className="kset-panel-text">Kanbo forgets the secret and pauses every sync. Tasks stay, and so do their links to Notion pages.</p>
                <div className="kset-panel-acts">
                  <Button ref={cancelOffRef} variant="ghost" onClick={() => { setConfirmOff(false); focusNext.current = "off"; }} disabled={busy === "disconnect"}>Cancel</Button>
                  <Button variant="danger" icon="x" onClick={() => void disconnect()} loading={busy === "disconnect"}>{busy === "disconnect" ? "Disconnecting…" : "Disconnect"}</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </SetGroup>

      <SyncList workspaceId={workspaceId} connected={status.connected} canManage={canManage} projects={projects}
        importButton={canManage && status.connected ? (
          <Button ref={importRef} size="sm" variant="ghost" icon="plus" onClick={() => setWizard(true)} className="knt-import">Import a database</Button>
        ) : null} />
      <SyncNote show={status.connected} />

      {canManage && status.connected && (
        <ImportWizard open={wizard} onClose={() => { setWizard(false); window.setTimeout(() => importRef.current?.focus(), 0); }}
          workspaceId={workspaceId} projects={projects} onOpenProject={onOpenProject} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the syncs */

const statsText = (s: NotionSync["stats"]) => {
  const parts = [s.created ? `${s.created} new` : null, s.updated ? `${s.updated} updated` : null, s.pushed ? `${s.pushed} sent to Notion` : null].filter(Boolean);
  return parts.length ? parts.join(", ") : "no changes";
};

function SyncList({ workspaceId, connected, canManage, projects, importButton }: {
  workspaceId: string; connected: boolean; canManage: boolean; projects: NotionPanelProps["projects"]; importButton: ReactNode;
}) {
  const [syncs, setSyncs] = useState<NotionSync[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ask, setAsk] = useState(0);
  useEffect(() => {
    let live = true;
    listNotionSyncs(workspaceId)
      .then((s) => { if (live) { setSyncs(s); setProblem(null); } })
      .catch((e) => { if (live) setProblem(errMsg(e)); });
    return () => { live = false; };
  }, [workspaceId, ask, connected]);
  useEffect(() => subscribeNotionSyncs(workspaceId, () => setAsk((n) => n + 1)), [workspaceId]);

  if (!connected && !syncs?.length) return null;
  return (
    <SetGroup title="Synced databases" action={importButton}>
      {problem && !syncs && (
        <SetRow label="Couldn't load the syncs" desc={problem}>
          <Button size="sm" icon="refresh" onClick={() => setAsk((n) => n + 1)}>Try again</Button>
        </SetRow>
      )}
      {!problem && syncs === null && <SetRow label="Syncs" desc={<span className="knt-checking" role="status"><span className="kspin" aria-hidden="true" />Loading…</span>} />}
      {syncs?.length === 0 && (
        <SetRow icon={<Icon name="layers" size={16} sw={1.75} />} label="Nothing synced yet"
          desc={canManage ? "Import a Notion database into a project, and keep it in sync if you like." : "Owners and admins can import Notion databases into projects."} />
      )}
      {syncs?.map((s) => (
        <SyncRow key={s.id} sync={s} canManage={canManage} connected={connected} project={projects.find((p) => p.id === s.projectId)}
          onChanged={() => setAsk((n) => n + 1)} />
      ))}
    </SetGroup>
  );
}

function SyncNote({ show }: { show: boolean }) {
  return show ? <SetNote>Kanbo checks synced databases every 10 minutes. When a task and its page both change in between, the later edit wins. A task deleted in Kanbo isn't brought back, and its Notion page stays.</SetNote> : null;
}

function SyncRow({ sync, canManage, connected, project, onChanged }: {
  sync: NotionSync; canManage: boolean; connected: boolean; project?: NotionPanelProps["projects"][number]; onChanged: () => void;
}) {
  const ids = "kns" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [busy, setBusy] = useState<null | "run" | "toggle" | "remove" | "adopt">(null);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const alive = useRef(true);
  const removeRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (confirm) cancelRef.current?.focus(); }, [confirm]);
  useEffect(() => {
    if (msg?.tone !== "ok") return;
    const t = setTimeout(() => alive.current && setMsg(null), 6000);
    return () => clearTimeout(t);
  }, [msg]);

  const act = async (kind: "run" | "toggle" | "remove" | "adopt") => {
    if (busy) return;
    setBusy(kind); setMsg(null);
    try {
      if (kind === "adopt") {
        await takeOverNotionSync(sync);
        if (alive.current) setMsg({ tone: "ok", text: "Saved: the sync now acts as you. Choose Sync now to run it." });
      } else if (kind === "run") {
        const st = await runNotionSyncNow(sync.id);
        if (alive.current) setMsg({ tone: "ok", text: `Synced: ${statsText(st)}.` });
      } else if (kind === "toggle") await setNotionSyncEnabled(sync.id, !sync.enabled);
      else { await deleteNotionSync(sync.id); }
      onChanged();
    } catch (e) {
      if (alive.current) setMsg({ tone: "signal", text: errMsg(e) });
      onChanged();
    } finally {
      if (alive.current) { setBusy(null); if (kind === "remove") setConfirm(false); }
    }
  };

  const projectName = project ? project.name : "a project you can't see";
  // the person it acts as has gone (or lost access): an owner/admin saves it as themselves
  const orphaned = !sync.createdBy || /no longer has access/.test(sync.lastError ?? "");
  const when = !sync.enabled ? "Paused"
    : sync.lastRunAt ? `Last synced ${timeAgo(sync.lastRunAt)}${sync.stats?.at && !sync.lastError ? ` · ${statsText(sync.stats)}` : ""}`
    : "Waiting for its first run";
  return (
    <div className="knt-sync" aria-labelledby={`${ids}-t`} role="group">
      <div className="kset-row">
        <span className="kset-row-icon"><Icon name="layers" size={16} sw={1.75} /></span>
        <div className="kset-row-text">
          <span id={`${ids}-t`} className="kset-row-label knt-sync-title">
            <span className="knt-sync-db">{sync.databaseTitle || "Notion database"}</span>
            <Icon name="arrowRight" size={12} sw={2} className="knt-sync-arrow" />
            <span className="sr-only">into </span>
            <span className="knt-sync-project">
              {project && <ProjectDot color={project.color} size={8} />}
              {project?.emoji ? <span aria-hidden="true">{project.emoji}</span> : null}
              <span>{projectName}</span>
            </span>
          </span>
          <span className="kset-row-desc knt-sync-desc">
            <Pill tone="neutral" icon={sync.direction === "two_way" ? "refresh" : "arrowLeft"}>{sync.direction === "two_way" ? "Both ways" : "From Notion"}</Pill>
            <span>{when}</span>
            {sync.createdByName && <span className="knt-quiet">· acts as {sync.createdByName}</span>}
          </span>
          {sync.lastError && sync.enabled && (
            <span className="knt-sync-err"><Icon name="alert" size={14} sw={2} /><span>{sync.lastError}</span></span>
          )}
        </div>
        {canManage && !confirm && (
          <div className="kset-row-ctl knt-sync-acts">
            {orphaned && connected && (
              <Button size="sm" variant="primary" icon="user" onClick={() => void act("adopt")} loading={busy === "adopt"} disabled={!!busy && busy !== "adopt"}>
                {busy === "adopt" ? "Saving…" : "Run as me"}
              </Button>
            )}
            {sync.enabled && connected && (
              <Button size="sm" icon="refresh" onClick={() => void act("run")} loading={busy === "run"} disabled={!!busy && busy !== "run"}>
                {busy === "run" ? "Syncing…" : "Sync now"}
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={sync.enabled ? "pause" : "play"} onClick={() => void act("toggle")} loading={busy === "toggle"}
              disabled={(!!busy && busy !== "toggle") || (!sync.enabled && !connected)}
              aria-label={`${sync.enabled ? "Pause" : "Resume"} the sync of ${sync.databaseTitle || "this database"}`}>
              {sync.enabled ? "Pause" : "Resume"}
            </Button>
            <Button ref={removeRef} size="sm" variant="ghost" icon="trash" className="knt-off" onClick={() => setConfirm(true)} disabled={!!busy}
              aria-label={`Remove the sync of ${sync.databaseTitle || "this database"}`}>Remove</Button>
          </div>
        )}
      </div>
      <div role="status" className="knt-live">{msgLine(msg)}</div>
      {confirm && (
        <div role="group" aria-labelledby={`${ids}-rm`} className="kset-panel knt-in" data-tone="signal">
          <p id={`${ids}-rm`} className="kset-panel-title">Remove this sync?</p>
          <p className="kset-panel-text">Kanbo stops syncing {sync.databaseTitle || "the database"}. Its tasks stay in {projectName}, each still linked to its Notion page.</p>
          <div className="kset-panel-acts">
            <Button ref={cancelRef} variant="ghost" onClick={() => { setConfirm(false); window.setTimeout(() => removeRef.current?.focus(), 0); }} disabled={busy === "remove"}>Cancel</Button>
            <Button variant="danger" icon="trash" onClick={() => void act("remove")} loading={busy === "remove"}>{busy === "remove" ? "Removing…" : "Remove sync"}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the Import wizard */

type Step = "pick" | "map" | "project" | "done";
const STEP_TITLES: Record<Exclude<Step, "done">, string> = { pick: "Choose a database", map: "Check the fields", project: "Choose a project" };
const NONE = "";

function ImportWizard({ open, onClose, workspaceId, projects, onOpenProject }: {
  open: boolean; onClose: () => void; workspaceId: string; projects: NotionPanelProps["projects"]; onOpenProject?: (id: string) => void;
}) {
  const ids = "knw" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [step, setStep] = useState<Step>("pick");
  const [query, setQuery] = useState("");
  const [dbs, setDbs] = useState<NotionDatabaseSummary[] | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const [db, setDb] = useState<NotionDatabaseSummary | null>(null);
  const [schema, setSchema] = useState<NotionDatabaseSchema | null>(null);
  const [rows, setRows] = useState<NotionPreviewRow[] | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<NotionFieldMapping | null>(null);
  const live = projects.filter((p) => !p.archivedAt);
  const [target, setTarget] = useState<"new" | "existing">("new");
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [color, setColor] = useState(() => spectrumColor(freshSpectrum(projects)));
  const [keep, setKeep] = useState(true);
  const [direction, setDirection] = useState<NotionSyncDirection>("two_way");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<NotionImportSummary | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // every opening starts again
  useEffect(() => {
    if (!open) return;
    setStep("pick"); setQuery(""); setDbs(null); setDb(null); setSchema(null); setRows(null); setMapping(null); setMapError(null);
    setTarget(live.length ? "existing" : "new"); setProjectId(live[0]?.id ?? ""); setName(""); setEmoji("");
    setColor(spectrumColor(freshSpectrum(projects))); setKeep(true); setDirection("two_way");
    setImporting(false); setImportError(null); setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // the step's heading takes focus, so screen readers hear where they are
  useEffect(() => {
    if (!open) return;
    if (step === "pick") searchRef.current?.focus({ preventScroll: true });
    else headRef.current?.focus();
  }, [step, open]);

  // databases (searched as people type)
  useEffect(() => {
    if (!open || step !== "pick") return;
    let on = true;
    setDbError(null);
    const t = window.setTimeout(() => {
      listNotionDatabases(workspaceId, query)
        .then((d) => { if (on) setDbs(d); })
        .catch((e) => { if (on) { setDbs(null); setDbError(errMsg(e)); } });
    }, query ? 300 : 0);
    return () => { on = false; window.clearTimeout(t); };
  }, [open, step, query, workspaceId]);

  const pick = async (d: NotionDatabaseSummary) => {
    setDb(d); setStep("map"); setSchema(null); setRows(null); setMapError(null); setMapping(null);
    if (!name) setName(d.title);
    try {
      const [s, r] = await Promise.all([getNotionDatabaseSchema(workspaceId, d.id), previewNotionDatabase(workspaceId, d.id)]);
      if (!alive.current) return;
      setSchema(s); setRows(r); setMapping(suggestNotionMapping(s));
    } catch (e) {
      if (alive.current) setMapError(errMsg(e));
    }
  };

  const doImport = async () => {
    if (!db || !mapping || importing) return;
    if (target === "existing" && !projectId) { setImportError("Choose a project to import into."); return; }
    if (target === "new" && !name.trim()) { setImportError("Give the new project a name."); return; }
    setImporting(true); setImportError(null);
    try {
      const r = await importNotionDatabase({
        workspaceId, databaseId: db.id, mapping, projectId: target === "existing" ? projectId : null,
        newProject: target === "new" ? { name: name.trim(), emoji, color } : null, keepInSync: keep, direction,
      });
      if (!alive.current) return;
      setResult(r); setStep("done");
    } catch (e) {
      if (alive.current) setImportError(errMsg(e));
    } finally {
      if (alive.current) setImporting(false);
    }
  };

  const projectOf = (id: string) => projects.find((p) => p.id === id);
  const stepNo = step === "pick" ? 1 : step === "map" ? 2 : step === "project" ? 3 : 3;
  const footer = step === "done" ? (
    <>
      {result && onOpenProject && projectOf(result.projectId) && (
        <Button variant="ghost" icon="arrowUpRight" onClick={() => { onOpenProject(result.projectId); onClose(); }}>Open project</Button>
      )}
      <Button variant="primary" onClick={onClose}>Done</Button>
    </>
  ) : (
    <>
      <span className="knt-wz-count" aria-hidden="true">Step {stepNo} of 3</span>
      {step !== "pick" && <Button variant="ghost" icon="arrowLeft" onClick={() => setStep(step === "project" ? "map" : "pick")} disabled={importing}>Back</Button>}
      {step === "map" && <Button variant="primary" iconRight="arrowRight" disabled={!mapping} onClick={() => setStep("project")}>Next</Button>}
      {step === "project" && (
        <Button variant="primary" icon="arrowRight" loading={importing} onClick={() => void doImport()}>{importing ? "Importing…" : "Import"}</Button>
      )}
    </>
  );

  return (
    <Sheet open={open} onClose={onClose} label="Import a Notion database" title="Import a Notion database" width={640} footer={footer}
      initialFocus={step === "pick" ? searchRef : undefined}>
      <div className="knt-wz">
        <p className="sr-only" role="status">{step === "done" ? "Import finished" : `Step ${stepNo} of 3: ${STEP_TITLES[step]}`}</p>
        {step !== "done" && (
          <ol className="knt-wz-steps" aria-label="Steps">
            {(["pick", "map", "project"] as const).map((s, i) => (
              <li key={s} data-state={s === step ? "now" : i + 1 < stepNo ? "done" : undefined} aria-current={s === step ? "step" : undefined}>
                <span className="knt-wz-dot" aria-hidden="true">{i + 1 < stepNo ? <Icon name="check" size={12} sw={2.5} /> : i + 1}</span>{STEP_TITLES[s]}
              </li>
            ))}
          </ol>
        )}

        {step === "pick" && (
          <section aria-labelledby={`${ids}-h1`}>
            <h3 id={`${ids}-h1`} className="knt-wz-h">Which database?</h3>
            <p className="knt-wz-p">These are the databases your Kanbo integration can see. Missing one? In Notion, open it and choose ••• › Connections › Kanbo.</p>
            <div className="knt-search">
              <Icon name="search" size={16} sw={1.75} />
              <input ref={searchRef} type="search" className="kset-input" placeholder="Search databases" aria-label="Search databases"
                value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {dbError && <p className="kset-err" role="alert">{dbError}</p>}
            {!dbError && dbs === null && <p className="knt-checking knt-wz-p" role="status"><span className="kspin" aria-hidden="true" />Asking Notion…</p>}
            {dbs?.length === 0 && (
              <p className="knt-wz-empty">{query ? `No database called “${query}” is shared with Kanbo.` : "Kanbo can't see any databases yet. Share one with your integration in Notion, then try again."}</p>
            )}
            {!!dbs?.length && (
              <ul className="knt-dbs" aria-label="Databases">
                {dbs.map((d) => (
                  <li key={d.id}>
                    <button type="button" className="knt-db" onClick={() => void pick(d)}>
                      <NotionIcon icon={d.icon} />
                      <span className="knt-db-title">{d.title}</span>
                      {d.lastEditedTime && <span className="knt-quiet">Edited {timeAgo(d.lastEditedTime)}</span>}
                      <Icon name="chevronRight" size={14} sw={2} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {step === "map" && db && (
          <section aria-labelledby={`${ids}-h2`}>
            <h3 id={`${ids}-h2`} ref={headRef} tabIndex={-1} className="knt-wz-h"><NotionIcon icon={db.icon} />{db.title}</h3>
            {mapError && <p className="kset-err" role="alert">{mapError}</p>}
            {!mapError && (!schema || !mapping) && <p className="knt-checking knt-wz-p" role="status"><span className="kspin" aria-hidden="true" />Reading the database…</p>}
            {schema && mapping && rows && <MapFields schema={schema} rows={rows} mapping={mapping} onChange={setMapping} />}
          </section>
        )}

        {step === "project" && db && (
          <section aria-labelledby={`${ids}-h3`}>
            <h3 id={`${ids}-h3`} ref={headRef} tabIndex={-1} className="knt-wz-h">Where should the tasks go?</h3>
            <div className="knt-choice" role="radiogroup" aria-label="Import into">
              <label className="knt-radio"><input type="radio" name={`${ids}-t`} checked={target === "new"} onChange={() => setTarget("new")} />A new project</label>
              <label className="knt-radio"><input type="radio" name={`${ids}-t`} checked={target === "existing"} disabled={!live.length} onChange={() => setTarget("existing")} />An existing project</label>
            </div>
            {target === "existing" ? (
              <div className="kset-field">
                <label htmlFor={`${ids}-p`}>Project</label>
                <select id={`${ids}-p`} className="knt-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {live.map((p) => <option key={p.id} value={p.id}>{p.emoji ? `${p.emoji} ` : ""}{p.name}</option>)}
                </select>
              </div>
            ) : (
              <div className="kpj-dialog knt-newp">
                <IdentityPreview name={name} emoji={emoji} color={color}>
                  <div className="kset-field">
                    <label htmlFor={`${ids}-n`}>Name</label>
                    <input id={`${ids}-n`} className="kset-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                  </div>
                </IdentityPreview>
                <IdentityFields name={name} emoji={emoji} color={color} onEmoji={setEmoji} onColor={setColor} />
              </div>
            )}
            <div className="knt-keep">
              <Toggle checked={keep} onChange={setKeep} label="Keep it in sync"
                description="Kanbo checks Notion every 10 minutes. When both sides change, the later edit wins." />
              {keep && (
                <div className="knt-dir">
                  <span className="knt-dir-label" id={`${ids}-dir`}>Changes flow</span>
                  <Segmented<NotionSyncDirection> ariaLabel="Changes flow" value={direction} onChange={setDirection}
                    options={[{ value: "two_way", label: "Both ways", icon: "refresh" }, { value: "from_notion", label: "From Notion only", icon: "arrowLeft" }]} />
                </div>
              )}
            </div>
            {importError && <p className="kset-err" role="alert">{importError}</p>}
          </section>
        )}

        {step === "done" && result && (
          <section className="knt-done" aria-labelledby={`${ids}-h4`}>
            <span className="knt-done-mark" aria-hidden="true"><Icon name="check" size={20} sw={2.5} /></span>
            <h3 id={`${ids}-h4`} ref={headRef} tabIndex={-1} className="knt-wz-h">
              {result.created === 1 ? "1 task imported" : `${result.created} tasks imported`}
            </h3>
            <p className="knt-wz-p">
              {db?.title} is in {projectOf(result.projectId)?.name ?? (target === "new" ? name.trim() : "the project")}
              {result.syncId ? (direction === "two_way" ? ", and stays in sync both ways." : ", and keeps taking changes from Notion.") : "."}
              {result.skipped ? ` ${result.skipped} ${result.skipped === 1 ? "page was" : "pages were"} already there or archived.` : ""}
            </p>
            {result.errors.length > 0 && (
              <ul className="knt-done-notes">{result.errors.map((e, i) => <li key={i}><Icon name="alert" size={14} sw={2} />{e}</li>)}</ul>
            )}
          </section>
        )}
      </div>
    </Sheet>
  );
}

/** An emoji, or an image from Notion (decorative; Notion's own image links expire, so a broken one falls back). */
export function NotionIcon({ icon, size = 18 }: { icon: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (icon && /^https:\/\//.test(icon) && !broken) {
    return <img className="knt-ico" src={icon} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return <span className="knt-ico" aria-hidden="true" style={{ fontSize: size - 4 }}>{icon && !/^https:/.test(icon) ? icon : "📄"}</span>;
}

/* the mapping step: a preview of 5 pages, then which field feeds what */
function MapFields({ schema, rows, mapping, onChange }: {
  schema: NotionDatabaseSchema; rows: NotionPreviewRow[]; mapping: NotionFieldMapping; onChange: (m: NotionFieldMapping) => void;
}) {
  const ids = "knm" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const of = (...types: string[]) => schema.properties.filter((p) => types.includes(p.type));
  const title = schema.properties.find((p) => p.type === "title");
  const statusProp = mapping.status ? schema.properties.find((p) => p.name === mapping.status!.property) : undefined;
  const shown = useMemo(() => {
    const names = [mapping.title, mapping.status?.property, mapping.due?.property, mapping.assignee?.property, mapping.tags?.property, mapping.description?.property]
      .filter((x): x is string => !!x);
    return names.length > 1 ? names : schema.properties.slice(0, 5).map((p) => p.name);
  }, [mapping, schema]);
  const cell = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v.join(", ") : v ?? "");

  const pickField = (key: "status" | "due" | "assignee" | "tags" | "description", prop: string) => {
    const next: NotionFieldMapping = { ...mapping };
    if (!prop) { delete next[key]; onChange(next); return; }
    if (key === "status") {
      const p = schema.properties.find((x) => x.name === prop) as (NotionDatabaseSchema["properties"][number] & { groups?: Record<string, string> }) | undefined;
      const values: Record<string, Status> = {};
      for (const o of p?.options ?? []) values[o] = guessKanboStatus(o, p?.groups?.[o]);
      next.status = { property: prop, values };
    } else next[key] = { property: prop };
    onChange(next);
  };
  const field = (key: "status" | "due" | "assignee" | "tags" | "description", label: string, hint: string, types: string[]) => {
    const opts = of(...types);
    const value = (mapping[key] as { property: string } | null | undefined)?.property ?? NONE;
    return (
      <div className="knt-map-row" key={key}>
        <label htmlFor={`${ids}-${key}`} className="knt-map-label">{label}<span className="knt-quiet">{hint}</span></label>
        <select id={`${ids}-${key}`} className="knt-select" value={value} onChange={(e) => pickField(key, e.target.value)} disabled={!opts.length}>
          <option value={NONE}>{opts.length ? "Don't bring in" : "No field of that kind"}</option>
          {opts.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
        </select>
      </div>
    );
  };

  return (
    <>
      <div className="knt-preview" role="region" aria-label="The first five pages" tabIndex={0}>
        <table>
          <caption className="sr-only">The first five pages of the database</caption>
          <thead><tr>{shown.map((n) => <th key={n} scope="col">{n}</th>)}</tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={shown.length}>This database is empty.</td></tr>}
            {rows.map((r) => <tr key={r.pageId}>{shown.map((n) => <td key={n}>{cell(r.values[n])}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
      <div className="knt-map" role="group" aria-label="Which Notion field feeds each Kanbo field">
        <div className="knt-map-row">
          <span className="knt-map-label">Task title<span className="knt-quiet">Always the database's title</span></span>
          <span className="knt-map-fixed">{title?.name ?? mapping.title}</span>
        </div>
        {field("status", "Status", "A status or select field", ["status", "select"])}
        {statusProp && mapping.status && (
          <div className="knt-values" role="group" aria-label={`What each ${statusProp.name} option means`}>
            {(statusProp.options ?? []).map((o) => (
              <div className="knt-value" key={o}>
                <label htmlFor={`${ids}-v-${o}`}><span className="knt-opt">{o}</span></label>
                <Icon name="arrowRight" size={12} sw={2} className="knt-quiet" />
                <select id={`${ids}-v-${o}`} className="knt-select" data-size="sm" value={mapping.status!.values[o] ?? NONE}
                  onChange={(e) => {
                    const values = { ...mapping.status!.values };
                    if (e.target.value) values[o] = e.target.value as Status; else delete values[o];
                    onChange({ ...mapping, status: { property: mapping.status!.property, values } });
                  }}>
                  <option value={NONE}>Leave as it is</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
        {field("due", "Due date", "A range also sets the start date", ["date"])}
        {field("assignee", "Assignee", "Matched to members by email", ["people"])}
        {field("tags", "Tags", "A multi-select field", ["multi_select"])}
        {field("description", "Description", "Its first paragraph", ["rich_text"])}
      </div>
      <p className="knt-wz-p knt-quiet">Fields you don't bring in stay in Notion, untouched.</p>
    </>
  );
}

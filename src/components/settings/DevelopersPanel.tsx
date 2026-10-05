/* ============================================================
   KANBO — Settings › Developers: API keys.                   [0046 · a1]
   Create a key (name; personal or team — team keys only in workspaces
   where you're an owner/admin; read-only or read & write; optional
   expiry), show the full key ONCE (copy + warning), list keys (name,
   prefix, scope, created, last used, expiry, status) and revoke.
   Owners/admins can switch to a workspace's team keys (everyone's) and
   revoke any of them. Links to the API reference (ApiDocs).
   Data: lib/apiKeys (demo mode: realistic example keys in memory).

   Built from SetGroup / SetRow (SettingsModal's kset-* rows), so it reads
   as a native Settings section; developers.css adds only its own parts.
   The full key lives in this component's state until "Done" and is never
   logged, stored or sent anywhere else.
   ============================================================ */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { ApiKey, ApiKeyAccess, CreatedApiKey, Role } from "../../data/types";
import { Button, Icon, Pill, Segmented } from "../primitives";
import { SetGroup, SetIntro, SetNote, SetRow } from "../integrations/settingsBits";
import { copyText } from "../rituals/shared";
import { isSupabaseConfigured } from "../../lib/supabase";
import {
  API_KEY_COPY, API_KEY_LIMITS, apiBaseUrl, apiKeyFailure, apiKeyMessage, createApiKey, listApiKeys, revokeApiKey,
} from "../../lib/apiKeys";
import "./developers.css";

/** A team workspace you're in, with your role there. */
export interface DevWorkspace {
  id: string;
  name: string;
  role: Role;
}

export interface DevelopersPanelProps {
  /** the team workspaces you belong to (team keys: where role is owner/admin) */
  workspaces: DevWorkspace[];
  /** the workspace open in the app (null = Personal): preselects the key's scope */
  currentWorkspaceId: string | null;
  /** open the API reference (the panel shows a link when given) */
  onOpenDocs?: () => void;
}

type Load = { state: "loading" } | { state: "ready"; keys: ApiKey[] } | { state: "error"; message: string; unavailable: boolean };
type Msg = { tone: "ok" | "signal"; text: string } | null;

const DAY = 86_400_000;
const EXPIRY_CHOICES: { value: string; label: string; days: number | null }[] = [
  { value: "never", label: "No expiry", days: null },
  { value: "7", label: "In 7 days", days: 7 },
  { value: "30", label: "In 30 days", days: 30 },
  { value: "90", label: "In 90 days", days: 90 },
  { value: "365", label: "In a year", days: 365 },
];
const isAdmin = (r: Role) => r === "owner" || r === "admin";

/** "5 Aug 2026" */
export function fmtKeyDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "Used just now" / "Used 3 hours ago" / "Used yesterday" / "Used on 5 Aug 2026" / "Never used" */
export function fmtLastUsed(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "Never used";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "Never used";
  const mins = Math.max(0, Math.floor((now - t) / 60_000));
  if (mins < 2) return "Used just now";
  if (mins < 60) return `Used ${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Used ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Used yesterday";
  if (days < 14) return `Used ${days} days ago`;
  return `Used on ${fmtKeyDate(iso)}`;
}

/** The expiry part of a key's line, and whether it needs attention soon. */
export function fmtExpiry(k: Pick<ApiKey, "expiresAt" | "status" | "revokedAt">, now = Date.now()): { text: string; soon: boolean } {
  if (k.status === "revoked") return { text: `Revoked ${fmtKeyDate(k.revokedAt)}`.trim(), soon: false };
  if (!k.expiresAt) return { text: "No expiry", soon: false };
  const t = Date.parse(k.expiresAt);
  if (k.status === "expired" || t <= now) return { text: `Expired ${fmtKeyDate(k.expiresAt)}`, soon: false };
  const days = Math.ceil((t - now) / DAY);
  if (days <= 14) return { text: days <= 1 ? "Expires within a day" : `Expires in ${days} days`, soon: true };
  return { text: `Expires ${fmtKeyDate(k.expiresAt)}`, soon: false };
}

const RANK: Record<ApiKey["status"], number> = { active: 0, expired: 1, revoked: 2 };
const byStatusThenNewest = (a: ApiKey, b: ApiKey) => RANK[a.status] - RANK[b.status] || b.createdAt.localeCompare(a.createdAt);

export function DevelopersPanel({ workspaces, currentWorkspaceId, onOpenDocs }: DevelopersPanelProps) {
  const ids = "kdev" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const adminWs = useMemo(() => workspaces.filter((w) => isAdmin(w.role)), [workspaces]);
  const [view, setView] = useState<"mine" | "team">("mine");
  const [teamWs, setTeamWs] = useState<string>(() => adminWs.find((w) => w.id === currentWorkspaceId)?.id ?? adminWs[0]?.id ?? "");
  const listFor = view === "team" && teamWs ? teamWs : null;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [ask, setAsk] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const createBtnRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // keep the team view on a workspace you still administer
  useEffect(() => {
    if (!adminWs.some((w) => w.id === teamWs)) setTeamWs(adminWs[0]?.id ?? "");
    if (!adminWs.length && view === "team") setView("mine");
  }, [adminWs, teamWs, view]);

  const lastFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    // a different list: show it loading; a refresh of the same list keeps it on screen
    if (lastFor.current !== listFor) { lastFor.current = listFor; setLoad({ state: "loading" }); }
    listApiKeys(listFor).then(
      (keys) => { if (live && alive.current) setLoad({ state: "ready", keys: [...keys].sort(byStatusThenNewest) }); },
      (e) => { if (live && alive.current) setLoad({ state: "error", message: apiKeyMessage(e), unavailable: apiKeyFailure(e) === "unavailable" }); },
    );
    return () => { live = false; };
  }, [listFor, ask]);

  useEffect(() => {
    if (msg?.tone !== "ok") return;
    const t = setTimeout(() => alive.current && setMsg(null), 5000);
    return () => clearTimeout(t);
  }, [msg]);

  const wsName = useCallback((k: Pick<ApiKey, "workspaceId" | "workspaceName">) =>
    workspaces.find((w) => w.id === k.workspaceId)?.name ?? k.workspaceName ?? "a team workspace", [workspaces]);

  const onCreated = (k: CreatedApiKey) => {
    setCreated(k);
    setFormOpen(false);
    setMsg(null);
    setAsk((n) => n + 1);
  };

  const revoke = async (k: ApiKey) => {
    if (busyId) return;
    setBusyId(k.id);
    setMsg(null);
    try {
      const done = await revokeApiKey(k.id);
      if (!alive.current) return;
      setConfirmId(null);
      setLoad((l) => (l.state === "ready" ? { state: "ready", keys: l.keys.map((x) => (x.id === done.id ? { ...x, ...done } : x)).sort(byStatusThenNewest) } : l));
      setMsg({ tone: "ok", text: `Revoked “${k.name}”. Anything using it has stopped working.` });
    } catch (e) {
      if (!alive.current) return;
      setMsg({ tone: "signal", text: apiKeyMessage(e) });
      if (apiKeyFailure(e) === "not_found") { setConfirmId(null); setAsk((n) => n + 1); }
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  const keys = load.state === "ready" ? load.keys : [];
  const liveMine = view === "mine" ? keys.filter((k) => k.status === "active").length : null;
  const canCreate = load.state !== "error" || !load.unavailable;
  const docsLink = onOpenDocs && (
    <button type="button" className="kset-link kdev-docs-link" onClick={onOpenDocs}>API reference</button>
  );

  return (
    <div className="kdev">
      <SetIntro>
        Connect Kanbo to your own tools and scripts with the Kanbo API. A key acts as you, with exactly your access: it can never do more than you can.
      </SetIntro>

      {created && <NewKeyReveal created={created} scope={created.workspaceId ? `Team key for ${wsName(created)}` : "Personal key"}
        onDone={() => { setCreated(null); setMsg({ tone: "ok", text: `“${created.name}” is ready to use.` }); requestAnimationFrame(() => createBtnRef.current?.focus()); }} />}

      <SetGroup title="API keys" action={docsLink}>
        {adminWs.length > 0 && (
          <SetRow label="Show" desc={view === "team" ? "Every team key in the workspace, whoever made it. You can revoke any of them." : "Your personal keys and the team keys you made."} group>
            <Segmented ariaLabel="Which keys to show" value={view} onChange={(v) => { setView(v); setConfirmId(null); setMsg(null); }}
              options={[{ value: "mine", label: "Your keys" }, { value: "team", label: "Team keys" }]} />
            {view === "team" && adminWs.length > 1 && (
              <select className="kdev-select" aria-label="Workspace" value={teamWs} onChange={(e) => { setTeamWs(e.target.value); setConfirmId(null); }}>
                {adminWs.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            )}
          </SetRow>
        )}

        {load.state === "loading" && (
          <SetRow icon={<Icon name="lock" size={16} sw={1.75} />} label="API keys"
            desc={<span className="kdev-checking" role="status"><span className="kspin" aria-hidden="true" />Loading keys…</span>} />
        )}
        {load.state === "error" && (
          <SetRow icon={<Icon name={load.unavailable ? "lock" : "alert"} size={16} sw={1.75} />}
            label={load.unavailable ? "Not switched on yet" : "Couldn't load your keys"}
            desc={load.unavailable ? "Kanbo's API hasn't been set up yet. Once it has, you can make keys here." : load.message}>
            {!load.unavailable && <Button size="sm" icon="refresh" onClick={() => setAsk((n) => n + 1)}>Try again</Button>}
          </SetRow>
        )}
        {load.state === "ready" && keys.length === 0 && (
          <SetRow icon={<Icon name="lock" size={16} sw={1.75} />} label={view === "team" ? "No team keys yet" : "No keys yet"}
            desc={view === "team" ? `Nobody has made a key for ${adminWs.find((w) => w.id === teamWs)?.name ?? "this workspace"} yet.` : "Make one to connect Zapier, a reporting script or your own app."} />
        )}
        {load.state === "ready" && keys.length > 0 && (
          <ul className="kdev-keys" aria-label={view === "team" ? "Team keys" : "Your API keys"}>
            {keys.map((k) => (
              <KeyRow key={k.id} k={k} team={view === "team"} wsName={wsName(k)} confirming={confirmId === k.id} busy={busyId === k.id}
                onAskRevoke={() => { setConfirmId(k.id); setMsg(null); }} onCancel={() => setConfirmId(null)} onRevoke={() => void revoke(k)} />
            ))}
          </ul>
        )}
        <div role="status" className="kdev-live">
          {msg && (
            <p className="kdev-msg kdev-in" data-tone={msg.tone}>
              <Icon name={msg.tone === "ok" ? "check" : "alert"} size={14} sw={2} /><span>{msg.text}</span>
            </p>
          )}
        </div>

        {canCreate && view === "mine" && (formOpen ? (
          <CreateKeyForm ids={ids} adminWs={adminWs} currentWorkspaceId={currentWorkspaceId}
            onCancel={() => { setFormOpen(false); requestAnimationFrame(() => createBtnRef.current?.focus()); }} onCreated={onCreated} />
        ) : (
          <SetRow label="New key" desc={liveMine !== null ? `${liveMine} of ${API_KEY_LIMITS.livePerPerson} live keys.` : undefined}>
            <Button ref={createBtnRef} size="sm" variant="primary" icon="plus" onClick={() => { setFormOpen(true); setCreated(null); setMsg(null); }}>Create key</Button>
          </SetRow>
        ))}
      </SetGroup>

      <SetNote>
        {!isSupabaseConfigured ? "This is the demo: these keys are examples and don't connect to anything. " : ""}
        Use keys from servers and scripts, never in a web page. Kanbo keeps only a fingerprint of each key, so a lost key can't be shown again: revoke it and make another. Revoked keys leave this list after 30 days.
      </SetNote>
    </div>
  );
}

/* ---------------------------------------------------------------- a key */

function KeyRow({ k, team, wsName, confirming, busy, onAskRevoke, onCancel, onRevoke }: {
  k: ApiKey; team: boolean; wsName: string; confirming: boolean; busy: boolean;
  onAskRevoke: () => void; onCancel: () => void; onRevoke: () => void;
}) {
  const id = "kdevk" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const exp = fmtExpiry(k);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const revokeBtnRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirming.current && k.status === "active") revokeBtnRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming, k.status]);
  const inactive = k.status !== "active";
  return (
    <li className="kdev-key" data-status={k.status}>
      <div className="kdev-key-main">
        <span className="kdev-key-icon" aria-hidden="true"><Icon name="lock" size={16} sw={1.75} /></span>
        <div className="kdev-key-text">
          <div className="kdev-key-top">
            <span id={`${id}-n`} className="kdev-key-name">{k.name}</span>
            <code className="kdev-prefix"><span className="sr-only">Key starting </span>{k.prefix}…</code>
          </div>
          <div className="kdev-pills">
            <Pill tone={k.access === "write" ? "accent" : "neutral"}>{k.access === "write" ? "Read & write" : "Read-only"}</Pill>
            <Pill tone="neutral" icon={k.workspaceId ? "users" : "user"}>{k.workspaceId ? `Team · ${wsName}` : "Personal"}</Pill>
            {k.status === "expired" && <Pill tone="warn">Expired</Pill>}
            {k.status === "revoked" && <Pill tone="neutral">Revoked</Pill>}
          </div>
          <p className="kdev-key-meta">
            <span>Created {fmtKeyDate(k.createdAt)}{team && k.createdByName ? ` by ${k.createdByName}` : ""}</span>
            <span aria-hidden="true"> · </span>
            <span>{fmtLastUsed(k.lastUsedAt)}</span>
            <span aria-hidden="true"> · </span>
            <span data-tone={exp.soon ? "warn" : undefined}>{exp.text}</span>
          </p>
        </div>
        {k.canRevoke && !inactive && !confirming && (
          <Button ref={revokeBtnRef} size="sm" variant="ghost" className="kdev-revoke" onClick={onAskRevoke} aria-describedby={`${id}-n`}>Revoke</Button>
        )}
      </div>
      {confirming && (
        <div role="group" aria-labelledby={`${id}-c`} className="kset-panel kdev-in" data-tone="signal">
          <p id={`${id}-c`} className="kset-panel-title">Revoke “{k.name}”?</p>
          <p className="kset-panel-text">Anything using this key stops working straight away. This can't be undone, but you can make a new key.</p>
          <div className="kset-panel-acts">
            <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button variant="danger" icon="x" onClick={onRevoke} loading={busy}>{busy ? "Revoking…" : "Revoke key"}</Button>
          </div>
        </div>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------- create */

function CreateKeyForm({ ids, adminWs, currentWorkspaceId, onCancel, onCreated }: {
  ids: string; adminWs: DevWorkspace[]; currentWorkspaceId: string | null;
  onCancel: () => void; onCreated: (k: CreatedApiKey) => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string>(() => (adminWs.some((w) => w.id === currentWorkspaceId) ? currentWorkspaceId! : "personal"));
  const [access, setAccess] = useState<ApiKeyAccess>("read");
  const [expiry, setExpiry] = useState("never");
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; nameRef.current?.focus(); return () => { alive.current = false; }; }, []);

  const team = adminWs.find((w) => w.id === scope);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    setFormError(null);
    if (!n) { setNameError("Give the key a name, so you know what it's for."); nameRef.current?.focus(); return; }
    if (n.length > API_KEY_LIMITS.name) { setNameError(API_KEY_COPY.invalidName); nameRef.current?.focus(); return; }
    setNameError(null);
    const days = EXPIRY_CHOICES.find((c) => c.value === expiry)?.days ?? null;
    setBusy(true);
    try {
      const made = await createApiKey({
        name: n, workspaceId: team ? team.id : null, access,
        expiresAt: days ? new Date(Date.now() + days * DAY).toISOString() : null,
      });
      if (!alive.current) return;
      onCreated(made);
    } catch (err) {
      if (!alive.current) return;
      const text = apiKeyMessage(err);
      if (text === API_KEY_COPY.invalidName) { setNameError(text); nameRef.current?.focus(); } else setFormError(text);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <form className="kdev-form kdev-in" onSubmit={(e) => void submit(e)} noValidate aria-label="Create an API key">
      <div className="kset-field">
        <label htmlFor={`${ids}-name`}>Name</label>
        <input ref={nameRef} id={`${ids}-name`} name="api-key-name" type="text" className="kset-input" autoComplete="off" spellCheck={false}
          maxLength={API_KEY_LIMITS.name + 20} placeholder="e.g. Zapier, reporting script" value={name} disabled={busy}
          onChange={(e) => { setName(e.target.value); if (nameError) setNameError(null); }}
          aria-invalid={nameError ? true : undefined} aria-describedby={`${ids}-name-hint`} />
        <p id={`${ids}-name-hint`} className="kset-hint" data-tone={nameError ? "signal" : undefined}>{nameError ?? "So you can tell your keys apart later."}</p>
      </div>

      <div className="kset-field">
        <label htmlFor={`${ids}-scope`}>Works in</label>
        <select id={`${ids}-scope`} className="kdev-select kdev-select-full" value={scope} disabled={busy} onChange={(e) => setScope(e.target.value)}
          aria-describedby={`${ids}-scope-hint`}>
          <option value="personal">Everywhere you work (personal key)</option>
          {adminWs.map((w) => <option key={w.id} value={w.id}>Only {w.name} (team key)</option>)}
        </select>
        <p id={`${ids}-scope-hint`} className="kset-hint">
          {team
            ? `Acts as you, but only inside ${team.name}. It stops working if you're no longer an owner or admin there.`
            : `Acts as you in your Personal list and every workspace you're in.${adminWs.length ? "" : " Team keys are for workspace owners and admins."}`}
        </p>
      </div>

      <fieldset className="kdev-choices" disabled={busy}>
        <legend>Access</legend>
        <label className="kdev-choice">
          <input type="radio" name={`${ids}-access`} value="read" checked={access === "read"} onChange={() => setAccess("read")} />
          <span className="kdev-choice-text">
            <span className="kdev-choice-label">Read-only</span>
            <span className="kdev-choice-desc">Can look but not change anything. Starts kanbo_pk_.</span>
          </span>
        </label>
        <label className="kdev-choice">
          <input type="radio" name={`${ids}-access`} value="write" checked={access === "write"} onChange={() => setAccess("write")} />
          <span className="kdev-choice-text">
            <span className="kdev-choice-label">Read &amp; write</span>
            <span className="kdev-choice-desc">Can also create, edit, complete and archive. Starts kanbo_sk_.</span>
          </span>
        </label>
      </fieldset>

      <div className="kset-field">
        <label htmlFor={`${ids}-exp`}>Expires</label>
        <select id={`${ids}-exp`} className="kdev-select kdev-select-full" value={expiry} disabled={busy} onChange={(e) => setExpiry(e.target.value)}>
          {EXPIRY_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>

      {formError && <p className="kset-err kdev-form-err" role="alert">{formError}</p>}
      <div className="kdev-acts">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" icon="lock" loading={busy}>{busy ? "Creating…" : "Create key"}</Button>
      </div>
    </form>
  );
}

/* ---------------------------------------------------------------- the key, once */

function NewKeyReveal({ created, scope, onDone }: { created: CreatedApiKey; scope: string; onDone: () => void }) {
  const id = "kdevr" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, [created.id]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    const ok = await copyText(created.key);
    setCopied(ok);
    setCopyFailed(!ok);
    if (!ok) { inputRef.current?.focus(); inputRef.current?.select(); }
  };
  const tryIt = `curl -H "Authorization: Bearer ${created.key}" ${apiBaseUrl()}/me`;
  return (
    <section className="kdev-reveal kdev-in" aria-labelledby={`${id}-t`}>
      <div className="kdev-reveal-head">
        <Icon name="check" size={16} sw={2.25} />
        <h3 id={`${id}-t`} className="kdev-reveal-title">“{created.name}” is ready</h3>
        <span className="kdev-reveal-scope">{scope} · {created.access === "write" ? "Read & write" : "Read-only"}</span>
      </div>
      <p className="kdev-warn" id={`${id}-w`}><Icon name="alert" size={14} sw={2} /><span>{API_KEY_COPY.shownOnce}</span></p>
      <div className="kdev-keyfield">
        <label className="sr-only" htmlFor={`${id}-k`}>Your new API key</label>
        <input ref={inputRef} id={`${id}-k`} className="kdev-keyinput" type="text" readOnly value={created.key}
          spellCheck={false} autoComplete="off" aria-describedby={`${id}-w`} onFocus={(e) => e.currentTarget.select()} />
        <Button variant="primary" icon={copied ? "check" : "copy"} onClick={() => void copy()} aria-label={copied ? "Key copied" : "Copy key"}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div role="status" className="kdev-live">
        {copyFailed && <p className="kset-hint">Couldn't copy automatically. The key is selected: copy it with your keyboard.</p>}
      </div>
      <details className="kdev-try">
        <summary><Icon name="chevronRight" size={14} sw={2} />Check it works</summary>
        <pre className="kdev-pre" tabIndex={0} aria-label="Example request"><code>{tryIt}</code></pre>
      </details>
      <div className="kdev-acts">
        <Button variant="secondary" onClick={onDone}>Done, I've stored it safely</Button>
      </div>
    </section>
  );
}

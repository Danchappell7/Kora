/* ============================================================
   KANBO — Settings › Developers › Webhooks.                      [a2, 0046]
   Add an endpoint (https URL, events checklist, personal or a team
   workspace where you can edit), show the signing secret ONCE, send a
   test, recent deliveries (event, status, response time, attempts, next
   retry, redeliver), switch on/off, rotate the secret, edit, delete.
   Someone who can't manage an endpoint sees its address masked
   (hooks.zapier.com/…x2kd): catch-hook URLs work as passwords.
   Data: lib/webhooks (the 0046 definer functions; demo: in-memory fakes).

   Built from SettingsModal's kset-* rows (SetGroup / SetRow), so it reads
   as a native Settings section; webhooks.css adds only what Settings
   doesn't have. Every message lands in a polite live region; refusals in
   role="alert". Motion is 160ms and off under prefers-reduced-motion.
   ============================================================ */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Webhook, WebhookDelivery, WebhookEvent } from "../../data/types";
import { Button, Icon, IconButton, Pill } from "../primitives";
import { SetGroup, SetIntro, SetNote, SetRow } from "../integrations/settingsBits";
import { copyText } from "../rituals/shared";
import { isSupabaseConfigured } from "../../lib/supabase";
import {
  agoText, createWebhook, deleteWebhook, eventsSummary, isWebhookUrlShapeOk, listWebhookDeliveries, listWebhooks, MAX_CONSECUTIVE_FAILURES,
  PERSONAL_WEBHOOK_EVENTS as PERSONAL_EVENTS, redeliverWebhookDelivery, RETRY_SCHEDULE_MIN, rotateWebhookSecret, sendTestWebhook,
  setWebhookDemoRoles, shortWebhookUrl, soonText, updateWebhook, WEBHOOK_EVENT_INFO, WEBHOOK_EVENTS, WEBHOOK_LIMITS, webhookErrorText,
  webhookFailure, webhookHealth,
} from "../../lib/webhooks";
import type { DevWorkspace } from "./DevelopersPanel";
import "./webhooks.css";

export interface WebhooksPanelProps {
  /** the team workspaces you belong to (team endpoints: owners, admins and members — never guests) */
  workspaces: DevWorkspace[];
  /** the workspace open in the app (null = Personal): preselects the endpoint's scope */
  currentWorkspaceId: string | null;
}

type Msg = { tone: "ok" | "signal"; text: string } | null;
const PERSONAL = "personal";
const EVENT_GROUPS: { label: string; events: WebhookEvent[] }[] = [
  { label: "Tasks", events: ["task.created", "task.updated", "task.completed", "task.deleted"] },
  { label: "Comments", events: ["comment.created"] },
  { label: "Projects", events: ["project.created", "project.updated"] },
  { label: "People", events: ["member.joined"] },
  { label: "Approvals", events: ["approval.requested", "approval.decided"] },
];
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const retryWords = RETRY_SCHEDULE_MIN.map((m) => (m < 60 ? `${m} min` : `${m / 60} h`)).join(", ");

const fullFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fullTime = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? fullFmt.format(Date.parse(iso)) : undefined);

/** WEBHOOK_EVENT_INFO descriptions mark field names with `backticks`: show them as code. */
function withCode(text: string): ReactNode {
  return text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith("`") ? <code key={i} className="kwh-code">{part.slice(1, -1)}</code> : part));
}

/* ============================================================ panel */

export function WebhooksPanel({ workspaces, currentWorkspaceId }: WebhooksPanelProps) {
  const ids = "kwh" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  // demo mode: the fake applies the same who-manages-what rules as the server.
  // Synced while rendering (idempotent) so the first list already uses it.
  if (!isSupabaseConfigured) setWebhookDemoRoles(workspaces);
  const writable = useMemo(() => workspaces.filter((w) => w.role !== "guest"), [workspaces]);
  const guestIn = useMemo(() => workspaces.filter((w) => w.role === "guest"), [workspaces]);
  const initial = currentWorkspaceId && writable.some((w) => w.id === currentWorkspaceId) ? currentWorkspaceId : PERSONAL;
  const [scope, setScope] = useState<string>(initial);
  // the workspace list can change under us (left a workspace): fall back to Personal
  useEffect(() => {
    if (scope !== PERSONAL && !writable.some((w) => w.id === scope)) setScope(PERSONAL);
  }, [scope, writable]);
  const scopeName = scope === PERSONAL ? "Personal" : writable.find((w) => w.id === scope)?.name ?? "this workspace";

  return (
    <div className="kwh">
      <SetIntro>
        Kanbo sends a signed HTTPS POST to your endpoint when something happens — a task is added or finished, someone comments,
        a project changes, a teammate joins — so Zapier, Make or your own service can act on it straight away.
      </SetIntro>
      {(writable.length > 0 || guestIn.length > 0) && (
        <div className="kwh-scope">
          <label htmlFor={`${ids}-scope`} className="kwh-scope-label">Endpoints for</label>
          <select id={`${ids}-scope`} className="kwh-select" value={scope} onChange={(e) => setScope(e.target.value)}
            aria-describedby={guestIn.length ? `${ids}-guest` : undefined}>
            <option value={PERSONAL}>Personal (your own tasks and projects)</option>
            {writable.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          {guestIn.length > 0 && (
            <p id={`${ids}-guest`} className="kset-hint">
              You're a guest in {guestIn.map((w) => w.name).join(", ")}, so you can't add webhooks there.
            </p>
          )}
        </div>
      )}
      <ScopeView key={scope} workspaceId={scope === PERSONAL ? null : scope} scopeName={scopeName} />
    </div>
  );
}

/* ============================================================ one scope */

type Load = { state: "loading" } | { state: "ready"; hooks: Webhook[] } | { state: "problem"; text: string; unavailable: boolean };
type Reveal = { hookId: string; host: string; secret: string; kind: "created" | "rotated" } | null;

function ScopeView({ workspaceId, scopeName }: { workspaceId: string | null; scopeName: string }) {
  const ids = "kwhs" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const personal = workspaceId === null;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const focusAfter = useRef<(() => void) | null>(null);
  useEffect(() => { const f = focusAfter.current; if (f) { focusAfter.current = null; f(); } });

  const reload = useCallback(async () => {
    setLoad((l) => (l.state === "ready" ? l : { state: "loading" }));
    try {
      const hooks = await listWebhooks(workspaceId);
      if (alive.current) setLoad({ state: "ready", hooks });
    } catch (e) {
      if (!alive.current) return;
      const why = webhookFailure(e);
      setLoad({ state: "problem", text: why === "unavailable" ? "Webhooks aren't switched on for Kanbo yet. Once they are, you can add endpoints here." : webhookErrorText(e), unavailable: why === "unavailable" });
    }
  }, [workspaceId]);
  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (msg?.tone !== "ok") return;
    const t = setTimeout(() => alive.current && setMsg(null), 6000);
    return () => clearTimeout(t);
  }, [msg]);

  const hooks = load.state === "ready" ? load.hooks : [];
  const limit = personal ? WEBHOOK_LIMITS.personal : WEBHOOK_LIMITS.perWorkspace;
  const full = hooks.length >= limit;
  const replace = (w: Webhook) => setLoad((l) => (l.state === "ready" ? { state: "ready", hooks: l.hooks.map((h) => (h.id === w.id ? w : h)) } : l));

  const group = (children: ReactNode) => (
    <SetGroup title="Webhooks" action={load.state === "ready" && !adding ? (
      <Button ref={addRef} size="sm" icon="plus" onClick={() => { setAdding(true); setReveal(null); setMsg(null); }} disabled={full}
        title={full ? `That's the limit of ${limit} endpoints here.` : undefined}>Add endpoint</Button>
    ) : undefined}>
      {children}
    </SetGroup>
  );

  if (load.state === "loading") {
    return group(<SetRow icon={<Icon name="zap" size={16} sw={1.75} />} label="Webhooks"
      desc={<span className="kwh-checking" role="status"><span className="kspin" aria-hidden="true" />Loading endpoints…</span>} />);
  }
  if (load.state === "problem") {
    return group(
      <SetRow icon={<Icon name="zap" size={16} sw={1.75} />} label={load.unavailable ? "Not switched on yet" : "Couldn't load webhooks"} desc={load.text}>
        {!load.unavailable && <Button size="sm" icon="refresh" onClick={() => void reload()}>Try again</Button>}
      </SetRow>,
    );
  }

  return (
    <>
      {group(
        <>
          {reveal && (
            <SecretReveal reveal={reveal} onDone={() => {
              const id = reveal.hookId;
              setReveal(null);
              focusAfter.current = () => document.getElementById(`${ids}-row-${id}`)?.focus();
            }} />
          )}
          {adding && (
            <EndpointForm mode="add" personal={personal} scopeName={scopeName}
              onCancel={() => { setAdding(false); focusAfter.current = () => addRef.current?.focus(); }}
              onSubmit={async (v) => {
                const w = await createWebhook({ workspaceId, url: v.url, events: v.events, description: v.description });
                if (!alive.current) return;
                const { secret, ...hook } = w;
                setLoad((l) => (l.state === "ready" ? { state: "ready", hooks: [...l.hooks, hook] } : l));
                setAdding(false);
                setReveal({ hookId: w.id, host: hostOf(w.url), secret, kind: "created" });
                setMsg({ tone: "ok", text: `Endpoint added. Copy its signing secret now, then send a test.` });
              }} />
          )}
          {hooks.length === 0 && !adding && (
            <SetRow icon={<Icon name="zap" size={16} sw={1.75} />} label="No endpoints yet"
              desc={personal
                ? "Add one to hear about your personal tasks and projects as they change."
                : `Add one to send ${scopeName}'s task, comment, project and member events to another tool.`} />
          )}
          {hooks.map((h) => (
            <EndpointRow key={h.id} rowId={`${ids}-row-${h.id}`} hook={h} personal={personal} scopeName={scopeName}
              expanded={expanded === h.id} onExpand={(on) => setExpanded(on ? h.id : null)}
              onChange={replace}
              onSecret={(secret) => setReveal({ hookId: h.id, host: hostOf(h.url), secret, kind: "rotated" })}
              onMessage={setMsg}
              onDeleted={() => {
                setLoad((l) => (l.state === "ready" ? { state: "ready", hooks: l.hooks.filter((x) => x.id !== h.id) } : l));
                if (reveal?.hookId === h.id) setReveal(null);
                setMsg({ tone: "ok", text: `Endpoint for ${hostOf(h.url)} deleted.` });
                focusAfter.current = () => addRef.current?.focus();
              }} />
          ))}
          <div role="status" className="kwh-live">
            {msg && (
              <p className="kwh-msg kwh-in" data-tone={msg.tone}>
                <Icon name={msg.tone === "ok" ? "check" : "alert"} size={14} sw={2} /><span>{msg.text}</span>
              </p>
            )}
          </div>
        </>,
      )}
      <SetNote>
        Each delivery is signed with the endpoint's secret (the Kanbo-Signature header). Failed deliveries are retried after {retryWords};
        after {MAX_CONSECUTIVE_FAILURES} failures in a row the endpoint is switched off and you'll hear about it in your Inbox.
        {full ? ` That's the limit of ${limit} endpoints here.` : ""}
        {!isSupabaseConfigured ? " This is a demo: the endpoints are examples and nothing is sent." : ""}
      </SetNote>
      <VerifyHelp />
    </>
  );
}

/* ============================================================ secret, shown once */

function SecretReveal({ reveal, onDone }: { reveal: NonNullable<Reveal>; onDone: () => void }) {
  const ids = "kwhx" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const copyRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => { copyRef.current?.focus(); }, [reveal.secret]);
  const copy = async () => {
    setCopyFailed(false);
    if (await copyText(reveal.secret)) { setCopied(true); return; }
    setCopyFailed(true);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
  };
  return (
    <div role="group" aria-labelledby={`${ids}-t`} className="kset-panel kwh-secret kwh-in">
      <p id={`${ids}-t`} className="kset-panel-title">
        {reveal.kind === "created" ? `Signing secret for ${reveal.host}` : `New signing secret for ${reveal.host}`}
      </p>
      <p className="kset-panel-text" id={`${ids}-d`}>
        Copy it now and keep it with your receiver: it checks that each delivery really came from Kanbo.
        <strong> For your security, Kanbo can't show it again.</strong>
        {reveal.kind === "rotated" ? " The old secret has already stopped working." : ""}
      </p>
      <div className="kwh-secret-row">
        <input ref={inputRef} className="kset-input kwh-mono" readOnly value={reveal.secret} aria-label="Signing secret"
          aria-describedby={`${ids}-d`} spellCheck={false} autoComplete="off" onFocus={(e) => e.currentTarget.select()} />
        <Button ref={copyRef} icon={copied ? "check" : "copy"} onClick={() => void copy()} aria-label={copied ? "Signing secret copied" : "Copy signing secret"}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div role="status" className="kwh-live">
        {copyFailed && <p className="kset-hint">Couldn't copy automatically. The secret is selected: press Ctrl+C (⌘C on a Mac) to copy it.</p>}
      </div>
      <div className="kset-panel-acts">
        <Button variant="primary" onClick={onDone}>{copied ? "Done" : "I've saved it"}</Button>
      </div>
    </div>
  );
}

/* ============================================================ add / edit form */

interface FormValues { url: string; events: WebhookEvent[]; description: string | null }

function EndpointForm({ mode, personal, scopeName, initial, onCancel, onSubmit }: {
  mode: "add" | "edit";
  personal: boolean;
  scopeName: string;
  initial?: FormValues;
  onCancel: () => void;
  onSubmit: (v: FormValues) => Promise<void>;
}) {
  const ids = "kwhf" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const available = personal ? PERSONAL_EVENTS : WEBHOOK_EVENTS;
  const [url, setUrl] = useState(initial?.url ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [events, setEvents] = useState<WebhookEvent[]>(initial?.events ?? ["task.created", "task.completed"]);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const firstBoxRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { urlRef.current?.focus(); }, []);

  const toggle = (e: WebhookEvent, on: boolean) => {
    setEvents((cur) => (on ? [...new Set([...cur, e])] : cur.filter((x) => x !== e)));
    setEventsError(null);
  };
  const allOn = available.every((e) => events.includes(e));

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    setFormError(null);
    const u = url.trim();
    const urlProblem = !u ? "Paste your endpoint's address."
      : /^http:\/\//i.test(u) ? "Use an https:// address: Kanbo only sends over HTTPS."
      : u.length > WEBHOOK_LIMITS.url ? `That address is too long (${WEBHOOK_LIMITS.url} characters at most).`
      : !isWebhookUrlShapeOk(u) ? "Use a public https:// address with a hostname, like https://hooks.example.com/kanbo. IP addresses and internal names aren't allowed."
      : null;
    const chosen = events.filter((e) => available.includes(e));
    setUrlError(urlProblem);
    setEventsError(chosen.length ? null : "Choose at least one event.");
    if (urlProblem) { urlRef.current?.focus(); return; }
    if (!chosen.length) { firstBoxRef.current?.focus(); return; }
    setBusy(true);
    try {
      await onSubmit({ url: u, events: chosen, description: description.trim() || null });
    } catch (e) {
      if (!alive.current) return;
      const why = webhookFailure(e);
      if (why === "invalid_url") { setUrlError(webhookErrorText(e)); urlRef.current?.focus(); }
      else if (why === "invalid_events") setEventsError(webhookErrorText(e));
      else setFormError(webhookErrorText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <form className="kwh-form kwh-in" onSubmit={(e) => void submit(e)} noValidate aria-label={mode === "add" ? "Add a webhook endpoint" : "Change this endpoint"}>
      <div className="kwh-fields">
        <div className="kset-field">
          <label htmlFor={`${ids}-url`}>Endpoint URL</label>
          <input ref={urlRef} id={`${ids}-url`} name="webhook-url" type="url" inputMode="url" className="kset-input kwh-mono"
            autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={WEBHOOK_LIMITS.url + 50}
            placeholder="https://hooks.example.com/kanbo" value={url} disabled={busy}
            onChange={(e) => { setUrl(e.target.value); if (urlError) setUrlError(null); }}
            aria-invalid={urlError ? true : undefined} aria-describedby={`${ids}-url-hint`} />
          <p id={`${ids}-url-hint`} className="kset-hint" data-tone={urlError ? "signal" : undefined}>
            {urlError ?? "A public https:// address. Kanbo doesn't follow redirects."}
          </p>
        </div>
        <div className="kset-field">
          <label htmlFor={`${ids}-desc`}>Description <span className="kwh-opt">(optional)</span></label>
          <input id={`${ids}-desc`} name="webhook-description" type="text" className="kset-input" autoComplete="off"
            maxLength={WEBHOOK_LIMITS.description} placeholder="New tasks into the ops sheet" value={description} disabled={busy}
            onChange={(e) => setDescription(e.target.value)} aria-describedby={`${ids}-desc-hint`} />
          <p id={`${ids}-desc-hint`} className="kset-hint">So everyone can tell what it's for.</p>
        </div>
      </div>
      <fieldset className="kwh-events" aria-describedby={eventsError ? `${ids}-ev-err` : `${ids}-ev-hint`} disabled={busy}>
        <legend className="kwh-legend">Events to send</legend>
        <p id={`${ids}-ev-hint`} className="kset-hint kwh-ev-hint">
          {personal ? "From your personal tasks and projects." : `From everything in ${scopeName}.`}{" "}
          <button type="button" className="kset-link kwh-all" onClick={() => { setEvents(allOn ? [] : [...available]); setEventsError(null); }}>
            {allOn ? "Clear all" : "Choose all"}
          </button>
        </p>
        <div className="kwh-ev-groups">
          {EVENT_GROUPS.map((g) => {
            const evs = g.events.filter((e) => available.includes(e));
            if (!evs.length) return null;
            return (
              <div key={g.label} className="kwh-ev-group" role="group" aria-label={g.label}>
                <p className="kwh-ev-group-title" aria-hidden="true">{g.label}</p>
                {evs.map((e) => (
                  <label key={e} className="kwh-ev">
                    <input ref={e === available[0] ? firstBoxRef : undefined} type="checkbox" className="kwh-ev-box"
                      checked={events.includes(e)} onChange={(x) => toggle(e, x.target.checked)}
                      aria-describedby={`${ids}-ev-${e.replace(".", "-")}`} />
                    <span className="kwh-ev-text">
                      <span className="kwh-ev-label">{WEBHOOK_EVENT_INFO[e].label} <code className="kwh-code">{e}</code></span>
                      <span id={`${ids}-ev-${e.replace(".", "-")}`} className="kwh-ev-desc">{withCode(WEBHOOK_EVENT_INFO[e].description)}</span>
                    </span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
        {eventsError && <p id={`${ids}-ev-err`} className="kset-hint" data-tone="signal" role="alert">{eventsError}</p>}
      </fieldset>
      {formError && <p className="kset-err kwh-form-err" role="alert">{formError}</p>}
      <div className="kwh-acts">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="primary" icon={mode === "add" ? "plus" : "check"} loading={busy}>
          {busy ? (mode === "add" ? "Adding…" : "Saving…") : mode === "add" ? "Add endpoint" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

/* ============================================================ one endpoint */

function EndpointRow({ rowId, hook, personal, scopeName, expanded, onExpand, onChange, onSecret, onMessage, onDeleted }: {
  rowId: string;
  hook: Webhook;
  personal: boolean;
  scopeName: string;
  expanded: boolean;
  onExpand: (on: boolean) => void;
  onChange: (w: Webhook) => void;
  onSecret: (secret: string) => void;
  onMessage: (m: Msg) => void;
  onDeleted: () => void;
}) {
  const ids = "kwhr" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const host = hostOf(hook.url);
  const health = webhookHealth(hook);
  const [switching, setSwitching] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const flip = async () => {
    if (switching || !hook.canManage) return;
    const next = !hook.active;
    setSwitching(true); setRowError(null);
    onChange({ ...hook, active: next }); // optimistic; the server's answer replaces it
    try {
      const w = await updateWebhook(hook.id, { active: next });
      if (!alive.current) return;
      onChange(w);
      onMessage({ tone: "ok", text: next ? `Sending to ${host} again.` : `Switched off. Nothing more goes to ${host} until you switch it back on.` });
    } catch (e) {
      if (!alive.current) return;
      onChange(hook);
      setRowError(webhookErrorText(e));
    } finally {
      if (alive.current) setSwitching(false);
    }
  };

  const pill = health === "off"
    ? <Pill tone="signal" icon="pause">Switched off</Pill>
    : health === "failing"
      ? <Pill tone="warn" icon="refresh" title={`${hook.failureCount} failed in a row`}>Retrying</Pill>
      : health === "ok" ? <Pill tone="ok" icon="check">Working</Pill> : <Pill tone="neutral">No deliveries yet</Pill>;

  const last = !hook.active && hook.disabledReason
    ? hook.disabledReason
    : hook.lastDeliveryAt
      ? `Last delivery ${agoText(hook.lastDeliveryAt)}${hook.lastStatus ? ` (HTTP ${hook.lastStatus})` : hook.lastError ? ` (${hook.lastError})` : ""}`
      : "Nothing sent yet";

  return (
    <div className="kwh-item" data-off={!hook.active || undefined}>
      <div className="kset-row kwh-row">
        <span className="kset-row-icon"><Icon name="zap" size={16} sw={1.75} /></span>
        <div className="kset-row-text">
          <span className="kset-row-label kwh-url" title={hook.canManage ? hook.url : undefined}>{shortWebhookUrl(hook.url)}</span>
          <span className="kset-row-desc">
            {hook.description ? <>{hook.description} · </> : null}
            {eventsSummary(hook.events, personal)}
          </span>
          <span className="kset-row-desc kwh-last" data-tone={health === "off" || health === "failing" ? "warn" : undefined}>
            <span title={fullTime(hook.lastDeliveryAt)}>{last}</span>
            {!personal && hook.createdByName ? <> · Added by {hook.createdByName}</> : null}
          </span>
        </div>
        <div className="kset-row-ctl kwh-ctl">
          {pill}
          {hook.canManage && (
            <button type="button" role="switch" aria-checked={hook.active} className="ktoggle-switch kwh-switch" disabled={switching}
              aria-label={`Send events to ${host}`} onClick={() => void flip()}>
              <span className="ktoggle-thumb" aria-hidden="true" />
            </button>
          )}
          <Button id={rowId} size="sm" variant="ghost" iconRight={expanded ? "chevronDown" : "chevronRight"}
            aria-expanded={expanded} aria-controls={`${ids}-details`} onClick={() => onExpand(!expanded)}
            aria-label={`${expanded ? "Hide" : "Show"} details for ${host}`}>
            Details
          </Button>
        </div>
      </div>
      {rowError && <p className="kwh-msg kwh-row-err" data-tone="signal" role="alert"><Icon name="alert" size={14} sw={2} /><span>{rowError}</span></p>}
      <div id={`${ids}-details`} hidden={!expanded}>
        {expanded && (
          <EndpointDetails hook={hook} personal={personal} scopeName={scopeName} host={host} onChange={onChange} onSecret={onSecret} onMessage={onMessage} onDeleted={onDeleted}
            onClose={() => { onExpand(false); requestAnimationFrame(() => document.getElementById(rowId)?.focus()); }} />
        )}
      </div>
    </div>
  );
}

type Busy = null | "test" | "rotate" | "delete" | "redeliver";

function EndpointDetails({ hook, personal, scopeName, host, onChange, onSecret, onMessage, onDeleted, onClose }: {
  hook: Webhook;
  personal: boolean;
  scopeName: string;
  host: string;
  onChange: (w: Webhook) => void;
  onSecret: (secret: string) => void;
  onMessage: (m: Msg) => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const ids = "kwhd" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<null | "rotate" | "delete">(null);
  const [note, setNote] = useState<Msg>(null);
  const testRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const rotateRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const timers = useRef<number[]>([]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; timers.current.forEach((t) => window.clearTimeout(t)); };
  }, []);

  const loadDeliveries = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await listWebhookDeliveries(hook.id, 25);
      if (!alive.current) return;
      setDeliveries(list); setLoadError(null);
    } catch (e) {
      if (alive.current) setLoadError(webhookErrorText(e));
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }, [hook.id]);
  useEffect(() => { void loadDeliveries(); }, [loadDeliveries]);
  useEffect(() => { if (confirm) cancelRef.current?.focus(); }, [confirm]);

  /** look again shortly after something was queued (a ping arrives within seconds) */
  const checkSoon = () => {
    for (const ms of [1800, 5000]) timers.current.push(window.setTimeout(() => { if (alive.current) void loadDeliveries(); }, ms));
  };

  const run = async (kind: Busy, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind); setNote(null);
    try { await fn(); } catch (e) {
      if (alive.current) setNote({ tone: "signal", text: webhookErrorText(e) });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const test = () => run("test", async () => {
    await sendTestWebhook(hook.id);
    if (!alive.current) return;
    setNote({ tone: "ok", text: `Test event queued for ${host}. It shows below within a few seconds.` });
    checkSoon();
  });
  const rotate = () => run("rotate", async () => {
    const secret = await rotateWebhookSecret(hook.id);
    if (!alive.current) return;
    setConfirm(null);
    onSecret(secret);
  });
  const remove = () => run("delete", async () => {
    await deleteWebhook(hook.id);
    if (!alive.current) return;
    onDeleted();
  });
  const redeliver = (d: WebhookDelivery) => run("redeliver", async () => {
    await redeliverWebhookDelivery(d.id);
    if (!alive.current) return;
    setNote({ tone: "ok", text: `Sending that ${WEBHOOK_EVENT_INFO[d.event as WebhookEvent]?.label.toLowerCase() ?? "event"} again now.` });
    setDeliveries((list) => list?.map((x) => (x.id === d.id ? { ...x, state: "pending", attempt: 0, error: null, nextAttemptAt: new Date().toISOString() } : x)) ?? list);
    checkSoon();
  });

  if (editing) {
    return (
      <EndpointForm mode="edit" personal={personal} scopeName={scopeName}
        initial={{ url: hook.url, events: hook.events, description: hook.description }}
        onCancel={() => { setEditing(false); requestAnimationFrame(() => editRef.current?.focus()); }}
        onSubmit={async (v) => {
          const w = await updateWebhook(hook.id, { url: v.url, events: v.events, description: v.description ?? "" });
          if (!alive.current) return;
          onChange(w);
          setEditing(false);
          onMessage({ tone: "ok", text: `Endpoint for ${hostOf(w.url)} saved.` });
          requestAnimationFrame(() => editRef.current?.focus());
        }} />
    );
  }

  return (
    <div className="kwh-details kwh-in">
      {hook.canManage ? (
        <div className="kwh-tools" role="group" aria-label={`Actions for ${host}`}>
          <Button ref={testRef} size="sm" icon="send" onClick={() => void test()} loading={busy === "test"} disabled={!!busy && busy !== "test"}>
            {busy === "test" ? "Sending…" : "Send test"}
          </Button>
          <Button ref={editRef} size="sm" icon="sliders" onClick={() => { setEditing(true); setConfirm(null); }} disabled={!!busy}>Edit</Button>
          <Button ref={rotateRef} size="sm" icon="refresh" onClick={() => setConfirm("rotate")} disabled={!!busy}>Rotate secret</Button>
          <Button ref={deleteRef} size="sm" icon="trash" className="kwh-danger" onClick={() => setConfirm("delete")} disabled={!!busy}>Delete</Button>
        </div>
      ) : (
        <p className="kwh-readonly">
          <Icon name="lock" size={14} sw={2} />
          <span>
            Added by {hook.createdByName ?? "someone else"}. Only they, or a workspace owner or admin, can change it or see its full address.
          </span>
        </p>
      )}

      {confirm === "rotate" && (
        <div role="group" aria-labelledby={`${ids}-rot`} className="kset-panel kwh-in">
          <p id={`${ids}-rot`} className="kset-panel-title">Replace the signing secret?</p>
          <p className="kset-panel-text">The current secret stops working straight away, so deliveries will fail your check until you give your receiver the new one.</p>
          <div className="kset-panel-acts">
            <Button ref={cancelRef} variant="ghost" onClick={() => { setConfirm(null); requestAnimationFrame(() => rotateRef.current?.focus()); }} disabled={busy === "rotate"}>Cancel</Button>
            <Button variant="primary" icon="refresh" onClick={() => void rotate()} loading={busy === "rotate"}>{busy === "rotate" ? "Replacing…" : "Replace secret"}</Button>
          </div>
        </div>
      )}
      {confirm === "delete" && (
        <div role="group" aria-labelledby={`${ids}-del`} className="kset-panel kwh-in" data-tone="signal">
          <p id={`${ids}-del`} className="kset-panel-title">Delete the endpoint for {host}?</p>
          <p className="kset-panel-text">Kanbo stops sending to it at once and forgets its delivery history. This can't be undone.</p>
          <div className="kset-panel-acts">
            <Button ref={cancelRef} variant="ghost" onClick={() => { setConfirm(null); requestAnimationFrame(() => deleteRef.current?.focus()); }} disabled={busy === "delete"}>Cancel</Button>
            <Button variant="danger" icon="trash" onClick={() => void remove()} loading={busy === "delete"}>{busy === "delete" ? "Deleting…" : "Delete endpoint"}</Button>
          </div>
        </div>
      )}

      <div role="status" className="kwh-live">
        {note && (
          <p className="kwh-msg kwh-in" data-tone={note.tone}>
            <Icon name={note.tone === "ok" ? "check" : "alert"} size={14} sw={2} /><span>{note.text}</span>
          </p>
        )}
      </div>

      <div className="kwh-dl-head">
        <h4 className="kwh-dl-title" id={`${ids}-dl`}>Recent deliveries</h4>
        <IconButton icon="refresh" size="sm" label="Refresh deliveries" onClick={() => void loadDeliveries()} disabled={refreshing} />
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      {deliveries === null && !loadError ? (
        <p className="kwh-dl-empty" role="status"><span className="kspin" aria-hidden="true" /> Loading deliveries…</p>
      ) : loadError ? (
        <p className="kwh-dl-empty" role="alert">{loadError}</p>
      ) : deliveries && deliveries.length === 0 ? (
        <p className="kwh-dl-empty">Nothing sent yet.{hook.canManage ? " Send a test to see what a delivery looks like." : ""}</p>
      ) : (
        <ul className="kwh-dl" aria-labelledby={`${ids}-dl`}>
          {deliveries!.map((d) => (
            // a test isn't sent again (Send test makes a new one); nothing goes to a switched-off endpoint
            <DeliveryItem key={d.id} d={d} canRedeliver={hook.canManage && hook.active && d.event !== "ping"} busy={busy === "redeliver"} onRedeliver={() => void redeliver(d)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DeliveryItem({ d, canRedeliver, busy, onRedeliver }: { d: WebhookDelivery; canRedeliver: boolean; busy: boolean; onRedeliver: () => void }) {
  const label = d.event === "ping" ? "Test event" : WEBHOOK_EVENT_INFO[d.event as WebhookEvent]?.label ?? d.event;
  const code = d.statusCode && d.statusCode > 0 ? `HTTP ${d.statusCode}` : null;
  const status = d.state === "delivered"
    ? <Pill tone="ok" icon="check">Delivered{code ? ` · ${d.statusCode}` : ""}</Pill>
    : d.state === "failed"
      ? <Pill tone="signal" icon="x">Failed{code ? ` · ${d.statusCode}` : ""}</Pill>
      : d.attempt === 0
        ? <Pill tone="neutral" icon="clock">Sending</Pill>
        : <Pill tone="warn" icon="refresh">Retrying{code ? ` · ${d.statusCode}` : ""}</Pill>;
  const bits: string[] = [];
  if (d.durationMs != null && d.attempt > 0) bits.push(d.durationMs >= 1000 ? `${(d.durationMs / 1000).toFixed(1)} s` : `${d.durationMs} ms`);
  if (d.attempt > 1) bits.push(`attempt ${d.attempt}`);
  if (d.state === "pending" && d.attempt > 0 && d.nextAttemptAt) bits.push(`next try ${soonText(d.nextAttemptAt)}`);
  return (
    <li className="kwh-dl-item">
      <div className="kwh-dl-main">
        <span className="kwh-dl-event">{label} <code className="kwh-code">{d.event}</code></span>
        <span className="kwh-dl-meta">
          <time dateTime={d.createdAt} title={fullTime(d.createdAt)}>{agoText(d.createdAt)}</time>
          {bits.length ? ` · ${bits.join(" · ")}` : ""}
        </span>
        {d.error && d.state !== "delivered" && <span className="kwh-dl-error">{d.error}</span>}
      </div>
      <div className="kwh-dl-side">
        {status}
        {canRedeliver && (d.state === "failed" || (d.state === "pending" && d.attempt > 0)) && (
          <Button size="sm" variant="ghost" icon="send" onClick={onRedeliver} disabled={busy}
            aria-label={`Send this ${label.toLowerCase()} again`}>Send again</Button>
        )}
      </div>
    </li>
  );
}

/* ============================================================ how to verify */

function VerifyHelp() {
  return (
    <details className="kwh-help">
      <summary><Icon name="chevronRight" size={14} sw={2} />How to check a delivery came from Kanbo</summary>
      <div className="kwh-help-body">
        <p>
          Every delivery has a <code className="kwh-code">Kanbo-Signature</code> header like <code className="kwh-code">t=1760000000,v1=5257a8…</code>.
          Work out an HMAC-SHA256 of <code className="kwh-code">t + "." + the raw body</code> with your signing secret, compare it with
          <code className="kwh-code"> v1</code>, and turn away anything older than five minutes. The same event keeps its
          <code className="kwh-code"> id</code> across retries, so you can ignore repeats.
        </p>
        <pre className="kwh-pre" tabIndex={0} aria-label="Node.js example"><code>{`import crypto from "node:crypto";

function fromKanbo(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = crypto.createHmac("sha256", secret)
    .update(\`\${parts.t}.\${rawBody}\`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
  const given = Buffer.from(parts.v1 ?? "");
  return fresh && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), given);
}`}</code></pre>
      </div>
    </details>
  );
}

/* ============================================================
   KANBO — Settings › Developers: Connect your AI.               [0050]
   The address to paste, short click-by-click steps for each AI app (written
   from their docs as they stood on 4 Nov 2026: docs/integrations/mcp.md has the
   sources), and the apps connected so far, each with Revoke.
   Until migration 0050 and the mcp function are live it says plainly that it
   isn't switched on yet, and nothing else changes.
   Data: lib/mcpOAuth (demo mode: example connections in memory).
   ============================================================ */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, Icon, Pill } from "../primitives";
import { SetGroup, SetNote, SetRow } from "../integrations/settingsBits";
import { copyText } from "../rituals/shared";
import { apiBaseUrl } from "../../lib/apiKeys";
import { isSupabaseConfigured } from "../../lib/supabase";
import { cursorInstallLink, listConnectedApps, MCP_COPY, MCP_RESOURCE, McpNotReady, revokeConnectedApp, type ConnectedApp } from "../../lib/mcpOAuth";
import { fmtKeyDate, fmtLastUsed } from "./DevelopersPanel";
import "./developers.css";

type Tab = "claude" | "chatgpt" | "cursor" | "claude-code" | "code";
const TABS: { id: Tab; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "cursor", label: "Cursor" },
  { id: "claude-code", label: "Claude Code" },
  { id: "code", label: "Your own code" },
];

/** A block of text to copy: a command or an example. */
function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    const ok = await copyText(text);
    setCopied(ok);
    setFailed(!ok);
  };
  return (
    <div className="kcai-copy">
      <pre className="kcai-pre" tabIndex={0} aria-label={label}><code>{text}</code></pre>
      <Button size="sm" icon={copied ? "check" : "copy"} onClick={() => void copy()} aria-label={copied ? `${label}: copied` : `Copy ${label}`}>{copied ? "Copied" : "Copy"}</Button>
      <div role="status" className="kdev-live">
        {failed && <p className="kset-hint">Couldn't copy automatically. Select the text and copy it with your keyboard.</p>}
      </div>
    </div>
  );
}

function Steps({ children, start }: { children: ReactNode; start?: number }) {
  return <ol className="kcai-steps" start={start}>{children}</ol>;
}

function TabBody({ tab }: { tab: Tab }) {
  const base = apiBaseUrl();
  switch (tab) {
    case "claude":
      return (
        <>
          <Steps>
            <li>In Claude, go to <strong>Customize › Connectors</strong>.</li>
            <li>Choose <strong>Add custom connector</strong>.</li>
            <li>Call it Kanbo and paste the address above. If it asks how to sign in, choose <strong>Sign in now</strong> and <strong>Use Claude's published identity</strong>.</li>
            <li>Choose <strong>Add</strong>, then <strong>Connect</strong>. Sign in to Kanbo and press <strong>Allow</strong>.</li>
          </Steps>
          <p className="kcai-note">Works on every Claude plan. The Free plan allows one custom connector. On Team and Enterprise an Owner adds it first under <strong>Organization settings › Connectors</strong>, then each person chooses Connect. Once added it works in Claude on the web, on desktop and on your phone.</p>
        </>
      );
    case "chatgpt":
      return (
        <>
          <Steps>
            <li>On the ChatGPT website, go to <strong>Plugins</strong> and choose the plus button, then <strong>Add custom MCP server</strong>.</li>
            <li>Call it Kanbo and paste the address above under <strong>Connection</strong>. Leave the sign-in choice on OAuth.</li>
            <li>Read the warning, choose <strong>I understand and want to continue</strong>, then <strong>Create as a plugin</strong>.</li>
            <li>Install the plugin, sign in to Kanbo and press <strong>Allow</strong>. In a new chat, type <code>@</code> and pick Kanbo.</li>
          </Steps>
          <p className="kcai-note">Reading and changing needs a Business, Enterprise or Edu plan (on Business, an admin or owner adds it). Pro can read but not change. Plus and Free aren't listed by OpenAI, so check your account. It can only be added on the website.</p>
        </>
      );
    case "cursor":
      return (
        <>
          <p className="kcai-lead"><a className="kbtn kcai-install" href={cursorInstallLink()}>Add Kanbo to Cursor</a></p>
          <Steps>
            <li>Choose the button above and let Cursor open. Or add this to <code>~/.cursor/mcp.json</code>:</li>
          </Steps>
          <CopyBlock label="Cursor settings" text={JSON.stringify({ mcpServers: { kanbo: { url: MCP_RESOURCE } } }, null, 2)} />
          <Steps start={2}>
            <li>Cursor asks you to sign in. Sign in to Kanbo and press <strong>Allow</strong>.</li>
          </Steps>
        </>
      );
    case "claude-code":
      return (
        <>
          <p className="kcai-lead">Run this once in your terminal:</p>
          <CopyBlock label="Claude Code command" text={`claude mcp add --transport http kanbo ${MCP_RESOURCE}`} />
          <Steps>
            <li>In Claude Code, run <code>/mcp</code> and choose kanbo. Sign in to Kanbo and press <strong>Allow</strong>.</li>
          </Steps>
          <p className="kcai-note">To remove it later, run <code>claude mcp logout kanbo</code> first and then <code>claude mcp remove kanbo</code>: removing alone doesn't end the connection. Revoke below does.</p>
        </>
      );
    case "code":
      return (
        <>
          <p className="kcai-lead">Make an API key below (read-only keys start kanbo_pk_, read and write keys start kanbo_sk_), then use it with either door. The same key works for both, with your access.</p>
          <p className="kcai-sub">The MCP server</p>
          <CopyBlock label="MCP example" text={`curl ${MCP_RESOURCE} \\
  -H "Authorization: Bearer $KANBO_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"my_day","arguments":{}}}'`} />
          <p className="kcai-sub">The REST API</p>
          <CopyBlock label="REST example" text={`curl -H "Authorization: Bearer $KANBO_API_KEY" \\
  "${base}/tasks?assignee=me&status=todo,progress"`} />
          <p className="kcai-note">The whole REST API is in the <a className="kset-link" href={`${base}/openapi.json`} target="_blank" rel="noreferrer">OpenAPI document</a>. The Anthropic and OpenAI APIs can call the MCP server for you with the same key: <a className="kset-link" href="https://github.com/Danchappell7/Kora/blob/main/docs/integrations/mcp.md" target="_blank" rel="noreferrer">examples</a>.</p>
        </>
      );
  }
}

type Load = { state: "loading" } | { state: "ready"; apps: ConnectedApp[] } | { state: "off" } | { state: "error"; message: string };

export function ConnectAiPanel() {
  const ids = "kcai" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [tab, setTab] = useState<Tab>("claude");
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [ask, setAsk] = useState(0);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "signal"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let on = true;
    setLoad({ state: "loading" });
    listConnectedApps()
      .then((apps) => { if (on) setLoad({ state: "ready", apps }); })
      .catch((e) => {
        if (!on) return;
        if (e instanceof McpNotReady) setLoad({ state: "off" });
        else setLoad({ state: "error", message: /failed to fetch|network/i.test(String(e?.message)) ? MCP_COPY.offline : "Couldn't load your connected apps." });
      });
    return () => { on = false; };
  }, [ask]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);

  const copyAddress = async () => {
    const ok = await copyText(MCP_RESOURCE);
    setCopied(ok);
    if (!ok) { addressRef.current?.focus(); addressRef.current?.select(); }
  };

  const onTabKey = useCallback((e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const to = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
      : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(TABS[to].id);
    tabRefs.current[TABS[to].id]?.focus();
  }, [tab]);

  const revoke = async (app: ConnectedApp) => {
    setBusyId(app.id);
    setMsg(null);
    try {
      await revokeConnectedApp(app.id);
      if (!alive.current) return;
      setConfirmId(null);
      setLoad((l) => (l.state === "ready" ? { state: "ready", apps: l.apps.filter((a) => a.id !== app.id) } : l));
      setMsg({ tone: "ok", text: `Disconnected “${app.name}”. It has stopped working.` });
    } catch {
      if (alive.current) setMsg({ tone: "signal", text: MCP_COPY.failed });
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  return (
    <div className="kcai">
      <SetGroup title="Connect your AI">
        <div className="kcai-address">
          <p className="kcai-address-lead" id={`${ids}-al`}>Let Claude, ChatGPT, Cursor or your own agents read and manage your Kanbo, as you and with your access. Paste this one address into your AI app, sign in to Kanbo and press Allow.</p>
          {load.state === "off" && (
            <p className="kdev-warn kcai-off" role="status"><Icon name="alert" size={14} sw={2} /><span>This isn't switched on yet: until Kanbo's server is updated the address won't answer. Everything else in Kanbo carries on as normal.</span></p>
          )}
          <div className="kdev-keyfield">
            <input ref={addressRef} className="kdev-keyinput" type="text" readOnly value={MCP_RESOURCE} aria-labelledby={`${ids}-al`} spellCheck={false} autoComplete="off" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="primary" icon={copied ? "check" : "copy"} onClick={() => void copyAddress()} aria-label={copied ? "Address copied" : "Copy address"}>{copied ? "Copied" : "Copy"}</Button>
          </div>
          <p className="kcai-note">Paste it exactly, with the www: an AI app that's sent from kanbo.co.uk to www.kanbo.co.uk loses its sign-in.</p>
        </div>
        <div className="kcai-tabs">
          <div role="tablist" aria-label="Which AI app" className="kcai-tablist" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button key={t.id} ref={(el) => { tabRefs.current[t.id] = el; }} type="button" role="tab" id={`${ids}-tab-${t.id}`}
                className="kcai-tab" aria-selected={tab === t.id} aria-controls={`${ids}-panel`} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${tab}`} className="kcai-panel" tabIndex={0}>
            <TabBody tab={tab} />
          </div>
        </div>
      </SetGroup>

      <SetGroup title="Connected AI apps">
        {load.state === "loading" && (
          <SetRow icon={<Icon name="link" size={16} sw={1.75} />} label="Connected AI apps"
            desc={<span className="kdev-checking" role="status"><span className="kspin" aria-hidden="true" />Loading…</span>} />
        )}
        {load.state === "off" && (
          <SetRow icon={<Icon name="lock" size={16} sw={1.75} />} label="Not switched on yet" desc="Once it is, the AI apps you connect will show here." />
        )}
        {load.state === "error" && (
          <SetRow icon={<Icon name="alert" size={16} sw={1.75} />} label="Couldn't load them" desc={load.message}>
            <Button size="sm" icon="refresh" onClick={() => setAsk((n) => n + 1)}>Try again</Button>
          </SetRow>
        )}
        {load.state === "ready" && load.apps.length === 0 && (
          <SetRow icon={<Icon name="link" size={16} sw={1.75} />} label="None yet" desc="AI apps you allow will show here, and you can disconnect them at any time." />
        )}
        {load.state === "ready" && load.apps.length > 0 && (
          <ul className="kdev-keys" aria-label="Connected AI apps">
            {load.apps.map((a) => (
              <li key={a.id} className="kdev-key" data-status="active">
                <div className="kdev-key-main">
                  <span className="kdev-key-icon" aria-hidden="true"><Icon name="link" size={16} sw={1.75} /></span>
                  <div className="kdev-key-text">
                    <div className="kdev-key-top">
                      <span className="kdev-key-name"><bdi>{a.name}</bdi></span>
                      {a.host && <code className="kdev-prefix">{a.host}</code>}
                    </div>
                    <div className="kdev-pills">
                      <Pill tone={a.access === "write" ? "accent" : "neutral"}>{a.access === "write" ? "Read and change" : "Read only"}</Pill>
                      <Pill tone="neutral" icon={a.workspaceId ? "users" : "user"}>{a.workspaceId ? a.workspaceName ?? "One workspace" : "All my workspaces"}</Pill>
                    </div>
                    <p className="kdev-key-meta">
                      <span>Connected {fmtKeyDate(a.createdAt)}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{fmtLastUsed(a.lastUsedAt)}</span>
                    </p>
                  </div>
                  {confirmId !== a.id && <Button size="sm" variant="ghost" className="kdev-revoke" onClick={() => { setConfirmId(a.id); setMsg(null); }} aria-label={`Revoke ${a.name}`}>Revoke</Button>}
                </div>
                {confirmId === a.id && (
                  <div role="group" aria-label={`Revoke ${a.name}?`} className="kset-panel kdev-in" data-tone="signal">
                    <p className="kset-panel-title">Revoke “<bdi>{a.name}</bdi>”?</p>
                    <p className="kset-panel-text">It stops working on its next request. You can connect it again whenever you like.</p>
                    <div className="kset-panel-acts">
                      <Button variant="ghost" onClick={() => setConfirmId(null)} disabled={busyId === a.id}>Cancel</Button>
                      <Button variant="danger" icon="x" onClick={() => void revoke(a)} loading={busyId === a.id}>{busyId === a.id ? "Revoking…" : "Revoke"}</Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </SetGroup>
      <div role="status" className="kdev-live">
        {msg && <p className="kdev-msg" data-tone={msg.tone}>{msg.tone === "ok" ? <Icon name="check" size={14} sw={2.25} /> : <Icon name="alert" size={14} sw={2} />}<span>{msg.text}</span></p>}
      </div>
      {!isSupabaseConfigured && <SetNote>This is the demo: these connections are examples.</SetNote>}
    </div>
  );
}

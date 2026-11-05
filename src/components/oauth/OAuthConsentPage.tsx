/* ============================================================
   KANBO — /oauth/authorize: "Allow <app> to use your Kanbo?"     [0050]
   Where Claude, ChatGPT, Cursor and others send people to connect. Root keeps
   the request through signing in (lib/oauthRequest) and shows this page instead
   of the app once someone is signed in.

   It always asks: there is no silent re-approval. The name is whatever the app
   calls itself, so the page says so, and shows the host it will send you back
   to (and the app's own published host, when it has one). A bad client or a bad
   redirect address stops here and never redirects.

   Nothing here ever leaves without a click. Anyone can register an app and name
   any address, so a registered address proves nothing (RFC 9700 section 4.11.2):
   a link with a mistake in it stops here too, with a button back to the app's
   host, rather than bouncing a signed-in person straight to wherever it says.
   Cancel and Allow go back with location.assign, so no form and no CSP
   form-action is involved. Postgres checks everything again when Allow is pressed.

   A page of its own (no dialog over the app), lazy loaded, in both themes, at 390px.
   ============================================================ */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Icon } from "../primitives";
import { isSupabaseConfigured } from "../../lib/supabase";
import { forgetOAuthRequest } from "../../lib/oauthRequest";
import { parseAuthorizeRequest, type AuthorizeRequest } from "../../../supabase/functions/_shared/mcp/oauthCore.ts";
import {
  allowUrl, ApproveError, approveConnection, approveFailure, consentWorkspaces, denyUrl, MCP_COPY, prepareClient,
  type ConsentWorkspace, type McpAccess, type PreparedClient,
} from "../../lib/mcpOAuth";
import "./oauth.css";

export interface OAuthConsentPageProps {
  /** the query string /oauth/authorize was opened with, without the "?" */
  query: string;
  /** the signed-in person's email */
  email?: string | null;
  /** leave the page for the app (nothing to do here any more) */
  onClose: () => void;
  /** where the browser goes (tests pass a spy) */
  navigate?: (url: string) => void;
}

type View =
  | { kind: "loading" }
  | { kind: "ask"; request: AuthorizeRequest; client: PreparedClient; workspaces: ConsentWorkspace[] }
  | { kind: "sent"; host: string; denied: boolean }
  | { kind: "dead"; title: string; body: string; retry?: boolean; back?: { url: string; host: string } };

const go = (url: string) => { window.location.assign(url); };

/** Leaving for the app: the request is finished with, so this tab won't ask about it again. */
const leave = (navigate: (url: string) => void, url: string) => { forgetOAuthRequest(); navigate(url); };

export function OAuthConsentPage({ query, email = null, onClose, navigate = go }: OAuthConsentPageProps) {
  const ids = "koauth" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const parsed = useMemo(() => parseAuthorizeRequest(new URLSearchParams(query)), [query]);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [access, setAccess] = useState<McpAccess>("write");
  const [scope, setScope] = useState<"all" | "one">("all");
  const [workspaceId, setWorkspaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let on = true;
    setView({ kind: "loading" });
    if (parsed.kind === "fatal") {
      setView({ kind: "dead", title: "This link isn't complete", body: parsed.reason === "bad_redirect"
        ? "The app asked to send you back to an address Kanbo won't use, so Kanbo stopped here. Nothing was connected."
        : "It doesn't say which app is asking. Start connecting again from the app." });
      return;
    }
    const clientId = parsed.kind === "ok" ? parsed.request.clientId : parsed.clientId;
    const redirectUri = parsed.kind === "ok" ? parsed.request.redirectUri : parsed.redirectUri;
    (async () => {
      const answer = await prepareClient(clientId, redirectUri);
      if (!on) return;
      if (!answer.ok) {
        const dead: View = answer.reason === "not_ready" ? { kind: "dead", title: "Not switched on yet", body: answer.message }
          : answer.reason === "unavailable" ? { kind: "dead", title: "Couldn't check this app", body: answer.message, retry: true }
          : answer.reason === "signed_out" ? { kind: "dead", title: "Sign in first", body: answer.message }
          : { kind: "dead", title: "Kanbo can't connect this app", body: answer.message };
        setView(dead);
        return;
      }
      // the address is one this app registered, which says nothing about who registered it: only a click goes there
      if (parsed.kind === "redirect_error") {
        setView({
          kind: "dead",
          title: "This request isn't valid",
          body: `The link from the app has a mistake in it, so Kanbo stopped here and nothing was connected. If you were connecting an app you trust, start again from the app. The address it gave is ${answer.client.redirectHost}.`,
          back: { url: denyUrl(parsed.redirectUri, parsed.state, parsed.error, parsed.description), host: answer.client.redirectHost },
        });
        return;
      }
      if (parsed.kind !== "ok") return;
      const workspaces = await consentWorkspaces().catch(() => [] as ConsentWorkspace[]);
      if (!on) return;
      setAccess(parsed.request.wantsWrite ? "write" : "read");
      setWorkspaceId(workspaces[0]?.id ?? "");
      setScope("all");
      setView({ kind: "ask", request: parsed.request, client: answer.client, workspaces });
    })().catch(() => { if (on) setView({ kind: "dead", title: "Couldn't check this app", body: MCP_COPY.checkFailed, retry: true }); });
    return () => { on = false; };
    // navigate is stable for the life of the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, ask]);

  // each new step is announced by moving focus to its heading
  useEffect(() => { if (view.kind !== "loading") headingRef.current?.focus(); }, [view.kind]);

  const allow = async (e: FormEvent) => {
    e.preventDefault();
    if (view.kind !== "ask" || busy) return;
    const ws = scope === "one" ? workspaceId : null;
    if (scope === "one" && !ws) { setError("Choose which workspace."); return; }
    setBusy(true); setError(null);
    try {
      const code = await approveConnection(view.request, access, ws);
      if (!alive.current) return;
      if (!isSupabaseConfigured) { setView({ kind: "dead", title: "This is the demo", body: `In real Kanbo, this is where you'd go back to ${view.client.redirectHost}, connected. Nothing was sent.` }); return; }
      leave(navigate, allowUrl(view.request, code));
      setView({ kind: "sent", host: view.client.redirectHost, denied: false });
    } catch (err) {
      if (!alive.current) return;
      setError((err instanceof ApproveError ? err : approveFailure(err)).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const cancel = () => {
    if (view.kind !== "ask") { onClose(); return; }
    if (!isSupabaseConfigured) { onClose(); return; }
    leave(navigate, denyUrl(view.request.redirectUri, view.request.state));
    setView({ kind: "sent", host: view.client.redirectHost, denied: true });
  };

  const titleId = `${ids}-t`;
  const c = view.kind === "ask" ? view.client : null;
  return (
    <main className="koauth-page" aria-labelledby={titleId}>
      <div className="koauth-card">
        <div className="koauth-mark" aria-hidden="true"><Icon name="link" size={22} sw={1.75} /></div>
        {view.kind === "loading" && (
          <>
            <h1 id={titleId} className="koauth-title">Connect an app to Kanbo</h1>
            <p className="koauth-body" role="status"><span className="kspin" aria-hidden="true" /> Checking this app…</p>
          </>
        )}

        {view.kind === "ask" && c && (
          <form onSubmit={allow} noValidate>
            <h1 id={titleId} ref={headingRef} tabIndex={-1} className="koauth-title">Allow <bdi>{c.name}</bdi> to use your Kanbo?</h1>
            <dl className="koauth-facts">
              <div>
                <dt>Sends you back to</dt>
                <dd><code>{c.redirectHost}</code></dd>
              </div>
              {c.clientHost && (
                <div>
                  <dt>Published by</dt>
                  <dd><code>{c.clientHost}</code></dd>
                </div>
              )}
              {email && (
                <div>
                  <dt>Signed in as</dt>
                  <dd>{email}</dd>
                </div>
              )}
            </dl>
            <p className="koauth-note"><span className="koauth-note-name">“<bdi>{c.name}</bdi>”</span> is the name the app gave itself. Kanbo can't vouch for it, so check the address above is what you expect.</p>
            {c.loopback && (
              <div className="koauth-warn" role="note">
                <Icon name="alert" size={16} sw={2} />
                <p>This app runs on this computer. Only allow it if you've just started it yourself.</p>
              </div>
            )}

            <fieldset className="koauth-choices" disabled={busy}>
              <legend>What it can do</legend>
              {view.request.wantsWrite && (
                <label className="koauth-choice">
                  <input type="radio" name={`${ids}-access`} checked={access === "write"} onChange={() => setAccess("write")} />
                  <span className="koauth-choice-text">
                    <span className="koauth-choice-label">Read and change</span>
                    <span className="koauth-choice-desc">See your tasks and projects, add and change them, and move tasks to the recycle bin.</span>
                  </span>
                </label>
              )}
              <label className="koauth-choice">
                <input type="radio" name={`${ids}-access`} checked={access === "read"} onChange={() => setAccess("read")} />
                <span className="koauth-choice-text">
                  <span className="koauth-choice-label">Read only</span>
                  <span className="koauth-choice-desc">See your tasks and projects. It can't change anything.{view.request.wantsWrite ? "" : " This app only asked to read."}</span>
                </span>
              </label>
            </fieldset>

            <fieldset className="koauth-choices" disabled={busy}>
              <legend>Where</legend>
              <label className="koauth-choice">
                <input type="radio" name={`${ids}-scope`} checked={scope === "all"} onChange={() => { setScope("all"); setError(null); }} />
                <span className="koauth-choice-text">
                  <span className="koauth-choice-label">All my workspaces</span>
                  <span className="koauth-choice-desc">Everything you can see in Kanbo, including your Personal list.</span>
                </span>
              </label>
              {view.workspaces.length > 0 && (
                <label className="koauth-choice">
                  <input type="radio" name={`${ids}-scope`} checked={scope === "one"} onChange={() => setScope("one")} />
                  <span className="koauth-choice-text">
                    <span className="koauth-choice-label">One workspace</span>
                    <span className="koauth-choice-desc">Only that workspace, and not your Personal list.</span>
                  </span>
                </label>
              )}
              {scope === "one" && view.workspaces.length > 0 && (
                <div className="koauth-pick">
                  <label htmlFor={`${ids}-ws`}>Workspace</label>
                  <select id={`${ids}-ws`} className="koauth-select" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} disabled={busy}>
                    {view.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </div>
              )}
            </fieldset>

            <p className="koauth-small">It can never do more than you can, and where you're a guest it can only read and comment. You can disconnect it any time in Settings › Developers.</p>
            <p className="koauth-err" role="alert">{error ?? ""}</p>
            <div className="koauth-acts">
              <Button onClick={cancel} disabled={busy}>Cancel</Button>
              <Button type="submit" variant="primary" loading={busy} data-autofocus>Allow</Button>
            </div>
          </form>
        )}

        {view.kind === "sent" && (
          <>
            <h1 id={titleId} ref={headingRef} tabIndex={-1} className="koauth-title">{view.denied ? "Nothing was connected" : "All done"}</h1>
            <p className="koauth-body" role="status">Taking you back to <code>{view.host}</code>. If nothing happens, you can close this tab and go back to the app.</p>
            <div className="koauth-acts"><Button onClick={onClose}>Open Kanbo</Button></div>
          </>
        )}

        {view.kind === "dead" && (
          <>
            <h1 id={titleId} ref={headingRef} tabIndex={-1} className="koauth-title">{view.title}</h1>
            <p className="koauth-body" role={view.retry ? "alert" : undefined}>{view.body}</p>
            <div className="koauth-acts">
              {view.retry && <Button icon="refresh" onClick={() => setAsk((n) => n + 1)}>Try again</Button>}
              {view.back && (
                <Button onClick={() => {
                  if (!isSupabaseConfigured) { onClose(); return; }
                  const { url, host } = view.back!;
                  leave(navigate, url);
                  setView({ kind: "sent", host, denied: true });
                }}>
                  Go back to <bdi className="koauth-host">{view.back.host}</bdi>
                </Button>
              )}
              <Button variant="primary" onClick={onClose}>Back to Kanbo</Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default OAuthConsentPage;

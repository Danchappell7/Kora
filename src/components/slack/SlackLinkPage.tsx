/* ============================================================
   KANBO — /link/slack: "Link your Slack account?" (X · Y)       [0049]
   Where /kanbo's one-time "Link your Kanbo account" button lands. Signed
   in, it asks first (whose Slack account, in which Slack workspace), then
   claims the link: /kanbo then adds tasks as this person, with their
   access. Signed out, Root sends people to sign in first and keeps the
   token (lib/slackLinkToken) so App opens this page straight after.

   When the Slack account's email isn't this Kanbo account's (or Slack
   didn't share one), linking needs a ticked "This Slack account is mine":
   a link someone else sends you can't quietly tie their Slack to your
   Kanbo. Used, expired and unknown links say so, with what to do next.

   A full-screen dialog over the app (focus trapped, Escape = Cancel).
   Mount (integrator): App, when slackLinkToOpen(location) gives a token —
     <SlackLinkPage token={t} email={auth.user?.email} onDone={() => { forgetSlackLink(); setT(null); }} />
   ============================================================ */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button, Icon } from "../primitives";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import {
  claimSlackLink, forgetSlackLink, previewSlackLink, SLACK_APP_COPY, SlackAppError, slackAppFailure, slackTeamLabel,
  type SlackLinkPreview, type SlackLinkResult,
} from "../../lib/slackApp";
import "./slackApp.css";

export interface SlackLinkPageProps {
  /** the one-time token from /link/slack?t=… */
  token: string;
  /** closed (linked, cancelled or nothing to do): the host drops the page */
  onDone: () => void;
  /** the signed-in person's email, to say which Kanbo account the Slack account joins */
  email?: string | null;
}

type View =
  | { kind: "loading" }
  | { kind: "ask"; preview: SlackLinkPreview }
  | { kind: "linked"; result: SlackLinkResult }
  | { kind: "dead"; title: string; body: string }
  | { kind: "failed"; message: string };

export function SlackLinkPage({ token, onDone, email = null }: SlackLinkPageProps) {
  const ids = "kslka" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [view, setView] = useState<View>({ kind: "loading" });
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const close = () => { forgetSlackLink(); onDone(); };
  const trap = useFocusTrap<HTMLDivElement>(true, () => { if (!busy) close(); });
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let on = true;
    setView({ kind: "loading" });
    previewSlackLink(token).then((p) => {
      if (!on) return;
      if (!p) setView({ kind: "dead", title: "This link isn't valid", body: SLACK_APP_COPY.invalidLink });
      else if (p.status === "used") setView({ kind: "dead", title: "This link has been used", body: SLACK_APP_COPY.used });
      else if (p.status === "expired") setView({ kind: "dead", title: "This link has expired", body: SLACK_APP_COPY.expired });
      else setView({ kind: "ask", preview: p });
    }).catch((e) => { if (on) setView({ kind: "failed", message: slackAppFailure(e).message }); });
    return () => { on = false; };
  }, [token, ask]);

  // each new step is announced by moving focus to its heading
  useEffect(() => { if (view.kind !== "loading") headingRef.current?.focus(); }, [view.kind]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (view.kind !== "ask" || busy) return;
    const p = view.preview;
    const needsTick = !p.emailMatches;
    if (needsTick && !mine) { setError("Tick the box to confirm this Slack account is yours."); return; }
    setBusy(true); setError(null);
    try {
      const result = await claimSlackLink(token, needsTick && mine);
      if (!alive.current) return;
      forgetSlackLink();
      setView({ kind: "linked", result });
    } catch (err) {
      if (!alive.current) return;
      const f = err instanceof SlackAppError ? err : slackAppFailure(err);
      if (f.reason === "used" || f.reason === "expired" || f.reason === "invalid_link") {
        setView({ kind: "dead", title: f.reason === "used" ? "This link has been used" : f.reason === "expired" ? "This link has expired" : "This link isn't valid", body: f.message });
      } else setError(f.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const titleId = `${ids}-t`;
  const descId = `${ids}-d`;
  const whoId = `${ids}-w`;
  const asking = view.kind === "ask" && !view.preview.alreadyLinked;
  return (
    <div className="kslka-page" role="presentation">
      <div ref={trap} className="kslka-card" role="dialog" aria-modal="true" aria-labelledby={asking ? `${titleId} ${whoId}` : titleId} aria-describedby={view.kind === "loading" ? undefined : descId} tabIndex={-1}>
        <div className="kslka-mark" aria-hidden="true"><Icon name="message" size={22} sw={1.75} /></div>
        {view.kind === "loading" && (
          <>
            <h1 id={titleId} className="kslka-title">Link Slack to Kanbo</h1>
            <p className="kslka-body" role="status"><span className="kspin" aria-hidden="true" /> Checking your link…</p>
          </>
        )}

        {view.kind === "ask" && (() => {
          const p = view.preview;
          const who = p.slackUserName || "this Slack account";
          const team = slackTeamLabel(p.teamName, p.teamId ?? undefined);
          if (p.alreadyLinked) {
            return (
              <>
                <h1 id={titleId} ref={headingRef} tabIndex={-1} className="kslka-title">Slack is already linked</h1>
                <p id={descId} className="kslka-body"><strong>{who}</strong> in <strong>{team}</strong> is already linked to your Kanbo account. You can use <code>/kanbo</code> in Slack now.</p>
                <div className="kslka-acts"><Button variant="primary" onClick={close} data-autofocus>Done</Button></div>
              </>
            );
          }
          return (
            <form onSubmit={submit} noValidate>
              <h1 id={titleId} ref={headingRef} tabIndex={-1} className="kslka-title">Link your Slack account?</h1>
              <p id={whoId} className="kslka-who"><strong>{who}</strong><span aria-hidden="true"> · </span><span className="sr-only"> in </span><span className="kslka-who-team">{team}</span></p>
              <div id={descId}>
                <p className="kslka-body">
                  Then <code>/kanbo</code> and <strong>Create a Kanbo task</strong> in {team} add tasks as you{email ? <> (<strong>{email}</strong>)</> : null}, with your own access, and Kanbo links you share there can show a preview.
                </p>
                {!p.emailMatches && (
                  <div className="kslka-warn" role="note">
                    <Icon name="alert" size={16} sw={2} />
                    <p>{p.hasEmail
                      ? "This Slack account's email isn't the one you use for Kanbo. Only link it if this Slack account is yours: if someone sent you this link, cancel."
                      : "Slack didn't share this account's email, so Kanbo can't check it's yours. Only link it if it is: if someone sent you this link, cancel."}</p>
                  </div>
                )}
                {!p.emailMatches && (
                  <label className="kslka-check">
                    <input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); setError(null); }}
                      aria-describedby={error ? `${ids}-err` : undefined} aria-invalid={!!error && !mine} />
                    <span>This Slack account is mine</span>
                  </label>
                )}
              </div>
              <p id={`${ids}-err`} className="kslka-err" role="alert">{error ?? ""}</p>
              <div className="kslka-acts">
                <Button onClick={close} disabled={busy}>Cancel</Button>
                <Button type="submit" variant="primary" icon="link" loading={busy} data-autofocus>Link account</Button>
              </div>
            </form>
          );
        })()}

        {view.kind === "linked" && (
          <>
            <h1 id={titleId} ref={headingRef} tabIndex={-1} className="kslka-title">Slack is linked</h1>
            <div id={descId}>
              <p className="kslka-body"><strong>{view.result.slackUserName || "Your Slack account"}</strong> in <strong>{slackTeamLabel(view.result.teamName, view.result.teamId)}</strong> is now linked to Kanbo. Go back to Slack and try:</p>
              <p className="kslka-example"><code>/kanbo Send the brief fri 3pm</code></p>
              <p className="kslka-note">You can unlink it any time in Settings › Calendar &amp; integrations.</p>
            </div>
            <div className="kslka-acts"><Button variant="primary" onClick={close} data-autofocus>Open Kanbo</Button></div>
          </>
        )}

        {view.kind === "dead" && (
          <>
            <h1 id={titleId} ref={headingRef} tabIndex={-1} className="kslka-title">{view.title}</h1>
            <p id={descId} className="kslka-body">{view.body}</p>
            <div className="kslka-acts"><Button variant="primary" onClick={close} data-autofocus>Back to Kanbo</Button></div>
          </>
        )}

        {view.kind === "failed" && (
          <>
            <h1 id={titleId} ref={headingRef} tabIndex={-1} className="kslka-title">Couldn't check this link</h1>
            <p id={descId} className="kslka-body" role="alert">{view.message}</p>
            <div className="kslka-acts">
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" icon="refresh" onClick={() => setAsk((n) => n + 1)} data-autofocus>Try again</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default SlackLinkPage;

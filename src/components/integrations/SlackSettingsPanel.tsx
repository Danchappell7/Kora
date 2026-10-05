/* ============================================================
   KANBO — Settings › Calendar & integrations › Slack.            [f6-slack]
   Owners/admins: paste an Incoming Webhook URL (Connect), Send test,
   Disconnect, daily stand-up auto-post on/off + time. Members/guests: see
   whether it's connected (and to which channel label), nothing else.
   Personal workspace: explains Slack is per team workspace.
   Demo: works against lib/slack's in-memory fake.
   Mount (integrator): inside SettingsModal's calendar section, after the
   Calendars group, with the active workspace.

   The webhook link is a secret: once saved it's never shown again (the
   field clears; the row says "Connected to #channel"). Before migration
   0043 runs the panel explains that Slack isn't switched on yet.

   While the daily stand-up is on, owners/admins are told when it isn't
   really going out (slack-post's "status" action): Kanbo's scheduler isn't
   running yet (slack-standup not deployed or its pg_cron job missing), or
   Slack refused the last one (link removed, channel archived…). If that
   can't be checked (slack-post not deployed), a quiet line says so.
   ============================================================ */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Role, SlackStatus } from "../../data/types";
import { Button, Icon, Toggle } from "../primitives";
import { isSupabaseConfigured } from "../../lib/supabase";
import {
  autopostNote, connectSlack, DEFAULT_AUTOPOST_TIME, disconnectSlack, isSlackWebhookUrl, loadSlackAutopostHealth,
  setSlackAutopost, SLACK_AUTOPOST_TIMES, SLACK_COPY, testSlack, type SlackHealthLoad,
} from "../../lib/slack";
import { SetGroup, SetIntro, SetNote, SetRow } from "./settingsBits";
import { useSlackStatus } from "./useSlackStatus";
import "./slack.css";

export interface SlackSettingsPanelProps {
  /** the active workspace (null = Personal) */
  workspaceId: string | null;
  workspaceName?: string;
  /** the viewer's role there (owner/admin manage; the server re-checks) */
  role?: Role | null;
}

type Busy = null | "connect" | "test" | "disconnect";
type Msg = { tone: "ok" | "signal"; text: string } | null;

const SLACK_APPS_URL = "https://api.slack.com/apps";
const slackIcon = <Icon name="send" size={16} sw={1.75} />;

export function SlackSettingsPanel({ workspaceId, workspaceName, role }: SlackSettingsPanelProps) {
  const { status, problem, loading, reload } = useSlackStatus(workspaceId);
  const wsName = workspaceName?.trim() || "this workspace";

  if (!workspaceId) {
    return (
      <div className="kslk">
        <SetGroup title="Slack">
          <SetRow icon={slackIcon} label="Slack is for team workspaces"
            desc="Switch to a team workspace to post its stand-ups, project status updates and risks to a Slack channel." />
        </SetGroup>
      </div>
    );
  }

  if (!status) {
    if (loading) {
      return (
        <div className="kslk">
          <SetGroup title="Slack">
            <SetRow icon={slackIcon} label="Slack" desc={<span className="kslk-checking" role="status"><span className="kspin" aria-hidden="true" />Checking the connection…</span>} />
          </SetGroup>
        </div>
      );
    }
    if (problem === "unavailable") {
      return (
        <div className="kslk">
          <SetGroup title="Slack">
            <SetRow icon={slackIcon} label="Not switched on yet"
              desc="Kanbo's Slack connection hasn't been set up yet. Once it has, owners and admins can connect a channel here." />
          </SetGroup>
        </div>
      );
    }
    return (
      <div className="kslk">
        <SetGroup title="Slack">
          <SetRow icon={slackIcon} label="Couldn't check Slack"
            desc={problem === "offline" ? "You're offline. Kanbo will check again when you're back online." : "Something went wrong reading the Slack connection."}>
            <Button size="sm" icon="refresh" onClick={reload}>Try again</Button>
          </SetRow>
        </SetGroup>
      </div>
    );
  }

  return <SlackPanelBody key={workspaceId} workspaceId={workspaceId} wsName={wsName} status={status} role={role} />;
}

function SlackPanelBody({ workspaceId, wsName, status, role }: { workspaceId: string; wsName: string; status: SlackStatus; role?: Role | null }) {
  const ids = "kslk" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const canManage = status.canManage && (role == null || role === "owner" || role === "admin");
  const where = status.channelLabel || "your Slack channel";

  const [busy, setBusy] = useState<Busy>(null);
  const [editing, setEditing] = useState(false);       // replacing the link of a connected channel
  const [confirmOff, setConfirmOff] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [linkMsg, setLinkMsg] = useState<Msg>(null);    // under the channel row: test result, connected, errors
  const [autoMsg, setAutoMsg] = useState<Msg>(null);
  const [time, setTime] = useState(status.autopostTime || DEFAULT_AUTOPOST_TIME);
  const [autopost, setAutopost] = useState(status.autopost);
  const [saving, setSaving] = useState(false);
  const autoSeq = useRef(0);
  // is the daily post really going out? (owners/admins, while connected)
  const [health, setHealth] = useState<SlackHealthLoad | null>(null);
  const [healthAsk, setHealthAsk] = useState(0);

  const urlRef = useRef<HTMLInputElement>(null);
  const testRef = useRef<HTMLButtonElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const offRef = useRef<HTMLButtonElement>(null);
  const cancelOffRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<HTMLElement | null | "url" | "test" | "replace" | "off" | "cancelOff">(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // follow the server (another tab, another admin) unless a change of ours is in flight
  useEffect(() => {
    if (saving) return;
    setAutopost(status.autopost);
    if (status.autopostTime) setTime(status.autopostTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.autopost, status.autopostTime]);

  // ask the server while the daily post is on: when the panel opens with it
  // on, when it's switched on, and again after a new link is saved
  useEffect(() => {
    if (!canManage || !status.connected || !autopost) return;
    let live = true;
    void loadSlackAutopostHealth(workspaceId).then((h) => { if (live && alive.current) setHealth(h); });
    return () => { live = false; };
  }, [workspaceId, canManage, status.connected, autopost, healthAsk]);

  // move focus where the change put the person, once the DOM has it
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    const el = want === "url" ? urlRef.current : want === "test" ? testRef.current : want === "replace" ? replaceRef.current
      : want === "off" ? offRef.current : want === "cancelOff" ? cancelOffRef.current : want;
    el?.focus();
  });

  // messages fade on their own after a while; errors stay until the next action
  useEffect(() => {
    if (linkMsg?.tone !== "ok") return;
    const t = setTimeout(() => alive.current && setLinkMsg(null), 6000);
    return () => clearTimeout(t);
  }, [linkMsg]);
  useEffect(() => {
    if (autoMsg?.tone !== "ok") return;
    const t = setTimeout(() => alive.current && setAutoMsg(null), 2500);
    return () => clearTimeout(t);
  }, [autoMsg]);

  const showForm = canManage && (!status.connected || editing);

  /* ---- connect / replace ---- */
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const u = url.trim();
    setFormError(null);
    if (!u) { setUrlError("Paste the webhook link from Slack."); urlRef.current?.focus(); return; }
    if (!isSlackWebhookUrl(u)) { setUrlError(u.length > 500 ? SLACK_COPY.tooLong : SLACK_COPY.invalidUrl); urlRef.current?.focus(); return; }
    setUrlError(null);
    setBusy("connect");
    try {
      const s = await connectSlack(workspaceId, u, label);
      if (!alive.current) return;
      setUrl(""); setLabel(""); setEditing(false);
      setHealthAsk((n) => n + 1);   // a new link: the old link's failures no longer apply
      setLinkMsg({ tone: "ok", text: `Connected to ${s.channelLabel || "Slack"}. Send a test to check it.` });
      focusNext.current = "test";
    } catch (err) {
      if (!alive.current) return;
      const text = (err as Error)?.message || SLACK_COPY.saveFailed;
      if (text === SLACK_COPY.invalidUrl || text === SLACK_COPY.tooLong) { setUrlError(text); focusNext.current = "url"; }
      else setFormError(text);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const startReplace = () => {
    setEditing(true); setConfirmOff(false); setLinkMsg(null);
    setUrl(""); setUrlError(null); setFormError(null);
    setLabel(status.channelLabel ?? "");
    focusNext.current = "url";
  };
  const cancelReplace = () => {
    setEditing(false); setUrl(""); setUrlError(null); setFormError(null);
    focusNext.current = "replace";
  };

  /* ---- test ---- */
  const sendTest = async () => {
    if (busy) return;
    setBusy("test"); setLinkMsg(null);
    const r = await testSlack(workspaceId);
    if (!alive.current) return;
    setBusy(null);
    setLinkMsg(r.ok ? { tone: "ok", text: `Test message sent to ${where}. Have a look in Slack.` } : { tone: "signal", text: r.message });
    // the link works: the server forgets a refused daily post, and so do we
    if (r.ok) setHealth((h) => (h?.health?.lastError ? { ...h, health: { ...h.health, lastError: null } } : h));
  };

  /* ---- disconnect ---- */
  const openConfirm = () => { setConfirmOff(true); setEditing(false); setLinkMsg(null); focusNext.current = "cancelOff"; };
  const closeConfirm = () => { setConfirmOff(false); focusNext.current = "off"; };
  const disconnect = async () => {
    if (busy) return;
    setBusy("disconnect"); setLinkMsg(null);
    try {
      await disconnectSlack(workspaceId);
      if (!alive.current) return;
      setConfirmOff(false);
      setFormError(null);
      setLinkMsg(null);
      setAutoMsg(null);
      focusNext.current = "url";
    } catch (err) {
      if (!alive.current) return;
      setLinkMsg({ tone: "signal", text: (err as Error)?.message || SLACK_COPY.saveFailed });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  /* ---- daily stand-up ----
     The switch and the time stay usable while a save is in flight (disabling
     them would drop keyboard focus); the latest choice wins, and a refusal
     puts back what the server last agreed to. */
  const saveAutopost = async (on: boolean, at: string) => {
    const id = ++autoSeq.current;
    setAutopost(on); setTime(at); setAutoMsg(null); setSaving(true);
    try {
      await setSlackAutopost(workspaceId, on, at);
      if (!alive.current || id !== autoSeq.current) return;
      setAutoMsg({ tone: "ok", text: "Saved" });
    } catch (err) {
      if (!alive.current || id !== autoSeq.current) return;
      setAutopost(status.autopost); setTime(status.autopostTime || DEFAULT_AUTOPOST_TIME);
      setAutoMsg({ tone: "signal", text: (err as Error)?.message || SLACK_COPY.saveFailed });
    } finally {
      if (alive.current && id === autoSeq.current) setSaving(false);
    }
  };

  const note = autopost ? autopostNote(health) : null;

  const msgLine = (m: Msg) => m && (
    <p className="kslk-msg kslk-in" data-tone={m.tone}>
      <Icon name={m.tone === "ok" ? "check" : "alert"} size={14} sw={2} />
      <span>{m.text}</span>
    </p>
  );

  /* ---- the connect form (new connection, or a replacement link) ---- */
  const form = showForm && (
    <form className="kslk-form kslk-in" onSubmit={(e) => void submit(e)} noValidate aria-label={editing ? "Replace the Slack webhook link" : "Connect Slack"}>
      <div className="kslk-fields">
        <div className="kset-field">
          <label htmlFor={`${ids}-url`}>Webhook link</label>
          <input ref={urlRef} id={`${ids}-url`} name="slack-webhook" type="url" inputMode="url" className="kset-input kslk-url"
            autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={600}
            placeholder="https://hooks.slack.com/services/…" value={url} disabled={busy === "connect"}
            onChange={(e) => { setUrl(e.target.value); if (urlError) setUrlError(null); }}
            aria-invalid={urlError ? true : undefined} aria-describedby={`${ids}-url-hint`} />
          <p id={`${ids}-url-hint`} className="kset-hint" data-tone={urlError ? "signal" : undefined}>
            {urlError ?? "Kept on Kanbo's server and never shown again, to anyone."}
          </p>
        </div>
        <div className="kset-field">
          <label htmlFor={`${ids}-label`}>Channel name <span className="kslk-opt">(optional)</span></label>
          <input id={`${ids}-label`} name="slack-channel" type="text" className="kset-input" autoComplete="off" spellCheck={false}
            maxLength={80} placeholder="#team-updates" value={label} disabled={busy === "connect"}
            onChange={(e) => setLabel(e.target.value)} aria-describedby={`${ids}-label-hint`} />
          <p id={`${ids}-label-hint`} className="kset-hint">So everyone can see where posts go.</p>
        </div>
      </div>
      <details className="kslk-help">
        <summary><Icon name="chevronRight" size={14} sw={2} />How to get a webhook link</summary>
        <ol className="kslk-steps">
          <li>Open <a href={SLACK_APPS_URL} target="_blank" rel="noopener noreferrer">Slack's app page<span className="sr-only"> (opens in a new tab)</span></a> and choose <strong>Create New App</strong>, then <strong>From scratch</strong>. Call it Kanbo and pick your Slack workspace.</li>
          <li>Open <strong>Incoming Webhooks</strong> and switch them on.</li>
          <li>Choose <strong>Add New Webhook to Workspace</strong>, pick the channel and allow it.</li>
          <li>Copy the webhook link Slack shows you and paste it above.</li>
        </ol>
      </details>
      {formError && <p className="kset-err kslk-form-err" role="alert">{formError}</p>}
      <div className="kslk-acts">
        {editing && <Button variant="ghost" onClick={cancelReplace} disabled={busy === "connect"}>Cancel</Button>}
        <Button type="submit" variant="primary" icon={editing ? "refresh" : "link"} loading={busy === "connect"}>
          {busy === "connect" ? "Connecting…" : editing ? "Replace link" : "Connect"}
        </Button>
      </div>
    </form>
  );

  return (
    <div className="kslk">
      {!status.connected && canManage && (
        <SetIntro>Post stand-ups, project status updates and risks to a Slack channel, and have Kanbo post the stand-up every weekday.</SetIntro>
      )}

      <SetGroup title="Slack">
        {status.connected ? (
          <div>
            <SetRow icon={slackIcon} label={status.channelLabel || "Slack channel"}
              desc={<><span className="kset-ok">Connected</span>{canManage ? " · Stand-ups, updates and risks can be posted here." : status.canPost ? " · Post from Pulse, the Radar and project updates." : ""}</>}>
              {canManage && (
                <Button ref={testRef} size="sm" icon="send" onClick={() => void sendTest()} loading={busy === "test"} disabled={!!busy && busy !== "test"}>
                  {busy === "test" ? "Sending…" : "Send test"}
                </Button>
              )}
            </SetRow>
            <div role="status" className="kslk-live">{msgLine(linkMsg)}</div>
          </div>
        ) : (
          <div>
            <SetRow icon={slackIcon} label="Not connected"
              desc={canManage ? "Paste an Incoming Webhook link from Slack to choose the channel." : `An owner or admin of ${wsName} can connect a Slack channel.`} />
            <div role="status" className="kslk-live">{msgLine(linkMsg)}</div>
            {form}
          </div>
        )}

        {status.connected && canManage && (
          <div>
            <SetRow label="Webhook link" desc="Saved on Kanbo's server. Replace it to post to a different channel.">
              {!editing && !confirmOff && (
                <>
                  <Button ref={replaceRef} size="sm" variant="ghost" onClick={startReplace} disabled={!!busy}>Replace</Button>
                  <Button ref={offRef} size="sm" className="kset-btn-signal kslk-off" onClick={openConfirm} disabled={!!busy}>Disconnect</Button>
                </>
              )}
            </SetRow>
            {editing && form}
            {confirmOff && (
              <div role="group" aria-labelledby={`${ids}-off-t`} className="kset-panel kslk-in" data-tone="signal">
                <p id={`${ids}-off-t`} className="kset-panel-title">Disconnect Slack?</p>
                <p className="kset-panel-text">Kanbo forgets the webhook link and stops the daily stand-up. Messages already in Slack stay there.</p>
                <div className="kset-panel-acts">
                  <Button ref={cancelOffRef} variant="ghost" onClick={closeConfirm} disabled={busy === "disconnect"}>Cancel</Button>
                  <Button variant="danger" icon="x" onClick={() => void disconnect()} loading={busy === "disconnect"}>
                    {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </SetGroup>

      {status.connected && (
        <SetGroup title="Daily stand-up" action={<span role="status" className="kslk-saved-slot">{autoMsg?.tone === "ok" && <span className="kslk-saved kslk-in"><Icon name="check" size={12} sw={2.5} />Saved</span>}</span>}>
          {canManage ? (
            <>
              <div className="kset-row">
                <Toggle checked={autopost} disabled={busy === "disconnect"}
                  onChange={(on) => void saveAutopost(on, time)}
                  label="Post the stand-up every weekday"
                  description={`Kanbo writes the stand-up from the team's tasks and posts it to ${where}, Monday to Friday.`} />
              </div>
              <SetRow label="Time" desc="UK time. It can arrive up to 15 minutes after.">
                <select className="kslk-select" aria-label="Stand-up time" value={time} disabled={busy === "disconnect"}
                  onChange={(e) => void saveAutopost(autopost, e.target.value)}>
                  {(SLACK_AUTOPOST_TIMES.includes(time) ? SLACK_AUTOPOST_TIMES : [...SLACK_AUTOPOST_TIMES, time].sort()).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </SetRow>
              <div role="status" className="kslk-live kslk-health">
                {note && (
                  <p className="kslk-msg kslk-in" data-tone={note.tone}>
                    <Icon name={note.tone === "signal" ? "alert" : "clock"} size={14} sw={2} />
                    <span>{note.text}</span>
                  </p>
                )}
              </div>
              {autoMsg?.tone === "signal" && <div role="alert">{msgLine(autoMsg)}</div>}
            </>
          ) : (
            <SetRow label={status.autopost ? `Every weekday at ${status.autopostTime ?? DEFAULT_AUTOPOST_TIME}` : "Off"}
              desc={status.autopost ? `Kanbo posts the team's stand-up to ${where}, Monday to Friday (UK time).` : "An owner or admin can have Kanbo post the stand-up every weekday."} />
          )}
        </SetGroup>
      )}

      <SetNote>
        {!isSupabaseConfigured
          ? "This is a demo: nothing is sent to Slack."
          : status.connected
            ? "Anyone who can post in this workspace can share to the channel. Guests can't. The webhook link can't be read back, owners included."
            : "The webhook link stays on Kanbo's server. Nobody can read it back once it's saved, owners included."}
      </SetNote>
    </div>
  );
}

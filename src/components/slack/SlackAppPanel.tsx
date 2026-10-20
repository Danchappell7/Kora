/* ============================================================
   KANBO — Settings › Calendar & integrations › Kanbo for Slack.  [0049]
   Beside the Slack channel (webhook) panel. Three cards:
     • Slack workspaces: each Slack workspace you've linked an account in
       (and any that adds tasks to this Kanbo workspace), and which Kanbo
       workspace its /kanbo adds tasks to. Choosing it ("Adds tasks to")
       takes both sides: an owner or admin of the Slack workspace (Slack says
       so) who runs the Kanbo workspace, whatever it pointed at before. An
       owner or admin of the Kanbo workspace it points at can set it back to
       Personal lists (the database decides: slack_app_set_default).
     • Your linked Slack accounts, each with Unlink (asks first).
     • How to use: /kanbo examples, the message shortcut, link previews.
   Before migration 0049 it explains the Slack app isn't switched on yet.
   Demo: lib/slackApp's in-memory Slack workspace.
   Mount (integrator): SettingsModal's calendar section, after the Slack
   webhook panel, with the active workspace and your team workspaces.
   ============================================================ */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Role } from "../../data/types";
import { Button, Icon } from "../primitives";
import { SetGroup, SetNote, SetRow } from "../integrations/settingsBits";
import {
  loadSlackAppStatus, setSlackDefaultWorkspace, SLACK_EXAMPLES, slackAppFailure, slackTeamLabel, unlinkSlackAccount,
  type SlackAppLink, type SlackAppStatus, type SlackAppTeam,
} from "../../lib/slackApp";
import "./slackApp.css";

export interface SlackAppPanelProps {
  /** the active workspace (null = Personal) */
  workspaceId: string | null;
  workspaceName?: string;
  /** your role there (owners/admins choose; the server re-checks) */
  role?: Role | null;
  /** the team workspaces you're in, with your role: "Adds tasks to" offers the ones you run */
  workspaces?: { id: string; name: string; role: Role }[];
}

type Msg = { tone: "ok" | "signal"; text: string } | null;
const NONE = "";
const ELSEWHERE = "__elsewhere";
const slackIcon = <Icon name="message" size={16} sw={1.75} />;
const fmtDate = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

export function SlackAppPanel({ workspaceId, workspaceName, role, workspaces = [] }: SlackAppPanelProps) {
  const ids = "kslka" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [status, setStatus] = useState<SlackAppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<null | "unavailable" | "offline" | "error">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [ask, setAsk] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const focusAfter = useRef<string | null>(null);

  const reload = useCallback(() => setAsk((n) => n + 1), []);
  useEffect(() => {
    let on = true;
    setLoading(true);
    loadSlackAppStatus(workspaceId)
      .then((s) => { if (on) { setStatus(s); setProblem(null); } })
      .catch((e) => {
        if (!on) return;
        const f = slackAppFailure(e);
        setProblem(f.reason === "unavailable" ? "unavailable" : f.reason === "network" ? "offline" : "error");
      })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [workspaceId, ask]);

  // ok messages fade; refusals stay until the next action
  useEffect(() => {
    if (msg?.tone !== "ok") return;
    const t = setTimeout(() => alive.current && setMsg(null), 5000);
    return () => clearTimeout(t);
  }, [msg]);

  // after a confirm closes (or a link goes), focus lands somewhere sensible
  useEffect(() => {
    const want = focusAfter.current;
    if (!want) return;
    focusAfter.current = null;
    document.getElementById(want)?.focus();
  });

  const wsName = workspaceName?.trim() || "this workspace";
  // the workspaces you run (where "Adds tasks to" may point)
  const runs = workspaces.filter((w) => w.role === "owner" || w.role === "admin");
  if (workspaceId && (role === "owner" || role === "admin") && !runs.some((w) => w.id === workspaceId)) runs.unshift({ id: workspaceId, name: wsName, role });

  const choose = async (team: SlackAppTeam, value: string) => {
    if (busy || value === ELSEWHERE) return;
    const target = value === NONE ? null : value;
    setBusy(`team:${team.teamId}`); setMsg(null);
    try {
      await setSlackDefaultWorkspace(team.teamId, target);
      const s = await loadSlackAppStatus(workspaceId);
      if (!alive.current) return;
      setStatus(s);
      const label = slackTeamLabel(team.teamName, team.teamId);
      const name = target ? runs.find((w) => w.id === target)?.name ?? "that workspace" : null;
      setMsg({ tone: "ok", text: name ? `/kanbo in ${label} now adds tasks to ${name}.` : `/kanbo in ${label} now adds tasks to people's Personal lists.` });
    } catch (e) {
      if (alive.current) setMsg({ tone: "signal", text: slackAppFailure(e).message });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const unlink = async (l: SlackAppLink) => {
    const key = `${l.teamId}:${l.slackUserId}`;
    if (busy) return;
    setBusy(`link:${key}`); setMsg(null);
    try {
      await unlinkSlackAccount(l.teamId, l.slackUserId);
      const s = await loadSlackAppStatus(workspaceId);
      if (!alive.current) return;
      setStatus(s); setConfirm(null);
      setMsg({ tone: "ok", text: `Unlinked ${l.slackUserName || "your Slack account"} in ${slackTeamLabel(l.teamName, l.teamId)}. /kanbo there will ask you to link again.` });
      focusAfter.current = `${ids}-links`;
    } catch (e) {
      if (alive.current) setMsg({ tone: "signal", text: slackAppFailure(e).message });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const live = (
    <div className="kslka-live" role="status" aria-live="polite">
      {msg && <p className="kslka-msg" data-tone={msg.tone}><Icon name={msg.tone === "ok" ? "check" : "alert"} size={14} sw={2} /><span>{msg.text}</span></p>}
    </div>
  );

  // one tree whatever the state, so the cards stay put (and keep focus) while the status arrives
  const statusRows = !status ? (
    loading ? (
      <SetRow icon={slackIcon} label="Kanbo for Slack" desc={<span className="kslka-checking" role="status"><span className="kspin" aria-hidden="true" />Checking…</span>} />
    ) : problem === "unavailable" ? (
      <SetRow icon={slackIcon} label="Not switched on yet"
        desc="Kanbo's Slack app hasn't been set up yet. Once it has, you can add tasks from Slack with /kanbo and turn any message into a task." />
    ) : (
      <SetRow icon={slackIcon} label="Couldn't check the Slack app"
        desc={problem === "offline" ? "You're offline. Kanbo will check again when you're back online." : "Something went wrong reading the Slack app's settings."}>
        <Button size="sm" icon="refresh" onClick={reload}>Try again</Button>
      </SetRow>
    )
  ) : status.teams.length === 0 ? (
    <SetRow icon={slackIcon} label="No Slack workspace yet"
      desc={<>Once the Kanbo app is in your Slack workspace, type <code>/kanbo</code> there and follow the link to connect your account. {status.canManage ? `Then, if you're an owner or admin of that Slack workspace, you can choose ${wsName} here as the workspace it adds tasks to.` : "Then an owner or admin of the Slack workspace can choose which Kanbo workspace it adds tasks to."}</>} />
  ) : status.teams.map((t) => (
    <TeamRow key={t.teamId} ids={ids} team={t} wsName={wsName} runs={runs} busy={busy === `team:${t.teamId}`} anyBusy={!!busy} onChoose={(v) => void choose(t, v)} />
  ));

  const linkRows = !status ? null : status.links.length === 0 ? (
    <SetRow icon={slackIcon} label="None yet" desc={<>Type <code>/kanbo</code> in Slack and follow the link it gives you.</>} />
  ) : status.links.map((l) => {
    const key = `${l.teamId}:${l.slackUserId}`;
    const when = fmtDate(l.linkedAt);
    const name = l.slackUserName || l.slackUserId;
    const team = slackTeamLabel(l.teamName, l.teamId);
    if (confirm === key) {
      return (
        <div key={key} className="kset-row kslka-confirm" role="group" aria-labelledby={`${ids}-c-${key}`}>
          <span className="kset-row-icon">{slackIcon}</span>
          <div className="kset-row-text">
            <span id={`${ids}-c-${key}`} className="kset-row-label">Unlink {name}?</span>
            <span className="kset-row-desc">/kanbo in {team} will stop adding tasks as you until you link again.</span>
          </div>
          <div className="kset-row-ctl kslka-acts-inline">
            <Button size="sm" id={`${ids}-cancel-${key}`} onClick={() => { setConfirm(null); focusAfter.current = `${ids}-unlink-${key}`; }} disabled={busy === `link:${key}`}>Cancel</Button>
            <Button size="sm" variant="danger" loading={busy === `link:${key}`} onClick={() => void unlink(l)}>Unlink</Button>
          </div>
        </div>
      );
    }
    return (
      <SetRow key={key} icon={slackIcon} label={name} desc={`${team}${when ? ` · linked ${when}` : ""}`}>
        <Button size="sm" variant="ghost" id={`${ids}-unlink-${key}`} aria-label={`Unlink ${name} in ${team}`} disabled={!!busy}
          onClick={() => { setConfirm(key); setMsg(null); focusAfter.current = `${ids}-cancel-${key}`; }}>Unlink</Button>
      </SetRow>
    );
  });

  return (
    <div className="kslka">
      <SetGroup title="Kanbo for Slack">{statusRows}</SetGroup>
      {live}
      {status && (
        <section className="kset-group" aria-labelledby={`${ids}-links`}>
          <div className="kset-group-head"><h3 id={`${ids}-links`} className="kset-group-title" tabIndex={-1}>Your linked Slack accounts</h3></div>
          <div className="kset-card">{linkRows}</div>
        </section>
      )}
      <HowTo ids={ids} />
    </div>
  );
}

function TeamRow({ ids, team, wsName, runs, busy, anyBusy, onChoose }: {
  ids: string; team: SlackAppTeam; wsName: string; runs: { id: string; name: string }[]; busy: boolean; anyBusy: boolean; onChoose: (v: string) => void;
}) {
  const label = slackTeamLabel(team.teamName, team.teamId);
  const where = team.isDefaultHere ? wsName : team.defaultWorkspaceName;
  const desc = team.isDefaultHere
    ? <>/kanbo and <strong>Create a Kanbo task</strong> add tasks to {wsName}.</>
    : where ? <>/kanbo adds tasks to {where}.</>
    : team.defaultElsewhere ? <>/kanbo adds tasks to another Kanbo workspace.</>
    : <>Not connected to a Kanbo workspace yet: /kanbo adds tasks to people's Personal lists.</>;
  // choose any workspace you run: a Slack owner/admin there (Slack says so). Otherwise, only set it back
  // to Personal lists, when it points at a workspace you run (canClear). The database decides either way.
  const current = team.defaultWorkspaceId ?? (team.defaultElsewhere ? ELSEWHERE : NONE);
  const canPick = team.linked && team.slackAdmin && runs.length > 0;
  const canClear = team.linked && team.canClear && current !== NONE;
  const canChoose = canPick || canClear;
  const offered = canPick ? runs : runs.filter((w) => w.id === current);
  const selectId = `${ids}-ws-${team.teamId}`;
  const why = canPick ? null
    : !team.linked ? " Link your own Slack account there to change it."
    : canClear ? " Only an owner or admin of the Slack workspace can point it at a different workspace."
    : " Only an owner or admin of the Slack workspace, who also runs a Kanbo workspace, can choose it.";
  return (
    <SetRow icon={slackIcon} label={label} desc={<>{desc}{why}</>}>
      {canChoose && (
        <span className="kslka-pick">
          <label htmlFor={selectId} className="kslka-pick-label">Adds tasks to</label>
          <select id={selectId} className="kslka-select" value={current} disabled={anyBusy} aria-busy={busy || undefined}
            onChange={(e) => onChoose(e.target.value)}>
            {current === ELSEWHERE && <option value={ELSEWHERE} disabled>Another workspace</option>}
            {team.defaultWorkspaceId && !offered.some((w) => w.id === team.defaultWorkspaceId) && (
              <option value={team.defaultWorkspaceId} disabled>{team.defaultWorkspaceName ?? "Another workspace"}</option>
            )}
            {offered.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            <option value={NONE}>No workspace (Personal lists)</option>
          </select>
        </span>
      )}
    </SetRow>
  );
}

function HowTo({ ids }: { ids: string }) {
  return (
    <>
    <SetGroup title="How to use Kanbo in Slack">
      <div className="kslka-howto">
        <p id={`${ids}-howto`} className="kslka-howto-lead">Type <code>/kanbo</code> and the task in your own words. Kanbo reads it just like Quick capture:</p>
        <ul className="kslka-examples">
          {SLACK_EXAMPLES.map((x) => (
            <li key={x.text}><code>{x.text}</code><span>{x.means}</span></li>
          ))}
        </ul>
        <ul className="kslka-tips">
          <li><strong>#project</strong> picks a project in the connected Kanbo workspace; <strong>@person</strong> assigns it (with a #project); <strong>!high</strong> and <strong>~2h</strong> set the priority and estimate.</li>
          <li>On any message, choose <strong>More actions › Create a Kanbo task</strong> to turn it into a task with a link back to the message.</li>
          <li>Paste a Kanbo task or project link in Slack and it shows a preview, with <strong>Complete</strong> and <strong>Open</strong>, to people who've linked their account.</li>
        </ul>
      </div>
    </SetGroup>
    <SetNote>Kanbo only acts for people who've linked their account, and always with their own access: guests and people outside the workspace can't add to it.</SetNote>
    </>
  );
}

export default SlackAppPanel;

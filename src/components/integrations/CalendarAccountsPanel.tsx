/* ============================================================
   KANBO — Settings › Calendar & integrations › Connected calendars.
   Several calendar accounts (a work Google, a personal Google, an
   Outlook…): one row per account with its email, provider and how
   many calendars Kanbo shows. "Choose calendars" opens the account's
   own list to tick: colour swatch, name, Primary badge. Each tick saves
   straight away (like Appearance). "Disconnect" removes that account
   only. "Add Google account" / "Add Outlook account" are always there:
   the provider asks which account, so a second one of a kind is easy.
   Older server (before 0045 / the updated function): each account's
   main calendar, and a note that adding another of the same kind
   replaces it. Tokens never reach this panel: only ids, emails and the
   calendar list.
   ============================================================ */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CalendarConnection, CalendarWarning, CalProvider, ExtCalendar } from "../../data/types";
import { Button, Collapse, Icon, projectPaint } from "../primitives";
import { PROVIDER_LABEL, shownSummary, warningText } from "../../lib/calendars";
import { SetGroup, SetNote } from "./settingsBits";
import "./calendarAccounts.css";

export interface CalendarAccountsPanelProps {
  connections: CalendarConnection[];
  syncing?: boolean;
  /** accounts / calendars the last sync couldn't read */
  warnings?: CalendarWarning[];
  /** start adding an account (the provider's account chooser) */
  onConnect: (provider: CalProvider) => void;
  /** disconnect one account, by its id */
  onDisconnect: (connectionId: string) => void;
  /** an account's calendars (from the provider); throws with a message to show */
  loadCalendars?: (connectionId: string) => Promise<ExtCalendar[]>;
  /** show these calendars from the account; throws with a message to show */
  onSelect?: (connectionId: string, calendarIds: string[]) => Promise<void>;
}

/** Most calendars one account can show (the server and database enforce it too). */
export const MAX_CALENDARS = 25;
const SAVED_MS = 2000;

const swatch = (color: string) => ({ background: projectPaint(color || "#6b7a90").solid });

export function CalendarAccountsPanel({ connections, syncing, warnings = [], onConnect, onDisconnect, loadCalendars, onSelect }: CalendarAccountsPanelProps) {
  const legacy = connections.some((c) => !c.canChoose);
  return (
    <>
      <SetGroup title="Connected calendars"
        action={syncing ? <span className="kset-sync" role="status"><span className="kspin" aria-hidden="true" />Syncing…</span> : undefined}>
        {connections.length === 0 && (
          <div className="kset-row">
            <span className="kset-row-icon"><Icon name="calendar" size={16} sw={1.75} /></span>
            <div className="kset-row-text">
              <span className="kset-row-label">No calendars connected yet</span>
              <span className="kset-row-desc">Add a Google or Outlook account to see your meetings on Today and Month. You can add several.</span>
            </div>
          </div>
        )}
        {connections.map((c) => (
          <AccountRow key={c.id} conn={c} warnings={warnings.filter((w) => w.connectionId === c.id)}
            onDisconnect={onDisconnect} loadCalendars={c.canChoose ? loadCalendars : undefined} onSelect={c.canChoose ? onSelect : undefined} />
        ))}
        <div className="kset-row kacct-add">
          <Button size="sm" variant={connections.length ? "secondary" : "primary"} icon="plus" onClick={() => onConnect("google")}>Add Google account</Button>
          <Button size="sm" variant="secondary" icon="plus" onClick={() => onConnect("microsoft")}>Add Outlook account</Button>
        </div>
      </SetGroup>
      <SetNote>
        Kanbo only reads your events, to show your meetings on Today and Month and to plan around them. Nothing is written back to your calendars.
        {legacy && connections.length > 0 && " For now Kanbo shows each account's main calendar, and adding a second account of the same kind replaces the first."}
      </SetNote>
    </>
  );
}

type Load = { state: "idle" } | { state: "loading" } | { state: "ready"; calendars: ExtCalendar[] } | { state: "error"; message: string };

function AccountRow({ conn, warnings, onDisconnect, loadCalendars, onSelect }: {
  conn: CalendarConnection;
  warnings: CalendarWarning[];
  onDisconnect: (id: string) => void;
  loadCalendars?: (id: string) => Promise<ExtCalendar[]>;
  onSelect?: (id: string, ids: string[]) => Promise<void>;
}) {
  const ids = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const panelId = `kacct-${ids}`;
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);
  const savedTimer = useRef(0);
  useEffect(() => {
    alive.current = true; // (StrictMode mounts twice)
    return () => { alive.current = false; window.clearTimeout(savedTimer.current); };
  }, []);

  const who = conn.accountEmail || `${PROVIDER_LABEL[conn.provider]} account`;
  const shown = conn.selectedCalendars;

  const fetchList = useCallback(async () => {
    if (!loadCalendars) return;
    setLoad({ state: "loading" }); setProblem(null);
    try {
      const calendars = await loadCalendars(conn.id);
      if (!alive.current) return;
      setChosen(new Set(calendars.filter((c) => c.selected).map((c) => c.id)));
      setLoad({ state: "ready", calendars });
    } catch (e) {
      if (!alive.current) return;
      setLoad({ state: "error", message: e instanceof Error && e.message ? e.message : "Couldn't load this account's calendars." });
    }
  }, [conn.id, loadCalendars]);

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) void fetchList();
  };

  const toggle = async (cal: ExtCalendar) => {
    if (!onSelect || load.state !== "ready" || saving) return;
    const before = chosen;
    const next = new Set(before);
    if (next.has(cal.id)) next.delete(cal.id); else next.add(cal.id);
    // in the account's own order
    const list = load.calendars.map((c) => c.id).filter((id) => next.has(id));
    setChosen(next); setSaving(true); setSaved(false); setProblem(null);
    try {
      await onSelect(conn.id, list);
      if (!alive.current) return;
      setSaved(true);
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => { if (alive.current) setSaved(false); }, SAVED_MS);
    } catch (e) {
      if (!alive.current) return;
      setChosen(before);
      setProblem(e instanceof Error && e.message ? e.message : "Couldn't save that. Try again.");
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const reconnect = warnings.find((w) => w.reason === "reconnect");
  const atCap = chosen.size >= MAX_CALENDARS;
  const count = load.state === "ready" ? load.calendars.length : 0;

  return (
    <div className="kacct" data-open={open || undefined}>
      <div className="kset-row">
        <span className="kset-row-icon"><Icon name="calendar" size={16} sw={1.75} /></span>
        <div className="kset-row-text">
          <span className="kset-row-label kacct-email">{who}</span>
          <span className="kset-row-desc kacct-desc">
            {shown && shown.length > 0 && (
              <span className="kacct-dots" aria-hidden="true">
                {shown.slice(0, 8).map((c) => <span key={c.id} className="kacct-dot" style={swatch(c.color)} />)}
              </span>
            )}
            <span>{PROVIDER_LABEL[conn.provider]} · {shownSummary(conn)}</span>
          </span>
          {reconnect && <span className="kacct-warn" role="note"><Icon name="alert" size={12} sw={2} />{warningText(reconnect)}</span>}
          {!reconnect && warnings.map((w) => (
            <span key={`${w.calendarId ?? "all"}-${w.reason}`} className="kacct-warn" role="note"><Icon name="alert" size={12} sw={2} />{warningText(w)}</span>
          ))}
        </div>
        <div className="kset-row-ctl">
          {loadCalendars && (
            <Button size="sm" variant="ghost" iconRight="chevronDown" className="kacct-toggle" aria-expanded={open} aria-controls={open ? panelId : undefined}
              aria-label={`Choose calendars from ${who}`} onClick={toggleOpen}>Choose calendars</Button>
          )}
          <Button size="sm" onClick={() => onDisconnect(conn.id)} aria-label={`Disconnect ${who}`}>Disconnect</Button>
        </div>
      </div>
      {loadCalendars && (
        <Collapse open={open}>
          <div id={panelId} className="kacct-panel">
            {load.state === "loading" && (
              <p className="kacct-status" role="status"><span className="kspin" aria-hidden="true" />Loading calendars…</p>
            )}
            {load.state === "error" && (
              <div className="kacct-status">
                <p className="kset-err" role="alert">{load.message}</p>
                <Button size="sm" onClick={() => void fetchList()}>Try again</Button>
              </div>
            )}
            {load.state === "ready" && (
              count === 0 ? <p className="kacct-status">This account has no calendars Kanbo can read.</p> : (
                <fieldset className="kacct-list" aria-describedby={`${panelId}-foot`}>
                  <legend className="sr-only">Calendars to show from {who}</legend>
                  {load.calendars.map((cal) => {
                    const on = chosen.has(cal.id);
                    const off = saving || (!on && atCap);
                    return (
                      <label key={cal.id} className="kacct-item" data-disabled={off || undefined}>
                        <span className="kset-check" data-disabled={off || undefined}>
                          <input type="checkbox" checked={on} disabled={off} onChange={() => void toggle(cal)} />
                          <span className="kset-check-box" aria-hidden="true"><Icon name="check" size={12} sw={2.5} /></span>
                        </span>
                        <span className="kacct-swatch" style={swatch(cal.color)} aria-hidden="true" />
                        <span className="kacct-name">{cal.name}</span>
                        {cal.primary && <span className="kpill kacct-badge" data-tone="neutral" aria-hidden="true">Primary</span>}
                        {cal.primary && <span className="sr-only"> (primary calendar)</span>}
                        {cal.accessRole === "freeBusyReader" && <span className="kacct-role">Busy times only</span>}
                      </label>
                    );
                  })}
                </fieldset>
              )
            )}
            {load.state === "ready" && count > 0 && (
              <p id={`${panelId}-foot`} className="kacct-foot" aria-live="polite">
                {problem ? <span className="kacct-problem">{problem}</span>
                  : saving ? "Saving…"
                  : saved ? "Saved. Today and Month now show these calendars."
                  : atCap ? `Up to ${MAX_CALENDARS} calendars per account.`
                  : `${chosen.size} of ${count} shown. Changes save straight away.`}
              </p>
            )}
          </div>
        </Collapse>
      )}
    </div>
  );
}

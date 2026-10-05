/* ============================================================
   KANBO — Settings › Calendar & integrations › "Add Kanbo to your calendar". [f7-calendar]
   The private feed URL (copy; hidden until you ask to see it), one-click
   Google Calendar, Outlook on the web (personal, work or school), steps
   for Apple Calendar and Outlook for Windows, "Include due dates" and
   "Reset link". Demo: an example URL, actions off, and a note that it
   works once signed in. Before 0043: explains it isn't switched on yet.
   Never crashes, never shows a half-made link.
   Mount (integrator): inside SettingsModal's calendar section, after the
   "Calendars" group (and in place of its empty state when no calendar is
   connected, so the feed is always reachable).
   ============================================================ */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CalendarFeed, IconName } from "../../data/types";
import { Button, Icon, Pill, Toggle } from "../primitives";
import { copyText, useOptionalToast } from "../rituals/shared";
import {
  calendarFeedUrl, demoCalendarFeedUrl, FEED_CALENDAR_NAME, googleCalendarSubscribeUrl, loadCalendarFeed,
  outlook365SubscribeUrl, outlookSubscribeUrl, resetCalendarFeed, setCalendarFeedIncludeDue, webcalUrl,
  type CalendarFeedLoad,
} from "../../lib/calendarFeed";
import { SetGroup, SetNote, SetRow } from "./settingsBits";
import "./calendarFeed.css";

export interface CalendarFeedPanelProps {
  /** called after a successful "Reset link" (e.g. to toast) */
  onReset?: () => void;
}

const TITLE = "Add Kanbo to your calendar";
const COPIED_MS = 2000;

/** The link with the token hidden, short enough to read in the field even
 *  on a phone: "…/ics-feed?t=••••••••3f9a" (the last four tell links apart). */
export function maskFeedUrl(url: string): string {
  const m = /^[^?#]*?([^/?#]*)\?(?:[^#]*&)?t=([^&#]*)/i.exec(url);
  if (!m) return url;
  return `…/${m[1]}?t=${"•".repeat(8)}${m[2].slice(-4)}`;
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");

/** An <a> that looks like a kit Button (sm). Disabled → a disabled <button>. */
function LinkButton({ href, children, icon = "arrowUpRight", variant = "secondary", newTab = true, disabled, label }: {
  href: string | null; children: ReactNode; icon?: IconName; variant?: "primary" | "secondary"; newTab?: boolean; disabled?: boolean; label?: string;
}) {
  if (!href || disabled) {
    return <Button size="sm" variant={variant} iconRight={icon} disabled aria-label={label}>{children}</Button>;
  }
  return (
    <a className="kbtn kcal-linkbtn" data-variant={variant} data-size="sm" href={href}
      {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : { rel: "noreferrer" })}
      aria-label={label ? `${label}${newTab ? " (opens in a new tab)" : ""}` : undefined}>
      <span className="kbtn-label">{children}</span>
      <Icon name={icon} size={14} sw={1.75} />
      {newTab && !label && <span className="sr-only"> (opens in a new tab)</span>}
    </a>
  );
}

export function CalendarFeedPanel({ onReset }: CalendarFeedPanelProps) {
  const toast = useOptionalToast();
  const ids = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [load, setLoad] = useState<CalendarFeedLoad | null>(null); // null = loading
  const [retrying, setRetrying] = useState(false);
  const [includeDue, setIncludeDue] = useState(true);
  const [savingDue, setSavingDue] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState(""); // polite announcements when there's no toast

  const alive = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const resetBtnRef = useRef<HTMLButtonElement>(null);
  const copyBtnRef = useRef<HTMLButtonElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const copiedTimer = useRef(0);
  const freshTimer = useRef(0);

  const take = useCallback((r: CalendarFeedLoad) => {
    if (!alive.current) return;
    setLoad(r);
    if (r.state === "ready") setIncludeDue(r.feed.includeDue);
  }, []);

  useEffect(() => {
    alive.current = true;
    loadCalendarFeed().then(take, () => take({ state: "error", message: "Kanbo couldn't reach the server. Try again in a moment." }));
    return () => {
      alive.current = false;
      window.clearTimeout(copiedTimer.current);
      window.clearTimeout(freshTimer.current);
    };
  }, [take]);

  const retry = useCallback(async () => {
    setRetrying(true);
    const r = await loadCalendarFeed({ refresh: true });
    if (!alive.current) return;
    setRetrying(false);
    take(r);
  }, [take]);

  // offline when it opened: try again as soon as the connection is back
  useEffect(() => {
    if (load?.state !== "error") return;
    const back = () => { void retry(); };
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, [load?.state, retry]);

  // the confirmation takes focus when it opens, on the safe choice (its
  // group label and description are read out as focus enters it)
  useEffect(() => {
    if (confirming) confirmCancelRef.current?.focus();
  }, [confirming]);

  const announce = (msg: string, kind: "success" | "error" = "success") => {
    if (toast) { if (kind === "error") toast.error(msg); else toast.success(msg); } else setSaid(msg);
  };

  const demo = load?.state === "demo";
  const feed: CalendarFeed | null = load?.state === "ready" ? load.feed : null;
  const url = feed ? calendarFeedUrl(feed.token) : demo ? demoCalendarFeedUrl() : null;
  const live = !!feed; // real link, actions on
  const reveal = demo || shown;

  const copy = async () => {
    if (!url || !live) return;
    setCopyFailed(false);
    const ok = await copyText(url);
    if (!alive.current) return;
    if (ok) {
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => { if (alive.current) setCopied(false); }, COPIED_MS);
      announce("Calendar link copied");
    } else {
      // no clipboard: show the link, select it, and say how to copy it by hand
      setShown(true);
      setCopyFailed(true);
      window.requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    }
  };

  const toggleDue = async (next: boolean) => {
    if (!live || savingDue) return;
    setProblem(null);
    setIncludeDue(next); // optimistic
    setSavingDue(true);
    try {
      const saved = await setCalendarFeedIncludeDue(next);
      if (!alive.current) return;
      if (saved) { setIncludeDue(saved.includeDue); setLoad({ state: "ready", feed: saved }); }
      else { setIncludeDue(!next); setLoad({ state: "unavailable" }); }
    } catch (e) {
      if (!alive.current) return;
      setIncludeDue(!next);
      setProblem((e as Error)?.message || "That didn't save. Try again.");
    } finally {
      if (alive.current) setSavingDue(false);
    }
  };

  const closeConfirm = () => {
    setConfirming(false);
    window.requestAnimationFrame(() => resetBtnRef.current?.focus());
  };

  const doReset = async () => {
    if (!live || resetting) return;
    setProblem(null);
    setResetting(true);
    try {
      const next = await resetCalendarFeed();
      if (!alive.current) return;
      if (!next) { setLoad({ state: "unavailable" }); setConfirming(false); return; }
      setLoad({ state: "ready", feed: next });
      setIncludeDue(next.includeDue);
      setConfirming(false);
      setShown(false);
      setCopied(false);
      setFresh(true);
      window.clearTimeout(freshTimer.current);
      freshTimer.current = window.setTimeout(() => { if (alive.current) setFresh(false); }, 1600);
      announce("New calendar link ready. Add it to your calendar again.");
      onReset?.();
      window.requestAnimationFrame(() => copyBtnRef.current?.focus());
    } catch (e) {
      if (!alive.current) return;
      setProblem((e as Error)?.message || "The link wasn't reset. Try again.");
    } finally {
      if (alive.current) setResetting(false);
    }
  };

  const onConfirmKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    // Escape backs out of the confirmation only, not the whole Settings sheet
    e.preventDefault();
    e.stopPropagation();
    if (!resetting) closeConfirm();
  };

  /* ---------------- states without a link ---------------- */

  if (load && (load.state === "unavailable" || load.state === "signedOut" || load.state === "error")) {
    const copyFor = {
      unavailable: { label: "Not switched on yet", desc: "Calendar links will appear here once they're switched on. There's nothing you need to do." },
      signedOut: { label: "Sign in to get your link", desc: "Your calendar link belongs to your account, so it appears here once you're signed in." },
      error: { label: "Your calendar link didn't load", desc: load.state === "error" ? load.message : "" },
    }[load.state];
    return (
      <div className="kcal" data-state={load.state}>
        <SetGroup title={TITLE}>
          <SetRow label={copyFor.label} desc={copyFor.desc}>
            {load.state === "error" && (
              <Button size="sm" icon="refresh" loading={retrying} onClick={() => { void retry(); }}>Try again</Button>
            )}
          </SetRow>
        </SetGroup>
        <SetNote>Put your planned work in Google Calendar, Outlook or Apple Calendar, so meetings don't land on your focus time.</SetNote>
      </div>
    );
  }

  /* ---------------- loading, demo and ready ---------------- */

  const loading = load === null;
  const shownUrl = url ? (reveal ? url : maskFeedUrl(url)) : "";
  const webcal = url && live ? webcalUrl(url) : null;
  const keyHint = isMac() ? "⌘C" : "Ctrl+C";
  const descId = `kcal-${ids}-d`;
  const hintId = `kcal-${ids}-h`;
  const confirmTitleId = `kcal-${ids}-ct`;
  const confirmTextId = `kcal-${ids}-cx`;
  const confirmId = `kcal-${ids}-c`;

  return (
    <div className="kcal" data-state={loading ? "loading" : load.state}>
      <SetGroup title={TITLE} action={demo ? <Pill tone="neutral" icon="eye">Example</Pill> : live ? <Pill tone="neutral" icon="lock">Private</Pill> : undefined}>
        {/* the link */}
        <div className="kset-row kcal-link" aria-busy={loading || undefined}>
          <div className="kset-row-text">
            <label className="kset-row-label" htmlFor={`kcal-${ids}-url`}>Your private calendar link</label>
            <span id={descId} className="kset-row-desc">
              {demo
                ? "This is an example. Your own link appears here once you're signed in to your account."
                : "Your planned work for today and the next 14 days, as busy time. Anyone with the link can see it, so keep it to yourself."}
            </span>
          </div>
          <div className="kcal-field" data-fresh={fresh || undefined}>
            {loading ? (
              <span className="kskel kcal-skel" role="status"><span className="sr-only">Getting your calendar link…</span></span>
            ) : (
              <span className="kcal-input-wrap">
                {/* hidden, there's nothing to select: Show and Copy are the way in (and a
                    tap can't zoom a phone into a field it can't use) */}
                <input ref={inputRef} id={`kcal-${ids}-url`} className="kcal-input" type="text" readOnly value={shownUrl}
                  data-masked={!reveal || undefined} tabIndex={reveal ? undefined : -1}
                  spellCheck={false} autoComplete="off" aria-describedby={copyFailed ? `${descId} ${hintId}` : descId}
                  onFocus={(e) => { if (reveal) e.currentTarget.select(); }} />
                {live && (
                  <button type="button" className="kcal-reveal" aria-pressed={shown} onClick={() => setShown((v) => !v)}
                    aria-label={shown ? "Hide the link" : "Show the link"}>
                    {shown ? "Hide" : "Show"}
                  </button>
                )}
              </span>
            )}
            <Button ref={copyBtnRef} size="md" icon={copied ? "check" : "copy"} disabled={!live} onClick={() => { void copy(); }}
              aria-label={copied ? "Calendar link copied" : "Copy calendar link"}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          {copyFailed && (
            <p id={hintId} className="kcal-hint" role="status">Couldn't copy automatically. The link is selected: press {keyHint} to copy it.</p>
          )}
        </div>

        {/* Google */}
        <SetRow label="Google Calendar" desc="Opens Google Calendar with Kanbo ready to add. Google checks for changes every few hours.">
          <LinkButton href={live && url ? googleCalendarSubscribeUrl(url) : null} variant="primary">Add to Google Calendar</LinkButton>
        </SetRow>

        {/* Outlook on the web */}
        <SetRow label="Outlook" desc="Outlook on the web, for a personal account or a work or school one.">
          <span className="kcal-pair">
            <LinkButton href={live && url ? outlookSubscribeUrl(url, FEED_CALENDAR_NAME) : null} label="Add to Outlook.com">Outlook.com</LinkButton>
            <LinkButton href={live && url ? outlook365SubscribeUrl(url, FEED_CALENDAR_NAME) : null} label="Add to Outlook for work or school">Work or school</LinkButton>
          </span>
        </SetRow>

        {/* everything else */}
        <div className="kset-row kcal-more-row">
          <details className="kcal-more">
            <summary className="kcal-more-sum">
              <Icon name="chevronRight" size={14} sw={2} />
              <span>Apple Calendar, Outlook for Windows and other apps</span>
            </summary>
            <div className="kcal-more-body">
              <ul className="kcal-steps">
                <li><strong>Apple Calendar on a Mac:</strong> File › New Calendar Subscription, paste the link, then set Auto-refresh to every 15 minutes.</li>
                <li><strong>iPhone or iPad:</strong> Settings › Calendar › Accounts › Add Account › Other › Add Subscribed Calendar, then paste the link.</li>
                <li><strong>Outlook for Windows:</strong> in the new Outlook, Add calendar › Subscribe from web. In classic Outlook, Home › Open Calendar › From Internet. Paste the link.</li>
                <li><strong>Google Calendar, by hand:</strong> Other calendars › + › From URL, then paste the link.</li>
                <li><strong>Anything else:</strong> look for “Subscribe”, “From URL” or “Internet calendar” and paste the link.</li>
              </ul>
              <div className="kcal-more-acts">
                <LinkButton href={webcal} icon="calendarPlus" newTab={false}>Open in calendar app</LinkButton>
                <span className="kcal-more-note">On a Mac, iPhone or iPad this subscribes straight away.</span>
              </div>
            </div>
          </details>
        </div>

        {/* due dates */}
        <div className="kset-row">
          <Toggle checked={includeDue} onChange={(v) => { void toggleDue(v); }} disabled={!live || savingDue}
            label="Include due dates" description="Due dates show as all-day events, marked free so they don't block your time." />
        </div>

        {/* reset */}
        <SetRow label="Reset link" desc="Makes a new link. Calendars using the old one stop updating.">
          <Button ref={resetBtnRef} size="sm" icon="refresh" disabled={!live}
            aria-expanded={confirming} aria-controls={confirming ? confirmId : undefined}
            onClick={() => { setProblem(null); setConfirming(true); if (confirming) confirmCancelRef.current?.focus(); }}>Reset link</Button>
        </SetRow>
        {confirming && live && (
          <div id={confirmId} className="kcal-confirm" role="group" aria-labelledby={confirmTitleId} aria-describedby={confirmTextId} onKeyDown={onConfirmKey}>
            <h4 id={confirmTitleId} className="kcal-confirm-title">Reset your calendar link?</h4>
            <p id={confirmTextId} className="kcal-confirm-text">
              Kanbo makes a new link straight away. Any calendar using the old one stops updating, so you'll need to add Kanbo to it again.
            </p>
            <div className="kcal-confirm-acts">
              <Button ref={confirmCancelRef} size="sm" variant="ghost" onClick={closeConfirm} disabled={resetting}>Cancel</Button>
              <Button size="sm" variant="danger" loading={resetting} onClick={() => { void doReset(); }}>Reset link</Button>
            </div>
          </div>
        )}
        {problem && <p className="kcal-err" role="alert"><Icon name="alert" size={14} sw={2} />{problem}</p>}
      </SetGroup>
      <SetNote>
        Calendar apps check for changes on their own schedule: Apple Calendar as often as every 15 minutes, Google Calendar and Outlook every few hours. Done and archived tasks are left out.
      </SetNote>
      {!toast && <span className="sr-only" role="status" aria-live="polite">{said}</span>}
    </div>
  );
}

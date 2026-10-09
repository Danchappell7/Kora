/* ============================================================
   KANBO — Settings › Workspace › History.                   [0047, w1]
   A filterable timeline of the workspace's history (person, action
   type, date range), grouped by UK day, paged as you scroll (keyset on
   created_at + id), with Export CSV of everything that matches. Owners
   and admins see everyone's actions; others see only their own (the
   server enforces it — the page says so and asks only for yours).

   Built from Settings' group and card markup (kset-*), so it reads as a
   native Settings section; bin.css adds the timeline. Loading, empty,
   "not switched on yet", error and end-of-history states; every result
   lands in a polite live region. Data: lib/audit (demo: realistic fakes).
   ============================================================ */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { AuditAction, AuditEvent, AuditPage, IconName, Member } from "../../data/types";
import { Avatar, Button, EmptyState, Icon, KanboGlyph } from "../primitives";
import { getMember, memberInitials } from "../../data/data";
import {
  AUDIT_ACTIONS, AUDIT_ACTION_INFO, AUDIT_ACTOR_KANBO, AUDIT_PAGE, AUDIT_RETENTION_DAYS, auditEventDetails, auditEventsToCsv, auditFailure,
  auditParts, exportAuditEvents, listAuditEvents, londonDay, type AuditGroup,
} from "../../lib/audit";
import { downloadCsv } from "../../lib/exportTasks";
import "./bin.css";

export interface HistoryLogProps {
  workspaceId: string;
  workspaceName: string;
  /** names and avatars for the person filter */
  members: Member[];
  currentUserId: string;
  /** owner/admin: everyone's actions; otherwise only your own */
  canSeeAll: boolean;
}

type Range = "any" | "today" | "7" | "30" | "90" | "custom";
const RANGES: { value: Range; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "custom", label: "Custom dates…" },
];
const GROUPS: AuditGroup[] = ["Tasks and projects", "People", "Workspace", "Integrations"];
const GROUP_PREFIX = "group:";

type Load =
  | { state: "loading" }
  | { state: "ready"; events: AuditEvent[]; next: AuditPage["next"]; more: "idle" | "loading" | "error" }
  | { state: "problem"; why: ReturnType<typeof auditFailure> };

/* ---------------- pure helpers (tested) ---------------- */

/** YYYY-MM-DD plus n days (n may be negative). */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A range choice → the query's from / to (UK days, inclusive). */
export function rangeDays(range: Range, today: string, custom: { from: string; to: string }): { from: string | null; to: string | null } {
  switch (range) {
    case "today": return { from: today, to: today };
    case "7": return { from: addDays(today, -6), to: today };
    case "30": return { from: addDays(today, -29), to: today };
    case "90": return { from: addDays(today, -89), to: today };
    case "custom": {
      const from = custom.from || null, to = custom.to || null;
      // the wrong way round: search the days between them anyway
      return from && to && from > to ? { from: to, to: from } : { from, to };
    }
    default: return { from: null, to: null };
  }
}

/** The action filter's value → the actions to ask for (null = every action). */
export function actionsFor(value: string): AuditAction[] | null {
  if (!value) return null;
  if (value.startsWith(GROUP_PREFIX)) {
    const g = value.slice(GROUP_PREFIX.length);
    return AUDIT_ACTIONS.filter((a) => AUDIT_ACTION_INFO[a].group === g);
  }
  return (AUDIT_ACTIONS as string[]).includes(value) ? [value as AuditAction] : null;
}

const dayHeading = (() => {
  const thisYear = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long" });
  const other = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "long", year: "numeric" });
  return (iso: string, today: string): string => {
    const day = londonDay(iso);
    if (day === today) return "Today";
    if (day === addDays(today, -1)) return "Yesterday";
    return day.slice(0, 4) === today.slice(0, 4) ? thisYear.format(Date.parse(iso)) : other.format(Date.parse(iso));
  };
})();
const clockFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fullFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** An action's mark in the timeline (and how loudly). */
export function actionMark(action: string): { icon: IconName; tone?: "signal" | "ok" } {
  if (action.endsWith(".purged")) return { icon: "trash", tone: "signal" };
  if (action.endsWith(".deleted")) return { icon: "trash" };
  if (action.endsWith(".restored")) return { icon: "undo", tone: "ok" };
  switch (action) {
    case "project.archived": return { icon: "archive" };
    case "project.unarchived": return { icon: "refresh" };
    case "member.invited": return { icon: "send" };
    case "member.joined": return { icon: "user", tone: "ok" };
    case "member.removed": return { icon: "logout" };
    case "role.changed": return { icon: "sliders" };
    case "workspace.renamed": return { icon: "briefcase" };
    case "integration.connected": return { icon: "link", tone: "ok" };
    case "integration.disconnected": return { icon: "link" };
    case "api_key.created": case "api_key.revoked": return { icon: "lock" };
    case "webhook.created": case "webhook.deleted": return { icon: "zap" };
    default: return { icon: "dot" };
  }
}

const fileSlug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";

/* ---------------- the section ---------------- */

export function HistoryLog({ workspaceId, workspaceName, members, currentUserId, canSeeAll }: HistoryLogProps) {
  const ids = "khist" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [person, setPerson] = useState("");
  const [action, setAction] = useState("");
  const [range, setRange] = useState<Range>("any");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [exporting, setExporting] = useState<number | null>(null);
  const [said, setSaid] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const today = londonDay(Date.now());
  const days = rangeDays(range, today, custom);
  const actions = actionsFor(action);
  // someone who isn't an owner/admin only ever asks for their own actions (it's all the server returns)
  const actorId = canSeeAll ? person || null : currentUserId;
  const queryKey = JSON.stringify([workspaceId, actorId, actions, days.from, days.to]);
  const query = useMemo(() => ({ workspaceId, actorId, actions, from: days.from, to: days.to }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryKey]);
  const filtered = (canSeeAll && !!person) || !!action || range !== "any";

  /* ---- first page, again whenever the filters change ---- */
  const seq = useRef(0);
  // a new filter keeps the old entries on screen, dimmed, until the new ones arrive (no flash of skeleton)
  const [refreshing, setRefreshing] = useState(false);
  const loadFirst = useCallback(async () => {
    const n = ++seq.current;
    setLoad((l) => (l.state === "ready" ? l : { state: "loading" }));
    setRefreshing(true);
    try {
      const page = await listAuditEvents({ ...query, limit: AUDIT_PAGE });
      if (!alive.current || n !== seq.current) return;
      setRefreshing(false);
      setLoad({ state: "ready", events: page.events, next: page.next, more: "idle" });
      setSaid(page.events.length ? `${page.events.length}${page.next ? "+" : ""} ${page.events.length === 1 ? "entry" : "entries"}` : "No entries");
    } catch (e) {
      if (!alive.current || n !== seq.current) return;
      setRefreshing(false);
      setLoad({ state: "problem", why: auditFailure(e) });
    }
  }, [query]);
  useEffect(() => { void loadFirst(); }, [loadFirst]);

  /* ---- older pages, as you scroll (or press Show older) ---- */
  const loadMore = useCallback(async () => {
    const cur = load;
    if (cur.state !== "ready" || !cur.next || cur.more === "loading" || refreshing) return;
    const n = seq.current;
    setLoad({ ...cur, more: "loading" });
    try {
      const page = await listAuditEvents({ ...query, before: cur.next, limit: AUDIT_PAGE });
      if (!alive.current || n !== seq.current) return;
      setLoad((l) => (l.state === "ready" ? { state: "ready", events: [...l.events, ...page.events], next: page.next, more: "idle" } : l));
    } catch {
      if (!alive.current || n !== seq.current) return;
      setLoad((l) => (l.state === "ready" ? { ...l, more: "error" } : l));
    }
  }, [load, query, refreshing]);
  const sentinel = useRef<HTMLDivElement>(null);
  const moreRef = useRef(loadMore);
  moreRef.current = loadMore;
  const canAutoLoad = load.state === "ready" && !!load.next && load.more === "idle" && !refreshing;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canAutoLoad || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver((entries) => { if (entries.some((x) => x.isIntersecting)) void moreRef.current(); }, { rootMargin: "240px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [canAutoLoad]);

  /* ---- Export CSV: every page that matches, not just what's loaded ---- */
  const exportCsv = async () => {
    if (exporting != null) return;
    setExporting(0);
    try {
      const { events, truncated } = await exportAuditEvents(query, (n) => { if (alive.current) setExporting(n); });
      if (!alive.current) return;
      downloadCsv(`kanbo-history-${fileSlug(workspaceName)}-${today}.csv`, auditEventsToCsv(events));
      setSaid(truncated
        ? `Exported the newest ${events.length.toLocaleString("en-GB")} entries. Narrow the filters to export the rest.`
        : `Exported ${events.length.toLocaleString("en-GB")} ${events.length === 1 ? "entry" : "entries"}.`);
    } catch (e) {
      if (!alive.current) return;
      setSaid(auditFailure(e) === "network" ? "Couldn't export: check your connection and try again." : "Couldn't export the history. Try again.");
    } finally {
      if (alive.current) setExporting(null);
    }
  };

  const clearFilters = () => { setPerson(""); setAction(""); setRange("any"); setCustom({ from: "", to: "" }); };

  /* ---- the person filter: you first, then everyone by name, then Kanbo ---- */
  const people = useMemo(() => {
    const seen = new Set<string>();
    return members.filter((m) => m.id && !seen.has(m.id) && (seen.add(m.id), true))
      .sort((a, b) => (a.id === currentUserId ? -1 : b.id === currentUserId ? 1 : a.name.localeCompare(b.name, "en-GB", { sensitivity: "base" })));
  }, [members, currentUserId]);

  /* ---- the timeline ---- */
  const events = load.state === "ready" ? load.events : [];
  const byDay = useMemo(() => {
    const out: { day: string; label: string; rows: AuditEvent[] }[] = [];
    for (const e of events) {
      const day = londonDay(e.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(e);
      else out.push({ day, label: dayHeading(e.createdAt, today), rows: [e] });
    }
    return out;
  }, [events, today]);

  let card: ReactNode;
  if (load.state === "loading") {
    card = (
      <div className="kset-card khist-card" aria-busy="true">
        <span className="sr-only" role="status">Loading the history</span>
        {[70, 52, 64].map((w, i) => (
          <div key={i} className="khist-skel" aria-hidden="true">
            <span className="skel khist-skel-av" />
            <span className="khist-skel-lines">
              <span className="skel khist-skel-line" style={{ width: `${w}%` }} />
              <span className="skel khist-skel-line" style={{ width: `${Math.round(w * 0.45)}%`, height: 8, opacity: 0.7 }} />
            </span>
          </div>
        ))}
      </div>
    );
  } else if (load.state === "problem") {
    card = (
      <div className="kset-card khist-card">
        {load.why === "unavailable"
          ? <EmptyState size="sm" art="briefcase" title="History isn't switched on yet"
              body="Once it is, deletes and restores, invitations and role changes, integrations, API keys and webhooks are recorded here." />
          : <EmptyState size="sm" art="briefcase" title="Couldn't load the history"
              body={load.why === "network" ? "Check your connection, then try again." : "Something went wrong on our side. Try again in a moment."}
              action={<Button size="sm" variant="secondary" icon="refresh" loading={refreshing} onClick={() => void loadFirst()}>Try again</Button>} />}
      </div>
    );
  } else if (!events.length) {
    card = (
      <div className="kset-card khist-card">
        {filtered
          ? <EmptyState size="sm" art="search" title="Nothing matches these filters"
              body="Try another person, action or date range."
              action={<Button size="sm" variant="ghost" onClick={clearFilters}>Clear filters</Button>} />
          : <EmptyState size="sm" art="briefcase" title={canSeeAll ? "Nothing recorded yet" : "Nothing of yours recorded yet"}
              body={canSeeAll
                ? `Deletes and restores, invitations and role changes, integrations, API keys and webhooks in ${workspaceName} show up here.`
                : `When you delete or restore something, or change an integration in ${workspaceName}, it shows up here.`} />}
      </div>
    );
  } else {
    const st = load.state === "ready" ? load : null;
    card = (
      <div className="kset-card khist-card" data-refreshing={refreshing || undefined} aria-busy={refreshing || undefined}>
        {byDay.map((g) => (
          <section key={g.day} aria-labelledby={`${ids}-d-${g.day}`}>
            <h4 className="khist-day" id={`${ids}-d-${g.day}`}>{g.label}</h4>
            <ul className="khist-rows">
              {g.rows.map((e) => <HistoryRow key={e.id} event={e} currentUserId={currentUserId} />)}
            </ul>
          </section>
        ))}
        <div className="khist-more" ref={sentinel}>
          {st?.next
            ? st.more === "error"
              ? <>
                  <p className="khist-end" data-tone="signal" role="alert">Couldn't load older entries.</p>
                  <Button size="sm" variant="secondary" icon="refresh" onClick={() => void loadMore()}>Try again</Button>
                </>
              : <Button size="sm" variant="ghost" icon="chevronDown" loading={st.more === "loading"} onClick={() => void loadMore()}>
                  {st.more === "loading" ? "Loading older entries…" : "Show older"}
                </Button>
            : <p className="khist-end">That's everything{filtered ? " that matches" : ""}. History is kept for a year.</p>}
        </div>
      </div>
    );
  }

  const ready = load.state === "ready";
  return (
    <section className="kset-group khist" aria-labelledby={`${ids}-title`}>
      <div className="kset-group-head">
        <h3 id={`${ids}-title`} className="kset-group-title">History</h3>
        <Button size="sm" variant="ghost" icon="arrowUpRight" loading={exporting != null} onClick={() => void exportCsv()}
          disabled={!ready || !events.length} aria-describedby={`${ids}-csv`}>
          {exporting != null ? (exporting ? `Exporting… ${exporting.toLocaleString("en-GB")}` : "Exporting…") : "Export CSV"}
        </Button>
        <span id={`${ids}-csv`} className="sr-only">Downloads every entry that matches the filters as a spreadsheet.</span>
      </div>
      <p className="kset-intro" style={{ marginBottom: 12 }}>
        Who did what in {workspaceName}: deletes and restores, people and roles, renames, integrations, API keys and webhooks.
        Kept for {AUDIT_RETENTION_DAYS === 365 ? "a year" : `${AUDIT_RETENTION_DAYS} days`}.
      </p>
      {!canSeeAll && (
        <p className="khist-notice"><Icon name="eye" size={16} sw={1.75} />
          <span>You're seeing your own actions. Owners and admins see everyone's.</span>
        </p>
      )}
      <div className="khist-filters" role="group" aria-label="Filter the history">
        {canSeeAll && (
          <>
            <label htmlFor={`${ids}-who`} className="sr-only">Person</label>
            <select id={`${ids}-who`} className="khist-field" value={person} onChange={(e) => setPerson(e.target.value)} data-active={!!person || undefined}>
              <option value="">Everyone</option>
              {people.map((m) => <option key={m.id} value={m.id}>{m.id === currentUserId ? `You (${m.name})` : m.name}</option>)}
              <option value={AUDIT_ACTOR_KANBO}>Kanbo (automatic)</option>
            </select>
          </>
        )}
        <label htmlFor={`${ids}-what`} className="sr-only">Action</label>
        <select id={`${ids}-what`} className="khist-field" value={action} onChange={(e) => setAction(e.target.value)} data-active={!!action || undefined}>
          <option value="">All actions</option>
          {GROUPS.map((g) => (
            <optgroup key={g} label={g}>
              <option value={GROUP_PREFIX + g}>All {g.toLowerCase()}</option>
              {AUDIT_ACTIONS.filter((a) => AUDIT_ACTION_INFO[a].group === g).map((a) => <option key={a} value={a}>{AUDIT_ACTION_INFO[a].label}</option>)}
            </optgroup>
          ))}
        </select>
        <label htmlFor={`${ids}-when`} className="sr-only">When</label>
        <select id={`${ids}-when`} className="khist-field" value={range} onChange={(e) => setRange(e.target.value as Range)} data-active={range !== "any" || undefined}>
          {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        {range === "custom" && (
          <span className="khist-range">
            <label htmlFor={`${ids}-from`}>From</label>
            <input id={`${ids}-from`} type="date" className="khist-field" value={custom.from} max={custom.to || today}
              min={addDays(today, -AUDIT_RETENTION_DAYS)} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            <label htmlFor={`${ids}-to`}>To</label>
            <input id={`${ids}-to`} type="date" className="khist-field" value={custom.to} min={custom.from || undefined}
              max={today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </span>
        )}
        {filtered && <button type="button" className="khist-clear" onClick={clearFilters}>Clear filters</button>}
      </div>
      {range === "custom" && custom.from && custom.to && custom.from > custom.to && (
        <p className="khist-hint">“From” is after “To”, so this shows the days between them.</p>
      )}
      {card}
      <p className="sr-only" role="status" aria-live="polite">{said}</p>
    </section>
  );
}

/* ---------------- one entry ---------------- */

function HistoryRow({ event: e, currentUserId }: { event: AuditEvent; currentUserId: string }) {
  const parts = auditParts(e, { you: currentUserId });
  const details = auditEventDetails(e);
  const mark = actionMark(e.action);
  const known = e.actorId ? getMember(e.actorId) : undefined;
  const t = Date.parse(e.createdAt);
  return (
    <li className="khist-row">
      <span className="khist-mark" aria-hidden="true">
        {known
          ? <span className="khist-av"><Avatar id={known.id} size={28} /></span>
          : e.actorId
            ? <span className="khist-av">{memberInitials(e.actorName)}</span>
            : <span className="khist-av" data-kind="kanbo"><KanboGlyph size={14} /></span>}
        <span className="khist-badge" data-tone={mark.tone}><Icon name={mark.icon} size={10} sw={2.25} /></span>
      </span>
      <div className="khist-body">
        <p className="khist-say">
          {parts.map((p, i) => (typeof p === "string" ? <span key={i}>{p}</span> : <strong key={i}>{p.strong}</strong>))}
        </p>
        {details && <p className="khist-detail">{details}</p>}
      </div>
      {Number.isFinite(t) && (
        <time className="khist-when" dateTime={new Date(t).toISOString()} title={fullFmt.format(t)}>{clockFmt.format(t)}</time>
      )}
    </li>
  );
}


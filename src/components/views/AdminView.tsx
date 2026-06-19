/* ============================================================
   KANBO — admin-only dashboard. Account list + counts come from the
   profiles table (readable by any signed-in user, so no backend setup).
   Cross-user aggregates come from admin_stats(); the charts come from
   admin_series() (both optional SECURITY DEFINER RPCs).
   ============================================================ */
import { useEffect, useState } from "react";
import { Icon } from "../primitives";
import { store, type AdminSeries, type AdminDay, type AdminAccount } from "../../data/store";
import type { AccessRequest } from "../../data/types";
import { reportError } from "../../lib/monitoring";

/* Early-access requests — approve people before their account works. */
function AccessRequestsPanel() {
  const [reqs, setReqs] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => { setLoading(true); store.listAccessRequests().then(setReqs).catch(reportError).finally(() => setLoading(false)); };
  useEffect(load, []);
  const pending = reqs.filter((r) => r.status === "pending");
  const act = async (id: string, kind: "approve" | "decline") => {
    setBusy(id);
    try { if (kind === "approve") await store.approveAccessRequest(id); else await store.declineAccessRequest(id); load(); }
    catch (e) { reportError(e); } finally { setBusy(null); }
  };
  if (!loading && reqs.length === 0) return null;
  return (
    <div className="glass" style={{ borderRadius: 16, padding: "16px 20px", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
        <Icon name="inbox" size={16} style={{ color: "var(--accent)" }} />
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>Early-access requests</h2>
        {pending.length > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--on-accent)", background: "var(--accent)", borderRadius: 99, padding: "1px 8px" }}>{pending.length} pending</span>}
      </div>
      {loading ? <span style={{ fontSize: 13, color: "var(--ink-4)" }}>Loading…</span> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {reqs.slice(0, 40).map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 11px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500 }}>{r.name || "—"}</div>
                <div className="truncate" style={{ fontSize: 12, color: "var(--ink-4)" }}>{r.email}</div>
              </div>
              {r.status === "pending" ? (
                <>
                  <button disabled={busy === r.id} onClick={() => act(r.id, "approve")} className="btn btn-accent" style={{ padding: "6px 12px", fontSize: 12.5 }}>Approve</button>
                  <button disabled={busy === r.id} onClick={() => act(r.id, "decline")} className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12.5, color: "var(--ink-4)" }}>Decline</button>
                </>
              ) : (
                <span style={{ fontSize: 12, fontWeight: 600, color: r.status === "approved" ? "var(--st-done)" : "var(--ink-4)" }}>{r.status === "approved" ? "Approved" : "Declined"}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtAgo(iso: string): string {
  if (!iso) return "—";
  const d = Date.now() - new Date(iso).getTime();
  const days = Math.floor(d / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
function fmtDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/* ---- slim ribbon of the essentials the chart can't show ---- */
function Ribbon({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="glass" style={{ borderRadius: 14, padding: "13px 20px", marginBottom: 18, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 0" }}>
      {items.map((it, i) => (
        <div key={it.label} style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "0 20px", borderLeft: i ? "1px solid var(--hairline)" : "none" }}>
          <span className="kicker">{it.label}</span>
          <span className="mono tnum" style={{ fontSize: 19, fontWeight: 600, lineHeight: 1 }}>{it.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ---- big interactive trend chart with gridlines, axis + hover ---- */
const METRICS: { key: keyof Omit<AdminDay, "d">; label: string; color: string }[] = [
  { key: "sessions", label: "Sessions", color: "var(--accent)" },
  { key: "active", label: "Active users", color: "#37c6a8" },
  { key: "signups", label: "Signups", color: "#f0a93b" },
  { key: "tasks", label: "Tasks created", color: "#6aa3ff" },
  { key: "actions", label: "Actions", color: "#d77bf0" },
];

function TrendChart({ days }: { days: AdminDay[] }) {
  const [metric, setMetric] = useState<keyof Omit<AdminDay, "d">>("sessions");
  const [hover, setHover] = useState<number | null>(null);
  const active = METRICS.find((m) => m.key === metric)!;
  const W = 720, H = 230, padL = 34, padB = 22, padT = 12;
  const vals = days.map((d) => Number(d[metric]) || 0);
  const max = Math.max(...vals, 1);
  const niceMax = max <= 4 ? 4 : Math.ceil(max / 5) * 5;
  const innerW = W - padL, innerH = H - padB - padT;
  const x = (i: number) => padL + (i / (days.length - 1 || 1)) * innerW;
  const y = (v: number) => padT + innerH - (v / niceMax) * innerH;
  const line = vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
  const area = `${line} L${x(vals.length - 1)} ${padT + innerH} L${padL} ${padT + innerH} Z`;
  const total = vals.reduce((a, b) => a + b, 0);
  const peak = Math.max(...vals, 0);
  const avg = (total / (vals.length || 1));
  const gid = "trend-grad";
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));
  const labelEvery = Math.ceil(days.length / 6);

  const headStat = (label: string, value: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span className="kicker" style={{ fontSize: 9.5 }}>{label}</span>
      <span className="mono tnum" style={{ fontSize: 15, fontWeight: 600 }}>{value}</span>
    </div>
  );

  return (
    <div className="glass" style={{ borderRadius: 18, padding: "18px 20px 14px", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ width: 9, height: 9, borderRadius: 99, background: active.color, boxShadow: `0 0 8px ${active.color}` }} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>{active.label}</span>
          <span style={{ fontSize: 12, color: "var(--ink-4)" }}>· last 30 days</span>
        </div>
        <div style={{ display: "flex", gap: 22, marginLeft: 6 }}>
          {headStat("Total", total.toLocaleString())}
          {headStat("Daily avg", avg.toFixed(avg >= 10 ? 0 : 1))}
          {headStat("Peak", peak.toLocaleString())}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4, flexWrap: "wrap" }}>
          {METRICS.map((m) => (
            <button key={m.key} onClick={() => setMetric(m.key)} style={{
              fontSize: 11.5, fontWeight: 600, padding: "5px 11px", borderRadius: 8, cursor: "pointer",
              border: "1px solid " + (m.key === metric ? "transparent" : "var(--hairline-strong)"),
              background: m.key === metric ? m.color : "transparent",
              color: m.key === metric ? "#fff" : "var(--ink-3)", transition: "all .15s var(--ease)",
            }}>{m.label}</button>
          ))}
        </div>
      </div>
      <div style={{ position: "relative" }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", overflow: "visible" }}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * W;
            const i = Math.round(((px - padL) / innerW) * (days.length - 1));
            setHover(Math.max(0, Math.min(days.length - 1, i)));
          }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={active.color} stopOpacity="0.26" />
              <stop offset="1" stopColor={active.color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((t, i) => {
            const yy = y(t);
            return (
              <g key={i}>
                <line x1={padL} y1={yy} x2={W} y2={yy} stroke="var(--hairline)" strokeWidth="1" />
                <text x={padL - 6} y={yy + 3.5} textAnchor="end" fontSize="9.5" fill="var(--ink-4)" className="mono">{t}</text>
              </g>
            );
          })}
          <path d={area} fill={`url(#${gid})`} />
          <path d={line} fill="none" stroke={active.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          {days.map((d, i) => (i % labelEvery === 0 || i === days.length - 1) ? (
            <text key={i} x={x(i)} y={H - 4} textAnchor="middle" fontSize="9.5" fill="var(--ink-4)" className="mono">{d.d.slice(5)}</text>
          ) : null)}
          {hover != null && (
            <g>
              <line x1={x(hover)} y1={padT} x2={x(hover)} y2={padT + innerH} stroke={active.color} strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
              <circle cx={x(hover)} cy={y(vals[hover])} r="3.8" fill={active.color} stroke="var(--bg)" strokeWidth="1.5" />
            </g>
          )}
        </svg>
        {hover != null && (
          <div style={{
            position: "absolute", top: 0, left: `${(x(hover) / W) * 100}%`, transform: "translateX(-50%)",
            background: "var(--surface-2)", border: "1px solid var(--hairline-strong)", borderRadius: 8,
            padding: "5px 9px", pointerEvents: "none", whiteSpace: "nowrap", boxShadow: "var(--shadow)",
          }}>
            <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{fmtDate(days[hover].d)}</div>
            <div className="mono tnum" style={{ fontSize: 14, fontWeight: 600, color: active.color }}>{vals[hover]} {active.label.toLowerCase()}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- horizontal breakdown bars (tasks by status / priority) ---- */
function Breakdown({ title, icon, data, palette }: { title: string; icon: "check" | "target"; data: Record<string, number>; palette: Record<string, string> }) {
  const all = Object.keys(palette).map((k) => [k, data[k] || 0] as const);
  const anyNonZero = all.some(([, v]) => v > 0);
  const entries = anyNonZero ? all.filter(([, v]) => v > 0) : all;
  const total = all.reduce((a, [, v]) => a + v, 0);
  const max = Math.max(...entries.map(([, v]) => v), 1);
  return (
    <div className="glass" style={{ borderRadius: 18, padding: "16px 18px", flex: 1, minWidth: 240 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
        <Icon name={icon} size={16} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 14.5, fontWeight: 600 }}>{title}</span>
        <span className="mono tnum" style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--ink-4)" }}>{total} total</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 64, fontSize: 12, color: "var(--ink-3)", textTransform: "capitalize", flexShrink: 0 }}>{k}</span>
            <div style={{ flex: 1, height: 9, borderRadius: 6, background: "var(--surface-2)", overflow: "hidden" }}>
              <div style={{ width: `${total ? (v / max) * 100 : 0}%`, height: "100%", borderRadius: 6, background: palette[k], minWidth: v ? 5 : 0, transition: "width .7s var(--ease)" }} />
            </div>
            <span className="mono tnum" style={{ width: 28, textAlign: "right", fontSize: 12, color: "var(--ink-2)", flexShrink: 0 }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = { todo: "#8a8f98", progress: "var(--accent)", review: "#f0a93b", blocked: "#e5544b", done: "#37c6a8" };
const PRIORITY_COLORS: Record<string, string> = { low: "#6aa3ff", medium: "#37c6a8", high: "#f0a93b", urgent: "#e5544b" };

export function AdminView() {
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [series, setSeries] = useState<AdminSeries | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      store.adminAccounts().then((a) => a ?? store.adminProfiles()),
      store.adminStats(),
      store.adminSeries(),
    ])
      .then(([list, s, ts]) => { if (!cancelled) { setAccounts(list); setStats(s); setSeries(ts); } })
      .catch(reportError)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const totalUsers = stats?.total_users ?? accounts.length;
  const num = (v?: number) => v == null ? "—" : v.toLocaleString();
  const fmtDur = (sec?: number) => {
    if (sec == null) return "—";
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };
  const dash = loading ? "…" : undefined;
  const ribbon = [
    { label: "Accounts", value: dash ?? num(totalUsers) },
    { label: "Active today", value: dash ?? num(stats?.dau) },
    { label: "Active · week", value: dash ?? num(stats?.wau) },
    { label: "Avg session", value: dash ?? fmtDur(stats?.avg_session_sec) },
    { label: "MRR", value: dash ?? (stats?.mrr_cents != null ? `£${(stats.mrr_cents / 100).toLocaleString()}` : "—") },
  ];

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 24px 56px", maxWidth: 1040, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>Overview</h1>
        <span style={{ fontSize: 13, color: "var(--ink-4)" }}>Live product analytics</span>
      </div>

      <Ribbon items={ribbon} />

      <AccessRequestsPanel />

      {!series && !loading && (
        <div className="glass" style={{ padding: "13px 16px", borderRadius: 12, marginBottom: 18, display: "flex", alignItems: "center", gap: 11, border: "1px solid color-mix(in oklch, var(--accent) 26%, transparent)", background: "var(--accent-dim)" }}>
          <Icon name="sparkles" size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
            Account numbers are live. To light up the charts, dwell time and cross-user totals, run the one-time <strong>0016_admin_analytics</strong> and <strong>0017_admin_timeseries</strong> SQL in your Supabase editor — then these fill in automatically.
          </span>
        </div>
      )}

      {series && series.days.length > 0 && <TrendChart days={series.days} />}

      {series && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 18 }}>
          <Breakdown title="Tasks by status" icon="check" data={series.by_status} palette={STATUS_COLORS} />
          <Breakdown title="Tasks by priority" icon="target" data={series.by_priority} palette={PRIORITY_COLORS} />
        </div>
      )}

      <div className="glass" style={{ borderRadius: 18, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <Icon name="user" size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>Accounts</span>
          <span className="mono tnum" style={{ fontSize: 11.5, color: "var(--ink-4)", background: "var(--surface)", borderRadius: 6, padding: "1px 7px" }}>{accounts.length}</span>
        </div>
        {!loading && accounts.length > 0 && (
          <div className="hide-sm" style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 18px", borderBottom: "1px solid var(--hairline)" }}>
            <span style={{ width: 30, flexShrink: 0 }} />
            <span className="kicker" style={{ flex: 1 }}>Member</span>
            <span className="kicker" style={{ width: 130, flexShrink: 0 }}>Joined</span>
            <span className="kicker" style={{ width: 90, flexShrink: 0, textAlign: "right" }}>Last active</span>
          </div>
        )}
        {loading ? (
          <div style={{ padding: "28px 18px", textAlign: "center", color: "var(--ink-4)", fontSize: 13 }}>Loading accounts…</div>
        ) : accounts.length === 0 ? (
          <div style={{ padding: "28px 18px", textAlign: "center", color: "var(--ink-4)", fontSize: 13 }}>No accounts yet.</div>
        ) : accounts.map((a, i) => (
          <div key={a.id} className="lift-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 18px", borderTop: i ? "1px solid var(--hairline)" : "none" }}>
            <span style={{ width: 30, height: 30, borderRadius: 99, flexShrink: 0, display: "grid", placeItems: "center", background: "var(--accent-dim)", color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600 }}>{(a.name || a.email || "?").slice(0, 2).toUpperCase()}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="truncate" style={{ fontSize: 13.5, color: "var(--ink)", fontWeight: 500 }}>{a.name}</div>
              <div className="truncate" style={{ fontSize: 12, color: "var(--ink-4)" }}>{a.email}</div>
            </div>
            <span className="mono hide-sm" style={{ width: 130, flexShrink: 0, fontSize: 12, color: "var(--ink-3)" }}>{fmtDate(a.createdAt)}</span>
            <span className="mono" style={{ width: 90, flexShrink: 0, textAlign: "right", fontSize: 11.5, color: "var(--ink-4)" }}>{fmtAgo(a.updatedAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

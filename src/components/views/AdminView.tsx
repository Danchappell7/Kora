/* ============================================================
   KANBO — admin-only dashboard. Account list + counts come from the
   profiles table (readable by any signed-in user, so no backend setup).
   Cross-user aggregates come from admin_stats(); the charts come from
   admin_series() (both optional SECURITY DEFINER RPCs).
   ============================================================ */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../primitives";
import { store, type AdminSeries, type AdminDay } from "../../data/store";
import { reportError } from "../../lib/monitoring";

interface Account { id: string; name: string; email: string; updatedAt: string }

type IconNameLite = "user" | "sparkles" | "check" | "zap" | "target" | "calendarPlus" | "clock" | "refresh";

function fmtAgo(iso: string): string {
  if (!iso) return "—";
  const d = Date.now() - new Date(iso).getTime();
  const days = Math.floor(d / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/* ---- tiny inline sparkline (no axes) for the KPI cards ---- */
function MiniSpark({ data, color = "var(--accent)" }: { data: number[]; color?: string }) {
  if (!data.length) return null;
  const w = 120, h = 30, max = Math.max(...data, 1), min = Math.min(...data, 0);
  const pts = data.map((v, i) => [(i / (data.length - 1 || 1)) * w, h - ((v - min) / (max - min || 1)) * (h - 4) - 2]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block", marginTop: 2 }}>
      <path d={`${d} L${w} ${h} L0 ${h} Z`} fill={color} opacity={0.1} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
    </svg>
  );
}

function StatCard({ kicker, value, sub, icon, spark, color }: { kicker: string; value: string | number; sub?: string; icon: IconNameLite; spark?: number[]; color?: string }) {
  return (
    <div className="glass" style={{ padding: 18, borderRadius: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <span className="kicker">{kicker}</span>
        <span style={{ marginLeft: "auto", color: color || "var(--accent)" }}><Icon name={icon} size={16} /></span>
      </div>
      <span className="mono tnum" style={{ fontSize: 30, fontWeight: 600, lineHeight: 1 }}>{value}</span>
      {sub && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{sub}</span>}
      {spark && spark.some((v) => v > 0) && <MiniSpark data={spark} color={color} />}
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
  const W = 720, H = 220, padL = 34, padB = 22, padT = 12;
  const vals = days.map((d) => Number(d[metric]) || 0);
  const max = Math.max(...vals, 1);
  const niceMax = max <= 4 ? 4 : Math.ceil(max / 5) * 5;
  const innerW = W - padL, innerH = H - padB - padT;
  const x = (i: number) => padL + (i / (days.length - 1 || 1)) * innerW;
  const y = (v: number) => padT + innerH - (v / niceMax) * innerH;
  const line = vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
  const area = `${line} L${x(vals.length - 1)} ${padT + innerH} L${padL} ${padT + innerH} Z`;
  const total = vals.reduce((a, b) => a + b, 0);
  const gid = "trend-grad";
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));
  const labelEvery = Math.ceil(days.length / 6);

  return (
    <div className="glass" style={{ borderRadius: 16, padding: "16px 18px 12px", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Icon name="zap" size={16} style={{ color: active.color }} />
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>{active.label} · last 30 days</span>
          <span className="mono tnum" style={{ fontSize: 11.5, color: "var(--ink-4)", background: "var(--surface)", borderRadius: 6, padding: "1px 7px" }}>{total.toLocaleString()} total</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4, flexWrap: "wrap" }}>
          {METRICS.map((m) => (
            <button key={m.key} onClick={() => setMetric(m.key)} style={{
              fontSize: 11.5, fontWeight: 600, padding: "4px 10px", borderRadius: 8, cursor: "pointer",
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
          <path d={line} fill="none" stroke={active.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          {days.map((d, i) => (i % labelEvery === 0 || i === days.length - 1) && (
            <text key={i} x={x(i)} y={H - 4} textAnchor="middle" fontSize="9.5" fill="var(--ink-4)" className="mono">{d.d.slice(5)}</text>
          ))}
          {hover != null && (
            <g>
              <line x1={x(hover)} y1={padT} x2={x(hover)} y2={padT + innerH} stroke={active.color} strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
              <circle cx={x(hover)} cy={y(vals[hover])} r="3.6" fill={active.color} stroke="var(--bg)" strokeWidth="1.5" />
            </g>
          )}
        </svg>
        {hover != null && (
          <div style={{
            position: "absolute", top: 0, left: `${(x(hover) / W) * 100}%`, transform: "translateX(-50%)",
            background: "var(--surface-2)", border: "1px solid var(--hairline-strong)", borderRadius: 8,
            padding: "5px 9px", pointerEvents: "none", whiteSpace: "nowrap", boxShadow: "var(--shadow-2)",
          }}>
            <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{days[hover].d}</div>
            <div className="mono tnum" style={{ fontSize: 14, fontWeight: 600, color: active.color }}>{vals[hover]} {active.label.toLowerCase()}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- horizontal breakdown bars (tasks by status / priority) ---- */
function Breakdown({ title, icon, data, palette }: { title: string; icon: IconNameLite; data: Record<string, number>; palette: Record<string, string> }) {
  const all = Object.keys(palette).map((k) => [k, data[k] || 0] as const);
  const anyNonZero = all.some(([, v]) => v > 0);
  const entries = anyNonZero ? all.filter(([, v]) => v > 0) : all;
  const total = all.reduce((a, [, v]) => a + v, 0);
  const max = Math.max(...entries.map(([, v]) => v), 1);
  return (
    <div className="glass" style={{ borderRadius: 16, padding: "16px 18px", flex: 1, minWidth: 240 }}>
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
              <div style={{ width: `${(v / max) * 100}%`, height: "100%", borderRadius: 6, background: palette[k], minWidth: v ? 5 : 0, transition: "width .7s var(--ease)" }} />
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
  const [accounts, setAccounts] = useState<Account[]>([]);
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
  const newRecent = stats?.new_signups_30d ?? accounts.filter((a) => a.updatedAt && Date.now() - new Date(a.updatedAt).getTime() < 7 * 86400000).length;
  const num = (v?: number) => v == null ? "—" : v.toLocaleString();
  const fmtDur = (sec?: number) => {
    if (sec == null) return "—";
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };
  const spark = useMemo(() => {
    const d = series?.days ?? [];
    return {
      signups: d.map((x) => x.signups),
      sessions: d.map((x) => x.sessions),
      active: d.map((x) => x.active),
      actions: d.map((x) => x.actions),
    };
  }, [series]);

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 1040, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14, marginBottom: 18 }}>
        <StatCard kicker="Accounts" value={loading ? "…" : totalUsers} icon="user" sub="Total registered" />
        <StatCard kicker={stats ? "New · 30d" : "New · 7d"} value={loading ? "…" : newRecent} icon="sparkles" color="#f0a93b" sub={stats ? "Signups last 30 days" : "Profiles touched (approx.)"} spark={spark.signups} />
        <StatCard kicker="Active · 30d" value={loading ? "…" : num(stats?.active_users_30d)} icon="zap" color="#37c6a8" sub="Signed in last 30 days" spark={spark.active} />
        <StatCard kicker="Avg session" value={loading ? "…" : fmtDur(stats?.avg_session_sec)} icon="clock" sub="Time on app, last 30d" />
        <StatCard kicker="Active today" value={loading ? "…" : num(stats?.dau)} icon="target" sub={`${num(stats?.wau)} this week`} />
        <StatCard kicker="Sessions · 30d" value={loading ? "…" : num(stats?.sessions_30d)} icon="refresh" sub="Visits last 30 days" spark={spark.sessions} />
        <StatCard kicker="Tasks" value={loading ? "…" : num(stats?.total_tasks)} icon="check" color="#6aa3ff" sub={stats ? `${num(stats?.completed_tasks)} completed` : "—"} />
        <StatCard kicker="Actions · 30d" value={loading ? "…" : num(stats?.actions_30d)} icon="calendarPlus" color="#d77bf0" sub="Task events last 30 days" spark={spark.actions} />
        <StatCard kicker="MRR" value={loading ? "…" : (stats?.mrr_cents != null ? `£${(stats.mrr_cents / 100).toLocaleString()}` : "—")} icon="sparkles" sub="Active subscriptions" />
      </div>

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

      <div className="glass" style={{ borderRadius: 16, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <Icon name="user" size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>Accounts</span>
          <span className="mono tnum" style={{ fontSize: 11.5, color: "var(--ink-4)", background: "var(--surface)", borderRadius: 6, padding: "1px 7px" }}>{accounts.length}</span>
        </div>
        {loading ? (
          <div style={{ padding: "28px 18px", textAlign: "center", color: "var(--ink-4)", fontSize: 13 }}>Loading accounts…</div>
        ) : accounts.length === 0 ? (
          <div style={{ padding: "28px 18px", textAlign: "center", color: "var(--ink-4)", fontSize: 13 }}>No accounts yet.</div>
        ) : accounts.map((a, i) => (
          <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 18px", borderTop: i ? "1px solid var(--hairline)" : "none" }}>
            <span style={{ width: 30, height: 30, borderRadius: 99, flexShrink: 0, display: "grid", placeItems: "center", background: "var(--accent-dim)", color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600 }}>{(a.name || a.email || "?").slice(0, 2).toUpperCase()}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="truncate" style={{ fontSize: 13.5, color: "var(--ink)", fontWeight: 500 }}>{a.name}</div>
              <div className="truncate" style={{ fontSize: 12, color: "var(--ink-4)" }}>{a.email}</div>
            </div>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)", flexShrink: 0 }}>{fmtAgo(a.updatedAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

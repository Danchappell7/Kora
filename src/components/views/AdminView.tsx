/* ============================================================
   KANBO — admin-only dashboard. Account list + counts come from the
   profiles table (readable by any signed-in user, so no backend setup).
   Cross-user aggregates come from an optional admin_stats() RPC.
   ============================================================ */
import { useEffect, useState } from "react";
import { Icon } from "../primitives";
import { store } from "../../data/store";
import { reportError } from "../../lib/monitoring";

interface Account { id: string; name: string; email: string; updatedAt: string }

function StatCard({ kicker, value, sub, icon }: { kicker: string; value: string | number; sub?: string; icon: IconNameLite }) {
  return (
    <div className="glass" style={{ padding: 18, borderRadius: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <span className="kicker">{kicker}</span>
        <span style={{ marginLeft: "auto", color: "var(--accent)" }}><Icon name={icon} size={16} /></span>
      </div>
      <span className="mono tnum" style={{ fontSize: 32, fontWeight: 600, lineHeight: 1 }}>{value}</span>
      {sub && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{sub}</span>}
    </div>
  );
}
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

export function AdminView() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([store.adminAccounts().then((a) => a ?? store.adminProfiles()), store.adminStats()])
      .then(([list, s]) => { if (!cancelled) { setAccounts(list); setStats(s); } })
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

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 1040, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14, marginBottom: 26 }}>
        <StatCard kicker="Accounts" value={loading ? "…" : totalUsers} icon="user" sub="Total registered" />
        <StatCard kicker={stats ? "New · 30d" : "New · 7d"} value={loading ? "…" : newRecent} icon="sparkles" sub={stats ? "Signups last 30 days" : "Profiles touched (approx.)"} />
        <StatCard kicker="Active · 30d" value={loading ? "…" : num(stats?.active_users_30d)} icon="zap" sub="Signed in last 30 days" />
        <StatCard kicker="Avg session" value={loading ? "…" : fmtDur(stats?.avg_session_sec)} icon="clock" sub="Time on app, last 30d" />
        <StatCard kicker="Active today" value={loading ? "…" : num(stats?.dau)} icon="target" sub={`${num(stats?.wau)} this week`} />
        <StatCard kicker="Sessions · 30d" value={loading ? "…" : num(stats?.sessions_30d)} icon="refresh" sub="Visits last 30 days" />
        <StatCard kicker="Tasks" value={loading ? "…" : num(stats?.total_tasks)} icon="check" sub={stats ? `${num(stats?.completed_tasks)} completed` : "—"} />
        <StatCard kicker="Actions · 30d" value={loading ? "…" : num(stats?.actions_30d)} icon="calendarPlus" sub="Task events last 30 days" />
        <StatCard kicker="MRR" value={loading ? "…" : (stats?.mrr_cents != null ? `£${(stats.mrr_cents / 100).toLocaleString()}` : "—")} icon="sparkles" sub="Active subscriptions" />
      </div>

      {!stats && !loading && (
        <div className="glass" style={{ padding: "13px 16px", borderRadius: 12, marginBottom: 20, display: "flex", alignItems: "center", gap: 11, border: "1px solid color-mix(in oklch, var(--accent) 26%, transparent)", background: "var(--accent-dim)" }}>
          <Icon name="sparkles" size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
            Account numbers are live. To light up dwell time, active users, sessions, tasks and actions, run the one-time <strong>0016_admin_analytics</strong> SQL in your Supabase editor — then these fill in automatically.
          </span>
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

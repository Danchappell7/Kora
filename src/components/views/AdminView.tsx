/* ============================================================
   KANBO — admin-only dashboard. Account list + counts come from the
   profiles table (readable by any signed-in user, so no backend setup).
   Cross-user aggregates come from admin_stats(); the charts come from
   admin_series() (both optional SECURITY DEFINER RPCs).
   ============================================================ */
import { useEffect, useState, useCallback } from "react";
import { Icon } from "../primitives";
import { store, type AdminSeries, type AdminDay, type AdminAccount, type AdminAccountDetail, type AdminBilling, type AdminFunnel, type AdminWorkspace, type AdminAuditEntry } from "../../data/store";
import type { AccessRequest } from "../../data/types";
import { reportError } from "../../lib/monitoring";

/* Early-access requests — review, approve (with email), decline. */
type ReqTab = "pending" | "approved" | "declined" | "all";
const REQ_BADGE: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "var(--st-review)" },
  approved: { label: "Approved", color: "var(--st-done)" },
  declined: { label: "Declined", color: "var(--ink-4)" },
};
function AccessRequestsPanel() {
  const [reqs, setReqs] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<ReqTab>("pending");
  const [q, setQ] = useState("");
  const [flash, setFlash] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const load = () => { setLoading(true); store.listAccessRequests().then(setReqs).catch(reportError).finally(() => setLoading(false)); };
  useEffect(load, []);
  const toggleSel = (id: string) => setSel((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const counts = {
    pending: reqs.filter((r) => r.status === "pending").length,
    approved: reqs.filter((r) => r.status === "approved").length,
    declined: reqs.filter((r) => r.status === "declined").length,
    all: reqs.length,
  };
  const needle = q.trim().toLowerCase();
  const shown = reqs
    .filter((r) => tab === "all" || r.status === tab)
    .filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.email.toLowerCase().includes(needle));

  const act = async (id: string, kind: "approve" | "decline") => {
    setBusy(id);
    try {
      if (kind === "approve") {
        const emailed = await store.approveAccessRequest(id);
        setFlash({ id, text: emailed ? "Approved · email sent" : "Approved · email not sent", ok: emailed });
      } else {
        const sent = await store.declineAccessRequest(id);
        setFlash({ id, text: sent ? "Declined · email sent" : "Declined", ok: true });
      }
      load();
      setTimeout(() => setFlash((f) => (f?.id === id ? null : f)), 4500);
    } catch (e) { reportError(e); setFlash({ id, text: "Something went wrong", ok: false }); }
    finally { setBusy(null); }
  };

  const bulkApprove = async () => {
    const ids = [...sel];
    if (!ids.length) return;
    setBusy("bulk"); setBulkNote(null);
    let ok = 0, emailed = 0;
    for (const id of ids) {
      try { const sent = await store.approveAccessRequest(id); ok++; if (sent) emailed++; }
      catch (e) { reportError(e); }
    }
    setSel(new Set()); load();
    setBulkNote(`Approved ${ok} request${ok === 1 ? "" : "s"}${emailed ? ` · ${emailed} email${emailed === 1 ? "" : "s"} sent` : ""}.`);
    setTimeout(() => setBulkNote(null), 5000);
    setBusy(null);
  };

  if (!loading && reqs.length === 0) return null;
  const selectablePending = shown.filter((r) => r.status === "pending");
  const allSelected = selectablePending.length > 0 && selectablePending.every((r) => sel.has(r.id));
  const tabs: { k: ReqTab; label: string }[] = [
    { k: "pending", label: "Pending" }, { k: "approved", label: "Approved" }, { k: "declined", label: "Declined" }, { k: "all", label: "All" },
  ];
  return (
    <div className="glass" style={{ borderRadius: 16, padding: "16px 20px", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 13, flexWrap: "wrap" }}>
        <Icon name="inbox" size={16} style={{ color: "var(--accent)" }} />
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>Early-access requests</h2>
        {counts.pending > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--on-accent)", background: "var(--accent)", borderRadius: 99, padding: "1px 8px" }}>{counts.pending} pending</span>}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email…" aria-label="Search requests"
          style={{ marginLeft: "auto", height: 30, width: 200, maxWidth: "40vw", padding: "0 11px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12.5, outline: "none" }} />
      </div>

      {/* status tabs */}
      <div style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 9, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 13 }}>
        {tabs.map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px", borderRadius: 7, border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 500,
            background: tab === t.k ? "var(--accent)" : "transparent", color: tab === t.k ? "var(--on-accent)" : "var(--ink-3)" }}>
            {t.label}<span className="mono" style={{ fontSize: 10.5, opacity: 0.8 }}>{counts[t.k]}</span>
          </button>
        ))}
      </div>

      {(selectablePending.length > 0 || bulkNote) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 11, flexWrap: "wrap" }}>
          {selectablePending.length > 0 && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--ink-3)", cursor: "pointer" }}>
              <input type="checkbox" checked={allSelected} onChange={() => setSel(allSelected ? new Set() : new Set(selectablePending.map((r) => r.id)))} /> Select all pending
            </label>
          )}
          {sel.size > 0 && (
            <>
              <button disabled={busy === "bulk"} onClick={bulkApprove} className="btn btn-accent" style={{ padding: "6px 12px", fontSize: 12.5 }}>{busy === "bulk" ? "Approving…" : `Approve ${sel.size} selected`}</button>
              <button onClick={() => setSel(new Set())} className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12.5, color: "var(--ink-4)" }}>Clear</button>
            </>
          )}
          {bulkNote && <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--st-done)" }}>{bulkNote}</span>}
        </div>
      )}

      {loading ? <span style={{ fontSize: 13, color: "var(--ink-4)" }}>Loading…</span> : shown.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--ink-4)", margin: "6px 2px" }}>No {tab === "all" ? "" : tab + " "}requests{needle ? " match your search" : ""}.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {shown.slice(0, 100).map((r) => {
            const badge = REQ_BADGE[r.status] ?? REQ_BADGE.pending;
            const f = flash?.id === r.id ? flash : null;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 10, border: `1px solid ${sel.has(r.id) ? "var(--accent)" : "var(--hairline)"}`, background: sel.has(r.id) ? "var(--accent-dim)" : "var(--surface)" }}>
                {r.status === "pending" && <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggleSel(r.id)} aria-label={`Select ${r.email}`} style={{ flexShrink: 0, cursor: "pointer" }} />}
                <span style={{ width: 32, height: 32, borderRadius: 99, background: "var(--accent-dim)", color: "var(--accent)", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
                  {(r.name || r.email || "?").trim().charAt(0).toUpperCase()}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{r.name || "—"}</div>
                  <div className="truncate" style={{ fontSize: 12, color: "var(--ink-4)" }}>{r.email}</div>
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)", flexShrink: 0 }} title={r.createdAt}>{fmtAgo(r.createdAt)}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: badge.color, background: `color-mix(in oklch, ${badge.color} 14%, transparent)`, borderRadius: 99, padding: "3px 9px", flexShrink: 0 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: badge.color }} />{badge.label}
                </span>
                {f ? (
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: f.ok ? "var(--st-done)" : "var(--prio-urgent)", flexShrink: 0 }}>{f.text}</span>
                ) : (
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {r.status !== "approved" && <button disabled={busy === r.id} onClick={() => act(r.id, "approve")} className="btn btn-accent" style={{ padding: "6px 12px", fontSize: 12.5 }}>{r.status === "declined" ? "Approve anyway" : "Approve"}</button>}
                    {r.status === "pending" && <button disabled={busy === r.id} onClick={() => act(r.id, "decline")} className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12.5, color: "var(--ink-4)" }}>Decline</button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function fmtAgo(iso: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
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

const RANGES = [7, 30, 90];
function TrendChart({ days }: { days: AdminDay[] }) {
  const [metric, setMetric] = useState<keyof Omit<AdminDay, "d">>("sessions");
  const [range, setRange] = useState(30);
  const [hover, setHover] = useState<number | null>(null);
  const active = METRICS.find((m) => m.key === metric)!;
  const view = days.slice(-range);
  const prior = days.slice(-range * 2, -range);
  const W = 720, H = 230, padL = 34, padB = 22, padT = 12;
  const vals = view.map((d) => Number(d[metric]) || 0);
  const max = Math.max(...vals, 1);
  const niceMax = max <= 4 ? 4 : Math.ceil(max / 5) * 5;
  const innerW = W - padL, innerH = H - padB - padT;
  const x = (i: number) => padL + (i / (view.length - 1 || 1)) * innerW;
  const y = (v: number) => padT + innerH - (v / niceMax) * innerH;
  const line = vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
  const area = `${line} L${x(vals.length - 1)} ${padT + innerH} L${padL} ${padT + innerH} Z`;
  const total = vals.reduce((a, b) => a + b, 0);
  const peak = Math.max(...vals, 0);
  const avg = (total / (vals.length || 1));
  const priorTotal = prior.reduce((a, d) => a + (Number(d[metric]) || 0), 0);
  const delta = prior.length >= range && priorTotal > 0 ? Math.round(((total - priorTotal) / priorTotal) * 100) : null;
  const gid = "trend-grad";
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));
  const labelEvery = Math.ceil(view.length / 6);

  const headStat = (label: string, value: string, extra?: React.ReactNode) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span className="kicker" style={{ fontSize: 9.5 }}>{label}</span>
      <span className="mono tnum" style={{ fontSize: 15, fontWeight: 600, display: "inline-flex", alignItems: "baseline", gap: 6 }}>{value}{extra}</span>
    </div>
  );

  return (
    <div className="glass" style={{ borderRadius: 18, padding: "18px 20px 14px", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ width: 9, height: 9, borderRadius: 99, background: active.color, boxShadow: `0 0 8px ${active.color}` }} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>{active.label}</span>
          <span style={{ fontSize: 12, color: "var(--ink-4)" }}>· last {range} days</span>
        </div>
        <div style={{ display: "flex", gap: 22, marginLeft: 6 }}>
          {headStat("Total", total.toLocaleString(), delta != null ? (
            <span style={{ fontSize: 11, fontWeight: 700, color: delta >= 0 ? "var(--st-done)" : "var(--prio-urgent)" }}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}%</span>
          ) : undefined)}
          {headStat("Daily avg", avg.toFixed(avg >= 10 ? 0 : 1))}
          {headStat("Peak", peak.toLocaleString())}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {/* date range */}
          <div style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 8, background: "var(--surface)", border: "1px solid var(--hairline)" }}>
            {RANGES.map((r) => (
              <button key={r} onClick={() => setRange(r)} style={{ fontSize: 11.5, fontWeight: 600, padding: "4px 9px", borderRadius: 6, border: "none", cursor: "pointer",
                background: r === range ? "var(--accent)" : "transparent", color: r === range ? "var(--on-accent)" : "var(--ink-3)" }}>{r}d</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
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
      </div>
      <div style={{ position: "relative" }}>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", overflow: "visible" }}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * W;
            const i = Math.round(((px - padL) / innerW) * (view.length - 1));
            setHover(Math.max(0, Math.min(view.length - 1, i)));
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
          {view.map((d, i) => (i % labelEvery === 0 || i === view.length - 1) ? (
            <text key={i} x={x(i)} y={H - 4} textAnchor="middle" fontSize="9.5" fill="var(--ink-4)" className="mono">{d.d.slice(5)}</text>
          ) : null)}
          {hover != null && hover < view.length && (
            <g>
              <line x1={x(hover)} y1={padT} x2={x(hover)} y2={padT + innerH} stroke={active.color} strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
              <circle cx={x(hover)} cy={y(vals[hover])} r="3.8" fill={active.color} stroke="var(--bg)" strokeWidth="1.5" />
            </g>
          )}
        </svg>
        {hover != null && hover < view.length && (
          <div style={{
            position: "absolute", top: 0, left: `${(x(hover) / W) * 100}%`, transform: "translateX(-50%)",
            background: "var(--surface-2)", border: "1px solid var(--hairline-strong)", borderRadius: 8,
            padding: "5px 9px", pointerEvents: "none", whiteSpace: "nowrap", boxShadow: "var(--shadow)",
          }}>
            <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{fmtDate(view[hover].d)}</div>
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

/* ---- account status chip ---- */
function StatusChip({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 600, color, background: `color-mix(in oklch, ${color} 14%, transparent)`, borderRadius: 99, padding: "2px 8px", whiteSpace: "nowrap" }}>
      <span style={{ width: 5, height: 5, borderRadius: 99, background: color }} />{label}
    </span>
  );
}

/* ---- CSV export ---- */
function exportAccountsCSV(rows: AdminAccount[]) {
  const head = ["Name", "Email", "Joined", "Last active", "Approved", "Admin", "Suspended"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const body = rows.map((a) => [a.name, a.email, a.createdAt, a.updatedAt, a.approved === false ? "no" : "yes", a.isAdmin ? "yes" : "no", a.suspended ? "yes" : "no"].map(esc).join(","));
  const csv = [head.join(","), ...body].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = `kanbo-accounts-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

/* ---- per-account slide-over: detail + admin actions ---- */
function AccountDrawer({ account, currentEmail, onClose, onReload }: {
  account: AdminAccount; currentEmail?: string; onClose: () => void; onReload: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<AdminAccountDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let on = true; store.adminAccountDetail(account.id).then((d) => on && setDetail(d)).catch(reportError); return () => { on = false; }; }, [account.id]);

  const isSelf = (account.email || "").toLowerCase() === (currentEmail || "").toLowerCase();
  const appr = detail?.approved ?? account.approved ?? true;
  const adm = detail?.isAdmin ?? account.isAdmin ?? false;
  const susp = detail?.suspended ?? account.suspended ?? false;

  const run = async (key: string, fn: () => Promise<void>, opts: { close?: boolean; log?: string } = {}) => {
    setBusy(key); setErr(null);
    try {
      await fn();
      if (opts.log) await store.adminLog(key, account.email || account.id, opts.log);
      await onReload();
      if (opts.close) { onClose(); return; }
      const d = await store.adminAccountDetail(account.id); setDetail(d);
    } catch (e) { setErr((e as Error)?.message || "Action failed"); reportError(e); }
    finally { setBusy(null); }
  };

  const stat = (label: string, value: string | number) => (
    <div><div className="kicker" style={{ fontSize: 9.5 }}>{label}</div><div className="mono tnum" style={{ fontSize: 19, fontWeight: 600 }}>{value}</div></div>
  );

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 70, background: "color-mix(in oklch, var(--bg-deep) 45%, transparent)", backdropFilter: "blur(2px)" }} />
      <div role="dialog" aria-modal="true" aria-label={`${account.name} account`} className="anim-fadein" style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 440, maxWidth: "94vw", zIndex: 71, background: "var(--surface-raised)", borderLeft: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 20px", borderBottom: "1px solid var(--hairline)" }}>
          <span style={{ width: 42, height: 42, borderRadius: 99, flexShrink: 0, display: "grid", placeItems: "center", background: "var(--accent-dim)", color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600 }}>{(account.name || account.email || "?").slice(0, 2).toUpperCase()}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="truncate" style={{ fontSize: 16, fontWeight: 600 }}>{account.name || "Unnamed"}{isSelf && <span style={{ fontSize: 12, color: "var(--ink-4)", fontWeight: 400 }}> · you</span>}</div>
            <div className="truncate" style={{ fontSize: 12.5, color: "var(--ink-4)" }}>{account.email}</div>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close" style={{ border: "none" }}><Icon name="x" size={18} /></button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            {adm && <StatusChip label="Admin" color="var(--accent)" />}
            {susp && <StatusChip label="Suspended" color="var(--prio-urgent)" />}
            {!appr && <StatusChip label="Pending approval" color="var(--st-review)" />}
            {appr && !susp && <StatusChip label="Active" color="var(--st-done)" />}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 16 }}>
            {stat("Owned workspaces", detail?.workspacesOwned ?? "—")}
            {stat("Member of", detail?.workspacesMember ?? "—")}
            {stat("Tasks", detail?.tasksTotal ?? "—")}
            {stat("Completed", detail?.tasksDone ?? "—")}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 12.5, color: "var(--ink-3)" }}>
            <Row k="Joined" v={fmtDate(account.createdAt)} />
            <Row k="Last sign-in" v={detail ? (detail.lastSignInAt ? fmtAgo(detail.lastSignInAt) : "never") : "…"} />
            <Row k="Plan" v={detail?.plan ? `${detail.plan}${detail.subStatus ? ` · ${detail.subStatus}` : ""}` : "—"} />
          </div>

          {err && <div style={{ fontSize: 12.5, color: "var(--prio-urgent)", background: "color-mix(in oklch, var(--prio-urgent) 10%, transparent)", borderRadius: 10, padding: "9px 12px" }}>{err}</div>}

          <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="kicker">Actions</div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Extend trial</span>
              {[1, 3, 6].map((m) => (
                <button key={m} disabled={busy != null} onClick={() => run("extend", () => store.adminExtendTrial(account.id, m), { log: `Extended trial +${m} month${m === 1 ? "" : "s"}` })}
                  className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>{busy === "extend" ? "…" : `+${m}mo`}</button>
              ))}
            </div>
            <button disabled={busy != null} onClick={() => run("approve", () => store.adminSetApproved(account.id, !appr), { log: appr ? "Revoked access" : "Approved access" })} className="btn btn-ghost" style={{ justifyContent: "center" }}>
              <Icon name={appr ? "lock" : "check"} size={15} /> {busy === "approve" ? "Saving…" : appr ? "Revoke access" : "Approve access"}
            </button>
            <button disabled={busy != null || (isSelf && adm)} onClick={() => run("admin", () => store.adminSetAdmin(account.id, !adm), { log: adm ? "Revoked admin" : "Granted admin" })} className="btn btn-ghost" style={{ justifyContent: "center" }} title={isSelf && adm ? "You can't remove your own admin" : undefined}>
              <Icon name="sparkles" size={15} /> {busy === "admin" ? "Saving…" : adm ? "Revoke admin" : "Make admin"}
            </button>
            {!isSelf && (
              <button disabled={busy != null} onClick={() => run("suspend", () => store.adminSetSuspended(account.id, !susp), { log: susp ? "Unsuspended" : "Suspended" })} className="btn btn-ghost" style={{ justifyContent: "center", color: susp ? "var(--st-done)" : "var(--prio-high)" }}>
                <Icon name={susp ? "refresh" : "pause"} size={15} /> {busy === "suspend" ? "Saving…" : susp ? "Unsuspend" : "Suspend account"}
              </button>
            )}
            {!isSelf && (
              <button disabled={busy != null} className="btn btn-ghost" style={{ justifyContent: "center", color: "var(--prio-urgent)" }}
                onClick={() => {
                  const typed = window.prompt(`This permanently deletes ${account.email} and ALL their data. This cannot be undone.\n\nType the email to confirm:`);
                  if (typed != null && typed.trim().toLowerCase() === (account.email || "").toLowerCase()) run("delete", () => store.adminDeleteUser(account.id), { close: true, log: "Deleted account" });
                  else if (typed != null) window.alert("Email didn't match — nothing was deleted.");
                }}>
                <Icon name="trash" size={15} /> {busy === "delete" ? "Deleting…" : "Delete account"}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><span style={{ color: "var(--ink-4)" }}>{k}</span><span className="mono" style={{ color: "var(--ink-2)" }}>{v}</span></div>;
}

/* ---- accounts table: search / filter / sort / export + drawer ---- */
type SortKey = "recent" | "joined" | "name";
type FilterKey = "all" | "admins" | "unapproved" | "suspended" | "inactive";
const INACTIVE_MS = 30 * 86400000;
function AccountsPanel({ accounts, loading, currentEmail, onReload }: {
  accounts: AdminAccount[]; loading: boolean; currentEmail?: string; onReload: () => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [open, setOpen] = useState<AdminAccount | null>(null);
  const needle = q.trim().toLowerCase();

  const filtered = accounts.filter((a) => {
    if (needle && !a.name.toLowerCase().includes(needle) && !a.email.toLowerCase().includes(needle)) return false;
    if (filter === "admins") return a.isAdmin;
    if (filter === "unapproved") return a.approved === false;
    if (filter === "suspended") return !!a.suspended;
    if (filter === "inactive") return !a.updatedAt || (Date.now() - new Date(a.updatedAt).getTime()) > INACTIVE_MS;
    return true;
  });
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "joined") return (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0);
    return (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0);
  });

  const selStyle: React.CSSProperties = { height: 30, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12.5, outline: "none", cursor: "pointer" };

  return (
    <div className="glass" style={{ borderRadius: 18, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 18px", borderBottom: "1px solid var(--hairline)", flexWrap: "wrap" }}>
        <Icon name="user" size={16} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 14.5, fontWeight: 600 }}>Accounts</span>
        <span className="mono tnum" style={{ fontSize: 11.5, color: "var(--ink-4)", background: "var(--surface)", borderRadius: 6, padding: "1px 7px" }}>{filtered.length}{filtered.length !== accounts.length ? ` / ${accounts.length}` : ""}</span>
        <div style={{ flex: 1 }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email…" aria-label="Search accounts"
          style={{ height: 30, width: 190, maxWidth: "40vw", padding: "0 11px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12.5, outline: "none" }} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as FilterKey)} aria-label="Filter accounts" style={selStyle}>
          <option value="all">All</option><option value="admins">Admins</option><option value="unapproved">Pending</option><option value="suspended">Suspended</option><option value="inactive">Inactive 30d+</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort accounts" style={selStyle}>
          <option value="recent">Recently active</option><option value="joined">Newest</option><option value="name">Name</option>
        </select>
        <button onClick={() => exportAccountsCSV(sorted)} disabled={!sorted.length} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}><Icon name="arrowUpRight" size={14} /> CSV</button>
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
      ) : sorted.length === 0 ? (
        <div style={{ padding: "28px 18px", textAlign: "center", color: "var(--ink-4)", fontSize: 13 }}>No accounts{needle || filter !== "all" ? " match" : " yet"}.</div>
      ) : sorted.map((a, i) => {
        const inactive = !a.updatedAt || (Date.now() - new Date(a.updatedAt).getTime()) > INACTIVE_MS;
        return (
          <button key={a.id} onClick={() => setOpen(a)} className="lift-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 18px", borderTop: i ? "1px solid var(--hairline)" : "none", width: "100%", textAlign: "left", background: "transparent", border: "none", borderTopColor: "var(--hairline)", cursor: "pointer" }}>
            <span style={{ width: 30, height: 30, borderRadius: 99, flexShrink: 0, display: "grid", placeItems: "center", background: "var(--accent-dim)", color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600 }}>{(a.name || a.email || "?").slice(0, 2).toUpperCase()}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span className="truncate" style={{ fontSize: 13.5, color: "var(--ink)", fontWeight: 500 }}>{a.name}</span>
                {a.isAdmin && <StatusChip label="Admin" color="var(--accent)" />}
                {a.suspended && <StatusChip label="Suspended" color="var(--prio-urgent)" />}
                {a.approved === false && <StatusChip label="Pending" color="var(--st-review)" />}
              </div>
              <div className="truncate" style={{ fontSize: 12, color: "var(--ink-4)" }}>{a.email}</div>
            </div>
            <span className="mono hide-sm" style={{ width: 130, flexShrink: 0, fontSize: 12, color: "var(--ink-3)" }}>{fmtDate(a.createdAt)}</span>
            <span className="mono" style={{ width: 90, flexShrink: 0, textAlign: "right", fontSize: 11.5, color: inactive ? "var(--ink-4)" : "var(--ink-3)" }}>{fmtAgo(a.updatedAt)}</span>
          </button>
        );
      })}
      {open && <AccountDrawer account={open} currentEmail={currentEmail} onClose={() => setOpen(null)} onReload={onReload} />}
    </div>
  );
}

/* ---- billing & revenue ---- */
const SUB_COLORS: Record<string, string> = { active: "#37c6a8", trialing: "var(--accent)", past_due: "#f0a93b", canceled: "#8a8f98" };
function money(cents: number): string {
  const v = cents / 100;
  return "£" + (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}
function BillingPanel({ billing, onReload }: { billing: AdminBilling; onReload: () => Promise<void> }) {
  const [extBusy, setExtBusy] = useState(false);
  const [extNote, setExtNote] = useState<string | null>(null);
  const extendAll = async (months: number) => {
    if (!window.confirm(`Extend every active trial by ${months} month${months === 1 ? "" : "s"}?`)) return;
    setExtBusy(true); setExtNote(null);
    try {
      const n = await store.adminExtendAllTrials(months);
      await store.adminLog("extend_all_trials", "all trials", `Extended ${n} trial${n === 1 ? "" : "s"} by ${months}mo`);
      setExtNote(`Extended ${n} trial${n === 1 ? "" : "s"} by ${months} month${months === 1 ? "" : "s"}.`);
      await onReload();
      setTimeout(() => setExtNote(null), 5000);
    } catch (e) { reportError(e); setExtNote("Couldn't extend trials."); }
    finally { setExtBusy(false); }
  };
  const subTotal = billing.active + billing.trialing + billing.past_due + billing.canceled;
  const paying = billing.active + billing.past_due;
  const mix: { k: string; label: string; v: number }[] = [
    { k: "active", label: "Active", v: billing.active },
    { k: "trialing", label: "Trialing", v: billing.trialing },
    { k: "past_due", label: "Past due", v: billing.past_due },
    { k: "canceled", label: "Canceled", v: billing.canceled },
  ];
  const head = (label: string, value: string, color?: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span className="kicker" style={{ fontSize: 9.5 }}>{label}</span>
      <span className="mono tnum" style={{ fontSize: 22, fontWeight: 600, color: color || "var(--ink)" }}>{value}</span>
    </div>
  );
  return (
    <div className="glass" style={{ borderRadius: 18, padding: "18px 20px", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 16, flexWrap: "wrap" }}>
        <Icon name="zap" size={16} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 15, fontWeight: 600 }}>Billing & revenue</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 7 }}>
          {extNote && <span style={{ fontSize: 12, fontWeight: 600, color: "var(--st-done)" }}>{extNote}</span>}
          <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Extend all trials</span>
          {[1, 3, 6].map((m) => (
            <button key={m} disabled={extBusy} onClick={() => extendAll(m)} className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>{extBusy ? "…" : `+${m}mo`}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "16px 40px", marginBottom: 18 }}>
        {head("MRR", money(billing.mrr_cents), "var(--accent)")}
        {head("Paying", String(paying))}
        {head("Trialing", String(billing.trialing))}
        {head("Seats", String(billing.seats_active))}
        {head("Personal / Team", `${billing.plan_personal} / ${billing.plan_team}`)}
      </div>

      {/* subscription mix */}
      <div className="kicker" style={{ marginBottom: 9 }}>Subscriptions · {subTotal}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: billing.trials_ending.length ? 18 : 0 }}>
        {mix.map((m) => {
          const max = Math.max(...mix.map((x) => x.v), 1);
          return (
            <div key={m.k} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 74, fontSize: 12, color: "var(--ink-3)", flexShrink: 0 }}>{m.label}</span>
              <div style={{ flex: 1, height: 9, borderRadius: 6, background: "var(--surface-2)", overflow: "hidden" }}>
                <div style={{ width: `${(m.v / max) * 100}%`, height: "100%", borderRadius: 6, background: SUB_COLORS[m.k], minWidth: m.v ? 5 : 0, transition: "width .7s var(--ease)" }} />
              </div>
              <span className="mono tnum" style={{ width: 28, textAlign: "right", fontSize: 12, color: "var(--ink-2)", flexShrink: 0 }}>{m.v}</span>
            </div>
          );
        })}
      </div>

      {/* trials ending soon */}
      {billing.trials_ending.length > 0 && (
        <>
          <div className="kicker" style={{ marginBottom: 9 }}>Trials ending soon · {billing.trials_ending.length}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {billing.trials_ending.slice(0, 8).map((t, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 11px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>{t.name || t.email}</div>
                  <div className="truncate" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{t.email}{t.plan ? ` · ${t.plan}` : ""}</div>
                </div>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--st-review)", flexShrink: 0 }}>ends {fmtAgoFuture(t.trial_ends_at)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
function fmtAgoFuture(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso).getTime() - Date.now();
  const days = Math.ceil(d / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

/* ---- conversion funnel ---- */
function FunnelCard({ funnel }: { funnel: AdminFunnel }) {
  const base = Math.max(funnel.signups, 1);
  const steps = [
    { label: "Signed up", v: funnel.signups, color: "var(--accent)", hint: "" },
    { label: "Approved", v: funnel.approved, color: "#6aa3ff", hint: "" },
    { label: "Activated", v: funnel.activated, color: "#37c6a8", hint: "created a task" },
    { label: "Active 30d", v: funnel.active_30d, color: "#f0a93b", hint: "" },
  ];
  return (
    <div className="glass" style={{ borderRadius: 18, padding: "16px 18px", flex: 1, minWidth: 240 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
        <Icon name="trendingUp" size={16} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 14.5, fontWeight: 600 }}>Conversion funnel</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {steps.map((s) => {
          const pct = Math.round((s.v / base) * 100);
          return (
            <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 78, fontSize: 12, color: "var(--ink-3)", flexShrink: 0 }} title={s.hint || undefined}>{s.label}</span>
              <div style={{ flex: 1, height: 9, borderRadius: 6, background: "var(--surface-2)", overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", borderRadius: 6, background: s.color, minWidth: s.v ? 5 : 0, transition: "width .7s var(--ease)" }} />
              </div>
              <span className="mono tnum" style={{ width: 58, textAlign: "right", fontSize: 12, color: "var(--ink-2)", flexShrink: 0 }}>{s.v} · {pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---- broadcast banner composer ---- */
const BANNER_KINDS: { k: "info" | "warning" | "success"; label: string; color: string }[] = [
  { k: "info", label: "Info", color: "var(--accent)" },
  { k: "warning", label: "Warning", color: "#f0a93b" },
  { k: "success", label: "Success", color: "#37c6a8" },
];
function BannerComposer() {
  const [msg, setMsg] = useState("");
  const [kind, setKind] = useState<"info" | "warning" | "success">("info");
  const [current, setCurrent] = useState<{ message: string; kind: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => store.activeBanner().then((b) => setCurrent(b ? { message: b.message, kind: b.kind } : null)).catch(reportError);
  useEffect(() => { load(); }, []);
  const publish = async () => {
    if (!msg.trim()) return;
    setBusy(true);
    try { await store.adminSetBanner(msg.trim(), kind); await store.adminLog("banner", "all users", `Set ${kind} banner: ${msg.trim().slice(0, 80)}`); setMsg(""); await load(); }
    catch (e) { reportError(e); } finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true);
    try { await store.adminClearBanner(); await store.adminLog("banner", "all users", "Cleared banner"); await load(); }
    catch (e) { reportError(e); } finally { setBusy(false); }
  };
  return (
    <div className="glass" style={{ borderRadius: 18, padding: "16px 20px", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 13 }}>
        <Icon name="bell" size={16} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 15, fontWeight: 600 }}>Broadcast banner</span>
        <span style={{ fontSize: 12, color: "var(--ink-4)" }}>· shown to everyone in-app</span>
      </div>
      {current && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 10, marginBottom: 12, background: `color-mix(in oklch, ${BANNER_KINDS.find((b) => b.k === current.kind)?.color || "var(--accent)"} 12%, transparent)`, border: `1px solid color-mix(in oklch, ${BANNER_KINDS.find((b) => b.k === current.kind)?.color || "var(--accent)"} 30%, transparent)` }}>
          <span style={{ fontSize: 13, color: "var(--ink-2)", flex: 1 }}>{current.message}</span>
          <button onClick={clear} disabled={busy} className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>Clear</button>
        </div>
      )}
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "center" }}>
        <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Message to show all users…" aria-label="Banner message"
          style={{ flex: 1, minWidth: 220, height: 38, padding: "0 13px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, outline: "none" }} />
        <select value={kind} onChange={(e) => setKind(e.target.value as "info" | "warning" | "success")} aria-label="Banner type" style={{ height: 38, padding: "0 9px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none", cursor: "pointer" }}>
          {BANNER_KINDS.map((b) => <option key={b.k} value={b.k}>{b.label}</option>)}
        </select>
        <button onClick={publish} disabled={busy || !msg.trim()} className="btn btn-accent" style={{ opacity: msg.trim() ? 1 : 0.5 }}>{busy ? "Saving…" : current ? "Replace" : "Publish"}</button>
      </div>
    </div>
  );
}

/* ---- all-workspaces oversight table ---- */
function WorkspacesPanel() {
  const [rows, setRows] = useState<AdminWorkspace[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const load = () => store.adminWorkspaces().then(setRows).catch(reportError);
  useEffect(() => { load(); }, []);
  if (rows == null) return null;
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((w) => !needle || w.name.toLowerCase().includes(needle) || (w.owner_email || "").toLowerCase().includes(needle));
  const close = async (w: AdminWorkspace) => {
    const typed = window.prompt(`Close "${w.name}" (owner ${w.owner_email})? This deletes all its projects, tasks and members.\n\nType the workspace name to confirm:`);
    if (typed == null) return;
    if (typed.trim() !== w.name) { window.alert("Name didn't match — nothing was closed."); return; }
    setBusy(w.id);
    try { await store.adminCloseWorkspace(w.id); await store.adminLog("close_workspace", w.name, `Closed workspace owned by ${w.owner_email}`); await load(); }
    catch (e) { reportError(e); } finally { setBusy(null); }
  };
  return (
    <div className="glass" style={{ borderRadius: 18, overflow: "hidden", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 18px", borderBottom: "1px solid var(--hairline)", flexWrap: "wrap" }}>
        <Icon name="briefcase" size={16} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 14.5, fontWeight: 600 }}>Workspaces</span>
        <span className="mono tnum" style={{ fontSize: 11.5, color: "var(--ink-4)", background: "var(--surface)", borderRadius: 6, padding: "1px 7px" }}>{rows.length}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search workspaces"
          style={{ marginLeft: "auto", height: 30, width: 180, maxWidth: "40vw", padding: "0 11px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12.5, outline: "none" }} />
      </div>
      {shown.length === 0 ? (
        <div style={{ padding: "24px 18px", textAlign: "center", color: "var(--ink-4)", fontSize: 13 }}>No workspaces{needle ? " match" : ""}.</div>
      ) : shown.map((w, i) => (
        <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 18px", borderTop: i ? "1px solid var(--hairline)" : "none" }}>
          {w.logo_url
            ? <img src={w.logo_url} alt="" style={{ width: 30, height: 30, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
            : <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: "grid", placeItems: "center", background: "var(--surface-2)", color: "var(--ink-4)", fontSize: 13, fontWeight: 700 }}>{(w.name || "?").charAt(0).toUpperCase()}</span>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="truncate" style={{ fontSize: 13.5, fontWeight: 500 }}>{w.name}</div>
            <div className="truncate" style={{ fontSize: 12, color: "var(--ink-4)" }}>{w.owner_name || w.owner_email || "—"}</div>
          </div>
          <span className="mono hide-sm" style={{ fontSize: 11.5, color: "var(--ink-3)", width: 70, textAlign: "right", flexShrink: 0 }}>{w.members} mem</span>
          <span className="mono hide-sm" style={{ fontSize: 11.5, color: "var(--ink-3)", width: 70, textAlign: "right", flexShrink: 0 }}>{w.tasks} tasks</span>
          <span className="mono hide-sm" style={{ fontSize: 11.5, color: "var(--ink-4)", width: 110, textAlign: "right", flexShrink: 0 }}>{fmtDate(w.created_at)}</span>
          <button onClick={() => close(w)} disabled={busy === w.id} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12, color: "var(--prio-urgent)", flexShrink: 0 }}>{busy === w.id ? "…" : <><Icon name="trash" size={13} /> Close</>}</button>
        </div>
      ))}
    </div>
  );
}

/* ---- admin audit log ---- */
function AuditPanel() {
  const [rows, setRows] = useState<AdminAuditEntry[] | null>(null);
  useEffect(() => { store.adminAuditList().then(setRows).catch(reportError); }, []);
  if (rows == null || rows.length === 0) return null;
  return (
    <div className="glass" style={{ borderRadius: 18, overflow: "hidden", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 18px", borderBottom: "1px solid var(--hairline)" }}>
        <Icon name="clock" size={16} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 14.5, fontWeight: 600 }}>Audit log</span>
        <span className="mono tnum" style={{ fontSize: 11.5, color: "var(--ink-4)", background: "var(--surface)", borderRadius: 6, padding: "1px 7px" }}>{rows.length}</span>
      </div>
      {rows.slice(0, 50).map((r, i) => (
        <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 18px", borderTop: i ? "1px solid var(--hairline)" : "none" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="truncate" style={{ fontSize: 13, color: "var(--ink-2)" }}>{r.detail || r.action}{r.target ? <span style={{ color: "var(--ink-4)" }}> · {r.target}</span> : null}</div>
            <div className="truncate" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{r.actor_email || "—"}</div>
          </div>
          <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)", flexShrink: 0 }} title={r.created_at}>{fmtAgo(r.created_at)}</span>
        </div>
      ))}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = { todo: "#8a8f98", progress: "var(--accent)", review: "#f0a93b", blocked: "#e5544b", done: "#37c6a8" };
const PRIORITY_COLORS: Record<string, string> = { low: "#6aa3ff", medium: "#37c6a8", high: "#f0a93b", urgent: "#e5544b" };

export function AdminView({ currentEmail }: { currentEmail?: string } = {}) {
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [series, setSeries] = useState<AdminSeries | null>(null);
  const [billing, setBilling] = useState<AdminBilling | null>(null);
  const [funnel, setFunnel] = useState<AdminFunnel | null>(null);
  const [loading, setLoading] = useState(true);

  const reloadAccounts = useCallback(async () => {
    const a = await store.adminAccounts();
    setAccounts(a ?? await store.adminProfiles());
  }, []);
  const reloadBilling = useCallback(async () => { setBilling(await store.adminBilling()); }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      store.adminAccounts().then((a) => a ?? store.adminProfiles()),
      store.adminStats(),
      store.adminSeriesRange(90),
      store.adminBilling(),
      store.adminFunnel(),
    ])
      .then(([list, s, ts, b, f]) => { if (!cancelled) { setAccounts(list); setStats(s); setSeries(ts); setBilling(b); setFunnel(f); } })
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
    { label: "Stickiness", value: dash ?? (stats?.dau != null && stats?.wau ? `${Math.round((stats.dau / stats.wau) * 100)}%` : "—") },
    { label: "Avg session", value: dash ?? fmtDur(stats?.avg_session_sec) },
    { label: "MRR", value: dash ?? (billing ? money(billing.mrr_cents) : "—") },
  ];

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 24px 56px", maxWidth: 1040, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>Overview</h1>
        <span style={{ fontSize: 13, color: "var(--ink-4)" }}>Live product analytics</span>
      </div>

      <Ribbon items={ribbon} />

      <AccessRequestsPanel />

      <BannerComposer />

      {!series && !loading && (
        <div className="glass" style={{ padding: "13px 16px", borderRadius: 12, marginBottom: 18, display: "flex", alignItems: "center", gap: 11, border: "1px solid color-mix(in oklch, var(--accent) 26%, transparent)", background: "var(--accent-dim)" }}>
          <Icon name="sparkles" size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
            Account numbers are live. To light up the charts, dwell time and cross-user totals, run the one-time <strong>0016_admin_analytics</strong> and <strong>0017_admin_timeseries</strong> SQL in your Supabase editor — then these fill in automatically.
          </span>
        </div>
      )}

      {series && series.days.length > 0 && <TrendChart days={series.days} />}

      {funnel && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 18 }}>
          <FunnelCard funnel={funnel} />
        </div>
      )}

      {billing && <BillingPanel billing={billing} onReload={reloadBilling} />}

      <AccountsPanel accounts={accounts} loading={loading} currentEmail={currentEmail} onReload={reloadAccounts} />

      <div style={{ height: 18 }} />
      <WorkspacesPanel />
      <AuditPanel />
    </div>
  );
}

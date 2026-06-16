/* ============================================================
   KANBO — shared primitives (Avatar, StatusDot, Checkbox, Tag,
   PriorityFlag, Segmented, Tooltip, AiScore)
   ============================================================ */
import { Icon } from "./Icon";
import {
  getMember, memberInitials, STATUS_META, TAGS, PRIORITY_META,
} from "../../data/data";
import type { Status, Priority, IconName } from "../../data/types";

export { Icon };
export { KanboLogo } from "./KanboLogo";

/* ---------- Avatar ---------- */
export function Avatar({ id, size = 24, ring }: { id: string; size?: number; ring?: boolean }) {
  const m = getMember(id);
  if (!m) return null;
  const shadow = ring ? `0 0 0 2px var(--bg), 0 0 0 3.5px ${m.color}` : "0 0 0 1.5px var(--bg)";
  if (m.avatarUrl) {
    return (
      <img src={m.avatarUrl} alt={m.name} title={m.name} style={{
        width: size, height: size, borderRadius: 99, flexShrink: 0, objectFit: "cover",
        display: "inline-block", boxShadow: shadow,
      }} />
    );
  }
  return (
    <span title={m.name} style={{
      width: size, height: size, borderRadius: 99, flexShrink: 0,
      display: "inline-grid", placeItems: "center",
      fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: size * 0.36,
      color: "var(--bg-deep)", background: m.color,
      boxShadow: shadow,
    }}>{memberInitials(m.name)}</span>
  );
}

export function AvatarStack({ ids, size = 22 }: { ids: string[]; size?: number }) {
  return (
    <span style={{ display: "inline-flex" }}>
      {ids.map((id, i) => (
        <span key={id} style={{ marginLeft: i ? -size * 0.32 : 0, zIndex: ids.length - i }}>
          <Avatar id={id} size={size} />
        </span>
      ))}
    </span>
  );
}

/* ---------- StatusDot ---------- */
export function StatusDot({ status, size = 9, glow }: { status: Status; size?: number; glow?: boolean }) {
  const c = STATUS_META[status].color;
  const isProgress = status === "progress";
  return (
    <span style={{ position: "relative", width: size, height: size, flexShrink: 0, display: "inline-block" }}>
      <span style={{
        position: "absolute", inset: 0, borderRadius: 99,
        background: status === "todo" ? "transparent" : c,
        border: status === "todo" ? `1.6px solid ${c}` : "none",
        boxShadow: glow ? `0 0 8px ${c}` : "none",
      }} />
      {isProgress && <span style={{ position: "absolute", inset: -3, borderRadius: 99, border: `1.5px solid ${c}`, opacity: 0.35, animation: "pulseGlow 2s var(--ease) infinite" }} />}
    </span>
  );
}

/* ---------- Checkbox ---------- */
export function Check({ done, onToggle, size = 18 }: { done?: boolean; onToggle?: () => void; size?: number }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onToggle && onToggle(); }} aria-label="toggle"
      style={{
        width: size, height: size, borderRadius: 6, flexShrink: 0, cursor: "pointer", padding: 0,
        display: "grid", placeItems: "center", transition: "all .18s var(--ease)",
        border: `1.6px solid ${done ? "var(--accent)" : "var(--hairline-strong)"}`,
        background: done ? "var(--accent)" : "transparent",
        boxShadow: done ? "0 0 12px var(--accent-glow)" : "none",
      }}>
      {done && <Icon name="check" size={size * 0.7} sw={3} style={{ color: "var(--on-accent)" }} />}
    </button>
  );
}

/* ---------- Tag chip ---------- */
export function Tag({ id, small }: { id: string; small?: boolean }) {
  const tg = TAGS[id];
  if (!tg) return null;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      fontFamily: "var(--font-mono)", fontSize: small ? 10 : 11, fontWeight: 500,
      padding: small ? "1px 7px" : "2px 8px", borderRadius: 6,
      color: tg.color,
      border: `1px solid color-mix(in oklch, ${tg.color} 30%, transparent)`,
      backgroundColor: `color-mix(in oklch, ${tg.color} 12%, transparent)`,
    }}>{tg.label}</span>
  );
}

/* ---------- Priority flag ---------- */
export function PriorityFlag({ priority, size = 14, withLabel }: { priority: Priority; size?: number; withLabel?: boolean }) {
  const p = PRIORITY_META[priority];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: p.color }} title={p.label + " priority"}>
      <Icon name="flag" size={size} fill={priority === "urgent" || priority === "high" ? p.color : "none"} />
      {withLabel && <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{p.label}</span>}
    </span>
  );
}

/* ---------- AI score pill ---------- */
export function AiScore({ score, reason }: { score: number; reason?: string }) {
  const c = score >= 80 ? "var(--prio-urgent)" : score >= 60 ? "var(--prio-high)" : "var(--ink-3)";
  return (
    <span data-tip={reason} className="ai-score" style={{
      display: "inline-flex", alignItems: "center", gap: 5, position: "relative",
      fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, color: c,
      padding: "2px 7px 2px 6px", borderRadius: 6,
      background: `color-mix(in oklch, ${c} 12%, transparent)`,
      border: `1px solid color-mix(in oklch, ${c} 26%, transparent)`,
    }}>
      <Icon name="sparkles" size={11} />{score}
    </span>
  );
}

/* ---------- Segmented control ---------- */
export interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
  icon?: IconName;
}
export function Segmented<T extends string>({ options, value, onChange }: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="kseg">
      {options.map((o) => (
        <button key={o.value} className="kseg-btn" data-active={o.value === value} onClick={() => onChange(o.value)} title={o.label}>
          {o.icon && <Icon name={o.icon} size={15} />}{o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Tooltip (CSS via data-tip) ---------- */
export function GlobalTipStyles() {
  return (
    <style>{`
      [data-tip]::after {
        content: attr(data-tip);
        position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%) translateY(4px);
        background: var(--surface-raised); color: var(--ink); border: 1px solid var(--hairline-strong);
        font-family: var(--font-display); font-size: 11.5px; font-weight: 400; line-height: 1.4;
        padding: 7px 10px; border-radius: 9px; white-space: normal; width: max-content; max-width: 220px;
        box-shadow: var(--shadow-lg); opacity: 0; pointer-events: none; transition: all .16s var(--ease); z-index: 200;
      }
      [data-tip]:hover::after { opacity: 1; transform: translateX(-50%) translateY(0); }
    `}</style>
  );
}

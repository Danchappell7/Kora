/* ============================================================
   KANBO — Topbar
   ============================================================ */
import { useState } from "react";
import type { ReactNode, CSSProperties } from "react";
import { Icon } from "./primitives";

const createMenuItem: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 10px", borderRadius: 9,
  border: "none", cursor: "pointer", textAlign: "left", background: "transparent",
  color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5,
};

export function Topbar({ title, subtitle, breadcrumb, children, onNewTask, onNewProject, onCommand, onBell, onMenu, theme, toggleTheme }: {
  title?: string;
  subtitle?: string;
  breadcrumb?: string;
  children?: ReactNode;
  onNewTask: () => void;
  onNewProject: () => void;
  onCommand: () => void;
  onBell: () => void;
  onMenu?: () => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <header className="topbar" style={{
      display: "flex", alignItems: "center", gap: 16, padding: "16px 24px 14px",
      borderBottom: "1px solid var(--hairline)", flexShrink: 0, position: "relative", zIndex: 4,
    }}>
      {onMenu && (
        <button className="btn-icon" onClick={onMenu} aria-label="Open menu" style={{ flexShrink: 0 }}>
          <Icon name="menu" size={18} />
        </button>
      )}
      <div style={{ minWidth: 0 }}>
        {breadcrumb && <div className="kicker" style={{ marginBottom: 5 }}>{breadcrumb}</div>}
        <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.025em", lineHeight: 1.1 }}>{title}</h1>
        {subtitle && <p style={{ margin: "3px 0 0", fontSize: 13, color: "var(--ink-3)" }}>{subtitle}</p>}
      </div>
      <div style={{ flex: 1 }} />
      <button onClick={onCommand} className="topbar-search" aria-label="Search or open command palette" style={{
        display: "flex", alignItems: "center", gap: 9, height: 38, padding: "0 12px 0 13px", minWidth: 210,
        borderRadius: 11, border: "1px solid var(--hairline)", background: "var(--surface)", cursor: "pointer",
        color: "var(--ink-4)", fontFamily: "var(--font-display)", fontSize: 13.5, transition: "all .16s",
      }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--hairline-strong)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--hairline)")}>
        <Icon name="search" size={16} />
        <span style={{ flex: 1, textAlign: "left" }}>Search or ask Kanbo…</span>
        <kbd className="mono" style={{ fontSize: 11, padding: "2px 6px", borderRadius: 6, background: "var(--surface-2)", border: "1px solid var(--hairline)", color: "var(--ink-4)" }}>⌘K</kbd>
      </button>
      {children}
      <button className="btn-icon" onClick={toggleTheme} title="Toggle theme">
        <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
      </button>
      <button className="btn-icon" onClick={onBell} title="Notifications" style={{ position: "relative" }}>
        <Icon name="bell" size={17} />
        <span style={{ position: "absolute", top: 7, right: 7, width: 6, height: 6, borderRadius: 99, background: "var(--accent)", boxShadow: "0 0 6px var(--accent)" }} />
      </button>
      <div style={{ position: "relative" }}>
        <button className="btn btn-accent topbar-create" onClick={() => setCreateOpen((v) => !v)}>
          <Icon name="plus" size={16} /> <span className="topbar-create-label">Create <Icon name="chevronDown" size={14} style={{ marginLeft: -2, opacity: 0.8 }} /></span>
        </button>
        {createOpen && (
          <>
            <div onClick={() => setCreateOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
            <div className="glass anim-scalein" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 41, width: 184, padding: 6, borderRadius: 12, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
              <button style={createMenuItem} onClick={() => { setCreateOpen(false); onNewTask(); }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <Icon name="tasks" size={16} style={{ color: "var(--accent)" }} /> New task
              </button>
              <button style={createMenuItem} onClick={() => { setCreateOpen(false); onNewProject(); }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <Icon name="folder" size={16} style={{ color: "var(--accent)" }} /> New project
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}

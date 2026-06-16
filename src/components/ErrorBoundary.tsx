/* ============================================================
   KANBO — top-level error boundary
   Catches render/runtime errors, reports them, and shows a
   recoverable fallback instead of a white screen.
   ============================================================ */
import { Component, type ReactNode } from "react";
import { reportError } from "../lib/monitoring";

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportError(error, { componentStack: info.componentStack ?? undefined });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ position: "relative", height: "100vh", display: "grid", placeItems: "center", overflow: "hidden", padding: 24 }}>
        <div className="app-bg" />
        <div className="glass" style={{ position: "relative", zIndex: 1, maxWidth: 440, width: "100%", padding: 28, borderRadius: 20, textAlign: "center", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "color-mix(in oklch, var(--st-blocked) 14%, transparent)", color: "var(--st-blocked)", marginBottom: 16 }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ink-3)", margin: "0 0 20px" }}>
            An unexpected error interrupted the page. Reloading usually fixes it — and we've logged it so it can be looked into.
          </p>
          <button className="btn btn-accent" onClick={() => window.location.reload()} style={{ justifyContent: "center" }}>Reload Kanbo</button>
        </div>
      </div>
    );
  }
}

/* ============================================================
   KANBO — error boundaries
   Catches render/runtime errors, reports them, and shows a
   recoverable fallback instead of a white screen.
   - default: the whole-app fallback (reload Kanbo)
   - inline: a single view or panel failed — the rest of the app
     keeps working, with "Go home" (or "Close") and "Retry"
   ============================================================ */
import { Component, type ReactNode } from "react";
import { reportError } from "../lib/monitoring";
import { AppBg } from "./primitives";

interface Props {
  children: ReactNode;
  /** contain the failure to one view/panel instead of replacing the whole app */
  inline?: boolean;
  /** inline only: render the fallback as a floating side panel (for overlays such as the task panel) */
  floating?: boolean;
  /** inline only: leave the broken view — e.g. route home or close the panel */
  onHome?: () => void;
  /** inline only: label for the leave button (default "Go home") */
  homeLabel?: string;
  /** identifies the boundary in error reports */
  name?: string;
}
interface State { error: Error | null }

const warnIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
);

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportError(error, { componentStack: info.componentStack ?? undefined, boundary: this.props.name ?? (this.props.inline ? "inline" : "app") });
  }

  private retry = () => this.setState({ error: null });

  private home = () => {
    this.setState({ error: null });
    this.props.onHome?.();
  };

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.inline) return this.renderInline();
    return (
      <div style={{ position: "relative", height: "100vh", display: "grid", placeItems: "center", overflow: "hidden", padding: 24 }}>
        <AppBg />
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

  private renderInline() {
    const { floating, onHome, homeLabel = "Go home" } = this.props;
    const card = (
      <div role="alert" className="glass" style={{ width: "100%", maxWidth: 400, padding: "22px 22px 20px", borderRadius: 18, textAlign: "center", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", border: "1px solid var(--hairline)" }}>
        <div style={{ display: "inline-flex", padding: 11, borderRadius: 14, background: "color-mix(in oklch, var(--st-blocked) 14%, transparent)", color: "var(--st-blocked)", marginBottom: 12 }}>{warnIcon}</div>
        <h2 style={{ fontSize: 16.5, fontWeight: 600, letterSpacing: "-0.01em", margin: "0 0 6px" }}>This view hit a problem</h2>
        <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--ink-3)", margin: "0 0 16px" }}>
          The rest of Kanbo is still working and your saved work is safe. We've logged the error so it can be fixed.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          {onHome && <button type="button" className="btn btn-ghost" onClick={this.home} style={{ justifyContent: "center" }}>{homeLabel}</button>}
          <button type="button" className="btn btn-accent" onClick={this.retry} style={{ justifyContent: "center" }}>Retry</button>
        </div>
      </div>
    );
    if (floating) {
      return (
        <div role="dialog" aria-modal="true" aria-label="Task panel error" style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 60, width: 440, maxWidth: "100vw", display: "grid", placeItems: "center", padding: 18, background: "var(--surface-solid, var(--surface-raised))", borderLeft: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)" }}>
          {card}
        </div>
      );
    }
    return <div style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: 24, overflowY: "auto" }}>{card}</div>;
  }
}

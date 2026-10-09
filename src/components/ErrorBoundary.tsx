/* ============================================================
   KANBO — error boundaries
   Catches render/runtime errors, reports them, and shows a calm,
   recoverable empty state instead of a white screen.
   - default: the whole app failed — Reload, or Go to Today
   - inline: a single view or panel failed — the rest of the app keeps
     working; Reload re-renders the view, the leave button routes away
     ("Go to Today", or "Close" for a panel). When the view's code didn't
     arrive (a chunk), Reload tries it in place once if the browser can
     be asked for the file again, and otherwise reloads the page: a
     browser never fetches a module that failed in this page again.
   ============================================================ */
import { Component, type ReactNode } from "react";
import { reportError } from "../lib/monitoring";
import { chunkReload, chunkRetryable, isChunkLoadError } from "../lib/lazyLoad";
import { AppBg, Button } from "./primitives";

interface Props {
  children: ReactNode;
  /** contain the failure to one view/panel instead of replacing the whole app */
  inline?: boolean;
  /** inline only: render the fallback as a floating side panel (for overlays such as the task panel) */
  floating?: boolean;
  /** inline only: leave the broken view — e.g. route to Today or close the panel */
  onHome?: () => void;
  /** inline only: label for the leave button (default "Go to Today") */
  homeLabel?: string;
  /** identifies the boundary in error reports */
  name?: string;
}
interface State { error: Error | null }

const TITLE = "Something went wrong on this page";

const mark = (
  <span className="kempty-mark" aria-hidden="true">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </svg>
  </span>
);

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportError(error, { componentStack: info.componentStack ?? undefined, boundary: this.props.name ?? (this.props.inline ? "inline" : "app") });
  }

  /** a chunk that didn't arrive has had its one in-place retry here */
  private chunkRetried = false;

  private retry = () => {
    const { error } = this.state;
    if (error && isChunkLoadError(error)) {
      if (this.chunkRetried || !chunkRetryable(error)) { chunkReload.reload(); return; }
      this.chunkRetried = true;
    }
    this.setState({ error: null });
  };

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
        <div role="alert" className="kempty" data-size="lg" style={{ position: "relative", zIndex: 1 }}>
          {mark}
          <h1 className="kempty-title">{TITLE}</h1>
          <div className="kempty-body">
            <p>Something unexpected interrupted Kanbo. Reloading usually fixes it, and the error has been logged so it can be looked into.</p>
          </div>
          <div className="kempty-action">
            <Button variant="secondary" onClick={() => window.location.assign("/today")}>Go to Today</Button>
            <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </div>
      </div>
    );
  }

  private renderInline() {
    const { floating, onHome, homeLabel = "Go to Today" } = this.props;
    const card = (
      <div role="alert" className="kempty" data-size="md">
        {mark}
        <h2 className="kempty-title">{TITLE}</h2>
        <div className="kempty-body">
          <p>The rest of Kanbo is still working and your saved work is safe. The error has been logged so it can be fixed.</p>
        </div>
        <div className="kempty-action">
          {onHome && <Button variant="secondary" onClick={this.home}>{homeLabel}</Button>}
          <Button variant="primary" icon="refresh" onClick={this.retry}>Reload</Button>
        </div>
      </div>
    );
    if (floating) {
      return (
        <div role="dialog" aria-modal="true" aria-label="Task panel error" style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 60, width: "var(--detail-w, 480px)", maxWidth: "100vw", display: "grid", placeItems: "center", padding: 24, background: "var(--bg)", borderLeft: "1px solid var(--hairline)", boxShadow: "var(--e2-drop, var(--shadow-lg))" }}>
          {card}
        </div>
      );
    }
    return <div style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: 24, overflowY: "auto" }}>{card}</div>;
  }
}

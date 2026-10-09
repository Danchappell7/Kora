/* ============================================================
   KANBO — skeletons for a page whose code is still arriving (the
   places are split into chunks: lazyViews.ts). Each one is the
   silhouette of the page it stands in for — a tab bar and 36px rows
   (Inbox, My tasks, Search, a project's list), columns (Board), cards
   (Projects), tiles and charts (Pulse, Insights, Workload), people,
   the week and the month — at the same gutters and widths, so nothing
   jumps when the page lands. It fades in after a beat (a fast load
   shows nothing at all), and not at all with reduced motion. The
   silhouette is hidden from assistive tech; a status line says what's
   loading instead.
   ============================================================ */
import type { CSSProperties, Key, ReactNode } from "react";
import type { Route, TaskView } from "../app-types";

export type SkeletonKind = "list" | "board" | "tiles" | "insights" | "people" | "week" | "month";

/** Which silhouette a route's page has (a project or My tasks: the view it's shown in). */
export function skeletonFor(route: Route, taskView: TaskView = "list"): SkeletonKind {
  switch (route.view) {
    case "myweek": return "week";
    case "calendar": return "month";
    case "home": case "pulse": case "analytics": case "reports": case "workload": return "insights";
    case "projects": case "portfolios": case "goals": return "tiles";
    case "team": return "people";
    case "tasks": case "project": {
      // a project's own pages (Docs, Updates, Requests, Rules, About) are columns of rows too
      const tab = route.view === "project" ? route.tab ?? taskView : taskView;
      return tab === "board" ? "board" : tab === "calendar" ? "month" : "list";
    }
    default: return "list";
  }
}

const bar = (w: number | string, h: number | string = 12, style: CSSProperties = {}, key?: Key) => (
  <span key={key} className="skel" style={{ display: "block", flexShrink: 0, width: w, height: h, borderRadius: "var(--r-xs, 4px)", ...style }} />
);
const fade = (i: number): CSSProperties => ({ opacity: Math.max(0.3, 1 - i * 0.09) });

function TabBar({ tabs = [56, 72, 48] }: { tabs?: number[] }) {
  return <div className="kpskel-bar">{tabs.map((w, i) => bar(w, 12, {}, i))}<span style={{ flex: 1 }} />{bar(88, 28, { borderRadius: "var(--r-sm, 6px)" })}</div>;
}

function Rows({ n = 9, avatar = false }: { n?: number; avatar?: boolean }) {
  return (
    <>
      {bar(96, 10, { margin: "4px 12px 12px" })}
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="kpskel-row" style={fade(i)}>
          {avatar ? bar(28, 28, { borderRadius: 999 }) : bar(16, 16, { borderRadius: 999 })}
          {bar(`${30 + (i * 13) % 36}%`, 12)}
          <span style={{ flex: 1 }} />
          <span className="kpskel-wide">{bar(64, 11)}</span>
          {bar(44, 11)}
        </div>
      ))}
    </>
  );
}

function Card({ lines = 2, tall = 0 }: { lines?: number; tall?: number }) {
  return (
    <div className="kpskel-card">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>{bar(24, 24, { borderRadius: "var(--r-sm, 6px)" })}{bar("45%", 13)}</div>
      {Array.from({ length: lines }, (_, i) => bar(`${80 - i * 22}%`, 10, {}, i))}
      {tall > 0 && <span style={{ display: "block", height: tall }} />}
      {bar("100%", 4, { borderRadius: 99, marginTop: "auto" })}
    </div>
  );
}

const BODY: Record<SkeletonKind, () => ReactNode> = {
  list: () => <><TabBar /><div className="kpskel-body"><Rows /></div></>,
  board: () => (
    <><TabBar />
      <div className="kpskel-body" style={{ maxWidth: "none" }}>
        <div className="kpskel-cols">
          {[3, 2, 4, 1].map((cards, c) => (
            <div key={c} className="kpskel-col">
              <div style={{ display: "flex", alignItems: "center", gap: 8, height: 32 }}>{bar(12, 12, { borderRadius: 99 })}{bar(72, 12)}</div>
              {Array.from({ length: cards }, (_, i) => <div key={i} className="kpskel-card" style={fade(i)}>{bar("70%", 12)}{bar("40%", 10)}</div>)}
            </div>
          ))}
        </div>
      </div>
    </>
  ),
  tiles: () => (
    <div className="kpskel-body" style={{ margin: "0 auto" }}>
      <div className="kpskel-tools">{bar(240, 32, { borderRadius: "var(--r-sm, 6px)", maxWidth: "100%" })}{bar(160, 28, { borderRadius: "var(--r-sm, 6px)" })}</div>
      <div className="kpskel-grid">{Array.from({ length: 6 }, (_, i) => <div key={i} style={fade(i)}><Card tall={24} /></div>)}</div>
    </div>
  ),
  insights: () => (
    <div className="kpskel-body">
      <div className="kpskel-stats">
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="kpskel-card" style={{ minHeight: 88 }}>{bar("50%", 10)}{bar(64, 24)}</div>)}
      </div>
      <div className="kpskel-charts">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="kpskel-card" style={{ minHeight: 240 }}>
            {bar("35%", 12)}
            <div style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 10, paddingTop: 16 }}>
              {[60, 85, 45, 100, 70, 90, 55].map((h, j) => bar(`${100 / 9}%`, Math.round(h * 1.4), { borderRadius: "var(--r-xs, 4px) var(--r-xs, 4px) 0 0" }, j))}
            </div>
          </div>
        ))}
      </div>
    </div>
  ),
  people: () => <><TabBar tabs={[48, 64, 72, 56]} /><div className="kpskel-body"><Rows n={7} avatar /></div></>,
  week: () => (
    <div className="kpskel-body" style={{ maxWidth: "none" }}>
      <div className="kpskel-week">
        {Array.from({ length: 7 }, (_, d) => (
          <div key={d} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {bar(56, 12, { margin: "4px 0 6px" })}
            {Array.from({ length: [3, 2, 4, 2, 3, 1, 0][d] }, (_, i) => <div key={i} className="kpskel-card" style={{ padding: 10, ...fade(i) }}>{bar("75%", 11)}{bar("40%", 9)}</div>)}
          </div>
        ))}
      </div>
    </div>
  ),
  month: () => (
    <div className="kpskel-body" style={{ maxWidth: "none", overflowX: "hidden" }}>
      <div className="kpskel-tools">{bar(140, 16)}<span style={{ flex: 1 }} />{bar(120, 28, { borderRadius: "var(--r-sm, 6px)" })}</div>
      <div className="kpskel-month">
        {Array.from({ length: 35 }, (_, i) => <div key={i} className="kpskel-cell">{bar(16, 10)}{i % 3 === 0 && bar("70%", 10, { marginTop: 8 })}</div>)}
      </div>
    </div>
  ),
};

/** A place's page while its code arrives. `label`: the page's name ("Inbox"). */
export function PlaceSkeleton({ kind, label }: { kind: SkeletonKind; label: string }) {
  return (
    <div className="kpskel" data-kind={kind}>
      <span className="sr-only" role="status">Loading {label}…</span>
      <div aria-hidden="true" style={{ display: "contents" }}>{BODY[kind]()}</div>
    </div>
  );
}

/** The task panel's place while its code arrives: its edge, header and first fields. */
export function PanelSkeleton({ mobile = false }: { mobile?: boolean }) {
  return (
    <div className="kpanel-skel" data-mobile={mobile || undefined}>
      <span className="sr-only" role="status">Loading task…</span>
      <div aria-hidden="true" style={{ display: "contents" }}>
        <div className="kpanel-skel-head">{bar(120, 12)}<span style={{ flex: 1 }} />{bar(28, 28, { borderRadius: "var(--r-sm, 6px)" })}{bar(28, 28, { borderRadius: "var(--r-sm, 6px)" })}</div>
        <div className="kpanel-skel-body">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>{bar(20, 20, { borderRadius: 999 })}{bar("70%", 20)}</div>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 16, height: 32, ...fade(i) }}>{bar(72, 11)}{bar(`${30 + (i * 17) % 40}%`, 12)}</div>
          ))}
          {bar("100%", 72, { marginTop: 12, borderRadius: "var(--r-md, 8px)" })}
        </div>
      </div>
    </div>
  );
}

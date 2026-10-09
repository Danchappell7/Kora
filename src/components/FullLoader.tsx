/* ============================================================
   KANBO — the loading silhouette, shown while the session and the
   workspace load (and while the app's own code arrives), so nothing
   jumps when the shell lands. Shared by the front door (Root) and
   the app itself.
   ============================================================ */
import { AppBg } from "./primitives";

/** The shell's own silhouette while the workspace loads: the sidebar (or, on a
 *  phone, the bottom bar), the page header and a column of 36px rows, so
 *  nothing jumps when it lands. The silhouette is hidden from assistive tech;
 *  a status line says what's happening instead. */
export function FullLoader() {
  const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;
  const bar = (w: number | string, h = 12, style: React.CSSProperties = {}) => <div className="skel" style={{ width: w, height: h, borderRadius: "var(--r-xs, 4px)", ...style }} />;
  return (
    <div style={{ position: "relative", height: "100vh", overflow: "hidden", display: "flex", background: "var(--bg)" }}>
      <span className="sr-only" role="status">Loading your workspace…</span>
      <AppBg />
      {!isMobile && (
        <div aria-hidden="true" style={{ position: "relative", zIndex: 1, width: "var(--sidebar-w, 232px)", flexShrink: 0, background: "var(--bg-deep)", borderRight: "1px solid var(--hairline)", padding: "12px 10px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, height: 44, padding: "0 8px" }}>{bar(24, 24, { borderRadius: "var(--r-sm, 6px)" })}{bar(96, 14)}</div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
            {[62, 48, 70].map((w, i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, height: 32, padding: "0 8px" }}>{bar(16, 16)}{bar(w, 12)}</div>)}
          </div>
          <div style={{ padding: "16px 8px 6px" }}>{bar(40, 10)}</div>
          {[64, 44].map((w, i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, height: 32, padding: "0 8px" }}>{bar(16, 16)}{bar(w, 12)}</div>)}
          <div style={{ padding: "16px 8px 6px" }}>{bar(52, 10)}</div>
          {[112, 88, 96].map((w, i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, height: 30, padding: "0 8px" }}>{bar(8, 8, { borderRadius: 2 })}{bar(w, 11)}</div>)}
        </div>
      )}
      <div aria-hidden="true" style={{ position: "relative", zIndex: 1, flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, height: isMobile ? 52 : "var(--header-h, 56px)", padding: "0 var(--gutter, 32px)", borderBottom: "1px solid var(--hairline)", flexShrink: 0 }}>
          {bar(isMobile ? 96 : 120, 18)}{!isMobile && bar(72, 11)}<div style={{ flex: 1 }} />
          {!isMobile && bar(240, 32, { borderRadius: "var(--r-sm, 6px)" })}{bar(isMobile ? 32 : 112, 32, { borderRadius: "var(--r-sm, 6px)" })}
        </div>
        <div style={{ padding: "20px var(--gutter, 32px)", display: "flex", flexDirection: "column", width: "100%", maxWidth: "var(--list-max, 1120px)", boxSizing: "border-box" }}>
          {bar(96, 12, { marginBottom: 12 })}
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, height: "var(--row-h, 36px)", padding: "0 12px", opacity: 1 - i * 0.09 }}>
              {bar(16, 16, { borderRadius: 99 })}
              {bar(`${34 + (i * 11) % 38}%`, 12)}
              <div style={{ flex: 1 }} />
              {!isMobile && bar(64, 11)}{bar(44, 11)}
            </div>
          ))}
        </div>
        {isMobile && (
          // the phone's bottom bar: five slots, the middle one the + button
          <div style={{ marginTop: "auto", flexShrink: 0, display: "flex", alignItems: "flex-start", height: "calc(56px + env(safe-area-inset-bottom, 0px))", paddingTop: 8, boxSizing: "border-box", background: "var(--bg-deep)", borderTop: "1px solid var(--hairline)" }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} style={{ flex: "1 1 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                {i === 2 ? bar(48, 40, { borderRadius: "var(--r-md, 8px)", marginTop: -2 }) : <>{bar(22, 22, { borderRadius: "var(--r-sm, 6px)" })}{bar(36, 8)}</>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   KANBO — "you have unsynced changes" guard on sign-out.
   Signing out wipes this device's offline queue (so it can never
   replay as the next person), so we never do it silently: if edits
   are still waiting, give the sync a moment, and if they can't go
   through, let the person choose to stay or discard them.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { offlineQueue } from "../lib/offlineQueue";

/** how long to wait for an in-flight sync before asking */
const SYNC_GRACE_MS = 3000;

export function UnsyncedSignOutDialog({ onStay, onSignOut }: { onStay: () => void; onSignOut: () => void }) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onStay);
  const [count, setCount] = useState(() => offlineQueue.size());
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  const [waited, setWaited] = useState(false);
  const finished = useRef(false);

  useEffect(() => offlineQueue.subscribe(setCount), []);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const t = window.setTimeout(() => setWaited(true), SYNC_GRACE_MS);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); clearTimeout(t); };
  }, []);
  // everything synced while we waited — carry on signing out
  useEffect(() => {
    if (count === 0 && !finished.current) { finished.current = true; onSignOut(); }
  }, [count, onSignOut]);

  const syncing = online && !waited && count > 0;
  const n = count === 1 ? "1 change" : `${count} changes`;
  const it = count === 1 ? "it" : "they";
  const title = syncing ? "Syncing your changes…" : "You have unsynced changes";
  const body = syncing
    ? `Saving ${n} before you sign out.`
    : !online
      ? `${n} you made offline ${count === 1 ? "hasn’t" : "haven’t"} reached Kanbo yet. Reconnect and ${it}’ll sync automatically. If you sign out now, ${it}’ll be lost.`
      : `${n} ${count === 1 ? "hasn’t" : "haven’t"} synced yet. Stay signed in and Kanbo will keep trying, or sign out and discard ${count === 1 ? "it" : "them"}.`;

  return (
    <div className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 200, background: "color-mix(in oklch, var(--bg-deep) 62%, transparent)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18, overflowY: "auto" }}>
      <div ref={trapRef} role="alertdialog" aria-modal="true" aria-labelledby="kanbo-unsynced-title" aria-describedby="kanbo-unsynced-body" className="glass anim-scalein"
        style={{ width: 420, maxWidth: "94vw", borderRadius: 20, padding: 26, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <span style={{ display: "inline-grid", placeItems: "center", width: 42, height: 42, borderRadius: 13, marginBottom: 14, background: syncing ? "var(--accent-dim)" : "color-mix(in oklch, var(--prio-high) 18%, transparent)", color: syncing ? "var(--accent)" : "var(--prio-high)" }}>
          <Icon name={syncing ? "refresh" : "clock"} size={20} />
        </span>
        <h2 id="kanbo-unsynced-title" style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>{title}</h2>
        <p id="kanbo-unsynced-body" aria-live="polite" style={{ fontSize: 14, color: "var(--ink-3)", lineHeight: 1.55, margin: "0 0 20px" }}>{body}</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <button autoFocus onClick={onStay} className="btn btn-accent" style={{ flex: 1, minWidth: 150, justifyContent: "center", padding: "11px 15px" }}>Stay signed in</button>
          <button onClick={() => { finished.current = true; onSignOut(); }} className="btn btn-ghost" style={{ flex: 1, minWidth: 150, justifyContent: "center", padding: "11px 15px", color: "var(--prio-urgent)" }}>
            Sign out and discard
          </button>
        </div>
      </div>
    </div>
  );
}

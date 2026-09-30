/* ============================================================
   KANBO — "you have unsynced changes" guard on sign-out.
   Signing out wipes this device's offline queue (so it can never
   replay as the next person), so we never do it silently: if edits
   are still waiting and we're online, sync them now and carry on
   signing out once they're saved. If they can't go through, say so
   honestly and let the person try again, stay, or discard them.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { offlineQueue } from "../lib/offlineQueue";

/** keep "Syncing…" up at least this long so a quick sync doesn't flash */
const MIN_SYNC_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function UnsyncedSignOutDialog({ onSync, onStay, onSignOut }: {
  /** replay the offline queue now */
  onSync: () => Promise<unknown>;
  onStay: () => void;
  onSignOut: () => void;
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onStay);
  const [count, setCount] = useState(() => offlineQueue.size());
  const online0 = typeof navigator === "undefined" || navigator.onLine !== false;
  const [online, setOnline] = useState(online0);
  // it syncs on mount when online — start in that state so the first frame
  // doesn't flash "couldn't save"
  const [syncing, setSyncing] = useState(online0);
  const finished = useRef(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const syncRef = useRef(onSync);
  syncRef.current = onSync;

  const sync = useCallback(async () => {
    if (busy.current || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
    busy.current = true;
    setSyncing(true);
    const started = Date.now();
    try { await syncRef.current(); } catch { /* what's left stays queued — shown below */ }
    const left = offlineQueue.size();
    const rest = MIN_SYNC_MS - (Date.now() - started);
    if (rest > 0) await sleep(rest);
    // the app may be replaying the queue itself (e.g. it just came back
    // online) — keep saying "Syncing" while the queue is still shrinking
    for (let last = left, n = offlineQueue.size(); n > 0 && n < last && Date.now() - started < 10_000; n = offlineQueue.size()) {
      last = n;
      await sleep(MIN_SYNC_MS);
    }
    busy.current = false;
    if (alive.current) setSyncing(false);
  }, []);

  useEffect(() => offlineQueue.subscribe(setCount), []);
  useEffect(() => {
    alive.current = true;
    const on = () => { setOnline(true); sync(); };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    sync(); // online now? save them before signing out
    return () => { alive.current = false; window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, [sync]);
  // everything synced — carry on signing out
  useEffect(() => {
    if (count === 0 && !finished.current) { finished.current = true; onSignOut(); }
  }, [count, onSignOut]);

  const showSyncing = online && syncing && count > 0;
  const one = count === 1;
  const n = one ? "1 change" : `${count} changes`;
  const title = showSyncing ? "Syncing your changes…" : "You have unsynced changes";
  const body = showSyncing
    ? `Saving ${n} before you sign out.`
    : !online
      ? `You’re offline, so ${n} ${one ? "hasn’t" : "haven’t"} reached Kanbo yet. Reconnect and ${one ? "it’ll" : "they’ll"} sync automatically. If you sign out now, ${one ? "it’ll" : "they’ll"} be lost.`
      : `Kanbo couldn’t save ${n} just now. Try again, or stay signed in and Kanbo will retry when you reconnect or press Retry now. Signing out now discards ${one ? "it" : "them"}.`;

  return (
    <div className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 200, background: "color-mix(in oklch, var(--bg-deep) 62%, transparent)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18, overflowY: "auto" }}>
      <div ref={trapRef} role="alertdialog" aria-modal="true" aria-labelledby="kanbo-unsynced-title" aria-describedby="kanbo-unsynced-body" className="glass anim-scalein"
        style={{ width: 420, maxWidth: "94vw", borderRadius: 20, padding: 26, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <span style={{ display: "inline-grid", placeItems: "center", width: 42, height: 42, borderRadius: 13, marginBottom: 14, background: showSyncing ? "var(--accent-dim)" : "color-mix(in oklch, var(--prio-high) 18%, transparent)", color: showSyncing ? "var(--accent)" : "var(--prio-high)" }}>
          <Icon name={showSyncing ? "refresh" : "clock"} size={20} />
        </span>
        <h2 id="kanbo-unsynced-title" style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>{title}</h2>
        <p id="kanbo-unsynced-body" aria-live="polite" style={{ fontSize: 14, color: "var(--ink-3)", lineHeight: 1.55, margin: "0 0 20px" }}>{body}</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <button autoFocus onClick={onStay} className="btn btn-accent" style={{ flex: 1, minWidth: 150, justifyContent: "center", padding: "11px 15px" }}>Stay signed in</button>
          {online && !syncing && (
            <button onClick={sync} className="btn btn-ghost" style={{ flex: 1, minWidth: 150, justifyContent: "center", padding: "11px 15px" }}>
              <Icon name="refresh" size={15} /> Try again
            </button>
          )}
          <button onClick={() => { finished.current = true; onSignOut(); }} className="btn btn-ghost" style={{ flex: "1 1 100%", justifyContent: "center", padding: "11px 15px", color: "var(--prio-urgent)" }}>
            Sign out and discard
          </button>
        </div>
      </div>
    </div>
  );
}

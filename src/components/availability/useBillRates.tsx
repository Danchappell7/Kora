/* ============================================================
   KANBO — Time & billing's rates (0055). Once 0055 is run, a team's
   rates are shared: a project's own, else the workspace's default,
   read and set by its owners and admins; members see hours only.
   Before it (and in Personal) the rate is this device's, as it was.
   RateField: a £ field that saves on Enter or when you leave it.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { useToast } from "../Toast";
import { availabilityOn, canSeeRates, defaultRate, projectRate, rateFor } from "../../lib/availability";
import { saveRate } from "../../lib/availabilitySync";
import { useAvailability } from "./useAvailability";
import "./availability.css";

const LOCAL_KEY = "kanbo-bill-rate";
function useOptionalToast() { try { return useToast(); } catch { return null; } }

export interface BillRates {
  /** "local": this device's one rate (before 0055, or Personal); "shared": the team's; "hidden": a member's view */
  mode: "local" | "shared" | "hidden";
  /** the hourly rate for a project's time (0 when none) */
  rateFor: (projectId: string) => number;
  /** the rate everything falls back to: the device's, or the workspace's default */
  fallback: number;
  /** a project's own rate (shared only) */
  ownRate: (projectId: string) => number | null;
  setFallback: (n: number | null) => void;
  setProjectRate: (projectId: string, n: number | null) => void;
  /** some project has a rate of its own */
  mixed: boolean;
}

export function useBillRates(): BillRates {
  const s = useAvailability();
  const toast = useOptionalToast();
  const ws = s.activeWs;
  const [local, setLocal] = useState<number>(() => { try { return Number(localStorage.getItem(LOCAL_KEY)) || 0; } catch { return 0; } });
  const shared = availabilityOn(s) && !!ws;
  const mode = !shared ? "local" : canSeeRates(ws, s) ? "shared" : "hidden";
  const save = (projectId: string | null, n: number | null) => {
    if (!ws) return;
    void saveRate(ws, projectId, n == null || !(n >= 0) ? null : n).then((r) => { if (!r.ok) toast?.error(r.message); });
  };
  return {
    mode,
    rateFor: (pid) => (mode === "local" ? local : mode === "shared" ? rateFor(ws, pid, s) : 0),
    fallback: mode === "local" ? local : mode === "shared" ? defaultRate(ws, s) ?? 0 : 0,
    ownRate: (pid) => (mode === "shared" ? projectRate(ws, pid, s) : null),
    setFallback: (n) => {
      if (mode === "local") { const v = n ?? 0; setLocal(v); try { localStorage.setItem(LOCAL_KEY, String(v)); } catch { /* private mode */ } }
      else if (mode === "shared") save(null, n);
    },
    setProjectRate: (pid, n) => { if (mode === "shared") save(pid, n); },
    mixed: mode === "shared" && s.rates.some((r) => r.workspaceId === ws && r.projectId !== null),
  };
}

/** A £-an-hour field: saves the typed rate on Enter or when you leave it (blank clears it). */
export function RateField({ value, label, placeholder, onCommit, size }: {
  value: number | null;
  label: string;
  placeholder?: string;
  onCommit: (n: number | null) => void;
  size?: "sm";
}) {
  const shown = value == null || value === 0 ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  const typed = useRef(false);
  useEffect(() => { if (!typed.current) setDraft(shown); }, [shown]);
  const commit = () => {
    if (!typed.current) return;
    typed.current = false;
    const t = draft.trim();
    const n = t === "" ? null : Number(t);
    if (n != null && !(n >= 0 && n <= 100000)) { setDraft(shown); return; }
    if ((n ?? 0) === (value ?? 0)) return;
    onCommit(n);
  };
  return (
    <span className="kav-rate-field" data-size={size}>
      <span aria-hidden="true">£</span>
      <input type="number" min={0} step="0.01" inputMode="decimal" aria-label={label} value={draft} placeholder={placeholder ?? "0"}
        onChange={(e) => { typed.current = true; setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } else if (e.key === "Escape") { typed.current = false; setDraft(shown); } }} />
    </span>
  );
}

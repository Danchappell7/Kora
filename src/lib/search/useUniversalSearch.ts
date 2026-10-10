/* ============================================================
   KANBO — one search, two sources: what's on the device answers at
   once (localSearch), the server's search_all follows after a short
   pause (debounced, a newer keystroke cancels the older request), and
   only an answer for the CURRENT words and filters is ever used.
   No server (demo mode), offline, or a database without 0048
   ("unavailable", remembered for the session) → the device's answer is
   the whole answer, and `reason` says why, quietly.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchFailure, SearchFilters, SearchHit, SearchHitKind } from "../../data/types";
import { isAbort, localSearch, searchAll, searchFailure, type LocalSearchInput } from "../searchApi";
import { supabase } from "../supabase";

export type SearchPhase = "idle" | "searching" | "done";
/** why only the device answered */
export type LocalReason = "demo" | "offline" | "unavailable" | "not_allowed" | "error" | null;

export interface UniversalSearchArgs {
  /** false: nothing to search (no words, no filters) */
  active: boolean;
  text: string;
  filters: SearchFilters;
  /** what's on hand for the instant answer */
  local: Omit<LocalSearchInput, "text" | "filters" | "limit">;
  /** the kinds the device answers for (default: every kind asked); e.g. leave tasks to a host that lists them itself */
  localKinds?: SearchHitKind[];
  /** per kind: the device's cap and search_all's lim */
  limit: number;
  debounceMs: number;
  /** override (tests); default: a Supabase client is configured */
  server?: boolean;
}
export interface UniversalSearchResult {
  local: SearchHit[];
  /** the server's hits for the current search (null: not asked, or not back yet) */
  server: SearchHit[] | null;
  phase: SearchPhase;
  reason: LocalReason;
}

let serverMissing = false;
/** (tests) forget that search_all was missing */
export function resetSearchServerMemory(): void { serverMissing = false; }

const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

export function useUniversalSearch(a: UniversalSearchArgs): UniversalSearchResult {
  const key = useMemo(() => JSON.stringify([a.text.trim(), a.filters, a.limit]), [a.text, a.filters, a.limit]);
  const localKindsKey = a.localKinds?.join(",") ?? "";
  const local = useMemo<SearchHit[]>(() => {
    if (!a.active) return [];
    const asked = a.filters.kinds ?? ["task", "comment", "doc", "project", "person"];
    const kinds = a.localKinds ? asked.filter((k) => a.localKinds!.includes(k)) : asked;
    if (!kinds.length) return [];
    return localSearch({ ...a.local, text: a.text, filters: { ...a.filters, kinds }, limit: a.limit });
    // the local inputs are arrays the host keeps stable between renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.active, key, localKindsKey, a.local.tasks, a.local.projects, a.local.members, a.local.comments, a.local.docs, a.local.currentUserId]);

  const wantServer = a.server ?? !!supabase;
  const [answer, setAnswer] = useState<{ key: string; hits: SearchHit[] } | null>(null);
  const [failure, setFailure] = useState<{ key: string; reason: LocalReason } | null>(null);
  const [online, setOnline] = useState(isOnline);
  const latest = useRef(key);
  latest.current = key;

  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  const canAsk = a.active && wantServer && online && !serverMissing;
  useEffect(() => {
    if (!canAsk) return;
    const ac = new AbortController();
    const forKey = key;
    const timer = window.setTimeout(() => {
      searchAll(a.text, a.filters, { limit: a.limit, signal: ac.signal }).then(
        (hits) => { if (latest.current === forKey) { setAnswer({ key: forKey, hits }); setFailure(null); } },
        (e: unknown) => {
          if (isAbort(e) || latest.current !== forKey) return;
          const f: SearchFailure = searchFailure(e);
          if (f === "unavailable") serverMissing = true;
          setFailure({ key: forKey, reason: f === "network" ? "offline" : f === "invalid" ? "error" : f });
        },
      );
    }, a.debounceMs);
    return () => { window.clearTimeout(timer); ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAsk, key, a.debounceMs]);

  const server = answer?.key === key ? answer.hits : null;
  const failed = failure?.key === key ? failure.reason : null;
  const reason: LocalReason = !a.active ? null
    : !wantServer ? "demo"
    : !online ? "offline"
    : serverMissing && !server ? "unavailable"
    : failed;
  const phase: SearchPhase = !a.active ? "idle" : server || reason ? "done" : "searching";
  return { local, server: reason ? null : server, phase, reason };
}

/** Words for why the answer came from the device alone (quiet, one line). */
export function localReasonText(reason: LocalReason): string | null {
  switch (reason) {
    case "demo": return "Demo mode: searching on this device";
    case "offline": return "You're offline: showing what's on this device";
    case "unavailable": return "Full-text search isn't switched on yet: showing what's on this device";
    case "not_allowed": return "Search isn't available to your account right now";
    case "error": return "Couldn't reach search: showing what's on this device";
    default: return null;
  }
}

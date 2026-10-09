/* ============================================================
   KANBO — signed links for the board's cover images.
   A card's cover is one of its task's own image files
   (tasks.cover_attachment_id). The page may hand the links in
   (coverUrls); otherwise the board fetches them itself, only for the
   tasks that have a cover, in batches, and re-signs them before the
   hour-long links lapse (as the Files view does). The demo's seeded
   covers need no fetch.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import { store } from "../../data/store";
import { reportError } from "../../lib/monitoring";
import { chunk } from "../tasks/otherViewsLogic";
import { demoCoverUrls, effectiveCoverId } from "./boardDemo";
import type { Task } from "../../data/types";

const ID_CHUNK = 80;                       // task ids per request
const RESIGN_MS = 45 * 60 * 1000;          // links last an hour; re-sign well before
const EMPTY: Record<string, string> = Object.freeze({}) as Record<string, string>;

/** attachment id → image URL for every cover the board shows. */
export function useCoverUrls(tasks: readonly Pick<Task, "id" | "coverAttachmentId">[], given?: Record<string, string>): Record<string, string> {
  const demo = useMemo(demoCoverUrls, []);
  // the covers we still need a link for, as "taskId:attachmentId" (sorted, so re-ordering never refetches)
  const wantKey = useMemo(() => {
    const out: string[] = [];
    for (const t of tasks) {
      const id = effectiveCoverId(t);
      if (id && !demo[id] && !given?.[id]) out.push(`${t.id}:${id}`);
    }
    return out.sort().join(",");
  }, [tasks, given, demo]);
  const [fetched, setFetched] = useState<Record<string, string>>(EMPTY);
  const [tick, setTick] = useState(0);
  const req = useRef(0);

  useEffect(() => {
    if (!wantKey) return;
    const pairs = wantKey.split(",").map((p) => p.split(":") as [string, string]);
    const wanted = new Set(pairs.map(([, a]) => a));
    const n = ++req.current;
    Promise.all(chunk([...new Set(pairs.map(([t]) => t))], ID_CHUNK).map((ids) => store.listProjectAttachments(ids)))
      .then((parts) => {
        if (n !== req.current) return;
        const next: Record<string, string> = {};
        for (const a of parts.flat()) if (wanted.has(a.id) && a.url && a.mime?.startsWith("image/")) next[a.id] = a.url;
        setFetched((cur) => ({ ...cur, ...next }));
      })
      .catch((e) => { if (n === req.current) reportError(e, { op: "board-covers" }); });
  }, [wantKey, tick]);
  useEffect(() => () => { req.current++; }, []);

  // re-sign before the links lapse (checked each minute, and when the tab comes back)
  useEffect(() => {
    if (!wantKey) return;
    let at = Date.now();
    const check = () => {
      if (document.visibilityState === "visible" && Date.now() - at > RESIGN_MS) { at = Date.now(); setTick((x) => x + 1); }
    };
    const iv = window.setInterval(check, 60 * 1000);
    document.addEventListener("visibilitychange", check);
    return () => { window.clearInterval(iv); document.removeEventListener("visibilitychange", check); };
  }, [wantKey]);

  return useMemo(() => (Object.keys(fetched).length || given || Object.keys(demo).length ? { ...demo, ...fetched, ...(given ?? {}) } : EMPTY), [demo, fetched, given]);
}

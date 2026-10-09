/* ============================================================
   KANBO — the template library as React state (lib/templates).
   Loads when first needed (`enabled`), follows changes made in this
   tab (onLibraryChange), and says how the load went. The library
   itself falls back to the built-ins (and this browser's own
   templates) when offline or before 0048, so `templates` is only
   empty while the first load is on its way.
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryTemplate, TemplateFailure } from "../../data/types";

/* The library's code (lib/templates: the built-ins, the data, adoption) is fetched the first
   time it's wanted, so Quick capture and New task don't carry it in their own downloads. */
const loadLibrary = () => import("../../lib/templates");

export type LibraryStatus = "idle" | "loading" | "ready" | "error";

export interface LibraryState {
  templates: LibraryTemplate[];
  status: LibraryStatus;
  failure: TemplateFailure | null;
  reload: () => void;
}

export function useLibraryTemplates(workspaceId: string | null, enabled = true): LibraryState {
  const [templates, setTemplates] = useState<LibraryTemplate[]>([]);
  const [status, setStatus] = useState<LibraryStatus>("idle");
  const [failure, setFailure] = useState<TemplateFailure | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const mine = ++seq.current;
    let alive = true;
    setStatus((s) => (s === "ready" ? s : "loading"));
    loadLibrary().then((m) => m.listLibraryTemplates(workspaceId).then(
      (list) => { if (alive && mine === seq.current) { setTemplates(list); setStatus("ready"); setFailure(null); } },
      (e) => { if (alive && mine === seq.current) { setStatus("error"); setFailure(m.templateFailure(e)); } },
    ), () => { if (alive && mine === seq.current) { setStatus("error"); setFailure("network"); } });
    return () => { alive = false; };
  }, [workspaceId, enabled, tick]);

  useEffect(() => {
    if (!enabled) return;
    let off: (() => void) | null = null, gone = false;
    loadLibrary().then((m) => { if (!gone) off = m.onLibraryChange(reload); }, () => undefined);
    return () => { gone = true; off?.(); };
  }, [enabled, reload]);

  return { templates, status, failure, reload };
}

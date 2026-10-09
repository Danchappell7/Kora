/* ============================================================
   KANBO — what search reads on the device in demo mode, beyond the
   tasks and projects the app holds: the demo docs with their text
   (lib/docs' in-memory docs, so a search finds "£12 a seat" in the
   Decision log) and every comment the demo store has. Loaded once, on
   demand, through dynamic imports (never in the first download).
   DEMO_SEARCH_COMMENTS: realistic threads on the demo tasks for the
   integrator to seed into the demo store, so a comment search and the
   task panel always show the same comments (search never invents any).
   ============================================================ */
import { useEffect, useState } from "react";
import type { Comment, DocBlock, ProjectDoc, ProjectDocListItem } from "../../data/types";
import type { LocalSearchInput } from "../searchApi";

export type LocalDoc = NonNullable<LocalSearchInput["docs"]>[number];

/** A doc's text as search reads it: each block's spans, one line per block (as project_docs.plain_text). */
export function docPlainText(body: readonly DocBlock[] | null | undefined): string {
  return (body ?? [])
    .map((b) => (b.spans ?? []).map((s) => s.text ?? "").join(""))
    .filter((line) => line.trim())
    .join("\n")
    .slice(0, 200_000);
}

export interface CorpusDeps {
  listProjectDocs: (projectId: string) => Promise<ProjectDocListItem[]>;
  getProjectDoc: (docId: string) => Promise<ProjectDoc | null>;
  listComments: (taskId: string) => Promise<Comment[]>;
}

/** The demo docs (with text) of these projects and the comments on these tasks. Never throws. */
export async function loadDemoCorpus(projectIds: readonly string[], taskIds: readonly string[], deps?: Partial<CorpusDeps>): Promise<{ docs: LocalDoc[]; comments: Comment[] }> {
  const d: CorpusDeps = {
    listProjectDocs: deps?.listProjectDocs ?? (async (id) => (await import("../docs")).listProjectDocs(id)),
    getProjectDoc: deps?.getProjectDoc ?? (async (id) => (await import("../docs")).getProjectDoc(id)),
    listComments: deps?.listComments ?? (async (id) => (await import("../../data/store")).store.listComments(id)),
  };
  const docs: LocalDoc[] = [];
  await Promise.all(projectIds.map(async (pid) => {
    try {
      const items = await d.listProjectDocs(pid);
      const full = await Promise.all(items.map((it) => d.getProjectDoc(it.id).catch(() => null)));
      for (const doc of full) {
        if (!doc) continue;
        docs.push({
          id: doc.id, projectId: doc.projectId, title: doc.title, workspaceId: doc.workspaceId, text: docPlainText(doc.body),
          icon: doc.icon, archived: !!doc.archivedAt, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy,
        });
      }
    } catch { /* a project without docs, or none to read */ }
  }));
  const comments: Comment[] = [];
  const lists = await Promise.all(taskIds.map((id) => d.listComments(id).catch(() => [] as Comment[])));
  for (const l of lists) comments.push(...l);
  return { docs, comments };
}

/** The demo corpus, loaded once when `enabled` (demo mode), refreshed when the search box is next used. */
export function useDemoCorpus(enabled: boolean, projectIds: readonly string[], taskIds: readonly string[], refreshKey = 0): { docs: LocalDoc[]; comments: Comment[] } | null {
  const [corpus, setCorpus] = useState<{ docs: LocalDoc[]; comments: Comment[] } | null>(null);
  const pKey = projectIds.join(","), tKey = taskIds.length;
  useEffect(() => {
    if (!enabled) { setCorpus(null); return; }
    let live = true;
    void loadDemoCorpus(projectIds, taskIds).then((c) => { if (live) setCorpus(c); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pKey, tKey, refreshKey]);
  return corpus;
}

/* ------------------------------------------------------------------ demo threads (for the integrator to seed) */

const minutesAgo = (now: number, m: number) => new Date(now - m * 60_000).toISOString();

/** Comment threads on the demo tasks (t-1 … t-30 in data.ts), newest last, timed relative to `now`. */
export function demoSearchComments(now: number = Date.now()): Comment[] {
  const c = (id: string, taskId: string, authorId: string, authorName: string, body: string, ago: number, mentions: string[] = []): Comment =>
    ({ id, taskId, authorId, authorName, body, createdAt: minutesAgo(now, ago), mentions });
  return [
    c("dc-1", "t-1", "m-1", "Maya Lin", "Can we move the pricing table to slide 3? It lands better straight after the traction chart.", 60 * 26),
    c("dc-2", "t-1", "m-self", "Daniel Okai", "Good call. I'll also cut the competitor slide so we stay at 14.", 60 * 25),
    c("dc-3", "t-1", "m-3", "Sana Rao", "Brand colours on the cover are the old palette. New tokens are in review, I'll swap them once they're approved.", 60 * 5),
    c("dc-4", "t-1", "m-2", "Theo Vance", "@Daniel the demo video link for slide 9 is in the launch brief.", 42, ["m-self"]),
    c("dc-5", "t-2", "m-1", "Maya Lin", "Blocked on the design tokens v2. Everything else is merged and waiting in staging.", 60 * 30),
    c("dc-6", "t-2", "m-3", "Sana Rao", "Tokens should land in review tomorrow morning; I'll ping you when they do.", 60 * 20),
    c("dc-7", "t-3", "m-2", "Theo Vance", "Variant B drops the annual toggle. Pricing stays at £12 a seat for both arms.", 60 * 50),
    c("dc-8", "t-4", "m-self", "Daniel Okai", "Naming looks great. Can we keep the spacing scale on a 4px base?", 60 * 8),
    c("dc-9", "t-10", "m-1", "Maya Lin", "Events for sign-up and first project are firing; checkout events still to do.", 60 * 70),
    c("dc-10", "t-25", "m-3", "Sana Rao", "The FAQ still mentions the old monthly price. Needs updating before the launch emails go out.", 60 * 3),
  ];
}

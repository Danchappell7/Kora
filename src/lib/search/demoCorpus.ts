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

/** Comment threads on the demo tasks (t-1 … t-30 in data.ts), oldest first in each, timed relative to `now`.
 *  Exactly as many on each task as its `comments` count says, so seeding them changes no number on screen. */
export function demoSearchComments(now: number = Date.now()): Comment[] {
  const c = (id: string, taskId: string, authorId: string, authorName: string, body: string, ago: number, mentions: string[] = []): Comment =>
    ({ id, taskId, authorId, authorName, body, createdAt: minutesAgo(now, ago), mentions });
  const D = "Daniel Okai", M = "Maya Lin", T = "Theo Vance", S = "Sana Rao";
  return [
    // t-1 Finalise Q3 launch narrative deck (4)
    c("dc-1", "t-1", "m-1", M, "Can we move the pricing table to slide 3? It lands better straight after the traction chart.", 60 * 26),
    c("dc-2", "t-1", "m-self", D, "Good call. I'll also cut the competitor slide so we stay at 14.", 60 * 25),
    c("dc-3", "t-1", "m-3", S, "The cover still uses the old palette. The new tokens are in review; I'll swap them once they're approved.", 60 * 5),
    c("dc-4", "t-1", "m-2", T, "@Daniel the demo video link for slide 9 is in the launch brief.", 42, ["m-self"]),
    // t-2 Ship onboarding redesign to staging (2)
    c("dc-5", "t-2", "m-1", M, "Blocked on design tokens v2. Everything else is merged and waiting in staging.", 60 * 30),
    c("dc-6", "t-2", "m-3", S, "Tokens should be in review tomorrow morning; I'll ping you when they land.", 60 * 20),
    // t-3 Run pricing-page A/B test (1)
    c("dc-7", "t-3", "m-2", T, "Variant B drops the annual toggle. Pricing stays at £12 a seat for both arms.", 60 * 50),
    // t-4 Define design tokens v2 (6)
    c("dc-8", "t-4", "m-3", S, "First pass is up: colour, spacing and radius tokens, named by role rather than by value.", 60 * 72),
    c("dc-9", "t-4", "m-self", D, "Naming reads well. Can we keep the spacing scale on a 4px base?", 60 * 48),
    c("dc-10", "t-4", "m-3", S, "Yes: 4, 8, 12, 16, 24, 32. I've dropped the 6px step nobody used.", 60 * 46),
    c("dc-11", "t-4", "m-1", M, "The muted text colour fails contrast on the sidebar in dark mode. Could it go a step lighter?", 60 * 30),
    c("dc-12", "t-4", "m-3", S, "Fixed, it's 4.8:1 now on every surface. Updated the colour sheet too.", 60 * 28),
    c("dc-13", "t-4", "m-self", D, "Looks great. Approving once the pricing page mock picks them up.", 60 * 4),
    // t-6 Migrate auth to edge sessions (3)
    c("dc-14", "t-6", "m-1", M, "Sessions now refresh at the edge; the 15-minute token lifetime holds up in testing.", 60 * 52),
    c("dc-15", "t-6", "m-2", T, "Load test next: I'll point 2,000 virtual users at staging tomorrow.", 60 * 30),
    c("dc-16", "t-6", "m-1", M, "Rollout plan: 5% on Monday, everyone by Thursday if the error rate stays flat.", 60 * 6),
    // t-8 Fix flaky CI on macOS runners (1)
    c("dc-17", "t-8", "m-2", T, "It's the simulator boot timing out. A retry wrapper on that one step should do it.", 60 * 96),
    // t-9 New homepage hero illustration (2)
    c("dc-18", "t-9", "m-3", S, "Two directions in the brand folder: the calm desk scene, and the busier team one.", 60 * 70),
    c("dc-19", "t-9", "m-self", D, "The desk scene, please. It matches the launch narrative better.", 60 * 66),
  ];
}

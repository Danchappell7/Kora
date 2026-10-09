/* ============================================================
   KANBO — a doc @mention in the Inbox: where it opens, and which
   workspace's Inbox it belongs in. Its own module (lib/docs re-exports
   it) so the shell can sort the Inbox without loading the docs code.
   ============================================================ */
import type { Activity } from "../data/types";

/** The doc a doc_mention opens: /p/:projectId/docs/:docId (null for anything else). */
export function docMentionRoute(a: Pick<Activity, "kind" | "meta">): { view: "project"; projectId: string; tab: "docs"; docId: string } | null {
  if (a.kind !== "doc_mention" || !a.meta?.docId || !a.meta.projectId) return null;
  return { view: "project", projectId: a.meta.projectId, tab: "docs", docId: a.meta.docId };
}

/** Does a doc_mention belong in this workspace's Inbox? (Its project's workspace; null = Personal.) A project
 *  you can't see here (another workspace, or gone) keeps it out. */
export function docMentionInWorkspace(a: Pick<Activity, "kind" | "meta">, projects: readonly { id: string; workspaceId?: string | null }[], workspaceId: string | null): boolean {
  const r = docMentionRoute(a);
  if (!r) return false;
  const p = projects.find((x) => x.id === r.projectId);
  return !!p && (p.workspaceId ?? null) === workspaceId;
}

// ============================================================
// KANBO — Slack and project access (0058).                       [w4]
//
// A Slack channel is a team channel: everyone in it reads what's posted,
// whoever posted it. So with Project access switched on, only Whole
// workspace projects are posted or stood up there with their titles; a
// Members only or Private one isn't (D18). Before 0058, or with the switch
// off, every project is open, as today.
//
//   statusPostProject   slack-post's post_status: the project, read AS the
//                       person posting (RLS: a project they can't see isn't
//                       there), then is it open to the whole channel?
//   splitStandupTasks   slack-standup: the stand-up's tasks, and the ones in
//                       projects that aren't open (counted, never named)
//   standupAudienceCheck slack-post's post_standup and post_risks: the app
//                       builds that text itself, and only an app from wave 4
//                       on leaves out Members only and Private work. It says
//                       so ({audience: "open"}); a tab opened before then
//                       doesn't, so where the switch is on it's asked to
//                       reload instead of posting a list of every task it saw
//
// Pure (no Deno globals, no remote imports): vitest runs it (slackAccess.test.ts).
// ============================================================
import { AccessLookupFailed, type ProjectAccess } from "./projectAccess.ts";

/** What slack-post says when the project isn't open to the whole workspace. */
export const PRIVATE_PROJECT_COPY = "This project is private, so it isn't posted to the team channel.";

/** A supabase-js client signed in as the person (RLS applies). */
// deno-lint-ignore no-explicit-any
export type UserTableDb = { from(table: string): any };

export type StatusPostCheck =
  | { ok: true; projectName: string | undefined }
  | { ok: false; status: 400 | 403 | 404 | 503; reason: "invalid" | "private_project" | "unavailable"; error: string };

/** post_status: the project as the person posting sees it, and whether the team channel may name it. */
export async function statusPostProject(asUser: UserTableDb, access: ProjectAccess, workspaceId: string, projectId: string): Promise<StatusPostCheck> {
  const { data: p, error } = await asUser.from("projects").select("id,name,workspace_id").eq("id", projectId).maybeSingle();
  if (error) return { ok: false, status: 503, reason: "unavailable", error: "Couldn't read that project. Try again." };
  // not there, or they can't see it (RLS): the same answer, so nothing is given away
  if (!p) return { ok: false, status: 404, reason: "invalid", error: "That project couldn't be found." };
  if (String(p.workspace_id ?? "") !== workspaceId) return { ok: false, status: 400, reason: "invalid", error: "That project isn't in this workspace." };
  let open: boolean;
  try { open = await access.projectIsOpen(workspaceId, String(p.id)); } catch (e) {
    if (!(e instanceof AccessLookupFailed)) throw e;
    return { ok: false, status: 503, reason: "unavailable", error: "Couldn't check who can see this project. Try again." };
  }
  if (!open) return { ok: false, status: 403, reason: "private_project", error: PRIVATE_PROJECT_COPY };
  return { ok: true, projectName: p.name ?? undefined };
}

/** What slack-post says to a tab too old to know which work stays out of the team channel. */
export const RELOAD_TO_POST_COPY = "Reload Kanbo to post to Slack.";
/** What the app (wave 4 on) sends with post_standup and post_risks: its text leaves out work in projects that aren't open. */
export const STANDUP_AUDIENCE = "open";

export type StandupAudienceCheck = { ok: true } | { ok: false; status: 409 | 503; reason: "invalid" | "unavailable"; error: string };

/**
 * post_standup / post_risks: may this text go to the team channel? It always may when the app says it
 * left closed work out (`audience` is STANDUP_AUDIENCE), and before 0058 or with the switch off (every
 * project is open). Otherwise the text is from a tab opened before wave 4, built from every task it
 * could see: refused with 409 "invalid" and RELOAD_TO_POST_COPY (the only reason an old tab shows the
 * server's own sentence for). `admin` reads workspaces with the service role.
 */
export async function standupAudienceCheck(admin: UserTableDb, workspaceId: string, audience: unknown): Promise<StandupAudienceCheck> {
  if (audience === STANDUP_AUDIENCE) return { ok: true };
  const { data, error } = await admin.from("workspaces").select("project_access").eq("id", workspaceId).maybeSingle();
  if (error) {
    // before 0058 there's no switch: everything's open, as today
    const e = error as { code?: string; message?: string };
    if (e.code === "42703" || e.code === "PGRST204" || /does not exist|schema cache/i.test(e.message ?? "")) return { ok: true };
    return { ok: false, status: 503, reason: "unavailable", error: "Couldn't check who can see this workspace's projects. Try again." };
  }
  if ((data as { project_access?: unknown } | null)?.project_access === true) return { ok: false, status: 409, reason: "invalid", error: RELOAD_TO_POST_COPY };
  return { ok: true };
}

/**
 * The stand-up's tasks split by `closed` (closed_project_ids, lower case): the ones it may name, and the
 * ones in Members only and Private projects, which it only counts. A task with no real project is open.
 */
export function splitStandupTasks<T extends { project_id?: string | null }>(tasks: readonly T[], closed: ReadonlySet<string>): { open: T[]; hidden: T[] } {
  const open: T[] = [], hidden: T[] = [];
  for (const t of tasks) (closed.has(String(t.project_id ?? "").toLowerCase()) ? hidden : open).push(t);
  return { open, hidden };
}

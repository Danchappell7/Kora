/* ============================================================
   KANBO — your project updates for Today (0053). Only a project's
   OWNER hears about its update: on its update day and the two working
   days after (lib/updateRhythm), or when a lead has asked for one and
   nothing's been posted since (lib/updateAsks). Today turns these
   into one line under the brief and one "Kanbo noticed" nudge, each
   opening the update with Kanbo's draft ready to post.
   Archived and on-hold projects, Personal, and projects with no
   update day are left out. Pure: no React, no clock of its own.
   ============================================================ */
import type { Project, StatusUpdate, Task, UpdateAsk, Workspace } from "../data/types";
import { getMember, toLocalISO } from "../data/data";
import { indexTasks, projectUpdates, statusFacts } from "./statusDraft";
import { dueDayWords, isPaused, projectRhythmState, type RhythmState } from "./updateRhythm";
import { asksAwaiting } from "./updateAsks";
import type { Noticed } from "./noticed";

export interface DueUpdate {
  project: Project;
  /** due: its update day (or a follow-up day) · asked: a lead asked, and nothing's been posted since */
  reason: "due" | "asked";
  state: RhythmState | null;
  /** the lead's ask, when there is one */
  ask?: UpdateAsk;
  /** this week's changes: what Kanbo drafts it from */
  changes: number;
}

export interface DueInput {
  me: string;
  /** the projects Today covers (this workspace's, or every business's) */
  projects: readonly Project[];
  tasks: readonly Task[];
  statusUpdates: readonly StatusUpdate[];
  asks: readonly UpdateAsk[];
  today: Date;
  workspaces?: readonly Workspace[];
}

/** Your updates to write today: due ones (the longest-waiting first), then asked-for ones. */
export function dueUpdatesFor({ me, projects, tasks, statusUpdates, asks, today, workspaces }: DueInput): DueUpdate[] {
  const idx = indexTasks(tasks as Task[]);
  const latestOf = (pid: string) => projectUpdates(statusUpdates as StatusUpdate[], pid)[0];
  const awaiting = asksAwaiting(asks, me, latestOf);
  const out: DueUpdate[] = [];
  for (const p of projects) {
    if (p.ownerId !== me || !p.workspaceId || p.id === "p-personal" || p.archivedAt) continue;
    const latest = latestOf(p.id);
    if (isPaused(p, latest)) continue;
    const state = projectRhythmState(p, idx.byProject.get(p.id) ?? [], latest, today, workspaces);
    const ask = awaiting.find((a) => a.projectId === p.id);
    if (state?.kind !== "due" && !ask) continue;
    const changes = statusFacts(p, tasks as Task[], statusUpdates as StatusUpdate[], today, idx).changes;
    out.push({ project: p, reason: state?.kind === "due" ? "due" : "asked", state, ...(ask ? { ask } : {}), changes });
  }
  const followUp = (d: DueUpdate) => (d.state?.kind === "due" ? d.state.followUp : -1);
  return out.sort((a, b) => (a.reason === b.reason ? 0 : a.reason === "due" ? -1 : 1) || followUp(b) - followUp(a)
    || a.project.name.localeCompare(b.project.name, "en-GB", { sensitivity: "base" }));
}

const firstName = (id?: string) => (id ? getMember(id)?.name?.trim().split(/\s+/)[0] : undefined) || "A lead";
const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** When it was (or is) due, in words: "today", "Fri 6 Nov". */
export function dueWhen(d: DueUpdate, today: Date): string {
  return d.state?.kind === "due" ? dueDayWords(d.state.due, toLocalISO(today)) : "today";
}

/** The sentence after the project names, for one update: "is due today." / "was due Fri 6 Nov." */
export function dueVerb(d: DueUpdate, today: Date): string {
  if (d.reason === "asked") return "";
  const when = dueWhen(d, today);
  return when === "today" ? "is due today" : `was due ${when}`;
}

/** What Kanbo drafts it from: "Kanbo has drafted it from this week's 7 changes." */
export function draftedFrom(items: readonly DueUpdate[]): string {
  if (items.length > 1) return "Kanbo has drafts ready.";
  const n = items[0]?.changes ?? 0;
  return n > 0 ? `Kanbo has drafted it from this week's ${n === 1 ? "1 change" : `${n} changes`}.` : "Kanbo has a draft ready.";
}

/** The one "Kanbo noticed" nudge about them (none when there's nothing due or asked). */
export function updateNoticed(items: readonly DueUpdate[], today: Date): Noticed[] {
  if (!items.length) return [];
  const first = items[0];
  const title = items.length > 1
    ? `${items.length} project updates are waiting on you`
    : first.reason === "asked" ? `${firstName(first.ask?.askedBy)} asked for an update on ${first.project.name}`
    : `Your ${first.project.name} update ${dueVerb(first, today)}`;
  const body = items.length > 1
    ? `${listWords(items.map((d) => d.project.name))}. ${draftedFrom(items)} Each takes a minute to check.`
    : `${draftedFrom(items)} Check it, change what you like, and post.`;
  return [{
    // (stable for the day's set, so "Not now" keeps it away until something new is due or asked)
    id: `update:${items.map((d) => `${d.project.id}:${d.reason === "asked" ? d.ask?.id : d.state?.kind === "due" ? d.state.due : ""}`).join(",")}`,
    kind: "update", tone: "accent", icon: "notes",
    title, body,
    actions: [{ kind: "update", label: items.length > 1 ? `Start with ${first.project.name}` : "Review and post", projectId: first.project.id }],
  }];
}

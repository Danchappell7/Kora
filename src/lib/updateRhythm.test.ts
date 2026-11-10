/* lib/updateRhythm: a project's update day as the app reads it (its own, its workspace's, or Friday),
   where its update stands, and the one word a table shows for it. Before 0053: the 14-day rule. */
import { describe, it, expect, afterEach } from "vitest";
import type { Project, StatusUpdate, Task, Workspace } from "../data/types";
import {
  isPaused, noteRhythmSchema, ownRhythm, projectRhythm, projectRhythmState, resetRhythmSchema, rhythmOn, rhythmToSave, startedOn, updateFreshness, workspaceRhythm,
} from "./updateRhythm";

const FRI = new Date(2026, 10, 13);        // Friday 13 Nov 2026
const WS: Workspace[] = [
  { id: "w-a", name: "Alpha", kind: "team", updateRhythm: { cadence: "monthly", weekday: 5 } },
  { id: "w-b", name: "Beta", kind: "team" },
];
const proj = (o: Partial<Project> = {}): Project => ({ id: "p1", name: "Launch", emoji: "", color: "", workspaceId: "w-b", ...o });
const task = (o: Partial<Task> = {}): Task => ({
  id: "t1", title: "x", description: "", status: "todo", priority: "medium", projectId: "p1", assigneeId: "m", tags: [], dependencies: [], subtasks: [],
  focusMin: 30, comments: 0, aiScore: 0, createdAt: "2026-09-01T09:00:00", ...o,
});
const upd = (createdAt: string, status: StatusUpdate["status"] = "on_track"): StatusUpdate => ({ id: "u", projectId: "p1", summary: "", status, createdAt });

afterEach(() => resetRhythmSchema());

describe("a project's rhythm", () => {
  it("its own, else its workspace's, else weekly on Friday; none in Personal", () => {
    expect(projectRhythm(proj({ updateRhythm: { cadence: "never", weekday: 5 } }), WS)?.cadence).toBe("never");
    expect(projectRhythm(proj({ workspaceId: "w-a" }), WS)).toEqual({ cadence: "monthly", weekday: 5 });
    expect(projectRhythm(proj(), WS)).toEqual({ cadence: "weekly", weekday: 5 });
    expect(projectRhythm(proj({ workspaceId: null }), WS)).toBeNull();
    expect(workspaceRhythm(undefined)).toEqual({ cadence: "weekly", weekday: 5 });
    expect(ownRhythm(proj({ updateRhythm: { cadence: "weekly", weekday: 2 } }))).toBe(true);
    expect(ownRhythm(proj())).toBe(false);
  });
  it("is off before 0053 (the load didn't see the column), on in the demo", () => {
    expect(rhythmOn()).toBe(true);
    noteRhythmSchema(false);
    expect(rhythmOn()).toBe(false);
    expect(projectRhythm(proj(), WS)).toBeNull();
  });
  it("on hold or archived is paused; so is a project whose latest update says On hold", () => {
    expect(isPaused(proj({ status: "on_hold" }))).toBe(true);
    expect(isPaused(proj({ archivedAt: "2026-11-01" }))).toBe(true);
    expect(isPaused(proj(), { status: "on_hold" })).toBe(true);
    expect(isPaused(proj(), { status: "at_risk" })).toBe(false);
  });
  it("starts the day its first task was added (a task that doesn't say counts as long ago)", () => {
    expect(startedOn([task({ createdAt: "2026-11-02T10:00:00" }), task({ id: "t2", createdAt: "2026-10-20T10:00:00" })], "p1")).toBe("2026-10-20");
    expect(startedOn([task({ createdAt: undefined })], "p1")).toBe("1970-01-01");
    expect(startedOn([task({ projectId: "p2" })], "p1")).toBeNull();
  });
  it("reads where the update stands on the day", () => {
    expect(projectRhythmState(proj(), [task()], upd("2026-11-07T10:00:00"), FRI, WS)).toMatchObject({ kind: "ok" });
    expect(projectRhythmState(proj(), [task()], upd("2026-11-03T10:00:00"), FRI, WS)).toMatchObject({ kind: "due", due: "2026-11-13", followUp: 0 });
    expect(projectRhythmState(proj(), [task()], upd("2026-11-03T10:00:00", "on_hold"), FRI, WS)).toEqual({ kind: "off", why: "paused" });
  });
  it("fortnightly keeps its anchor while the day stays the same, and starts from the next such day otherwise", () => {
    expect(rhythmToSave({ cadence: "fortnightly", weekday: 5, anchor: "2026-10-30" }, FRI)).toEqual({ cadence: "fortnightly", weekday: 5, anchor: "2026-10-30" });
    expect(rhythmToSave({ cadence: "fortnightly", weekday: 2, anchor: "2026-10-30" }, FRI)).toEqual({ cadence: "fortnightly", weekday: 2, anchor: "2026-11-17" });
    expect(rhythmToSave({ cadence: "weekly", weekday: 3, anchor: "2026-10-30" }, FRI)).toEqual({ cadence: "weekly", weekday: 3 });
  });
});

describe("the one word a table shows", () => {
  const today = "2026-11-13";
  it("Update missing past the day and its follow-ups (or when the round before lapsed too)", () => {
    expect(updateFreshness({ kind: "missing", due: "2026-11-06" }, 12, false, today)).toMatchObject({ kind: "missing", text: "Update missing", tone: "warn", rank: 0, byDay: true,
      title: "Last update 12 days ago. One was due Fri 6 Nov." });
    expect(updateFreshness({ kind: "due", due: today, followUp: 0, lapsed: true }, null, false, today)).toMatchObject({ kind: "missing", text: "Update missing" });
  });
  it("Due today on the day, Due <day> on the follow-up days", () => {
    expect(updateFreshness({ kind: "due", due: today, followUp: 0, lapsed: false }, 9, false, today)).toMatchObject({ kind: "due", text: "Due today", rank: 1 });
    expect(updateFreshness({ kind: "due", due: "2026-11-12", followUp: 1, lapsed: false }, 9, false, today)).toMatchObject({ kind: "due", text: "Due yesterday" });
  });
  it("otherwise how long ago, with the next due day in its title", () => {
    expect(updateFreshness({ kind: "ok", next: "2026-11-20", due: today }, 2, false, today)).toMatchObject({ kind: "ok", text: "Updated 2d ago", short: "2d",
      title: "Last update 2 days ago. Next one due Fri 20 Nov." });
    expect(updateFreshness({ kind: "off", why: "never" }, null, true, today)).toMatchObject({ kind: "off", text: "No update yet", title: "No status update posted yet. This project has no update day." });
  });
  it("before 0053 (no rhythm): the 14-day rule", () => {
    expect(updateFreshness(null, 16, true, today)).toMatchObject({ kind: "missing", text: "No update in 14 days", short: "16d · stale", byDay: false });
    expect(updateFreshness(null, 3, false, today)).toMatchObject({ kind: "ok", text: "Updated 3d ago", byDay: false });
  });
});

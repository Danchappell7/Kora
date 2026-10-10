/* ============================================================
   0048 contracts: the final parts of the UX wave's foundation — row
   parsers fed the JSON the 0048 PGlite replay produced, the database's
   limits and messages, the drag-and-drop kit's surface, the notify prefs
   defaults, routes for saved views, the tour's anchors, and that every
   package's entry points exist. Packages: don't edit this file; it tests
   only what the architect marked [final].
   ============================================================ */
import { describe, expect, it } from "vitest";
import {
  BOARD_SETTINGS_MAX_BYTES, KUDOS_EMOJI, KUDOS_NOTE_MAX, KUDOS_PER_DAY, ONBOARDING_MAX_BYTES, SAVED_VIEW_LIMITS, SEARCH_LIMIT_MAX,
  SEARCH_MARK_END, SEARCH_MARK_START, SNOOZE_MAX_DAYS, SNOOZES_PER_PERSON, TEMPLATE_LIMITS, WIP_LIMIT_MAX,
  kudosFailure, parseBoardSettings, parseKudos, parseLibraryTemplate, parseOnboardingState, parseSavedView, parseSearchFilters,
  parseSearchHit, parseSnooze, parseTemplateBody, savedViewFailure, searchFailure, searchFiltersToRpc, splitHighlights, templateFailure,
} from "./rows0048";
import { parseActivityMeta } from "./activityMeta";
import * as dnd from "./dnd";
import { DEFAULT_DIGEST_TIME, DEFAULT_TIMEZONE, NOTIFY_KINDS, applyNotifyPrefsPatch, readNotifyPrefs } from "./notifyPrefs";
import { canEditView, canShareViews } from "./views";
import { SETUP_ITEMS, TOUR_ANCHORS, tourRoleOf } from "./onboarding";
import { chipsToFilters, removeSearchChip } from "./searchNL";
import { groupSearchHits, SEARCH_GROUPS } from "./searchApi";
import { kudosCounts } from "./momentum";
import { wipState } from "../components/tasks/otherViewsLogic";
import { pathOf, routeOf, canonicalPath } from "./nav";
import type { Kudos, SearchChip, SearchHit } from "../data/types";

const nodeFs = "node:fs";
const { readFileSync, readdirSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string; readdirSync: (p: string) => string[] };
const { cwd } = (globalThis as unknown as { process: { cwd(): string } }).process;
const SQL = readFileSync(`${cwd()}/supabase/migrations/0048_ux_wave.sql`, "utf8");
const src = (p: string) => readFileSync(`${cwd()}/src/${p}`, "utf8");

// captured from the 0048 PGlite replay (scratchpad/pgtest-0048/dump.mjs)
const SAVED_VIEW = { "id": "a8364055-15eb-4d0f-9aa6-0d53431ffa86", "workspace_id": "32bcfe00-b584-4a9b-a861-d331bceb69b0", "user_id": "a89a2412-b64a-49e4-bb75-10dc9466bba2", "name": "Launch blockers", "emoji": "🚧", "kind": "project", "query": { "v": 1, "filters": { "status": "blocked" }, "groupBy": "assignee", "viewType": "board", "projectId": "fe601abf-a2e0-4f29-ac9a-49eacd1b4f20" }, "pinned": true, "position": 1, "shared": true, "created_at": "2026-10-09T17:41:31.711Z", "updated_at": "2026-10-09T17:41:31.711Z" };
const TEMPLATE = { "id": "a1b71c68-a9c2-43cd-a9de-429c29576018", "workspace_id": "32bcfe00-b584-4a9b-a861-d331bceb69b0", "user_id": "a89a2412-b64a-49e4-bb75-10dc9466bba2", "name": "Client onboarding", "emoji": "🤝", "body": { "title": "Onboard {client}", "estimate": 90, "priority": "high", "subtasks": [{ "title": "Kick-off call", "offsetDays": 2, "assigneeRole": "project_owner" }], "checklist": ["Contract signed"] }, "shared": true, "created_at": "2026-10-09T17:41:31.712Z", "updated_at": "2026-10-09T17:41:31.712Z" };
const SNOOZE = { "user_id": "a89a2412-b64a-49e4-bb75-10dc9466bba2", "task_id": "610f3019-387f-44ec-9c9e-50613b791fe6", "until": "2026-10-09T18:41:31.714Z", "created_at": "2026-10-09T17:41:31.714Z" };
const GIVE_KUDOS = { "id": "f7fb9ef1-c395-4077-97c2-3405baa5b9e6", "note": "Great work", "emoji": "👏", "task_id": "610f3019-387f-44ec-9c9e-50613b791fe6", "to_name": "Sana Rao", "to_user": "a89a2412-b64a-49e4-bb75-10dc9466bba2", "from_name": "Theo Hart", "from_user": "56709045-a8fa-42c1-8c2b-80f424fe596e", "created_at": "2026-10-09T17:41:31.698+00:00", "workspace_id": "32bcfe00-b584-4a9b-a861-d331bceb69b0" };
const KUDOS_ROW = { "id": "f7fb9ef1-c395-4077-97c2-3405baa5b9e6", "task_id": "610f3019-387f-44ec-9c9e-50613b791fe6", "workspace_id": "32bcfe00-b584-4a9b-a861-d331bceb69b0", "from_user": "56709045-a8fa-42c1-8c2b-80f424fe596e", "to_user": "a89a2412-b64a-49e4-bb75-10dc9466bba2", "emoji": "👏", "note": "Great work", "created_at": "2026-10-09T17:41:31.698Z" };
const KUDOS_META = { "note": "Great work", "emoji": "👏", "kudos_id": "f7fb9ef1-c395-4077-97c2-3405baa5b9e6" };
const ONBOARDING = { "v": 1, "tour": { "done": false, "role": "member", "step": "inbox" }, "momentum": { "daysOff": ["2026-10-16"], "streakHidden": false }, "checklist": { "done": { "plan_day": "2026-10-09T08:00:00Z" } } };
const HITS = [
  { "kind": "task", "id": "610f3019-387f-44ec-9c9e-50613b791fe6", "title": "Launch deck", "snippet": "Draft the pricing slides for the board", "rank": 0.12158542, "task_id": "610f3019-387f-44ec-9c9e-50613b791fe6", "project_id": "fe601abf-a2e0-4f29-ac9a-49eacd1b4f20", "workspace_id": "32bcfe00-b584-4a9b-a861-d331bceb69b0", "meta": { "status": "done", "archived": false, "due_date": "2026-10-09", "priority": "high", "parent_id": null, "assignee_id": "a89a2412-b64a-49e4-bb75-10dc9466bba2" }, "updated_at": "2026-10-09T17:41:31.687Z" },
  { "kind": "comment", "id": "440fb99b-c553-4625-b68f-69c458293a12", "title": "Launch deck", "snippet": "Can we move the pricing table to slide", "rank": 0.12158542, "task_id": "610f3019-387f-44ec-9c9e-50613b791fe6", "project_id": "fe601abf-a2e0-4f29-ac9a-49eacd1b4f20", "workspace_id": "32bcfe00-b584-4a9b-a861-d331bceb69b0", "meta": { "author_id": "56709045-a8fa-42c1-8c2b-80f424fe596e", "author_name": "Theo Hart", "task_status": "done" }, "updated_at": "2026-10-09T17:41:31.690Z" },
  { "kind": "doc", "id": "7c0f5d8e-1f2a-4b3c-9d4e-5f6a7b8c9d0e", "title": "Launch brief", "snippet": "Pricing: three tiers, annual discount", "rank": 0.12158542, "task_id": null, "project_id": "fe601abf-a2e0-4f29-ac9a-49eacd1b4f20", "workspace_id": "32bcfe00-b584-4a9b-a861-d331bceb69b0", "meta": { "icon": null, "archived": false, "updated_by": "a89a2412-b64a-49e4-bb75-10dc9466bba2", "project_name": "Launch" }, "updated_at": "2026-10-09T17:41:31.693Z" },
  { "kind": "project", "id": "fe601abf-a2e0-4f29-ac9a-49eacd1b4f20", "title": "Launch", "snippet": "Pricing page and the launch plan", "rank": 0.12158542, "task_id": null, "project_id": "fe601abf-a2e0-4f29-ac9a-49eacd1b4f20", "workspace_id": "32bcfe00-b584-4a9b-a861-d331bceb69b0", "meta": { "color": "oklch(0.7 0.15 30)", "emoji": "🚀", "status": null, "archived": false, "owner_id": "62cfb118-74ee-4ed0-9703-3fa5ce9f5ded" }, "updated_at": "2026-10-09T17:41:31.683Z" },
  { "kind": "person", "id": "56709045-a8fa-42c1-8c2b-80f424fe596e", "title": "Theo Hart", "snippet": "theo@demo.test", "rank": 1, "task_id": null, "project_id": null, "workspace_id": "32bcfe00-b584-4a9b-a861-d331bceb69b0", "meta": { "role": "member", "email": "theo@demo.test", "title": null, "avatar_url": null }, "updated_at": null },
];

describe("0048 rows → app types", () => {
  it("saved view", () => {
    expect(parseSavedView(SAVED_VIEW)).toEqual({
      id: SAVED_VIEW.id, workspaceId: SAVED_VIEW.workspace_id, userId: SAVED_VIEW.user_id, name: "Launch blockers", emoji: "🚧", kind: "project",
      query: { v: 1, projectId: SAVED_VIEW.query.projectId, viewType: "board", filters: { status: "blocked" }, groupBy: "assignee" },
      pinned: true, position: 1, shared: true, createdAt: SAVED_VIEW.created_at, updatedAt: SAVED_VIEW.updated_at,
    });
    expect(parseSavedView({ ...SAVED_VIEW, kind: "kanban" })).toBeNull();
    expect(parseSavedView({ ...SAVED_VIEW, name: "" })).toBeNull();
    expect(parseSavedView(null)).toBeNull();
    // a junk query never throws: v 1, unknown fields dropped
    expect(parseSavedView({ ...SAVED_VIEW, query: "nope" })?.query).toEqual({ v: 1 });
    expect(parseSavedView({ ...SAVED_VIEW, query: { v: 1, viewType: "gantt", filters: { a: 1, b: "x", c: true }, sortDir: "up" } })?.query)
      .toEqual({ v: 1, filters: { b: "x", c: true } });
  });
  it("library template", () => {
    expect(parseLibraryTemplate(TEMPLATE)).toEqual({
      id: TEMPLATE.id, workspaceId: TEMPLATE.workspace_id, userId: TEMPLATE.user_id, name: "Client onboarding", emoji: "🤝", shared: true,
      body: { title: "Onboard {client}", priority: "high", estimate: 90, subtasks: [{ title: "Kick-off call", offsetDays: 2, assigneeRole: "project_owner" }], checklist: ["Contract signed"] },
      createdAt: TEMPLATE.created_at, updatedAt: TEMPLATE.updated_at,
    });
    expect(parseLibraryTemplate({ ...TEMPLATE, id: "builtin-lib-bug" })?.builtin).toBe(true);
    expect(parseTemplateBody({ description: "no title" })).toBeNull();
    const big = parseTemplateBody({ title: "x".repeat(600), priority: "massive", subtasks: Array.from({ length: 60 }, (_, i) => ({ title: `s${i}`, assigneeRole: "boss" })), checklist: ["a", "", 3] });
    expect(big?.title).toHaveLength(TEMPLATE_LIMITS.title);
    expect(big?.priority).toBeUndefined();
    expect(big?.subtasks).toHaveLength(TEMPLATE_LIMITS.subtasks);
    expect(big?.subtasks?.[0]).toEqual({ title: "s0" });
    expect(big?.checklist).toEqual(["a"]);
  });
  it("kudos (a row, and give_kudos's answer) + its Inbox meta", () => {
    const base = { id: KUDOS_ROW.id, taskId: KUDOS_ROW.task_id, workspaceId: KUDOS_ROW.workspace_id, fromUser: KUDOS_ROW.from_user, toUser: KUDOS_ROW.to_user, emoji: "👏", note: "Great work" };
    expect(parseKudos(KUDOS_ROW)).toEqual({ ...base, createdAt: KUDOS_ROW.created_at });
    expect(parseKudos(GIVE_KUDOS)).toEqual({ ...base, createdAt: GIVE_KUDOS.created_at, fromName: "Theo Hart", toName: "Sana Rao" });
    expect(parseKudos({ ...KUDOS_ROW, emoji: "💩" })?.emoji).toBe("🎉");
    expect(parseKudos({ ...KUDOS_ROW, to_user: null })).toBeNull();
    expect(parseActivityMeta(KUDOS_META)).toEqual({ kudosId: KUDOS_ROW.id, emoji: "👏", note: "Great work" });
    expect(parseActivityMeta({ kudos_id: "k", emoji: "🎉", note: null })).toEqual({ kudosId: "k", emoji: "🎉", note: null });
  });
  it("snooze", () => {
    expect(parseSnooze(SNOOZE)).toEqual({ taskId: SNOOZE.task_id, until: SNOOZE.until, createdAt: SNOOZE.created_at });
    expect(parseSnooze({ task_id: "t" })).toBeNull();
  });
  it("onboarding (merge_onboarding's answer) and board settings", () => {
    expect(parseOnboardingState(ONBOARDING)).toEqual({
      v: 1, tour: { step: "inbox", done: false, role: "member" }, checklist: { done: { plan_day: "2026-10-09T08:00:00Z" } },
      momentum: { streakHidden: false, daysOff: ["2026-10-16"] },
    });
    expect(parseOnboardingState(null)).toEqual({});
    expect(parseOnboardingState({ tour: { step: 5, done: "true", role: "boss" }, checklist: { done: { nope: "x", plan_day: 1 }, dismissedAt: null }, sample: { projectId: "" }, momentum: { daysOff: ["Friday", "2026-12-25"] } }))
      .toEqual({ tour: { step: null, done: true }, checklist: { done: {}, dismissedAt: null }, momentum: { daysOff: ["2026-12-25"] } });
    expect(parseBoardSettings({})).toBeUndefined();
    expect(parseBoardSettings({ wip: { todo: 5, progress: "3", review: 0, done: 5000, bad: "x" }, covers: true })).toEqual({ wip: { todo: 5, progress: 3, done: WIP_LIMIT_MAX }, covers: true });
  });
  it("search hits: every kind, with its extras", () => {
    const hits = HITS.map(parseSearchHit);
    expect(hits.every(Boolean)).toBe(true);
    const [task, comment, doc, project, person] = hits as SearchHit[];
    expect(task).toMatchObject({ kind: "task", title: "Launch deck", taskId: task.id, source: "server", task: { status: "done", priority: "high", dueDate: "2026-10-09", parentId: null, archived: false } });
    expect(comment).toMatchObject({ kind: "comment", taskId: HITS[0].id, comment: { authorName: "Theo Hart", taskStatus: "done" } });
    expect(doc).toMatchObject({ kind: "doc", taskId: null, doc: { projectName: "Launch", icon: null } });
    expect(project).toMatchObject({ kind: "project", project: { emoji: "🚀", archived: false } });
    expect(person).toMatchObject({ kind: "person", title: "Theo Hart", person: { email: "theo@demo.test", role: "member" } });
    expect(parseSearchHit({ kind: "secret", id: "x" })).toBeNull();
    expect(groupSearchHits(hits as SearchHit[]).map((g) => g.label)).toEqual(SEARCH_GROUPS.map((g) => g.label));
  });
  it("snippets become text runs (never HTML)", () => {
    expect(splitHighlights(HITS[0].snippet)).toEqual([{ text: "Draft the ", hit: false }, { text: "pricing", hit: true }, { text: " slides for the board", hit: false }]);
    expect(splitHighlights(`<b>${SEARCH_MARK_START}x${SEARCH_MARK_END}${SEARCH_MARK_END}</b>`)).toEqual([{ text: "<b>", hit: false }, { text: "x", hit: true }, { text: "</b>", hit: false }]);
    expect(splitHighlights(null)).toEqual([]);
  });
  it("search filters: app ⇄ RPC", () => {
    const f = parseSearchFilters({ kinds: ["task", "nope"], workspaceId: null, projectId: "p", assigneeId: "u", statuses: ["blocked", "x"], excludeDone: true, dueFrom: "2026-10-05", dueTo: "friday", authorId: "a", includeArchived: "true" });
    expect(f).toEqual({ kinds: ["task"], workspaceId: null, projectId: "p", assigneeId: "u", statuses: ["blocked"], excludeDone: true, dueFrom: "2026-10-05", authorId: "a", includeArchived: true });
    expect(searchFiltersToRpc(f)).toEqual({ kinds: ["task"], workspace_id: null, project_id: "p", assignee_id: "u", statuses: ["blocked"], exclude_done: true, due_from: "2026-10-05", author_id: "a", include_archived: true });
    expect(searchFiltersToRpc({})).toEqual({});   // everywhere
  });
  it("the database's messages → failure kinds", () => {
    expect(savedViewFailure(new Error("too many saved views"))).toBe("too_many");
    expect(savedViewFailure(new Error('new row violates row-level security policy for table "saved_views"'))).toBe("not_allowed");
    expect(savedViewFailure(new Error('new row for relation "saved_views" violates check constraint "saved_views_shape"'))).toBe("invalid");
    expect(savedViewFailure(new Error('relation "public.saved_views" does not exist'))).toBe("unavailable");
    expect(templateFailure(new Error("too many task templates"))).toBe("too_many");
    expect(templateFailure(new TypeError("Failed to fetch"))).toBe("network");
    for (const [m, k] of [["not authorized", "not_allowed"], ["task not found", "not_found"], ["task not done", "not_done"], ["kudos need a team task", "team_only"],
      ["not for yourself", "self"], ["too many kudos", "too_many"], ["invalid emoji", "invalid"], ["invalid recipient", "invalid"],
      ["Could not find the function public.give_kudos(p_task) in the schema cache", "unavailable"], ["boom", "error"]] as const) {
      expect(kudosFailure(new Error(m))).toBe(k);
    }
    expect(searchFailure(new Error("invalid filters"))).toBe("invalid");
    expect(searchFailure(new Error("not authorized"))).toBe("not_allowed");
    expect(searchFailure({ message: "function public.search_all(text, jsonb, integer) does not exist" })).toBe("unavailable");
  });
});

describe("the limits and lists match 0048_ux_wave.sql", () => {
  it("kudos emoji, note, daily cap", () => {
    const m = /emoji in \(([^)]*)\)/.exec(SQL);
    expect(m?.[1].match(/'([^']+)'/g)?.map((s) => s.slice(1, -1))).toEqual([...KUDOS_EMOJI]);
    expect(SQL).toContain(`char_length(note) between 1 and ${KUDOS_NOTE_MAX}`);
    expect(SQL).toContain(`>= ${KUDOS_PER_DAY} then\n      raise exception 'too many kudos'`);
  });
  it("views, templates, snoozes, onboarding, board, search", () => {
    expect(SQL).toContain(`char_length(btrim(name)) between 1 and ${SAVED_VIEW_LIMITS.name}`);
    expect(SQL).toContain(`pg_column_size(query) <= ${SAVED_VIEW_LIMITS.queryBytes}`);
    expect(SQL).toContain(`char_length(emoji) <= ${SAVED_VIEW_LIMITS.emoji}`);
    expect(SQL).toContain(`then ${SAVED_VIEW_LIMITS.perPerson} else ${TEMPLATE_LIMITS.perPerson} end`);
    expect(SQL).toContain(`pg_column_size(body) <= ${TEMPLATE_LIMITS.bodyBytes}`);
    expect(SQL).toContain(`jsonb_array_length(body -> 'subtasks') <= ${TEMPLATE_LIMITS.subtasks}`);
    expect(SQL).toContain(`char_length(body ->> 'title') <= ${TEMPLATE_LIMITS.title}`);
    expect(SQL).toContain(`now() + interval '${SNOOZE_MAX_DAYS} days'`);
    expect(SQL).toContain(`>= ${SNOOZES_PER_PERSON} then`);
    expect(SQL).toContain(`pg_column_size(onboarding) <= ${ONBOARDING_MAX_BYTES}`);
    expect(SQL).toContain(`pg_column_size(board_settings) <= ${BOARD_SETTINGS_MAX_BYTES}`);
    expect(SQL).toContain(`least(greatest(coalesce(lim, 20), 1), ${SEARCH_LIMIT_MAX})`);
    expect(SQL).toContain("kind in ('my_tasks', 'project', 'search')");
    // every kind the app may queue is allowed in notify_queue
    const q = /and kind in \(([^)]*)\)\n  and char_length\(event_key\)/.exec(SQL);
    const kinds = q?.[1].match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
    for (const k of NOTIFY_KINDS) expect(kinds).toContain(k);
    // snippet markers
    expect(SQL).toContain("chr(57344)");
    expect(SEARCH_MARK_START.codePointAt(0)).toBe(57344);
    expect(SEARCH_MARK_END.codePointAt(0)).toBe(57345);
  });
});

describe("drag-and-drop kit (u3 builds it; the surface is final)", () => {
  it("exports the hooks, the layer and the keyboard alternatives", () => {
    for (const fn of ["useTaskDragSource", "useTaskDropTarget", "useDragState", "useDropTargets", "listDropTargets", "dropOnTarget", "isTaskDragActive", "cancelTaskDrag", "DragLayer"] as const) {
      expect(typeof dnd[fn]).toBe("function");
    }
    expect([dnd.DND_DRAG_THRESHOLD_PX, dnd.DND_LONG_PRESS_MS, dnd.DND_SNAP_MINUTES, dnd.DND_AUTOSCROLL_EDGE_PX]).toEqual([4, 350, 15, 48]);
  });
  it("snaps to quarter hours inside the day; labels the ghost", () => {
    expect([dnd.snapMinutes(547), dnd.snapMinutes(553), dnd.snapMinutes(-30), dnd.snapMinutes(1439), dnd.snapMinutes(NaN), dnd.snapMinutes(61, 30)]).toEqual([540, 555, 0, 1425, 0, 60]);
    expect(dnd.dragLabel({ taskIds: ["a"] }, " Launch deck ")).toBe("Launch deck");
    expect(dnd.dragLabel({ taskIds: ["a"] })).toBe("1 task");
    expect(dnd.dragLabel({ taskIds: ["a", "b", "c"] }, "ignored")).toBe("3 tasks");
  });
});

describe("notification prefs (defaults and validation are final)", () => {
  it("fills every default; a malformed value counts as unset", () => {
    const p = readNotifyPrefs(undefined);
    expect([p.delivery, p.digestTime, p.quietHours, p.timezone, p.bundle]).toEqual(["realtime", DEFAULT_DIGEST_TIME, null, DEFAULT_TIMEZONE, true]);
    expect(p.inApp("kudos") && p.channel("comment", "email") && p.channel("mention", "push")).toBe(true);
    const q = readNotifyPrefs({ delivery: "digest", digest_time: "07:30", timezone: "America/New_York", bundle: false, comment_email: false, kudos: "false",
      quiet_hours: { start: "22:00", end: "07:00", days: [5, 1, 1, 9] } });
    expect([q.delivery, q.digestTime, q.timezone, q.bundle, q.channel("comment", "email"), q.inApp("kudos")]).toEqual(["digest", "07:30", "America/New_York", false, false, false]);
    expect(q.quietHours).toEqual({ start: "22:00", end: "07:00", days: [1, 5] });
    const bad = readNotifyPrefs({ delivery: "sometimes", digest_time: "25:00", timezone: "Mars/Olympus", quiet_hours: { start: "22:00", end: "22:00" } });
    expect([bad.delivery, bad.digestTime, bad.timezone, bad.quietHours]).toEqual(["realtime", DEFAULT_DIGEST_TIME, DEFAULT_TIMEZONE, null]);
  });
  it("a patch: null removes a key (what merge_notify_prefs stores)", () => {
    expect(applyNotifyPrefsPatch({ a: true, quiet_hours: { start: "22:00", end: "07:00" } }, { quiet_hours: null, delivery: "digest" })).toEqual({ a: true, delivery: "digest" });
  });
});

describe("views, onboarding, search chips, board, kudos counts", () => {
  it("who may edit / share views (the database's rules)", () => {
    const v = { userId: "sana", shared: true, workspaceId: "ws" };
    expect(canEditView(v, { userId: "sana", role: "guest" })).toBe(true);
    expect(canEditView(v, { userId: "theo", role: "member" })).toBe(false);
    expect(canEditView(v, { userId: "ada", role: "admin" })).toBe(true);
    expect(canEditView({ ...v, shared: false }, { userId: "ada", role: "owner" })).toBe(false);
    expect([canShareViews("member", "ws"), canShareViews("guest", "ws"), canShareViews("owner", null), canShareViews(null, "ws")]).toEqual([true, false, false, false]);
  });
  it("the tour's roles, checklist items and anchors (each anchor is on a real element)", () => {
    expect([tourRoleOf("admin", false), tourRoleOf("member", false), tourRoleOf("guest", false), tourRoleOf(null, true)]).toEqual(["owner", "member", "guest", "owner"]);
    expect(SETUP_ITEMS.owner).toEqual(["invite_team", "connect_calendar", "add_domain", "connect_slack"]);
    expect(SETUP_ITEMS.member).toEqual(["plan_day", "complete_task", "install_app", "set_notifications"]);
    const files = ["components/Sidebar.tsx", "components/Topbar.tsx", "components/views/TodayView.tsx", "components/TaskDetail.tsx", "components/views/InboxView.tsx"].map(src).join("\n");
    for (const sel of Object.values(TOUR_ANCHORS)) {
      const name = /data-tour="([^"]+)"/.exec(sel)?.[1];
      expect(files.includes(`data-tour="${name}"`) || files.includes(`"${name}"`), name).toBe(true);
    }
  });
  it("search chips: merged patches; removing one re-merges the rest", () => {
    const chips: SearchChip[] = [
      { id: "a", kind: "assignee", label: "Maya", patch: { assigneeId: "m" }, source: "Maya's" },
      { id: "b", kind: "due", label: "Overdue", patch: { dueTo: "2026-10-08", excludeDone: true }, source: "overdue" },
      { id: "c", kind: "project", label: "In Launch", patch: { projectId: "p" }, source: "in Launch" },
    ];
    expect(chipsToFilters(chips, { workspaceId: "ws" })).toEqual({ workspaceId: "ws", assigneeId: "m", dueTo: "2026-10-08", excludeDone: true, projectId: "p" });
    const parsed = { input: "Maya's overdue tasks in Launch", text: "", filters: chipsToFilters(chips), chips };
    expect(removeSearchChip(parsed, "b").filters).toEqual({ assigneeId: "m", projectId: "p" });
  });
  it("WIP state and kudos counts", () => {
    expect([wipState(2, 3), wipState(3, 3), wipState(4, 3), wipState(9, null), wipState(9, 0)]).toEqual(["ok", "at", "over", "ok", "ok"]);
    const k = (from: string, to: string, at: string): Kudos => ({ id: from + to + at, taskId: "t", workspaceId: "w", fromUser: from, toUser: to, emoji: "🎉", note: null, createdAt: at });
    expect(kudosCounts([k("a", "b", "2026-10-09T09:00:00Z"), k("c", "b", "2026-10-09T10:00:00Z"), k("b", "a", "2026-10-01T10:00:00Z")], "2026-10-05T00:00:00Z"))
      .toEqual({ a: { received: 0, given: 1 }, b: { received: 2, given: 0 }, c: { received: 0, given: 1 } });
  });
});

describe("routes carry a saved view", () => {
  it("My tasks and project views round-trip ?view=; docs and search don't take it", () => {
    expect(pathOf({ view: "tasks", savedViewId: "v1" })).toBe("/tasks?view=v1");
    expect(pathOf({ view: "tasks", tab: "waiting", list: "overdue", savedViewId: "v 2" })).toBe("/tasks/waiting?due=overdue&view=v+2");
    expect(routeOf("/tasks/waiting", "?due=overdue&view=v+2")).toEqual({ view: "tasks", tab: "waiting", list: "overdue", savedViewId: "v 2" });
    expect(pathOf({ view: "project", projectId: "p1", tab: "board", savedViewId: "v1" })).toBe("/p/p1/board?view=v1");
    expect(routeOf("/p/p1/board", "?view=v1")).toEqual({ view: "project", projectId: "p1", tab: "board", savedViewId: "v1" });
    expect(routeOf("/p/p1/docs/d1", "?view=v1")).toEqual({ view: "project", projectId: "p1", tab: "docs", docId: "d1" });
    expect(canonicalPath("/tasks", "?view=v1&task=t9")).toBe("/tasks?view=v1&task=t9");
    expect(pathOf({ view: "tasks" })).toBe("/tasks");
  });
});

describe("every package's entry points exist (stubs until built)", () => {
  it("libs", async () => {
    const libs: [string, string[]][] = [
      ["./onboarding", ["tourSteps", "checklistView", "showSetupChecklist", "shouldAutoStartTour", "saveOnboarding", "startTour", "onTourRequest", "tourSamplePlan", "createTourSample", "removeTourSample"]],
      ["./searchNL", ["parseSearchNL", "chipsToFilters", "removeSearchChip"]],
      ["./searchApi", ["searchAll", "localSearch", "mergeSearchHits", "groupSearchHits", "recentSearches", "rememberSearch", "forgetRecentSearches"]],
      ["./notifyPrefs", ["readNotifyPrefs", "mergeNotifyPrefs", "snoozeChoices", "listSnoozes", "snoozeThread", "unsnoozeThread", "subscribeSnoozes", "isSnoozed", "inQuietHours", "quietHoursEnd", "nextDigestAt", "planDelivery"]],
      ["./inboxTriage", ["bundleInbox"]],
      ["./views", ["listSavedViews", "createSavedView", "updateSavedView", "deleteSavedView", "reorderSavedViews", "adoptLegacySavedSearches", "subscribeSavedViews", "viewRoute"]],
      // (what a view shows and its count: their own module, fetched when idle — never in the first download)
      ["./savedViews/counts", ["viewMatchesTask", "viewCount", "viewCounts"]],
      ["./gestures", ["useSwipeRow", "swipeDecision", "haptic"]],
      ["./templates", ["listLibraryTemplates", "createLibraryTemplate", "updateLibraryTemplate", "deleteLibraryTemplate", "adoptLocalTemplates", "templateFromTask", "matchTemplates", "planTemplate"]],
      ["./presence", ["usePresence", "useTyping", "useDocCollab", "applyDocOps", "mergeRemoteBatch", "diffDocBlocks", "presenceSentence", "presenceKey"]],
      ["./dropActions", ["useProjectDropTarget", "usePersonDropTarget"]],
      // (the moves load with the first drop)
      ["./dropMoves", ["moveTasksToProject", "reassignTasks"]],
      ["./momentum", ["isWorkingDay", "computeStreak", "recapWindow", "buildWinsRecap", "winsRecapText", "kudosCounts", "listKudos", "giveKudos", "takeBackKudos", "subscribeKudos"]],
    ];
    for (const [path, names] of libs) {
      const mod = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
      for (const n of names) expect(typeof mod[n], `${path} ${n}`).toBe("function");
    }
  });
  it("components (final props in each file's header)", async () => {
    const comps: [string, string[]][] = [
      ["../components/onboarding", ["TourHost", "SetupChecklist", "HelpMenu"]],
      ["../components/presence", ["PresenceAvatars", "TypingIndicator"]],
      ["../components/templates", ["TemplateLibrary", "TemplatePicker", "SaveAsTemplate"]],
      ["../components/momentum", ["WinsRecap", "StreakChip", "KudosButton"]],
      ["../components/views/SavedViewEditor", ["SavedViewEditor", "SaveViewButton"]],
      ["../components/settings/NotificationPrefsPanel", ["NotificationPrefsPanel"]],
      ["../components/QuickAddSheet", ["QuickAddSheet"]],
      ["../components/tasks/CoverPicker", ["CoverPicker"]],
    ];
    for (const [path, names] of comps) {
      const mod = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
      for (const n of names) expect(typeof mod[n], `${path} ${n}`).toBe("function");
    }
  });
  it("the owner doc's VERIFY query is the migration's", () => {
    const norm = (t: string) => t.replace(/\s+/g, " ").trim();
    const block = SQL.split("-- VERIFY")[1];
    const from = block.indexOf("-- select");
    const fromSql = block.slice(from, block.indexOf(";", from) + 1).split("\n").map((l) => l.replace(/^--\s?/, "")).join("\n");
    const doc = src("../docs/integrations/database-0048.md");
    const fromDoc = /```sql\n([\s\S]*?)```/.exec(doc)?.[1] ?? "";
    expect(norm(fromDoc)).toBe(norm(fromSql));
  });
  it("the migration is the only 0048 and records itself", () => {
    const files = readdirSync(`${cwd()}/supabase/migrations`).filter((f) => f.startsWith("0048"));
    expect(files).toEqual(["0048_ux_wave.sql"]);
    expect(SQL).toContain("insert into public.schema_migrations (version) values ('0048')");
  });
});

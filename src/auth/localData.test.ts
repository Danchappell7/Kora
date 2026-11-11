/* Whose data is cached on this device — shared desks, several tabs, full storage. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Task } from "../data/types";

const task = (id: string) => ({ id, title: `Task ${id}` } as unknown as Task);

/** a fresh page: new module state (this tab's queue is read from storage once, at import) */
async function freshTab() {
  vi.resetModules();
  const ld = await import("./localData");
  const { offlineQueue } = await import("../lib/offlineQueue");
  return { ...ld, offlineQueue };
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("local data belongs to one account at a time", () => {
  it("never replays another account's queued edits; parks and restores them instead", async () => {
    const { claimLocalData, offlineQueue, SNAPSHOT_KEY, OWNER_KEY, STASH_PREFIX } = await freshTab();
    expect(claimLocalData("user-a")).toBe(false);
    offlineQueue.enqueueCreate(task("t1"), "user-a");
    offlineQueue.enqueueUpdate("t9", { title: "renamed" });
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ uid: "user-a", boot: {} }));

    expect(claimLocalData("user-b")).toBe(true); // this page showed user-a → reload
    expect(offlineQueue.size()).toBe(0);
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(localStorage.getItem(OWNER_KEY)).toBe("user-b");
    expect(JSON.parse(localStorage.getItem(STASH_PREFIX + "user-a") || "[]")).toHaveLength(2);

    claimLocalData("user-a");
    expect(offlineQueue.all().map((m) => m.kind)).toEqual(["create", "update"]);
    expect(localStorage.getItem(STASH_PREFIX + "user-a")).toBeNull();
  });

  it("infers the owner of data cached before owner tracking existed", async () => {
    let t = await freshTab();
    localStorage.setItem(t.SNAPSHOT_KEY, JSON.stringify({ uid: "old-user", boot: {} }));
    expect(t.claimLocalData("new-user")).toBe(true);
    expect(localStorage.getItem(t.SNAPSHOT_KEY)).toBeNull();

    localStorage.clear();
    t = await freshTab();
    localStorage.setItem(t.SNAPSHOT_KEY, JSON.stringify({ uid: "same", boot: {} }));
    expect(t.claimLocalData("same")).toBe(false);
    expect(localStorage.getItem(t.SNAPSHOT_KEY)).not.toBeNull();
  });

  it("sign-out drops the snapshot and queue but keeps the owner and view state for the same person", async () => {
    let t = await freshTab();
    t.claimLocalData("user-a");
    t.offlineQueue.enqueueCreate(task("t1"), "user-a");
    localStorage.setItem(t.SNAPSHOT_KEY, "{}");
    localStorage.setItem("kanbo-filters:my", '{"priority":"high"}');
    localStorage.setItem("kanbo-filters:p-secret", '{"hideDone":true}');
    localStorage.setItem("kanbo-inbox-seen", "123");
    localStorage.setItem("kanbo-templates", '[{"id":"tpl-1","name":"Theirs"}]');
    // (a project template holds a project's name, its task titles and notes)
    localStorage.setItem("kanbo-project-templates", '[{"id":"ptpl-1","name":"Acquisition of Target Co","emoji":"🔒","color":"#000","tasks":[{"title":"Draft SPA for Target Co","description":"Price £4.2m"}]}]');
    localStorage.setItem("kanbo-theme", "light");
    sessionStorage.setItem("kanbo-needs-password", "invite");
    t.clearLocalUserData();
    expect(t.offlineQueue.size()).toBe(0);
    expect(localStorage.getItem(t.SNAPSHOT_KEY)).toBeNull();
    expect(sessionStorage.getItem("kanbo-needs-password")).toBeNull();
    expect(localStorage.getItem(t.OWNER_KEY)).toBe("user-a");
    expect(localStorage.getItem("kanbo-theme")).toBe("light");

    // the same person signs back in (after the sign-out reload): nothing to reset
    t = await freshTab();
    expect(t.claimLocalData("user-a")).toBe(false);
    expect(localStorage.getItem("kanbo-filters:my")).toBe('{"priority":"high"}');
    expect(localStorage.getItem("kanbo-inbox-seen")).toBe("123");
    expect(localStorage.getItem("kanbo-templates")).not.toBeNull();
    expect(localStorage.getItem("kanbo-project-templates")).not.toBeNull();

    // someone else signs in: their view state goes, and the page must reload
    localStorage.setItem("kanbo-onboarded", "1");
    t = await freshTab();
    expect(t.claimLocalData("user-b")).toBe(true);
    // (every list's filters: another account's can hide user-b's tasks)
    expect(localStorage.getItem("kanbo-filters:my")).toBeNull();
    expect(localStorage.getItem("kanbo-filters:p-secret")).toBeNull();
    expect(localStorage.getItem("kanbo-inbox-seen")).toBeNull();
    expect(localStorage.getItem("kanbo-onboarded")).toBeNull();
    // (their per-browser templates never move up into user-b's library)
    expect(localStorage.getItem("kanbo-templates")).toBeNull();
    // (nor are user-a's project templates offered in user-b's New project)
    expect(localStorage.getItem("kanbo-project-templates")).toBeNull();
    expect(localStorage.getItem("kanbo-theme")).toBe("light");
    // …and after that reload, no loop
    t = await freshTab();
    expect(t.claimLocalData("user-b")).toBe(false);
  });

  it("a project template saved on this device (a project's name, task titles and notes) isn't offered to the next account", async () => {
    const t = await freshTab();
    const tpl = await import("../lib/templates");
    const { filtersKey, readFilters } = await import("../lib/taskOps");
    t.claimLocalData("user-a");
    expect(tpl.storeProjectTemplate({ name: "Acquisition of Target Co", emoji: "🔒", color: "#64748B",
      tasks: [{ title: "Draft SPA for Target Co", description: "Price £4.2m, earn-out 18 months" }] })).not.toBeNull();
    localStorage.setItem(filtersKey("my"), JSON.stringify({ priority: "urgent", hideDone: true }));
    t.clearLocalUserData();                       // user-a signs out…
    expect(t.claimLocalData("user-a")).toBe(false); // …and back in: still theirs
    expect(tpl.getUserProjectTemplates().map((x) => x.name)).toEqual(["Acquisition of Target Co"]);
    t.clearLocalUserData();
    t.claimLocalData("user-b");                   // someone else signs in at the same desk
    expect(tpl.getUserProjectTemplates()).toEqual([]);
    expect(tpl.getProjectTemplates().some((x) => /Target Co/.test(x.name))).toBe(false);
    expect(readFilters("my")).toMatchObject({ priority: "all", hideDone: false });
  });

  it("clears another tab's in-memory edits when a different account signs in elsewhere", async () => {
    // tab Y: user-a with queued update/delete edits (no create to infer an owner from)
    const y = await freshTab();
    y.claimLocalData("user-a");
    y.offlineQueue.enqueueUpdate("t1", { title: "A's edit" });
    y.offlineQueue.enqueueDelete("t2");
    // tab X signed user-a out (empty stored queue) and user-b signed in there
    localStorage.setItem(y.QUEUE_KEY, "[]");
    localStorage.setItem(y.OWNER_KEY, "user-b");

    // SIGNED_IN(user-b) reaches tab Y
    expect(y.claimLocalData("user-b")).toBe(true);
    expect(y.offlineQueue.size()).toBe(0);
    const parked = JSON.parse(localStorage.getItem(y.STASH_PREFIX + "user-a") || "[]") as { kind: string }[];
    expect(parked.map((m) => m.kind)).toEqual(["update", "delete"]);
  });

  it("leaves the new account's stored queue alone when clearing another tab's memory", async () => {
    const y = await freshTab();
    y.claimLocalData("user-a");
    y.offlineQueue.enqueueUpdate("t1", { title: "A's edit" });
    const bQueue = JSON.stringify([{ id: "q-b", ts: 1, kind: "delete", taskId: "tb" }]);
    localStorage.setItem(y.QUEUE_KEY, bQueue);
    localStorage.setItem(y.OWNER_KEY, "user-b");
    y.claimLocalData("user-b");
    expect(y.offlineQueue.size()).toBe(0);
    expect(localStorage.getItem(y.QUEUE_KEY)).toBe(bQueue);
  });

  it("fails closed when storage is full: the queue is still emptied and the owner switched", async () => {
    const t = await freshTab();
    t.claimLocalData("user-a");
    t.offlineQueue.enqueueUpdate("t1", { title: "offline" });
    t.offlineQueue.enqueueDelete("t2");
    localStorage.setItem(t.SNAPSHOT_KEY, JSON.stringify({ uid: "user-a", big: "x".repeat(1000) }));
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith(t.STASH_PREFIX)) throw new DOMException("quota", "QuotaExceededError");
      return real.call(this, k, v);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    t.claimLocalData("user-b");
    expect(t.offlineQueue.size()).toBe(0);
    expect(localStorage.getItem(t.OWNER_KEY)).toBe("user-b");
    expect(localStorage.getItem(t.SNAPSHOT_KEY)).toBeNull();
  });

  it("parks this tab's edits when the session ends elsewhere, and restores them for the same person", async () => {
    const t = await freshTab();
    t.claimLocalData("user-a");
    t.offlineQueue.enqueueUpdate("t1", { title: "offline" });
    t.parkLocalData("user-a");
    expect(t.offlineQueue.size()).toBe(0);
    // parked twice (two tabs holding the same queued op) → still one copy
    const op = JSON.parse(localStorage.getItem(t.STASH_PREFIX + "user-a") || "[]");
    t.offlineQueue.clear();
    localStorage.setItem(t.QUEUE_KEY, JSON.stringify(op));
    const other = await freshTab();
    other.parkLocalData("user-a");
    expect(JSON.parse(localStorage.getItem(t.STASH_PREFIX + "user-a") || "[]")).toHaveLength(1);

    const back = await freshTab();
    back.claimLocalData("user-a");
    expect(back.offlineQueue.all().map((m) => m.kind)).toEqual(["update"]);
  });

  it("forgets a stored Supabase session", async () => {
    const t = await freshTab();
    localStorage.setItem("sb-abcd-auth-token", "{}");
    localStorage.setItem("sb-abcd-auth-token-code-verifier", "v");
    localStorage.setItem("custom-key", "{}");
    localStorage.setItem("kanbo-theme", "dark");
    t.forgetStoredSession("custom-key");
    expect(localStorage.getItem("sb-abcd-auth-token")).toBeNull();
    expect(localStorage.getItem("sb-abcd-auth-token-code-verifier")).toBeNull();
    expect(localStorage.getItem("custom-key")).toBeNull();
    expect(localStorage.getItem("kanbo-theme")).toBe("dark");
  });
});

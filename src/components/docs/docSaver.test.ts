/* Autosave with optimistic concurrency (fake timers; the save function is a stand-in for the RPC). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocBlock, DocSaveInput, DocSaveResult, DocSaveState, ProjectDoc } from "../../data/types";
import { createDocSaver } from "./docSaver";

const doc = (over: Partial<ProjectDoc> = {}): ProjectDoc => ({
  id: "d1", projectId: "p1", workspaceId: "w1", title: "T", body: [], icon: null, position: 1, mentions: [], createdBy: "u1", createdByName: null,
  updatedBy: "u1", updatedByName: null, createdAt: "2026-10-09T10:00:00.000Z", updatedAt: "2026-10-09T10:00:00.000Z", archivedAt: null, canEdit: true, ...over,
});

let content: { title: string; body: DocBlock[] };
let states: DocSaveState[];
let calls: DocSaveInput[];
let respond: (input: DocSaveInput) => Promise<DocSaveResult>;
const flushPromises = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function make() {
  const hooks = { saved: [] as ProjectDoc[], conflict: [] as ProjectDoc[], gone: 0, errors: [] as string[] };
  const saver = createDocSaver("2026-10-09T10:00:00.000Z", {
    docId: "d1", projectId: "p1",
    save: (input) => { calls.push(input); return respond(input); },
    draft: () => content,
    onState: (s) => states.push(s),
    onSaved: (d) => hooks.saved.push(d),
    onConflict: (d) => hooks.conflict.push(d),
    onGone: () => { hooks.gone++; },
    onError: (why) => hooks.errors.push(why),
  });
  return { saver, hooks };
}
let stamp = 0;
const ok = (input: DocSaveInput): Promise<DocSaveResult> => Promise.resolve({ status: "saved", doc: doc({ title: input.title, body: input.body, updatedAt: `2026-10-09T10:00:0${++stamp}.000Z` }) });

beforeEach(() => {
  vi.useFakeTimers();
  content = { title: "T", body: [] };
  states = []; calls = []; stamp = 0;
  respond = ok;
});
afterEach(() => vi.useRealTimers());

describe("autosave", () => {
  it("saves 2 s after the last change, with the loaded base and the doc's mentions; then the new base", async () => {
    const { saver, hooks } = make();
    content = { title: "T2", body: [{ id: "a", type: "p", spans: [{ text: "@S", mention: "m-3" }] }] };
    saver.touch();
    expect(states).toEqual(["saving"]);
    vi.advanceTimersByTime(1500);
    saver.touch();
    vi.advanceTimersByTime(1999);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(calls[0]).toMatchObject({ id: "d1", projectId: "p1", title: "T2", baseUpdatedAt: "2026-10-09T10:00:00.000Z", mentions: ["m-3"] });
    expect(states).toEqual(["saving", "saved"]);
    expect(saver.base).toBe("2026-10-09T10:00:01.000Z");
    expect(saver.dirty).toBe(false);
    expect(hooks.saved).toHaveLength(1);
    content = { ...content, title: "T3" };
    saver.touch();
    await saver.flush();
    expect(calls[1].baseUpdatedAt).toBe("2026-10-09T10:00:01.000Z");
  });

  it("flush saves at once; nothing to save is no call (and undoing back to what's saved isn't a save)", async () => {
    const { saver } = make();
    await saver.flush();
    expect(calls).toHaveLength(0);
    content = { title: "X", body: [] };
    saver.touch();
    content = { title: "T", body: [] }; // typed, then undid
    await saver.flush();
    expect(calls).toHaveLength(0);
    expect(states.pop()).toBe("saved");
  });

  it("changes made while a save is in flight go in the next save", async () => {
    let release!: () => void;
    respond = (input) => new Promise((r) => { release = () => r({ status: "saved", doc: doc({ title: input.title, updatedAt: `2026-10-09T10:00:0${++stamp}.000Z` }) }); });
    const { saver } = make();
    content = { title: "A", body: [] };
    saver.touch();
    const first = saver.flush();
    content = { title: "AB", body: [] };
    saver.touch();
    void saver.flush();
    expect(calls).toHaveLength(1);
    release();
    await first;
    await flushPromises();
    vi.advanceTimersByTime(2000);
    await flushPromises();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ title: "AB", baseUpdatedAt: "2026-10-09T10:00:01.000Z" });
    release();
    await flushPromises();
    expect(saver.dirty).toBe(false);
  });

  it("a conflict stops autosave until keep mine (saved on their updatedAt) or reload (their copy adopted)", async () => {
    const theirs = doc({ title: "Theirs", updatedBy: "u2", updatedByName: "Sana", updatedAt: "2026-10-09T10:05:00.000Z" });
    respond = () => Promise.resolve({ status: "conflict", doc: theirs });
    const { saver, hooks } = make();
    content = { title: "Mine", body: [] };
    saver.touch();
    await saver.flush();
    expect(states.pop()).toBe("conflict");
    expect(hooks.conflict).toEqual([theirs]);
    expect(saver.held).toBe(true);
    content = { title: "Mine 2", body: [] };
    saver.touch();
    vi.advanceTimersByTime(10_000);
    expect(calls).toHaveLength(1);                 // held
    respond = ok;
    await saver.keepMine(theirs.updatedAt);
    expect(calls[1]).toMatchObject({ title: "Mine 2", baseUpdatedAt: "2026-10-09T10:05:00.000Z" });
    expect(saver.held).toBe(false);
    // reload theirs instead
    saver.hold();
    content = { title: "Theirs", body: [] };
    saver.adopt("2026-10-09T10:09:00.000Z");
    expect(saver.base).toBe("2026-10-09T10:09:00.000Z");
    expect(saver.dirty).toBe(false);
    await saver.flush();
    expect(calls).toHaveLength(2);
  });

  it("offline: says so, retries with backoff and when the browser is back", async () => {
    let fail = true;
    respond = (input) => (fail ? Promise.reject(new TypeError("Failed to fetch")) : ok(input));
    const { saver } = make();
    content = { title: "Train", body: [] };
    saver.touch();
    await saver.flush();
    expect(states.pop()).toBe("offline");
    vi.advanceTimersByTime(2000);
    await flushPromises();
    expect(calls).toHaveLength(2);
    expect(states[states.length - 1]).toBe("offline");
    fail = false;
    window.dispatchEvent(new Event("online"));
    await flushPromises();
    expect(states[states.length - 1]).toBe("saved");
    expect(saver.dirty).toBe(false);
  });

  it("a refusal waits for the person; a deleted doc is gone for good", async () => {
    respond = () => Promise.reject(new Error("doc too large"));
    const { saver, hooks } = make();
    content = { title: "Huge", body: [] };
    saver.touch();
    await saver.flush();
    expect(hooks.errors).toEqual(["too_large"]);
    expect(states.pop()).toBe("error");
    vi.advanceTimersByTime(60_000);
    expect(calls).toHaveLength(1);
    respond = () => Promise.reject(new Error("doc not found"));
    saver.touch();
    await saver.flush();
    expect(hooks.gone).toBe(1);
    saver.touch();
    await saver.flush();
    expect(calls).toHaveLength(2);
  });

  it("dispose stops timers; revive (StrictMode remount) starts them again", async () => {
    const { saver } = make();
    content = { title: "Z", body: [] };
    saver.touch();
    saver.dispose();
    vi.advanceTimersByTime(5000);
    expect(calls).toHaveLength(0);
    saver.revive();
    vi.advanceTimersByTime(2000);
    await flushPromises();
    expect(calls).toHaveLength(1);
  });
});

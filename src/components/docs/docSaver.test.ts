/* Autosave with optimistic concurrency (fake timers; the save function is a stand-in for the RPC). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocBlock, DocSaveResult, DocSaveState, ProjectDoc } from "../../data/types";
import type { DocSaveRequest } from "../../lib/docs";
import { createDocSaver } from "./docSaver";
type DocSaveInput = DocSaveRequest;

const doc = (over: Partial<ProjectDoc> = {}): ProjectDoc => ({
  id: "d1", projectId: "p1", workspaceId: "w1", title: "T", body: [], icon: null, position: 1, mentions: [], createdBy: "u1", createdByName: null,
  updatedBy: "u1", updatedByName: null, createdAt: "2026-10-09T10:00:00.000Z", updatedAt: "2026-10-09T10:00:00.000Z", archivedAt: null, canEdit: true, ...over,
});

let content: { title: string; body: DocBlock[] };
let states: DocSaveState[];
let calls: DocSaveInput[];
let respond: (input: DocSaveInput) => Promise<DocSaveResult>;
const flushPromises = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const last = <T,>(list: T[]): T | undefined => list[list.length - 1];

function make() {
  const hooks = { saved: [] as ProjectDoc[], conflict: [] as ProjectDoc[], gone: 0, errors: [] as string[], kept: [] as { title: string; body: DocBlock[]; base: string }[], forgot: 0 };
  const saver = createDocSaver("2026-10-09T10:00:00.000Z", {
    docId: "d1", projectId: "p1",
    save: (input) => { calls.push(input); return respond(input); },
    draft: () => content,
    onState: (s) => states.push(s),
    onSaved: (d) => hooks.saved.push(d),
    onConflict: (d) => hooks.conflict.push(d),
    onGone: () => { hooks.gone++; },
    onError: (why) => hooks.errors.push(why),
    keep: (d) => hooks.kept.push(d),
    forget: () => { hooks.forgot++; },
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

  it("changes made while a save is in flight go in the next save, straight after it; flush resolves when both have landed", async () => {
    let release!: () => void;
    respond = (input) => new Promise((r) => { release = () => r({ status: "saved", doc: doc({ title: input.title, updatedAt: `2026-10-09T10:00:0${++stamp}.000Z` }) }); });
    const { saver } = make();
    content = { title: "A", body: [] };
    saver.touch();
    const first = saver.flush();
    content = { title: "AB", body: [] };
    saver.touch();
    let done = false;
    void saver.flush().then(() => { done = true; });
    expect(calls).toHaveLength(1);
    release();
    await flushPromises();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ title: "AB", baseUpdatedAt: "2026-10-09T10:00:01.000Z" });
    expect(done).toBe(false);
    release();
    await first;
    await flushPromises();
    expect(done).toBe(true);
    expect(saver.dirty).toBe(false);
    vi.advanceTimersByTime(5000);
    await flushPromises();
    expect(calls).toHaveLength(2);
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

  it("checkpoint: the next save is a version of its own (then ordinary again); keep mine is one; reload clears it", async () => {
    const { saver } = make();
    content = { title: "Restored", body: [] };
    saver.touch();
    saver.checkpoint();
    await saver.flush();
    expect(calls[0].checkpoint).toBe(true);
    content = { title: "Restored, then typed", body: [] };
    saver.touch();
    await saver.flush();
    expect(calls[1].checkpoint).toBeUndefined();
    // a restore that changes nothing sends nothing, and leaves no checkpoint waiting
    saver.checkpoint();
    saver.touch();
    await saver.flush();
    expect(calls).toHaveLength(2);
    content = { title: "Next", body: [] };
    saver.touch();
    await saver.flush();
    expect(calls[2].checkpoint).toBeUndefined();
    // keep mine
    const theirs = doc({ title: "Theirs", updatedBy: "u1", updatedAt: "2026-10-09T10:05:00.000Z" });
    respond = () => Promise.resolve({ status: "conflict", doc: theirs });
    content = { title: "Mine", body: [] };
    saver.touch();
    await saver.flush();
    respond = ok;
    await saver.keepMine(theirs.updatedAt);
    expect(calls[4]).toMatchObject({ title: "Mine", baseUpdatedAt: theirs.updatedAt, checkpoint: true });
    // reload theirs: a checkpoint asked for before it doesn't ride on the next ordinary save
    saver.checkpoint();
    saver.hold();
    saver.adopt("2026-10-09T10:09:00.000Z");
    content = { title: "After reload", body: [] };
    saver.touch();
    await saver.flush();
    expect(calls[5].checkpoint).toBeUndefined();
  });

  it("a checkpoint asked for while a save is in flight rides on the next save, not that one", async () => {
    let release!: () => void;
    respond = (input) => new Promise((r) => { release = () => r({ status: "saved", doc: doc({ title: input.title, updatedAt: `2026-10-09T10:00:0${++stamp}.000Z` }) }); });
    const { saver } = make();
    content = { title: "What I had", body: [] };
    saver.touch();
    void saver.flush();
    content = { title: "An old version", body: [] };
    saver.touch();
    saver.checkpoint();
    const all = saver.flush();
    release();
    await flushPromises();
    release();
    await all;
    expect(calls.map((c) => [c.title, !!c.checkpoint])).toEqual([["What I had", false], ["An old version", true]]);
  });

  it("keeps what can't be saved (offline, refused, a conflict) with its base; forgets once the server has it", async () => {
    let fail: Error | null = new TypeError("Failed to fetch");
    respond = (input) => (fail ? Promise.reject(fail) : ok(input));
    const { saver, hooks } = make();
    content = { title: "Train", body: [] };
    saver.touch();
    await saver.flush();
    expect(last(hooks.kept)).toEqual({ title: "Train", body: [], base: "2026-10-09T10:00:00.000Z" });
    fail = new Error("doc too large");
    content = { title: "Train, longer", body: [] };
    saver.touch();
    await saver.flush();
    expect(last(hooks.kept)!.title).toBe("Train, longer");
    fail = null;
    const before = hooks.forgot;
    saver.touch();
    await saver.flush();
    expect(hooks.forgot).toBe(before + 1);
    respond = () => Promise.resolve({ status: "conflict", doc: doc({ updatedAt: "2026-10-09T10:07:00.000Z" }) });
    content = { title: "Clash", body: [] };
    saver.touch();
    await saver.flush();
    expect(last(hooks.kept)!.title).toBe("Clash");
    saver.adopt("2026-10-09T10:07:00.000Z"); // reload theirs
    expect(hooks.forgot).toBe(before + 2);
  });

  it("a doc deleted while open (realtime): no more saves, and nothing kept", async () => {
    const { saver, hooks } = make();
    content = { title: "Gone", body: [] };
    saver.touch();
    saver.markGone();
    expect(saver.gone).toBe(true);
    expect(last(states)).toBe("error");
    await saver.flush();
    vi.advanceTimersByTime(10_000);
    saver.dispose();
    expect(calls).toHaveLength(0);
    expect(hooks.kept).toHaveLength(0);
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

describe("closing the editor", () => {
  it("mid-save: the save in flight lands and the changes typed during it still go, on its base; then nothing's kept", async () => {
    const releases: (() => void)[] = [];
    respond = (input) => new Promise((r) => releases.push(() => r({ status: "saved", doc: doc({ title: input.title, body: input.body, updatedAt: `2026-10-09T10:00:0${++stamp}.000Z` }) })));
    const { saver, hooks } = make();
    content = { title: "A", body: [{ id: "x", type: "p", spans: [{ text: "first" }] }] };
    saver.touch();
    vi.advanceTimersByTime(2000);              // the autosave goes out
    expect(calls).toHaveLength(1);
    content = { title: "A", body: [{ id: "x", type: "p", spans: [{ text: "first and the last words" }] }] };
    saver.touch();                              // typed while it saves
    void saver.flush();                         // blur
    void saver.flush();                         // the editor's cleanup…
    saver.dispose();                            // …and closing
    expect(last(hooks.kept)!.body[0].spans![0].text).toBe("first and the last words");
    releases[0]();
    await flushPromises();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ baseUpdatedAt: "2026-10-09T10:00:01.000Z", body: [{ id: "x", type: "p", spans: [{ text: "first and the last words" }] }] });
    const forgot = hooks.forgot;
    releases[1]();
    await flushPromises();
    expect(saver.dirty).toBe(false);
    expect(hooks.forgot).toBe(forgot + 1);
    expect(hooks.saved).toHaveLength(0);       // no callbacks to an editor that's gone
    vi.advanceTimersByTime(60_000);
    await flushPromises();
    expect(calls).toHaveLength(2);
  });

  it("offline: what's unsaved is kept (with its base); no retries once closed", async () => {
    respond = () => Promise.reject(new TypeError("Failed to fetch"));
    const { saver, hooks } = make();
    content = { title: "T", body: [{ id: "a", type: "p", spans: [{ text: "written on the train" }] }] };
    saver.touch();
    await saver.flush();
    expect(saver.state).toBe("offline");
    content = { title: "T", body: [{ id: "a", type: "p", spans: [{ text: "written on the train, and more" }] }] };
    saver.touch();
    void saver.flush();
    saver.dispose();
    await flushPromises();
    expect(last(hooks.kept)).toEqual({ title: "T", body: content.body, base: "2026-10-09T10:00:00.000Z" });
    const tries = calls.length;
    respond = ok;
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(120_000);
    await flushPromises();
    expect(calls).toHaveLength(tries);
  });

  it("a conflict left open is kept; a refusal too", async () => {
    respond = () => Promise.resolve({ status: "conflict", doc: doc({ title: "Theirs", updatedAt: "2026-10-09T10:05:00.000Z" }) });
    const { saver, hooks } = make();
    content = { title: "Mine", body: [] };
    saver.touch();
    await saver.flush();
    content = { title: "Mine, more", body: [] };
    saver.touch();
    void saver.flush();
    saver.dispose();
    expect(last(hooks.kept)).toMatchObject({ title: "Mine, more", base: "2026-10-09T10:00:00.000Z" });
    expect(calls).toHaveLength(1);
  });

  it("revive after a close tells the editor where things stand", async () => {
    let release!: () => void;
    respond = (input) => new Promise((r) => { release = () => r({ status: "saved", doc: doc({ title: input.title, updatedAt: "2026-10-09T10:00:09.000Z" }) }); });
    const { saver } = make();
    content = { title: "S", body: [] };
    saver.touch();
    void saver.flush();
    saver.dispose();
    release();
    await flushPromises();
    expect(last(states)).toBe("saving");
    saver.revive();
    expect(last(states)).toBe("saved");
  });
});

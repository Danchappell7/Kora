// @vitest-environment node
// Unit tests for the account-deletion photo clean-up (delete-account), run
// against a tiny in-memory stand-in for the supabase-js storage + table API.
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetRemovedAvatar, removeAvatarPhotos, type StorageAdmin } from "./avatars.ts";

const UID = "6f1c2b9e-1111-4a2b-9c3d-000000000001";
const OTHER = "6f1c2b9e-2222-4a2b-9c3d-000000000002";
const url = (path: string) => `https://abc.supabase.co/storage/v1/object/public/avatars/${path}`;

type Err = { message: string } | null;

function fakeAdmin(opts: { files: string[]; avatarUrl?: string | null; listErr?: Err; removeErr?: Err; throwOnList?: boolean }) {
  const objects = new Set(opts.files);
  const profile = { avatar_url: opts.avatarUrl ?? null };
  const calls = { removed: [] as string[][], updates: [] as Record<string, unknown>[] };
  const admin: StorageAdmin = {
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe("avatars");
        return {
          async list(folder: string, o: { limit: number }) {
            if (opts.throwOnList) throw new Error("network down");
            expect(o.limit).toBeGreaterThan(0);
            if (opts.listErr) return { data: null, error: opts.listErr };
            const data = [...objects].filter((p) => p.startsWith(`${folder}/`)).map((p) => ({ name: p.slice(folder.length + 1) }));
            return { data, error: null };
          },
          async remove(paths: string[]) {
            calls.removed.push(paths);
            if (opts.removeErr) return { data: null, error: opts.removeErr };
            paths.forEach((p) => objects.delete(p));
            return { data: [], error: null };
          },
        };
      },
    },
    from: (table: string) => {
      expect(table).toBe("profiles");
      const q = {
        select: () => q,
        eq: (col: string, v: string) => { expect([col, v]).toEqual(["id", UID]); return q; },
        maybeSingle: async () => ({ data: { ...profile }, error: null }),
        update: (patch: Record<string, unknown>) => ({
          eq: async (col: string, v: string) => { expect([col, v]).toEqual(["id", UID]); calls.updates.push(patch); Object.assign(profile, patch); return { error: null }; },
        }),
      };
      return q;
    },
  };
  return { admin, objects, profile, calls };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("removeAvatarPhotos", () => {
  it("removes the person's own face photos and keeps workspace logos and other people's files", async () => {
    const f = fakeAdmin({ files: [`${UID}/avatar-1.png`, `${UID}/avatar-2.webp`, `${UID}/wslogo-ws1-3.png`, `${OTHER}/avatar-9.png`] });
    const removed = await removeAvatarPhotos(f.admin, UID);
    expect(removed.sort()).toEqual([`${UID}/avatar-1.png`, `${UID}/avatar-2.webp`]);
    expect([...f.objects].sort()).toEqual([`${UID}/wslogo-ws1-3.png`, `${OTHER}/avatar-9.png`]);
  });

  it("does nothing (and calls nothing) when there are no photos", async () => {
    const f = fakeAdmin({ files: [`${UID}/wslogo-ws1-3.png`] });
    expect(await removeAvatarPhotos(f.admin, UID)).toEqual([]);
    expect(f.calls.removed).toEqual([]);
  });

  it("never throws: list or remove failures just report nothing removed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await removeAvatarPhotos(fakeAdmin({ files: [`${UID}/avatar-1.png`], listErr: { message: "boom" } }).admin, UID)).toEqual([]);
    expect(await removeAvatarPhotos(fakeAdmin({ files: [`${UID}/avatar-1.png`], removeErr: { message: "boom" } }).admin, UID)).toEqual([]);
    expect(await removeAvatarPhotos(fakeAdmin({ files: [`${UID}/avatar-1.png`], throwOnList: true }).admin, UID)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("refuses an empty user id (would list the bucket root)", async () => {
    const f = fakeAdmin({ files: [`${UID}/avatar-1.png`] });
    expect(await removeAvatarPhotos(f.admin, "")).toEqual([]);
    expect(f.objects.size).toBe(1);
  });
});

describe("forgetRemovedAvatar", () => {
  it("clears the profile photo when it pointed at a removed file", async () => {
    const f = fakeAdmin({ files: [], avatarUrl: url(`${UID}/avatar-1.png`) });
    await forgetRemovedAvatar(f.admin, UID, [`${UID}/avatar-1.png`]);
    expect(f.profile.avatar_url).toBeNull();
  });

  it("leaves a Google photo, a workspace logo URL or an unrelated file alone", async () => {
    for (const avatarUrl of ["https://lh3.googleusercontent.com/a/photo.jpg", url(`${UID}/wslogo-ws1-3.png`), url(`${OTHER}/avatar-1.png`), null]) {
      const f = fakeAdmin({ files: [], avatarUrl });
      await forgetRemovedAvatar(f.admin, UID, [`${UID}/avatar-1.png`]);
      expect(f.calls.updates).toEqual([]);
    }
  });

  it("does nothing when no photo was removed", async () => {
    const f = fakeAdmin({ files: [], avatarUrl: url(`${UID}/avatar-1.png`) });
    await forgetRemovedAvatar(f.admin, UID, []);
    expect(f.calls.updates).toEqual([]);
  });
});

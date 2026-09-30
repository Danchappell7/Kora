import { describe, it, expect, vi, afterEach } from "vitest";
import {
  avatarMime, avatarExtension, avatarProblem, avatarObjectPath, prepareAvatarFile, removeAvatarObjects,
  AVATAR_ACCEPT, AVATAR_MAX_BYTES, AVATAR_MESSAGES,
} from "./avatarUpload";

const UID = "6f1c0d2e-1111-4a4a-9b9b-222233334444";
const BASE = "https://abcd.supabase.co/storage/v1/object/public/avatars";
const file = (name: string, type: string, size = 1024) => new File([new Uint8Array(size)], name, { type });

afterEach(() => { vi.restoreAllMocks(); });

describe("avatar type rules", () => {
  it("accepts exactly PNG, JPEG, GIF and WebP", () => {
    expect(AVATAR_ACCEPT.split(",").sort()).toEqual(["image/gif", "image/jpeg", "image/png", "image/webp"]);
    expect(avatarExtension("image/png")).toBe("png");
    expect(avatarExtension("image/jpeg")).toBe("jpg");
    expect(avatarExtension("image/gif")).toBe("gif");
    expect(avatarExtension("image/webp")).toBe("webp");
    expect(avatarExtension("image/svg+xml")).toBeNull();
    expect(avatarExtension("text/html")).toBeNull();
  });

  it("normalises odd MIME types and falls back to the file name", () => {
    expect(avatarMime({ type: "image/jpg" })).toBe("image/jpeg");
    expect(avatarMime({ type: "IMAGE/PNG" })).toBe("image/png");
    expect(avatarMime({ type: "", name: "IMG_0042.HEIC" })).toBe("image/heic");
    expect(avatarMime({ type: "", name: "noext" })).toBe("");
  });

  it("explains what's wrong in plain words", () => {
    expect(avatarProblem({ type: "image/svg+xml", size: 10 })).toBe(AVATAR_MESSAGES.svg);
    expect(avatarProblem({ type: "image/heic", size: 10 })).toBe(AVATAR_MESSAGES.heic);
    expect(avatarProblem({ type: "text/html", size: 10 })).toBe(AVATAR_MESSAGES.type);
    expect(avatarProblem({ type: "image/png", size: 0 })).toBe(AVATAR_MESSAGES.empty);
    expect(avatarProblem({ type: "image/png", size: AVATAR_MAX_BYTES + 1 })).toBe(AVATAR_MESSAGES.size);
    expect(avatarProblem({ type: "image/png", size: AVATAR_MAX_BYTES })).toBeNull();
  });
});

describe("prepareAvatarFile", () => {
  it("takes the extension from the MIME type, not the file name", async () => {
    const out = await prepareAvatarFile(file("party.html", "image/gif"));
    expect(out.name).toBe("avatar.gif");
    expect(out.type).toBe("image/gif");
  });

  it("never uploads a still photo's original bytes (they can carry GPS) when the browser can't redraw it", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await expect(prepareAvatarFile(file("me.jpeg.exe", "image/jpeg", 2048))).rejects.toThrow(AVATAR_MESSAGES.prepare);
    // small PNG and WebP files are redrawn too, not passed through
    await expect(prepareAvatarFile(file("tiny.png", "image/png", 200))).rejects.toThrow(AVATAR_MESSAGES.prepare);
    await expect(prepareAvatarFile(file("tiny.webp", "image/webp", 200))).rejects.toThrow(AVATAR_MESSAGES.prepare);
  });

  it("uploads the redrawn image, named from its type", async () => {
    const ctx = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
      cb(new Blob([new Uint8Array(321)], { type: type ?? "image/png" }));
    });
    // jsdom never decodes images, so stand in a 1024x768 photo
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:photo");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const RealImage = window.Image;
    class FakeImage { naturalWidth = 1024; naturalHeight = 768; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(_: string) { setTimeout(() => this.onload?.(), 0); } }
    window.Image = FakeImage as unknown as typeof Image;
    try {
      const small = await prepareAvatarFile(file("tiny.png", "image/png", 200));
      expect(small.name).toBe("avatar.png");
      expect(small.size).toBe(321); // the redrawn bytes, not the original 200
      const photo = await prepareAvatarFile(file("IMG_0001.JPG", "image/jpeg", 4096));
      expect(photo.name).toBe("avatar.jpg");
      expect(photo.type).toBe("image/jpeg");
      expect(photo.size).toBe(321);
      // shorter side scaled to 512
      expect(ctx.drawImage).toHaveBeenLastCalledWith(expect.anything(), 0, 0, 683, 512);
    } finally {
      window.Image = RealImage;
    }
  });

  it("refuses SVG, oversized files, and HEIC this browser can't convert", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await expect(prepareAvatarFile(file("logo.svg", "image/svg+xml"))).rejects.toThrow(AVATAR_MESSAGES.svg);
    await expect(prepareAvatarFile(file("big.png", "image/png", AVATAR_MAX_BYTES + 1))).rejects.toThrow(AVATAR_MESSAGES.size);
    await expect(prepareAvatarFile(file("IMG_1.HEIC", "image/heic"))).rejects.toThrow(AVATAR_MESSAGES.heic);
    await expect(prepareAvatarFile(file("IMG_2.HEIC", "image/heic", AVATAR_MAX_BYTES + 1))).rejects.toThrow(AVATAR_MESSAGES.size);
  });
});

describe("avatarObjectPath", () => {
  it("finds this user's uploaded avatars", () => {
    expect(avatarObjectPath(`${BASE}/${UID}/avatar-1727000000000.jpg`, UID)).toBe(`${UID}/avatar-1727000000000.jpg`);
    expect(avatarObjectPath(`${BASE}/${UID}/avatar-1.png?t=123`, UID)).toBe(`${UID}/avatar-1.png`);
  });

  it("never points at anything else", () => {
    expect(avatarObjectPath(`${BASE}/someone-else/avatar-1.jpg`, UID)).toBeNull();          // another user
    expect(avatarObjectPath(`${BASE}/${UID}/wslogo-ws1-1.png`, UID)).toBeNull();            // a workspace logo
    expect(avatarObjectPath(`${BASE}/${UID}/nested/avatar-1.png`, UID)).toBeNull();         // unexpected shape
    expect(avatarObjectPath("https://lh3.googleusercontent.com/a/abc=s96-c", UID)).toBeNull(); // Google photo
    expect(avatarObjectPath("blob:http://localhost/123", UID)).toBeNull();
    expect(avatarObjectPath("not a url", UID)).toBeNull();
    expect(avatarObjectPath(null, UID)).toBeNull();
    expect(avatarObjectPath(`${BASE}/${UID}/avatar-1.jpg`, null)).toBeNull();
  });
});

describe("removeAvatarObjects", () => {
  it("is a quiet no-op in demo mode", async () => {
    await expect(removeAvatarObjects([`${BASE}/${UID}/avatar-1.jpg`], UID)).resolves.toBeUndefined();
  });
});

/* ============================================================
   KANBO — profile photo helpers (Settings → Your profile)
   - Mirrors the avatars bucket's allow-list on the client: PNG, JPEG, GIF
     or WebP, up to 5 MB. SVG (can carry script) and HEIC (Chrome can't
     show it) are refused with a clear message.
   - PNG, JPEG and WebP photos are always redrawn on a canvas (downscaled
     when large) and re-encoded before upload, which drops embedded metadata
     such as the GPS location a phone photo carries. That matters because
     the bucket is public. If the browser can't redraw the image we refuse
     it rather than upload the original bytes. GIFs go up unchanged so they
     keep their animation.
   - The file extension comes from the MIME type, never from the name the
     user's file happens to have.
   - Replaced photos are removed from storage (only our own
     "<uid>/avatar-*" objects; workspace logos share the bucket and are
     never touched).
   ============================================================ */
import { supabase } from "./supabase";

export const AVATAR_BUCKET = "avatars";
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
/** Shorter side of a re-encoded photo, in px (sharp at 2x on the largest avatar we draw). */
export const AVATAR_EDGE = 512;

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
/** For `<input type="file" accept>`. Leaving HEIC out also makes iPhones hand over a JPEG. */
export const AVATAR_ACCEPT = Object.keys(MIME_EXT).join(",");

const NAME_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", svg: "image/svg+xml",
};

/** Normalised MIME type. Falls back to the file name when the browser reports none (e.g. HEIC on Windows). */
export function avatarMime(file: { type?: string; name?: string }): string {
  const t = (file.type || "").trim().toLowerCase();
  if (t === "image/jpg" || t === "image/pjpeg") return "image/jpeg";
  if (t) return t;
  const ext = (file.name?.split(".").pop() || "").toLowerCase();
  return NAME_MIME[ext] ?? "";
}

/** File extension for an allowed MIME type, or null when the type isn't allowed. */
export function avatarExtension(mime: string): string | null {
  return MIME_EXT[mime.trim().toLowerCase()] ?? null;
}

const isHeic = (mime: string) => mime === "image/heic" || mime === "image/heif";

export const AVATAR_MESSAGES = {
  svg: "SVG images can't be used as a profile photo. Choose a PNG, JPG, GIF or WebP.",
  heic: "This browser can't read HEIC photos. Choose a JPG or PNG instead.",
  type: "Choose a PNG, JPG, GIF or WebP image.",
  size: "That image is over 5 MB. Choose a smaller one.",
  empty: "That file is empty. Choose another image.",
  unreadable: "Couldn't read that image. Choose another PNG, JPG or WebP.",
  prepare: "Your browser couldn't prepare that image. Try another image, or a different browser.",
  large: "That image is too large to use as a profile photo. Choose a smaller one.",
} as const;

/** Why this file can't be uploaded as it is, in words for the user, or null when it's fine. */
export function avatarProblem(file: { type?: string; size: number; name?: string }): string | null {
  const mime = avatarMime(file);
  if (mime === "image/svg+xml") return AVATAR_MESSAGES.svg;
  if (isHeic(mime)) return AVATAR_MESSAGES.heic;
  if (!avatarExtension(mime)) return AVATAR_MESSAGES.type;
  if (file.size <= 0) return AVATAR_MESSAGES.empty;
  if (file.size > AVATAR_MAX_BYTES) return AVATAR_MESSAGES.size;
  return null;
}

/** Re-wraps bytes as `avatar.<ext>` with a trusted type, so the upload path's extension matches the MIME type. */
function asAvatarFile(bytes: Blob, mime: string): File {
  return new File([bytes], `avatar.${avatarExtension(mime) ?? "png"}`, { type: mime });
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const finish = (ok: boolean) => {
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      if (ok) resolve(img); else reject(new Error("Couldn't read that image."));
    };
    const timer = window.setTimeout(() => finish(false), 10000);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

/**
 * Redraw a still image on a canvas (downscaled when large) and encode it
 * afresh, so none of the original file's metadata survives. Drawing an <img>
 * applies EXIF orientation, so sideways phone photos come out upright.
 * Throws an Error with a message for the user when the browser can't do it;
 * the original bytes are never uploaded instead.
 */
async function reencode(file: File, mime: string): Promise<File> {
  let ctx: CanvasRenderingContext2D | null = null;
  const canvas = typeof document === "undefined" ? null : document.createElement("canvas");
  try { ctx = canvas?.getContext("2d") ?? null; } catch { ctx = null; }
  if (!canvas || !ctx) throw new Error(isHeic(mime) ? AVATAR_MESSAGES.heic : AVATAR_MESSAGES.prepare);
  const img = await loadImage(file).catch(() => null);
  const w = img?.naturalWidth ?? 0, h = img?.naturalHeight ?? 0;
  if (!img || !w || !h) throw new Error(isHeic(mime) ? AVATAR_MESSAGES.heic : AVATAR_MESSAGES.unreadable);
  const scale = Math.min(1, AVATAR_EDGE / Math.min(w, h));
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  // keep transparency for PNG/WebP; everything else (JPEG, HEIC) becomes JPEG
  const target = mime === "image/png" || mime === "image/webp" ? mime : "image/jpeg";
  if (target === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((res) => {
    try { canvas.toBlob(res, target, 0.9); } catch { res(null); }
  });
  // a browser that can't encode the requested type hands back PNG, which is fine
  const outMime = blob ? avatarMime(blob) : "";
  if (!blob || !avatarExtension(outMime) || blob.size <= 0) throw new Error(AVATAR_MESSAGES.prepare);
  if (blob.size > AVATAR_MAX_BYTES) throw new Error(AVATAR_MESSAGES.large);
  return asAvatarFile(blob, outMime);
}

/**
 * Validate a picked file and turn it into what we upload. Throws an Error
 * whose message is ready to show the user.
 */
export async function prepareAvatarFile(file: File): Promise<File> {
  const mime = avatarMime(file);
  if (isHeic(mime)) {
    // never uploaded as HEIC, but a browser that can decode it (Safari)
    // turns it into a JPEG below
    if (file.size <= 0) throw new Error(AVATAR_MESSAGES.empty);
    if (file.size > AVATAR_MAX_BYTES) throw new Error(AVATAR_MESSAGES.size);
  } else {
    const problem = avatarProblem(file);
    if (problem) throw new Error(problem);
  }
  if (mime === "image/gif") return asAvatarFile(file, mime); // keep the animation
  return reencode(file, mime);
}

/**
 * The storage path of one of this user's uploaded avatars, parsed from its
 * public URL. Null for anything else: other people's files, workspace logos,
 * Google profile pictures, blob: previews.
 */
export function avatarObjectPath(url: string | null | undefined, uid: string | null | undefined): string | null {
  if (!url || !uid) return null;
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return null; }
  const marker = `/storage/v1/object/public/${AVATAR_BUCKET}/`;
  const at = pathname.indexOf(marker);
  if (at < 0) return null;
  let path: string;
  try { path = decodeURIComponent(pathname.slice(at + marker.length)); } catch { return null; }
  const prefix = `${uid}/`;
  if (!path.startsWith(prefix)) return null;
  return /^avatar-[^/]+$/.test(path.slice(prefix.length)) ? path : null;
}

/** Best-effort delete of replaced avatars. Never throws: a leftover file is harmless, a failed save isn't. */
export async function removeAvatarObjects(urls: (string | null | undefined)[], uid: string | null | undefined): Promise<void> {
  if (!supabase || !uid) return;
  const paths = [...new Set(urls.map((u) => avatarObjectPath(u, uid)).filter((p): p is string => !!p))];
  if (!paths.length) return;
  try { await supabase.storage.from(AVATAR_BUCKET).remove(paths); } catch { /* cleanup only */ }
}

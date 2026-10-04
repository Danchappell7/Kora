/* ============================================================
   KANBO — installable app: the browser's install prompt.         [f8-push-pwa]
   Chrome/Edge/Android fire `beforeinstallprompt` once, early — often
   before React mounts — so main.tsx calls listenForInstallPrompt() at
   startup and this module keeps the event for <InstallPrompt>. iOS has
   no prompt: it gets an "Add to Home Screen" hint instead.
   Holding the event (preventDefault) swaps Chrome's own mini-infobar on
   phones for Kanbo's quieter nudge; the address-bar install button stays.
   ============================================================ */

/** installed: running standalone; available: the browser offered a prompt;
 *  ios: Safari on iPhone/iPad (Share › Add to Home Screen); unavailable: none of these. */
export type InstallState = "installed" | "available" | "ios" | "unavailable";

/** The non-standard event Chromium fires when the app can be installed. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installedHere = false;
let listening = false;
const listeners = new Set<(s: InstallState) => void>();

function emit(): void {
  const s = installState();
  for (const fn of [...listeners]) {
    try { fn(s); } catch { /* a listener's problem isn't ours */ }
  }
}

const media = (q: string): boolean => {
  try { return typeof window !== "undefined" && !!window.matchMedia?.(q).matches; } catch { return false; }
};

/** Start listening for beforeinstallprompt / appinstalled. Call once, before rendering. Safe anywhere (no-op without window). */
export function listenForInstallPrompt(): void {
  if (listening || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  listening = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep it for our own button instead of the browser's banner
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installedHere = true;
    emit();
  });
  // opened from the dock / home screen in this same tab (or back)
  try {
    window.matchMedia?.("(display-mode: standalone)")?.addEventListener?.("change", () => emit());
  } catch { /* old browsers */ }
}

/** Is the app running installed (display-mode: standalone, or iOS navigator.standalone)? */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (media("(display-mode: standalone)") || media("(display-mode: window-controls-overlay)") || media("(display-mode: minimal-ui)")) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone, iPod or iPad (iPadOS reports a Mac with touch). */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

/** Which desktop/mobile browser this is, for "how to install" copy. */
export type BrowserFamily = "safari-mac" | "firefox" | "chromium" | "other";
export function browserFamily(): BrowserFamily {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  if (/Firefox\//i.test(ua) && !/Seamonkey/i.test(ua)) return "firefox";
  if (/(Chrome|Chromium|CriOS|Edg|OPR|SamsungBrowser)\//i.test(ua)) return "chromium";
  if (/Safari\//i.test(ua) && /Macintosh/i.test(ua)) return "safari-mac";
  return "other";
}

export function installState(): InstallState {
  if (installedHere || isStandalone()) return "installed";
  if (deferred) return "available";
  if (isIos()) return "ios";
  return "unavailable";
}

/** Show the browser's install prompt (only when installState() is "available"). */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const e = deferred;
  if (!e) return "unavailable";
  deferred = null; // a prompt event can be used once
  try {
    await e.prompt();
    const choice = await e.userChoice;
    if (choice.outcome === "accepted") installedHere = true;
    emit();
    return choice.outcome === "accepted" ? "accepted" : "dismissed";
  } catch {
    emit();
    return "unavailable";
  }
}

/** Told when the state changes (prompt captured, app installed). Returns an unsubscribe. */
export function onInstallStateChange(fn: (s: InstallState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tests only: forget everything this module has seen. */
export function __resetInstallForTests(): void {
  deferred = null;
  installedHere = false;
  listeners.clear();
}

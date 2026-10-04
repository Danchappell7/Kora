/* ============================================================
   KANBO — installable app: the browser's install prompt.         [f8-push-pwa]
   Chrome/Edge/Android fire `beforeinstallprompt` once, early — often
   before React mounts — so main.tsx calls listenForInstallPrompt() at
   startup and this module keeps the event for <InstallPrompt>. iOS has
   no prompt: it gets an "Add to Home Screen" hint instead.
   CONTRACT STUB — f8 replaces the bodies, keeps every exported name/signature.
   ============================================================ */

/** installed: running standalone; available: the browser offered a prompt;
 *  ios: Safari on iPhone/iPad (Share › Add to Home Screen); unavailable: none of these. */
export type InstallState = "installed" | "available" | "ios" | "unavailable";

/** Start listening for beforeinstallprompt / appinstalled. Call once, before rendering. Safe anywhere (no-op without window). */
export function listenForInstallPrompt(): void {
  /* stub: f8 */
}

/** Is the app running installed (display-mode: standalone, or iOS navigator.standalone)? */
export function isStandalone(): boolean {
  return false;
}

export function installState(): InstallState {
  return "unavailable";
}

/** Show the browser's install prompt (only when installState() is "available"). */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  return "unavailable";
}

/** Told when the state changes (prompt captured, app installed). Returns an unsubscribe. */
export function onInstallStateChange(fn: (s: InstallState) => void): () => void {
  void fn;
  return () => {};
}

import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FullLoader } from "./components/FullLoader";
import { initMonitoring } from "./lib/monitoring";
import { listenForInstallPrompt } from "./lib/install";
import { applyPublicTheme, publicFormTokenFromPath } from "./lib/publicPage";
import { prefetch } from "./lib/lazyLoad";
import { isSupabaseConfigured } from "./lib/backend";
import { applyAppearance, loadAppearance } from "./lib/appearance";
import {
  Root, PrivacyPolicy, Terms, PublicFormPage, likelySignedIn,
  rootChunk, appChunk, signInChunk, adminChunk, legalChunk, publicFormChunk,
} from "./entryChunks";
import "./styles/globalSheets";
import "./styles/kanbo.css";

initMonitoring();
// the browser offers "Install app" once, often before React mounts: keep it for <InstallPrompt>
listenForInstallPrompt();

// Hidden internal route: /admin loads the standalone admin app, never the
// consumer product. Everything else loads Kanbo as normal.
const path = window.location.pathname.replace(/\/+$/, "");
const isAdminRoute = path === "/admin";
// Public legal pages — standalone, no auth, so the URLs are stable for Google
// OAuth verification and footer links.
const legal = path === "/privacy" ? "privacy" : path === "/terms" ? "terms" : null;
// Public request forms: /f/<token> is a standalone page for people without an
// account — no auth, no app shell (f9 owns this route and src/public/).
const publicFormToken = publicFormTokenFromPath(path);
// Paper unless the visitor's system is dark (never the app's saved theme), set
// before the first paint so the page doesn't flash Navy while its code loads
if (publicFormToken !== null) applyPublicTheme();

// Each page is its own chunk (see entryChunks): ask for this one's now, all at
// once, rather than one after another as React reaches them. Root (the session)
// always; then the app for someone who's signed in, the sign-in site for anyone else.
if (publicFormToken !== null) prefetch(publicFormChunk);
else if (legal) prefetch(legalChunk);
else {
  // the saved look (accent, text size, density) from the first frame: the app used to apply
  // it as it mounted under every page but /admin; it now mounts once someone's signed in
  if (!isAdminRoute) applyAppearance(loadAppearance());
  prefetch(rootChunk);
  let storage: Storage | null = null;
  try { storage = window.localStorage; } catch { /* blocked */ }
  if (isAdminRoute) prefetch(adminChunk);
  else prefetch(likelySignedIn({ configured: isSupabaseConfigured, storage, href: window.location.href }) ? appChunk : signInChunk);
}

const root = createRoot(document.getElementById("root")!);

// Each call builds a fresh element tree, so React re-renders every
// (unmemoised) component — which is how views pick up a new "today" from the
// live clock below without threading a prop through the whole app. State is
// kept (same component types in the same places), but components declared
// inside another component's body remount, so this runs once per day change,
// never on a timer.
function renderApp(): void {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <ToastProvider>
          {publicFormToken !== null ? (
            <Suspense fallback={null}><PublicFormPage token={publicFormToken} /></Suspense>
          ) : legal ? (
            <Suspense fallback={null}>{legal === "privacy" ? <PrivacyPolicy /> : <Terms />}</Suspense>
          ) : (
            <Suspense fallback={isAdminRoute ? null : <FullLoader />}><Root admin={isAdminRoute} /></Suspense>
          )}
        </ToastProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}
renderApp();

// Live clock: KANBO_TODAY / NOW_MIN are refreshed every minute and when the
// tab wakes. When the date changes the app re-renders once — so a tab left
// open overnight shows the right "Today", overdue flags and date presets the
// next morning. Minute-level updates (Plan's now-line) go only to components
// that call useNowMin(). (Loaded with the app's code: public pages never need it.)
if (!legal && publicFormToken === null) {
  import("./lib/liveClock").then(({ startLiveClock }) => startLiveClock(renderApp), () => { /* the app's own load reports it */ });
}

// PWA: register the service worker in production for instant loads + offline
// shell. Network-first for HTML means new deploys are picked up immediately.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* non-fatal */ });
  });
}

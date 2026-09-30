import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AdminApp } from "./admin/AdminApp";
import { PrivacyPolicy, Terms } from "./components/Legal";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initMonitoring } from "./lib/monitoring";
import { startLiveClock } from "./lib/liveClock";
import "./styles/kanbo.css";

initMonitoring();

// Hidden internal route: /admin loads the standalone admin app, never the
// consumer product. Everything else loads Kanbo as normal.
const path = window.location.pathname.replace(/\/+$/, "");
const isAdminRoute = path === "/admin";
// Public legal pages — standalone, no auth, so the URLs are stable for Google
// OAuth verification and footer links.
const legal = path === "/privacy" ? "privacy" : path === "/terms" ? "terms" : null;

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
          {legal === "privacy" ? <PrivacyPolicy /> : legal === "terms" ? <Terms /> : (
            <AuthProvider>
              {isAdminRoute ? <AdminApp /> : <App />}
            </AuthProvider>
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
// that call useNowMin().
if (!legal) startLiveClock(renderApp);

// PWA: register the service worker in production for instant loads + offline
// shell. Network-first for HTML means new deploys are picked up immediately.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* non-fatal */ });
  });
}

/* ============================================================
   KANBO — the product's front door, loaded straight after the entry:
   the session (AuthProvider), then exactly one of
     • a password or confirmation link   UpdatePasswordScreen
     • the sign-in site                  PublicSite
     • an AI app asking to connect       OAuthConsentPage (its own chunk)
     • the app                           App (its own chunk)
     • /admin                            AdminApp
   in the same order App checks them (App keeps its own checks too).
   So a visitor who isn't signed in never downloads the app, and a
   signed-in person never downloads the sign-in site. While the
   session is restored, and while either one's code arrives, the app's
   loading silhouette shows, as it always has.
   ============================================================ */
import { Suspense, useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { FullLoader } from "./components/FullLoader";
import { AdminApp, App, OAuthConsentPage, PublicSite, UpdatePasswordScreen } from "./entryChunks";
import { forgetOAuthRequest, isOAuthAuthorizePath, takeOAuthRequest } from "./lib/oauthRequest";
import { rememberSlackLink, slackLinkTokenFromUrl } from "./lib/slackLinkToken";

export default function Root({ admin = false }: { admin?: boolean }) {
  return (
    <AuthProvider>
      {admin ? <Suspense fallback={null}><AdminApp /></Suspense> : <Gate />}
    </AuthProvider>
  );
}

export function Gate() {
  const auth = useAuth();
  // 0049: a Slack app link (/link/slack?t=…) opened signed out: keep its token through signing in
  // (a Google sign-in comes back to the home page), so the app opens "Link Slack…" straight after
  const signedOut = auth.configured && !auth.loading && !auth.user;
  useEffect(() => {
    if (!signedOut) return;
    const t = slackLinkTokenFromUrl(window.location.href);
    if (t) rememberSlackLink(t);
  }, [signedOut]);
  // 0050: an AI app's "connect to Kanbo" (/oauth/authorize?…): kept through signing in, out of the
  // address bar at once, then asked instead of opening the app. Null: nobody's asking.
  const [oauthQuery, setOauthQuery] = useState<string | null>(takeOAuthRequest);
  const closeOAuth = () => {
    forgetOAuthRequest();
    setOauthQuery(null);
    if (isOAuthAuthorizePath(window.location.pathname)) {
      try { window.history.replaceState(window.history.state, "", "/"); } catch { /* not a browser */ }
    }
  };
  if (auth.recovery) return <Suspense fallback={<FullLoader />}><UpdatePasswordScreen /></Suspense>;
  // still restoring the session: a loader, never a flash of the marketing site
  if (auth.configured && auth.loading) return <FullLoader />;
  if (auth.configured && !auth.user) return <Suspense fallback={<FullLoader />}><PublicSite /></Suspense>;
  if (oauthQuery !== null) return <Suspense fallback={<FullLoader />}><OAuthConsentPage query={oauthQuery} email={auth.user?.email ?? null} onClose={closeOAuth} /></Suspense>;
  return <Suspense fallback={<FullLoader />}><App /></Suspense>;
}

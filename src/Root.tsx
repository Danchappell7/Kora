/* ============================================================
   KANBO — the product's front door, loaded straight after the entry:
   the session (AuthProvider), then exactly one of
     • a password or confirmation link   UpdatePasswordScreen
     • the sign-in site                  PublicSite
     • the app                           App (its own chunk)
     • /admin                            AdminApp
   in the same order App checks them (App keeps its own checks too).
   So a visitor who isn't signed in never downloads the app, and a
   signed-in person never downloads the sign-in site. While the
   session is restored, and while either one's code arrives, the app's
   loading silhouette shows, as it always has.
   ============================================================ */
import { Suspense } from "react";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { FullLoader } from "./components/FullLoader";
import { AdminApp, App, PublicSite, UpdatePasswordScreen } from "./entryChunks";

export default function Root({ admin = false }: { admin?: boolean }) {
  return (
    <AuthProvider>
      {admin ? <Suspense fallback={null}><AdminApp /></Suspense> : <Gate />}
    </AuthProvider>
  );
}

export function Gate() {
  const auth = useAuth();
  if (auth.recovery) return <Suspense fallback={<FullLoader />}><UpdatePasswordScreen /></Suspense>;
  // still restoring the session: a loader, never a flash of the marketing site
  if (auth.configured && auth.loading) return <FullLoader />;
  if (auth.configured && !auth.user) return <Suspense fallback={<FullLoader />}><PublicSite /></Suspense>;
  return <Suspense fallback={<FullLoader />}><App /></Suspense>;
}

/* ============================================================
   KANBO — what the first download can load next. The entry itself
   (main.tsx) is only React, the error boundary, toasts, monitoring and
   the stylesheet; each kind of page is its own chunk:
     /privacy, /terms          Legal
     /f/<token>                the public request form
     everything else           Root: the session, then the sign-in
                               site (signed out), the app (signed in)
                               or /admin
   so a public page never downloads the app, and a visitor who isn't
   signed in never downloads it either.
   ============================================================ */
import { chunk, lazyComponent } from "./lib/lazyLoad";

export const rootChunk = chunk(() => import("./Root"));
export const appChunk = chunk(() => import("./App"));
export const signInChunk = chunk(() => import("./auth/LoginScreen"));
export const adminChunk = chunk(() => import("./admin/AdminApp"));
export const legalChunk = chunk(() => import("./components/Legal"));
export const publicFormChunk = chunk(() => import("./public/PublicFormPage"));

export const Root = lazyComponent(rootChunk, (m) => m.default, "Root");
export const App = lazyComponent(appChunk, (m) => m.default, "App");
export const PublicSite = lazyComponent(signInChunk, (m) => m.PublicSite, "PublicSite");
export const UpdatePasswordScreen = lazyComponent(signInChunk, (m) => m.UpdatePasswordScreen, "UpdatePasswordScreen");
export const PendingApproval = lazyComponent(signInChunk, (m) => m.PendingApproval, "PendingApproval");
export const AdminApp = lazyComponent(adminChunk, (m) => m.AdminApp, "AdminApp");
export const PrivacyPolicy = lazyComponent(legalChunk, (m) => m.PrivacyPolicy, "PrivacyPolicy");
export const Terms = lazyComponent(legalChunk, (m) => m.Terms, "Terms");
export const PublicFormPage = lazyComponent(publicFormChunk, (m) => m.default, "PublicFormPage");

/** A stored Supabase session (supabase-js keeps it as sb-<ref>-auth-token), or an
 *  OAuth return that's about to become one. Demo mode (no backend) is always "in". */
export function likelySignedIn(opts: { configured: boolean; storage?: Pick<Storage, "length" | "key"> | null; href?: string }): boolean {
  if (!opts.configured) return true;
  try {
    const s = opts.storage;
    if (s) for (let i = 0; i < s.length; i++) if (/^sb-.+-auth-token$/.test(s.key(i) ?? "")) return true;
  } catch { /* storage blocked */ }
  const href = opts.href ?? "";
  return /[?&]code=|[#&]access_token=/.test(href);
}

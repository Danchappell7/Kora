/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Web push (0043): the VAPID public key, base64url. Unset = push is hidden. Public by design (never the private key). */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
  /** Sentry (w9): the project's DSN. Unset = error reporting is off. Public by design. */
  readonly VITE_SENTRY_DSN?: string;
  /** Sentry (w9): the share of page loads and route changes timed, 0–1 (default 0.1 in production, 0.5 in previews). */
  readonly VITE_SENTRY_TRACES_RATE?: string;
  /** The environment name for Sentry ("production", "preview" …); defaults to Vercel's VERCEL_ENV. */
  readonly VITE_APP_ENV?: string;
  /** "true" once the Google provider is set up in Supabase: shows "Continue with Google". */
  readonly VITE_ENABLE_GOOGLE?: string;
  /** Google's `hd` hint (w9): a company domain to show first in Google's account chooser, or "off".
   *  Unset = the one auto-approved company domain, when there is exactly one (rpc sign_in_hints). */
  readonly VITE_GOOGLE_HD?: string;
}

/** The running build (vite.config.ts → src/lib/buildInfo.ts buildInfoFromEnv). Read it through BUILD_INFO. */
declare const __KANBO_BUILD__: {
  release: string | null;
  builtAt: string | null;
  vercelEnv: string | null;
  branch: string | null;
  repo: string | null;
} | undefined;

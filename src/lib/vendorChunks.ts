/* ============================================================
   KANBO — the build's vendor chunks (vite.config.ts manualChunks).
   Third-party code goes in long-lived chunks of its own, so an app
   deploy never changes their file names or busts their cache: React,
   Supabase and Sentry each get one, anything else "vendor". The app's
   own code returns undefined and is split where it's imported
   (entryChunks.ts, lazyViews.ts). Rollup's CommonJS helper goes with
   React, which needs it, so no vendor chunk ever imports an app chunk
   (whose name changes every deploy).
   ============================================================ */
export function vendorChunk(id: string): string | undefined {
  if (id.includes("commonjsHelpers")) return "react";
  const m = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id);
  if (!m) return undefined;
  const pkg = m[1].replace(/\\/g, "/");
  if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler") return "react";
  if (pkg.startsWith("@supabase/") || pkg === "iceberg-js" || pkg === "tslib") return "supabase";
  if (pkg.startsWith("@sentry/") || pkg.startsWith("@sentry-internal/") || pkg === "hoist-non-react-statics" || pkg === "react-is") return "sentry";
  return "vendor";
}

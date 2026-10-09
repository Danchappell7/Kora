/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { buildInfoFromEnv } from "./src/lib/buildInfo";

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // the running build (commit, build time, Vercel environment): Sentry's release
  // tag and /admin › System status. Read through src/lib/buildInfo.ts BUILD_INFO.
  define: {
    __KANBO_BUILD__: JSON.stringify(buildInfoFromEnv(process.env, { isBuild: command === "build" })),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          supabase: ["@supabase/supabase-js"],
          sentry: ["@sentry/react"],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // run tests in demo mode (no Supabase) regardless of a local .env;
    // billing on so the trial/paywall math is exercised by Billing.test.ts
    env: { VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "", VITE_BILLING_ENABLED: "true" },
    coverage: { provider: "v8", reporter: ["text", "html"] },
    // lets `--maxWorkers=N` cap a busy machine on its own (with the default minimum,
    // a small cap fails: "minThreads and maxThreads must not conflict")
    minWorkers: 1,
  },
}));

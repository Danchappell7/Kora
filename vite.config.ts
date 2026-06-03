/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
    // run tests in demo mode (no Supabase) regardless of a local .env
    env: { VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" },
    coverage: { provider: "v8", reporter: ["text", "html"] },
  },
});

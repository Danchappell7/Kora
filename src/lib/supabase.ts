/* ============================================================
   KANBO — Supabase client
   If the env vars aren't set, the app runs in in-memory "demo
   mode" (see data/store.ts). Set both to switch to the real
   backend — no code change required.
   ============================================================ */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isSupabaseConfigured } from "./backend";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export { isSupabaseConfigured };

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

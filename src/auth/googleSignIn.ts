/* ============================================================
   KANBO — Sign in with Google: the pure parts.               [w9-ops]
   • googleSignInEnabled()   VITE_ENABLE_GOOGLE=true (read at render, so tests can stub it)
   • the `hd` hint           Google's account chooser shows one company's accounts
                             first. VITE_GOOGLE_HD sets it ("off" turns it off);
                             unset, it's the ONE auto-approved company domain
                             (Admin › Auto-approved company domains) when there
                             is exactly one, from rpc sign_in_hints() — cached
                             for six hours on this device. A hint only: anyone
                             can still pick another account ("Use another Google
                             account"), and it never decides who gets in.
   • provider readiness      GET /auth/v1/settings says whether the Google
                             provider is switched on in Supabase; when it says
                             no, the button stays hidden (instead of sending
                             people to a raw "provider is not enabled" page).
   • queryParams             prompt=select_account (shared desks: always ask
                             which account) + hd.
   ============================================================ */

/** Free email providers: never an `hd` hint (it would say "@gmail.com accounts first"). */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.co.uk", "msn.com",
  "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "btinternet.com",
]);
const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

type Env = Record<string, string | boolean | undefined>;
const viteEnv = (): Env => import.meta.env as unknown as Env;

export function googleSignInEnabled(env: Env = viteEnv()): boolean {
  return env.VITE_ENABLE_GOOGLE === "true";
}

/** A company email domain, tidied ("@Acme.co.uk " → "acme.co.uk"); null for anything else or a free provider. */
export function normaliseDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.trim().toLowerCase().replace(/^.*@/, "").replace(/\.$/, "");
  if (!DOMAIN_RE.test(d) || PUBLIC_EMAIL_DOMAINS.has(d)) return null;
  return d;
}

export type HdSetting = { mode: "off" } | { mode: "fixed"; domain: string } | { mode: "auto" };

/** VITE_GOOGLE_HD: unset → auto (the one approved domain) · "off"/"none"/"false" → no hint · a domain → that domain. */
export function hdSetting(raw: unknown): HdSetting {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!s || s === "auto") return { mode: "auto" };
  if (s === "off" || s === "none" || s === "false") return { mode: "off" };
  const domain = normaliseDomain(s);
  return domain ? { mode: "fixed", domain } : { mode: "off" };
}

/** What Kanbo asks Google for: always the account chooser, and the company hint when there is one. */
export function googleQueryParams(hd?: string | null): Record<string, string> {
  const domain = normaliseDomain(hd);
  return domain ? { prompt: "select_account", hd: domain } : { prompt: "select_account" };
}

/** Where Google sends people back to: the admin console from /admin, the app otherwise. */
export function oauthRedirectTo(loc: { origin: string; pathname: string }): string {
  return loc.pathname.replace(/\/+$/, "") === "/admin" ? `${loc.origin}/admin` : loc.origin;
}

/* ---------------- the hint, cached ---------------- */

export const HINT_CACHE_KEY = "kanbo-google-hint";
export const HINT_CACHE_MS = 6 * 60 * 60 * 1000;
export const HINT_TIMEOUT_MS = 2500;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readHintCache(storage: StorageLike | null, now: number): { hd: string | null } | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(HINT_CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { hd?: unknown; at?: unknown };
    if (typeof o.at !== "number" || now - o.at > HINT_CACHE_MS || now < o.at) return null;
    return { hd: o.hd === null ? null : normaliseDomain(o.hd) };
  } catch { return null; }
}

export function writeHintCache(storage: StorageLike | null, hd: string | null, now: number): void {
  try { storage?.setItem(HINT_CACHE_KEY, JSON.stringify({ hd, at: now })); } catch { /* private mode */ }
}

/** The rpc's answer: { google_hd: "acme.co.uk" | null }. */
export function parseSignInHints(raw: unknown): { hd: string | null } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!("google_hd" in o)) return null;
  return { hd: normaliseDomain(o.google_hd) };
}

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
export type HintRpc = () => PromiseLike<RpcResult>;

const withTimeout = <T,>(p: PromiseLike<T>, ms: number): Promise<T | "timeout"> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

/** The `hd` hint for this sign-in page. Never throws; null = no hint. */
export async function loadGoogleHint(deps: {
  setting: HdSetting;
  rpc: HintRpc | null;
  storage: StorageLike | null;
  now?: number;
  timeoutMs?: number;
}): Promise<string | null> {
  if (deps.setting.mode === "off") return null;
  if (deps.setting.mode === "fixed") return deps.setting.domain;
  const now = deps.now ?? Date.now();
  const cached = readHintCache(deps.storage, now);
  if (cached) return cached.hd;
  if (!deps.rpc) return null;
  try {
    const res = await withTimeout(deps.rpc(), deps.timeoutMs ?? HINT_TIMEOUT_MS);
    if (res === "timeout") return null;                      // try again next time
    if (res.error) {
      // the rpc isn't there (database older than the hint): remember "no hint" for a while
      if (res.error.code === "PGRST202" || res.error.code === "42883" || /could not find the function|does not exist/i.test(res.error.message ?? "")) {
        writeHintCache(deps.storage, null, now);
      }
      return null;
    }
    const parsed = parseSignInHints(res.data);
    if (!parsed) return null;
    writeHintCache(deps.storage, parsed.hd, now);
    return parsed.hd;
  } catch { return null; }
}

/* ---------------- is the provider on? ---------------- */

/** GoTrue's public settings: is Google switched on? null when it can't tell. */
export function parseGoogleProvider(raw: unknown): boolean | null {
  if (!raw || typeof raw !== "object") return null;
  const ext = (raw as { external?: unknown }).external;
  if (!ext || typeof ext !== "object") return null;
  const g = (ext as Record<string, unknown>).google;
  return typeof g === "boolean" ? g : null;
}

export async function loadGoogleProviderReady(deps: {
  supabaseUrl: string | null | undefined;
  anonKey: string | null | undefined;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}): Promise<boolean | null> {
  const base = (deps.supabaseUrl ?? "").trim().replace(/\/+$/, "");
  const key = (deps.anonKey ?? "").trim();
  if (!base || !key) return null;
  const doFetch = deps.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), deps.timeoutMs ?? HINT_TIMEOUT_MS);
  try {
    const res = await doFetch(`${base}/auth/v1/settings`, { headers: { apikey: key }, signal: ac.signal });
    if (!res.ok) return null;
    return parseGoogleProvider(await res.json());
  } catch { return null; } finally { clearTimeout(t); }
}

/* ---------------- words ---------------- */

/** A Google sign-in error in plain words (falls back to the shared auth copy). */
export function friendlyGoogleError(message: string | null | undefined, fallback: (m: string) => string): string {
  const m = (message ?? "").trim();
  if (/provider is not enabled|unsupported provider/i.test(m)) return "Google sign-in isn’t switched on yet. Use your email and password for now.";
  if (/popup|cancel/i.test(m)) return "Google sign-in was cancelled. You can try again.";
  return fallback(m);
}

/** Has this account signed in with Google (a linked Google identity)? */
export function usesGoogle(providers: readonly string[] | null | undefined): boolean {
  return !!providers?.includes("google");
}

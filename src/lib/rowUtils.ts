/* ============================================================
   KANBO — tiny helpers shared by the 0048 row parsers.  [architect: final]
   ============================================================ */
export type Row = Record<string, unknown>;
export const isObj = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
export const strOr = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
export const bool = (v: unknown): boolean => v === true || v === "true";
export const strArr = (v: unknown, max = 200): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []);
export const errText = (e: unknown): string => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e ?? ""));
export const isNetwork = (m: string): boolean => /failed to fetch|network|load failed|fetch failed|timeout/i.test(m);
/** "function … does not exist" / "relation … does not exist" / PostgREST's PGRST202/PGRST205: 0048 isn't in yet */
export const isMissing = (m: string): boolean => /does not exist|could not find the (function|table)|PGRST20[25]|schema cache/i.test(m);

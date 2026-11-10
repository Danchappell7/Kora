/* ============================================================
   KANBO — portfolio updates (0054 portfolio_updates): the update a
   portfolio's owner posts, which Kanbo drafts from its projects'
   latest updates (lib/portfolioDraft). Read like the portfolio
   (members and above, never guests; a Personal one by you alone).
   Its writers post; the author edits (marked edited); the author or
   the workspace's owners and admins delete. Its owner and followers
   hear about each one in their Inbox. Demo: in memory, seeded.
   Before 0054: portfolioUpdatesOn() is false and the page says so.
   ============================================================ */
import { useEffect, useSyncExternalStore } from "react";
import type { PortfolioUpdate, StatusKind, UpdateSections } from "../data/types";
import { DEMO_PORTFOLIO_UPDATES } from "../data/data";
import { parseSections } from "./updateSections";
import { errText } from "./rowUtils";
import { supabase } from "./supabase";

const COLUMNS = "id,portfolio_id,workspace_id,author_id,summary,status,sections,created_at,edited_at";
const KINDS = new Set<string>(["on_track", "at_risk", "off_track", "on_hold"]);

export class PortfolioUpdateError extends Error {
  constructor(readonly reason: "not_allowed" | "unavailable" | "failed", message: string) { super(message); this.name = "PortfolioUpdateError"; }
}

/** portfolio_updates (anything) → an update, or null. */
export function parsePortfolioUpdate(r: unknown): PortfolioUpdate | null {
  const o = r as Record<string, unknown> | null;
  if (!o || typeof o.id !== "string" || typeof o.portfolio_id !== "string" || typeof o.summary !== "string") return null;
  const sections = parseSections(o.sections);
  return {
    id: o.id, portfolioId: o.portfolio_id, workspaceId: typeof o.workspace_id === "string" ? o.workspace_id : null,
    authorId: typeof o.author_id === "string" ? o.author_id : null, summary: o.summary,
    status: (KINDS.has(String(o.status)) ? o.status : "on_track") as StatusKind,
    ...(sections ? { sections } : {}), createdAt: String(o.created_at ?? ""), editedAt: typeof o.edited_at === "string" ? o.edited_at : null,
  };
}

let byPortfolio = new Map<string, PortfolioUpdate[]>();
let loaded = new Set<string>();
let missing = false;
let snapshot = { byPortfolio, missing };
let seq = 0;
const listeners = new Set<() => void>();
const tell = () => { snapshot = { byPortfolio, missing }; listeners.forEach((fn) => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const setList = (id: string, list: PortfolioUpdate[]) => {
  byPortfolio = new Map(byPortfolio);
  byPortfolio.set(id, [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  tell();
};

/** Is posting a portfolio update switched on? (Before 0054 the table isn't there.) */
export const portfolioUpdatesOn = (): boolean => !missing;

const isMissing = (e: unknown) => {
  const code = String((e as { code?: unknown })?.code ?? "");
  return code === "42P01" || code === "PGRST205" || /could not find|does not exist|schema cache/i.test(errText(e));
};
const failure = (e: unknown, what: string): PortfolioUpdateError => {
  if (isMissing(e)) { missing = true; tell(); return new PortfolioUpdateError("unavailable", "Portfolio updates aren't switched on yet."); }
  if (/row-level security|policy|permission/i.test(errText(e))) return new PortfolioUpdateError("not_allowed", "You can't do that on this portfolio.");
  return new PortfolioUpdateError("failed", `Couldn't ${what} just now. Try again in a moment.`);
};

/** Read a portfolio's updates (newest first; once, again with `force`). */
export async function loadPortfolioUpdates(portfolioId: string, force = false): Promise<PortfolioUpdate[]> {
  if (!portfolioId || portfolioId.startsWith("tmp-") || missing || (loaded.has(portfolioId) && !force)) return byPortfolio.get(portfolioId) ?? [];
  loaded.add(portfolioId);
  if (!supabase) {
    if (!byPortfolio.has(portfolioId)) setList(portfolioId, DEMO_PORTFOLIO_UPDATES.filter((u) => u.portfolioId === portfolioId).map((u) => ({ ...u })));
    return byPortfolio.get(portfolioId) ?? [];
  }
  const { data, error } = await supabase.from("portfolio_updates").select(COLUMNS).eq("portfolio_id", portfolioId).order("created_at", { ascending: false }).limit(100);
  if (error) {
    loaded.delete(portfolioId);
    if (isMissing(error)) { missing = true; tell(); }
    return [];
  }
  setList(portfolioId, ((data as unknown[] | null) ?? []).map(parsePortfolioUpdate).filter((u): u is PortfolioUpdate => !!u));
  return byPortfolio.get(portfolioId) ?? [];
}

/** A portfolio's updates, newest first, kept current. */
export function usePortfolioUpdates(portfolioId: string): { updates: PortfolioUpdate[]; on: boolean } {
  const snap = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  useEffect(() => { void loadPortfolioUpdates(portfolioId); }, [portfolioId]);
  return { updates: snap.byPortfolio.get(portfolioId) ?? NONE, on: !snap.missing };
}
const NONE: PortfolioUpdate[] = [];

/** Post one (the database makes you its author). */
export async function postPortfolioUpdate(portfolioId: string, input: { summary: string; status: StatusKind; sections?: UpdateSections }, me: string): Promise<PortfolioUpdate> {
  const summary = input.summary.trim();
  if (!summary) throw new PortfolioUpdateError("failed", "Write something first.");
  const sections = parseSections(input.sections);
  if (!supabase) {
    const u: PortfolioUpdate = { id: `pu-demo-new-${++seq}`, portfolioId, authorId: me, summary, status: input.status, ...(sections ? { sections } : {}), createdAt: new Date().toISOString(), editedAt: null };
    setList(portfolioId, [u, ...(byPortfolio.get(portfolioId) ?? [])]);
    return u;
  }
  if (missing) throw new PortfolioUpdateError("unavailable", "Portfolio updates aren't switched on yet.");
  const { data, error } = await supabase.from("portfolio_updates").insert({ portfolio_id: portfolioId, author_id: me, summary, status: input.status, sections: sections ?? null }).select(COLUMNS).single();
  if (error) throw failure(error, "post the update");
  const u = parsePortfolioUpdate(data);
  if (!u) throw new PortfolioUpdateError("failed", "Couldn't post the update just now. Try again in a moment.");
  setList(portfolioId, [u, ...(byPortfolio.get(portfolioId) ?? []).filter((x) => x.id !== u.id)]);
  return u;
}

/** Change your own (marked edited). */
export async function editPortfolioUpdate(u: PortfolioUpdate, patch: { summary?: string; status?: StatusKind; sections?: UpdateSections | null }): Promise<PortfolioUpdate> {
  const sections = patch.sections === null ? undefined : parseSections(patch.sections);
  let next: PortfolioUpdate = { ...u, ...patch, sections, editedAt: new Date().toISOString() };
  if (!sections) delete next.sections;
  if (supabase) {
    const row: Record<string, unknown> = {};
    if (patch.summary !== undefined) row.summary = patch.summary.trim();
    if (patch.status !== undefined) row.status = patch.status;
    if ("sections" in patch) row.sections = sections ?? null;
    const { data, error } = await supabase.from("portfolio_updates").update(row).eq("id", u.id).select(COLUMNS);
    if (error) throw failure(error, "save the update");
    const got = parsePortfolioUpdate((data as unknown[] | null)?.[0]);
    if (!got) throw new PortfolioUpdateError("not_allowed", "Only the person who posted an update can change it.");
    next = got;
  }
  setList(u.portfolioId, (byPortfolio.get(u.portfolioId) ?? []).map((x) => (x.id === u.id ? next : x)));
  return next;
}

/** Delete one: its author, or the workspace's owners and admins. */
export async function deletePortfolioUpdate(u: PortfolioUpdate): Promise<void> {
  if (supabase) {
    const { data, error } = await supabase.from("portfolio_updates").delete().eq("id", u.id).select("id");
    if (error) throw failure(error, "delete the update");
    if (!(data as unknown[] | null)?.length) throw new PortfolioUpdateError("not_allowed", "Only its author, or a workspace owner or admin, can delete it.");
  }
  setList(u.portfolioId, (byPortfolio.get(u.portfolioId) ?? []).filter((x) => x.id !== u.id));
}

/** Tests: start again. */
export function resetPortfolioUpdates(seed: PortfolioUpdate[] = []): void {
  byPortfolio = new Map();
  for (const u of seed) byPortfolio.set(u.portfolioId, [...(byPortfolio.get(u.portfolioId) ?? []), u]);
  loaded = new Set(byPortfolio.keys());
  missing = false; seq = 0; tell();
}

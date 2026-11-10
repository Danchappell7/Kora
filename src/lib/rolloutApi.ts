/* ============================================================
   KANBO — rolling Kanbo out (0058), the server's side:
   · workspace_activity(ws): who's been active here in the last 7 days,
     by day (owners and admins only; the database checks);
   · admin_provision_business / admin_workspace_adoption: the platform
     console's "Provision a business" and per-workspace weekly actives
     (platform admins only; the database checks is_admin()).
   Demo: a believable week from the seed. Before 0058 each answers
   "off" (the card or panel says it isn't switched on yet), never an
   error.
   ============================================================ */
import type { Workspace, WorkspaceMember } from "../data/types";
import { store } from "../data/store";
import { KANBO_TODAY, WORKSPACES } from "../data/data";
import { parseActivity, type WorkspaceActivity } from "./rollout";
import { errText } from "./rowUtils";
import { supabase } from "./supabase";

/** A missing table, column or function: 0058 isn't run yet. */
export function notYet(e: unknown): boolean {
  const code = String((e as { code?: unknown } | null)?.code ?? "");
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(code)
    || /could not find the (function|table|column)|does not exist|schema cache/i.test(errText(e));
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const back = (today: Date, n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d); };

/* ---------------- active by day ---------------- */

export type ActivityAnswer = WorkspaceActivity | "off" | "failed";

/** The demo's week: the first person in every day, then four of seven, two, and one who's gone quiet.
 *  A workspace made `since` a day this week has nobody in it before then. */
const DEMO_DAYS: readonly (readonly number[])[] = [[0, 1, 2, 3, 4, 5, 6], [0, 1, 3, 4, 6], [1, 4], [9]];
export function demoActivity(userIds: readonly string[], today: Date = KANBO_TODAY, since?: string): WorkspaceActivity {
  const first = since && since > back(today, 30) ? since : null;
  const seen = (i: number) => DEMO_DAYS[i % DEMO_DAYS.length].filter((n) => !first || back(today, n) >= first);
  const members = userIds.map((userId, i) => {
    const ago = seen(i);
    return { userId, days: ago.filter((n) => n < 7).length, lastDay: ago.length ? back(today, Math.min(...ago)) : null };
  });
  const days = Array.from({ length: 7 }, (_, k) => {
    const n = 6 - k;
    return { day: back(today, n), people: userIds.filter((_, i) => seen(i).includes(n)).length };
  });
  return { today: iso(today), ...(first ? { since: first } : {}), members, days };
}

/** Who's been active in a workspace this week, by day. The database answers its owners and admins only.
 *  (`since`: the workspace's first day, for the demo's week.) */
export async function loadWorkspaceActivity(workspaceId: string, members: readonly WorkspaceMember[] = [], since?: string): Promise<ActivityAnswer> {
  if (!supabase) {
    return demoActivity(members.filter((m) => m.workspaceId === workspaceId && m.status === "active" && m.userId).map((m) => m.userId!), KANBO_TODAY, since);
  }
  try {
    const { data, error } = await supabase.rpc("workspace_activity", { p_ws: workspaceId });
    if (error) return notYet(error) ? "off" : "failed";
    return parseActivity(data) ?? "failed";
  } catch { return "failed"; }
}

/* ---------------- the platform console ---------------- */

// Mail domains anyone can sign up with (0058 public_mail_domain, kept in step): pre-approving one would let anyone in.
const PUBLIC_MAIL_PROVIDER = /^(gmail|googlemail|outlook|hotmail|live|windowslive|msn|yahoo|ymail|rocketmail|aol|aim|icloud|gmx|web|mail|email|yandex|ya|protonmail|proton|zoho|zohomail|tutanota|tuta|tutamail|fastmail|hushmail|mailbox|posteo|qq|163|126|yeah|sina|sohu|naver|daum|hanmail|rediffmail|t-online|freenet|orange|wanadoo|free|laposte|sfr|libero|virgilio|seznam|wp|o2|onet|interia|inbox|mail2world)\.([a-z]{2,6})(\.[a-z]{2,3})?$/;
const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set(["me.com", "mac.com", "pm.me", "hey.com", "duck.com", "btinternet.com", "btopenworld.com",
  "bt.com", "sky.com", "virginmedia.com", "virgin.net", "ntlworld.com", "blueyonder.co.uk", "talktalk.net", "tiscali.co.uk",
  "plus.net", "plusnet.com", "aol.co.uk", "eclipse.co.uk", "zen.co.uk", "live.co.uk", "mail.ru", "bk.ru", "list.ru", "rambler.ru",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "cox.net", "charter.net", "shaw.ca", "rogers.com", "bigpond.com",
  "optusnet.com.au", "xtra.co.nz"]);
/** A public mail provider's domain (gmail.com, outlook.co.uk, virginmedia.com…), not a business's own. */
export function publicMailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  return PUBLIC_MAIL_PROVIDER.test(d) || PUBLIC_MAIL_DOMAINS.has(d);
}

export interface ProvisionInput { name: string; ownerEmail: string; domain?: string | null; pack?: string | null }
export interface Provisioned {
  workspaceId: string;
  /** the owner-to-be's invite (its email goes through the invite-member function) */
  memberId: string;
  domain: string | null;
  domainAdded: boolean;
  /** people already waiting from the domain who were let in */
  approved: number;
}
export type ProvisionFailure = "off" | "not_allowed" | "invalid" | "failed";
export class ProvisionError extends Error {
  constructor(readonly reason: ProvisionFailure, message: string) { super(message); this.name = "ProvisionError"; }
}

/** What admin_provision_business's refusal means, in the console's words. */
export function provisionRefusal(message: string): ProvisionError {
  if (/not authori[sz]ed/i.test(message)) return new ProvisionError("not_allowed", "Only platform admins can provision a business.");
  if (/public email domain/i.test(message)) return new ProvisionError("invalid", "That's a public email domain: approving it would let anyone in.");
  if (/invalid email/i.test(message)) return new ProvisionError("invalid", "Enter the owner's full email address.");
  if (/invalid domain/i.test(message)) return new ProvisionError("invalid", "That doesn't look like a domain. Try something like harbourfit.co.uk.");
  if (/someone else/i.test(message)) return new ProvisionError("invalid", "The owner has to be someone other than you. You stay on as an admin.");
  if (/name the business/i.test(message)) return new ProvisionError("invalid", "Give the business a name (up to 80 characters).");
  if (/invalid pack/i.test(message)) return new ProvisionError("invalid", "That pack isn't one Kanbo knows.");
  return new ProvisionError("failed", "Couldn't provision it just now. Try again in a moment.");
}

/** Create the business: workspace, the owner's invite, the domain, the handover (platform admins; the database checks).
 *  `me` is the admin (the demo makes it as them). Throws ProvisionError. */
export async function provisionBusiness(input: ProvisionInput, me: { id: string; email: string; name: string }): Promise<Provisioned> {
  const domain = input.domain?.trim().toLowerCase() || null;
  if (!supabase) {
    const w = await store.createWorkspace(input.name.trim(), me);
    const m = await store.inviteMember(w.id!, input.ownerEmail.trim().toLowerCase(), "admin");
    demoHandovers.set(w.id!, { name: w.name, email: input.ownerEmail.trim().toLowerCase(), pack: input.pack ?? null });
    return { workspaceId: w.id!, memberId: m.id, domain, domainAdded: !!domain, approved: 0 };
  }
  const { data, error } = await supabase.rpc("admin_provision_business", {
    p_name: input.name, p_owner_email: input.ownerEmail, p_domain: domain, p_pack: input.pack ?? null,
  });
  if (error) {
    if (notYet(error)) throw new ProvisionError("off", "Provisioning isn't switched on yet: run migration 0058.");
    throw provisionRefusal(errText(error));
  }
  const r = (data ?? {}) as Record<string, unknown>;
  if (typeof r.workspace_id !== "string" || typeof r.member_id !== "string") throw new ProvisionError("failed", "Couldn't provision it just now. Try again in a moment.");
  return {
    workspaceId: r.workspace_id, memberId: r.member_id, domain: typeof r.domain === "string" ? r.domain : null,
    domainAdded: r.domain_added === true, approved: Number(r.approved) || 0,
  };
}

export interface AdoptionRow {
  id: string;
  name: string;
  createdAt: string;
  members: number;
  invited: number;
  /** people who worked there in the last 7 days (a task, a comment, an update) */
  weeklyActive: number;
  /** tasks done in the last 7 days */
  doneWeek: number;
  /** the last day anyone worked there ("YYYY-MM-DD") */
  lastDay: string | null;
  /** a handover waiting for (or done by) the owner it was set up for */
  handover: { email: string; done: boolean } | null;
  pack: string | null;
}

/** demo: what was provisioned in this visit (the database keeps it in workspace_handovers) */
const demoHandovers = new Map<string, { name: string; email: string; pack: string | null }>();
/** The demo's numbers: Foundrise taking to it, Courtside Padel getting going, Harbour quiet. */
const DEMO_ADOPTION: Record<string, Pick<AdoptionRow, "members" | "invited" | "weeklyActive" | "doneWeek"> & { daysAgo: number }> = {
  "ws-foundrise": { members: 4, invited: 2, weeklyActive: 3, doneWeek: 9, daysAgo: 0 },
  "ws-reco": { members: 3, invited: 0, weeklyActive: 2, doneWeek: 4, daysAgo: 1 },
  "ws-courtside": { members: 2, invited: 0, weeklyActive: 2, doneWeek: 3, daysAgo: 0 },
  "ws-harbour": { members: 2, invited: 0, weeklyActive: 1, doneWeek: 0, daysAgo: 6 },
  "ws-northlight": { members: 2, invited: 0, weeklyActive: 1, doneWeek: 2, daysAgo: 2 },
};

function parseAdoption(raw: unknown): AdoptionRow[] {
  return (Array.isArray(raw) ? raw : []).flatMap((x): AdoptionRow[] => {
    const r = x as Record<string, unknown>;
    if (!r || typeof r.id !== "string") return [];
    const n = (v: unknown) => Number(v) || 0;
    const day = typeof r.last_day === "string" ? r.last_day.slice(0, 10) : null;
    return [{
      id: r.id, name: String(r.name ?? ""), createdAt: String(r.created_at ?? ""), members: n(r.members), invited: n(r.invited),
      weeklyActive: n(r.weekly_active), doneWeek: n(r.done_week), lastDay: day,
      handover: typeof r.handover_email === "string" ? { email: r.handover_email, done: !!r.handover_done_at } : null,
      pack: typeof r.pack === "string" ? r.pack : null,
    }];
  });
}

/** Every workspace's adoption (platform admins; the database checks). "off" before 0058. */
export async function workspaceAdoption(workspaces: readonly Workspace[] = WORKSPACES): Promise<AdoptionRow[] | "off" | "failed"> {
  if (!supabase) {
    const today = KANBO_TODAY;
    // (newest first, as the database lists them: what was provisioned in this visit leads)
    const made = [...demoHandovers].reverse().map(([id, h]) => ({ id, name: h.name }));
    return [...made, ...workspaces.filter((w) => w.id && !demoHandovers.has(w.id)).map((w) => ({ id: w.id!, name: w.name }))].map((w) => {
      const h = demoHandovers.get(w.id);
      // (provisioned in this visit: only its owner-to-be's invite so far; the admin isn't counted)
      const d = h ? { members: 0, invited: 1, weeklyActive: 0, doneWeek: 0, daysAgo: 0 } : DEMO_ADOPTION[w.id] ?? { members: 1, invited: 0, weeklyActive: 1, doneWeek: 0, daysAgo: 0 };
      return { id: w.id, name: w.name, createdAt: "", members: d.members, invited: d.invited, weeklyActive: d.weeklyActive, doneWeek: d.doneWeek,
        lastDay: h ? null : back(today, d.daysAgo), handover: h ? { email: h.email, done: false } : null, pack: h?.pack ?? null };
    });
  }
  try {
    const { data, error } = await supabase.rpc("admin_workspace_adoption");
    if (error) return notYet(error) ? "off" : "failed";
    return parseAdoption(data);
  } catch { return "failed"; }
}

/* ============================================================
   KANBO — a business pack, made concrete (src/packs).
   The gallery's preview shows every part a pack sets up, each one
   tickable: its projects (each with its sections, starter tasks, and
   any request form and rule), goals with their key results, a
   portfolio, docs, and the workspace's update day. This module turns
   a pack and those choices (a PackPick) into a PackPlan: real dates,
   colours and doc bodies, no ids yet. lib/packApply creates it.
   • Projects are planned as any team template's
     (templates buildWorkspaceFromTemplate), a countdown project's
     tasks counted back from its anchor day (anchoredDay).
   • Goals are for one quarter, picked in the preview (by default this
     one, or the next when less than two months of this one are left);
     a "year" goal is for that whole year. Before Goals 2.0 (0052) they
     go in with a due date and key results as sub-goals, and nothing
     that needs 0052 (owner, quarter, links, lower is better).
   • Goals are only for those who may set the business's goals, the
     update day only for owners and admins of a team workspace, once
     update days are switched on.
   • A holding company's businesses each get a project and a portfolio.
   Pure: no React, no I/O.
   ============================================================ */
import type {
  DocBlock, GoalDirection, TemplateDoc, TemplateKeyResult, TemplateProject, TemplatePortfolio, UpdateRhythm, WorkspacePlan, WorkspaceTemplate,
} from "../data/types";
import { toLocalISO } from "../data/data";
import { buildWorkspaceFromTemplate } from "./templates";
import { addDays, parseDay } from "./templatePlan";
import { docTemplate, emptyBlock, markdownToBlocks, blockText } from "./docBlocks";
import { periodChoices, periodLabel, periodRange, quarterOf } from "./goalPeriods";
import { spectrumColor, type SpectrumKey } from "./projectIdentity";
import { rhythmToSave } from "./updateRhythm";

/* ---------- the parts you can untick ---------- */

export const packPart = {
  project: (key: string) => `project:${key}`,
  goal: (key: string) => `goal:${key}`,
  portfolio: (key: string) => `portfolio:${key}`,
  doc: (projectKey: string, i: number) => `doc:${projectKey}/${i}`,
  form: (projectKey: string) => `form:${projectKey}`,
  updates: "updates",
} as const;

/** What someone chose in the preview. */
export interface PackPick {
  packId: string;
  /** the parts they unticked (packPart ids) */
  off: string[];
  /** a countdown project's anchor day, by its key ("YYYY-MM-DD") */
  anchors: Record<string, string>;
  /** the quarter the goals are for ("2027-Q1") */
  quarter: string;
  /** a holding company's businesses */
  businesses: string[];
}

/** Where the pack is going, and who's using it. */
export interface PackContext {
  today: Date;
  /** Goals 2.0 (0052) is in: owners, quarters, links */
  goalsV2: boolean;
  /** may set the business's goals: owners and admins (anyone, in Personal or before 0052) */
  canSetGoals: boolean;
  /** may set the update day: owners and admins of a team workspace, once 0053 is in */
  canSetUpdateDay: boolean;
  /** the other businesses you run (a holding company's starting list) */
  businesses?: string[];
}

export const isPartOn = (pick: Pick<PackPick, "off">, part: string): boolean => !pick.off.includes(part);

/* ---------- the goals' quarter ---------- */

/** This quarter, or the next when less than two months of this one are left. */
export function packQuarter(today: Date): string {
  const q = quarterOf(today);
  const end = parseDay(periodRange(q)!.end)!;
  return end.getTime() - today.getTime() < 60 * 86_400_000 ? quarterOf(addDays(end, 1)) : q;
}
/** This quarter and the next, for the preview's picker (the two the Goals page opens on). */
export function packQuarterChoices(today: Date): { value: string; label: string }[] {
  return periodChoices(today).filter((c) => c.group === "Quarter").slice(0, 2).map(({ value, label }) => ({ value, label }));
}
const isQuarter = (q: string) => /^\d{4}-Q[1-4]$/.test(q);

/* ---------- a holding company's businesses ---------- */

export const MAX_BUSINESSES = 8;
const BUSINESS_HUES: readonly SpectrumKey[] = ["sky", "coral", "jade", "orchid", "amber", "lagoon", "rose", "citron"];

/** The names as they'll be used: trimmed, no blanks or repeats, at most eight, 60 characters each. */
export function cleanBusinesses(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const n = raw.trim().replace(/\s+/g, " ").slice(0, 60).trim();
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
    if (out.length >= MAX_BUSINESSES) break;
  }
  return out;
}
const named = (s: string | undefined, business: string) => (s == null ? s : s.split("{business}").join(business));

/** The business's own project key ("business-1"). */
export const businessKey = (i: number) => `business-${i + 1}`;

/** The pack with a project and a portfolio for each business (a holding company); other packs as they are. */
export function expandPack(pack: WorkspaceTemplate, businesses: readonly string[]): WorkspaceTemplate {
  const per = pack.perBusiness;
  if (!per) return pack;
  const names = cleanBusinesses(businesses);
  const projects: TemplateProject[] = names.map((b, i) => ({
    ...per.project,
    key: businessKey(i),
    name: named(per.project.name, b)!,
    description: named(per.project.description, b),
    hue: BUSINESS_HUES[i % BUSINESS_HUES.length],
    tasks: per.project.tasks.map((x) => ({ ...x, title: named(x.title, b)!, description: named(x.description, b) })),
  }));
  const portfolios: TemplatePortfolio[] = names.map((b, i) => ({
    ...per.portfolio,
    key: businessKey(i),
    name: named(per.portfolio.name, b)!,
    description: named(per.portfolio.description, b),
    hue: BUSINESS_HUES[i % BUSINESS_HUES.length],
    projects: [businessKey(i)],
  }));
  return { ...pack, projects: [...pack.projects, ...projects], portfolios: [...(pack.portfolios ?? []), ...portfolios] };
}

/* ---------- where a pick starts ---------- */

/** Everything ticked (but the update day, when it's added to a workspace that has one already),
 *  each countdown on its default day, goals for packQuarter. */
export function defaultPick(pack: WorkspaceTemplate, ctx: Pick<PackContext, "today" | "businesses"> & { mode?: "workspace" | "project" }): PackPick {
  const anchors: Record<string, string> = {};
  for (const p of pack.projects) if (p.anchor) anchors[p.key] = toLocalISO(addDays(ctx.today, Math.max(0, Math.round(p.anchor.defaultInDays))));
  return {
    packId: pack.id, off: ctx.mode === "project" ? [packPart.updates] : [], anchors, quarter: packQuarter(ctx.today),
    businesses: pack.perBusiness ? cleanBusinesses(ctx.businesses ?? []).slice(0, 6) : [],
  };
}

/** How many of a countdown project's tasks are already behind on that anchor day (they start out due today). */
export function tasksBehind(project: Pick<TemplateProject, "tasks">, anchorDay: string, today: Date): number {
  const anchor = parseDay(anchorDay);
  if (!anchor) return 0;
  return project.tasks.filter((x) => typeof x.fromAnchor === "number" && addDays(anchor, x.fromAnchor) < today).length;
}

/* ---------- the plan ---------- */

export interface PlannedKeyResult {
  name: string;
  icon?: string;
  unit?: string;
  target?: number;
  startValue?: number;
  direction?: GoalDirection;
  /** projects that serve it (Goals 2.0 links) */
  linkKeys: string[];
}
export interface PlannedPackGoal extends PlannedKeyResult {
  key: string;
  description?: string;
  /** Goals 2.0: "2027-Q1" / "2027-FY" and its days */
  period?: string;
  periodStart?: string;
  periodEnd?: string;
  /** the period's last day ("YYYY-MM-DD") */
  due: string;
  /** the project whose % it is */
  projectKey?: string;
  keyResults: PlannedKeyResult[];
}
export interface PlannedPackDoc { projectKey: string; title: string; icon: string; body: DocBlock[] }
export interface PlannedPackPortfolio { key: string; name: string; description?: string; emoji?: string; color?: string; projectKeys: string[] }
export interface PlannedPoster { projectKey: string; formName: string; headline: string; line?: string }

export interface PackPlan extends WorkspacePlan {
  goals: PlannedPackGoal[];
  goalsV2: boolean;
  /** the goals' quarter ("2027-Q1"), and in words ("Q1 2027"); "" with no goals */
  goalQuarter: string;
  goalPeriod: string;
  portfolios: PlannedPackPortfolio[];
  docs: PlannedPackDoc[];
  posters: PlannedPoster[];
  /** the workspace's new update day (null: left as it is) */
  updateRhythm: UpdateRhythm | null;
}

/** A meeting doc's agenda in place of the template's one empty item. */
function withAgenda(body: DocBlock[], agenda: readonly string[]): DocBlock[] {
  const at = body.findIndex((b) => b.type === "h2" && blockText(b) === "Agenda");
  if (at < 0) return body;
  let end = at + 1;
  while (end < body.length && body[end].type === "numbered") end++;
  const items = agenda.filter((a) => a.trim()).map((a) => emptyBlock("numbered", { spans: [{ text: a.trim() }] }));
  return [...body.slice(0, at + 1), ...items, ...body.slice(end)];
}

/** A starter doc's title, icon and blocks. */
export function packDoc(d: TemplateDoc, ctx: { projectName: string; today: string }): { title: string; icon: string; body: DocBlock[] } {
  if (d.markdown) return { title: d.title, icon: d.icon ?? "📄", body: markdownToBlocks(d.markdown) };
  const base = docTemplate(d.from ?? "blank", ctx);
  return { title: d.title.trim() || base.title, icon: d.icon ?? base.icon, body: d.agenda?.length ? withAgenda(base.body, d.agenda) : base.body };
}

/** A goal's or key result's numbers (and, with Goals 2.0, its icon and the projects that serve it). */
const keyResult = (k: TemplateKeyResult, ctx: { v2: boolean; keys: Set<string>; links: readonly string[]; not?: string }): PlannedKeyResult => ({
  name: k.name,
  ...(ctx.v2 && k.icon ? { icon: k.icon } : {}),
  linkKeys: ctx.v2 ? [...new Set(k.links ?? ctx.links)].filter((x) => ctx.keys.has(x) && x !== ctx.not) : [],
  ...(k.unit ? { unit: k.unit } : {}),
  ...(typeof k.target === "number" ? { target: k.target } : {}),
  ...(typeof k.start === "number" ? { startValue: k.start } : {}),
  ...(k.direction ? { direction: k.direction } : {}),
});

/** Pure: the pack as it'll be created, for these choices. */
export function buildPackPlan(pack: WorkspaceTemplate, pick: PackPick, ctx: PackContext): PackPlan {
  const full = expandPack(pack, pick.businesses);
  const on = (part: string) => isPartOn(pick, part);
  const today = toLocalISO(ctx.today);

  const kept = full.projects.filter((p) => on(packPart.project(p.key)));
  const keys = new Set(kept.map((p) => p.key));
  const anchors = Object.fromEntries(Object.entries(pick.anchors).filter(([, v]) => !!parseDay(v)));
  const base = buildWorkspaceFromTemplate(
    { ...full, projects: full.projects.map((p) => (p.form && !on(packPart.form(p.key)) ? { ...p, form: undefined } : p)) },
    ctx.today, { projectKeys: [...keys], anchors },
  );

  const docs: PlannedPackDoc[] = kept.flatMap((p) => (p.docs ?? [])
    .map((d, i) => ({ d, i }))
    .filter(({ i }) => on(packPart.doc(p.key, i)))
    .map(({ d }) => ({ projectKey: p.key, ...packDoc(d, { projectName: p.name, today }) })));

  const posters: PlannedPoster[] = kept
    .filter((p) => p.form?.poster && on(packPart.form(p.key)))
    .map((p) => ({ projectKey: p.key, formName: p.form!.name, headline: p.form!.poster!.headline, ...(p.form!.poster!.line ? { line: p.form!.poster!.line } : {}) }));

  const quarter = isQuarter(pick.quarter) ? pick.quarter : packQuarter(ctx.today);
  const v2 = ctx.goalsV2;
  const goals: PlannedPackGoal[] = !ctx.canSetGoals ? [] : (full.goals ?? []).filter((g) => on(packPart.goal(g.key)))
    // (lower is better needs 0052's direction: before it, it would read the wrong way round)
    .filter((g) => v2 || g.direction !== "lower")
    .map((g) => {
      const period = g.span === "year" ? `${quarter.slice(0, 4)}-FY` : quarter;
      const range = periodRange(period)!;
      const projectKey = g.project && keys.has(g.project) ? g.project : undefined;
      const links = g.links ?? [];
      return {
        key: g.key, ...keyResult(g, { v2, keys, links, not: projectKey }),
        ...(g.description ? { description: g.description } : {}),
        ...(v2 ? { period, periodStart: range.start, periodEnd: range.end } : {}),
        due: range.end,
        ...(projectKey ? { projectKey } : {}),
        // (a key result is served by its goal's projects unless it says otherwise; the one whose % is the goal's included)
        keyResults: (g.keyResults ?? []).filter((k) => v2 || k.direction !== "lower")
          .map((k) => keyResult(k, { v2, keys, links: projectKey ? [projectKey, ...links] : links })),
      };
    });

  const portfolios: PlannedPackPortfolio[] = (full.portfolios ?? [])
    .filter((pf) => on(packPart.portfolio(pf.key)))
    .map((pf) => ({
      key: pf.key, name: pf.name,
      ...(pf.description ? { description: pf.description } : {}),
      ...(pf.emoji ? { emoji: pf.emoji } : {}),
      ...(pf.hue ? { color: spectrumColor(pf.hue) } : {}),
      projectKeys: pf.projects.filter((k) => keys.has(k)),
    }))
    .filter((pf) => pf.projectKeys.length > 0);

  const updateRhythm = pack.updateRhythm && ctx.canSetUpdateDay && on(packPart.updates) ? rhythmToSave(pack.updateRhythm, ctx.today) : null;

  return {
    ...base, templateId: pack.id, name: pack.name,
    goals, goalsV2: v2, goalQuarter: goals.length ? quarter : "", goalPeriod: goals.length ? periodLabel(quarter) : "",
    portfolios, docs, posters, updateRhythm,
  };
}

/* ---------- counting it ---------- */

export interface PackCounts {
  projects: number;
  tasks: number;
  goals: number;
  keyResults: number;
  portfolios: number;
  docs: number;
  forms: number;
  posters: number;
  updateDay: boolean;
}

export function packCounts(plan: PackPlan): PackCounts {
  return {
    projects: plan.projects.length,
    tasks: plan.projects.reduce((n, p) => n + p.tasks.length, 0),
    goals: plan.goals.length,
    keyResults: plan.goals.reduce((n, g) => n + g.keyResults.length, 0),
    portfolios: plan.portfolios.length,
    docs: plan.docs.length,
    forms: plan.projects.filter((p) => !!p.form).length,
    posters: plan.posters.length,
    updateDay: !!plan.updateRhythm,
  };
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** "5 projects · 41 tasks · 3 goals · 1 portfolio · 4 docs · 1 form" (what's in it, nothing that's 0). */
export function packCountsLine(c: PackCounts): string {
  const bits = [
    c.projects && plural(c.projects, "project"), c.tasks && plural(c.tasks, "task"),
    c.goals && plural(c.goals, "goal"), c.portfolios && plural(c.portfolios, "portfolio"),
    c.docs && plural(c.docs, "doc"), c.forms && plural(c.forms, "form"),
  ].filter(Boolean);
  return bits.join(" · ");
}

/** Does it set anything up at all? */
export const packHasParts = (c: PackCounts): boolean =>
  c.projects + c.goals + c.portfolios > 0 || c.updateDay;

/** What a pack holds, for its gallery card (everything ticked; a holding company's businesses not yet named). */
export function packStats(pack: WorkspaceTemplate): PackCounts & { perBusiness: boolean } {
  const projects = pack.projects;
  return {
    projects: projects.length,
    tasks: projects.reduce((n, p) => n + p.tasks.length, 0),
    goals: pack.goals?.length ?? 0,
    keyResults: (pack.goals ?? []).reduce((n, g) => n + (g.keyResults?.length ?? 0), 0),
    portfolios: pack.portfolios?.length ?? 0,
    docs: projects.reduce((n, p) => n + (p.docs?.length ?? 0), 0),
    forms: projects.filter((p) => !!p.form).length,
    posters: projects.filter((p) => !!p.form?.poster).length,
    updateDay: !!pack.updateRhythm,
    perBusiness: !!pack.perBusiness,
  };
}

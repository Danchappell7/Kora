/* ============================================================
   KANBO — a portfolio, read the way the Today brief reads a day
   (0054, c-portfolio-workspace):
     · portfolioSentence: "6 projects: 4 on track, 1 at risk, 1 silent
       for 3 weeks" — each project counted once, by the pill it wears
       (its lead's call, or no update yet), unless its update is missing
       (then it's silent);
     · portfolioFactsForAi / draftPortfolioLocal: the update Kanbo
       drafts from its projects' latest updates and health, for the
       owner to post (the AI's when it's on, else written here);
     · portfolioCsv / printPortfolio: the table as a spreadsheet, and
       a clean page for the browser's Print (Save as PDF).
   Pure apart from printPortfolio (it opens the print window).
   ============================================================ */
import type { Portfolio, Project, StatusKind, StatusUpdate, Task, UpdateSections, Workspace } from "../data/types";
import type { MergedStatus } from "./honestStatus";
import { STATUS_WORDS } from "./honestStatus";
import type { UpdateFreshness } from "./updateRhythm";
import type { ProjectHealth } from "../components/views/reportingUtils";
import { fmtShortDay, statusFacts, type TaskIndex } from "./statusDraft";
import { sectionsAsText } from "./updateSections";
import { progressOf } from "./countRules";
import { toCsv } from "./exportTasks";

/** One project as a portfolio reads it (the page's rows). */
export interface PortfolioRowLike {
  p: Project;
  ptasks: Task[];
  health: ProjectHealth | null;
  latest?: StatusUpdate;
  status: MergedStatus;
  fresh: UpdateFreshness;
}

const DAY = 86_400_000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysSince = (iso: string | undefined, today: Date): number | null => {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return Math.max(0, Math.round((midnight(today).getTime() - midnight(t).getTime()) / DAY));
};
/** "3 weeks" · "9 days" · "a week" */
const quietFor = (days: number) => (days >= 14 ? `${Math.floor(days / 7)} weeks` : days >= 7 ? "a week" : plural(days, "day"));
const firstSentence = (s: string, max = 160) => {
  const one = (s.match(/^[\s\S]*?[.!?](\s|$)/)?.[0] ?? s).trim().replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : one;
};
const lower = (s: string) => s.slice(0, 1).toLowerCase() + s.slice(1);

/** How a project counts in the sentence: silent (its update is missing), its lead's call, or none (no update yet):
 *  the same as the pill its row wears. */
export function rowBucket(r: PortfolioRowLike): StatusKind | "silent" | "none" {
  if (r.fresh.kind === "missing") return "silent";
  return r.status.lead ?? "none";
}

/** "6 projects: 4 on track, 1 at risk, 1 silent for 3 weeks" (the brief's voice). */
export function portfolioSentence(rows: readonly PortfolioRowLike[], today: Date): string {
  if (!rows.length) return "No projects in it yet.";
  const count = (k: ReturnType<typeof rowBucket>) => rows.filter((r) => rowBucket(r) === k).length;
  const parts: string[] = [];
  for (const k of ["on_track", "at_risk", "off_track", "on_hold"] as const) {
    const n = count(k);
    if (n) parts.push(`${n} ${lower(STATUS_WORDS[k])}`);
  }
  const silent = rows.filter((r) => rowBucket(r) === "silent");
  const quiet = silent.map((r) => daysSince(r.latest?.createdAt, today)).filter((d): d is number => d != null);
  if (quiet.length) {
    const least = Math.min(...quiet);
    parts.push(quiet.length === 1 ? `1 silent for ${quietFor(least)}` : `${quiet.length} silent for ${quietFor(least)} or more`);
  }
  // never posted: missing already, or not yet due
  const never = silent.length - quiet.length + count("none");
  if (never) parts.push(`${never} with no update yet`);
  return `${plural(rows.length, "project")}: ${parts.join(", ")}`;
}

/** The facts Kanbo's portfolio draft is written from: names, calls, counts and each project's latest words, never whole tasks
 *  (an Ask a project put to the portfolio's own owner is left out: it isn't theirs to pass on). */
export function portfolioFactsForAi(pf: Pick<Portfolio, "name" | "description" | "targetDate">, rows: readonly PortfolioRowLike[], tasks: Task[], idx: TaskIndex,
  statusUpdates: StatusUpdate[], today: Date, ownerId?: string | null) {
  return {
    portfolio: pf.name,
    description: pf.description?.slice(0, 400) ?? null,
    targetDate: pf.targetDate ?? null,
    today: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`,
    projects: rows.slice(0, 40).map((r) => {
      const f = statusFacts(r.p, tasks, statusUpdates, today, idx);
      return {
        name: r.p.name,
        call: r.status.lead,
        kanbo: r.status.kanbo,
        progressPct: f.pct,
        overdue: f.overdue.length,
        blocked: f.blocked.length,
        nextMilestone: f.nextMilestone ? { title: f.nextMilestone.title.slice(0, 120), due: f.nextMilestone.dueDate ?? null } : null,
        updateMissing: r.fresh.kind === "missing",
        latest: r.latest ? {
          daysAgo: daysSince(r.latest.createdAt, today), status: r.latest.status, summary: r.latest.summary.slice(0, 400),
          ...(r.latest.sections ? { sections: ownerId && r.latest.askUserIds?.includes(ownerId) ? withoutAsks(r.latest.sections) : r.latest.sections } : {}),
        } : null,
      };
    }),
  };
}

const withoutAsks = (s: UpdateSections): UpdateSections => { const rest = { ...s }; delete rest.asks; return rest; };

const RANK: Record<string, number> = { off_track: 0, at_risk: 1, silent: 2, on_hold: 3, none: 4, on_track: 5 };

/** A portfolio update written on this device: where it stands in a sentence or two, the worst off by name,
 *  and Highlights / Risks / Asks / Next gathered from its projects' own updates (an Ask a project put to the
 *  portfolio's own owner isn't theirs to pass on, so it's left out). */
export function draftPortfolioLocal(rows: readonly PortfolioRowLike[], tasks: Task[], idx: TaskIndex, statusUpdates: StatusUpdate[], today: Date,
  ownerId?: string | null): { summary: string; status: StatusKind; sections: UpdateSections } {
  if (!rows.length) return { summary: "No projects in this portfolio yet.", status: "on_track", sections: {} };
  const buckets = rows.map((r) => ({ r, b: rowBucket(r) })).sort((x, y) => RANK[x.b] - RANK[y.b]);
  const onTrack = buckets.filter((x) => x.b === "on_track").length;
  const s: string[] = [`${onTrack} of ${plural(rows.length, "project")} ${onTrack === 1 ? "is" : "are"} on track.`];
  const worst = buckets.filter((x) => x.b === "off_track" || x.b === "at_risk").slice(0, 2);
  for (const { r, b } of worst) {
    const why = r.latest ? firstSentence(r.latest.summary) : "";
    s.push(`${r.p.name} is ${b === "off_track" ? "off track" : "at risk"}${why ? `: ${lower(why).replace(/[.!?]?$/, ".")}` : "."}`);
  }
  const silent = buckets.filter((x) => x.b === "silent");
  if (silent.length === 1) {
    const d = daysSince(silent[0].r.latest?.createdAt, today);
    s.push(d == null ? `${silent[0].r.p.name} hasn't posted an update yet.` : `${silent[0].r.p.name} hasn't posted an update for ${quietFor(d)}.`);
  } else if (silent.length > 1) s.push(`${silent.length} projects haven't posted their update.`);
  const status: StatusKind = buckets.some((x) => x.b === "off_track") ? "off_track"
    : buckets.some((x) => x.b === "at_risk" || x.b === "silent") ? "at_risk" : "on_track";

  const sections: UpdateSections = {};
  const highlights = rows.filter((r) => r.latest?.sections?.highlights).slice(0, 3).map((r) => `${r.p.name}: ${firstSentence(r.latest!.sections!.highlights!, 120)}`);
  if (highlights.length) sections.highlights = highlights.join("\n");
  else {
    const done = rows.map((r) => ({ r, n: statusFacts(r.p, tasks, statusUpdates, today, idx).done7.length })).filter((x) => x.n > 0);
    if (done.length) sections.highlights = done.slice(0, 3).map((x) => `${x.r.p.name}: ${plural(x.n, "task")} finished this week.`).join("\n");
  }
  const risks = worst.map(({ r }) => `${r.p.name}: ${r.latest?.sections?.risks ? firstSentence(r.latest.sections.risks, 120) : r.status.sees.replace(/^Kanbo sees /, "")}`);
  for (const { r } of silent.slice(0, 2)) risks.push(`${r.p.name}: no update since ${r.latest ? fmtShortDay(r.latest.createdAt, today) : "it started"}.`);
  // (nothing said yet, and Kanbo sees trouble in the work)
  for (const { r } of buckets.filter((x) => x.b === "none" && x.r.status.mismatch).slice(0, 2)) risks.push(`${r.p.name}: no update yet; ${r.status.sees.replace(/^Kanbo sees /, "")}.`);
  if (risks.length) sections.risks = risks.join("\n");
  const asks = rows.filter((r) => r.latest?.sections?.asks && !(ownerId && r.latest.askUserIds?.includes(ownerId))).slice(0, 3)
    .map((r) => `${r.p.name}: ${firstSentence(r.latest!.sections!.asks!, 140)}`);
  if (asks.length) sections.asks = asks.join("\n");
  const next = rows.map((r) => ({ r, ms: statusFacts(r.p, tasks, statusUpdates, today, idx).nextMilestone }))
    .filter((x) => x.ms?.dueDate).sort((a, b) => a.ms!.dueDate!.localeCompare(b.ms!.dueDate!)).slice(0, 3)
    .map((x) => `${x.r.p.name}: ${x.ms!.title.trim()}, ${fmtShortDay(x.ms!.dueDate, today)}.`);
  if (next.length) sections.next = next.join("\n");
  return { summary: s.join(" "), status, sections };
}

/** The table as CSV: one row per project (its business when it spans several). */
export function portfolioCsv(rows: readonly PortfolioRowLike[], tasks: Task[], idx: TaskIndex, statusUpdates: StatusUpdate[], today: Date,
  opts: { ownerName?: (id: string) => string | undefined; workspaces?: readonly Workspace[] } = {}): string {
  const across = !!opts.workspaces;
  const head = ["Project", ...(across ? ["Business"] : []), "Owner", "Status", "Kanbo sees", "Done %", "Tasks", "Overdue", "Blocked",
    "Next milestone", "Milestone date", "Last update", "Update", "Sections", "Update day"];
  const body = rows.map((r) => {
    const f = statusFacts(r.p, tasks, statusUpdates, today, idx);
    const biz = across ? [opts.workspaces!.find((w) => (w.id ?? null) === (r.p.workspaceId ?? null))?.name ?? ""] : [];
    return [r.p.name, ...biz, r.p.ownerId ? opts.ownerName?.(r.p.ownerId) ?? "" : "", r.status.label, r.status.sees.replace(/^Kanbo sees /, ""),
      progressOf(r.ptasks).pct, f.total, f.overdue.length, f.blocked.length, f.nextMilestone?.title ?? "", f.nextMilestone?.dueDate ?? "",
      r.latest ? r.latest.createdAt.slice(0, 10) : "", r.latest?.summary ?? "", sectionsAsText(r.latest?.sections), r.fresh.kind === "off" ? "" : r.fresh.text];
  });
  return toCsv([head, ...body]);
}

/** A file name for the export: "q3-launch-portfolio-2026-11-10.csv". */
export function portfolioFileName(name: string, today: Date, ext: "csv"): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "portfolio";
  const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return `${slug}-portfolio-${d}.${ext}`;
}

/** A clean page of the portfolio for the browser's Print dialog (Save as PDF): its sentence, its last
 *  portfolio update and every project's row. */
export function printPortfolio(pf: Pick<Portfolio, "name" | "description" | "targetDate" | "emoji">, sentence: string, rows: readonly PortfolioRowLike[],
  tasks: Task[], idx: TaskIndex, statusUpdates: StatusUpdate[], today: Date, latestPortfolioUpdate?: { summary: string; status: StatusKind; createdAt: string; sections?: UpdateSections }): void {
  const w = window.open("", "_blank");
  if (!w) return;
  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
  const trs = rows.map((r) => {
    const f = statusFacts(r.p, tasks, statusUpdates, today, idx);
    return `<tr><td><b>${esc(r.p.emoji)} ${esc(r.p.name)}</b></td><td>${esc(r.status.label)}${r.status.mismatch ? ` <span class="m">(${esc(r.status.sees)})</span>` : ""}</td>`
      + `<td>${f.pct}%</td><td>${f.nextMilestone ? `${esc(f.nextMilestone.title)}<br><span class="m">${esc(fmtShortDay(f.nextMilestone.dueDate, today))}</span>` : "—"}</td>`
      + `<td>${r.latest ? `${esc(r.latest.summary)}<br><span class="m">${esc(fmtShortDay(r.latest.createdAt, today))}</span>` : `<span class="m">${esc(r.fresh.kind === "missing" ? r.fresh.text : "No update yet")}</span>`}</td></tr>`;
  }).join("");
  const pu = latestPortfolioUpdate
    ? `<section class="pu"><h2>Latest portfolio update · ${esc(STATUS_WORDS[latestPortfolioUpdate.status])} · ${esc(fmtShortDay(latestPortfolioUpdate.createdAt, today))}</h2><p>${esc(latestPortfolioUpdate.summary)}</p>`
      + (latestPortfolioUpdate.sections ? `<p class="secs">${esc(sectionsAsText(latestPortfolioUpdate.sections)).replace(/\n/g, "<br>")}</p>` : "") + `</section>`
    : "";
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(pf.name)} — portfolio</title><style>`
    + `body{font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;padding:32px;max-width:960px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}`
    + `.sub{color:#555;font-size:14px;margin:0 0 6px}.desc{color:#444;font-size:13px;margin:0 0 18px}.pu{border:1px solid #e3e3e3;border-radius:8px;padding:12px 14px;margin:0 0 18px}`
    + `.pu h2{font-size:12px;color:#666;margin:0 0 6px;font-weight:600}.pu p{margin:0;font-size:13px;line-height:1.5}.pu .secs{margin-top:8px;color:#333}`
    + `table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #eee}th{color:#666;font-weight:600}`
    + `.m{color:#777}@media print{.noprint{display:none}body{padding:0}}</style></head><body>`
    + `<h1>${esc(pf.emoji ?? "")} ${esc(pf.name)}</h1><p class="sub">${esc(sentence)}${pf.targetDate ? ` · Target ${esc(fmtShortDay(pf.targetDate, today))}` : ""} · ${esc(today.toLocaleDateString("en-GB"))}</p>`
    + (pf.description ? `<p class="desc">${esc(pf.description)}</p>` : "") + pu
    + `<table><thead><tr><th>Project</th><th>Status</th><th>Done</th><th>Next milestone</th><th>Latest update</th></tr></thead><tbody>${trs}</tbody></table>`
    + `<p class="noprint" style="margin-top:24px;color:#888;font-size:12px">Use your browser's Print dialog to save it as a PDF.</p></body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
}

/* ============================================================
   KANBO — the pieces every business shares:
   · WorkspaceMark: a business's logo (its upload), else its first letter
     on a tile in a hue of its own (from its id, as a project's is).
   · WorkspaceChip: the small chip a row wears in All businesses (mark and
     short name), from the context App sets while the mode is on; nothing
     otherwise, so the single-workspace views are as they were.
   · AllBusinessesToggle: the opt-in switch on Today, Inbox and My tasks.
   · BusinessLeadLine: Today's brief, led by the business that needs you most
     (All businesses on), or naming the other workspace that needs you (off).
   · useGuestRow: in All businesses a row from a workspace you're a guest in
     stays view-only, as it would be there.
   ============================================================ */
import { createContext, Fragment, useCallback, useContext, useMemo, type ReactNode } from "react";
import { Icon, ProjectTile } from "../primitives";
import { getProject } from "../../data/data";
import type { Task, Workspace } from "../../data/types";
import { spectrumColor, SPECTRUM, stableHash } from "../../lib/projectIdentity";
import { shortName, type BusinessLead } from "../../lib/businesses";

export const BUSINESS_CSS = `
.kwsmark { display: inline-grid; place-items: center; flex-shrink: 0; overflow: hidden; border-radius: var(--r-xs, 4px); }
.kwsmark img { width: 100%; height: 100%; object-fit: cover; display: block; }
.kwsmark[data-size="28"], .kwsmark[data-size="32"] { border-radius: var(--r-sm, 6px); }
.kwsmark[data-size="40"] { border-radius: var(--r-md, 8px); }
.kwschip { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; max-width: 132px; height: 20px; padding: 0 7px 0 2px; border-radius: 999px;
  background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline); font: 500 11px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); white-space: nowrap; }
.kwschip > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.kwschip[data-mark] { padding: 0; background: none; box-shadow: none; }
/* in a list row's cluster it holds a column of its own, so every row's project still lines up */
.kwschip-col { display: inline-flex; flex-shrink: 0; width: 120px; min-width: 0; }
.kwschip-col > .kwschip { max-width: 100%; }
@media (max-width: 859px) {
  .kwschip-col { width: auto; }
  .kwschip-col > .kwschip { padding-right: 2px; }
  .kwschip-col > .kwschip > span:last-child { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
}
.kallbiz { display: inline-flex; align-items: center; gap: 7px; height: var(--h-sm, 28px); padding: 0 10px 0 8px; border: 0; border-radius: 999px; cursor: pointer;
  background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline); color: var(--ink-2); font: 600 12px/16px var(--font-ui, var(--font-display)); white-space: nowrap;
  transition: background var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease), box-shadow var(--d-1, 90ms) var(--ease); }
.kallbiz:hover { background: var(--fill-2); color: var(--ink); }
.kallbiz > svg { color: var(--icon-quiet, var(--ink-4)); }
.kallbiz[aria-pressed="true"] { background: var(--bg-selected, var(--accent-dim)); box-shadow: inset 0 0 0 1px var(--accent-line, var(--accent)); color: var(--ink); }
.kallbiz[aria-pressed="true"] > svg { color: var(--accent-text, var(--accent)); }
.kallbiz-sw { position: relative; width: 22px; height: 12px; border-radius: 999px; background: var(--fill-3, var(--hairline-strong)); transition: background var(--d-1, 90ms) var(--ease); }
.kallbiz-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 8px; height: 8px; border-radius: 50%; background: var(--bg-raised, #fff); box-shadow: 0 1px 1px oklch(0.2 0.03 268 / 0.25); transition: transform var(--d-2, 160ms) var(--ease); }
.kallbiz[aria-pressed="true"] .kallbiz-sw { background: var(--accent-fill, var(--accent)); }
.kallbiz[aria-pressed="true"] .kallbiz-sw::after { transform: translateX(10px); }
@media (max-width: 859px) { .kallbiz { height: 32px; } }
@media (prefers-reduced-motion: reduce) { .kallbiz-sw::after { transition: none; } }
/* Today's brief, across businesses: one sentence under the brief's words (who needs you most), the rest on a
   quieter line; no box, so the headline and Plan my day keep their place */
.kbizlead { display: flex; flex-direction: column; gap: 4px; margin: 14px 0 0; max-width: 760px; }
.kbizlead-lead { margin: 0; font: 400 15px/24px var(--font-ui, var(--font-display)); color: var(--ink-2); text-wrap: pretty; }
.kbizlead-lead > .kwsmark { margin-right: 7px; vertical-align: -3px; }
.kbizlead-lead b { font-weight: 600; color: var(--ink); }
.kbizlead-task { display: inline; padding: 0; border: 0; background: none; font: inherit; color: var(--accent-text, var(--accent)); cursor: pointer; text-align: left;
  text-decoration: underline dotted; text-underline-offset: 3px; text-decoration-thickness: 1px; border-radius: 2px; }
.kbizlead-task:hover { text-decoration-style: solid; }
.kbizlead-all { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; cursor: pointer; white-space: nowrap;
  font: 600 14px/24px var(--font-ui, var(--font-display)); color: var(--accent-text, var(--accent)); border-radius: 4px; vertical-align: baseline; }
.kbizlead-all:hover { text-decoration: underline; text-underline-offset: 3px; }
.kbizlead-all > svg { align-self: center; }
.kbizlead-rest { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 14px; margin: 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kbizlead-one { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.kbizlead-one b { font-weight: 500; color: var(--ink-2); }
@media (max-width: 859px) { .kbizlead { margin-top: 12px; } .kbizlead-what { display: none; } }
/* a workspace's mark, wearing a dot while another workspace needs you (a phone's header) */
.kwsmark-wrap { position: relative; display: inline-flex; flex-shrink: 0; }
.kwsmark-ping { position: absolute; top: -3px; right: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 2px var(--bg); }
`;

/** A workspace's mark: its logo, else its first letter on a tile in a hue of its own. Personal wears the person glyph's Iris. */
export function WorkspaceMark({ workspace, size = 16, title }: { workspace: Pick<Workspace, "id" | "name" | "logoUrl" | "kind">; size?: 16 | 20 | 28 | 32 | 40; title?: string }) {
  if (workspace.logoUrl) {
    return (
      <span className="kwsmark" data-size={size} style={{ width: size, height: size }} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
        <img src={workspace.logoUrl} alt="" />
      </span>
    );
  }
  const id = workspace.id ?? "personal";
  const hue = workspace.kind === "personal" ? "iris" : SPECTRUM[stableHash(`ws:${id}`) % SPECTRUM.length].key;
  const tile = size === 32 || size === 40 ? 28 : size;
  return (
    <span className="kwsmark" data-size={size} style={{ width: size, height: size }} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <ProjectTile project={{ id: `ws-mark:${id}`, color: spectrumColor(hue), name: workspace.name }} size={tile as 16 | 20 | 28} />
    </span>
  );
}

/* ---------- the row chip (All businesses) ---------- */

interface ChipCtx { on: boolean; byId: Map<string, Workspace>; guestIn: ReadonlySet<string> }
const NO_GUEST: ReadonlySet<string> = new Set();
const BusinessChips = createContext<ChipCtx>({ on: false, byId: new Map(), guestIn: NO_GUEST });

/** App wraps the page in this: while All businesses is on (`on`), rows show which business each task is from,
 *  and a row from a workspace you're a guest in (`guestIn`) is view-only. */
export function BusinessChipsProvider({ on, workspaces, guestIn = NO_GUEST, children }: { on: boolean; workspaces: Workspace[]; guestIn?: ReadonlySet<string>; children: ReactNode }) {
  const value = useMemo<ChipCtx>(() => ({ on, byId: new Map(workspaces.map((w) => [w.id ?? "personal", w])), guestIn }), [on, workspaces, guestIn]);
  // (the chips', the switch's and the lead line's rules, once for the page)
  return <BusinessChips.Provider value={value}><style>{BUSINESS_CSS}</style>{children}</BusinessChips.Provider>;
}

/** Is All businesses on (a row may need its chip's room)? */
export const useBusinessChips = (): boolean => useContext(BusinessChips).on;

/** In All businesses: is this row view-only (a task in a workspace you're a guest in)? Off, the page's own
 *  read-only says so for every row. */
export function useGuestRow(): (t: Pick<Task, "workspaceId"> | null | undefined) => boolean {
  const { on, guestIn } = useContext(BusinessChips);
  return useCallback((t) => on && !!t?.workspaceId && guestIn.has(t.workspaceId), [on, guestIn]);
}

/** A workspace's mark by its id (null: Personal), whether or not All businesses is on; nothing for one you can't see. */
export function WorkspaceMarkFor({ workspaceId, size = 16 }: { workspaceId: string | null; size?: 16 | 20 }) {
  const w = useContext(BusinessChips).byId.get(workspaceId ?? "personal");
  return w ? <WorkspaceMark workspace={w} size={size} /> : null;
}

/** The business a row's task (or doc) is from, while All businesses is on; nothing otherwise. `col`: a list row's own
 *  column. `mark`: just its logo (a narrow row, beside the project's own tile), its name said and shown on hover. */
export function WorkspaceChip({ projectId, col, mark }: { projectId?: string | null; col?: boolean; mark?: boolean }) {
  const { on, byId } = useContext(BusinessChips);
  if (!on || !projectId) return null;
  const p = getProject(projectId);
  if (!p) return null;
  const w = byId.get(p.workspaceId ?? "personal");
  if (!w) return null;
  if (mark) return <span className="kwschip" data-mark="" title={w.name}><WorkspaceMark workspace={w} size={16} /><span className="sr-only">In {w.name}</span></span>;
  const chip = (
    <span className="kwschip" title={w.name}>
      <WorkspaceMark workspace={w} size={16} />
      <span><span className="sr-only">In </span>{shortName(w.name, 16)}</span>
    </span>
  );
  return col ? <span className="kwschip-col">{chip}</span> : chip;
}

/** The switch on Today, Inbox and My tasks: on, every business you're in shows together. */
export function AllBusinessesToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className="kallbiz" aria-pressed={on} onClick={() => onChange(!on)}
      title={on ? "Showing every business you're in. Switch off to see just this one." : "Show every business you're in together"}>
      <Icon name="layers" size={14} sw={1.75} />
      <span>All businesses</span>
      <span className="kallbiz-sw" aria-hidden="true" />
    </button>
  );
}

const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Today's brief across businesses, under its words.
 *  · "all" (All businesses on): the business that needs you most and what it holds (its most pressing task,
 *    which opens, left out when the headline already names it), then the others on a quieter line.
 *  · "elsewhere" (off): the other workspace that needs you most, the rest by name, and a way to see them all.
 *  Nothing when nothing needs you. */
export function BusinessLeadLine({ lead, mode = "all", focusTaskId, onOpen, onShowAll }: {
  lead: BusinessLead; mode?: "all" | "elsewhere"; focusTaskId?: string; onOpen: (taskId: string) => void; onShowAll?: () => void;
}) {
  if (!lead.lead) return null;
  const l = lead.lead;
  // (the headline already names it: the sentence says what else there is)
  const named = !!l.taskId && l.taskId !== focusTaskId;
  const rest = l.taskId ? l.parts.slice(1) : l.parts;
  const task = named && l.taskId ? (
    <><button type="button" className="kbizlead-task" onClick={() => onOpen(l.taskId!)}>{l.parts[0]}</button>{l.taskWhen ? ` (${l.taskWhen})` : ""}</>
  ) : null;
  const what = task ? <>{task}{rest.length > 0 && <>{rest.length === 1 ? " and " : ", "}{listWords(rest)}</>}</> : listWords(rest);
  const hasWhat = !!task || rest.length > 0;
  if (!hasWhat && !lead.others.length) return null;

  if (mode === "elsewhere") {
    const names = lead.others.map((o) => o.workspace.name);
    const too = names.length ? ` ${listWords(names.length > 2 ? [...names.slice(0, 2), `${names.length - 2} more`] : names)} ${names.length === 1 ? "needs" : "need"} you too.` : "";
    return (
      <div className="kbizlead" data-mode="elsewhere" role="note" aria-label="Your other workspaces">
        <p className="kbizlead-lead">
          <WorkspaceMark workspace={l.workspace} size={16} />
          <b>{l.workspace.name}</b> needs you{hasWhat ? <>: {what}.</> : "."}{too}{" "}
          {onShowAll && (
            <button type="button" className="kbizlead-all" onClick={onShowAll}>Show all businesses<Icon name="arrowRight" size={14} sw={2} /></button>
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="kbizlead" role="note" aria-label="Across your workspaces">
      {hasWhat && (
        <p className="kbizlead-lead">
          <WorkspaceMark workspace={l.workspace} size={16} />
          <b>{l.workspace.name}</b> needs you most today: {what}.
        </p>
      )}
      {lead.others.length > 0 && (
        <p className="kbizlead-rest">
          {/* (the spaces are for screen readers: a flex row drops them) */}
          <span>{hasWhat ? "Then" : "Needing you today:"}</span>{" "}
          {lead.others.slice(0, 3).map((o) => (
            <Fragment key={o.key}>
              <span className="kbizlead-one">
                <WorkspaceMark workspace={o.workspace} size={16} />
                <b>{shortName(o.workspace.name)}</b>{" "}
                <span className="kbizlead-what">· {o.detail}</span>
              </span>{" "}
            </Fragment>
          ))}
          {lead.others.length > 3 && <span>+{lead.others.length - 3} more</span>}
        </p>
      )}
    </div>
  );
}

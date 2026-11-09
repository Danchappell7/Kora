/* ============================================================
   KANBO — the pieces every business shares:
   · WorkspaceMark: a business's logo (its upload), else its first letter
     on a tile in a hue of its own (from its id, as a project's is).
   · WorkspaceChip: the small chip a row wears in All businesses (mark and
     short name), from the context App sets while the mode is on; nothing
     otherwise, so the single-workspace views are as they were.
   · AllBusinessesToggle: the opt-in switch on Today, Inbox and My tasks.
   · BusinessLeadLine: Today's brief, led by the business that needs you most.
   ============================================================ */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Icon, ProjectTile } from "../primitives";
import { getProject } from "../../data/data";
import type { Workspace } from "../../data/types";
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
@media (max-width: 859px) { .kallbiz { height: 32px; } .kbizlead-rest { padding-left: 0; } }
@media (prefers-reduced-motion: reduce) { .kallbiz-sw::after { transition: none; } }
/* Today's brief, in All businesses: who needs you most, then the rest */
.kbizlead { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 12px 0 0; padding: 10px 12px; border-radius: var(--r-md, 8px);
  background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline); font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); max-width: 820px; }
.kbizlead-lead { display: inline-flex; align-items: flex-start; gap: 8px; min-width: 0; color: var(--ink); }
.kbizlead-lead > .kwsmark { margin-top: 0; }
.kbizlead-lead b { font-weight: 600; }
.kbizlead-task { padding: 0; border: 0; background: none; font: inherit; color: var(--accent-text, var(--accent)); cursor: pointer; text-align: left;
  text-decoration: underline dotted; text-underline-offset: 3px; text-decoration-thickness: 1px; }
.kbizlead-task:hover { text-decoration-style: solid; }
.kbizlead-rest { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; flex-basis: 100%; padding-left: 28px; color: var(--ink-3); }
.kbizlead-one { display: inline-flex; align-items: center; gap: 6px; }
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

interface ChipCtx { on: boolean; byId: Map<string, Workspace> }
const BusinessChips = createContext<ChipCtx>({ on: false, byId: new Map() });

/** App wraps the page in this while All businesses is on: rows then show which business each task is from. */
export function BusinessChipsProvider({ on, workspaces, children }: { on: boolean; workspaces: Workspace[]; children: ReactNode }) {
  const value = useMemo<ChipCtx>(() => ({ on, byId: new Map(workspaces.map((w) => [w.id ?? "personal", w])) }), [on, workspaces]);
  // (the chips', the switch's and the lead line's rules, once for the page)
  return <BusinessChips.Provider value={value}><style>{BUSINESS_CSS}</style>{children}</BusinessChips.Provider>;
}

/** Is All businesses on (a row may need its chip's room)? */
export const useBusinessChips = (): boolean => useContext(BusinessChips).on;

/** The business a row's task (or doc) is from, while All businesses is on; nothing otherwise. `col`: a list row's own column. */
export function WorkspaceChip({ projectId, col }: { projectId?: string | null; col?: boolean }) {
  const { on, byId } = useContext(BusinessChips);
  if (!on || !projectId) return null;
  const p = getProject(projectId);
  if (!p) return null;
  const w = byId.get(p.workspaceId ?? "personal");
  if (!w) return null;
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

/** Today's brief in All businesses: the business that needs you most, its most pressing task (it opens),
 *  then the others in a quieter line. Nothing when no business needs you. */
export function BusinessLeadLine({ lead, onOpen }: { lead: BusinessLead; onOpen: (taskId: string) => void }) {
  if (!lead.lead) return null;
  const l = lead.lead;
  const [first, ...rest] = l.parts;
  return (
    <div className="kbizlead" role="note" aria-label="Across your businesses">
      <span className="kbizlead-lead">
        <WorkspaceMark workspace={l.workspace} size={20} />
        <span>
          <b>{l.workspace.name}</b> needs you most today:{" "}
          {l.taskId && first
            ? <button type="button" className="kbizlead-task" onClick={() => onOpen(l.taskId!)}>{first}</button>
            : first}
          {rest.length > 0 && <>{rest.length === 1 ? " and " : ", "}{rest.join(", ").replace(/, ([^,]*)$/, " and $1")}</>}.
        </span>
      </span>
      {lead.others.length > 0 && (
        <span className="kbizlead-rest">
          {lead.others.slice(0, 3).map((o) => (
            <span key={o.key} className="kbizlead-one">
              <WorkspaceMark workspace={o.workspace} size={16} />
              <span>{shortName(o.workspace.name)}: {o.parts.slice(0, 2).join(", ")}</span>
            </span>
          ))}
          {lead.others.length > 3 && <span>+{lead.others.length - 3} more</span>}
        </span>
      )}
    </div>
  );
}

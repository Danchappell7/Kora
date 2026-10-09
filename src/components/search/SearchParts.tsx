/* ============================================================
   KANBO — the pieces of universal search: highlighted text (<mark>,
   never HTML), the search box with the words it read as filters tinted
   behind them, the chips for those filters (each removable), the
   filters panel, the hit rows for comments, docs, projects and people
   (the Inbox's two-line row), and the start page (recent searches and
   ways to ask). Used by views/SearchView; ⌘K draws its own rows.
   ============================================================ */
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Avatar, Icon, IconButton, Pill, ProjectTile } from "../primitives";
import { getMember, timeAgo } from "../../data/data";
import { splitHighlights } from "../../lib/searchRows";
import { CHIP_ICON, chipSpoken } from "../../lib/search/chips";
import type { SearchChipKind, SearchHit } from "../../data/types";

/* ------------------------------------------------------------------ highlights */

export type Runs = { text: string; hit: boolean }[];
export function Highlighted({ runs, className }: { runs: Runs; className?: string }) {
  return (
    <span className={className}>
      {runs.map((r, i) => (r.hit ? <mark key={i} className="ksr-hl">{r.text}</mark> : <span key={i}>{r.text}</span>))}
    </span>
  );
}
/** A title whose searched words are painted by the CSS Custom Highlight API (lib/search/useTextHighlights):
 *  the text stays one text node, so it reads (and copies, and is found) whole. */
export function HighlightTitle({ text, className }: { text: string; className?: string }) {
  return <span className={className} data-hl="">{text}</span>;
}
export const plainRuns = (runs: Runs) => runs.map((r) => r.text).join("");

/* ------------------------------------------------------------------ the box */

export function SearchBox({ value, onChange, onKeyDown, spans, inputRef, label, placeholder, busy, onClear, describedBy, controls }: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** where the words read as filters are ([start, end)) */
  spans: [number, number][];
  inputRef: RefObject<HTMLInputElement>;
  label: string;
  placeholder: string;
  busy?: boolean;
  onClear: () => void;
  describedBy?: string;
  controls?: string;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const sync = () => { const el = inputRef.current, m = mirrorRef.current; if (el && m) m.style.transform = `translateX(${-el.scrollLeft}px)`; };
  useLayoutEffect(sync);
  const marks: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (a < at || b > value.length) continue;
    if (a > at) marks.push(value.slice(at, a));
    marks.push(<mark key={a} className="ksr-tok">{value.slice(a, b)}</mark>);
    at = b;
  }
  marks.push(value.slice(at));
  return (
    <div className="ksr-box" data-busy={busy || undefined}>
      <Icon className="ksr-ico" name="search" size={16} sw={1.75} />
      <div className="ksr-field">
        {spans.length > 0 && <div ref={mirrorRef} className="ksr-mirror" aria-hidden="true">{marks}</div>}
        <input ref={inputRef} className="ksr-input" type="search" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
          onScroll={sync} onSelect={sync} placeholder={placeholder} aria-label={label} aria-describedby={describedBy} aria-controls={controls}
          enterKeyHint="search" autoComplete="off" autoCorrect="off" spellCheck={false} data-focus-ring="none" />
      </div>
      {value && <IconButton icon="x" size="sm" label="Clear search" onClick={onClear} />}
    </div>
  );
}

/* ------------------------------------------------------------------ chips */

export { chipSpoken };

export function SearchChips({ chips, onRemove, onClearAll, label = "Read as" }: {
  chips: { id: string; kind: SearchChipKind; label: string }[];
  onRemove: (id: string) => void;
  onClearAll?: () => void;
  label?: string;
}) {
  if (!chips.length) return null;
  return (
    <div className="ksr-chips" role="group" aria-label="Filters read from your search">
      <span className="ksr-chips-label" aria-hidden="true">{label}</span>
      {chips.map((c) => (
        <span key={c.id} className="ksr-chip" data-kind={c.kind}>
          <Icon name={CHIP_ICON[c.kind]} size={13} sw={2} />
          <span>{c.label}</span>
          <button type="button" className="ksr-chip-x" aria-label={`Remove filter: ${chipSpoken(c)}`} title="Remove this filter" onClick={() => onRemove(c.id)}>
            <Icon name="x" size={12} sw={2.25} />
          </button>
        </span>
      ))}
      {onClearAll && chips.length > 1 && <button type="button" className="ksr-link" onClick={onClearAll}>Clear all</button>}
    </div>
  );
}

/* ------------------------------------------------------------------ filters panel */

export type Opt = { value: string; label: string; group?: string };
/** A select must never read "Any …" while a filter is applied: an active value that isn't offered is added. */
export function withCurrent(opts: Opt[], value: string, label: (v: string) => string): Opt[] {
  return value === "all" || opts.some((o) => o.value === value) ? opts : [...opts, { value, label: label(value) }];
}
/** A filter that is narrowing the results is tinted, so an applied filter reads at a glance. */
export function FilterSelect({ label, anyLabel, value, options, onChange, id }: { label: string; anyLabel: string; value: string; options: Opt[]; onChange: (v: string) => void; id?: string }) {
  const plain = options.filter((o) => !o.group);
  const groups = [...new Set(options.filter((o) => o.group).map((o) => o.group!))];
  return (
    <select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="ktv-search-select" data-on={value !== "all" || undefined}>
      <option value="all">{anyLabel}</option>
      {plain.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {options.filter((o) => o.group === g).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
export interface PanelField { key: string; title: string; label: string; anyLabel: string; value: string; options: Opt[]; onChange: (v: string) => void }
export function FiltersPanel({ id, fields, archived, onReset }: {
  id: string;
  fields: PanelField[];
  archived?: { on: boolean; onToggle: () => void } | null;
  onReset?: () => void;
}) {
  return (
    <div id={id} className="ksr-panel" role="region" aria-label="Filters">
      {fields.map((f) => (
        <div key={f.key} className="ksr-field-row">
          <span className="ksr-flabel" aria-hidden="true">{f.title}</span>
          <FilterSelect label={f.label} anyLabel={f.anyLabel} value={f.value} options={f.options} onChange={f.onChange} />
        </div>
      ))}
      {(archived || onReset) && (
        <div className="ksr-panel-foot">
          {archived && (
            <button type="button" className="ktv-chip ktv-chip-lg" aria-pressed={archived.on} onClick={archived.onToggle}
              title="Archived tasks, docs and projects (and what's in archived projects) are hidden unless this is on">
              <Icon name="archive" size={14} sw={1.75} /><span>Include archived</span>
            </button>
          )}
          {onReset && <button type="button" className="ksr-link" onClick={onReset}>Reset filters</button>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ hit rows (not tasks) */

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", guest: "Guest" };

export interface HitRowProps {
  hit: SearchHit;
  rowId: string;
  cursor?: boolean;
  onOpen: (hit: SearchHit) => void;
  projectOf?: (id: string | null) => { id: string; name: string; color: string; emoji?: string } | undefined;
  workspaceName?: (id: string | null) => string | undefined;
}

/** One comment, doc, project or person: avatar or icon, a title line, the excerpt, when. */
export function HitRow({ hit, rowId, cursor, onOpen, projectOf, workspaceName }: HitRowProps) {
  const snippetRuns: Runs = splitHighlights(hit.snippet);
  const snippetText = plainRuns(snippetRuns);
  const project = projectOf?.(hit.projectId);
  const when = hit.updatedAt ? timeAgo(hit.updatedAt) : "";
  let av: ReactNode, say: ReactNode, sub: ReactNode, aria = "", side: ReactNode = null;
  if (hit.kind === "comment") {
    const name = hit.comment?.authorName || getMember(hit.comment?.authorId ?? "")?.name || "Someone";
    const known = hit.comment?.authorId && getMember(hit.comment.authorId);
    av = known ? <span className="ksr-av"><Avatar id={hit.comment!.authorId!} size={28} /></span> : <span className="ksr-av">{initials(name)}</span>;
    say = <><strong className="ksr-t" style={{ flexShrink: 0 }}>{name}</strong><span className="ksr-dim">on</span><HighlightTitle className="ksr-t" text={hit.title || "Untitled task"} /></>;
    sub = snippetText ? <Highlighted className="ksr-snip" runs={snippetRuns} /> : null;
    aria = `Comment by ${name} on ${hit.title || "Untitled task"}${snippetText ? `: ${snippetText}` : ""}${when ? `, ${when}` : ""}`;
  } else if (hit.kind === "doc") {
    av = <span className="ksr-av" data-kind="icon" aria-hidden="true">{hit.doc?.icon || <Icon name="notes" size={14} sw={1.75} />}</span>;
    const where = project?.name ?? hit.doc?.projectName ?? undefined;
    say = (
      <>
        <HighlightTitle className="ksr-t" text={hit.title || "Untitled"} />
        {where && <span className="ksr-where">{project && <ProjectTile project={project} size={16} />}<span>{where}</span></span>}
      </>
    );
    sub = snippetText ? <Highlighted className="ksr-snip" runs={snippetRuns} /> : null;
    aria = `Doc ${hit.title || "Untitled"}${where ? ` in ${where}` : ""}${hit.doc?.archived ? ", archived" : ""}${snippetText ? `: ${snippetText}` : ""}`;
    if (hit.doc?.archived) side = <Pill tone="neutral" icon="archive">Archived</Pill>;
  } else if (hit.kind === "project") {
    const p = project ?? { id: hit.id, name: hit.title, color: hit.project?.color ?? "", emoji: hit.project?.emoji ?? undefined };
    av = <span className="ksr-av" style={{ background: "none" }} aria-hidden="true"><ProjectTile project={p} size={28} /></span>;
    say = <HighlightTitle className="ksr-t" text={hit.title} />;
    const ws = workspaceName?.(hit.workspaceId);
    sub = snippetText ? <Highlighted className="ksr-snip" runs={snippetRuns} /> : <span className="ksr-sub-meta">{ws ? `Project in ${ws}` : "Project"}</span>;
    aria = `Project ${hit.title}${ws ? ` in ${ws}` : ""}${hit.project?.archived ? ", archived" : ""}${snippetText ? `: ${snippetText}` : ""}`;
    if (hit.project?.archived) side = <Pill tone="neutral" icon="archive">Archived</Pill>;
  } else {
    const known = getMember(hit.id);
    av = known ? <span className="ksr-av"><Avatar id={hit.id} size={28} /></span> : <span className="ksr-av">{initials(hit.title)}</span>;
    say = <HighlightTitle className="ksr-t" text={hit.title} />;
    const bits = [hit.person?.email || known?.email, hit.person?.title, hit.person?.role ? ROLE[hit.person.role] : null].filter(Boolean) as string[];
    sub = bits.length ? <span className="ksr-sub-meta">{bits.join(" · ")}</span> : null;
    aria = `${hit.title}${bits.length ? `, ${bits.join(", ")}` : ""}`;
  }
  const showWhen = hit.kind === "comment" || hit.kind === "doc";
  return (
    <div className="ksr-hit" data-row-id={rowId} data-kind={hit.kind} data-cursor={cursor || undefined}>
      {av}
      <button type="button" className="ksr-main" data-search-result aria-label={aria} onClick={() => onOpen(hit)}>
        <span className="ksr-say">{say}</span>
        {sub && <span className="ksr-sub">{sub}</span>}
      </button>
      {side}
      {showWhen && when && <time className="ksr-when" dateTime={hit.updatedAt ?? undefined} aria-hidden="true">{when}</time>}
    </div>
  );
}

/* ------------------------------------------------------------------ the start page */

export function SearchStart({ recents, onPick, onForget, onForgetAll, examples }: {
  recents: string[];
  onPick: (text: string) => void;
  onForget: (text: string) => void;
  onForgetAll: () => void;
  examples: string[];
}) {
  return (
    <div className="ksr-start">
      {recents.length > 0 && (
        <section aria-labelledby="ksr-recent-h">
          <div className="ksr-start-head">
            <h3 id="ksr-recent-h">Recent searches</h3>
            <button type="button" className="ksr-link" aria-label="Clear recent searches" onClick={onForgetAll}>Clear</button>
          </div>
          <ul>
            {recents.map((r) => (
              <li key={r}>
                <button type="button" className="ksr-pick" data-search-result onClick={() => onPick(r)} aria-label={`Search again for ${r}`}>
                  <Icon name="clock" size={14} sw={1.75} /><span>{r}</span>
                </button>
                <IconButton className="ksr-forget" icon="x" size="sm" label={`Remove ${r} from recent searches`} onClick={() => onForget(r)} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="ksr-try-h">
        <div className="ksr-start-head"><h3 id="ksr-try-h">Try asking</h3></div>
        <ul>
          {examples.map((x) => (
            <li key={x}>
              <button type="button" className="ksr-pick" data-search-result onClick={() => onPick(x)}>
                <Icon name="search" size={14} sw={1.75} /><span>{x}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="ksr-tip">Names, projects, statuses and dates become filters you can remove. Put words in <q>quotes</q> to search for them exactly.</p>
      </section>
    </div>
  );
}

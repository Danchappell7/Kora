/* ============================================================
   KANBO — a portfolio's own page (/projects/portfolios/:id, 0054,
   c-portfolio-workspace phase one). Opening a portfolio feels like
   opening a project: its identity (hue band and tile), who owns it,
   what it's for, when it lands and who follows it, then one sentence
   in the Today brief's voice ("6 projects: 4 on track, 1 at risk, 1
   silent for 3 weeks"). Two tabs:
     · Table — the exec table (one pill per project, progress, next
       milestone, its update against its update day), projects added
       several at once, CSV and Print (Save as PDF);
     · Updates — the portfolio update Kanbo drafts from its projects'
       latest updates and health (its AI, else on this device) for the
       owner to post, its earlier ones, then each project's latest.
   Writers change it; a guest never gets here (portfolios are for
   members, 0051). A Personal portfolio spans businesses and is yours
   alone. Before 0054 the details and portfolio updates say they
   aren't switched on yet.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import { AiMark, Avatar, AvatarStack, Button, DateChip, EmptyState, Icon, IconButton, Pill, ProjectCover, ProjectTile, Provenance, Segmented } from "../primitives";
import { Popover } from "../primitives/Popover";
import { getMember, KANBO_TODAY, todayISO, WORKSPACES } from "../../data/data";
import { accessOn, visibilityOf } from "../../lib/projectAccess";
import type { Portfolio, PortfolioUpdate, Project, StatusKind, StatusUpdate, Task, UpdateSections, Workspace } from "../../data/types";
import type { PortfolioPatch } from "../../data/store";
import type { AiOutcome } from "../../lib/askTypes";
import { fmtShortDay, indexTasks, updateAuthor } from "../../lib/statusDraft";
import { combinedProgress } from "../../lib/countRules";
import { STATUS_TONES, STATUS_WORDS } from "../../lib/honestStatus";
import { hasSections, SECTION_HINTS, SECTION_KEYS, SECTION_LABELS, SECTION_MAX } from "../../lib/updateSections";
import { draftPortfolioLocal, portfolioCsv, portfolioFactsForAi, portfolioFileName, portfolioSentence, printPortfolio } from "../../lib/portfolioDraft";
import { deletePortfolioUpdate, editPortfolioUpdate, postPortfolioUpdate, usePortfolioUpdates } from "../../lib/portfolioUpdates";
import { downloadCsv } from "../../lib/exportTasks";
import type { AskForUpdate } from "../../lib/updateAsks";
import { DraftInput } from "../project/DraftInput";
import { EditIdentitySheet } from "../project/IdentityPicker";
import { POP_STYLE, STATUS_OPTIONS } from "../project/StatusComposer";
import { MergedStatusPill } from "../updates/MergedStatusPill";
import { AskForUpdateButton } from "../updates/AskForUpdate";
import { UpdateSectionsList } from "../updates/UpdateCard";
import { WorkspaceMark } from "../businesses/Businesses";
import { shortName } from "../../lib/businesses";
import { AddProjectsPicker } from "./AddProjectsPicker";
import { ACROSS_CSS, asIdentity, portfolioRows, PortfolioTable, type PfRow } from "./PortfoliosView";
import "../project/projects.css";
import "../updates/conversation.css";
import "./portfolio.css";

export type PortfolioTab = "table" | "updates";
export type AiPortfolio = (facts: unknown) => Promise<AiOutcome<{ summary: string; status: StatusKind; sections?: UpdateSections }>>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** 0058: a team portfolio's updates are read by everyone in its workspace, so Kanbo drafts one only
 *  from the projects they can all see (Whole workspace, or any while project access is off). The
 *  server can't scrub free text: this is the only place it's kept out. A Personal portfolio is yours. */
export function draftableRows(pf: Pick<Portfolio, "workspaceId">, rows: PfRow[], workspaces: Pick<Workspace, "id" | "projectAccess">[]): PfRow[] {
  if (!pf.workspaceId) return rows;
  return rows.filter((r) => !accessOn(workspaces.find((w) => w.id === (r.p.workspaceId ?? null))) || visibilityOf(r.p) === "workspace");
}

/** The portfolio update Kanbo drafts for its owner, and its earlier ones. */
function PortfolioUpdates({ pf, rows: allRows, tasks, statusUpdates, me, canWrite, lead, owner, aiPortfolio, onOpenProject }: {
  pf: Portfolio; rows: PfRow[]; tasks: Task[]; statusUpdates: StatusUpdate[]; me: string; canWrite: boolean; lead: boolean;
  owner: string | null; aiPortfolio?: AiPortfolio; onOpenProject: (id: string) => void;
}) {
  // (what Kanbo drafts from; each project's latest, below, is still every one you can see)
  const rows = draftableRows(pf, allRows, WORKSPACES);
  const leftOut = allRows.length - rows.length;
  const { updates, on } = usePortfolioUpdates(pf.id);
  const idx = useMemo(() => indexTasks(tasks), [tasks]);
  const isOwner = !!owner && owner === me;
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<StatusKind>("on_track");
  const [sections, setSections] = useState<UpdateSections>({});
  const [source, setSource] = useState<"ai" | "template" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // the owner opens to Kanbo's draft; once they've posted it, it folds back to "Draft a portfolio update"
  const [posted, setPosted] = useState(false);
  const open = canWrite && on && (writing || (isOwner && !posted));
  // (nothing everyone can see: nothing to draft from, and the note below says why)
  const local = () => (rows.length || !leftOut ? draftPortfolioLocal(rows, tasks, idx, statusUpdates, KANBO_TODAY, owner)
    : { summary: "", status: "on_track" as StatusKind, sections: {} as UpdateSections });
  const draft = async () => {
    if (drafting) return;
    setErr(null);
    const fill = (d: { summary: string; status: StatusKind; sections?: UpdateSections }, from: "ai" | "template", why: string | null) => {
      setText(d.summary); setKind(d.status); setSections(d.sections ?? {}); setSource(from); setNote(why);
    };
    if (!aiPortfolio || (!rows.length && leftOut)) { fill(local(), "template", null); return; }
    setDrafting(true);
    let out: Awaited<ReturnType<AiPortfolio>> | null = null;
    try { out = await aiPortfolio(portfolioFactsForAi(pf, rows, tasks, idx, statusUpdates, KANBO_TODAY, owner)); } catch { out = null; }
    setDrafting(false);
    if (out?.source === "ai" && out.data?.summary) fill(out.data, "ai", null);
    else fill(local(), "template", out?.source === "limit" ? "You've used today's Kanbo drafts, so this one was written on this device." : "Kanbo couldn't draft this one just now, so it was written on this device.");
  };
  const post = async () => {
    if (!text.trim() || posting) return;
    setPosting(true); setErr(null);
    try {
      await postPortfolioUpdate(pf.id, { summary: text, status: kind, sections: hasSections(sections) ? sections : undefined }, me);
      setText(""); setSections({}); setSource(null); setNote(null); setWriting(false); setPosted(true);
    } catch (e) { setErr((e as Error).message); }
    setPosting(false);
  };
  // the owner opens to Kanbo's draft, ready to post (on-device first: Kanbo's own is a click away)
  const seeded = useRef(false);
  useEffect(() => {
    if (!open || seeded.current || text || drafting) return;
    seeded.current = true;
    const d = local();
    setText(d.summary); setKind(d.status); setSections(d.sections); setSource("template");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const latestOfEach = allRows.filter((r) => r.latest);
  const ownerName = owner ? getMember(owner)?.name : undefined;
  return (
    <div className="kpf-updates">
      <section aria-label="Portfolio update">
        <h2 className="kpf-h2">Portfolio update {updates.length > 0 && <span className="kpj-count">{updates.length}</span>}</h2>
        {!on ? (
          <p className="kpf-off">Portfolio updates aren't switched on yet. Each project's latest update is below.</p>
        ) : open ? (
          <div className="kpf-compose kpj-composer">
            {!isOwner && <p className="kpf-compose-note">{ownerName ? `${firstName(ownerName)} owns this portfolio. ` : ""}Kanbo can draft it from the projects' latest updates.</p>}
            <Segmented ariaLabel="Portfolio status" options={STATUS_OPTIONS} value={kind} onChange={setKind} />
            <div className={source === "ai" ? "kvellum" : "kpj-draft"}>
              <textarea className={source === "ai" ? undefined : "kpj-field"} rows={4} value={text} aria-label="Portfolio update" placeholder={drafting ? "Kanbo is drafting…" : "How is the portfolio going?"}
                aria-busy={drafting || undefined} onChange={(e) => { setText(e.target.value); }} style={{ width: "100%" }}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void post(); } }} />
              {source === "ai" && <Provenance summary={`from ${plural(rows.length, "project")}' latest updates`} details={rows.map((r) => `${r.p.name}: ${r.status.label}`)} />}
            </div>
            {source === "template" && <p className="kpj-composer-note">{note ?? "Kanbo drafted this on this device from the projects' latest updates."} {isOwner ? "Edit it, then post it for your followers." : "Edit it before you post."}</p>}
            {leftOut > 0 && <p className="kpj-composer-note" title="Everyone here reads a portfolio update, so Kanbo leaves out projects not everyone can see.">Leaves out {plural(leftOut, "private project")}.</p>}
            <fieldset className="kuc-sec">
              {SECTION_KEYS.map((k) => (
                <label key={k} className="kuc-sec-row">
                  <span className="kuc-sec-label">{SECTION_LABELS[k]}</span>
                  <textarea className="kpj-field kuc-sec-field" rows={k === "highlights" || k === "risks" ? 2 : 1} maxLength={SECTION_MAX} value={sections[k] ?? ""}
                    placeholder={SECTION_HINTS[k]} onChange={(e) => setSections((s) => ({ ...s, [k]: e.target.value }))} />
                </label>
              ))}
            </fieldset>
            <div className="kpj-composer-foot">
              <Button variant="ghost" size="sm" onClick={() => void draft()} aria-busy={drafting || undefined}>
                <span className="kpj-btn-mark"><AiMark size={14} thinking={drafting} />{drafting ? "Drafting" : text.trim() ? "Redraft" : "Draft it for me"}</span>
              </Button>
              <span className="kpj-spacer" />
              {(!isOwner || posted) && <Button variant="ghost" size="sm" onClick={() => setWriting(false)}>Cancel</Button>}
              <Button variant="primary" size="sm" onClick={() => void post()} disabled={!text.trim() || posting} loading={posting}>Post update</Button>
            </div>
            {err && <p className="kuc-err" role="alert">{err}</p>}
          </div>
        ) : canWrite ? (
          <Button variant="secondary" size="sm" onClick={() => { setWriting(true); void draft(); }}>
            <span className="kpj-btn-mark"><AiMark size={14} />Draft a portfolio update</span>
          </Button>
        ) : null}
        {on && updates.length > 0 && (
          <ol className="kpf-hist" aria-label="Earlier portfolio updates" style={{ marginTop: 12 }}>
            {updates.map((u) => <PortfolioUpdateItem key={u.id} u={u} me={me} canWrite={canWrite} lead={lead} editing={editing === u.id} onEdit={setEditing} />)}
          </ol>
        )}
        {on && !updates.length && !open && <p className="kpf-off">No portfolio update yet.</p>}
      </section>
      <section aria-label="Each project's latest update">
        <h2 className="kpf-h2">Latest from each project</h2>
        {latestOfEach.length === 0 ? <p className="kpf-off">None of its projects has posted an update yet.</p> : (
          <ol className="kpf-latest">
            {allRows.map((r) => {
              const u = r.latest;
              const by = u ? updateAuthor(u) : undefined;
              return (
                <li key={r.p.id}>
                  <ProjectTile project={r.p} size={28} />
                  <div>
                    <div className="kpf-latest-head">
                      <button type="button" className="kpf-latest-name" onClick={() => onOpenProject(r.p.id)} aria-label={`Open project ${r.p.name}`}>{r.p.name}</button>
                      <MergedStatusPill m={r.status} />
                      {u && <span className="kpf-latest-meta">{by ? `${by} · ` : ""}{fmtShortDay(u.createdAt, KANBO_TODAY)}{u.editedAt ? " · edited" : ""}</span>}
                      {r.fresh.kind === "missing" && <span className="kup-fresh" data-kind="missing" title={r.fresh.title}>{r.fresh.text}</span>}
                    </div>
                    {u ? <>
                      <p className="kpf-latest-text">{u.summary}</p>
                      <UpdateSectionsList sections={u.sections} askUserIds={u.askUserIds} me={me} />
                    </> : <p className="kpf-latest-text">No update yet.</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

function PortfolioUpdateItem({ u, me, canWrite, lead, editing, onEdit }: { u: PortfolioUpdate; me: string; canWrite: boolean; lead: boolean; editing: boolean; onEdit: (id: string | null) => void }) {
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState(u.summary);
  const [kind, setKind] = useState<StatusKind>(u.status);
  const [err, setErr] = useState<string | null>(null);
  const by = updateAuthor(u);
  const mine = !!u.authorId && u.authorId === me;
  const canEdit = mine && canWrite;
  const canDelete = (mine && canWrite) || lead;
  return (
    <li>
      <div className="kpj-history-meta">
        <Pill tone={STATUS_TONES[u.status]}>{STATUS_WORDS[u.status]}</Pill>
        {by && <span className="kpj-history-by">{u.authorId && getMember(u.authorId) && <Avatar id={u.authorId} size={18} />}{by}</span>}
        <span className="kpj-mono">{fmtShortDay(u.createdAt, KANBO_TODAY)}</span>
        {u.editedAt && <span className="kuc-edited" title={`Edited ${new Date(u.editedAt).toLocaleString("en-GB")}`}>· edited</span>}
        {(canEdit || canDelete) && !editing && (
          <span className="kuc-more"><IconButton ref={moreRef} icon="more" size="sm" label="Portfolio update actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} /></span>
        )}
        <Popover open={menu} anchorRef={moreRef} onClose={() => setMenu(false)} role="menu" label="Portfolio update actions" align="end" minWidth={180} className="kpj-pop" style={{ ...POP_STYLE, padding: 4 }}>
          {canEdit && <button type="button" role="menuitem" className="kpj-menu-item" onClick={() => { setMenu(false); setText(u.summary); setKind(u.status); onEdit(u.id); }}><Icon name="notes" size={16} sw={1.75} />Edit update</button>}
          {canDelete && (
            <button type="button" role="menuitem" className="kpj-menu-item" data-tone="danger"
              onClick={() => { setMenu(false); if (window.confirm("Delete this portfolio update? This can't be undone.")) deletePortfolioUpdate(u).catch((e: Error) => setErr(e.message)); }}>
              <Icon name="trash" size={16} sw={1.75} />Delete update
            </button>
          )}
        </Popover>
      </div>
      {editing ? (
        <div className="kuc-edit kpj-composer">
          <Segmented ariaLabel="Portfolio status" options={STATUS_OPTIONS} value={kind} onChange={setKind} />
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <textarea autoFocus className="kpj-field" rows={3} value={text} aria-label="Portfolio update" onChange={(e) => setText(e.target.value)} />
          <div className="kuc-edit-foot">
            <Button variant="ghost" size="sm" onClick={() => onEdit(null)}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={!text.trim()}
              onClick={() => editPortfolioUpdate(u, { summary: text, status: kind }).then(() => onEdit(null), (e: Error) => setErr(e.message))}>Save</Button>
          </div>
        </div>
      ) : <>
        <p className="kpj-history-text">{u.summary}</p>
        <UpdateSectionsList sections={u.sections} />
      </>}
      {err && <p className="kuc-err" role="alert">{err}</p>}
    </li>
  );
}

export function PortfolioPage({ portfolio: pf, projects, tasks, statusUpdates, members, me, readOnly = false, lead = false, acrossBusinesses, asks,
  tab, onTab, onBack, onUpdate, onDelete, onOpenProject, aiPortfolio, onOpenInsights }: {
  portfolio: Portfolio;
  /** the projects it can hold: the workspace's (Personal: every business you're in) */
  projects: Project[];
  /** the workspace's tasks, archived projects' included (Personal: every workspace's) */
  tasks: Task[];
  statusUpdates: StatusUpdate[];
  /** who can own or follow it: the workspace's owners, admins and members (Personal: you) */
  members: { id: string; name: string }[];
  me: string;
  readOnly?: boolean;
  /** an owner or admin of its workspace (deletes any portfolio update) */
  lead?: boolean;
  acrossBusinesses?: { workspaces: Workspace[] };
  asks?: AskForUpdate;
  tab: PortfolioTab;
  onTab: (t: PortfolioTab) => void;
  onBack: () => void;
  onUpdate: (id: string, patch: PortfolioPatch) => void;
  onDelete: (id: string) => void;
  onOpenProject: (projectId: string) => void;
  aiPortfolio?: AiPortfolio;
  /** Team › Insights for just these projects (team workspaces) */
  onOpenInsights?: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [identity, setIdentity] = useState(false);
  const [followOpen, setFollowOpen] = useState(false);
  const followRef = useRef<HTMLButtonElement>(null);
  const idx = useMemo(() => indexTasks(tasks), [tasks]);
  const today = todayISO();
  const across = acrossBusinesses ?? null;
  // 0054's details (owner, description, date, followers, look): rows read before it carry none
  // (one just made, still on its way to the database, shows them: they're saved once it's there)
  const detailsOn = pf.followerIds !== undefined || pf.id.startsWith("tmp-");
  const { updates: pfUpdates } = usePortfolioUpdates(pf.id);
  const findProject = (pid: string) => projects.find((p) => p.id === pid);
  const inPf = pf.projectIds.map(findProject).filter((p): p is Project => !!p);
  // (re-read when the day turns over in a tab left open)
  const rows = useMemo(() => portfolioRows(inPf, tasks, idx, statusUpdates, KANBO_TODAY, WORKSPACES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pf.projectIds.join(","), projects, tasks, idx, statusUpdates, today]);
  const sentence = portfolioSentence(rows, KANBO_TODAY);
  const pct = combinedProgress(rows.flatMap((r) => r.ptasks), inPf.map((p) => p.id)).pct;
  const followers = (pf.followerIds ?? []).filter((id) => getMember(id));
  const following = followers.includes(me);
  const owner = pf.ownerId ?? null;
  const canWrite = !readOnly;
  const ident = asIdentity(pf);
  const available = projects.filter((p) => p.id !== "p-personal" && !pf.projectIds.includes(p.id) && !p.archivedAt);
  const askFor = (r: PfRow) => !readOnly && (r.fresh.kind === "missing" || r.fresh.kind === "due") ? <AskForUpdateButton project={r.p} asks={asks} /> : null;
  const bizOf = across ? (p: Project) => {
    const w = across.workspaces.find((x) => (x.id ?? null) === (p.workspaceId ?? null));
    return w ? <span className="kpj-pf-biz"><WorkspaceMark workspace={w} size={16} /><span>{shortName(w.name)}</span></span> : null;
  } : undefined;
  const csv = () => downloadCsv(portfolioFileName(pf.name, KANBO_TODAY, "csv"),
    portfolioCsv(rows, tasks, idx, statusUpdates, KANBO_TODAY, { ownerName: (id) => getMember(id)?.name, workspaces: across?.workspaces }));
  // (its latest portfolio update heads the page: what a meeting most wants)
  const print = () => printPortfolio(ident.emoji ? { ...pf, emoji: ident.emoji } : pf, sentence, rows, tasks, idx, statusUpdates, KANBO_TODAY, pfUpdates[0]);
  const lands = pf.targetDate ? fmtShortDay(pf.targetDate, KANBO_TODAY) : null;

  return (
    <div className="kpj-page kpf-page">
      {/* (across businesses: each project says which business it's from, as on the list) */}
      {across && <style>{ACROSS_CSS}</style>}
      <div className="kpj-wrap" data-across={across ? "" : undefined}>
        <button type="button" className="kpf-back" onClick={onBack}><Icon name="chevronLeft" size={14} sw={2} />All portfolios</button>
        <div className="kpf-hero">
          <ProjectCover project={ident} height={88} tile={44} radius={12} surface="bg" />
          <div className="kpf-hero-body">
            <div className="kpf-name-block">
              <span className="kpf-eyebrow"><Icon name="briefcase" size={12} sw={2} />Portfolio{across ? " · only you can see it" : ""}</span>
              {canWrite
                ? <DraftInput value={pf.name} required label={`Portfolio name: ${pf.name}`} onCommit={(v) => onUpdate(pf.id, { name: v })} className="kpj-field kpf-name-input" />
                : <h1 className="kpf-name">{pf.name}</h1>}
            </div>
            <div className="kpf-hero-acts">
              {canWrite && detailsOn && <Button variant="ghost" size="sm" icon="palette" onClick={() => setIdentity(true)}>Identity</Button>}
              {canWrite && <IconButton icon="trash" size="sm" tone="danger" label={`Delete portfolio ${pf.name}`}
                onClick={() => { if (window.confirm(`Delete portfolio “${pf.name}”? The projects themselves are kept. This can't be undone.`)) { onDelete(pf.id); onBack(); } }} />}
            </div>
          </div>
        </div>
        {/* how the programme is going, in the brief's voice */}
        <p className="kpf-sentence">{/[.!?]$/.test(sentence) ? sentence : `${sentence}.`}</p>
        {/* 0058: projects here you can't see are counted, never named */}
        {!across && accessOn(WORKSPACES.find((w) => w.id === pf.workspaceId)) && pf.projectIds.length > inPf.length && (
          <p className="kpf-sentence" style={{ fontSize: 13, color: "var(--ink-3)" }}>+{pf.projectIds.length - inPf.length} {pf.projectIds.length - inPf.length === 1 ? "project" : "projects"} you can't see</p>
        )}
        {rows.length > 0 && (
          <p className="kpf-sentence-sub">{pct}% of the work is done{lands ? `, and it's due to land ${lands}` : ""}.{rows.some((r) => r.status.mismatch) ? " Kanbo sees more trouble in the work on the projects it marks." : ""}</p>
        )}
        <div className="kpf-desc">
          {canWrite && detailsOn
            ? <DraftInput multiline value={pf.description ?? ""} label="What this portfolio is for" placeholder="What this portfolio is for, in a line or two"
                onCommit={(v) => onUpdate(pf.id, { description: v.trim() || null })} className="kpj-field" />
            : pf.description ? <p className="kpf-desc-text">{pf.description}</p> : null}
        </div>
        <div className="kpf-facts">
          <span className="kpf-fact">
            <span className="kpf-fact-label">Owner</span>
            {canWrite && detailsOn && !across ? (
              <select className="kpj-field" aria-label="Portfolio owner" value={owner ?? ""} onChange={(e) => onUpdate(pf.id, { ownerId: e.target.value || null })}>
                <option value="">No owner yet</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.id === me ? `${m.name} (you)` : m.name}</option>)}
              </select>
            ) : (
              <span className="kpf-fact-value">{owner && getMember(owner) ? <><Avatar id={owner} size={20} />{getMember(owner)!.name}</> : "No owner yet"}</span>
            )}
          </span>
          <span className="kpf-fact">
            <span className="kpf-fact-label">Target date</span>
            {detailsOn ? <DateChip value={pf.targetDate ?? undefined} label="Target date" size="md" tone="plain" placeholder="Add a date" readOnly={!canWrite}
              onChange={(d) => onUpdate(pf.id, { targetDate: d ?? null })} /> : <span className="kpf-fact-value">—</span>}
          </span>
          {!across && (
            <span className="kpf-fact">
              <span className="kpf-fact-label">Followers</span>
              {followers.length > 0 && <AvatarStack ids={followers} size={22} />}
              {detailsOn && canWrite ? (
                <>
                  <Button variant={following ? "ghost" : "secondary"} size="sm" icon={following ? "check" : "plus"}
                    onClick={() => onUpdate(pf.id, { followerIds: following ? followers.filter((x) => x !== me) : [...followers, me] })}>{following ? "Following" : "Follow"}</Button>
                  <IconButton ref={followRef} icon="users" size="sm" label="Choose followers" aria-haspopup="dialog" aria-expanded={followOpen} onClick={() => setFollowOpen((v) => !v)} />
                  <Popover open={followOpen} anchorRef={followRef} onClose={() => setFollowOpen(false)} role="dialog" label="Followers" minWidth={240} className="kpj-pop" style={{ ...POP_STYLE, padding: 10 }}>
                    <div className="kuc-sec-who" style={{ paddingLeft: 0 }} role="group" aria-label="Who follows this portfolio">
                      {members.map((m) => {
                        const on = followers.includes(m.id);
                        return <button key={m.id} type="button" className="kuc-chip" aria-pressed={on}
                          onClick={() => onUpdate(pf.id, { followerIds: on ? followers.filter((x) => x !== m.id) : [...followers, m.id] })}>{m.id === me ? "You" : firstName(m.name)}</button>;
                      })}
                      <span className="kuc-sec-who-note">Followers hear when a portfolio update is posted.</span>
                    </div>
                  </Popover>
                </>
              ) : followers.length === 0 ? <span className="kpf-fact-value">None yet</span> : null}
            </span>
          )}
          {!detailsOn && <span className="kpf-off">An owner, target date and followers aren't switched on yet.</span>}
        </div>

        <div className="kpf-tabs">
          <Segmented ariaLabel="Portfolio view" value={tab} onChange={(t) => { setPicking(false); onTab(t); }}
            options={[{ value: "table", label: `Table · ${rows.length}` }, { value: "updates", label: "Updates" }]} />
          <span className="kpf-tabs-end">
            {canWrite && <Button variant="ghost" size="sm" icon="plus" aria-expanded={picking} disabled={!available.length}
              title={available.length ? undefined : "Every project is already in this portfolio"} onClick={() => setPicking((v) => !v)}>Projects</Button>}
            <Button variant="ghost" size="sm" icon="arrowUpRight" onClick={csv} disabled={!rows.length}>Export CSV</Button>
            <Button variant="ghost" size="sm" icon="notes" onClick={print} disabled={!rows.length}>Print or PDF</Button>
            {onOpenInsights && <Button variant="ghost" size="sm" icon="chart" onClick={onOpenInsights} disabled={!rows.length}>Insights</Button>}
          </span>
        </div>
        {picking && (
          <AddProjectsPicker portfolioName={pf.name} available={available} workspaces={across?.workspaces}
            emptyNote={across ? "Every project you can see is already in this portfolio." : "Every project in this workspace is already in this portfolio."}
            onAdd={(ids) => { onUpdate(pf.id, { projectIds: [...pf.projectIds, ...ids.filter((id) => !pf.projectIds.includes(id))] }); setPicking(false); }}
            onCancel={() => setPicking(false)} />
        )}
        {tab === "table" ? (
          rows.length ? (
            <PortfolioTable rows={rows} tasks={tasks} idx={idx} statusUpdates={statusUpdates} label={`${pf.name} projects`} onOpenProject={onOpenProject}
              bizOf={bizOf} askFor={askFor} />
          ) : (
            <EmptyState art="briefcase" title="No projects in it yet" size="sm"
              body={canWrite ? "Add the projects that belong together with + Projects. You can pick several at once." : "Nobody has added a project to this portfolio yet."} />
          )
        ) : (
          <PortfolioUpdates pf={pf} rows={rows} tasks={tasks} statusUpdates={statusUpdates} me={me} canWrite={canWrite} lead={lead}
            owner={owner} aiPortfolio={aiPortfolio} onOpenProject={onOpenProject} />
        )}
      </div>
      {identity && (
        <EditIdentitySheet project={ident} open={identity} onClose={() => setIdentity(false)}
          onSave={({ emoji, color }) => onUpdate(pf.id, { emoji, color })} />
      )}
    </div>
  );
}

/* ============================================================
   KANBO — a business pack's preview: everything it sets up, each
   part tickable. Its key dates first (a countdown project counts
   back from the day you pick: opening day, finals day), a holding
   company's businesses, then the projects (each with its starter
   tasks and their dates, behind "Show tasks"), the goals and their
   key results for the quarter you pick, the portfolio, the docs, the
   request forms (and their QR posters) and the update day. A doc or
   a form comes with its project: untick the project and it goes too.
   The footer (PackPreviewFooter) says what it adds up to and sets it
   up. Rendered by the host in its sheet; the state is usePackFlow's.
   ============================================================ */
import { useId, type ReactNode } from "react";
import { Button, Icon, IconButton, ProjectTile } from "../primitives";
import { spectrumColor } from "../../lib/projectIdentity";
import { toLocalISO } from "../../data/data";
import {
  isPartOn, MAX_BUSINESSES, packCountsLine, packPart, packQuarterChoices, tasksBehind,
} from "../../lib/packPlan";
import { dueDayWords } from "../../lib/updateRhythm";
import { templateRepeatLabel } from "../../lib/templatePlan";
import type { PlannedTask, TemplateKeyResult } from "../../data/types";
import { packAsProject, updateDayWords } from "./PackGallery";
import { useTopOnMount, type PackFlow } from "./usePackFlow";
import type { PackUiContext } from "./packTypes";
import "./packs.css";

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "75%" · "£250,000" · "150 members" · "4% or less" · "Target to set" */
export function keyResultTarget(k: Pick<TemplateKeyResult, "target" | "unit" | "direction">): string {
  if (typeof k.target !== "number") return "Target to set";
  const n = k.target.toLocaleString("en-GB");
  const v = k.unit === "%" ? `${n}%` : k.unit === "£" ? `£${n}` : k.unit ? `${n} ${k.unit}` : n;
  return k.direction === "lower" ? `${v} or less` : v;
}

/** "Mon 9 Feb · weekly" · "Today" · "Fri 13 Feb · key date" */
function taskWhen(t: PlannedTask, today: string): string {
  const bits: string[] = [];
  if (t.dueDate) bits.push(cap(dueDayWords(t.dueDate, today)));
  if (t.recurrence !== "none") bits.push(templateRepeatLabel(t.recurrence).toLowerCase());
  if (t.milestone) bits.push("key date");
  return bits.join(" · ");
}

function Section({ title, count, aside, children, id }: { title: string; count?: number; aside?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section className="kbpk-sec" aria-labelledby={id}>
      <div className="kbpk-sechead">
        <h4 className="kbpk-sech" id={id}>{title}{count != null && <span className="kbpk-count">{count}</span>}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Row({ checked, disabled, onChange, lead, name, meta, children }: {
  checked: boolean; disabled?: boolean; onChange: (on: boolean) => void; lead: ReactNode; name: string; meta?: string; children?: ReactNode;
}) {
  return (
    <li className="kbpk-row" data-off={checked ? undefined : "true"}>
      <label className="kbpk-check" data-disabled={disabled || undefined}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {lead}
        <span className="kbpk-rtext">
          <span className="kbpk-rname">{name}</span>
          {meta && <span className="kbpk-rmeta"><span className="sr-only">, </span>{meta}</span>}
        </span>
      </label>
      {children}
    </li>
  );
}

export function PackPreview({ flow, context }: { flow: PackFlow; context: PackUiContext }) {
  const uid = useId();
  const top = useTopOnMount<HTMLDivElement>();
  const { pack, pick, plan } = flow;
  if (!pack || !pick || !plan) return null;
  const today = toLocalISO(context.today);
  const on = (part: string) => isPartOn(pick, part);
  const projOn = (key: string) => on(packPart.project(key));
  const planned = new Map(plan.projects.map((p) => [p.key, p]));
  const projectName = (key: string) => pack.projects.find((p) => p.key === key)?.name ?? key;
  const anchored = pack.projects.filter((p) => p.anchor);
  const docs = pack.projects.flatMap((p) => (p.docs ?? []).map((d, i) => ({ p, d, i })));
  const forms = pack.projects.filter((p) => p.form);
  const busy = !!flow.busy;
  const year = pick.quarter.slice(0, 4);

  return (
    <div ref={top} tabIndex={-1} className="kbpk-preview" aria-label={`What ${pack.name} sets up`} aria-busy={busy || undefined}>
      <header className="kbpk-phead">
        <ProjectTile project={packAsProject(pack)} size={44} />
        <div className="kbpk-phead-text">
          {pack.audience && <p className="kbpk-aud">{pack.audience}</p>}
          <p className="kbpk-psum">{pack.summary}</p>
        </div>
      </header>
      <fieldset className="kbpk-fs" disabled={busy}>
        <legend className="sr-only">What {pack.name} sets up</legend>

        {anchored.length > 0 && (
          <Section title={anchored.length === 1 ? "Key date" : "Key dates"} id={`${uid}-dates`}>
            <div className="kbpk-dates">
              {anchored.map((p) => {
                const day = pick.anchors[p.key] ?? "";
                const behind = day ? tasksBehind(p, day, context.today) : 0;
                const fid = `${uid}-anchor-${p.key}`;
                return (
                  <div key={p.key} className="kbpk-date" data-off={projOn(p.key) ? undefined : "true"}>
                    <label className="kbpk-dlabel" htmlFor={fid}>{p.anchor!.label}</label>
                    <input id={fid} className="kbpk-field" type="date" value={day} min={today} disabled={!projOn(p.key)}
                      aria-describedby={`${fid}-hint`}
                      onChange={(e) => { const v = e.target.value; flow.edit((pk) => ({ ...pk, anchors: { ...pk.anchors, [p.key]: v } })); }} />
                    <p className="kbpk-hint" id={`${fid}-hint`}>
                      {projOn(p.key) ? `${p.name} counts back from this day.` : `${p.name} is unticked.`}
                      {projOn(p.key) && behind > 0 && <span className="kbpk-warn"> {plural(behind, "task")} would already be behind, so {behind === 1 ? "it starts" : "they start"} out due today.</span>}
                    </p>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {pack.perBusiness && (
          <Section title="Businesses in the group" count={pick.businesses.filter((b) => b.trim()).length} id={`${uid}-biz`}>
            <p className="kbpk-hint">Each one gets a project for its numbers and reviews, and a portfolio of its own to add its projects to.</p>
            <ul className="kbpk-biz">
              {pick.businesses.map((b, i) => (
                <li key={i} className="kbpk-bizrow">
                  <ProjectTile project={{ id: `biz-${i}`, name: b || "?", emoji: "🏢", color: spectrumColor((["sky", "coral", "jade", "orchid", "amber", "lagoon", "rose", "citron"] as const)[i % 8]) }} size={20} />
                  <input className="kbpk-field" value={b} placeholder="Business name" aria-label={`Business ${i + 1}`} maxLength={60}
                    onChange={(e) => { const v = e.target.value; flow.edit((pk) => ({ ...pk, businesses: pk.businesses.map((x, j) => (j === i ? v : x)) })); }} />
                  <IconButton icon="x" size="sm" tone="danger" label={`Remove ${b.trim() || `business ${i + 1}`}`}
                    onClick={() => flow.edit((pk) => ({ ...pk, businesses: pk.businesses.filter((_, j) => j !== i) }))} />
                </li>
              ))}
            </ul>
            {pick.businesses.length < MAX_BUSINESSES && (
              <Button size="sm" variant="ghost" icon="plus" onClick={() => flow.edit((pk) => ({ ...pk, businesses: [...pk.businesses, ""] }))}>Add a business</Button>
            )}
          </Section>
        )}

        <Section title="Projects" count={plan.projects.length} id={`${uid}-projects`}>
          <ul className="kbpk-rows">
            {pack.projects.map((p) => {
              const pp = planned.get(p.key);
              const meta = [
                plural(p.tasks.length, "task"),
                p.anchor && `counts back from ${p.anchor.label.toLowerCase()}`,
                p.form && on(packPart.form(p.key)) && (p.form.poster ? "QR request form" : "request form"),
                p.rule && "a rule",
              ].filter(Boolean).join(" · ");
              return (
                <Row key={p.key} checked={projOn(p.key)} onChange={(v) => flow.toggle(packPart.project(p.key), v)}
                  lead={<ProjectTile project={{ id: `pack-${pack.id}-${p.key}`, name: p.name, emoji: p.emoji, color: spectrumColor(p.hue) }} size={20} />}
                  name={p.name} meta={meta}>
                  {pp && pp.tasks.length > 0 && (
                    <details className="kbpk-tasks">
                      <summary><Icon name="chevronRight" size={12} sw={2} />Show {plural(pp.tasks.length, "task")}</summary>
                      <ol className="kbpk-tlist">
                        {pp.tasks.map((t, i) => (
                          <li key={i} data-milestone={t.milestone || undefined}>
                            <span className="kbpk-tt">{t.title}</span>
                            <span className="kbpk-tw">{taskWhen(t, today)}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </Row>
              );
            })}
          </ul>
          {pack.perBusiness && (() => {
            const own = plan.projects.filter((p) => !pack.projects.some((x) => x.key === p.key));
            return own.length > 0 && <p className="kbpk-hint">And one for each business above, each in a portfolio of its own: {own.map((p) => p.name).join(", ")}.</p>;
          })()}
        </Section>

        {(pack.goals?.length ?? 0) > 0 && (
          <Section title="Goals" count={context.canSetGoals ? plan.goals.length : 0} id={`${uid}-goals`}
            aside={(
              <label className="kbpk-inline">
                <span>For</span>
                <select className="kbpk-field" data-size="sm" value={pick.quarter} disabled={!context.canSetGoals}
                  onChange={(e) => { const v = e.target.value; flow.edit((pk) => ({ ...pk, quarter: v })); }}>
                  {packQuarterChoices(context.today).map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
                </select>
              </label>
            )}>
            {!context.canSetGoals && <p className="kbpk-note">Owners and admins set the business's goals, so these are left out.</p>}
            {context.canSetGoals && !context.goalsV2 && <p className="kbpk-note">Goal owners and quarters aren't switched on yet, so each goal goes in with a due date at the end of its quarter, and its key results as sub-goals.</p>}
            <ul className="kbpk-rows">
              {pack.goals!.map((g) => {
                const checked = context.canSetGoals && on(packPart.goal(g.key));
                const meta = [
                  context.goalsV2 && "owned by you",
                  g.span === "year" && `for ${year}`,
                  g.project && (projOn(g.project) ? `progress follows ${projectName(g.project)}` : `${projectName(g.project)} is unticked`),
                ].filter(Boolean).join(" · ");
                return (
                  <Row key={g.key} checked={checked} disabled={!context.canSetGoals} onChange={(v) => flow.toggle(packPart.goal(g.key), v)}
                    lead={context.goalsV2 && g.icon
                      ? <span className="kbpk-glyph" aria-hidden="true">{g.icon}</span>
                      : <span className="kbpk-glyph" data-kind="goal"><Icon name="target" size={12} sw={2} /></span>}
                    name={g.name} meta={meta ? cap(meta) : undefined}>
                    {(g.keyResults?.length ?? 0) > 0 && (
                      <ul className="kbpk-krs" aria-label={`Key results for ${g.name}`}>
                        {g.keyResults!.map((k) => (
                          <li key={k.name} data-off={!context.goalsV2 && k.direction === "lower" ? "true" : undefined}>
                            <span className="kbpk-krn">{k.name}</span>
                            <span className="kbpk-krt" data-empty={typeof k.target !== "number" || undefined}>{keyResultTarget(k)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Row>
                );
              })}
            </ul>
          </Section>
        )}

        {(pack.portfolios?.length ?? 0) > 0 && (
          <Section title={pack.portfolios!.length === 1 ? "Portfolio" : "Portfolios"} id={`${uid}-pf`}>
            <ul className="kbpk-rows">
              {pack.portfolios!.map((pf) => {
                const keys = pf.projects.filter(projOn);
                return (
                  <Row key={pf.key} checked={keys.length > 0 && on(packPart.portfolio(pf.key))} disabled={!keys.length}
                    onChange={(v) => flow.toggle(packPart.portfolio(pf.key), v)}
                    lead={<ProjectTile project={{ id: `pack-${pack.id}-pf-${pf.key}`, name: pf.name, emoji: pf.emoji ?? "", color: spectrumColor(pf.hue ?? pack.hue) }} size={20} />}
                    name={pf.name}
                    meta={keys.length ? keys.map(projectName).join(", ") : "Its projects are all unticked"} />
                );
              })}
            </ul>
          </Section>
        )}

        {docs.length > 0 && (
          <Section title="Docs" count={plan.docs.length} id={`${uid}-docs`}>
            <ul className="kbpk-rows">
              {docs.map(({ p, d, i }) => {
                const part = packPart.doc(p.key, i);
                return (
                  <Row key={part} checked={projOn(p.key) && on(part)} disabled={!projOn(p.key)} onChange={(v) => flow.toggle(part, v)}
                    lead={<span className="kbpk-glyph" aria-hidden="true">{d.icon ?? "📄"}</span>}
                    name={d.title}
                    meta={projOn(p.key) ? `In ${p.name}${d.from === "meeting" ? " · meeting notes" : ""}` : `Comes with ${p.name}, which is unticked`} />
                );
              })}
            </ul>
          </Section>
        )}

        {forms.length > 0 && (
          <Section title={forms.length === 1 ? "Request form" : "Request forms"} id={`${uid}-forms`}>
            <ul className="kbpk-rows">
              {forms.map((p) => {
                const part = packPart.form(p.key);
                return (
                  <Row key={part} checked={projOn(p.key) && on(part)} disabled={!projOn(p.key)} onChange={(v) => flow.toggle(part, v)}
                    lead={<span className="kbpk-glyph" data-kind="form"><Icon name="inbox" size={12} sw={2} /></span>}
                    name={p.form!.name}
                    meta={projOn(p.key) ? `Requests land in ${p.name}${p.form!.poster ? " · with a QR poster to print" : ""}` : `Comes with ${p.name}, which is unticked`} />
                );
              })}
            </ul>
          </Section>
        )}

        {pack.updateRhythm && (
          <Section title="Update day" id={`${uid}-updates`}>
            <ul className="kbpk-rows">
              <Row checked={context.canSetUpdateDay && on(packPart.updates)} disabled={!context.canSetUpdateDay}
                onChange={(v) => flow.toggle(packPart.updates, v)}
                lead={<span className="kbpk-glyph" data-kind="updates"><Icon name="calendar" size={12} sw={2} /></span>}
                name={`Project ${updateDayWords(pack.updateRhythm).charAt(0).toLowerCase()}${updateDayWords(pack.updateRhythm).slice(1)}`}
                meta={context.canSetUpdateDay
                  ? `Each project's owner is reminded to post a short update${context.mode === "project" ? ". This changes the update day for the whole workspace." : "."}`
                  : context.updateDayNote ?? "The update day stays as it is."} />
            </ul>
          </Section>
        )}
      </fieldset>
      <p className="kbpk-foot-note">Starter tasks are assigned to you. Rename, move or delete anything afterwards.</p>
    </div>
  );
}

/** The preview's footer: what it adds up to, Back, and Set up. */
export function PackPreviewFooter({ flow, onBack }: { flow: PackFlow; onBack: () => void }) {
  if (!flow.pack) return null;
  const applying = flow.busy === "apply";
  return (
    <>
      <span className="kbpk-fline" data-warn={!flow.ready || undefined}>
        {flow.counts ? (flow.ready ? packCountsLine(flow.counts) : "Tick at least one part") : ""}
      </span>
      <Button variant="ghost" icon="arrowLeft" onClick={onBack} disabled={!!flow.busy}>Back</Button>
      <Button variant="primary" loading={applying} disabled={!flow.ready || (!!flow.busy && !applying)} onClick={() => { void flow.submit(); }}>
        {applying ? "Setting up…" : `Set up ${flow.pack.name}`}
      </Button>
    </>
  );
}

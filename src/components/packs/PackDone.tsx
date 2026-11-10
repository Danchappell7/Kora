/* ============================================================
   KANBO — after a business pack is set up: what it made (each line
   with Open, which goes there), anything not switched on yet or that
   couldn't be added, the QR posters to print, and Undo setup, which
   takes it all back (PackDoneFooter). Rendered by the host in its
   sheet; the state is usePackFlow's.
   ============================================================ */
import { useEffect, useId, useRef, useState } from "react";
import { Button, Icon } from "../primitives";
import type { Route } from "../../app-types";
import type { IconName } from "../../data/types";
import { NOT_YET_COPY, packOutcomeCounts, packOutcomeTitle, type PackPoster } from "../../lib/packApply";
import { updateDayWords } from "./PackGallery";
import { useTopOnMount, type PackFlow } from "./usePackFlow";
import type { PackHost, PackOutcome } from "./packTypes";
import "./packs.css";

const listOf = (names: string[], max = 4) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;

function Made({ icon, title, detail, route, onOpen }: { icon: IconName; title: string; detail?: string; route?: Route; onOpen?: (r: Route) => void }) {
  return (
    <li className="kbpk-made-row">
      <span className="kbpk-made-icon" aria-hidden="true"><Icon name={icon} size={14} sw={1.75} /></span>
      <span className="kbpk-made-text">
        <span className="kbpk-made-title">{title}</span>
        {detail && <span className="kbpk-made-detail">{detail}</span>}
      </span>
      {route && onOpen && <Button size="sm" variant="ghost" iconRight="arrowRight" aria-label={`Open ${title}`} onClick={() => onOpen(route)}>Open</Button>}
    </li>
  );
}

function PosterRow({ poster, print }: { poster: PackPoster; print: (p: PackPoster) => Promise<string | null> }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const go = () => {
    if (state === "busy") return;
    setProblem(null); setState("busy");
    // (the poster's window opens inside this click, before anything is awaited)
    void print(poster).then((err) => { if (!alive.current) return; setProblem(err); setState(err ? "idle" : "done"); });
  };
  return (
    <li className="kbpk-poster">
      <span className="kbpk-poster-mark" aria-hidden="true"><Icon name="grid" size={18} sw={1.75} /></span>
      <div className="kbpk-poster-text">
        <p className="kbpk-poster-head">“{poster.headline}”</p>
        <p className="kbpk-poster-meta">{poster.formName}{poster.projectName ? ` · ${poster.projectName}` : ""}</p>
        {problem && <p className="kbpk-err" role="alert"><Icon name="alert" size={12} sw={2} /><span>{problem}</span></p>}
      </div>
      <Button size="sm" variant="secondary" loading={state === "busy"} onClick={go}>{state === "done" ? "Print again" : "Print QR poster"}</Button>
    </li>
  );
}

export function PackDone({ flow, host, onOpen }: { flow: PackFlow; host: Pick<PackHost, "printPoster">; onOpen?: (r: Route) => void }) {
  const uid = useId();
  const top = useTopOnMount<HTMLDivElement>();
  const o: PackOutcome | null = flow.outcome;
  if (!o) return null;
  const a = o.applied;
  if (flow.undone) {
    const failed = flow.undone.failed;
    return (
      <div ref={top} className="kbpk-done" data-undone="">
        <div className="kbpk-dhead">
          <span className="kbpk-dmark" data-tone="neutral" aria-hidden="true"><Icon name="undo" size={18} sw={2} /></span>
          <div>
            <h3 className="kbpk-dtitle">Taken back</h3>
            <p className="kbpk-dsub">
              {failed.length
                ? `Most of what ${o.pack.name} set up has been removed, but ${listOf(failed.map((x) => `“${x}”`), 3)} couldn't be. You can delete ${failed.length === 1 ? "it" : "them"} by hand.`
                : `Everything ${o.pack.name} set up has been removed.${flow.undone.binned ? " Deleted projects wait in the recycle bin for 30 days." : ""}`}
            </p>
          </div>
        </div>
      </div>
    );
  }
  const c = packOutcomeCounts(a);
  const objectives = a.goals.filter((g) => !g.parentId);
  const firstDoc = a.docs[0];
  return (
    <div ref={top} className="kbpk-done">
      <div className="kbpk-dhead">
        <span className="kbpk-dmark" aria-hidden="true"><Icon name="check" size={18} sw={2.25} /></span>
        <div>
          <h3 className="kbpk-dtitle">{packOutcomeTitle(o.pack.name, a)}</h3>
          <p className="kbpk-dsub">Everything is assigned to you. Rename, move or delete anything afterwards.</p>
        </div>
      </div>
      <ul className="kbpk-made" aria-label={`What ${o.pack.name} set up`}>
        {c.projects && <Made icon="folder" title={c.projects} detail={listOf(a.projects.map((p) => p.name))} route={{ view: "projects" }} onOpen={onOpen} />}
        {c.goals && <Made icon="target" title={`${c.goals}${o.plan.goalPeriod ? ` for ${o.plan.goalPeriod}` : ""}`} detail={listOf(objectives.map((g) => g.name))} route={{ view: "goals", ...(o.plan.goalQuarter ? { tab: o.plan.goalQuarter } : {}) }} onOpen={onOpen} />}
        {c.portfolios && <Made icon="layers" title={c.portfolios} detail={listOf(a.portfolios.map((p) => p.name))}
          route={a.portfolios.length === 1 ? { view: "portfolios", portfolioId: a.portfolios[0].id } : { view: "portfolios" }} onOpen={onOpen} />}
        {c.docs && <Made icon="notes" title={c.docs} detail={listOf(a.docs.map((d) => d.title))}
          route={firstDoc ? { view: "project", projectId: firstDoc.projectId, tab: "docs" } : undefined} onOpen={onOpen} />}
        {c.forms && <Made icon="inbox" title={c.forms} detail={listOf(a.forms.map((f) => f.name))}
          route={a.forms[0] ? { view: "project", projectId: a.forms[0].projectId, tab: "requests" } : undefined} onOpen={onOpen} />}
        {a.rhythm && <Made icon="calendar" title={updateDayWords(a.rhythm.after)} detail="Each project's owner is reminded on the day, and missing updates show up for you." />}
      </ul>
      {a.notYet.map((f) => <p key={f} className="kbpk-note">{NOT_YET_COPY[f]}</p>)}
      {a.failed.length > 0 && (
        <p className="kbpk-note" data-tone="warn">
          <Icon name="alert" size={12} sw={2} />
          <span>{listOf(a.failed.map((x) => `“${x}”`), 3)} couldn't be added. You can add {a.failed.length === 1 ? "it" : "them"} by hand.</span>
        </p>
      )}
      {a.posters.length > 0 && (
        <section className="kbpk-posters" aria-labelledby={`${uid}-posters`}>
          <h4 className="kbpk-sech" id={`${uid}-posters`}>Print the QR {a.posters.length === 1 ? "poster" : "posters"}</h4>
          <p className="kbpk-hint">Printing switches on the form's public link, so anyone who scans the poster can send a request without an account. You can switch it off in the project's Requests.</p>
          <ul className="kbpk-rows">
            {a.posters.map((p) => <PosterRow key={p.formId} poster={p} print={(x) => host.printPoster(x, o)} />)}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The summary's footer: Undo setup (until it's been taken back) and Done. */
export function PackDoneFooter({ flow, onDone, canUndo = true }: { flow: PackFlow; onDone: () => void; canUndo?: boolean }) {
  const undoing = flow.busy === "undo";
  return (
    <>
      {canUndo && !flow.undone && (
        <Button variant="ghost" icon="undo" loading={undoing} onClick={() => { void flow.takeBack(); }} style={{ marginRight: "auto" }}>
          {undoing ? "Taking it back…" : "Undo setup"}
        </Button>
      )}
      <Button variant="primary" onClick={onDone} disabled={undoing}>Done</Button>
    </>
  );
}

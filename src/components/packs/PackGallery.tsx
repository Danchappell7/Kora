/* ============================================================
   KANBO — the business packs' cards, above the team templates in
   New workspace and New project › From a pack or template. Each
   card: the pack's cover and tile, who it's for, a sentence on what
   it does, what's inside (projects, goals, docs, a QR form, the
   update day) and Preview, which opens everything it sets up.
   ============================================================ */
import { useId } from "react";
import { Button, Icon, ProjectCover } from "../primitives";
import { spectrumColor } from "../../lib/projectIdentity";
import { BUSINESS_PACKS } from "../../packs";
import { packStats } from "../../lib/packPlan";
import { rhythmLabel } from "../../lib/updateRhythm";
import type { IconName, UpdateRhythm, WorkspaceTemplate } from "../../data/types";
import "./packs.css";

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** The pack, as a project-shaped thing its cover and tile can wear. */
export const packAsProject = (p: Pick<WorkspaceTemplate, "id" | "name" | "emoji" | "hue">) => ({ id: "pack-" + p.id, name: p.name, emoji: p.emoji, color: spectrumColor(p.hue) });

/** "Updates every Monday" · "Updates on the last Friday of the month" */
export function updateDayWords(r: UpdateRhythm): string {
  const label = rhythmLabel(r);
  const lower = label.charAt(0).toLowerCase() + label.slice(1);
  return r.cadence === "monthly" ? `Updates on ${lower}` : `Updates ${lower}`;
}

/** What's inside, as short chips. */
export function packInside(p: WorkspaceTemplate): { icon: IconName; text: string }[] {
  const s = packStats(p);
  const out: { icon: IconName; text: string }[] = [];
  out.push({ icon: "folder", text: s.perBusiness ? `${plural(s.projects, "project")}, and one for each business` : plural(s.projects, "project") });
  if (s.goals) out.push({ icon: "target", text: plural(s.goals, "goal") });
  if (s.portfolios || s.perBusiness) out.push({ icon: "layers", text: s.perBusiness ? "A portfolio for each business" : plural(s.portfolios, "portfolio") });
  if (s.docs) out.push({ icon: "notes", text: plural(s.docs, "doc") });
  if (s.posters) out.push({ icon: "inbox", text: s.posters === 1 ? "QR request form" : `${s.posters} QR request forms` });
  else if (s.forms) out.push({ icon: "inbox", text: plural(s.forms, "request form") });
  if (p.updateRhythm) out.push({ icon: "calendar", text: updateDayWords(p.updateRhythm) });
  return out;
}

export function PackGallery({ onPreview, busy = false, packs = BUSINESS_PACKS }: {
  onPreview: (pack: WorkspaceTemplate) => void;
  busy?: boolean;
  packs?: readonly WorkspaceTemplate[];
}) {
  const uid = useId();
  return (
    <section className="kbpk-gallery" aria-labelledby={`${uid}-h`}>
      <div className="kbpk-ghead">
        <h3 className="kbpk-gtitle" id={`${uid}-h`}>Business packs</h3>
        <p className="kbpk-gsub">A working setup for your kind of business: projects, goals, docs, request forms and an update day, in one step.</p>
      </div>
      <ul className="kbpk-grid" aria-label="Business packs">
        {packs.map((p) => {
          const nameId = `${uid}-${p.id}-n`;
          return (
            <li key={p.id} className="kbpk-card">
              <ProjectCover project={packAsProject(p)} size="card" height={52} tile={44} surface="surface" />
              <div className="kbpk-cbody">
                <h4 className="kbpk-cname" id={nameId}>{p.name}</h4>
                {p.audience && <p className="kbpk-aud">{p.audience}</p>}
                <p className="kbpk-csum">{p.summary}</p>
                <ul className="kbpk-inside" aria-label={`What's in ${p.name}`}>
                  {packInside(p).map((x) => (
                    <li key={x.text}><Icon name={x.icon} size={12} sw={1.75} /><span>{x.text}</span></li>
                  ))}
                </ul>
                <div className="kbpk-cfoot">
                  <Button size="sm" variant="secondary" iconRight="arrowRight" disabled={busy} aria-describedby={nameId} onClick={() => onPreview(p)}>
                    Preview
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The heading over the team templates, when packs come first. */
export function TeamTemplatesHeading() {
  return (
    <div className="kbpk-ghead" data-second="">
      <h3 className="kbpk-gtitle">Team templates</h3>
      <p className="kbpk-gsub">Just the projects, for one part of the business.</p>
    </div>
  );
}

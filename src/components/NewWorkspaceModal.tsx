/* ============================================================
   KANBO — create-workspace dialog (the kit's Sheet: scrim with no
   blur, 56px header, 64px footer; a bottom sheet on phones).
   Two steps: the name, then how to start — a business pack (its
   preview, then what it set up, with Undo: components/packs), a team
   template (TeamTemplatePicker: its projects, sections, starter
   tasks, a request form and a rule) or empty. The sheet stays open,
   showing progress, until the host has finished.
   ============================================================ */
import { useState, useEffect, useRef, useId } from "react";
import { Button, Sheet } from "./primitives";
import { TeamTemplatePicker } from "./TeamTemplatePicker";
import { PackGallery, TeamTemplatesHeading } from "./packs/PackGallery";
import { PackPreview, PackPreviewFooter } from "./packs/PackPreview";
import { PackDone, PackDoneFooter } from "./packs/PackDone";
import { usePackFlow } from "./packs/usePackFlow";
import type { PackHost, PackOutcome } from "./packs/packTypes";
import type { PackPick } from "../lib/packPlan";
import type { WorkspaceTemplate } from "../data/types";

const FIELD_CSS = `
.knws-field {
  width: 100%; height: var(--h-lg, 40px); padding: 0 12px; border-radius: var(--r-md, 8px);
  border: 1px solid var(--field-border); background: var(--field-bg); color: var(--ink);
  font: 500 14px/20px var(--font-ui, var(--font-display));
  transition: border-color var(--d-1, 90ms) var(--ease);
}
.knws-field::placeholder { color: var(--ink-4); }
.knws-field:hover { border-color: var(--field-border-hover); }
.knws-step:focus { outline: none; }
`;

/** How the new workspace starts: a team template (all its projects, or just `projectKeys`), or a business pack as picked. */
export type WorkspaceStart = { template: WorkspaceTemplate; projectKeys?: string[] } | { pack: WorkspaceTemplate; pick: PackPick };

export function NewWorkspaceModal({ open, onClose, onCreate, busy: hostBusy = false, packs }: {
  open: boolean;
  onClose: () => void;
  /** creates it (and sets it up from `start`); the sheet closes once this resolves, unless it
   *  resolves with a pack's outcome: then it shows what the pack set up */
  onCreate: (name: string, start?: WorkspaceStart) => void | PackOutcome | null | Promise<void | PackOutcome | null>;
  /** the host is still working (also shown while onCreate's promise is pending) */
  busy?: boolean;
  /** business packs (omit to offer team templates only) */
  packs?: PackHost;
}) {
  const [name, setName] = useState("");
  const [step, setStep] = useState<"name" | "template">("name");
  const [working, setWorking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const id = useId();
  const busy = hostBusy || working;
  const flow = usePackFlow({
    context: packs?.context ?? null,
    apply: async (pack, pick) => {
      const v = name.trim();
      if (!v) return null;
      const r = await onCreate(v, { pack, pick });
      // no outcome: it couldn't be set up (the host said why), so the sheet closes as for a template
      if (!r) { if (alive.current) onClose(); return null; }
      return r;
    },
    undo: packs?.undo,
  });

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // every opening starts afresh on the name (reset while rendering, so the last step never flashes)
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) { setWasOpen(open); if (open) { setName(""); setStep("name"); setWorking(false); flow.reset(); } }
  // each step starts with focus in it: the name field, or the template gallery
  const goTo = (to: "name" | "template") => {
    setStep(to);
    window.setTimeout(() => (to === "name" ? inputRef.current : stepRef.current)?.focus({ preventScroll: true }), 30);
  };

  const v = name.trim();
  const next = () => { if (v) goTo("template"); };
  const create = async (start?: WorkspaceStart) => {
    if (!v || busy) return;
    setWorking(true);
    try { await onCreate(v, start); }
    finally { if (alive.current) setWorking(false); }
    onClose();
  };

  if (step === "template" && packs && flow.outcome) {
    const openRoute = packs.open;
    return (
      <Sheet open={open} onClose={onClose} label={`${v} is set up`} title={`Set up ${v}`} width={720}
        footer={<PackDoneFooter flow={flow} onDone={onClose} />}>
        <div className="knws-step">
          <PackDone flow={flow} host={packs} onOpen={openRoute ? (r) => { onClose(); openRoute(r); } : undefined} />
        </div>
      </Sheet>
    );
  }
  if (step === "template" && packs && flow.pack) {
    return (
      <Sheet open={open} onClose={() => { if (!flow.busy) onClose(); }} label={`${flow.pack.name} for ${v}`} title={flow.pack.name} width={720}
        footer={<PackPreviewFooter flow={flow} onBack={() => { flow.back(); window.setTimeout(() => stepRef.current?.focus({ preventScroll: true }), 30); }} />}>
        <div className="knws-step">
          <PackPreview flow={flow} context={packs.context} />
        </div>
      </Sheet>
    );
  }
  if (step === "template") {
    return (
      <Sheet open={open} onClose={onClose} label={`Set up ${v}`} title={`Set up ${v}`} width={720}
        footer={<Button variant="ghost" icon="arrowLeft" onClick={() => goTo("name")} disabled={busy}>Back</Button>}>
        <div ref={stepRef} tabIndex={-1} className="knws-step" aria-label={`How ${v} starts`}>
          <style>{FIELD_CSS}</style>
          {packs && (
            <>
              <PackGallery busy={busy} onPreview={(p) => flow.start(p)} />
              <TeamTemplatesHeading />
            </>
          )}
          <TeamTemplatePicker mode="workspace" busy={busy}
            onPick={(template, projectKeys) => { void create({ template, projectKeys }); }}
            onStartEmpty={() => { void create(); }} />
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} label="New workspace" title="New workspace" initialFocus={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" iconRight="arrowRight" onClick={next} disabled={!v}>Next</Button>
        </>
      }>
      <style>{FIELD_CSS}</style>
      <label htmlFor={`${id}-name`} style={{ display: "block", marginBottom: 8, font: "600 13px/20px var(--font-ui, var(--font-display))", color: "var(--ink)" }}>
        Workspace name
      </label>
      <input ref={inputRef} id={`${id}-name`} className="knws-field" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); next(); } }}
        placeholder="e.g. Acme Inc" autoComplete="off" aria-describedby={`${id}-help`} />
      <p id={`${id}-help`} style={{ margin: "12px 0 0", font: "400 13px/20px var(--font-ui, var(--font-display))", color: "var(--ink-3)" }}>
        A shared space for a team. Next, start it from a business pack, a team template or empty. Invite people from Team › People, and everyone in it sees its projects and tasks.
      </p>
    </Sheet>
  );
}

/* ============================================================
   KANBO — "Ask for an update" on a project row (0053, lib/updateAsks).
   For a workspace's owners and admins, on projects someone else owns.
   One tap asks; then it reads "Asked" (with who and when) until the
   project can be asked about again. A refusal says why in a toast.
   useAskAction is the same for a menu item (the directory's ⋯ on touch).
   ============================================================ */
import { useState } from "react";
import { Button, Icon } from "../primitives";
import { getMember } from "../../data/data";
import type { Project, UpdateAsk } from "../../data/types";
import { AskError, type AskForUpdate } from "../../lib/updateAsks";
import { useToast } from "../Toast";
import "./updates.css";

// works outside the providers in isolated renders; in the app it's always there
function useOptionalToast() { try { return useToast(); } catch { return null; } }

const firstName = (id?: string | null) => (id ? getMember(id)?.name?.split(/\s+/)[0] : undefined) || "the owner";

export interface AskAction {
  /** may you ask about it? */
  can: boolean;
  /** the ask in the last 20 hours, if any */
  asked?: UpdateAsk;
  busy: boolean;
  /** "Ask Theo for an update on Clubhouse Fit-out" */
  label: string;
  ask: () => Promise<void>;
}

/** Asking about one project: whether you may, whether it's been asked, and the ask (it says how it went in a toast). */
export function useAskAction(project: Project | undefined, asks?: AskForUpdate): AskAction {
  const toast = useOptionalToast();
  const [busy, setBusy] = useState(false);
  const can = !!project && !!asks && asks.canAsk(project);
  const asked = can ? asks!.asked(project!) : undefined;
  const label = project ? `Ask ${firstName(project.ownerId)} for an update on ${project.name}` : "Ask for an update";
  const ask = async () => {
    if (!project || !asks || busy || asked) return;
    setBusy(true);
    try {
      await asks.ask(project);
      toast?.toast(`Asked ${firstName(project.ownerId)} for an update on ${project.name}`);
    } catch (err) {
      toast?.toast(err instanceof AskError ? err.message : "Couldn't ask just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };
  return { can, asked, busy, label, ask };
}

export function AskForUpdateButton({ project, asks, compact }: { project: Project; asks?: AskForUpdate; compact?: boolean }) {
  const a = useAskAction(project, asks);
  if (!a.can) return null;
  if (a.asked) {
    const who = getMember(a.asked.askedBy)?.name?.split(/\s+/)[0];
    return (
      <span className="kup-asked" title={`${who ? `${who} asked` : "Asked"} ${firstName(project.ownerId)} for an update`}>
        <Icon name="check" size={14} sw={2} />Asked
      </span>
    );
  }
  return (
    <Button variant="ghost" size="sm" icon="bell" loading={a.busy} onClick={(e) => { e.stopPropagation(); void a.ask(); }} aria-label={a.label}>
      {compact ? "Ask" : "Ask for an update"}
    </Button>
  );
}

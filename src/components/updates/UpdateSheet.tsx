/* ============================================================
   KANBO — a project's update in a sheet, from Today (0053): Kanbo's
   draft written as it opens (its AI when it's on, the on-device draft
   otherwise; words already in the project's draft are kept), ready to
   check and post. The same composer, and the same shared draft, as the
   project's own Updates tab. Loaded the first time one opens.
   ============================================================ */
import { useEffect, useRef } from "react";
import { Sheet } from "../primitives";
import type { Project, StatusUpdate, Task } from "../../data/types";
import { ComposerPanel, useStatusComposer, type AiStatus, type PostStatus } from "../project/StatusComposer";
import "./updates.css";

/** The update in a sheet: Kanbo's draft (AI when it's on, else on-device) ready to check and post. */
export function UpdateSheet({ project, tasks, statusUpdates, onPost, aiStatus, open, onClose, people }: {
  project: Project; tasks: Task[]; statusUpdates: StatusUpdate[]; onPost: PostStatus; aiStatus?: AiStatus; open: boolean; onClose: () => void;
  /** who an Ask can be for: the project's workspace's people, never you */
  people?: { id: string; name: string }[];
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const c = useStatusComposer({ project, tasks, statusUpdates, onPost, aiStatus, onPosted: onClose });
  // the draft is written as it opens (unless there are words worth keeping: yours, or Kanbo's from before);
  // the brief already said Kanbo drafted it, so one written on this device says so calmly
  useEffect(() => {
    if (open) c.ensureDraft({ auto: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.id]);
  return (
    <Sheet open={open} onClose={onClose} label={`Post an update on ${project.name}`} title={`Update on ${project.name}`} width={560} initialFocus={textRef}>
      <div className="kup-sheet">
        <ComposerPanel c={c} onCancel={onClose} textRef={textRef} people={people} />
      </div>
    </Sheet>
  );
}

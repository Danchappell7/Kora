/* ============================================================
   KANBO — your project updates on Today (0053). On a project's update
   day (and the two working days after), or when a lead's asked for it,
   its OWNER gets one line under the brief ("Your update on Q3 Product
   Launch is due today. Kanbo has drafted it from this week's 7
   changes.") and one "Kanbo noticed" nudge. Either opens the update in
   a sheet with Kanbo's draft already written (its AI when it's on, the
   on-device draft otherwise): check it, change what you like, post.
   Nothing posts on its own. useTodayUpdates gives Today the line, the
   nudge and the sheet; lib/updateDue decides what's due.
   ============================================================ */
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { Button, ProjectTile } from "../primitives";
import { getMember, KANBO_TODAY, todayISO, WORKSPACES } from "../../data/data";
import type { Project, StatusUpdate, Task } from "../../data/types";
import { dueUpdatesFor, dueVerb, draftedFrom, updateNoticed, type DueUpdate } from "../../lib/updateDue";
import { useUpdateAsks } from "../../lib/updateAsks";
import type { Noticed } from "../../lib/noticed";
import type { AiStatus, PostStatus } from "../project/StatusComposer";
import "./updates.css";

// the composer arrives with the first sheet opened (Today's own code stays small)
const UpdateSheet = lazy(() => import("./UpdateSheet").then((m) => ({ default: m.UpdateSheet })));

export interface TodayUpdates {
  /** your updates due or asked for today */
  items: DueUpdate[];
  /** the line under the brief (null: nothing due) */
  line: ReactNode;
  /** the one "Kanbo noticed" nudge */
  noticed: Noticed[];
  /** open a project's update, Kanbo's draft ready */
  open: (projectId: string) => void;
  /** the update sheet (render it once) */
  sheet: ReactNode;
}

const firstName = (id?: string) => (id ? getMember(id)?.name?.trim().split(/\s+/)[0] : undefined) || "A lead";

/** Today's update line, nudge and sheet for the signed-in person. Off (nothing) for a guest or without `onPost`. */
export function useTodayUpdates({ me, projects, tasks, statusUpdates, onPost, aiStatus, readOnly }: {
  me: string;
  projects: Project[];
  tasks: Task[];
  statusUpdates: StatusUpdate[];
  onPost?: PostStatus;
  aiStatus?: AiStatus;
  readOnly?: boolean;
}): TodayUpdates {
  const asks = useUpdateAsks();
  const today = todayISO();
  const workspaces = WORKSPACES;
  const items = useMemo(() => (readOnly || !onPost ? [] : dueUpdatesFor({ me, projects, tasks, statusUpdates, asks, today: KANBO_TODAY, workspaces })),
    // (`today` re-reads it when the day rolls over; WORKSPACES changes when an update day does)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readOnly, !onPost, me, projects, tasks, statusUpdates, asks, today, workspaces]);
  const [openId, setOpenId] = useState<string | null>(null);
  // the sheet keeps its project while it fades out
  const [shownId, setShownId] = useState<string | null>(null);
  const open = (projectId: string) => { setShownId(projectId); setOpenId(projectId); };
  const shown = shownId ? projects.find((p) => p.id === shownId) : undefined;
  const noticed = useMemo(() => updateNoticed(items, KANBO_TODAY), [items]);
  return {
    items,
    line: items.length ? <UpdateLine items={items} onOpen={open} /> : null,
    noticed,
    open,
    sheet: shown && onPost ? (
      <Suspense fallback={null}>
        <UpdateSheet key={shown.id} project={shown} tasks={tasks} statusUpdates={statusUpdates} onPost={onPost} aiStatus={aiStatus}
          open={openId === shown.id} onClose={() => setOpenId(null)} />
      </Suspense>
    ) : null,
  };
}

/** "Your update on [Q3 Product Launch] is due today. Kanbo has drafted it from this week's 7 changes. [Review and post]" */
export function UpdateLine({ items, onOpen }: { items: DueUpdate[]; onOpen: (projectId: string) => void }) {
  const chip = (d: DueUpdate) => (
    <button key={d.project.id} type="button" className="kup-line-proj" onClick={() => onOpen(d.project.id)} title={`Open the update on ${d.project.name}`}>
      <ProjectTile project={d.project} size={16} /><span>{d.project.name}</span>
    </button>
  );
  const first = items[0];
  const asked = items.filter((d) => d.reason === "asked");
  let sentence: ReactNode;
  if (items.length === 1 && first.reason === "asked") {
    sentence = <>{firstName(first.ask?.askedBy)} asked for an update on {chip(first)}.</>;
  } else if (items.length === 1) {
    sentence = <>Your update on {chip(first)} {dueVerb(first, KANBO_TODAY)}.</>;
  } else {
    const chips = items.map(chip);
    const list = chips.flatMap((c, i) => (i === 0 ? [c] : [i === chips.length - 1 ? " and " : ", ", c]));
    sentence = <>Your updates on {list} are waiting.{asked.length === 1 ? ` ${firstName(asked[0].ask?.askedBy)} asked for the one on ${asked[0].project.name}.` : ""}</>;
  }
  return (
    <div className="kup-line" role="note" aria-label="Your project updates">
      <p className="kup-line-text">{sentence} {draftedFrom(items)}</p>
      <Button variant="secondary" size="sm" icon="notes" onClick={() => onOpen(first.project.id)}>
        {items.length > 1 ? `Start with ${first.project.name}` : "Review and post"}
      </Button>
    </div>
  );
}

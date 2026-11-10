/* ============================================================
   KANBO — the one place meetings open (0056). App mounts it once;
   "Run meeting" (meetingBus) asks it for the start sheet, and "Join",
   the Inbox's recap and a recap's "Last meeting" ask it to open one:
   the live room while it runs, its recap once it's ended. It holds
   what both need from App (the tasks, people, projects, goals and
   updates you can see, and the ways to make tasks and open docs).
   ============================================================ */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { Goal, Project, StatusUpdate, Task, Workspace, WorkspaceEvent, WorkspaceMember } from "../../data/types";
import type { NewProject } from "../../data/store";
import type { AiOutcome, ExtractedTask } from "../../lib/askTypes";
import type { Meeting } from "../../lib/meetings/types";
import { clearMeetingRequest, refreshLiveMeetings, useMeetingRequest } from "./meetingBus";
import { StartMeetingSheet } from "./StartMeetingSheet";

const MeetingRoom = lazy(() => import("./MeetingRoom").then((m) => ({ default: m.MeetingRoom })));

export interface MeetingData {
  me: string;
  workspaces: Workspace[];
  members: WorkspaceMember[];
  /** every live task you can see, in every workspace */
  tasks: Task[];
  /** the same, archived projects' tasks included (a goal linked to one keeps its %) */
  goalTasks?: Task[];
  projects: Project[];
  goals: Goal[];
  statusUpdates: StatusUpdate[];
}

export interface MeetingsHostProps extends MeetingData {
  /** a business's change history since a moment (Pulse's "done since" and Radar's slips) */
  loadEvents: (workspaceId: string, sinceISO: string) => Promise<WorkspaceEvent[]>;
  /** make the reviewed tasks (Extract tasks): their ids in order, or nothing when they weren't made */
  createTasks?: (rows: Array<Partial<Task> & { title: string }>) => string[] | void;
  /** take back a task the room just made (Make task's Undo) */
  deleteTask?: (id: string) => void;
  /** make a project (the "Meetings" project for a team meeting's notes) */
  onCreateProject?: (input: NewProject) => void;
  aiExtract?: (text: string, context?: string) => Promise<AiOutcome<ExtractedTask[]>>;
  onOpenTask: (id: string) => void;
  /** open a doc in its project (the room closes; the meeting carries on) */
  onOpenDoc: (projectId: string, docId: string) => void;
}

export function MeetingsHost(props: MeetingsHostProps) {
  const req = useMeetingRequest();
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (req?.kind === "open") { setOpen(req.id); clearMeetingRequest(); }
  }, [req]);
  const scope = req?.kind === "start" ? req.scope : null;
  const started = useCallback((m: Meeting) => { clearMeetingRequest(); setOpen(m.id); refreshLiveMeetings(); }, []);
  const close = useCallback(() => { setOpen(null); refreshLiveMeetings(); }, []);
  const data: MeetingData = useMemo(() => ({
    me: props.me, workspaces: props.workspaces, members: props.members, tasks: props.tasks, goalTasks: props.goalTasks,
    projects: props.projects, goals: props.goals, statusUpdates: props.statusUpdates,
  }), [props.me, props.workspaces, props.members, props.tasks, props.goalTasks, props.projects, props.goals, props.statusUpdates]);
  return (
    <>
      {scope && (
        <StartMeetingSheet key={`${scope.workspaceId}:${(scope.workspaceIds ?? []).join(",")}:${scope.preset}`} scope={scope} data={data}
          loadEvents={props.loadEvents} onCreateProject={props.onCreateProject} onClose={clearMeetingRequest} onStarted={started} />
      )}
      {open && (
        <Suspense fallback={null}>
          <MeetingRoom key={open} meetingId={open} data={data} onClose={close}
            createTasks={props.createTasks} deleteTask={props.deleteTask} aiExtract={props.aiExtract} onOpenTask={props.onOpenTask}
            onOpenDoc={(projectId, docId) => { close(); props.onOpenDoc(projectId, docId); }}
            onOpenMeeting={(id) => setOpen(id)} />
        </Suspense>
      )}
    </>
  );
}

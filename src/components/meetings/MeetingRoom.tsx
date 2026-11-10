/* ============================================================
   KANBO — the meeting room (0056): a calm, full-screen presenter view
   that works on a laptop shared on a screen and reads on a phone.
   · The agenda down the side, the item on the stage (large type), its
     notes beside it; Previous / Next below (← → or J / K, Home / End).
   · One person presents: their place is everyone's (realtime on the
     meeting row; the demo's teammates join and present too). Watching,
     you follow them; step away and "Back to Maya's place" brings you
     back (F). Anyone in the room can Present to take over; the
     presenter can hand over to someone who's there.
   · A timer: the meeting's time against its preset's time box, and how
     long the room has been on this item.
   · Notes, decisions and actions go in beside each item (N to write);
     any line becomes a task with an owner through Extract tasks.
   · The wrap-up saves the notes doc (the Meeting notes template, in the
     project chosen at the start) and ends it: the recap goes to
     everyone asked or there. An ended meeting opens as its recap.
   Leaving (Esc, ×) never ends it. A task opens in the task panel,
   which sits over the room.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AvatarStack, Button, Icon, IconButton, Sheet } from "../primitives";
import { Popover } from "../primitives/Popover";
import { useToast } from "../Toast";
import { ExtractTasksSheet } from "../ExtractTasksSheet";
import { BUSINESS_CSS, WorkspaceMark } from "../businesses/Businesses";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { isEditableTarget } from "../../hooks/useFocusTrap";
import { getMember, toLocalISO } from "../../data/data";
import type { Task } from "../../data/types";
import type { AiOutcome, ExtractedTask } from "../../lib/askTypes";
import { getProjectDoc, saveProjectDoc } from "../../lib/docs";
import { PRESETS, mayRun, meetingDay, meetingPeople, sectionOf, SECTION_LABEL } from "../../lib/meetings/agenda";
import { extractText, linkCreated, makeTaskText, meetingDoc } from "../../lib/meetings/notes";
import {
  addItem, deleteItem, endMeeting, getMeeting, handMeeting, isDemoMeetings, joinMeeting, listAttendees, listItems, meetingsMode, moveMeeting, presentMeeting,
  setMeetingDoc, subscribeMeeting, updateItem, type ItemInput,
} from "../../lib/meetings/sync";
import type { AgendaItem, Meeting, MeetingAttendee, MeetingItem } from "../../lib/meetings/types";
import type { MeetingData } from "./MeetingsHost";
import { refreshLiveMeetings } from "./meetingBus";
import { PersonMark, RoomStage, type StageContext } from "./RoomStage";
import { RoomNotes } from "./RoomNotes";
import { RoomRecap, RoomWrap, type WrapContext } from "./RoomWrap";
import "./meetings.css";

function useOptionalToast() { try { return useToast(); } catch { return null; } }
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16)));
/** The presenter's moves go out once the keys settle (one write for a run of presses). */
const MOVE_SETTLE_MS = 140;
/** A task Extract made may still be on its way to the database: linking it waits and tries again. */
const LINK_TRIES = [0, 700, 1500, 3000, 5000];

export interface MeetingRoomProps {
  meetingId: string;
  data: MeetingData;
  onClose: () => void;
  createTasks?: (rows: Array<Partial<Task> & { title: string }>) => string[] | void;
  aiExtract?: (text: string, context?: string) => Promise<AiOutcome<ExtractedTask[]>>;
  onOpenTask: (id: string) => void;
  onOpenDoc: (projectId: string, docId: string) => void;
  onOpenMeeting?: (id: string) => void;
}

export function MeetingRoom({ meetingId, data, onClose, createTasks, aiExtract, onOpenTask, onOpenDoc, onOpenMeeting }: MeetingRoomProps) {
  const { me, members, workspaces, projects } = data;
  const toast = useOptionalToast();
  const phone = useMediaQuery("(max-width: 759px)");
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined);
  const [items, setItems] = useState<MeetingItem[]>([]);
  const [attendees, setAttendees] = useState<MeetingAttendee[]>([]);

  /* ---- load, join, and follow live changes ---- */
  const pendingMove = useRef<{ timer: number; place: number } | null>(null);
  const inFlight = useRef(0);
  useEffect(() => {
    let alive = true;
    Promise.all([getMeeting(meetingId).catch(() => null), listItems(meetingId).catch(() => []), listAttendees(meetingId).catch(() => [])])
      .then(([m, its, ats]) => {
        if (!alive) return;
        setMeeting(m);
        setItems(its);
        setAttendees(ats);
        if (m?.status === "live") void joinMeeting(m.id, me);
      });
    const off = subscribeMeeting(meetingId, (c) => {
      if (c.meeting) {
        const next = c.meeting;
        setMeeting((cur) => {
          if (!cur) return next;
          // your own moves are on their way: keep your place until they land
          const mine = next.presenterId === me && (pendingMove.current || inFlight.current > 0);
          return mine ? { ...next, place: cur.place, placeKey: cur.placeKey, movedAt: cur.movedAt } : next;
        });
      }
      if (c.items) setItems(c.items);
      if (c.attendees) setAttendees(c.attendees);
    });
    return () => { alive = false; off(); };
  }, [meetingId, me]);

  const live = meeting?.status === "live";
  const agenda = meeting?.agenda ?? [];
  const n = agenda.length;
  const presenting = !!meeting && live && meeting.presenterId === me;
  const [follow, setFollow] = useState(true);
  const [own, setOwn] = useState(0);
  const presenterPlace = Math.min(Math.max(0, meeting?.place ?? 0), Math.max(0, n - 1));
  const idx = presenting || (live && follow) ? presenterPlace : Math.min(own, Math.max(0, n - 1));
  const item: AgendaItem | undefined = agenda[idx];

  /* ---- people ---- */
  const nameOf = useCallback((id: string): string | undefined => getMember(id)?.name ?? members.find((m) => m.userId === id)?.name ?? undefined, [members]);
  const host = meeting ? workspaces.find((w) => w.id === meeting.workspaceId) : undefined;
  const wsName = useCallback((id: string | null | undefined) => (meeting && meeting.workspaceIds.length > 1 && id ? workspaces.find((w) => w.id === id)?.name : undefined), [meeting, workspaces]);
  const people = useMemo(() => (meeting ? meetingPeople("team", meeting.workspaceId, [meeting.workspaceId], me, members, workspaces) : []), [meeting, me, members, workspaces]);
  const canWrite = !!meeting && mayRun(meeting.preset, meeting.workspaceId, meeting.workspaceIds, me, members, workspaces)
    && (live || (!!meeting.endedAt && Date.now() - new Date(meeting.endedAt).getTime() < 7 * 86400000));
  const hostRole = meeting ? members.find((m) => m.workspaceId === meeting.workspaceId && m.userId === me && m.status === "active")?.role : undefined;
  const canEnd = !!meeting && live && (presenting || meeting.startedBy === me || hostRole === "owner" || hostRole === "admin" || host?.ownerId === me);
  const inRoom = attendees.filter((a) => a.joinedAt && a.userId !== me).map((a) => a.userId);
  const presenterName = meeting?.presenterId ? (meeting.presenterId === me ? "You" : firstName(nameOf(meeting.presenterId) ?? "Someone")) : null;
  const recipients = attendees.filter((a) => a.userId !== me).map((a) => nameOf(a.userId) ?? "").filter(Boolean);

  /* ---- moving ---- */
  const flush = useCallback(() => {
    const p = pendingMove.current;
    if (!p || !meeting) return;
    pendingMove.current = null;
    inFlight.current++;
    void moveMeeting(meeting.id, p.place, meeting.agenda[p.place]?.key ?? null, me).then((r) => {
      inFlight.current--;
      if (!r.ok) toast?.error(r.message);
      else if (!pendingMove.current && inFlight.current === 0) setMeeting((cur) => (cur ? { ...cur, presenterId: r.data.presenterId, movedAt: r.data.movedAt } : cur));
    });
  }, [meeting, me, toast]);
  useEffect(() => () => { if (pendingMove.current) window.clearTimeout(pendingMove.current.timer); }, []);
  const go = useCallback((to: number) => {
    if (!meeting || !n) return;
    const place = Math.max(0, Math.min(n - 1, to));
    if (presenting) {
      if (place === presenterPlace && !pendingMove.current) return;
      setMeeting((cur) => (cur ? { ...cur, place, placeKey: cur.agenda[place]?.key ?? null, movedAt: new Date().toISOString() } : cur));
      if (pendingMove.current) window.clearTimeout(pendingMove.current.timer);
      pendingMove.current = { place, timer: window.setTimeout(flush, MOVE_SETTLE_MS) };
      return;
    }
    if (live && follow && place === presenterPlace) return;
    setFollow(false);
    setOwn(place);
  }, [meeting, n, presenting, presenterPlace, flush, live, follow]);
  const backToPresenter = () => { setFollow(true); setOwn(presenterPlace); };
  // following someone else's place moves your own with it (step away, and you step from there)
  useEffect(() => { if (follow) setOwn(presenterPlace); }, [follow, presenterPlace]);

  const takeOver = async () => {
    if (!meeting) return;
    const r = await presentMeeting(meeting.id, me);
    if (!r.ok) { toast?.error(r.message); return; }
    setMeeting(r.data);
    setFollow(true);
    // you carry on from where you are
    if (idx !== r.data.place) go(idx);
  };
  const [handOpen, setHandOpen] = useState(false);
  const handRef = useRef<HTMLButtonElement>(null);
  const handTo = async (who: string) => {
    setHandOpen(false);
    if (!meeting) return;
    if (pendingMove.current) { window.clearTimeout(pendingMove.current.timer); flush(); }
    const r = await handMeeting(meeting.id, who, me);
    if (!r.ok) { toast?.error(r.message); return; }
    setMeeting(r.data);
    setFollow(true);
    toast?.success(`${firstName(nameOf(who) ?? "They")} is presenting`);
  };

  /* ---- notes ---- */
  const [scope, setScope] = useState<"item" | "all">("item");
  const composerRef = useRef<HTMLInputElement>(null);
  const [notesOpen, setNotesOpen] = useState(false);   // (a phone: the notes in a sheet)
  const [agendaOpen, setAgendaOpen] = useState(false);
  const agendaKey = item ? (item.kind === "wrap" ? "wrap" : item.key) : null;
  const agendaTitle = useCallback((key: string | null) => (key ? agenda.find((a) => a.key === key)?.title : undefined), [agenda]);
  const add = useCallback(async (input: ItemInput): Promise<boolean> => {
    if (!meeting) return false;
    const r = await addItem(meeting.id, input, me);
    if (!r.ok) { toast?.error(r.message); return false; }
    setItems((xs) => (xs.some((x) => x.id === r.data.id) ? xs : [...xs, r.data]));
    return true;
  }, [meeting, me, toast]);
  const remove = useCallback(async (it: MeetingItem) => {
    setItems((xs) => xs.filter((x) => x.id !== it.id));
    const r = await deleteItem(it);
    if (!r.ok) { toast?.error(r.message); setItems((xs) => (xs.some((x) => x.id === it.id) ? xs : [...xs, it].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))); }
  }, [toast]);

  /* ---- lines into tasks (Extract tasks) ---- */
  const taskById = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data.tasks]);
  const hostProjects = useMemo(() => (meeting ? projects.filter((p) => p.workspaceId === meeting.workspaceId && !p.archivedAt) : []), [projects, meeting]);
  const [extract, setExtract] = useState<{ text: string; from?: MeetingItem } | null>(null);
  const linkWithRetry = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    for (const wait of LINK_TRIES) {
      if (wait) await new Promise((r) => window.setTimeout(r, wait));
      const r = await fn();
      if (r.ok) return true;
      if (!/can't do that/.test(r.message ?? "")) { toast?.error(r.message ?? "Couldn't link that task to the meeting."); return false; }
    }
    toast?.error("The tasks were made, but couldn't be linked to the meeting.");
    return false;
  };
  const onExtracted = (rows: Array<Partial<Task> & { title: string }>): boolean | void => {
    if (!createTasks || !meeting) return false;
    const ids = createTasks(rows);
    if (!Array.isArray(ids) || !ids.length) return;
    const from = extract?.from;
    const made = rows.map((r, i) => ({ row: r, id: ids[i] })).filter((x) => !!x.id);
    void (async () => {
      if (from && from.kind === "action" && !from.taskId && made[0]) {
        const [first, ...rest] = made;
        await linkWithRetry(() => updateItem({ ...from, taskId: first.id, ownerId: first.row.assigneeId ?? from.ownerId, due: first.row.dueDate ?? from.due }));
        for (const x of rest) await linkWithRetry(() => addItem(meeting.id, { kind: "action", body: x.row.title, agendaKey: from.agendaKey, ownerId: x.row.assigneeId ?? null, due: x.row.dueDate ?? null, taskId: x.id }, me));
        return;
      }
      const links = from ? made.map((x) => ({ taskId: x.id, itemId: null as string | null })) : linkCreated(made.map((x) => ({ id: x.id, title: x.row.title })), items);
      for (const [i, l] of links.entries()) {
        const x = made[i];
        const it = l.itemId ? items.find((y) => y.id === l.itemId) : undefined;
        if (it) await linkWithRetry(() => updateItem({ ...it, taskId: x.id, ownerId: x.row.assigneeId ?? it.ownerId, due: x.row.dueDate ?? it.due }));
        else await linkWithRetry(() => addItem(meeting.id, { kind: "action", body: x.row.title, agendaKey: from?.agendaKey ?? agendaKey, ownerId: x.row.assigneeId ?? null, due: x.row.dueDate ?? null, taskId: x.id }, me));
      }
    })();
  };
  const makeTask = (it: MeetingItem) => setExtract({ text: makeTaskText(it, nameOf), from: it });
  const extractAll = () => setExtract({ text: extractText(items, nameOf) });

  /* ---- the notes doc ---- */
  const docProject = meeting?.docProjectId ? hostProjects.find((p) => p.id === meeting.docProjectId) : hostProjects[0];
  const [docBusy, setDocBusy] = useState(false);
  const savedDoc = useRef<{ docId: string; updatedAt: string } | null>(null);
  const saveDoc = async (opts: { quiet?: boolean } = {}): Promise<{ docId: string; projectId: string } | null> => {
    if (!meeting || !docProject) return null;
    setDocBusy(true);
    try {
      const names = attendees.filter((a) => a.joinedAt || a.invited).map((a) => nameOf(a.userId) ?? "").filter(Boolean);
      const doc = meetingDoc(meeting, items, { nameOf, attendees: names, day: toLocalISO(new Date(meeting.startedAt)), projectName: docProject.name });
      const mine = savedDoc.current && savedDoc.current.docId === meeting.docId ? savedDoc.current : null;
      if (meeting.docId && !mine) return { docId: meeting.docId, projectId: meeting.docProjectId ?? docProject.id };   // someone else's: leave it
      const r = await saveProjectDoc({ id: mine?.docId ?? newId(), projectId: docProject.id, title: doc.title, icon: doc.icon, body: doc.body, baseUpdatedAt: mine?.updatedAt ?? null, mentions: [] });
      if (r.status === "conflict") {
        if (!opts.quiet) toast?.error("The notes doc was edited since, so Kanbo left it as it is.");
        return { docId: r.doc.id, projectId: docProject.id };
      }
      savedDoc.current = { docId: r.doc.id, updatedAt: r.doc.updatedAt };
      if (meeting.docId !== r.doc.id) {
        const s = await setMeetingDoc(meeting.id, r.doc.id, docProject.id, me);
        if (s.ok) setMeeting((cur) => (cur ? { ...cur, docId: r.doc.id, docProjectId: docProject.id } : cur));
      }
      if (!opts.quiet) toast?.success(`Notes saved to ${docProject.name}`);
      return { docId: r.doc.id, projectId: docProject.id };
    } catch (e) {
      toast?.error(e instanceof Error && /not allowed|not authorized/.test(e.message) ? "You can't add docs to that project." : "Couldn't save the notes doc. Try again.");
      return null;
    } finally { setDocBusy(false); }
  };
  const openDoc = async () => {
    if (meeting?.docId && meeting.docProjectId) { onOpenDoc(meeting.docProjectId, meeting.docId); return; }
    if (meeting?.docId) {
      const d = await getProjectDoc(meeting.docId).catch(() => null);
      if (d) onOpenDoc(d.projectId, d.id);
    }
  };

  /* ---- ending ---- */
  const [ending, setEnding] = useState(false);
  const end = async () => {
    if (!meeting) return;
    setEnding(true);
    if (pendingMove.current) { window.clearTimeout(pendingMove.current.timer); flush(); }
    const doc = await saveDoc({ quiet: true });
    const r = await endMeeting(meeting.id, me, doc);
    setEnding(false);
    if (!r.ok) { toast?.error(r.message); return; }
    setMeeting(r.data);
    refreshLiveMeetings();
    const who = recipients.map(firstName);
    toast?.success(who.length && (meetingsMode() === "shared" || isDemoMeetings()) ? `Recap sent to ${listWords(who)}` : "Meeting ended");
  };
  const goWrap = () => { const i = agenda.findIndex((a) => a.kind === "wrap"); if (i >= 0) go(i); };

  /* ---- keys ---- */
  const roomRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const [help, setHelp] = useState(false);
  useEffect(() => { stageRef.current?.focus({ preventScroll: true }); }, [meeting?.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const room = roomRef.current;
      const at = document.activeElement;
      // only while the room has the keys (not a sheet, menu or the task panel over it)
      if (!room || (at && at !== document.body && !room.contains(at))) return;
      if (isEditableTarget(e.target)) return;
      const k = e.key;
      if (k === "Escape") { e.preventDefault(); if (help) setHelp(false); else onClose(); return; }
      if (!meeting || meeting.status !== "live") return;
      if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === "j") { e.preventDefault(); go(idx + 1); }
      else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "k") { e.preventDefault(); go(idx - 1); }
      else if (k === "Home") { e.preventDefault(); go(0); }
      else if (k === "End") { e.preventDefault(); go(n - 1); }
      else if (k === "n" && canWrite) { e.preventDefault(); if (phone) setNotesOpen(true); window.setTimeout(() => composerRef.current?.focus(), 0); }
      else if (k === "f" && !presenting) { e.preventDefault(); if (follow) setFollow(false); else backToPresenter(); }
      else if (k === "?") { e.preventDefault(); setHelp((h) => !h); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });   // (every render: it reads the current place)

  /* ---- the screen ---- */
  if (typeof document === "undefined") return null;
  const stageCtx: StageContext = { taskById, nameOf, onOpenTask, wsName, agenda, onGo: live ? go : undefined };
  const wrapCtx: WrapContext = { nameOf, taskById, onOpenTask, onMakeTask: canWrite && createTasks ? makeTask : undefined, onDelete: canWrite ? (it) => void remove(it) : undefined, agendaTitle };
  const notes = meeting && live ? (
    <RoomNotes items={items} agendaKey={agendaKey} agendaTitle={agendaTitle} people={people} canWrite={canWrite} onAdd={add}
      onDelete={(it) => void remove(it)} onMakeTask={createTasks ? makeTask : undefined} nameOf={nameOf} taskById={taskById} onOpenTask={onOpenTask}
      composerRef={composerRef} scope={scope} onScope={setScope} />
  ) : null;
  const budget = meeting ? PRESETS[meeting.preset].minutes : 15;

  return createPortal(
    <div ref={roomRef} className="kmtg-room" role="dialog" aria-modal="true" aria-label={meeting?.title ?? "Meeting"} data-phone={phone || undefined} data-ended={meeting && !live ? "" : undefined} data-kdnd-ignore="">
      <style>{BUSINESS_CSS}</style>
      <header className="kmtg-top">
        {host && <WorkspaceMark workspace={host} size={28} />}
        <div className="kmtg-top-title">
          <h1 className="kmtg-title">{meeting?.title ?? "Meeting"}</h1>
          <p className="kmtg-top-sub">
            {meeting === undefined ? "Opening…" : !meeting ? "Not available" : live ? (
              <><span className="kmtg-livedot" aria-hidden="true" />{meetingsMode() === "local" && !isDemoMeetings() ? "On your screen only" : "Live"}{presenterName ? ` · ${presenterName === "You" ? "You're presenting" : `${presenterName} is presenting`}` : ""}</>
            ) : <>Recap · {meeting.preset === "leadership" ? "Leadership" : "Team"} meeting{meeting.endedAt ? `, ${meetingDay(new Date(meeting.endedAt))}` : ""}</>}
          </p>
        </div>
        {meeting && live && <RoomClock startedAt={meeting.startedAt} movedAt={meeting.movedAt} budget={budget} />}
        {meeting && live && inRoom.length > 0 && (
          <span className="kmtg-inroom" title={`In the room: ${listWords(inRoom.map((id) => nameOf(id) ?? "Someone"))}`}>
            <AvatarStack ids={inRoom.filter((id) => getMember(id)).slice(0, 5)} size={24} />
            <span className="kmtg-inroom-n">{inRoom.length + 1} here</span>
          </span>
        )}
        <span className="kmtg-top-acts">
          {meeting && live && presenting && inRoom.length > 0 && !phone && (
            <>
              <Button ref={handRef} size="sm" variant="ghost" icon="users" onClick={() => setHandOpen((o) => !o)} aria-haspopup="menu" aria-expanded={handOpen}>Hand over</Button>
              <Popover open={handOpen} anchorRef={handRef} onClose={() => setHandOpen(false)} role="menu" label="Hand over to" align="end" minWidth={200}>
                <div className="kmtg-menu">
                  {inRoom.map((id) => (
                    <button key={id} type="button" role="menuitem" className="kmtg-menu-i" onClick={() => void handTo(id)}>
                      <PersonMark id={id} name={nameOf(id)} size={20} />{nameOf(id) ?? "Someone"}
                    </button>
                  ))}
                </div>
              </Popover>
            </>
          )}
          {meeting && live && !presenting && <Button size="sm" variant="secondary" icon="play" onClick={() => void takeOver()}>Present</Button>}
          {canEnd && item?.kind !== "wrap" && <Button size="sm" variant="secondary" onClick={goWrap}>{phone ? "End" : "End meeting"}</Button>}
          <IconButton icon="x" label={live ? "Leave (the meeting carries on)" : "Close"} onClick={onClose} />
        </span>
      </header>

      {meeting === undefined ? (
        <div className="kmtg-loading" role="status"><span className="skel" /><span className="skel" /><span className="skel" /></div>
      ) : !meeting ? (
        <div className="kmtg-gone">
          <h2 className="kmtg-h">This meeting isn't here</h2>
          <p className="kmtg-sub">It may have been deleted, or it's for people you're not among.</p>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      ) : !live ? (
        <div className="kmtg-recap-wrap">
          <RoomRecap meeting={meeting} items={items} ctx={wrapCtx} ranBy={meeting.endedBy ? nameOf(meeting.endedBy) : undefined}
            docLabel={docProject?.name} hasDoc={!!meeting.docId} docBusy={docBusy}
            onSaveDoc={canWrite && docProject ? () => void saveDoc() : undefined} onOpenDoc={() => void openDoc()}
            onExtract={canWrite && createTasks ? extractAll : undefined}
            onOpenPrevious={meeting.previousId && onOpenMeeting ? () => onOpenMeeting(meeting.previousId!) : undefined} />
        </div>
      ) : (
        <>
          <div className="kmtg-body">
            {!phone && (
              <nav className="kmtg-rail" aria-label="Agenda">
                <AgendaList agenda={agenda} idx={idx} presenterPlace={presenterPlace} presenterName={presenting ? null : presenterName} items={items} onGo={go} />
              </nav>
            )}
            <main ref={stageRef} className="kmtg-stage" tabIndex={-1} aria-label={item ? `${item.title}, ${idx + 1} of ${n}` : "Agenda"}>
              <span className="sr-only" role="status">{item ? `${idx + 1} of ${n}: ${item.title}` : ""}</span>
              {!presenting && !follow && idx !== presenterPlace && (
                <button type="button" className="kmtg-follow" onClick={backToPresenter}>
                  <Icon name="arrowLeft" size={14} />Back to {presenterName}'s place · {presenterPlace + 1} of {n}
                </button>
              )}
              {item && (item.kind === "wrap" ? (
                <RoomWrap items={items} ctx={wrapCtx} live canEnd={canEnd} recipients={recipients} shared={meetingsMode() === "shared" || isDemoMeetings()}
                  docLabel={docProject?.name} hasDoc={!!meeting.docId} docBusy={docBusy}
                  onSaveDoc={canWrite && docProject ? () => void saveDoc() : undefined} onOpenDoc={() => void openDoc()}
                  onExtract={canWrite && createTasks ? extractAll : undefined} onEnd={() => void end()} ending={ending} />
              ) : <RoomStage item={item} ctx={stageCtx} />)}
            </main>
            {!phone && <aside className="kmtg-notes" aria-label="Notes">{notes}</aside>}
          </div>
          <footer className="kmtg-bottom">
            <Button variant="secondary" icon="arrowLeft" onClick={() => go(idx - 1)} disabled={idx === 0} aria-keyshortcuts="ArrowLeft">{phone ? "" : "Previous"}</Button>
            {phone ? (
              <button type="button" className="kmtg-pos" onClick={() => setAgendaOpen(true)} aria-label={`Agenda: ${idx + 1} of ${n}, ${item?.title ?? ""}`}>
                <span className="kmtg-pos-n">{idx + 1} of {n}</span><span className="kmtg-pos-t">{item?.title}</span><Icon name="chevronDown" size={14} />
              </button>
            ) : (
              <span className="kmtg-pos"><span className="kmtg-pos-n">{idx + 1} of {n}</span><span className="kmtg-pos-t">{item?.title}</span>
                <button type="button" className="kmtg-keys" onClick={() => setHelp((h) => !h)} aria-expanded={help}>Keys</button></span>
            )}
            {phone && <Button variant="secondary" icon="notes" onClick={() => setNotesOpen(true)}>{items.length ? `${items.length}` : "Notes"}</Button>}
            <Button variant={idx === n - 1 ? "secondary" : "primary"} iconRight="arrowRight" onClick={() => go(idx + 1)} disabled={idx >= n - 1} aria-keyshortcuts="ArrowRight">{phone ? "" : "Next"}</Button>
          </footer>
          {help && (
            <div className="kmtg-help" role="note">
              <p><kbd>←</kbd> <kbd>→</kbd> or <kbd>J</kbd> <kbd>K</kbd> previous and next · <kbd>Home</kbd> <kbd>End</kbd> first and last</p>
              <p><kbd>N</kbd> write a note · {presenting ? "you're presenting: everyone follows you" : <><kbd>F</kbd> follow {presenterName} or look round on your own</>} · <kbd>Esc</kbd> leave (it carries on)</p>
            </div>
          )}
        </>
      )}

      {phone && meeting && live && (
        <>
          <Sheet open={agendaOpen} onClose={() => setAgendaOpen(false)} label="Agenda" title="Agenda" side="bottom">
            <AgendaList agenda={agenda} idx={idx} presenterPlace={presenterPlace} presenterName={presenting ? null : presenterName} items={items} onGo={(i) => { go(i); setAgendaOpen(false); }} />
          </Sheet>
          <Sheet open={notesOpen} onClose={() => setNotesOpen(false)} label="Notes" side="bottom">{notes}</Sheet>
        </>
      )}
      {extract && meeting && (
        <ExtractTasksSheet open onClose={() => setExtract(null)} initialText={extract.text} context={meeting.title}
          projects={hostProjects} members={people} defaultProjectId={docProject?.id} currentUserId={me}
          onExtractAI={aiExtract} onCreate={onExtracted} />
      )}
    </div>,
    document.body,
  );
}

/** The agenda, grouped by section: where you are, where the presenter is, and how much is logged on each item. */
function AgendaList({ agenda, idx, presenterPlace, presenterName, items, onGo }: {
  agenda: readonly AgendaItem[]; idx: number; presenterPlace: number; presenterName: string | null; items: readonly MeetingItem[];
  onGo: (i: number) => void;
}) {
  const logged = new Map<string, number>();
  for (const it of items) if (it.agendaKey) logged.set(it.agendaKey, (logged.get(it.agendaKey) ?? 0) + 1);
  let last: string | null = null;
  return (
    <ol className="kmtg-agenda">
      {agenda.map((a, i) => {
        const sec = sectionOf(a);
        const head = sec === "people" && last !== "people" ? SECTION_LABEL.people : null;
        last = sec;
        const n = logged.get(a.kind === "wrap" ? "wrap" : a.key) ?? 0;
        return (
          <li key={a.key} data-person={a.kind === "person" || undefined}>
            {head && <span className="kmtg-agenda-h">{head}</span>}
            <button type="button" className="kmtg-agenda-i" aria-current={i === idx ? "step" : undefined} onClick={() => onGo(i)}>
              {a.kind === "person" ? <PersonMark id={a.personId} name={a.title} size={20} /> : <span className="kmtg-agenda-n">{i + 1}</span>}
              <span className="kmtg-agenda-t">{a.title}</span>
              {a.kind === "person" && a.offNow && <span className="kmtg-off" data-now="">Off</span>}
              {presenterName && i === presenterPlace && i !== idx && <span className="kmtg-agenda-here" title={`${presenterName} is here`}>{presenterName}</span>}
              {n > 0 && <span className="kmtg-agenda-c" aria-label={`${n} logged`}>{n}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The meeting's time against its time box, and the time on this item. */
function RoomClock({ startedAt, movedAt, budget }: { startedAt: string; movedAt: string; budget: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  const total = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const here = Math.max(0, Math.floor((now - new Date(movedAt).getTime()) / 1000));
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const over = total > budget * 60;
  return (
    <span className="kmtg-clock" data-over={over || undefined} role="timer" aria-label={`${Math.floor(total / 60)} minutes in, of ${budget}; ${Math.floor(here / 60)} on this item`}>
      <span className="kmtg-clock-t" aria-hidden="true">{mmss(total)}</span>
      <span className="kmtg-clock-b" aria-hidden="true">of {budget}:00 · {mmss(here)} here</span>
    </span>
  );
}

/* ============================================================
   KANBO — Team › People: who's here, what they're working on and how
   full their week is; invites (several at once), roles, and each
   person's profile. Plus WorkspaceSettingsPanel (logo, name, Close
   workspace), which Settings › Workspace renders — it's no longer on
   this page.
   ============================================================ */
import { useState, useEffect, useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Icon, IconButton, Avatar, Button, EmptyState, Meter, Pill, SectionLabel, Segmented, Sheet, StatusGlyph, ProjectDot } from "../primitives";
import { getProject, getMember, KANBO_TODAY } from "../../data/data";
import { can, canManageMember, assignableRoles, ROLE_META } from "../../lib/permissions";
import type { Task, Workspace, WorkspaceMember, Role } from "../../data/types";
import { AVATAR_ACCEPT, AVATAR_MESSAGES, avatarExtension, avatarMime } from "../../lib/avatarUpload";
import { uiZoom } from "../../lib/appearance";
import { inviteEmailNotice, type InviteEmailResult, type InvitedMember } from "../../data/store";
import { capacityOf, loadForWeek, loadTone, readCapacities } from "../../lib/radar";
import { startOfWeekMon } from "./reportingUtils";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* ---------- workspace logo cropper — drag to reposition + zoom, outputs a square PNG ----------
   The crop is redrawn on a canvas and saved as a fresh 256px PNG, so what's
   uploaded never carries the original's metadata (a phone photo's location)
   and always fits the avatars bucket (PNG/JPEG/GIF/WebP, 5 MB). */
const LOGO_TYPE_MSG = "Choose a PNG, JPG, GIF or WebP image for the logo.";
/** Why a picked file can't be cropped into a logo, or null. HEIC goes through: Safari can read it (the crop is a PNG). */
function logoFileProblem(file: { type?: string; name?: string; size: number }): string | null {
  const mime = avatarMime(file);
  if (!avatarExtension(mime) && mime !== "image/heic" && mime !== "image/heif") return LOGO_TYPE_MSG;
  if (file.size <= 0) return AVATAR_MESSAGES.empty;
  return null;
}
function LogoCropper({ file, onCancel, onConfirm, onError }: { file: File; onCancel: () => void; onConfirm: (f: File) => void; onError: (message: string) => void }) {
  const V = 280;            // viewport (square) in px
  const [url, setUrl] = useState("");
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const zoomRef = useRef<HTMLInputElement>(null);

  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u); }, [file]);

  const baseScale = nat ? Math.max(V / nat.w, V / nat.h) : 1;   // "cover" baseline so the square is always filled
  const scale = baseScale * zoom;
  const dispW = nat ? nat.w * scale : V;
  const dispH = nat ? nat.h * scale : V;

  // keep the image covering the viewport at all times
  const clamp = (o: { x: number; y: number }, dW: number, dH: number) => ({
    x: Math.min(0, Math.max(V - dW, o.x)),
    y: Math.min(0, Math.max(V - dH, o.y)),
  });

  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const w = e.currentTarget.naturalWidth, h = e.currentTarget.naturalHeight;
    setNat({ w, h });
    const bs = Math.max(V / w, V / h);
    setOffset({ x: (V - w * bs) / 2, y: (V - h * bs) / 2 });   // centred
  };

  const changeZoom = (z: number) => {
    if (!nat) { setZoom(z); return; }
    const oldS = baseScale * zoom, newS = baseScale * z;
    const cx = (V / 2 - offset.x) / oldS, cy = (V / 2 - offset.y) / oldS;   // hold the viewport centre fixed
    setZoom(z);
    setOffset(clamp({ x: V / 2 - cx * newS, y: V / 2 - cy * newS }, nat.w * newS, nat.h * newS));
  };

  const startDrag = (e: ReactPointerEvent) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    const z = uiZoom(); // pointer px → the dialog's px at Small/Large text
    const move = (ev: PointerEvent) => {
      const d = dragRef.current; if (!d || !nat) return;
      setOffset(clamp({ x: d.ox + (ev.clientX - d.x) / z, y: d.oy + (ev.clientY - d.y) / z }, nat.w * scale, nat.h * scale));
    };
    const up = () => { dragRef.current = null; window.removeEventListener("pointermove", move); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const save = () => {
    const img = imgRef.current; if (!nat || !img) return;
    setBusy(true);
    const S = 256;
    const canvas = document.createElement("canvas");
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext("2d");
    if (!ctx) { setBusy(false); return; }
    // map the viewport's visible region back to natural-image coordinates
    const sSize = V / scale;
    ctx.drawImage(img, -offset.x / scale, -offset.y / scale, sSize, sSize, 0, 0, S, S);
    canvas.toBlob((blob) => {
      if (!blob) { setBusy(false); onError(AVATAR_MESSAGES.prepare); return; }
      onConfirm(new File([blob], "workspace-logo.png", { type: "image/png" }));
    }, "image/png", 0.92);
  };

  return (
    <Sheet open onClose={onCancel} label="Adjust logo" title="Adjust logo" width={360} initialFocus={zoomRef}
      footer={<><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button variant="primary" onClick={save} loading={busy} disabled={!nat}>Save logo</Button></>}>
      <div className="kcrop">
        <div onPointerDown={startDrag} className="kcrop-view" style={{ width: V, height: V }}>
          {url && <img ref={imgRef} src={url} alt="" onLoad={onImgLoad} onError={() => onError(/hei[cf]$/.test(avatarMime(file)) ? AVATAR_MESSAGES.heic : AVATAR_MESSAGES.unreadable)} draggable={false} style={{ position: "absolute", left: offset.x, top: offset.y, width: dispW, height: dispH, maxWidth: "none", userSelect: "none", pointerEvents: "none" }} />}
        </div>
        <label className="kcrop-zoom">
          <Icon name="search" size={16} sw={1.75} />
          <input ref={zoomRef} type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => changeZoom(parseFloat(e.target.value))} aria-label="Zoom" />
        </label>
        <p className="kcrop-hint">Drag to reposition · slide to zoom</p>
      </div>
    </Sheet>
  );
}

/* ---------- People helpers ---------- */

/** Best-known name: the live profile name first, then the invite row, then the email. */
function memberName(m: WorkspaceMember): string {
  return (m.userId ? getMember(m.userId)?.name?.trim() : "") || m.name?.trim() || m.email;
}

/** Role description shown on the Team page. Guests read every project in the
    workspace (0041 RLS: active members read team rows) — say so, because
    "guest" usually implies narrower access than that. */
function roleBlurb(r: Role): string {
  return r === "guest" ? "Can view and comment — sees every project in this workspace" : ROLE_META[r]?.blurb ?? "";
}

const withArticle = (word: string) => (/^[aeiou]/i.test(word) ? "an " : "a ") + word;

/** Turn an invite_member failure into something an owner can act on. Matches
    both the raw RPC wording and the store's already-friendly rewrite of it. */
function inviteErrorText(e: unknown, email: string): string {
  const raw = String((e as { message?: unknown } | null)?.message ?? e ?? "").replace(/^Error:\s*/i, "").trim();
  if (/already a member/i.test(raw)) return `${email} is already a member — open their card to change their role.`;
  if (/only the (workspace )?owner can (add|invite) admins/i.test(raw)) return "Only the workspace owner can invite admins.";
  if (/not authori[sz]ed|permission denied|row-level security|only workspace owners and admins/i.test(raw)) return "Only owners and admins can invite people to this workspace.";
  if (/invalid email|valid email address/i.test(raw)) return "That email address doesn't look right — check it and try again.";
  if (/invalid role|choose a role/i.test(raw)) return "Choose a role for them first.";
  if (/failed to fetch|networkerror|network request failed|load failed|offline/i.test(raw)) return "You seem to be offline — check your connection and try again.";
  if (/^couldn['’]?t\b/i.test(raw)) return raw;   // already a whole sentence
  return raw ? `Couldn't send the invite: ${raw}` : "Couldn't send the invite. Please try again.";
}

const isThenable = (x: unknown): x is PromiseLike<unknown> =>
  !!x && (typeof x === "object" || typeof x === "function") && typeof (x as { then?: unknown }).then === "function";

/** Emails typed or pasted: split on commas, semicolons, spaces and new lines;
 *  "Name <sam@x.io>" keeps the address. Valid ones lower-cased and de-duplicated. */
export function parseEmails(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [], invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const s = raw.trim().replace(/^<|>$/g, "").replace(/^mailto:/i, "");
    if (!s) continue;
    if (EMAIL_RE.test(s)) { const v = s.toLowerCase(); if (!valid.includes(v)) valid.push(v); }
    else if (!invalid.includes(s)) invalid.push(s);
  }
  return { valid, invalid };
}

// the invite-member email function skips a send within a minute of the last
// one for the same invite, so Resend waits that long
const RESEND_COOLDOWN = 60_000;

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* permission denied / insecure context — fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-1000px";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

/** The role, as a quiet pill; pending invites read "Invited". Members — the
 *  default — carry none (`always` shows it anyway, e.g. in the profile). */
function RoleBadge({ m, always }: { m: WorkspaceMember; always?: boolean }) {
  if (m.status === "invited") return <Pill tone="warn">Invited</Pill>;
  if (m.role === "member" && !always) return null;
  return <Pill tone={m.role === "owner" ? "accent" : "neutral"} title={roleBlurb(m.role)}>{ROLE_META[m.role]?.label}</Pill>;
}

/* Per pending email: "fresh" = invited from this page a moment ago, "sent" =
   re-invited a moment ago, "emailed" = its email re-sent a moment ago (all hold
   Resend off for RESEND_COOLDOWN). `info` is a
   note about the email that needs nothing from you; with `hold` (an email went
   under a minute ago) Resend waits out the cooldown too. */
type ResendState = "sending" | "sent" | "emailed" | "fresh" | { error: string } | { info: string; hold?: boolean };

interface Load { hours: number; capacity: number }

/* One person: identity, what they're working on, their week and open count.
   The whole row opens their profile; pending invites add Resend and Copy link
   for owners and admins. Hoisted so it keeps its identity across renders. */
function PersonRow({ m, name, isSelf, openN, working, load, onSelect, invite }: {
  m: WorkspaceMember;
  name: string;
  isSelf: boolean;
  openN: number;
  working?: Task;
  load?: Load;
  onSelect: () => void;
  invite?: { canResend: boolean; resend?: ResendState; copied?: "ok" | "failed"; onResend: () => void; onCopy: () => void };
}) {
  const pending = m.status !== "active";
  const resend = invite?.resend;
  const resendError = resend && typeof resend === "object" && "error" in resend ? resend.error : null;
  const resendInfo = resend && typeof resend === "object" && "info" in resend ? resend : null;
  const done = resend === "sent" || resend === "emailed" || resend === "fresh" || !!resendInfo?.hold;
  const resendLabel = resend === "sending" ? "Sending…" : resend === "sent" ? "Invite refreshed" : resend === "emailed" ? "Invite sent" : resend === "fresh" ? "Just invited" : resendInfo?.hold ? "Recently sent" : "Resend";
  const feedback = resendError
    ? resendError
    : resendInfo ? resendInfo.info
    : resend === "sent" || resend === "emailed" ? "If the email doesn't reach them, copy the sign-up link and send it yourself."
    : invite?.copied === "ok" ? `Share it with them — they need to sign up with ${m.email} to join.`
    : invite?.copied === "failed" ? `Couldn't copy automatically — the sign-up link is ${window.location.origin}/`
    : null;
  const tone = load ? loadTone(load.hours, load.capacity) : "ink";
  const hours = load ? `${Math.round(load.hours * 10) / 10}h / ${Math.round(load.capacity * 10) / 10}h` : "";
  return (
    <li className="kppl-row" data-pending={pending || undefined}>
      <button type="button" className="kppl-main" onClick={onSelect} aria-haspopup="dialog">
        {m.userId && getMember(m.userId) ? <Avatar id={m.userId} size={32} /> : <span className="kppl-ghost" aria-hidden="true"><Icon name="user" size={16} sw={1.75} /></span>}
        <span className="kppl-id">
          <span className="kppl-line">
            <span className="kppl-name">{name}</span>
            {isSelf && <span className="kppl-you">you</span>}
            <RoleBadge m={m} />
          </span>
          <span className="kppl-sub">
            {pending
              ? `${name !== m.email ? `${m.email} · ` : ""}Invited as ${withArticle(ROLE_META[m.role]?.label.toLowerCase() ?? "member")}`
              : m.title?.trim() || (name !== m.email ? m.email : "")}
          </span>
        </span>
        {pending ? (
          <span className="kppl-work" data-muted="">They'll join as soon as they sign up or sign in with this email address.</span>
        ) : (
          <span className="kppl-work" data-muted={!working || undefined}>
            {working ? <>Working on: <span className="kppl-task">{working.title}</span></> : "Nothing in progress"}
          </span>
        )}
        {!pending && (
          m.role === "guest" || !load
            ? <span className="kppl-load"><span className="kppl-guest">{m.role === "guest" ? "Guest" : ""}</span></span>
            : (
              <span className="kppl-load">
                <Meter value={load.hours} max={load.capacity * 1.25} marker={load.capacity} width={96} height={4} tone={tone} label={`${name}: ${hours} this week`} />
                <span className="kppl-hours" data-tone={tone}>{hours}</span>
              </span>
            )
        )}
        {!pending && <span className="kppl-open">{openN} open</span>}
      </button>
      {invite && (
        <span className="kppl-actions">
          {invite.canResend && (
            <Button size="sm" variant="ghost" icon={done ? "check" : "refresh"} onClick={invite.onResend} disabled={resend === "sending" || done}
              aria-label={resend === "sending" ? `Sending invite to ${m.email}` : done ? `${resendLabel} (${m.email}) — you can resend in a minute` : `Resend invite to ${m.email}`}
              title={done ? "You can resend in a minute" : undefined} data-ok={done || undefined}>
              {resendLabel}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={invite.copied === "ok" ? "check" : "link"} onClick={invite.onCopy}
            aria-label={`Copy sign-up link for ${m.email}`} data-ok={invite.copied === "ok" || undefined}>
            {invite.copied === "ok" ? "Link copied" : "Copy link"}
          </Button>
        </span>
      )}
      {invite && <p className="kppl-feedback" aria-live="polite" data-tone={resendError ? "signal" : undefined}>{feedback}</p>}
    </li>
  );
}

/* Slide-over profile — role controls + role-gated task list. Hoisted so a
   realtime reload of members/tasks doesn't remount it (which wiped the
   Position draft and stole focus mid-typing). */
function MemberProfile({ m, name, isSelf, role, workspace, tasks, inviteOptions, onSetRole, onSetTitle, onTransferOwnership, onRemoveMember, onOpen, onClose }: {
  m: WorkspaceMember;
  name: string;
  isSelf: boolean;
  role: Role | undefined;
  workspace: string;
  tasks: Task[];
  inviteOptions: Role[];
  onSetRole?: (memberId: string, role: Role) => void;
  onSetTitle?: (memberId: string, title: string) => void;
  onTransferOwnership?: (workspaceId: string, memberId: string) => void;
  onRemoveMember: (memberId: string) => void;
  onOpen?: (taskId: string) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const memberId = m.userId ?? "";
  const assigned = tasks.filter((t) => t.assigneeId === memberId && !t.archivedAt);
  const openTasks = assigned.filter((t) => t.status !== "done").sort((a, b) => b.aiScore - a.aiScore);
  const doneN = assigned.length - openTasks.length;
  const canSeeTasks = can(role, "manageMembers") || isSelf;   // managers, or yourself
  const manageRole = m.status === "active" && !!onSetRole && canManageMember(role, m.role) && !isSelf;
  // anyone who manages members, or the member themselves, can set the position/title
  const canEditTitle = !!onSetTitle && m.status === "active" && (can(role, "manageMembers") || isSelf);
  const [titleDraft, setTitleDraft] = useState(m.title ?? "");
  // follow a saved/remote title change unless the user has an unsaved edit
  const syncedTitle = useRef(m.title ?? "");
  useEffect(() => {
    const next = m.title ?? "";
    setTitleDraft((d) => (d === syncedTitle.current ? next : d));
    syncedTitle.current = next;
  }, [m.title]);
  const pending = m.status !== "active";
  const titleUnchanged = titleDraft.trim() === (m.title ?? "");
  const canLeaveOrRemove = (canManageMember(role, m.role) && !isSelf) || (isSelf && m.role !== "owner");
  return (
    <Sheet open onClose={onClose} label={`${name} profile`} side="right" width={420} initialFocus={closeRef}>
      <div className="kprof">
        <div className="kprof-head">
          {m.userId && getMember(m.userId) ? <Avatar id={m.userId} size={40} /> : <span className="kppl-ghost" data-size="40" aria-hidden="true"><Icon name="user" size={20} sw={1.75} /></span>}
          <div className="kprof-who">
            <h2 className="kprof-name">{name}{isSelf && <span className="kppl-you">you</span>}</h2>
            {m.title && <p className="kprof-title">{m.title}</p>}
            {name !== m.email && <p className="kprof-email">{m.email}</p>}
          </div>
          <IconButton ref={closeRef} icon="x" label={`Close ${name} profile`} onClick={onClose} />
        </div>

        <div className="kprof-field">
          <span className="kprof-label" id={`kprof-role-${m.id}`}>Role</span>
          <div className="kprof-role">
            {manageRole ? (
              <select value={m.role} onChange={(e) => onSetRole!(m.id, e.target.value as Role)} aria-label={`Role for ${name}`} className="kfield-select">
                {[...new Set<Role>([m.role, ...inviteOptions])].map((r) => <option key={r} value={r}>{ROLE_META[r].label}</option>)}
              </select>
            ) : pending ? (
              <span className="kprof-value">{ROLE_META[m.role]?.label}</span>
            ) : <RoleBadge m={m} always />}
            <span className="kprof-hint">{roleBlurb(m.role)}</span>
          </div>
        </div>

        {/* position / job title — separate from the permission role */}
        {(canEditTitle || m.title) && (
          <div className="kprof-field">
            <label className="kprof-label" htmlFor={`kprof-pos-${m.id}`}>Position</label>
            {canEditTitle ? (
              <div className="kprof-inline">
                <input id={`kprof-pos-${m.id}`} value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} placeholder="e.g. Co-founder, Designer…" aria-label={`Position for ${name}`}
                  onKeyDown={(e) => { if (e.key === "Enter" && !titleUnchanged) onSetTitle!(m.id, titleDraft); }} className="kfield-input" />
                <Button variant="primary" disabled={titleUnchanged} onClick={() => onSetTitle!(m.id, titleDraft)}>Save</Button>
              </div>
            ) : (
              <span className="kprof-value">{m.title}</span>
            )}
          </div>
        )}

        {m.status === "active" && (
          <dl className="kprof-stats">
            <div><dt>Open</dt><dd>{openTasks.length}</dd></div>
            <div><dt>Completed</dt><dd data-tone="ok">{doneN}</dd></div>
          </dl>
        )}

        <div className="kprof-field">
          <SectionLabel count={m.status === "active" && canSeeTasks ? openTasks.length : undefined}>{isSelf ? "Your tasks" : "Assigned tasks"}</SectionLabel>
          {m.status !== "active" ? (
            <p className="kprof-hint">They haven't joined the workspace yet.</p>
          ) : !canSeeTasks ? (
            <p className="kprof-locked"><Icon name="lock" size={14} sw={1.75} /> Only admins can view a teammate's tasks.</p>
          ) : openTasks.length === 0 ? (
            <p className="kprof-hint">No open tasks.</p>
          ) : (
            <ul className="kprof-tasks">
              {openTasks.slice(0, 30).map((t) => {
                const proj = getProject(t.projectId);
                return (
                  <li key={t.id}>
                    <button type="button" onClick={() => { onOpen?.(t.id); onClose(); }} className="kprof-task">
                      <StatusGlyph status={t.status} size={14} />
                      <span className="truncate">{t.title}</span>
                      {proj && <ProjectDot color={proj.color} title={proj.name} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {((m.status === "active" && role === "owner" && onTransferOwnership && m.role !== "owner") || canLeaveOrRemove) && (
          <div className="kprof-danger">
            {m.status === "active" && role === "owner" && onTransferOwnership && m.role !== "owner" && (
              <Button variant="secondary" icon="target" full onClick={() => { if (window.confirm(`Make ${name} the owner? You'll become an admin.`)) { onTransferOwnership(workspace, m.id); onClose(); } }}>Make owner</Button>
            )}
            {canLeaveOrRemove && (
              <Button variant="secondary" icon="x" full className="kprof-remove" onClick={() => {
                // leaving / removal also takes the person off this workspace's task followers and
                // collaborators (0042 remove_member), and a re-invite doesn't put them back
                const q = isSelf ? "Leave this workspace? You'll also be taken off tasks you collaborate on or follow."
                  : pending ? `Cancel the invite to ${m.email}? They won't be able to join with it.`
                  : `Remove ${name} from this workspace? They'll also be taken off tasks they collaborate on or follow.`;
                if (window.confirm(q)) { onRemoveMember(m.id); onClose(); }
              }}>{isSelf ? "Leave workspace" : pending ? "Cancel invite" : "Remove from workspace"}</Button>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

/* ---------- workspace settings — branding + danger zone (owners and admins) ----------
   Settings › Workspace renders it (it left the Team page in the redesign).
   Nothing shows unless you can manage the workspace. */
export function WorkspaceSettingsPanel({ workspace, workspaces, myRole, currentUserId, onUpdateWorkspace, onUploadLogo, onDeleteWorkspace }: {
  workspace: string | null;
  workspaces: Pick<Workspace, "id" | "name" | "ownerId" | "logoUrl">[];
  myRole?: Role;
  /** until your role row loads, the workspace's owner still counts as its owner */
  currentUserId?: string;
  onUpdateWorkspace?: (workspaceId: string, name: string, logoUrl: string | null) => void;
  onUploadLogo?: (workspaceId: string, file: File) => void;
  onDeleteWorkspace?: (workspaceId: string) => void;
  /** accepted so a Settings host can pass the same props as the Team page; unused here */
  onNewWorkspace?: () => void;
}) {
  const ws = workspaces.find((w) => w.id === workspace);
  const [wsName, setWsName] = useState(ws?.name ?? "");
  const [savingWs, setSavingWs] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setWsName(ws?.name ?? ""); }, [workspace, ws?.name]);
  // feedback belongs to the workspace it was given in
  useEffect(() => { setLogoError(null); }, [workspace]);
  const role: Role | undefined = myRole ?? (currentUserId && ws?.ownerId === currentUserId ? "owner" : undefined);
  if (!can(role, "manageWorkspace") || !ws || !workspace) return null;
  const unchanged = !wsName.trim() || wsName.trim() === ws.name;

  return (
    <div className="kwsset">
      <style>{PEOPLE_CSS}</style>
      <div className="kwsset-row">
        <div className="kwsset-logo">
          {ws.logoUrl
            ? <img src={ws.logoUrl} alt="Workspace logo" />
            : <span aria-hidden="true">{(ws.name || "?").charAt(0).toUpperCase()}</span>}
        </div>
        <div className="kwsset-logo-side">
          <span className="kwsset-label">Logo</span>
          {/* the avatars bucket only takes PNG/JPEG/GIF/WebP: SVG and HEIC are left out of the picker (iPhones then hand over a JPEG) */}
          <input ref={logoRef} type="file" accept={AVATAR_ACCEPT} aria-label="Workspace logo image" style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) { const problem = logoFileProblem(f); setLogoError(problem); if (!problem) setCropFile(f); }
              if (logoRef.current) logoRef.current.value = "";
            }} />
          <span className="kwsset-actions">
            <Button size="sm" variant="secondary" icon="plus" onClick={() => logoRef.current?.click()}>{ws.logoUrl ? "Change logo" : "Upload logo"}</Button>
            {ws.logoUrl && <Button size="sm" variant="ghost" onClick={() => onUpdateWorkspace?.(workspace, ws.name, null)}>Remove</Button>}
          </span>
          <span className="kwsset-hint">PNG, JPG, GIF or WebP. Square works best.</span>
          {logoError && <span role="alert" className="kwsset-error">{logoError}</span>}
        </div>
      </div>

      <form className="kwsset-row kwsset-name" onSubmit={(e) => {
        e.preventDefault();
        if (unchanged || !workspace) return;
        setSavingWs(true); onUpdateWorkspace?.(workspace, wsName.trim(), ws.logoUrl ?? null); setTimeout(() => setSavingWs(false), 600);
      }}>
        <label className="kwsset-field">
          <span className="kwsset-label">Workspace name</span>
          <input value={wsName} onChange={(e) => setWsName(e.target.value)} className="kfield-input" />
        </label>
        <Button type="submit" variant="primary" disabled={savingWs || unchanged}>Save</Button>
      </form>

      {/* danger zone — owner only, and always last */}
      {can(role, "deleteWorkspace") && (
        <div className="kwsset-danger">
          <div>
            <p className="kwsset-danger-title">Close this workspace</p>
            <p className="kwsset-hint">Permanently deletes the workspace and all its projects, tasks and members. This cannot be undone.</p>
          </div>
          <Button variant="secondary" icon="trash" className="kwsset-close" onClick={() => {
            if (!workspace) return;
            const typed = window.prompt(`This permanently deletes "${ws.name}" and everything in it.\n\nType the workspace name to confirm:`);
            if (typed != null && typed.trim() === ws.name) onDeleteWorkspace?.(workspace);
            else if (typed != null) window.alert("Name didn't match — workspace was not closed.");
          }}>Close workspace</Button>
        </div>
      )}
      {cropFile && (
        <LogoCropper file={cropFile} onCancel={() => setCropFile(null)} onConfirm={(f) => { onUploadLogo?.(workspace, f); setCropFile(null); }}
          onError={(msg) => { setLogoError(msg); setCropFile(null); }} />
      )}
    </div>
  );
}

type RoleFilter = "all" | "admins" | "members" | "guests";
const ROLE_FILTER: Record<RoleFilter, (r: Role) => boolean> = {
  all: () => true,
  admins: (r) => r === "owner" || r === "admin",
  members: (r) => r === "member",
  guests: (r) => r === "guest",
};

/** One invite's outcome in a multi-invite: ok, refused (with the reason) or not an email. */
type InviteResult = { email: string; ok: boolean; text: string };

export function TeamView({ tasks, workspace, workspaces = [], members, currentUserId, myRole, onInvite, onResendInvite, onRemoveMember, onSetRole, onSetTitle, onTransferOwnership, onOpen, onNewWorkspace, onOpenWorkspaceSettings }: {
  tasks: Task[];
  workspace: string | null;
  workspaces?: { id: string | null; name: string; ownerId?: string; logoUrl?: string }[];
  members: WorkspaceMember[];
  currentUserId: string;
  myRole?: Role;
  /** Invite (or re-invite) an email. Return a promise that rejects on failure
      and the page confirms success or shows the server's reason inline
      ("already a member"…). A handler that returns nothing can't report the
      outcome, so the page then claims neither (it only clears the field, and
      the handler must surface failures itself). */
  onInvite: (workspaceId: string, email: string, role: Role) => void | Promise<unknown>;
  /** Re-send a pending invite's email (the invite itself stands). Without it,
      Resend re-runs onInvite, which refreshes the invite and emails it again. */
  onResendInvite?: (memberId: string) => Promise<InviteEmailResult>;
  onRemoveMember: (memberId: string) => void;
  onSetRole?: (memberId: string, role: Role) => void;
  onSetTitle?: (memberId: string, title: string) => void;
  onTransferOwnership?: (workspaceId: string, memberId: string) => void;
  onOpen?: (taskId: string) => void;
  /** Personal workspace: the "create a team" button */
  onNewWorkspace?: () => void;
  /** admins: a "Workspace settings" link to Settings › Workspace */
  onOpenWorkspaceSettings?: () => void;
  /** The workspace settings moved to Settings › Workspace (WorkspaceSettingsPanel);
      these are still accepted so older hosts compile, and are ignored. */
  onUpdateWorkspace?: (workspaceId: string, name: string, logoUrl: string | null) => void;
  onUploadLogo?: (workspaceId: string, file: File) => void;
  onDeleteWorkspace?: (workspaceId: string) => void;
}) {
  const [emails, setEmails] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [results, setResults] = useState<{ items: InviteResult[]; kept: number } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [resend, setResend] = useState<Record<string, ResendState>>({});
  const [copied, setCopied] = useState<{ id: string; result: "ok" | "failed" } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const emailsRef = useRef<HTMLTextAreaElement>(null);
  const ws = workspaces.find((w) => w.id === workspace);
  const timers = useRef<number[]>([]);
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);
  // feedback belongs to the workspace it was given in
  useEffect(() => { setInviteMsg(null); setResults(null); setResend({}); setCopied(null); setQuery(""); setRoleFilter("all"); }, [workspace]);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };
  // an invite just went out for this email: hold Resend off until the email function would send again
  const setResendFor = (email: string, state: ResendState) => {
    const key = email.toLowerCase();
    setResend((s) => ({ ...s, [key]: state }));
    later(() => setResend((s) => { if (s[key] !== state) return s; const n = { ...s }; delete n[key]; return n; }), RESEND_COOLDOWN);
  };
  const wsMembers = members.filter((m) => m.workspaceId === workspace);
  // fall back to owner if my row hasn't loaded but I own the workspace
  const role: Role | undefined = myRole ?? (ws?.ownerId === currentUserId ? "owner" : undefined);
  const canManage = can(role, "manageMembers");
  const inviteOptions = assignableRoles(role);
  // an admin's dropdown has no "admin" option — never leave the select on a value it can't show
  useEffect(() => {
    if (inviteOptions.length && !inviteOptions.includes(inviteRole)) setInviteRole(inviteOptions.includes("member") ? "member" : inviteOptions[0]);
  }, [inviteOptions.join(","), inviteRole]);

  // this week's load and what each person is working on (the load model Pulse and Workload share)
  const [capacities] = useState(readCapacities);
  const todayKey = KANBO_TODAY.getTime();   // the live clock moves it at midnight
  const weekLoad = useMemo(() => {
    const today = new Date(todayKey);
    return loadForWeek(tasks, startOfWeekMon(today), today).rows;
  }, [tasks, todayKey]);
  const working = useMemo(() => {
    const out = new Map<string, Task>();
    const under = tasks.filter((t) => t.status === "progress" && !t.archivedAt)
      .sort((a, b) => (b.aiScore - a.aiScore) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
    for (const t of under) if (t.assigneeId && !out.has(t.assigneeId)) out.set(t.assigneeId, t);
    return out;
  }, [tasks]);
  const openCount = (m: WorkspaceMember) => {
    const id = m.userId ?? "";
    return tasks.filter((t) => t.assigneeId === id && t.status !== "done" && !t.archivedAt).length;
  };

  // Personal workspace → prompt to create a team
  if (workspace === null) {
    return (
      <div className="kppl" data-empty="">
        <style>{PEOPLE_CSS}</style>
        <EmptyState art="users" size="lg" title="Personal is just for you"
          body="Create a team workspace to invite people and work on shared projects and tasks together."
          action={onNewWorkspace ? <Button variant="primary" icon="plus" onClick={onNewWorkspace}>New workspace</Button> : undefined} />
      </div>
    );
  }

  const { valid, invalid } = parseEmails(emails);
  const already = valid.map((v) => wsMembers.find((m) => m.status === "active" && m.email.toLowerCase() === v)).filter((m): m is WorkspaceMember => !!m);
  const submitInvite = async () => {
    if (!workspace || inviteBusy) return;
    setResults(null);
    if (!valid.length) { setInviteMsg({ kind: "error", text: "Enter a full email address, like name@company.com." }); return; }

    // one email: the page's long-standing single-invite messages
    if (valid.length === 1 && !invalid.length) {
      const v = valid[0];
      const existing = wsMembers.find((m) => m.email.toLowerCase() === v);
      if (existing?.status === "active") {
        setInviteMsg({ kind: "error", text: `${memberName(existing)} is already a member — open their card to change their role.` });
        return;
      }
      setInviteBusy(true);
      setInviteMsg(null);
      try {
        const r = onInvite(workspace, v, inviteRole);
        // no promise → no way to know how it went: claim nothing, just clear the field
        if (!isThenable(r)) { setEmails(""); return; }
        const res = await r;
        setEmails("");
        setResendFor(v, existing ? "sent" : "fresh");
        const as = withArticle(ROLE_META[inviteRole].label.toLowerCase());
        const ok = existing ? `Refreshed the invite for ${v} (as ${as}).` : `Invited ${v} as ${as}. They'll join when they sign up or sign in with that email.`;
        // the invite stands either way; say so when its email didn't go
        const note = inviteEmailNotice((res as InvitedMember | undefined)?.inviteEmail);
        setInviteMsg(note?.tone === "error" ? { kind: "error", text: note.text } : { kind: "ok", text: note ? `${ok} ${note.text}` : ok });
      } catch (e) {
        setInviteMsg({ kind: "error", text: inviteErrorText(e, v) });
      } finally {
        setInviteBusy(false);
      }
      return;
    }

    // several: one by one, each with its own outcome; what didn't go stays in the field
    setInviteBusy(true);
    setInviteMsg(null);
    const out: InviteResult[] = [];
    const keep: string[] = [];
    let silent = false;   // a handler that returns nothing can't say how it went
    for (const v of valid) {
      const existing = wsMembers.find((m) => m.email.toLowerCase() === v);
      if (existing?.status === "active") { out.push({ email: v, ok: false, text: `${memberName(existing)} is already a member` }); continue; }
      try {
        const r = onInvite(workspace, v, inviteRole);
        if (!isThenable(r)) { silent = true; continue; }
        const res = await r;
        setResendFor(v, existing ? "sent" : "fresh");
        const note = inviteEmailNotice((res as InvitedMember | undefined)?.inviteEmail);
        out.push({ email: v, ok: true, text: `${existing ? "Invite refreshed" : "Invited"}${note ? ` — ${note.text}` : ""}` });
      } catch (e) {
        out.push({ email: v, ok: false, text: inviteErrorText(e, v) });
        keep.push(v);
      }
    }
    for (const bad of invalid) { out.push({ email: bad, ok: false, text: "Doesn't look like an email address" }); keep.push(bad); }
    setEmails(keep.join("\n"));
    setResults(silent && out.every((x) => x.ok) ? null : { items: out, kept: keep.length });
    setInviteBusy(false);
  };

  const resendInvite = async (m: WorkspaceMember) => {
    const key = m.email.toLowerCase();
    const cur = resend[key];
    if (!workspace || cur === "sending" || cur === "sent" || cur === "emailed" || cur === "fresh" || (typeof cur === "object" && "info" in cur && cur.hold)) return;
    setResend((s) => ({ ...s, [key]: "sending" }));
    try {
      if (onResendInvite) {
        const res = await onResendInvite(m.id);
        const note = inviteEmailNotice(res);
        if (!note) setResendFor(key, "emailed");
        else if (res.reason === "throttled") setResendFor(key, { info: note.text, hold: true });
        else setResend((s) => ({ ...s, [key]: note.tone === "error" ? { error: note.text } : { info: note.text } }));
        return;
      }
      const r = onInvite(workspace, m.email, m.role);
      if (!isThenable(r)) { setResend((s) => { const n = { ...s }; delete n[key]; return n; }); return; }
      await r;
      setResendFor(key, "sent");
    } catch (e) {
      setResend((s) => ({ ...s, [key]: { error: inviteErrorText(e, m.email) } }));
    }
  };

  const copySignUpLink = async (m: WorkspaceMember) => {
    const ok = await copyText(window.location.origin + "/");
    setCopied({ id: m.id, result: ok ? "ok" : "failed" });
    if (ok) later(() => setCopied((c) => (c?.id === m.id && c.result === "ok" ? null : c)), 5000);
  };

  const q = query.trim().toLowerCase();
  const matches = (m: WorkspaceMember) => ROLE_FILTER[roleFilter](m.role) && (!q
    || [memberName(m), m.email, m.title ?? "", ROLE_META[m.role]?.label ?? ""].some((s) => s.toLowerCase().includes(q)));
  const active = wsMembers.filter((m) => m.status === "active");
  const invited = wsMembers.filter((m) => m.status === "invited");
  const shownActive = active.filter(matches);
  const shownInvited = invited.filter(matches);
  const counts = (Object.keys(ROLE_FILTER) as RoleFilter[]).map((k) => [k, wsMembers.filter((m) => ROLE_FILTER[k](m.role)).length] as const);
  const roleKinds = counts.filter(([k, n]) => k !== "all" && n > 0).length;
  const selected = selectedId ? wsMembers.find((x) => x.id === selectedId) : undefined;
  const loadOf = (m: WorkspaceMember): Load | undefined => (m.userId ? { hours: weekLoad.get(m.userId)?.hours ?? 0, capacity: capacityOf(capacities, m.userId) } : undefined);
  const nValid = valid.length;
  const sendLabel = nValid ? `Send ${nValid} invite${nValid === 1 ? "" : "s"}` : "Send invites";
  const okCount = results?.items.filter((r) => r.ok).length ?? 0;
  const summary = !results ? "" : okCount === results.items.length ? `Invited ${okCount} ${okCount === 1 ? "person" : "people"}.`
    : `Invited ${okCount} of ${results.items.length}.${results.kept ? " What's left is still in the box above, to fix and send again." : ""}`;
  const openInvite = () => { setInviteMsg(null); setResults(null); setInviteOpen(true); };

  return (
    <div className="kppl">
      <style>{PEOPLE_CSS}</style>
      <div className="kppl-inner">
        <div className="kppl-bar">
          <label className="kppl-find">
            <Icon name="search" size={16} sw={1.75} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find people" aria-label="Find people"
              onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); } }} />
          </label>
          {roleKinds > 1 && (
            <Segmented<RoleFilter> ariaLabel="Show" value={roleFilter} onChange={setRoleFilter}
              options={counts.filter(([k, n]) => k === "all" || n > 0).map(([k, n]) => ({ value: k, label: `${k === "all" ? "Everyone" : k === "admins" ? "Admins" : k === "members" ? "Members" : "Guests"} ${n}` }))} />
          )}
          <span className="kppl-bar-end">
            {canManage && onOpenWorkspaceSettings && <Button size="sm" variant="ghost" icon="settings" onClick={onOpenWorkspaceSettings}>Workspace settings</Button>}
            {canManage && <Button variant="primary" icon="plus" onClick={openInvite}>Invite people</Button>}
          </span>
        </div>

        <section className="kppl-group" aria-labelledby="kppl-members">
          <SectionLabel id="kppl-members" count={shownActive.length}>Members</SectionLabel>
          {shownActive.length === 0 ? (
            <p className="kppl-none">{q || roleFilter !== "all" ? <>No one matches{q ? <> “{query.trim()}”</> : " that filter"}. <button type="button" className="kppl-link" onClick={() => { setQuery(""); setRoleFilter("all"); }}>Show everyone</button></> : "No one has joined yet."}</p>
          ) : (
            <ul className="kppl-list">
              {shownActive.map((m) => (
                <PersonRow key={m.id} m={m} name={memberName(m)} isSelf={m.userId === currentUserId} openN={openCount(m)}
                  working={m.userId ? working.get(m.userId) : undefined} load={loadOf(m)} onSelect={() => setSelectedId(m.id)} />
              ))}
            </ul>
          )}
        </section>

        {shownInvited.length > 0 && (
          <section className="kppl-group" aria-labelledby="kppl-invites">
            <SectionLabel id="kppl-invites" count={shownInvited.length}>Pending invites</SectionLabel>
            <ul className="kppl-list">
              {shownInvited.map((m) => (
                <PersonRow key={m.id} m={m} name={memberName(m)} isSelf={false} openN={0} onSelect={() => setSelectedId(m.id)}
                  invite={canManage ? {
                    canResend: canManageMember(role, m.role),
                    resend: resend[m.email.toLowerCase()],
                    copied: copied?.id === m.id ? copied.result : undefined,
                    onResend: () => { void resendInvite(m); },
                    onCopy: () => { void copySignUpLink(m); },
                  } : undefined} />
              ))}
            </ul>
          </section>
        )}
      </div>

      {canManage && (
        <Sheet open={inviteOpen} onClose={() => setInviteOpen(false)} label={`Invite people to ${ws?.name ?? "this workspace"}`} title="Invite people" width={560} initialFocus={emailsRef}
          footer={(
            <>
              <Button variant="ghost" onClick={() => setInviteOpen(false)}>{results || inviteMsg?.kind === "ok" ? "Done" : "Cancel"}</Button>
              <Button variant="primary" type="submit" form="kinvite-form" icon="send" loading={inviteBusy} disabled={!nValid}>{inviteBusy ? "Inviting…" : sendLabel}</Button>
            </>
          )}>
          <form id="kinvite-form" className="kinvite" noValidate aria-label={`Invite to ${ws?.name ?? "this workspace"}`}
            onSubmit={(e) => { e.preventDefault(); void submitInvite(); }}>
            <label className="kinvite-field">
              <span className="kinvite-label">Emails</span>
              <textarea ref={emailsRef} value={emails} rows={4} spellCheck={false} autoComplete="off"
                placeholder={"sam@company.com, alex@company.com"} aria-label="Emails"
                aria-invalid={inviteMsg?.kind === "error" || undefined} aria-describedby="kinvite-help kinvite-msg"
                onChange={(e) => { setEmails(e.target.value); if (inviteMsg) setInviteMsg(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submitInvite(); } }} />
              <span id="kinvite-help" className="kinvite-help">
                Separate addresses with commas, spaces or new lines.
                {nValid > 1 && <> <b>{nValid} people</b>.</>}
                {invalid.length > 0 && <span className="kinvite-bad"> {invalid.length === 1 ? `“${invalid[0]}” doesn't look like an email address.` : `${invalid.length} entries don't look like email addresses.`}</span>}
                {already.length > 0 && <span className="kinvite-bad"> {already.length === 1 ? `${memberName(already[0])} is already a member.` : `${already.length} of them are already members.`}</span>}
              </span>
            </label>
            <label className="kinvite-field">
              <span className="kinvite-label">Role</span>
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} aria-label="Invite as role" className="kfield-select">
                {inviteOptions.map((r) => <option key={r} value={r}>{ROLE_META[r].label}</option>)}
              </select>
              <span className="kinvite-help"><b>{ROLE_META[inviteRole]?.label}</b> · {roleBlurb(inviteRole)}</span>
            </label>
            <p className="kinvite-note"><Icon name="lock" size={14} sw={1.75} />An invite lets them skip the waitlist: they join {ws?.name ?? "the workspace"} as soon as they sign up or sign in with the invited email.</p>
            {/* one live region, always mounted, so screen readers announce the outcome */}
            <div id="kinvite-msg" role="status" aria-live="polite" className="kinvite-status" data-kind={inviteMsg?.kind}>
              {inviteMsg && <Icon name={inviteMsg.kind === "error" ? "x" : "check"} size={14} sw={2} />}
              {inviteMsg?.text}
              {results && (
                <>
                  <span className="kinvite-summary">{summary}</span>
                  <ul className="kinvite-results">
                    {results.items.map((r) => (
                      <li key={r.email} data-ok={r.ok || undefined}>
                        <Icon name={r.ok ? "check" : "x"} size={14} sw={2} />
                        <span><span className="kinvite-email">{r.email}</span> — {r.text}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </form>
        </Sheet>
      )}

      {selected && (
        <MemberProfile key={selected.id} m={selected} name={memberName(selected)} isSelf={selected.userId === currentUserId}
          role={role} workspace={workspace} tasks={tasks} inviteOptions={inviteOptions}
          onSetRole={onSetRole} onSetTitle={onSetTitle} onTransferOwnership={onTransferOwnership}
          onRemoveMember={onRemoveMember} onOpen={onOpen} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

const PEOPLE_CSS = `
.kppl { flex: 1; min-width: 0; overflow-y: auto; container-type: inline-size; }
.kppl[data-empty] { display: grid; place-items: center; padding: 0 var(--gutter, 32px); }
.kppl-inner { max-width: var(--list-max, 1120px); margin: 0 auto; padding: 0 var(--gutter, 32px) 48px; }
.kppl-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-height: 56px; padding: 8px 0; }
.kppl-find { display: inline-flex; align-items: center; gap: 8px; width: 240px; max-width: 100%; height: var(--h-md, 32px); padding: 0 10px; border-radius: var(--r-sm, 6px);
  background: var(--field-bg, var(--surface)); border: 1px solid var(--field-border, var(--hairline-strong)); color: var(--icon-quiet, var(--ink-4));
  transition: border-color var(--d-1, 90ms) var(--ease); }
.kppl-find:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.kppl-find:focus-within { outline: 2px solid var(--accent); outline-offset: 1px; }
.kppl-find input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: none; background: transparent; color: var(--ink); font: 500 13px/20px var(--font-ui, var(--font-display)); }
.kppl-find input::placeholder { color: var(--ink-4); }
.kppl-find input::-webkit-search-cancel-button { display: none; }
.kppl-bar-end { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; }
.kppl-group { margin-top: 16px; }
.kppl-group + .kppl-group { margin-top: 24px; }
.kppl-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; }
.kppl-row { position: relative; display: flex; flex-wrap: wrap; align-items: center; border-radius: var(--r-sm, 6px); transition: background var(--d-1, 90ms) var(--ease); }
.kppl-row:hover { background: var(--fill-1); }
.kppl-main { flex: 1 1 520px; min-width: 0; display: grid; grid-template-columns: 32px minmax(180px, 1.1fr) minmax(0, 1.4fr) 176px 64px; align-items: center; gap: 0 16px;
  min-height: 56px; padding: 8px 12px; border: 0; border-radius: var(--r-sm, 6px); background: transparent; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.kppl-row[data-pending] .kppl-main { grid-template-columns: 32px minmax(180px, 1.1fr) minmax(0, 1.4fr); }
.kppl-ghost { width: 32px; height: 32px; border-radius: 999px; display: grid; place-items: center; flex-shrink: 0; border: 1.5px dashed var(--hairline-strong); color: var(--icon-quiet, var(--ink-4)); }
.kppl-ghost[data-size="40"] { width: 40px; height: 40px; }
.kppl-id { display: flex; flex-direction: column; min-width: 0; }
.kppl-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.kppl-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 14px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kppl-you { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); margin-left: -2px; }
.kppl-line .kpill { flex-shrink: 0; }
.kppl-sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kppl-work { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kppl-task { color: var(--ink-2); }
.kppl-work[data-muted] { color: var(--ink-4); }
.kppl-load { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-width: 0; }
.kppl-load .kmeter-wrap { flex: none; }
.kppl-hours { min-width: 66px; text-align: right; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-2); white-space: nowrap; }
.kppl-hours[data-tone="signal"] { color: var(--signal, var(--st-blocked)); }
.kppl-guest { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kppl-open { text-align: right; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); white-space: nowrap; }
.kppl-actions { display: inline-flex; align-items: center; gap: 4px; padding: 0 8px 0 0; }
.kppl-actions .kbtn[data-ok] { color: var(--ok, var(--st-done)); }
.kppl-feedback { flex-basis: 100%; margin: -4px 0 0; padding: 0 12px 10px 60px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
/* live regions stay in the accessibility tree while empty, so they can announce */
.kppl-feedback:empty { padding: 0; margin: 0; }
.kppl-feedback[data-tone="signal"] { color: var(--signal, var(--st-blocked)); }
.kppl-none { margin: 8px 12px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kppl-link { padding: 0; border: 0; background: none; font: inherit; font-weight: 600; color: var(--accent-text, var(--accent)); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
@container (max-width: 900px) {
  .kppl-main { grid-template-columns: 32px minmax(0, 1fr) 150px 56px; }
  .kppl-main .kppl-work { display: none; }
  .kppl-row[data-pending] .kppl-main { grid-template-columns: 32px minmax(0, 1fr); }
  .kppl-load .kmeter-wrap { width: 64px !important; }
}
@container (max-width: 560px) {
  .kppl-main { grid-template-columns: 32px minmax(0, 1fr) auto; }
  .kppl-open { display: none; }
  .kppl-load .kmeter-wrap { display: none; }
  .kppl-find { flex: 1 1 100%; width: auto; }
  .kppl-bar-end { width: 100%; margin-left: 0; }
  .kppl-bar-end .kbtn:last-child { flex: 1; }
  .kppl-feedback { padding-left: 12px; }
}
@media (max-width: 859px) { .kppl-inner { padding: 0 16px 32px; } }

/* invite dialog */
.kinvite { display: flex; flex-direction: column; gap: 16px; }
.kinvite-field { display: flex; flex-direction: column; gap: 6px; }
.kinvite-label { font: 600 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kinvite textarea { width: 100%; min-height: 96px; resize: vertical; padding: 8px 10px; border-radius: var(--r-md, 8px); border: 1px solid var(--field-border, var(--hairline-strong));
  background: var(--field-bg, var(--surface)); color: var(--ink); font: 500 13px/20px var(--font-ui, var(--font-display)); }
.kinvite textarea:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.kinvite textarea[aria-invalid="true"] { border-color: color-mix(in oklch, var(--signal, var(--st-blocked)) 60%, transparent); }
.kinvite-help { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kinvite-help b { font-weight: 600; color: var(--ink-2); }
.kinvite-bad { color: var(--warn, var(--st-review)); }
.kinvite-note { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 10px 12px; border-radius: var(--r-md, 8px); background: var(--fill-1);
  font: 500 12px/18px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kinvite-note svg { flex-shrink: 0; margin-top: 2px; color: var(--ink-3); }
.kinvite-status { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 6px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ok, var(--st-done)); }
.kinvite-status:empty { margin-top: -16px; }
.kinvite-status svg { flex-shrink: 0; margin-top: 3px; }
.kinvite-status[data-kind="error"] { color: var(--signal, var(--st-blocked)); }
.kinvite-summary { flex-basis: 100%; color: var(--ink); font-weight: 600; }
.kinvite-results { flex-basis: 100%; list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; color: var(--signal, var(--st-blocked)); }
.kinvite-results li { display: flex; gap: 8px; align-items: flex-start; }
.kinvite-results li[data-ok] { color: var(--ok, var(--st-done)); }
.kinvite-results li > span { color: var(--ink-2); }
.kinvite-email { color: var(--ink); font-weight: 600; }
.kfield-select, .kfield-input { height: var(--h-md, 32px); padding: 0 10px; border-radius: var(--r-sm, 6px); border: 1px solid var(--field-border, var(--hairline-strong));
  background: var(--field-bg, var(--surface)); color: var(--ink); font: 500 13px/20px var(--font-ui, var(--font-display)); }
.kfield-select { max-width: 240px; cursor: pointer; }
.kfield-select:hover, .kfield-input:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }

/* profile */
.kprof { display: flex; flex-direction: column; gap: 20px; min-height: 100%; }
.kprof-head { display: flex; align-items: flex-start; gap: 12px; }
.kprof-who { flex: 1; min-width: 0; }
.kprof-name { display: flex; align-items: baseline; gap: 8px; margin: 0; font: 600 20px/28px var(--font-head); letter-spacing: -0.012em; color: var(--ink); overflow-wrap: anywhere; }
.kprof-name .kppl-you { font: 500 12px/16px var(--font-ui, var(--font-display)); }
.kprof-title { margin: 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kprof-email { margin: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); overflow-wrap: anywhere; }
.kprof-field { display: flex; flex-direction: column; gap: 8px; }
.kprof-label { font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kprof-role { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.kprof-value { font: 600 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kprof-hint { margin: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kprof-inline { display: flex; gap: 8px; }
.kprof-inline .kfield-input { flex: 1; min-width: 0; }
.kprof-stats { display: flex; gap: 32px; margin: 0; }
.kprof-stats dt { font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kprof-stats dd { margin: 2px 0 0; font: 600 20px/28px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.kprof-stats dd[data-tone="ok"] { color: var(--ok, var(--st-done)); }
.kprof-locked { display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 12px; border-radius: var(--r-md, 8px); background: var(--fill-1); font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kprof-tasks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.kprof-task { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px); background: transparent;
  color: var(--ink); font: 500 14px/20px var(--font-ui, var(--font-display)); text-align: left; cursor: pointer; }
.kprof-task:hover { background: var(--fill-1); }
.kprof-task > .truncate { flex: 1; min-width: 0; }
.kprof-danger { display: flex; flex-direction: column; gap: 8px; margin-top: auto; padding-top: 16px; border-top: 1px solid var(--hairline); }
.kprof-remove { color: var(--signal, var(--st-blocked)) !important; }

/* workspace settings (Settings › Workspace) */
.kwsset { display: flex; flex-direction: column; gap: 24px; }
.kwsset-row { display: flex; align-items: flex-start; gap: 16px; }
.kwsset-logo { width: 56px; height: 56px; flex-shrink: 0; border-radius: var(--r-lg, 12px); overflow: hidden; display: grid; place-items: center;
  background: var(--fill-1); border: 1px dashed var(--hairline-strong); color: var(--ink-3); font: 600 20px/1 var(--font-head); }
.kwsset-logo img { width: 100%; height: 100%; object-fit: cover; }
.kwsset-logo:has(img) { border-style: solid; border-color: var(--hairline); }
.kwsset-logo-side { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
.kwsset-actions { display: inline-flex; gap: 8px; }
.kwsset-label { font: 600 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kwsset-hint { margin: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kwsset-error { max-width: 320px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--signal, var(--st-blocked)); }
.kwsset-name { align-items: flex-end; }
.kwsset-field { display: flex; flex-direction: column; gap: 6px; flex: 1; max-width: 360px; }
.kwsset-danger { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 16px; border-radius: var(--r-lg, 12px);
  border: 1px solid color-mix(in oklch, var(--signal, var(--st-blocked)) 30%, var(--hairline)); background: var(--signal-tint, color-mix(in oklch, var(--st-blocked) 6%, transparent)); }
.kwsset-danger-title { margin: 0 0 2px; font: 600 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kwsset-close { color: var(--signal, var(--st-blocked)) !important; }
.kcrop { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.kcrop-view { position: relative; overflow: hidden; border-radius: var(--r-lg, 12px); background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline); cursor: grab; touch-action: none; }
.kcrop-zoom { display: flex; align-items: center; gap: 10px; width: 280px; color: var(--ink-3); }
.kcrop-zoom input { flex: 1; accent-color: var(--accent); }
.kcrop-hint { margin: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
`;

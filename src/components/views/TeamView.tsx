/* ============================================================
   KANBO — Team: members, invites, roles, and the workspace
   settings panel (logo, name, Close workspace)
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Icon, Avatar, StatusDot, EmptyArt } from "../primitives";
import { getProject, getMember } from "../../data/data";
import { can, canManageMember, assignableRoles, ROLE_META } from "../../lib/permissions";
import type { Task, Workspace, WorkspaceMember, Role } from "../../data/types";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { AVATAR_ACCEPT, AVATAR_MESSAGES, avatarExtension, avatarMime } from "../../lib/avatarUpload";
import { uiZoom } from "../../lib/appearance";
import { inviteEmailNotice, type InviteEmailResult, type InvitedMember } from "../../data/store";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// neutral wash (hover, tracks, chips) that stays visible on white porcelain
// cards — --surface-2 is itself white there
const FILL_1 = "var(--fill-1, color-mix(in oklch, var(--ink) 6%, transparent))";

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
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);   // Tab stays inside, Escape cancels
  const zoomRef = useRef<HTMLInputElement>(null);
  useEffect(() => { zoomRef.current?.focus(); }, []);

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
    setOffset({ x: (V - w * bs) / 2, y: (V - h * bs) / 2 });   // centered
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
    <>
      <div onClick={onCancel} className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 90, background: "color-mix(in oklch, var(--bg-deep) 55%, transparent)", backdropFilter: "blur(3px)" }} />
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Adjust logo" className="glass anim-scalein" style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 91, width: 360, maxWidth: "92vw", padding: 22, borderRadius: 20, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Adjust logo</div>
          <button className="btn-icon" onClick={onCancel} aria-label="Cancel" style={{ border: "none" }}><Icon name="x" size={18} /></button>
        </div>
        <div onPointerDown={startDrag} style={{ alignSelf: "center", position: "relative", width: V, height: V, borderRadius: 16, overflow: "hidden", background: "var(--surface-2)", border: "1px solid var(--hairline)", cursor: "grab", touchAction: "none" }}>
          {url && <img ref={imgRef} src={url} alt="" onLoad={onImgLoad} onError={() => onError(/hei[cf]$/.test(avatarMime(file)) ? AVATAR_MESSAGES.heic : AVATAR_MESSAGES.unreadable)} draggable={false} style={{ position: "absolute", left: offset.x, top: offset.y, width: dispW, height: dispH, maxWidth: "none", userSelect: "none", pointerEvents: "none" }} />}
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", borderRadius: 16, boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--ink) 10%, transparent)" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <Icon name="search" size={14} style={{ color: "var(--ink-4)", flexShrink: 0 }} />
          <input ref={zoomRef} type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => changeZoom(parseFloat(e.target.value))} aria-label="Zoom" style={{ flex: 1, accentColor: "var(--accent)" }} />
        </div>
        <p style={{ margin: "-4px 0 0", fontSize: 11.5, color: "var(--ink-4)", textAlign: "center" }}>Drag to reposition · slide to zoom</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-accent" onClick={save} disabled={busy || !nat}>{busy ? "Saving…" : "Save logo"}</button>
        </div>
      </div>
    </>
  );
}

/* ---------- Team page helpers ---------- */

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

// status text tinted toward the ink so it clears WCAG AA in both themes
// (raw --st-done / --prio-urgent are too light for small text on porcelain)
const OK_INK = "color-mix(in oklch, var(--st-done) 60%, var(--ink))";
const ERR_INK = "color-mix(in oklch, var(--prio-urgent) 80%, var(--ink))";

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

function RoleBadge({ m }: { m: WorkspaceMember }) {
  return m.status === "invited"
    ? <span className="mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 6, color: "var(--st-review)", background: "color-mix(in oklch, var(--st-review) 12%, transparent)", flexShrink: 0 }}>Invited</span>
    : <span title={roleBlurb(m.role)} className="mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 6, color: m.role === "owner" ? "var(--accent)" : "var(--ink-3)", background: FILL_1, flexShrink: 0 }}>{ROLE_META[m.role]?.label}</span>;
}

/* Per pending email: "fresh" = invited from this page a moment ago, "sent" =
   re-invited a moment ago, "emailed" = its email re-sent a moment ago (all hold
   Resend off for RESEND_COOLDOWN). `info` is a
   note about the email that needs nothing from you; with `hold` (an email went
   under a minute ago) Resend waits out the cooldown too. */
type ResendState = "sending" | "sent" | "emailed" | "fresh" | { error: string } | { info: string; hold?: boolean };

/* Clean, clickable card — opens the profile drawer. Pending invites also get
   "Resend invite" and "Copy sign-up link" for owners/admins. Hoisted to module
   level so it keeps its identity across TeamView renders. */
function MemberCard({ m, name, isSelf, openN, onSelect, invite }: {
  m: WorkspaceMember;
  name: string;
  isSelf: boolean;
  openN: number;
  onSelect: () => void;
  invite?: { canResend: boolean; resend?: ResendState; copied?: "ok" | "failed"; onResend: () => void; onCopy: () => void };
}) {
  const load = Math.min(100, openN * 20);
  const pending = m.status !== "active";
  const resend = invite?.resend;
  const resendError = resend && typeof resend === "object" && "error" in resend ? resend.error : null;
  const resendInfo = resend && typeof resend === "object" && "info" in resend ? resend : null;
  const done = resend === "sent" || resend === "emailed" || resend === "fresh" || !!resendInfo?.hold;
  const resendLabel = resend === "sending" ? "Sending…" : resend === "sent" ? "Invite refreshed" : resend === "emailed" ? "Invite sent" : resend === "fresh" ? "Just invited" : resendInfo?.hold ? "Recently sent" : "Resend invite";
  return (
    <div className="glass lift" style={{ borderRadius: 16, display: "flex", flexDirection: "column", width: "100%" }}>
      <button type="button" onClick={onSelect} aria-haspopup="dialog" style={{ padding: invite ? "16px 16px 12px" : 16, borderRadius: 16, textAlign: "left", cursor: "pointer", border: "none", background: "transparent", display: "flex", flexDirection: "column", gap: 13, width: "100%", color: "var(--ink)", fontFamily: "var(--font-display)" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 12, width: "100%" }}>
          {m.userId ? <Avatar id={m.userId} size={40} /> : (
            <span style={{ width: 40, height: 40, borderRadius: 99, display: "grid", placeItems: "center", flexShrink: 0, background: FILL_1, border: "1px dashed var(--hairline-strong)", color: "var(--ink-4)" }}><Icon name="user" size={18} /></span>
          )}
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="truncate" style={{ display: "block", fontSize: 14.5, fontWeight: 600 }}>{name}{isSelf && <span style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 400 }}> · you</span>}</span>
            {m.title && <span className="truncate" style={{ display: "block", fontSize: 12, color: "var(--accent)", fontWeight: 500 }}>{m.title}</span>}
            {pending
              ? <span className="truncate" style={{ display: "block", fontSize: 12, color: "var(--ink-4)" }}>{name !== m.email ? `${m.email} · ` : ""}Invited as {withArticle(ROLE_META[m.role]?.label.toLowerCase() ?? "member")}</span>
              : name !== m.email && <span className="truncate" style={{ display: "block", fontSize: 12, color: "var(--ink-4)" }}>{m.email}</span>}
          </span>
          <RoleBadge m={m} />
        </span>
        {!pending ? (
          <span style={{ display: "block", width: "100%" }}>
            <span style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 6 }}>
              <span className="kicker">Workload</span>
              <span className="mono tnum" style={{ color: load > 60 ? "var(--prio-high)" : "var(--ink-3)" }}>{openN} open</span>
            </span>
            <span style={{ display: "block", height: 6, borderRadius: 99, background: "var(--track, var(--surface-2))", overflow: "hidden" }}>
              <span style={{ display: "block", width: load + "%", height: "100%", borderRadius: 99, background: load > 60 ? "var(--prio-high)" : "var(--accent)", transition: "width .8s var(--ease)" }} />
            </span>
          </span>
        ) : (
          <span style={{ display: "block", fontSize: 12.5, color: "var(--ink-4)", lineHeight: 1.5 }}>They'll join as soon as they sign up or sign in with this email address.</span>
        )}
      </button>
      {invite && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 16px 14px" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {invite.canResend && (
              <button type="button" className="btn btn-ghost" onClick={invite.onResend} disabled={resend === "sending" || done}
                aria-label={resend === "sending" ? `Sending invite to ${m.email}` : done ? `${resendLabel} (${m.email}) — you can resend in a minute` : `Resend invite to ${m.email}`}
                title={done ? "You can resend in a minute" : undefined}
                style={{ fontSize: 12.5, padding: "6px 11px", borderRadius: 10, color: done ? OK_INK : undefined, opacity: resend === "sending" ? 0.7 : 1, cursor: done || resend === "sending" ? "default" : "pointer" }}>
                <Icon name={done ? "check" : "refresh"} size={13} />
                {resendLabel}
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={invite.onCopy}
              aria-label={`Copy sign-up link for ${m.email}`}
              style={{ fontSize: 12.5, padding: "6px 11px", borderRadius: 10, color: invite.copied === "ok" ? OK_INK : undefined }}>
              <Icon name={invite.copied === "ok" ? "check" : "link"} size={13} />
              {invite.copied === "ok" ? "Link copied" : "Copy sign-up link"}
            </button>
          </div>
          <div aria-live="polite" style={{ fontSize: 11.5, lineHeight: 1.45, color: resendError ? ERR_INK : "var(--ink-4)" }}>
            {resendError
              ? resendError
              : resendInfo ? resendInfo.info
              : resend === "sent" || resend === "emailed" ? "If the email doesn't reach them, copy the sign-up link and send it yourself."
              : invite.copied === "ok" ? `Share it with them — they need to sign up with ${m.email} to join.`
              : invite.copied === "failed" ? `Couldn't copy automatically — the sign-up link is ${window.location.origin}/`
              : null}
          </div>
        </div>
      )}
    </div>
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
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
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
  return (
    <>
      <div onClick={onClose} className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 70, background: "color-mix(in oklch, var(--bg-deep) 45%, transparent)", backdropFilter: "blur(2px)" }} />
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label={`${name} profile`} className="anim-fadein" style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 420, maxWidth: "92vw", zIndex: 71, background: "var(--surface-raised)", borderLeft: "1px solid var(--hairline)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 20px", borderBottom: "1px solid var(--hairline)" }}>
          {m.userId ? <Avatar id={m.userId} size={44} /> : <span style={{ width: 44, height: 44, borderRadius: 99, display: "grid", placeItems: "center", flexShrink: 0, background: FILL_1, border: "1px dashed var(--hairline-strong)", color: "var(--ink-4)" }}><Icon name="user" size={20} /></span>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="truncate" style={{ fontSize: 16, fontWeight: 600 }}>{name}{isSelf && <span style={{ fontSize: 12, color: "var(--ink-4)", fontWeight: 400 }}> · you</span>}</div>
            {m.title && <div className="truncate" style={{ fontSize: 12.5, color: "var(--accent-text, var(--accent))", fontWeight: 500 }}>{m.title}</div>}
            {name !== m.email && <div className="truncate" style={{ fontSize: 12.5, color: "var(--ink-4)" }}>{m.email}</div>}
          </div>
          <button ref={closeRef} type="button" className="btn-icon" onClick={onClose} aria-label={`Close ${name} profile`} style={{ border: "none" }}><Icon name="x" size={18} /></button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="kicker">Role</span>
            {manageRole ? (
              <select value={m.role} onChange={(e) => onSetRole!(m.id, e.target.value as Role)} aria-label={`Role for ${name}`} style={{ height: 30, padding: "0 8px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none", cursor: "pointer" }}>
                {[...new Set<Role>([m.role, ...inviteOptions])].map((r) => <option key={r} value={r}>{ROLE_META[r].label}</option>)}
              </select>
            ) : pending ? (
              <span style={{ fontSize: 13, color: "var(--ink-2)", fontWeight: 600 }}>{ROLE_META[m.role]?.label}</span>
            ) : <RoleBadge m={m} />}
            <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{roleBlurb(m.role)}</span>
          </div>

          {/* position / job title — separate from the permission role */}
          {(canEditTitle || m.title) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <span className="kicker">Position</span>
              {canEditTitle ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} placeholder="e.g. Co-founder, Designer…" aria-label={`Position for ${name}`}
                    onKeyDown={(e) => { if (e.key === "Enter" && !titleUnchanged) onSetTitle!(m.id, titleDraft); }}
                    style={{ flex: 1, height: 34, padding: "0 11px", borderRadius: 9, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, outline: "none" }} />
                  <button type="button" className="btn btn-accent" disabled={titleUnchanged} onClick={() => onSetTitle!(m.id, titleDraft)} style={{ opacity: titleUnchanged ? 0.5 : 1 }}>Save</button>
                </div>
              ) : (
                <span style={{ fontSize: 13.5, color: "var(--ink-2)" }}>{m.title}</span>
              )}
            </div>
          )}

          {m.status === "active" && (
            <div style={{ display: "flex", gap: 24 }}>
              <div><div className="kicker">Open</div><div className="mono tnum" style={{ fontSize: 22, fontWeight: 600 }}>{openTasks.length}</div></div>
              <div><div className="kicker">Completed</div><div className="mono tnum" style={{ fontSize: 22, fontWeight: 600, color: "var(--st-done)" }}>{doneN}</div></div>
            </div>
          )}

          <div>
            <div className="kicker" style={{ marginBottom: 8 }}>{isSelf ? "Your tasks" : "Assigned tasks"}</div>
            {m.status !== "active" ? (
              <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>They haven't joined the workspace yet.</p>
            ) : !canSeeTasks ? (
              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 14px", borderRadius: 12, background: "var(--surface)", border: "1px solid var(--hairline)", color: "var(--ink-4)", fontSize: 12.5 }}>
                <Icon name="lock" size={14} /> Only admins can view a teammate's tasks.
              </div>
            ) : openTasks.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>No open tasks.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {openTasks.slice(0, 30).map((t) => {
                  const proj = getProject(t.projectId);
                  return (
                    <button key={t.id} type="button" onClick={() => { onOpen?.(t.id); onClose(); }} className="lift" style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-display)" }}>
                      <StatusDot status={t.status} size={7} />
                      <span className="truncate" style={{ flex: 1, fontSize: 13, color: "var(--ink)" }}>{t.title}</span>
                      {proj && <span title={proj.name} style={{ width: 7, height: 7, borderRadius: 2, background: proj.color, flexShrink: 0 }} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            {m.status === "active" && role === "owner" && onTransferOwnership && m.role !== "owner" && (
              <button type="button" className="btn btn-ghost" onClick={() => { if (window.confirm(`Make ${name} the owner? You'll become an admin.`)) { onTransferOwnership(workspace, m.id); onClose(); } }} style={{ justifyContent: "center" }}><Icon name="target" size={15} /> Make owner</button>
            )}
            {((canManageMember(role, m.role) && !isSelf) || (isSelf && m.role !== "owner")) && (
              <button type="button" className="btn btn-ghost" onClick={() => {
                // leaving / removal also takes the person off this workspace's task followers and
                // collaborators (0042 remove_member), and a re-invite doesn't put them back
                const q = isSelf ? "Leave this workspace? You'll also be taken off tasks you collaborate on or follow."
                  : pending ? `Cancel the invite to ${m.email}? They won't be able to join with it.`
                  : `Remove ${name} from this workspace? They'll also be taken off tasks they collaborate on or follow.`;
                if (window.confirm(q)) { onRemoveMember(m.id); onClose(); }
              }} style={{ justifyContent: "center", color: ERR_INK }}><Icon name="x" size={15} /> {isSelf ? "Leave workspace" : pending ? "Cancel invite" : "Remove from workspace"}</button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------- workspace settings — branding + danger zone (owners and admins) ----------
   The Team page shows it today; Settings › Workspace renders it too. Nothing
   shows unless you can manage the workspace. */
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

  return (
    <>
      <div className="glass" style={{ padding: 18, borderRadius: 16, marginBottom: 24, display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="kicker">Workspace settings</div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          {/* logo */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {ws.logoUrl ? (
              <img src={ws.logoUrl} alt="Workspace logo" style={{ width: 56, height: 56, borderRadius: 14, objectFit: "cover", border: "1px solid var(--hairline)" }} />
            ) : (
              <span style={{ width: 56, height: 56, borderRadius: 14, display: "grid", placeItems: "center", background: "var(--surface-2)", border: "1px dashed var(--hairline-strong)", color: "var(--ink-4)", fontSize: 20, fontWeight: 700 }}>{(ws.name || "?").charAt(0).toUpperCase()}</span>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {/* the avatars bucket only takes PNG/JPEG/GIF/WebP: SVG and HEIC are left out of the picker (iPhones then hand over a JPEG) */}
              <input ref={logoRef} type="file" accept={AVATAR_ACCEPT} aria-label="Workspace logo image" style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) { const problem = logoFileProblem(f); setLogoError(problem); if (!problem) setCropFile(f); }
                  if (logoRef.current) logoRef.current.value = "";
                }} />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-ghost" onClick={() => logoRef.current?.click()} style={{ fontSize: 12.5 }}><Icon name="plus" size={14} /> {ws.logoUrl ? "Change logo" : "Upload logo"}</button>
                {ws.logoUrl && <button className="btn btn-ghost" onClick={() => onUpdateWorkspace?.(workspace, ws.name, null)} style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Remove</button>}
              </div>
              <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>PNG, JPG, GIF or WebP. Square works best.</span>
              {logoError && <span role="alert" style={{ fontSize: 11.5, lineHeight: 1.4, fontWeight: 500, color: ERR_INK, maxWidth: 260 }}>{logoError}</span>}
            </div>
          </div>
          {/* name */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, flex: 1, minWidth: 240 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1 }}>
              <span className="kicker">Name</span>
              <input value={wsName} onChange={(e) => setWsName(e.target.value)}
                style={{ height: 38, padding: "0 13px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, outline: "none" }} />
            </label>
            <button className="btn btn-accent" disabled={savingWs || !wsName.trim() || wsName.trim() === ws.name}
              onClick={() => { if (!workspace) return; setSavingWs(true); onUpdateWorkspace?.(workspace, wsName.trim(), ws.logoUrl ?? null); setTimeout(() => setSavingWs(false), 600); }}
              style={{ opacity: (!wsName.trim() || wsName.trim() === ws.name) ? 0.5 : 1 }}>Save</button>
          </div>
        </div>
        {/* danger zone — owner only */}
        {can(role, "deleteWorkspace") && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "12px 14px", borderRadius: 12, border: "1px solid color-mix(in oklch, var(--prio-urgent) 35%, var(--hairline))", background: "color-mix(in oklch, var(--prio-urgent) 6%, transparent)" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)" }}>Close this workspace</div>
              <div style={{ fontSize: 12, color: "var(--ink-4)" }}>Permanently deletes the workspace and all its projects, tasks and members. This cannot be undone.</div>
            </div>
            <button className="btn btn-ghost" onClick={() => {
              if (!workspace) return;
              const typed = window.prompt(`This permanently deletes "${ws.name}" and everything in it.\n\nType the workspace name to confirm:`);
              if (typed != null && typed.trim() === ws.name) onDeleteWorkspace?.(workspace);
              else if (typed != null) window.alert("Name didn't match — workspace was not closed.");
            }} style={{ color: "var(--prio-urgent)", borderColor: "color-mix(in oklch, var(--prio-urgent) 40%, transparent)", flexShrink: 0 }}><Icon name="trash" size={14} /> Close workspace</button>
          </div>
        )}
      </div>
      {cropFile && (
        <LogoCropper file={cropFile} onCancel={() => setCropFile(null)} onConfirm={(f) => { onUploadLogo?.(workspace, f); setCropFile(null); }}
          onError={(msg) => { setLogoError(msg); setCropFile(null); }} />
      )}
    </>
  );
}

export function TeamView({ tasks, workspace, workspaces, members, currentUserId, myRole, onInvite, onResendInvite, onRemoveMember, onSetRole, onSetTitle, onTransferOwnership, onOpen, onNewWorkspace, onUpdateWorkspace, onUploadLogo, onDeleteWorkspace }: {
  tasks: Task[];
  workspace: string | null;
  workspaces: { id: string | null; name: string; ownerId?: string; logoUrl?: string }[];
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
  onNewWorkspace: () => void;
  onUpdateWorkspace?: (workspaceId: string, name: string, logoUrl: string | null) => void;
  onUploadLogo?: (workspaceId: string, file: File) => void;
  onDeleteWorkspace?: (workspaceId: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [resend, setResend] = useState<Record<string, ResendState>>({});
  const [copied, setCopied] = useState<{ id: string; result: "ok" | "failed" } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const ws = workspaces.find((w) => w.id === workspace);
  const timers = useRef<number[]>([]);
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);
  // feedback belongs to the workspace it was given in
  useEffect(() => { setInviteMsg(null); setResend({}); setCopied(null); }, [workspace]);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };
  // an invite just went out for this email: hold Resend off until the email function would send again
  const setResendFor = (email: string, state: ResendState) => {
    const key = email.toLowerCase();
    setResend((s) => ({ ...s, [key]: state }));
    later(() => setResend((s) => { if (s[key] !== state) return s; const n = { ...s }; delete n[key]; return n; }), RESEND_COOLDOWN);
  };
  const wsMembers = members.filter((m) => m.workspaceId === workspace);
  const active = wsMembers.filter((m) => m.status === "active");
  const invited = wsMembers.filter((m) => m.status === "invited");
  // fall back to owner if my row hasn't loaded but I own the workspace
  const role: Role | undefined = myRole ?? (ws?.ownerId === currentUserId ? "owner" : undefined);
  const canManage = can(role, "manageMembers");
  const inviteOptions = assignableRoles(role);
  // an admin's dropdown has no "admin" option — never leave the select on a value it can't show
  useEffect(() => {
    if (inviteOptions.length && !inviteOptions.includes(inviteRole)) setInviteRole(inviteOptions.includes("member") ? "member" : inviteOptions[0]);
  }, [inviteOptions.join(","), inviteRole]);

  // Personal workspace → prompt to create a team
  if (workspace === null) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 440 }}>
          <div style={{ marginBottom: 14 }}><EmptyArt kind="users" /></div>
          <p style={{ fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>Personal is just for you</p>
          <p style={{ fontSize: 13, margin: "5px 0 16px", lineHeight: 1.5 }}>Create a team workspace to invite people and collaborate on shared projects and tasks.</p>
          <button className="btn btn-accent" onClick={onNewWorkspace}><Icon name="plus" size={15} /> New workspace</button>
        </div>
      </div>
    );
  }

  const emailValid = EMAIL_RE.test(email.trim());
  const submitInvite = async () => {
    const v = email.trim().toLowerCase();
    if (!workspace || inviteBusy) return;
    if (!EMAIL_RE.test(v)) { setInviteMsg({ kind: "error", text: "Enter a full email address, like name@company.com." }); return; }
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
      if (!isThenable(r)) { setEmail(""); return; }
      const res = await r;
      setEmail("");
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

  const openCount = (m: WorkspaceMember) => {
    const id = m.userId ?? "";
    return tasks.filter((t) => t.assigneeId === id && t.status !== "done" && !t.archivedAt).length;
  };
  const selected = selectedId ? wsMembers.find((x) => x.id === selectedId) : undefined;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px" }}>
      <WorkspaceSettingsPanel workspace={workspace} workspaces={workspaces} myRole={myRole} currentUserId={currentUserId}
        onUpdateWorkspace={onUpdateWorkspace} onUploadLogo={onUploadLogo} onDeleteWorkspace={onDeleteWorkspace} onNewWorkspace={onNewWorkspace} />

      {/* invite */}
      {canManage && (
        <form className="glass" noValidate aria-label={`Invite to ${ws?.name ?? "this workspace"}`}
          onSubmit={(e) => { e.preventDefault(); void submitInvite(); }}
          style={{ display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px", borderRadius: 16, marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Icon name="users" size={17} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Invite to {ws?.name}</span>
            <input value={email} onChange={(e) => { setEmail(e.target.value); if (inviteMsg) setInviteMsg(null); }}
              type="email" inputMode="email" autoComplete="off" spellCheck={false} placeholder="teammate@company.com" aria-label="Invite email"
              aria-invalid={inviteMsg?.kind === "error" || undefined} aria-describedby="kinvite-msg"
              style={{ flex: 1, minWidth: 180, height: 38, padding: "0 13px", borderRadius: 10, border: `1px solid ${inviteMsg?.kind === "error" ? "color-mix(in oklch, var(--prio-urgent) 55%, var(--hairline))" : "var(--hairline)"}`, background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13.5, outline: "none" }} />
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} aria-label="Invite as role"
              style={{ height: 38, padding: "0 9px", borderRadius: 10, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none", cursor: "pointer" }}>
              {inviteOptions.map((r) => <option key={r} value={r}>{ROLE_META[r].label}</option>)}
            </select>
            <button type="submit" className="btn btn-accent" disabled={!emailValid || inviteBusy} style={{ opacity: emailValid && !inviteBusy ? 1 : 0.5 }}>
              <Icon name="plus" size={15} /> {inviteBusy ? "Inviting…" : "Invite"}
            </button>
          </div>
          <div id="kinvite-msg" style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 27 }}>
            <span style={{ fontSize: 12, color: "var(--ink-4)", lineHeight: 1.45 }}>
              <strong style={{ color: "var(--ink-3)", fontWeight: 600 }}>{ROLE_META[inviteRole]?.label}</strong> · {roleBlurb(inviteRole)}
            </span>
            {/* one live region, always mounted, so screen readers announce the outcome */}
            <span role="status" aria-live="polite" style={{ fontSize: 12.5, lineHeight: 1.45, fontWeight: 500, color: inviteMsg?.kind === "error" ? ERR_INK : OK_INK, display: "flex", alignItems: "center", gap: 6 }}>
              {inviteMsg && <Icon name={inviteMsg.kind === "error" ? "x" : "check"} size={13} />}
              {inviteMsg?.text}
            </span>
          </div>
        </form>
      )}

      <div className="kicker" style={{ marginBottom: 12 }}>Members · {active.length}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(280px,100%),1fr))", gap: 14, marginBottom: 28 }}>
        {active.map((m) => (
          <MemberCard key={m.id} m={m} name={memberName(m)} isSelf={m.userId === currentUserId} openN={openCount(m)} onSelect={() => setSelectedId(m.id)} />
        ))}
      </div>
      {invited.length > 0 && (
        <>
          <div className="kicker" style={{ marginBottom: 12 }}>Pending invites · {invited.length}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(280px,100%),1fr))", gap: 14 }}>
            {invited.map((m) => (
              <MemberCard key={m.id} m={m} name={memberName(m)} isSelf={false} openN={0} onSelect={() => setSelectedId(m.id)}
                invite={canManage ? {
                  canResend: canManageMember(role, m.role),
                  resend: resend[m.email.toLowerCase()],
                  copied: copied?.id === m.id ? copied.result : undefined,
                  onResend: () => { void resendInvite(m); },
                  onCopy: () => { void copySignUpLink(m); },
                } : undefined} />
            ))}
          </div>
        </>
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
